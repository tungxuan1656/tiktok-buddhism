import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../store.ts';
import type { Run } from '../store.ts';
import { Bridge } from '../bridge.ts';
import { Telegram, TelegramError } from '../telegram.ts';
import type { Runner } from '../pi.ts';
import { collect, hash } from '../artifacts.ts';

const message = (id: number, text: string, owner = 123, type = 'private') => ({ update_id: id, message: { from: { id: owner }, chat: { id: owner, type }, text } });
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
class FakeTelegram extends Telegram {
  texts: string[] = [];
  sent: string[] = [];
  sendHook?: () => Promise<void>;
  constructor() { super('not-a-real-token', 123); }
  override async say(text: string) { this.texts.push(text); }
  override async send(bytes: Uint8Array, name: string) {
    await this.sendHook?.();
    this.sent.push(`${name}:${hash(bytes)}`);
    return this.sent.length;
  }
}
class FakeRunner implements Runner {
  calls: string[] = [];
  hook: () => Promise<void> = async () => {};
  cancelHook: () => Promise<void> = async () => {};
  async run(session: string) { this.calls.push(session); await this.hook(); }
  async cancel() { await this.cancelHook(); }
  async stop() {}
}
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'buddhism-test-'));
  const stateDir = join(root, '.telegram');
  await mkdir(stateDir);
  const store = new Store(join(stateDir, 'state.sqlite'));
  const telegram = new FakeTelegram();
  const runner = new FakeRunner();
  const bridge = new Bridge(store, telegram, runner, root, stateDir);
  t.after(async () => { await bridge.shutdown(); store.db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, stateDir, store, telegram, runner, bridge };
}
async function fixture(store: Store, count = 2, revision = 'r01') {
  const task = store.current()!;
  const run = store.db.prepare('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1').get() as Run;
  const dir = join(task.dir, 'output', revision);
  const report = { task_id: task.id, run_id: run.id, status: 'ready_for_review', checked: true, revision, message: 'Đã kiểm tra.', files: [] as string[] };
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const name = `${String(i).padStart(3, '0')}.png`;
    execFileSync('magick', ['-size', '1080x1440', `xc:${i % 2 ? 'white' : 'beige'}`, join(dir, name)]);
    report.files.push(`output/${revision}/${name}`);
  }
  await writeFile(join(dir, 'episode.json'), JSON.stringify({ status: 'ready_for_review', slides: report.files.map(image => ({ image })) }));
  await writeFile(join(task.dir, 'handoff', run.id, 'result.json'), JSON.stringify(report));
  return { task, run, report };
}
async function settled(bridge: Bridge) { await bridge.active?.promise; }

test('only configured private owner is accepted; duplicate updates never generate again', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  await bridge.receive(message(1, 'intruder', 999));
  await bridge.receive(message(2, 'group', 123, 'group'));
  assert.equal(runner.calls.length, 0);
  const original = '  Làm một tập\nGiữ nguyên chữ và dấu.  \n';
  await bridge.receive(message(3, original));
  await settled(bridge);
  const run = store.db.prepare('SELECT * FROM runs').get() as Run;
  const request = JSON.parse(await readFile(join(store.current()!.dir, 'handoff', run.id, 'request.json'), 'utf8'));
  assert.equal(request.user_message, original);
  await bridge.receive(message(3, 'Làm một tập'));
  assert.equal(runner.calls.length, 1);
  assert.equal(telegram.sent.length, 2);
  assert.match(telegram.sent[0], /^001.png:/);
  assert.match(telegram.sent[1], /^002.png:/);
  assert.equal(store.deliveries()[0].message, 1);
});

test('ordinary follow-ups reuse task/session; /done keeps session; /new changes it without deleting old files', async t => {
  const { bridge, store, runner } = await setup(t);
  runner.hook = async () => {
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task=?').get(store.current()!.id) as { n: number };
    await fixture(store, 1, `r${String(count.n).padStart(2, '0')}`);
  };
  await bridge.receive(message(1, 'Tập đầu')); await settled(bridge);
  const first = store.current()!;
  await bridge.receive(message(2, 'Sửa câu cuối')); await settled(bridge);
  assert.equal(store.current()!.id, first.id);
  assert.equal(store.deliveries().length, 2);
  await bridge.receive(message(3, '/done'));
  await bridge.receive(message(4, 'Tập tiếp')); await settled(bridge);
  assert.notEqual(store.current()!.id, first.id);
  assert.equal(runner.calls[0], runner.calls[2]);
  await bridge.receive(message(5, '/new'));
  await bridge.receive(message(6, 'Tập mới')); await settled(bridge);
  assert.notEqual(runner.calls[0], runner.calls[3]);
  assert.ok(await readFile(join(first.dir, 'output/r01/001.png')));
});

test('cancel fences late results, holds queued additions, and refuses /new while busy', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  const entered = deferred(); const release = deferred();
  runner.hook = async () => { entered.resolve(); await release.promise; await fixture(store); };
  runner.cancelHook = async () => { release.resolve(); };
  await bridge.receive(message(1, 'Làm tập')); await entered.promise;
  await bridge.receive(message(2, 'Bổ sung đang chờ'));
  const task = store.current()!.id;
  await bridge.receive(message(3, '/new'));
  assert.equal(store.current()!.id, task);
  await bridge.receive(message(4, '/cancel'));
  await bridge.tick();
  assert.equal(telegram.sent.length, 0);
  assert.equal(runner.calls.length, 1);
  assert.equal(store.current()!.state, 'cancelled');
  assert.equal((store.db.prepare('SELECT state FROM inbox WHERE id=2').get() as { state: string }).state, 'held');
});

test('restart marks running requests interrupted and sending documents unknown; never reruns prompts', async t => {
  const { root, store, bridge, runner } = await setup(t);
  const task = store.createTask(root);
  store.receive(1, 'original');
  const run = store.begin(task, store.inputs()[0]);
  store.receive(2, 'queued addition');
  store.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,NULL)').run(run.id, 1, '/not-used', 'hash', 'sending');
  assert.equal(store.recover(), true);
  assert.equal(store.current()!.state, 'needs_attention');
  assert.equal(store.deliveries()[0].state, 'unknown');
  assert.equal(store.inputs().length, 0);
  await bridge.tick();
  assert.equal(runner.calls.length, 0);
  assert.equal(store.get('offset'), '3');
});

test('ambiguous Telegram send stops ordered delivery; /resend sends stored bytes without Pi', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  telegram.sendHook = async () => { throw new TelegramError(true); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  assert.deepEqual(store.deliveries().map(f => f.state), ['unknown', 'pending']);
  await bridge.tick(); await settled(bridge);
  assert.equal(telegram.sent.length, 0);
  telegram.sendHook = undefined;
  await bridge.receive(message(2, '/resend')); await settled(bridge);
  assert.deepEqual(store.deliveries().map(f => f.state), ['sent', 'sent']);
  assert.equal(runner.calls.length, 1);
});

test('cancel while an upload is in flight records its acknowledgement but never sends next page', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  const sending = deferred(); const release = deferred();
  runner.hook = async () => { await fixture(store); };
  telegram.sendHook = async () => { sending.resolve(); await release.promise; };
  await bridge.receive(message(1, 'Tập')); await sending.promise;
  const cancellation = bridge.receive(message(2, '/cancel'));
  assert.equal((store.db.prepare('SELECT state FROM runs').get() as { state: string }).state, 'ready');
  release.resolve(); await cancellation;
  assert.equal(telegram.sent.length, 1);
  assert.equal(store.current()!.state, 'cancelled');
  assert.equal(store.deliveries()[1].state, 'cancelled');
});

test('recovery preserves a committed revision even if a crash left its run cancelling', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  telegram.sendHook = async () => { throw new TelegramError(true); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  store.db.prepare("UPDATE runs SET state='cancelling'").run();
  store.recover();
  assert.equal((store.db.prepare('SELECT state FROM runs').get() as { state: string }).state, 'ready');
  telegram.sendHook = undefined;
  await bridge.receive(message(2, '/resend')); await settled(bridge);
  assert.equal(telegram.sent.length, 2);
  assert.equal(runner.calls.length, 1);
});

test('shutdown during an ambiguous upload preserves committed revision for resend after restart', async t => {
  const { bridge, store, runner, telegram, root, stateDir } = await setup(t);
  const sending = deferred(); const release = deferred();
  runner.hook = async () => { await fixture(store); };
  telegram.sendHook = async () => { sending.resolve(); await release.promise; throw new TelegramError(true); };
  await bridge.receive(message(1, 'Tập')); await sending.promise;
  const shutdown = bridge.shutdown(); release.resolve(); await shutdown;
  assert.equal((store.db.prepare('SELECT state FROM runs').get() as { state: string }).state, 'ready');
  const recovered = new Store(join(stateDir, 'state.sqlite'));
  const nextTelegram = new FakeTelegram(); const nextRunner = new FakeRunner();
  const next = new Bridge(recovered, nextTelegram, nextRunner, root, stateDir);
  t.after(async () => { await next.shutdown(); recovered.db.close(); });
  recovered.recover();
  assert.equal(recovered.deliveries()[0].state, 'unknown');
  await next.receive(message(2, '/resend')); await settled(next);
  assert.equal(nextTelegram.sent.length, 2);
  assert.equal(nextRunner.calls.length, 0);
});

test('manifest rejects wrong run, outside paths, mismatched order, invalid PNG and immutable revision reuse', async t => {
  const { bridge, store, runner, telegram, stateDir } = await setup(t);
  let data: Awaited<ReturnType<typeof fixture>>;
  runner.hook = async () => { data = await fixture(store); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const { task, run, report } = data!;
  const path = join(task.dir, 'handoff', run.id, 'result.json');
  await writeFile(path, JSON.stringify({ ...report, run_id: 'old' }));
  await assert.rejects(collect(task, run, stateDir), /lượt/);
  await writeFile(path, JSON.stringify({ ...report, files: ['../../outside.png', report.files[1]] }));
  await assert.rejects(collect(task, run, stateDir));
  await writeFile(path, JSON.stringify({ ...report, files: [...report.files].reverse() }));
  await assert.rejects(collect(task, run, stateDir));
  await writeFile(path, JSON.stringify(report));
  const original = await readFile(join(task.dir, report.files[0]));
  await writeFile(join(task.dir, report.files[0]), 'not png');
  await assert.rejects(collect(task, run, stateDir), /PNG/);
  await writeFile(join(task.dir, report.files[0]), original);
  const sent = telegram.sent.length;
  await bridge.receive(message(2, 'Try reusing r01')); await settled(bridge);
  assert.equal(telegram.sent.length, sent);
  assert.equal(store.current()!.state, 'needs_attention');
});

test('symlinks cannot escape the task and mutable source files do not change frozen outbox', async t => {
  const { bridge, store, runner, stateDir, root } = await setup(t);
  let data: Awaited<ReturnType<typeof fixture>>;
  runner.hook = async () => { data = await fixture(store, 1); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const file = store.deliveries()[0];
  const { task, run, report } = data!;
  const path = join(task.dir, report.files[0]);
  await writeFile(path, 'modified');
  assert.equal(hash(await readFile(file.path)), file.hash);
  await rm(path);
  const outside = join(root, 'outside.png');
  await writeFile(outside, await readFile(file.path));
  await symlink(outside, path);
  await assert.rejects(collect(task, run, stateDir), /ngoài/);
});

test('Telegram transport never exposes token in errors and distinguishes definite rejection', async () => {
  const token = '12345:secret-do-not-log';
  const network = new Telegram(token, 123, async () => { throw new Error(`request https://${token}`); });
  await assert.rejects(network.say('hello'), error => error instanceof TelegramError && error.ambiguous && !String(error).includes(token));
  const rejected = new Telegram(token, 123, async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 3 } }), { status: 429 }));
  await assert.rejects(rejected.say('hello'), error => error instanceof TelegramError && !error.ambiguous && error.retryAfter === 3);
});
