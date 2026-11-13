import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collect, hash } from './artifacts.ts';
import { Store } from './store.ts';
import type { Input, Run, Task } from './store.ts';
import { Telegram, TelegramError } from './telegram.ts';
import type { Update } from './telegram.ts';
import type { Runner } from './pi.ts';
import { Trace } from './trace.ts';

const HELP = 'Nhắn yêu cầu làm slide; Pi tự viết, vẽ và kiểm tra rồi gửi PNG gốc. Tin nhắn sau dùng để sửa cùng tập.\n/status: tiến độ\n/trace on|off: bật/tắt theo dõi trực tiếp (10 dòng)\n/log hoặc /trace: 10 dòng mới nhất\n/cancel: dừng, giữ dữ liệu\n/done: kết thúc tập\n/new: hội thoại và tập mới\n/resend: gửi lại ảnh chưa nhận được (có thể trùng nếu Telegram đã nhận nhưng mất xác nhận).\nChỉ hỗ trợ tin nhắn chữ; bạn tự đăng TikTok.';

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
  async say(text: string) {
    try { await this.telegram.say(text); }
    catch { console.error('Không gửi được thông báo Telegram; dữ liệu vẫn được giữ.'); }
  }
  async receive(update: Update) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return;
    const allowed = this.telegram.authorized(update);
    const text = allowed && typeof update.message?.text === 'string' ? update.message.text : undefined;
    const fresh = this.store.receive(update.update_id, text?.trim() ? text : undefined);
    if (fresh && allowed && !text?.trim()) await this.say('Hiện bot chỉ nhận tin nhắn chữ. Hãy gửi nội dung hoặc yêu cầu bằng chữ.');
    await this.tick();
  }
  async status() {
    const task = this.store.current();
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE state IN ('pending','held')").get() as { n: number };
    const files = this.store.deliveries();
    return `${task ? `Tập ${task.id}\n${task.state}: ${task.phase}` : 'Chưa có tập đang mở.'}\n${this.active ? 'Đang xử lý.' : 'Pi đang rảnh.'} Chờ/giữ lại: ${count.n}.\nẢnh chưa gửi: ${files.filter(f => f.state === 'pending').length}; chưa rõ/lỗi: ${files.filter(f => ['unknown', 'failed'].includes(f.state)).length}.\n${task ? `Thư mục: episodes/telegram-${task.id}` : 'Nhắn yêu cầu để bắt đầu.'}`;
  }
  async command(input: Input) {
    const command = input.text.split(/\s/)[0].split('@')[0].toLowerCase();
    if (command === '/log' || command === '/trace') {
      this.store.inputState(input.id, 'done');
      const option = input.text.trim().split(/\s+/)[1]?.toLowerCase();
      if (command === '/log' || !option) await this.say(this.trace.text());
      else if (option === 'on' || option === 'off') {
        await this.trace.setEnabled(option === 'on');
        await this.say(this.trace.enabled() ? 'Trace đã bật: cập nhật một tin nhắn, tối đa 10 dòng mới nhất.' : 'Trace live đã tắt; /log vẫn xem 10 dòng mới nhất.');
      } else await this.say('Dùng /trace on, /trace off hoặc /log (10 dòng mới nhất).');
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
    } else if (command === '/new' || command === '/done') {
      if (this.active) {
        this.store.inputState(input.id, 'done');
        await this.say('Tập còn đang chạy/gửi ảnh. Hãy /cancel hoặc đợi hoàn tất rồi gửi lại lệnh này.');
        return;
      }
      this.store.transaction(() => {
        this.store.closeTask(command === '/new');
        this.store.holdInputs();
        this.store.inputState(input.id, 'done');
      });
      this.trace.reset();
      this.trace.add(command === '/new' ? 'Đã mở hội thoại mới' : 'Đã kết thúc tập; giữ dữ liệu');
      await this.say(command === '/new' ? 'Đã mở hội thoại mới; dữ liệu cũ vẫn còn. Nhắn yêu cầu cho tập mới.' : 'Đã kết thúc tập; lịch sử và ảnh vẫn còn. Nhắn yêu cầu để tạo tập tiếp theo.');
    } else if (command === '/resend') {
      this.store.inputState(input.id, 'done');
      if (this.active) { await this.say('Đang bận; đợi xong rồi /resend.'); return; }
      const task = this.store.current();
      if (!task) { await this.say('Chưa có tập để gửi lại.'); return; }
      this.store.db.prepare("UPDATE deliveries SET state='pending' WHERE state IN ('unknown','failed','cancelled') AND run IN (SELECT id FROM runs WHERE task=? AND state='ready')").run(task.id);
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
    try {
      const handoff = join(task.dir, 'handoff', run.id);
      await mkdir(handoff, { recursive: true });
      const request = { task_id: task.id, run_id: run.id, episode_dir: task.dir, previous_state: task.state, user_message: input.text };
      await writeFile(join(handoff, 'request.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
      await this.say(`Đã nhận yêu cầu cho tập ${task.id}. Pi tự làm và kiểm tra; dùng /status để xem tiến độ. Tin nhắn bổ sung được lưu và xử lý sau lượt hiện tại.`);
      if (controller.signal.aborted) throw new Error('Đã hủy');
      await this.runner.run(task.session, `Thực hiện yêu cầu Telegram trong file ${join(handoff, 'request.json')}. Đọc bridge/agent.md và các tài liệu hiện hành. Kết quả máy đọc phải ghi vào ${join(handoff, 'result.json')}.`,
        phase => { if (!controller.signal.aborted) this.store.taskState(task.id, 'running', phase); }, controller.signal,
        line => { if (!controller.signal.aborted) this.trace.add(line); });
      if (controller.signal.aborted) throw new Error('Đã hủy');
      this.trace.add('Đang kiểm tra manifest và file PNG bàn giao');
      const result = await collect(task, run, this.stateDir);
      if (controller.signal.aborted) throw new Error('Đã hủy');
      const revision = result.revision ?? null;
      this.store.finish(run, result.status === 'ready_for_review' ? 'ready' : 'blocked',
        result.status === 'ready_for_review' ? `${result.revision}: đã kiểm tra, đang bàn giao` : result.message, revision, result.files);
      run.revision = revision;
      if (result.status === 'ready_for_review') {
        await this.deliver(run.id, controller.signal);
        if (controller.signal.aborted) throw new Error('Đã hủy khi bàn giao');
        this.deliveryPhase(task, run);
        await this.say(`Tập ${task.id}, ${result.revision}: ${result.message}\nẢnh ở trạng thái ready_for_review, chưa tự coi là bạn đã duyệt. Nếu thiếu file, dùng /status rồi /resend.`);
      } else {
        this.store.holdInputs();
        await this.say(`Pi cần bạn bổ sung/xử lý: ${result.message}\nCác tin nhắn đang chờ được giữ lại, không tự chạy. Nhắn hướng xử lý mới khi đã xác định tình trạng API.`);
      }
    } catch {
      this.trace.add(controller.signal.aborted ? 'Lượt đã dừng; giữ dữ liệu' : 'Lượt gián đoạn; không tự tạo lại ảnh');
      this.store.holdInputs();
      if (run.revision) {
        this.store.finish(run, 'ready', 'Bàn giao tạm dừng; /resend dùng lại ảnh đã chốt', run.revision);
        if (controller.signal.reason === 'user') this.store.taskState(task.id, 'cancelled', 'Đã hủy bàn giao; giữ ảnh đã chốt');
      } else {
        this.store.finish(run, controller.signal.aborted ? 'cancelled' : 'interrupted',
          controller.signal.aborted ? 'Đã hủy; giữ dữ liệu' : 'Cần kiểm tra: Pi/API hoặc manifest chưa hoàn tất');
      }
      if (!controller.signal.aborted) await this.say(`Tập ${task.id} đã dừng an toàn; chưa có kết quả bàn giao hợp lệ. Không tự tạo lại ảnh. Kiểm tra dữ liệu trong episodes/telegram-${task.id}, rồi nhắn hướng xử lý mới hoặc /new.`);
    } finally { await this.trace.flush(); }
  }
  startDelivery() {
    const files = this.store.deliveries();
    const file = files.find(file => file.state === 'pending' && files.every(prior => prior.run !== file.run || prior.position >= file.position || prior.state === 'sent'));
    if (!file || this.active || this.stopping) return;
    const run = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(file.run) as Run;
    const task = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(run.task) as Task;
    const controller = new AbortController();
    const active: Active = { run, task, controller, promise: Promise.resolve() };
    this.active = active;
    active.promise = this.deliver(run.id, controller.signal).finally(async () => {
      if (controller.signal.aborted) {
        this.store.finish(run, 'ready', 'Bàn giao tạm dừng; /resend dùng lại ảnh đã chốt', run.revision);
        if (controller.signal.reason === 'user') this.store.taskState(task.id, 'cancelled', 'Đã hủy bàn giao; giữ ảnh đã chốt');
      } else this.deliveryPhase(task, run);
      await this.trace.flush();
      if (this.active === active) this.active = undefined;
    });
  }
  deliveryPhase(task: Task, run: Run) {
    const complete = this.store.deliveries(run.id).every(file => file.state === 'sent');
    this.store.taskState(task.id, task.state === 'closed' ? 'closed' : 'idle',
      `${run.revision}: ${complete ? 'đã gửi đủ ảnh; chờ bạn xem' : 'gửi chưa đủ; /resend để gửi lại file đã chốt'}`);
  }
  async deliver(run: string, signal: AbortSignal) {
    for (const file of this.store.deliveries(run)) {
      if (signal.aborted || this.stopping) return;
      if (file.state === 'sent') continue;
      if (file.state !== 'pending') break;
      try {
        const bytes = await readFile(file.path);
        if (hash(bytes) !== file.hash) throw new Error('Ảnh đã thay đổi');
        this.trace.add(`Đang gửi slide ${file.position} qua Telegram`);
        this.store.deliveryState(file, 'sending');
        const message = await this.telegram.send(bytes, `${String(file.position).padStart(3, '0')}.png`, `Lượt ${run} · slide ${file.position}`);
        this.store.deliveryState(file, 'sent', message);
        this.trace.add(`Telegram xác nhận đã nhận slide ${file.position}`);
      } catch (error) {
        this.store.deliveryState(file, error instanceof TelegramError && error.ambiguous ? 'unknown' : 'failed');
        this.trace.add(`Gửi slide ${file.position} chưa hoàn tất; không tự tạo lại ảnh`);
        await this.say('Gửi ảnh chưa hoàn tất. Ảnh vẫn được giữ; /resend chỉ gửi lại file, không tạo ảnh mới. Nếu mất xác nhận Telegram, gửi lại có thể trùng.');
        return;
      }
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
