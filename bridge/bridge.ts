import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { collect, hash, manualHandoff } from './artifacts.ts';
import { Store } from './store.ts';
import type { Delivery, Input, Run, Task } from './store.ts';
import { Telegram, TelegramError } from './telegram.ts';
import type { Update } from './telegram.ts';
import { PiFailure } from './pi.ts';
import type { Runner } from './pi.ts';
import { Trace } from './trace.ts';
import { pruneTask } from './retention.ts';

const HELP = `Bạn cứ nhắn nội dung muốn làm. Mình sẽ lên kịch bản, vẽ và kiểm tra từng ảnh trước khi gửi để bạn xem và tự đăng.

Tin nhắn sau sẽ dùng để làm tiếp hoặc chỉnh cùng tập. Nếu đang bận, mình sẽ xử lý tin nhắn bổ sung sau khi xong lượt này. Hiện mình chỉ nhận tin nhắn chữ.

/status: xem tiến độ
/trace_on: bật theo dõi trực tiếp
/trace_off: tắt theo dõi trực tiếp
/log: xem 10 hoạt động gần nhất
/cancel: dừng và giữ lại phần đã làm
/done: kết thúc tập hiện tại
/new: tạm cất tập này để làm tập khác
/episodes: chọn lại tập chưa kết thúc
/files: tải tệp ảnh gốc của bản mới nhất
/resend: gửi lại phần chưa gửi đủ, theo đúng dạng ảnh hoặc tệp lần trước. Có thể trùng nếu Telegram đã nhận nhưng chưa xác nhận.`;

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
      else if (!text?.trim()) await this.say('Hiện mình chỉ đọc được tin nhắn chữ. Bạn nhắn lại nội dung cần làm nhé.');
    }
    await this.tick();
  }
  async status() {
    const task = this.store.current();
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE state IN ('pending','held')").get() as { n: number };
    const files = task ? this.store.taskDeliveries(task.id) : [];
    const manual = task?.state === 'needs_attention' && !files.length && await manualHandoff(task).catch(() => undefined);
    const phase = this.active?.run.revision ? 'Mình đang gửi ảnh cho bạn.'
      : manual ? 'Có bộ ảnh đã kiểm tra thủ công. Dùng /resend để mình gửi cho bạn.' : task?.phase;
    const waiting = files.filter(file => ['pending', 'held', 'cancelled'].includes(file.state)).length;
    const failed = files.filter(file => ['unknown', 'failed'].includes(file.state)).length;
    return [
      phase ?? 'Chưa có tập nào đang mở. Bạn nhắn yêu cầu để bắt đầu nhé.',
      count.n ? `Tin nhắn đang chờ hoặc được giữ lại: ${count.n}.` : '',
      waiting ? `Ảnh chưa gửi: ${waiting}.` : '',
      failed ? `Ảnh gửi lỗi hoặc chưa có xác nhận: ${failed}.` : '',
    ].filter(Boolean).join('\n');
  }
  async listEpisodes(input: Input, argument?: string) {
    this.store.inputState(input.id, 'done');
    const page = argument === undefined ? 1 : Number(argument);
    if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / 15)) {
      await this.say('Dùng /episodes để xem trang đầu, hoặc /episodes 2 để xem trang 2.');
      return;
    }
    const tasks = this.store.unfinished((page - 1) * 15, 16);
    if (!tasks.length) {
      await this.say(page === 1 ? 'Không có tập nào để mở lại.' : 'Trang này không có tập nào. Dùng /episodes để về trang đầu.');
      return;
    }
    const current = this.store.current()?.id;
    const navigation = [page > 1 ? `Trang trước: /episodes ${page - 1}.` : '', tasks.length > 15 ? `Trang sau: /episodes ${page + 1}.` : ''].filter(Boolean);
    await this.say([`Bạn muốn làm tiếp tập nào? (Trang ${page})`, ...navigation].join('\n'), tasks.slice(0, 15).map(task => {
      const title = Array.from(task.title?.trim().replace(/\s+/g, ' ') || task.phase).slice(0, 36).join('');
      return { text: `${task.id === current ? 'Đang mở · ' : ''}${title}`, callback_data: `episode:${task.id}` };
    }));
  }
  async changeEpisode(input: Input, command: '/new' | '/done' | '/resume_episode', id?: string) {
    if (this.active) {
      this.store.inputState(input.id, 'done');
      await this.say('Mình vẫn đang làm hoặc gửi ảnh cho tập này. Bạn đợi mình xong hoặc dùng /cancel để dừng trước nhé.');
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
    const message = resumed ? 'Mình đã mở lại tập bạn chọn. Bạn cứ nhắn phần muốn làm tiếp nhé.'
      : command === '/new' ? 'Bạn có thể nhắn yêu cầu cho tập mới. Nếu muốn quay lại tập cũ, dùng /episodes.'
      : 'Mình đã đóng tập này. Ảnh và lịch sử vẫn được giữ lại. Tin nhắn tiếp theo sẽ bắt đầu một tập mới.';
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
        await this.say(command === '/trace_off' ? 'Đã tắt theo dõi trực tiếp. Bạn vẫn xem được hoạt động gần đây bằng /log.'
          : this.trace.enabled() ? 'Mình sẽ cập nhật 10 hoạt động gần nhất trong cùng một tin nhắn.'
          : 'Chưa bật được theo dõi trực tiếp. Bạn vẫn xem được hoạt động gần đây bằng /log.');
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
      await this.say('Mình đã dừng và giữ lại ảnh, lịch sử cùng các tin nhắn đang chờ. Nếu máy chủ đã nhận yêu cầu vẽ, ảnh vẫn có thể được tạo xong. Mình sẽ không tự gửi lại yêu cầu vẽ.');
    } else if (command === '/files') {
      if (this.active) {
        this.store.inputState(input.id, 'done');
        await this.say('Bạn đợi mình xong lượt này rồi dùng /files để tải ảnh gốc nhé.');
        return;
      }
      const task = this.store.current();
      const run = task ? this.store.db.prepare("SELECT * FROM runs WHERE task=? AND state='ready' AND revision IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(task.id) as Run | undefined : undefined;
      if (!run) {
        this.store.inputState(input.id, 'done');
        await this.say('Tập này chưa có bộ ảnh hoàn chỉnh để tải.');
        return;
      }
      this.store.transaction(() => {
        this.store.inputState(input.id, 'done');
        this.store.set(`delivery_format:${run.id}`, 'document');
        this.store.db.prepare("UPDATE deliveries SET state='pending',message=NULL WHERE run=?").run(run.id);
      });
      await this.say('Mình đang gửi tệp ảnh gốc của bản mới nhất. Nếu chưa nhận đủ, bạn dùng /resend nhé.');
      this.startDelivery(run.id);
    } else if (command === '/resend') {
      this.store.inputState(input.id, 'done');
      if (this.active) { await this.say('Bạn đợi mình xong lượt này rồi dùng /resend nhé.'); return; }
      const task = this.store.current();
      if (!task) { await this.say('Chưa có tập nào đang mở để gửi lại.'); return; }
      const files = this.store.taskDeliveries(task.id);
      if (!files.length) {
        if (task.state === 'needs_attention') {
          try {
            const manual = await manualHandoff(task);
            if (manual) { this.start(input, manual); return; }
          } catch {
            await this.say('Mình chưa gửi ảnh vì không xác nhận được bản đã kiểm tra thủ công.');
            return;
          }
        }
        await this.say('Tập này chưa có bộ ảnh sẵn sàng để gửi.');
        return;
      }
      if (files.every(file => file.state === 'sent')) {
        await this.say('Mình đã gửi đủ ảnh của tập này. Bạn có thể dùng /files để tải ảnh gốc.');
        return;
      }
      this.store.db.prepare("UPDATE deliveries SET state='pending' WHERE state IN ('unknown','failed','cancelled','held') AND run IN (SELECT id FROM runs WHERE task=? AND state='ready')").run(task.id);
      await this.say('Mình đang gửi lại phần còn thiếu từ bộ ảnh đã lưu. Bạn có thể thấy ảnh trùng nếu lần trước Telegram đã nhận nhưng chưa xác nhận.');
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
  start(input: Input, manual?: Record<string, unknown>) {
    const task = this.store.current() ?? this.store.createTask(this.root);
    const run = this.store.begin(task, input);
    this.trace.reset();
    this.trace.add('Bắt đầu xử lý yêu cầu');
    const controller = new AbortController();
    const active: Active = { task, run, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = this.execute(active, input, manual).finally(() => { if (this.active === active) this.active = undefined; });
  }
  async execute(active: Active, input: Input, manual?: Record<string, unknown>) {
    const { task, run, controller } = active;
    const handoff = join(task.dir, 'handoff', run.id);
    let stage = 'prepare';
    try {
      await mkdir(handoff, { recursive: true });
      const request = { task_id: task.id, run_id: run.id, episode_dir: task.dir, previous_state: task.state, user_message: input.text };
      await writeFile(join(handoff, 'request.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
      if (manual) {
        stage = 'handoff';
        await writeFile(join(handoff, 'result.json'), JSON.stringify({ ...manual, run_id: run.id }, null, 2) + '\n', { flag: 'wx' });
        await this.say('Mình đang kiểm tra lại các tệp trước khi gửi, không vẽ lại ảnh.');
      } else {
        await this.say('Mình bắt đầu làm nhé. Bạn có thể dùng /status để xem tiến độ.');
        if (controller.signal.aborted) throw new Error('Đã hủy');
        stage = 'pi';
        await this.runner.run(task.session, `Thực hiện yêu cầu Telegram trong file ${join(handoff, 'request.json')}. Làm theo bridge/agent.md. Ghi kết quả vào ${join(handoff, 'result.json')}.`,
          phase => { if (!controller.signal.aborted) this.store.taskState(task.id, 'running', phase); }, controller.signal,
          line => { if (!controller.signal.aborted) this.trace.add(line); });
      }
      if (controller.signal.aborted) throw new Error('Đã hủy');
      stage = 'handoff';
      this.trace.add('Đang kiểm tra bộ ảnh trước khi gửi');
      const result = await collect(task, run, this.stateDir, Boolean(manual));
      if (controller.signal.aborted) throw new Error('Đã hủy');
      const revision = result.revision ?? null;
      this.store.finish(run, result.status === 'ready_for_review' ? 'ready' : 'blocked',
        result.status === 'ready_for_review' ? 'Ảnh đã được kiểm tra. Mình đang gửi cho bạn.' : result.message, revision, result.files);
      run.revision = revision;
      if (result.status === 'ready_for_review') {
        stage = 'delivery';
        await this.deliver(run.id, controller.signal);
        if (controller.signal.aborted) throw new Error('Đã hủy khi bàn giao');
        const complete = this.deliveryPhase(task, run);
        await this.retainLatest(task);
        if (!complete) return;
        await this.say([
          `Mình gửi đủ ${result.files.length} ảnh rồi, bạn xem nhé!`,
          result.message.trim(),
          'Nếu cần chỉnh, bạn cứ nhắn mình. Muốn tải ảnh gốc, dùng /files.',
        ].filter(Boolean).join('\n\n'));
      } else {
        this.store.holdInputs();
        await this.say(result.message.trim() || 'Mình chưa thể làm tiếp. Bạn dùng /status để xem tình hình nhé.');
      }
    } catch (error) {
      const reason = error instanceof PiFailure ? error.message : stage === 'handoff'
        ? 'Thiếu thông tin bàn giao hoặc tệp ảnh cuối không hợp lệ.'
        : 'Có lỗi trong lúc xử lý hoặc lưu kết quả.';
      if (!controller.signal.aborted) {
        await writeFile(join(handoff, 'failure.json'), JSON.stringify({ task_id: task.id, run_id: run.id, stage, code: error instanceof PiFailure ? error.code : stage, message: reason }, null, 2) + '\n', { flag: 'wx' })
          .catch(() => { console.error('Không lưu được hồ sơ lỗi; xem trạng thái tập và lịch sử Pi.'); });
      }
      this.trace.add(controller.signal.aborted ? 'Lượt đã dừng; giữ dữ liệu' : reason);
      this.store.holdInputs();
      if (run.revision) {
        this.store.finish(run, 'ready', 'Đã tạm dừng gửi ảnh. Dùng /resend để gửi tiếp.', run.revision);
        if (controller.signal.reason === 'user') this.store.taskState(task.id, 'cancelled', 'Đã dừng gửi. Ảnh đã lưu vẫn còn.');
      } else {
        this.store.finish(run, controller.signal.aborted ? 'cancelled' : 'interrupted',
          controller.signal.aborted ? 'Đã dừng. Phần đã làm vẫn được giữ lại.' : `Chưa làm xong. Nguyên nhân: ${reason}`);
      }
      if (!controller.signal.aborted) await this.say(`Mình chưa xong tập này.\nNguyên nhân: ${reason}\n\nPhần đã làm vẫn được giữ lại. Mình sẽ không tự vẽ lại. Khi sẵn sàng, bạn nhắn mình để tiếp tục tập này nhé.`);
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
        this.store.finish(run, 'ready', 'Đã tạm dừng gửi ảnh. Dùng /resend để gửi tiếp.', run.revision);
        if (controller.signal.reason === 'user') this.store.taskState(task.id, 'cancelled', 'Đã dừng gửi. Ảnh đã lưu vẫn còn.');
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
      complete ? 'Mình đã gửi đủ ảnh. Bạn có thể xem hoặc dùng /files để tải ảnh gốc.' : 'Chưa gửi đủ ảnh. Dùng /resend để gửi tiếp.');
    return complete;
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
      const first = batch[0].position;
      const range = batch.length === 1 ? `${first}` : `${first}–${batch.at(-1)!.position}`;
      const caption = `${documents ? 'Tệp ảnh gốc' : 'Ảnh'} ${range}/${files.length}`;
      try {
        const payload = await Promise.all(batch.map(async (file, index) => {
          const bytes = await readFile(file.path);
          if (hash(bytes) !== file.hash) throw new Error('Ảnh đã thay đổi');
          return { bytes, name: basename(file.path), caption: index === 0 ? caption : '' };
        }));
        if (signal.aborted || this.stopping) return;
        this.trace.add(`Đang gửi ${caption.toLowerCase()}`);
        this.store.transaction(() => batch.forEach(file => this.store.deliveryState(file, 'sending')));
        const messages = documents ? [await this.telegram.send(payload[0].bytes, payload[0].name, payload[0].caption)] : await this.telegram.photos(payload);
        this.store.transaction(() => batch.forEach((file, index) => this.store.deliveryState(file, 'sent', messages[index])));
        this.trace.add(`Telegram đã nhận ${caption.toLowerCase()}`);
      } catch (error) {
        this.store.transaction(() => batch.forEach(file => this.store.deliveryState(file, error instanceof TelegramError && error.ambiguous ? 'unknown' : 'failed')));
        this.trace.add(`Chưa gửi xong ${caption.toLowerCase()}`);
        await this.say(`Mình chưa gửi đủ ${documents ? 'tệp ảnh gốc' : 'ảnh'}. Bạn dùng /resend để gửi tiếp. Có thể trùng nếu Telegram đã nhận nhưng chưa xác nhận.${documents ? '' : ' Nếu ảnh quá lớn để gửi trong album, dùng /files để tải tệp gốc.'}`);
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
