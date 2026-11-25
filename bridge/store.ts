import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type Task = { id: string; session: string; dir: string; state: string; phase: string };
export type Run = { id: string; task: string; input: number; state: string; revision: string | null };
export type Delivery = { run: string; position: number; path: string; hash: string; state: string; message: number | null };
export type Input = { id: number; text: string; state: string };

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, text TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, dir TEXT NOT NULL,
        state TEXT NOT NULL, phase TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, input INTEGER NOT NULL,
        state TEXT NOT NULL, revision TEXT, UNIQUE(task, revision)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        run TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
        state TEXT NOT NULL, message INTEGER, PRIMARY KEY(run, position)
      );
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  receive(id: number, text?: string) {
    return this.transaction(() => {
      if (id < Number(this.get('offset') ?? 0)) return false;
      if (text !== undefined) this.db.prepare('INSERT OR IGNORE INTO inbox VALUES (?,?,?)').run(id, text, 'pending');
      this.set('offset', String(id + 1));
      return true;
    });
  }
  inputs(): Input[] {
    return this.db.prepare("SELECT * FROM inbox WHERE state='pending' ORDER BY id").all() as Input[];
  }
  inputState(id: number, state: string) {
    this.db.prepare('UPDATE inbox SET state=? WHERE id=?').run(state, id);
  }
  holdInputs() {
    this.db.prepare("UPDATE inbox SET state='held' WHERE state='pending' AND text NOT LIKE '/%'").run();
  }
  current(): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(this.get('task') ?? '') as Task | undefined;
  }
  createTask(root: string): Task {
    const session = this.get('session') ?? randomUUID();
    const id = randomUUID();
    const task = { id, session, dir: join(root, 'episodes', `telegram-${id}`), state: 'idle', phase: 'Mới nhận yêu cầu' };
    this.transaction(() => {
      this.set('session', session);
      this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(id, session, task.dir, task.state, task.phase);
      this.set('task', id);
    });
    return task;
  }
  taskState(id: string, state: string, phase: string) {
    this.db.prepare('UPDATE tasks SET state=?,phase=? WHERE id=?').run(state, phase, id);
  }
  begin(task: Task, input: Input): Run {
    const run = { id: randomUUID(), task: task.id, input: input.id, state: 'running', revision: null };
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,NULL)').run(run.id, task.id, input.id, 'running');
      this.inputState(input.id, 'working');
      this.taskState(task.id, 'running', 'Đang chuẩn bị kịch bản và ảnh');
    });
    return run;
  }
  finish(run: Run, state: string, phase: string, revision: string | null = null, deliveries: Omit<Delivery, 'state' | 'message'>[] = []) {
    this.transaction(() => {
      this.db.prepare('UPDATE runs SET state=?,revision=? WHERE id=?').run(state, revision, run.id);
      this.inputState(run.input, 'done');
      this.taskState(run.task, state === 'ready' ? 'idle' : state === 'cancelled' ? 'cancelled' : 'needs_attention', phase);
      if (deliveries.length) this.set(`delivery_format:${run.id}`, 'photo');
      for (const file of deliveries) {
        this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,NULL)').run(file.run, file.position, file.path, file.hash, 'pending');
      }
    });
  }
  finishUnchanged(run: Run, previous: Task) {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET state='unchanged' WHERE id=?").run(run.id);
      this.inputState(run.input, 'done');
      this.taskState(run.task, previous.state, previous.phase);
    });
  }
  latestWork(task: string): Run | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE task=? AND state!='unchanged' ORDER BY rowid DESC LIMIT 1").get(task) as Run | undefined;
  }
  latestReady(task: string): Run | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE task=? AND state='ready' AND revision IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(task) as Run | undefined;
  }
  committedRevisions(task: string) {
    return this.db.prepare(`SELECT revision, CASE
      WHEN state!='ready' THEN 'unavailable'
      WHEN EXISTS (SELECT 1 FROM deliveries WHERE run=runs.id)
        AND NOT EXISTS (SELECT 1 FROM deliveries WHERE run=runs.id AND state!='sent') THEN 'sent'
      ELSE 'unsent' END AS delivery
      FROM runs WHERE task=? AND revision IS NOT NULL ORDER BY rowid`).all(task) as { revision: string; delivery: 'sent' | 'unsent' | 'unavailable' }[];
  }
  deliveries(run?: string): Delivery[] {
    return this.db.prepare('SELECT * FROM deliveries WHERE (? IS NULL OR run=?) ORDER BY rowid').all(run ?? null, run ?? null) as Delivery[];
  }
  taskDeliveries(task: string): Delivery[] {
    return this.db.prepare('SELECT * FROM deliveries WHERE run IN (SELECT id FROM runs WHERE task=?) ORDER BY rowid').all(task) as Delivery[];
  }
  holdDeliveries(task: string) {
    this.db.prepare("UPDATE deliveries SET state='held' WHERE state='pending' AND run IN (SELECT id FROM runs WHERE task=?)").run(task);
  }
  deliveryState(file: Delivery, state: string, message: number | null = null) {
    this.db.prepare('UPDATE deliveries SET state=?,message=? WHERE run=? AND position=?').run(state, message, file.run, file.position);
  }
  recover(): boolean {
    return this.transaction(() => {
      const interrupted = this.db.prepare("SELECT * FROM runs WHERE state IN ('running','cancelling')").all() as Run[];
      for (const run of interrupted) {
        const committed = run.revision !== null;
        this.db.prepare('UPDATE runs SET state=? WHERE id=?').run(committed ? 'ready' : 'interrupted', run.id);
        this.inputState(run.input, 'done');
        this.taskState(run.task, committed ? 'idle' : 'needs_attention',
          committed ? 'Bàn giao gián đoạn; /resend dùng lại ảnh đã chốt' : 'Bị gián đoạn; cần kiểm tra API trước khi tiếp tục');
      }
      this.db.prepare("UPDATE deliveries SET state='unknown' WHERE state='sending'").run();
      if (interrupted.length) this.holdInputs();
      return interrupted.length > 0;
    });
  }
  listTasks(offset: number, limit: number, closed = false): (Task & { title: string | null })[] {
    return this.db.prepare(`SELECT tasks.*, (SELECT inbox.text FROM runs JOIN inbox ON inbox.id=runs.input
      WHERE runs.task=tasks.id ORDER BY runs.rowid LIMIT 1) AS title
      FROM tasks WHERE (state='closed')=? ORDER BY tasks.rowid DESC LIMIT ? OFFSET ?`).all(Number(closed), limit, offset) as (Task & { title: string | null })[];
  }
  activateTask(id: string, reopen = false): Task | undefined {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=? AND (state='closed')=?").get(id, Number(reopen)) as Task | undefined;
    if (!task) return;
    if (reopen) {
      const latest = this.latestWork(id);
      task.session = randomUUID();
      task.state = latest?.state === 'ready' ? 'idle' : 'needs_attention';
      task.phase = 'Đã mở lại bằng session mới; giữ phần đã làm.';
      this.db.prepare('UPDATE tasks SET session=?,state=?,phase=? WHERE id=?').run(task.session, task.state, task.phase, id);
    }
    this.set('task', task.id);
    this.set('session', task.session);
    return task;
  }
  leaveTask(close: boolean) {
    const task = this.current();
    if (task && close) this.taskState(task.id, 'closed', 'Đã kết thúc; giữ toàn bộ dữ liệu');
    this.set('task', '');
    this.set('session', randomUUID());
  }
}
