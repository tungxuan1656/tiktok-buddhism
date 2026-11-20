import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { collect, hash } from './artifacts.ts';
import { Store } from './store.ts';
import type { Delivery, Input, Run, Task } from './store.ts';
import { Telegram, TelegramError } from './telegram.ts';
import type { Update } from './telegram.ts';
import { PiFailure } from './pi.ts';
import type { Runner } from './pi.ts';
import { Trace } from './trace.ts';
import { pruneTask } from './retention.ts';

const HELP = 'Nhắn yêu cầu làm slide; Pi tự viết, vẽ và kiểm tra rồi gửi album ảnh đúng thứ tự. Tin nhắn sau dùng để sửa cùng tập.\n/status: tiến độ\n/trace_on: bật theo dõi trực tiếp (10 dòng)\n/trace_off: tắt theo dõi trực tiếp\n/log: 10 dòng mới nhất\n/cancel: dừng, giữ dữ liệu\n/done: kết thúc tập và mở session mới\n/new: tạm cất tập, mở session mới\n/episodes: chọn lại tập chưa kết thúc\n/files: tải tệp ảnh gốc của revision mới nhất (Telegram có thể nén ảnh trong album)\n/resend: gửi lại phần chưa nhận, giữ kiểu ảnh/tệp của lần bàn giao (có thể trùng nếu Telegram đã nhận nhưng mất xác nhận).\nChỉ hỗ trợ tin nhắn chữ; bạn tự đăng TikTok.';

type Active = { run: Run; task: Task; controller: AbortController; promise: Promise<void> };

export class Bridge {
  store: Store;
  telegram: Telegram;
  runner: Runner;
  root: string;
  stateDir: string;
  active?: Active;
  ticking = false;
  stopping = false;
  trace: Trace;
  constructor(store: Store, telegram: Telegram, runner: Runner, root: string, stateDir: string) {
    this.store = store; this.telegram = telegram; this.runner = runner; this.root = root; this.stateDir = stateDir;
    this.trace = new Trace(store, telegram);
  }
  async say(text: string, buttons?: Parameters<Telegram['say']>[1]) {
    try { await this.telegram.say(text, buttons); }
    catch { console.error('Không gửi được thông báo Telegram; dữ liệu vẫn được giữ.'); }
  }
  async receive(update: Update) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return;
    const allowed = this.telegram.authorized(update);
    const callback = update.callback_query;
    let text: string | undefined;
    if (allowed) {
      if (callback) {
        const id = /^episode:([0-9a-f-]{36})$/.exec(callback.data ?? '')?.[1];
        if (id) text = `/resume_episode ${id}`;
      } else if (typeof update.message?.text === 'string') text = update.message.text;
    }
    const fresh = this.store.receive(update.update_id, text?.trim() ? text : undefined);
    if (fresh && allowed) {
      if (callback) await this.telegram.acknowledge(callback.id).catch(() => {});
      else if (!text?.trim()) await this.say('Hiện bot chỉ nhận tin nhắn chữ. Hãy gửi nội dung hoặc yêu cầu bằng chữ.');
    }
    await this.tick();
  }
  async status() {
    const task = this.store.current();
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE state IN ('pending','held')").get() as { n: number };
    const files = task ? this.store.taskDeliveries(task.id) : [];
    return `${task ? `Tập ${task.id}\n${task.state}: ${task.phase}` : 'Chưa có tập đang mở.'}\n${this.active ? 'Đang xử lý.' : 'Pi đang rảnh.'} Chờ/giữ lại: ${count.n}.\nẢnh chưa gửi: ${files.filter(f => ['pending', 'held'].includes(f.state)).length}; chưa rõ/lỗi: ${files.filter(f => ['unknown', 'failed'].includes(f.state)).length}.\n${task ? `Thư mục: episodes/telegram-${task.id}` : 'Nhắn yêu cầu để bắt đầu.'}`;
  }
  async listEpisodes(input: Input, argument?: string) {
    this.store.inputState(input.id, 'done');
    const page = argument === undefined ? 1 : Number(argument);
    if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / 15)) {
      await this.say('Dùng /episodes hoặc /episodes 2 để xem trang khác.');
      return;
    }
    const tasks = this.store.unfinished((page - 1) * 15, 16);
    if (!tasks.length) {
      await this.say(page === 1 ? 'Không có tập chưa kết thúc.' : 'Trang này không có tập. Dùng /episodes để về trang đầu.');
      return;
    }
    const current = this.store.current()?.id;
    const navigation = [page > 1 ? `Trang trước: /episodes ${page - 1}.` : '', tasks.length > 15 ? `Trang sau: /episodes ${page + 1}.` : ''].filter(Boolean);
    await this.say([`Tập chưa kết thúc · trang ${page}. Chọn để mở lại session.`, ...navigation].join('\n'), tasks.slice(0, 15).map(task => {
      const title = Array.from(task.title?.trim().replace(/\s+/g, ' ') || task.phase).slice(0, 36).join('');
      return { text: `${task.id === current ? 'Đang mở · ' : ''}${task.id.slice(0, 8)} · ${title}`, callback_data: `episode:${task.id}` };
    }));
  }
  async changeEpisode(input: Input, command: '/new' | '/done' | '/resume_episode', id?: string) {
    if (this.active) {
      this.store.inputState(input.id, 'done');
      await this.say('Tập còn đang chạy/gửi ảnh. Hãy /cancel hoặc đợi hoàn tất rồi thử lại.');
      return;
    }
    const previous = this.store.current();
    const resumed = this.store.transaction(() => {
      this.store.inputState(input.id, 'done');
      const task = command === '/resume_episode' ? this.store.activateTask(id ?? '') : undefined;
      if (command === '/resume_episode' && (!task || task.id === previous?.id)) return task;
      if (command !== '/resume_episode') this.store.leaveTask(command === '/done');
      if (previous) this.store.holdDeliveries(previous.id);
      this.store.holdInputs();
      return task;
    });
    if (command === '/resume_episode' && !resumed) {
      await this.say('Tập này đã kết thúc hoặc không còn trong danh sách. Dùng /episodes để xem lại.');
      return;
    }
    if (!resumed || resumed.id !== previous?.id) this.trace.reset();
    const message = resumed ? `Đã mở tập ${resumed.id}. Nhắn yêu cầu để tiếp tục, hoặc /done để kết thúc.`
      : command === '/new' ? 'Đã mở session mới. Tập cũ vẫn có thể mở lại bằng /episodes. Nhắn yêu cầu cho tập mới.'
      : 'Đã kết thúc tập; lịch sử và ảnh vẫn còn. Tập tiếp theo dùng session mới.';
    this.trace.add(message);
    await this.say(message);
  }
  async command(input: Input) {
    const [name, argument] = input.text.trim().split(/\s+/);
    const command = name.split('@')[0].toLowerCase();
    if (command === '/episodes') return this.listEpisodes(input, argument);
    if (command === '/new' || command === '/done' || command === '/resume_episode') return this.changeEpisode(input, command, argument);
    if (command === '/log' || command === '/trace_on' || command === '/trace_off') {
      this.store.inputState(input.id, 'done');
      if (command === '/log') await this.say(this.trace.text());
      else {
        await this.trace.setEnabled(command === '/trace_on');
        await this.say(this.trace.enabled() ? 'Trace đã bật: cập nhật một tin nhắn, tối đa 10 dòng mới nhất.' : 'Trace live đã tắt; /log vẫn xem 10 dòng mới nhất.');
      }
      return;
    }
    // Persist controls before replying; replaying /cancel is safe, /new is fenced by its update ID.
    if (command === '/cancel') {
      this.store.holdInputs();
      this.trace.add('Nhận lệnh hủy; API từ xa có thể vẫn đang chạy');
      if (this.active) {
        this.active.controller.abort('user');
        this.store.db.prepare("UPDATE runs SET state='cancelling' WHERE id=? AND revision IS NULL").run(this.active.run.id);
        this.store.db.prepare("UPDATE deliveries SET state='cancelled' WHERE run=? AND state IN ('pending','failed','unknown')").run(this.active.run.id);
        await this.runner.cancel();
        await this.active?.promise;
      } else {
        const task = this.store.current();
        if (task) {
          this.store.taskState(task.id, 'cancelled', 'Đã dừng; giữ toàn bộ dữ liệu');
          this.store.db.prepare("UPDATE deliveries SET state='cancelled' WHERE run IN (SELECT id FROM runs WHERE task=?) AND state IN ('pending','failed','unknown')").run(task.id);
        }
      }
      this.store.inputState(input.id, 'done');
      await this.say('Đã dừng; không tự chạy lại. Giữ ảnh và lịch sử. API đang xử lý từ xa có thể vẫn hoàn tất; không retry khi chưa xác định kết quả.');
    } else if (command === '/files') {
      if (this.active) {
        this.store.inputState(input.id, 'done');
        await this.say('Đang bận; đợi xong rồi /files để tải tệp ảnh gốc.');
        return;
      }
      const task = this.store.current();
      const run = task ? this.store.db.prepare("SELECT * FROM runs WHERE task=? AND state='ready' AND revision IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(task.id) as Run | undefined : undefined;
      if (!run) {
        this.store.inputState(input.id, 'done');
        await this.say('Chưa có revision đã chốt để tải tệp ảnh gốc.');
        return;
      }
      this.store.transaction(() => {
        this.store.inputState(input.id, 'done');
        this.store.set(`delivery_format:${run.id}`, 'document');
        this.store.db.prepare("UPDATE deliveries SET state='pending',message=NULL WHERE run=?").run(run.id);
      });
      await this.say(`Đang gửi tệp ảnh gốc ${run.revision}, không tạo lại ảnh. /resend tiếp tục gửi tệp nếu bị gián đoạn.`);
      this.startDelivery(run.id);
    } else if (command === '/resend') {
      this.store.inputState(input.id, 'done');
      if (this.active) { await this.say('Đang bận; đợi xong rồi /resend.'); return; }
      const task = this.store.current();
      if (!task) { await this.say('Chưa có tập để gửi lại.'); return; }
      this.store.db.prepare("UPDATE deliveries SET state='pending' WHERE state IN ('unknown','failed','cancelled','held') AND run IN (SELECT id FROM runs WHERE task=? AND state='ready')").run(task.id);
      await this.say('Chỉ gửi lại file đã lưu, không tạo lại ảnh. Ảnh có thể trùng nếu lần trước Telegram đã nhận nhưng mất xác nhận.');
      this.startDelivery();
    } else {
      this.store.inputState(input.id, 'done');
      await this.say(command === '/status' ? await this.status() : HELP);
    }
  }
  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      for (const input of this.store.inputs()) {
        const live = this.store.db.prepare('SELECT state FROM inbox WHERE id=?').get(input.id) as { state: string };
        if (live.state !== 'pending') continue;
        if (input.text.startsWith('/')) await this.command(input);
        else if (!this.active) this.start(input);
      }
      if (!this.active) this.startDelivery();
    } finally { this.ticking = false; }
  }
  start(input: Input) {
    const task = this.store.current() ?? this.store.createTask(this.root);
    const run = this.store.begin(task, input);
    this.trace.reset();
    this.trace.add(`Bắt đầu lượt ${run.id.slice(0, 8)}`);
    const controller = new AbortController();
    const active: Active = { task, run, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = this.execute(active, input).finally(() => { if (this.active === active) this.active = undefined; });
  }
  async execute(active: Active, input: Input) {
    const { task, run, controller } = active;
    const handoff = join(task.dir, 'handoff', run.id);
    let stage = 'prepare';
    try {
      await mkdir(handoff, { recursive: true });
      const request = { task_id: task.id, run_id: run.id, episode_dir: task.dir, previous_state: task.state, user_message: input.text };
      await writeFile(join(handoff, 'request.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
      await this.say(`Đã nhận yêu cầu cho tập ${task.id}. Pi tự làm và kiểm tra; dùng /status để xem tiến độ. Tin nhắn bổ sung được lưu và xử lý sau lượt hiện tại.`);
      if (controller.signal.aborted) throw new Error('Đã hủy');
      stage = 'pi';
      await this.runner.run(task.session, `Thực hiện yêu cầu Telegram trong file ${join(handoff, 'request.json')}. Đọc bridge/agent.md và các tài liệu hiện hành. Không có ảnh đính kèm: chọn file cần xem từ kịch bản, checkpoint và status của đúng trang; dùng read với đúng ảnh trên đĩa khi cần kiểm tra thị giác. Kết quả máy đọc phải ghi vào ${join(handoff, 'result.json')}.`,
        phase => { if (!controller.signal.aborted) this.store.taskState(task.id, 'running', phase); }, controller.signal,
        line => { if (!controller.signal.aborted) this.trace.add(line); });
      if (controller.signal.aborted) throw new Error('Đã hủy');
      stage = 'handoff';
      this.trace.add('Đang kiểm tra manifest và file JPEG/PNG bàn giao');
      const result = await collect(task, run, this.stateDir);
      if (controller.signal.aborted) throw new Error('Đã hủy');
      const revision = result.revision ?? null;
      this.store.finish(run, result.status === 'ready_for_review' ? 'ready' : 'blocked',
        result.status === 'ready_for_review' ? `${result.revision}: đã kiểm tra, đang bàn giao` : result.message, revision, result.files);
      run.revision = revision;
      if (result.status === 'ready_for_review') {
        stage = 'delivery';
        await this.deliver(run.id, controller.signal);
        if (controller.signal.aborted) throw new Error('Đã hủy khi bàn giao');
        this.deliveryPhase(task, run);
        await this.retainLatest(task);
        await this.say(`Tập ${task.id}, ${result.revision}: ${result.message}\nẢnh ở trạng thái ready_for_review, chưa tự coi là bạn đã duyệt. Nếu thiếu file, dùng /status rồi /resend.`);
      } else {
        this.store.holdInputs();
        await this.say(`Pi cần bạn bổ sung/xử lý: ${result.message}\nCác tin nhắn đang chờ được giữ lại, không tự chạy. Nhắn hướng xử lý mới khi đã xác định tình trạng API.`);
      }
    } catch (error) {
      const reason = error instanceof PiFailure ? error.message : stage === 'handoff'
        ? 'Manifest bàn giao thiếu/không hợp lệ hoặc file JPEG/PNG chưa đạt kiểm tra.'
        : 'Lỗi thực thi hoặc lưu dữ liệu; cần kiểm tra lịch sử và file của lượt này.';
      if (!controller.signal.aborted) {
        await writeFile(join(handoff, 'failure.json'), JSON.stringify({ task_id: task.id, run_id: run.id, stage, code: error instanceof PiFailure ? error.code : stage, message: reason }, null, 2) + '\n', { flag: 'wx' })
          .catch(() => { console.error('Không lưu được hồ sơ lỗi; xem trạng thái tập và lịch sử Pi.'); });
      }
      this.trace.add(controller.signal.aborted ? 'Lượt đã dừng; giữ dữ liệu' : reason);
      this.store.holdInputs();
      if (run.revision) {
        this.store.finish(run, 'ready', 'Bàn giao tạm dừng; /resend dùng lại ảnh đã chốt', run.revision);
        if (controller.signal.reason === 'user') this.store.taskState(task.id, 'cancelled', 'Đã hủy bàn giao; giữ ảnh đã chốt');
      } else {
        this.store.finish(run, controller.signal.aborted ? 'cancelled' : 'interrupted',
          controller.signal.aborted ? 'Đã hủy; giữ dữ liệu' : `Cần kiểm tra: ${reason}`);
      }
      if (!controller.signal.aborted) await this.say(`Tập ${task.id} đã dừng; chưa có kết quả bàn giao hợp lệ.\nNguyên nhân: ${reason}\nGiữ toàn bộ ảnh/checkpoint trong episodes/telegram-${task.id}; không tự tạo lại ảnh. Nhắn hướng xử lý mới để tiếp tục cùng tập; /new chỉ khi muốn mở tập khác.`);
    } finally { await this.trace.flush(); }
  }
  startDelivery(runId?: string) {
    const task = this.store.current();
    if (!task || this.active || this.stopping) return;
    const files = this.store.taskDeliveries(task.id).filter(file => !runId || file.run === runId);
    const file = files.find(file => file.state === 'pending' && files.every(prior => prior.run !== file.run || prior.position >= file.position || prior.state === 'sent'));
    if (!file) return;
    const run = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(file.run) as Run;
    const controller = new AbortController();
    const active: Active = { run, task, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = this.deliver(run.id, controller.signal).finally(async () => {
      if (controller.signal.aborted) {
        this.store.finish(run, 'ready', 'Bàn giao tạm dừng; /resend dùng lại ảnh đã chốt', run.revision);
        if (controller.signal.reason === 'user') this.store.taskState(task.id, 'cancelled', 'Đã hủy bàn giao; giữ ảnh đã chốt');
      } else {
        this.deliveryPhase(task, run);
        await this.retainLatest(task);
      }
      await this.trace.flush();
      if (this.active === active) this.active = undefined;
    });
  }
  async retainLatest(task: Task) {
    try {
      const current = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) as Task;
      const result = await pruneTask(this.store, current, this.stateDir);
      if (result.removed) this.trace.add('Đã dọn bản cũ/draft; giữ bản mới nhất đã gửi đủ');
    } catch { console.error('Chưa dọn được dữ liệu cũ; giữ file để tránh mất dữ liệu.'); }
  }
  deliveryPhase(task: Task, run: Run) {
    const complete = this.store.deliveries(run.id).every(file => file.state === 'sent');
    this.store.taskState(task.id, task.state === 'closed' ? 'closed' : 'idle',
      `${run.revision}: ${complete ? 'đã gửi đủ ảnh; chờ bạn xem' : 'gửi chưa đủ; /resend để gửi lại file đã chốt'}`);
  }
  async deliver(run: string, signal: AbortSignal) {
    const files = this.store.deliveries(run);
    // Runs saved before album support keep their original document delivery format.
    const documents = this.store.get(`delivery_format:${run}`) !== 'photo';
    for (let i = 0; i < files.length;) {
      if (signal.aborted || this.stopping) return;
      if (files[i].state === 'sent') { i++; continue; }
      if (files[i].state !== 'pending') break;
      const batch: Delivery[] = [];
      for (let j = i; j < files.length && batch.length < (documents ? 1 : 10) && files[j].state === 'pending'; j++) batch.push(files[j]);
      try {
        const payload = await Promise.all(batch.map(async file => {
          const bytes = await readFile(file.path);
          if (hash(bytes) !== file.hash) throw new Error('Ảnh đã thay đổi');
          return { bytes, name: basename(file.path), caption: `Lượt ${run} · slide ${file.position}` };
        }));
        if (signal.aborted || this.stopping) return;
        this.trace.add(`Đang gửi ${documents ? 'tệp gốc' : 'ảnh/album'} slide ${batch[0].position}-${batch.at(-1)!.position}`);
        this.store.transaction(() => batch.forEach(file => this.store.deliveryState(file, 'sending')));
        const messages = documents ? [await this.telegram.send(payload[0].bytes, payload[0].name, payload[0].caption)] : await this.telegram.photos(payload);
        this.store.transaction(() => batch.forEach((file, index) => this.store.deliveryState(file, 'sent', messages[index])));
        this.trace.add(`Telegram xác nhận slide ${batch[0].position}-${batch.at(-1)!.position}`);
      } catch (error) {
        this.store.transaction(() => batch.forEach(file => this.store.deliveryState(file, error instanceof TelegramError && error.ambiguous ? 'unknown' : 'failed')));
        this.trace.add(`Gửi slide ${batch[0].position}-${batch.at(-1)!.position} chưa hoàn tất; không tự tạo lại ảnh`);
        await this.say('Gửi ảnh chưa hoàn tất. /resend chỉ gửi lại phần chưa nhận, không tạo ảnh mới; có thể trùng nếu Telegram đã nhận nhưng mất xác nhận. Dùng /files để lấy tệp ảnh gốc (kể cả ảnh vượt giới hạn 10 MB của album).');
        return;
      }
      i += batch.length;
    }
  }
  async shutdown() {
    this.stopping = true;
    const active = this.active;
    if (active) {
      active.controller.abort('shutdown');
      await this.runner.cancel();
      await active.promise;
    }
    await this.runner.stop();
    await this.trace.close();
  }
}
