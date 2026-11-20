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
import { PiFailure } from '../pi.ts';
import type { Runner } from '../pi.ts';
import { collect, hash, imageBytes } from '../artifacts.ts';
import { pruneTask } from '../retention.ts';

const message = (id: number, text: string, owner = 123, type = 'private') => ({ update_id: id, message: { from: { id: owner }, chat: { id: owner, type }, text } });
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
class FakeTelegram extends Telegram {
  texts: string[] = [];
  sent: string[] = [];
  albums: string[][] = [];
  albumCaptions: string[][] = [];
  documents: string[] = [];
  documentCaptions: string[] = [];
  sendHook?: () => Promise<void>;
  traces: string[] = [];
  constructor() { super('not-a-real-token', 123); }
  buttons: NonNullable<Parameters<Telegram['say']>[1]> = [];
  callbacks: string[] = [];
  override async say(text: string, buttons?: Parameters<Telegram['say']>[1]) {
    this.texts.push(text);
    if (buttons) this.buttons = buttons;
  }
  override async acknowledge(id: string) { this.callbacks.push(id); }
  override async trace(text: string, message?: number) { this.traces.push(text); return message ?? 100; }
  override async photos(files: { bytes: Uint8Array; name: string; caption: string }[]) {
    await this.sendHook?.();
    this.albums.push(files.map(file => file.name));
    this.albumCaptions.push(files.map(file => file.caption));
    return files.map(file => { this.sent.push(`${file.name}:${hash(file.bytes)}`); return this.sent.length; });
  }
  override async send(bytes: Uint8Array, name: string, caption: string) {
    await this.sendHook?.();
    this.documents.push(name);
    this.documentCaptions.push(caption);
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
async function fixture(store: Store, count = 2, revision = 'r01', extension = 'png') {
  const task = store.current()!;
  const run = store.db.prepare('SELECT * FROM runs ORDER BY rowid DESC LIMIT 1').get() as Run;
  const dir = join(task.dir, 'output', revision);
  const report = { task_id: task.id, run_id: run.id, status: 'ready_for_review', checked: true, revision, message: 'Đã kiểm tra.', files: [] as string[] };
  await mkdir(dir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const name = `${String(i).padStart(3, '0')}.${extension}`;
    execFileSync('magick', ['-size', '1080x1440', `xc:${i % 2 ? 'white' : 'beige'}`, join(dir, name)]);
    report.files.push(`output/${revision}/${name}`);
  }
  await writeFile(join(dir, 'episode.json'), JSON.stringify({ status: 'ready_for_review', slides: report.files.map(image => ({ image })) }));
  await writeFile(join(task.dir, 'handoff', run.id, 'result.json'), JSON.stringify(report));
  return { task, run, report };
}
async function settled(bridge: Bridge) { await bridge.active?.promise; }

test('failures keep a safe actionable cause in status and handoff without retrying Pi or images', async t => {
  for (const failure of [new PiFailure('model_json', 'Model/API trả HTTP 400: Invalid JSON body.'), new PiFailure('timeout', 'Pi vượt giới hạn 2 giờ.'), new Error('EXAMPLE_PRIVATE_VALUE'), undefined]) {
    const { bridge, runner, telegram, store } = await setup(t);
    runner.hook = async () => { if (failure) throw failure; };
    await bridge.receive(message(1, 'Tiếp tục tập')); await settled(bridge);
    const task = store.current()!;
    const run = store.db.prepare('SELECT * FROM runs').get() as Run;
    const report = JSON.parse(await readFile(join(task.dir, 'handoff', run.id, 'failure.json'), 'utf8'));
    assert.equal(report.run_id, run.id);
    const stage = failure ? 'pi' : 'handoff';
    assert.equal(report.code, failure instanceof PiFailure ? failure.code : stage);
    assert.equal(run.state, 'interrupted');
    assert.equal(task.state, 'needs_attention');
    assert.ok(task.phase.includes(report.message));
    assert.ok(telegram.texts.some(text => text.includes(`Nguyên nhân: ${report.message}`)));
    assert.ok(!JSON.stringify([report, task, telegram.texts]).includes('EXAMPLE_PRIVATE_VALUE'));
    assert.equal(runner.calls.length, 1);
    assert.equal(telegram.sent.length, 0);
    assert.equal(store.deliveries().length, 0);
  }
});

test('questions for the owner are sent as written, without a technical preamble', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  const question = 'Bạn muốn dùng bản dịch nào cho đoạn kinh này?';
  runner.hook = async () => {
    const task = store.current()!;
    const run = store.db.prepare('SELECT * FROM runs').get() as Run;
    await writeFile(join(task.dir, 'handoff', run.id, 'result.json'), JSON.stringify({
      task_id: task.id, run_id: run.id, status: 'needs_input', message: question,
    }));
  };
  await bridge.receive(message(1, 'Làm tập')); await settled(bridge);
  assert.equal(telegram.texts.at(-1), question);
  assert.equal(telegram.sent.length, 0);
  assert.equal(await bridge.status(), question);
});

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
  assert.equal(store.deliveries()[1].message, 2);
  assert.deepEqual(telegram.albums, [['001.png', '002.png']]);
  assert.deepEqual(telegram.documents, []);
});

test('follow-ups reuse the session; /done rotates it; /new parks tasks for reopening by the owner', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  const choose = (update_id: number, id: string, from = 123, type = 'private') => ({ update_id, callback_query: {
    id: `cb${update_id}`, from: { id: from }, message: { chat: { id: 123, type } }, data: `episode:${id}`,
  } });
  runner.hook = async () => {
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task=?').get(store.current()!.id) as { n: number };
    await fixture(store, 1, `r${String(count.n).padStart(2, '0')}`);
  };
  await bridge.receive(message(1, 'Tập đầu')); await settled(bridge);
  const first = store.current()!;
  await bridge.receive(message(2, 'Sửa câu cuối')); await settled(bridge);
  assert.equal(store.current()!.id, first.id);
  assert.equal(store.deliveries().length, 1);
  await bridge.receive(message(3, '/done'));
  await bridge.receive(message(4, 'Tập tiếp')); await settled(bridge);
  const second = store.current()!;
  assert.notEqual(second.id, first.id);
  assert.equal(runner.calls[0], runner.calls[1]);
  assert.notEqual(runner.calls[0], runner.calls[2]);
  await bridge.receive(message(5, '/new'));
  await bridge.receive(message(6, 'Tập mới')); await settled(bridge);
  const third = store.current()!;
  assert.notEqual(third.session, second.session);
  await bridge.receive(message(7, '/episodes'));
  assert.deepEqual(telegram.buttons.map(button => button.callback_data), [`episode:${third.id}`, `episode:${second.id}`]);
  assert.deepEqual(telegram.buttons.map(button => button.text), ['Đang mở · Tập mới', 'Tập tiếp']);
  await bridge.receive(choose(8, second.id, 999));
  await bridge.receive(choose(9, second.id, 123, 'group'));
  assert.equal(store.current()!.id, third.id);
  await bridge.receive(choose(10, first.id));
  assert.equal(store.current()!.id, third.id);
  await bridge.receive(choose(11, second.id));
  await bridge.receive(choose(11, third.id));
  assert.deepEqual(telegram.callbacks, ['cb10', 'cb11']);
  assert.equal(store.current()!.id, second.id);
  assert.equal(store.get('session'), second.session);
  assert.equal(runner.calls.length, 4);
  await bridge.receive(message(12, 'Sửa tập cũ')); await settled(bridge);
  assert.equal(runner.calls.at(-1), second.session);
  await bridge.receive(message(13, '/done'));
  assert.deepEqual(store.unfinished(0, 10).map(task => task.id), [third.id]);
  assert.ok(await readFile(join(first.dir, 'output/r02/001.png')));
});

test('parking holds pending delivery until an explicit /resend after reactivation', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store, 1); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const task = store.current()!;
  const file = store.deliveries()[0];
  store.deliveryState(file, 'pending');
  await bridge.receive(message(2, '/new'));
  assert.equal(store.deliveries()[0].state, 'held');
  await bridge.receive({ update_id: 3, callback_query: { id: 'cb3', from: { id: 123 }, message: { chat: { id: 123, type: 'private' } }, data: `episode:${task.id}` } });
  assert.equal(store.current()?.id, task.id);
  assert.equal(bridge.active, undefined);
  assert.equal(telegram.sent.length, 1);
  await bridge.receive(message(4, '/resend')); await settled(bridge);
  assert.equal(telegram.sent.length, 2);
  assert.equal(runner.calls.length, 1);
});

test('cancel fences late results, holds queued additions, and refuses /new while busy', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  const entered = deferred(); const release = deferred();
  runner.hook = async () => { entered.resolve(); await release.promise; await fixture(store); };
  runner.cancelHook = async () => { release.resolve(); };
  await bridge.receive(message(1, 'Làm tập')); await entered.promise;
  await bridge.receive(message(2, 'Bổ sung đang chờ'));
  const task = store.current()!.id;
  const status = await bridge.status();
  assert.match(status, /Tin nhắn đang chờ hoặc được giữ lại: 1/);
  assert.ok(!status.includes(task));
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

test('/resend reports an empty queue, then delivers a hash-pinned manual handoff only for the owner', async t => {
  const { bridge, runner, store, telegram } = await setup(t);
  let data!: Awaited<ReturnType<typeof fixture>>;
  runner.hook = async () => { data = await fixture(store); throw new PiFailure('model', 'HTTP 413'); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const { task, report } = data;
  await bridge.receive(message(2, '/resend'));
  assert.match(telegram.texts.at(-1)!, /chưa có bộ ảnh sẵn sàng để gửi/);
  const snapshot = await readFile(join(task.dir, 'output/r01/episode.json'));
  await writeFile(join(task.dir, 'episode.json'), snapshot);
  const sha256 = await Promise.all(report.files.map(async path => hash(await readFile(join(task.dir, path)))));
  const manifest = { ...report, snapshot_sha256: hash(snapshot), sha256 };
  const path = join(task.dir, 'handoff/manual.json');
  await writeFile(path, JSON.stringify({ ...manifest, sha256: ['changed', sha256[1]] }));
  await bridge.receive(message(3, '/resend')); await settled(bridge);
  assert.equal(telegram.sent.length, 0);
  assert.equal(store.deliveries().length, 0);
  await writeFile(path, JSON.stringify(manifest));
  assert.match(await bridge.status(), /đã kiểm tra thủ công.*\/resend/);
  await bridge.tick();
  await bridge.receive(message(4, '/resend', 999));
  assert.equal(telegram.sent.length, 0);
  await bridge.receive(message(5, '/resend')); await settled(bridge);
  assert.deepEqual(telegram.albums, [['001.png', '002.png']]);
  assert.deepEqual(store.deliveries().map(file => [file.state, file.hash]), sha256.map(digest => ['sent', digest]));
  assert.match(telegram.texts.at(-1)!, /Mình gửi đủ 2 ảnh rồi[\s\S]*Đã kiểm tra/);
  await bridge.receive(message(6, '/resend')); await settled(bridge);
  assert.match(telegram.texts.at(-1)!, /đã gửi đủ ảnh/);
  assert.equal(telegram.sent.length, 2);
  assert.equal(runner.calls.length, 1);
});

test('ambiguous Telegram send stops ordered delivery; /resend sends stored bytes without Pi', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  telegram.sendHook = async () => { throw new TelegramError(true); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  assert.deepEqual(store.deliveries().map(f => f.state), ['unknown', 'unknown']);
  assert.equal(telegram.texts.length, 2);
  assert.match(telegram.texts[1], /chưa gửi đủ ảnh.*\/resend/);
  assert.match(await bridge.status(), /Ảnh gửi lỗi hoặc chưa có xác nhận: 2/);
  await bridge.tick(); await settled(bridge);
  assert.equal(telegram.sent.length, 0);
  telegram.sendHook = undefined;
  await bridge.receive(message(2, '/resend')); await settled(bridge);
  assert.deepEqual(store.deliveries().map(f => f.state), ['sent', 'sent']);
  assert.equal(runner.calls.length, 1);
});

test('cancel while an album is in flight records the whole acknowledgement but never sends next batch', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  const sending = deferred(); const release = deferred();
  runner.hook = async () => { await fixture(store, 11); };
  telegram.sendHook = async () => { sending.resolve(); await release.promise; };
  await bridge.receive(message(1, 'Tập')); await sending.promise;
  const cancellation = bridge.receive(message(2, '/cancel'));
  assert.equal((store.db.prepare('SELECT state FROM runs').get() as { state: string }).state, 'ready');
  release.resolve(); await cancellation;
  assert.equal(telegram.sent.length, 10);
  assert.equal(store.current()!.state, 'cancelled');
  assert.deepEqual(store.deliveries().map(file => file.state), [...Array(10).fill('sent'), 'cancelled']);
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

test('crash recovery marks the entire in-flight album unknown and waits for explicit resend', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  store.db.prepare("UPDATE deliveries SET state='sending',message=NULL").run();
  store.recover();
  assert.deepEqual(store.deliveries().map(file => file.state), ['unknown', 'unknown']);
  await bridge.tick(); await settled(bridge);
  assert.equal(telegram.albums.length, 1);
  await bridge.receive(message(2, '/resend')); await settled(bridge);
  assert.equal(telegram.albums.length, 2);
  assert.equal(runner.calls.length, 1);
  assert.ok(store.deliveries().every(file => file.state === 'sent'));
});

test('photo delivery splits eleven slides into an ordered album and one photo', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store, 11); };
  await bridge.receive(message(1, 'Tập 11 trang')); await settled(bridge);
  assert.deepEqual(telegram.albums.map(album => album.length), [10, 1]);
  assert.equal(telegram.albums[0][9], '010.png');
  assert.deepEqual(telegram.albums[1], ['011.png']);
  assert.deepEqual(telegram.albumCaptions, [['Ảnh 1–10/11', ...Array(9).fill('')], ['Ảnh 11/11']]);
  assert.ok(store.deliveries().every(file => file.state === 'sent'));
  assert.deepEqual(telegram.texts, [
    'Mình bắt đầu làm nhé. Bạn có thể dùng /status để xem tiến độ.',
    'Mình gửi đủ 11 ảnh rồi, bạn xem nhé!\n\nĐã kiểm tra.\n\nNếu cần chỉnh, bạn cứ nhắn mình. Muốn tải ảnh gốc, dùng /files.',
  ]);
  assert.equal(await bridge.status(), 'Mình đã gửi đủ ảnh. Bạn có thể xem hoặc dùng /files để tải ảnh gốc.');
});

test('a TikTok episode accepts all 35 slides and delivers four ordered Telegram albums', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store, 35); };
  await bridge.receive(message(1, 'Tập 35 trang')); await settled(bridge);
  const names = Array.from({ length: 35 }, (_, i) => `${String(i + 1).padStart(3, '0')}.png`);
  assert.deepEqual(telegram.albums.map(album => album.length), [10, 10, 10, 5]);
  assert.deepEqual(telegram.albums.flat(), names);
  assert.equal(store.deliveries().length, 35);
  assert.ok(store.deliveries().every(file => file.state === 'sent'));
  assert.equal(store.current()!.state, 'idle');
  assert.equal(runner.calls.length, 1);
});

test('empty or over-limit TikTok episodes are rejected before any delivery, never truncated', async t => {
  for (const count of [0, 36]) {
    const { bridge, store, stateDir, runner, telegram } = await setup(t);
    let data: Awaited<ReturnType<typeof fixture>>;
    runner.hook = async () => {
      data = await fixture(store, 1);
      data.report.files = Array.from({ length: count }, (_, i) => `output/r01/${String(i + 1).padStart(3, '0')}.png`);
      await writeFile(join(data.task.dir, 'handoff', data.run.id, 'result.json'), JSON.stringify(data.report));
    };
    await bridge.receive(message(1, `Tập ${count} trang`)); await settled(bridge);
    await assert.rejects(collect(data!.task, data!.run, stateDir), /1-35 ảnh/);
    assert.equal(telegram.sent.length, 0);
    assert.equal(store.deliveries().length, 0);
    assert.equal(store.current()!.state, 'needs_attention');
    assert.equal(runner.calls.length, 1);
  }
});

test('/files sends only the latest revision as original documents; /resend keeps that format without Pi', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  let revision = 0;
  runner.hook = async () => { await fixture(store, 2, `r0${++revision}`); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  await bridge.receive(message(2, 'Sửa')); await settled(bridge);
  const originals = store.deliveries().map(file => file.hash);
  await bridge.receive(message(3, '/files', 999));
  assert.deepEqual(telegram.documents, []);
  let attempts = 0;
  telegram.sendHook = async () => { if (++attempts === 2) throw new TelegramError(true); };
  await bridge.receive(message(4, '/files')); await settled(bridge);
  assert.deepEqual(store.deliveries().map(file => file.state), ['sent', 'unknown']);
  store.recover();
  telegram.sendHook = undefined;
  await bridge.receive(message(5, '/resend')); await settled(bridge);
  await bridge.receive(message(5, '/resend'));
  assert.deepEqual(telegram.documents, ['001.png', '002.png']);
  assert.equal(telegram.albums.length, 2);
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(store.deliveries().map(file => file.hash), originals);
  assert.ok(store.deliveries().every(file => file.state === 'sent'));
});

test('a changed file blocks the whole album before any new upload', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  await writeFile(store.deliveries()[1].path, 'tampered');
  store.db.prepare("UPDATE deliveries SET state='pending',message=NULL").run();
  await bridge.tick(); await settled(bridge);
  assert.equal(telegram.albums.length, 1);
  assert.deepEqual(store.deliveries().map(file => file.state), ['failed', 'failed']);
  assert.equal(runner.calls.length, 1);
});

test('pending pre-album runs keep document delivery after upgrade', async t => {
  const { bridge, store, runner, telegram } = await setup(t);
  runner.hook = async () => { await fixture(store); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const run = store.deliveries()[0].run;
  store.db.prepare('DELETE FROM meta WHERE key=?').run(`delivery_format:${run}`);
  store.db.prepare("UPDATE deliveries SET state='pending',message=NULL").run();
  await bridge.tick(); await settled(bridge);
  assert.deepEqual(telegram.documents, ['001.png', '002.png']);
  assert.equal(telegram.albums.length, 1);
  assert.equal(runner.calls.length, 1);
});

test('JPEG delivery preserves bytes and extension for albums and /files while rejecting disguised or wrong-sized images', async t => {
  for (const extension of ['jpg', 'jpeg']) {
    const { bridge, store, runner, telegram } = await setup(t);
    runner.hook = async () => { await fixture(store, 2, 'r01', extension); };
    await bridge.receive(message(1, 'JPEG mới')); await settled(bridge);
    const names = [`001.${extension}`, `002.${extension}`];
    assert.deepEqual(telegram.albums, [names]);
    const file = store.deliveries()[0];
    assert.equal(hash(await imageBytes(file.path)), file.hash);
    await bridge.receive(message(2, '/files')); await settled(bridge);
    assert.deepEqual(telegram.documents, names);
    assert.equal(runner.calls.length, 1);
    const disguised = file.path.replace(`.${extension}`, '.png');
    await writeFile(disguised, await readFile(file.path));
    await assert.rejects(imageBytes(disguised), /Đuôi file/);
    execFileSync('magick', ['-size', '10x10', 'xc:white', file.path]);
    await assert.rejects(imageBytes(file.path), /1080 x 1440/);
  }
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


test('trace toggles use underscore commands, including Telegram bot suffixes, not the old spaced syntax', async t => {
  const { bridge, runner, telegram } = await setup(t);
  await bridge.receive(message(1, '/trace_on@txtiktokbuddhism_bot'));
  assert.equal(bridge.trace.enabled(), true);
  await bridge.receive(message(2, '/trace off'));
  assert.equal(bridge.trace.enabled(), true);
  assert.match(telegram.texts.at(-1)!, /\/trace_off:/);
  await bridge.receive(message(3, '/trace_off@txtiktokbuddhism_bot'));
  assert.equal(bridge.trace.enabled(), false);
  await bridge.receive(message(4, '/trace on'));
  assert.equal(bridge.trace.enabled(), false);
  assert.match(telegram.texts.at(-1)!, /\/trace_on:/);
  assert.equal(runner.calls.length, 0);
});

test('trace commands work while Pi is busy, respect owner auth and show only the latest ten lines', async t => {
  const { bridge, runner, telegram, store } = await setup(t);
  const entered = deferred();
  const release = deferred();
  runner.hook = async () => {
    for (let i = 0; i < 30; i++) bridge.trace.add(`safe event ${i}`);
    entered.resolve();
    await release.promise;
  };
  runner.cancelHook = async () => { release.resolve(); };
  await bridge.receive(message(1, '/trace_on', 999));
  assert.equal(bridge.trace.enabled(), false);
  await bridge.receive(message(2, '/trace_on'));
  assert.equal(bridge.trace.enabled(), true);
  await bridge.receive(message(3, 'start a task'));
  await entered.promise;
  await bridge.receive(message(4, '/log'));
  const log = telegram.texts.at(-1)!;
  assert.equal(log.split('\n').length, 10);
  assert.match(log, /safe event 20/);
  assert.match(log, /safe event 29/);
  assert.equal(runner.calls.length, 1);
  assert.equal(store.current()!.state, 'running');
  await bridge.receive(message(5, '/trace_off', 123, 'group'));
  assert.equal(bridge.trace.enabled(), true);
  await bridge.receive(message(6, '/trace_off'));
  assert.equal(bridge.trace.enabled(), false);
  const edits = telegram.traces.length;
  bridge.trace.add('one more safe event');
  await bridge.trace.flush();
  assert.equal(telegram.traces.length, edits);
  await bridge.receive(message(7, '/log'));
  assert.match(telegram.texts.at(-1)!, /one more safe event/);
  await bridge.receive(message(8, '/cancel'));
});


test('only a fully delivered replacement prunes old outputs/drafts and keeps sources, references and resend bytes', async t => {
  const { bridge, store, runner, telegram, stateDir } = await setup(t);
  let revision = 0;
  runner.hook = async () => { await fixture(store, 2, `r0${++revision}`); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const task = store.current()!;
  const oldRun = (store.db.prepare('SELECT * FROM runs').get() as Run).id;
  await mkdir(join(task.dir, 'drafts', 'old'), { recursive: true });
  await writeFile(join(task.dir, 'drafts', 'old', 'status.json'), '{"state":"succeeded"}');
  await writeFile(join(task.dir, 'source.txt'), 'Nguyên văn nguồn.');
  await writeFile(join(task.dir, 'notes.md'), 'Kiểm tra đã lưu.');
  await mkdir(join(task.dir, 'references'), { recursive: true });
  await writeFile(join(task.dir, 'references', 'identity.json'), '{}');
  telegram.sendHook = async () => { throw new TelegramError(true); };
  await bridge.receive(message(2, 'Sửa')); await settled(bridge);
  assert.ok(await readFile(join(task.dir, 'output/r01/001.png')));
  assert.ok(await readFile(join(task.dir, 'drafts/old/status.json')));
  telegram.sendHook = undefined;
  await bridge.receive(message(3, '/resend')); await settled(bridge);
  await assert.rejects(readFile(join(task.dir, 'output/r01/001.png')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(task.dir, 'drafts/old/status.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(stateDir, 'outbox', oldRun, '001.png')), { code: 'ENOENT' });
  assert.ok(await readFile(join(task.dir, 'output/r02/001.png')));
  assert.equal(await readFile(join(task.dir, 'source.txt'), 'utf8'), 'Nguyên văn nguồn.');
  assert.ok(await readFile(join(task.dir, 'notes.md')));
  assert.ok(await readFile(join(task.dir, 'references/identity.json')));
  assert.equal(store.deliveries().length, 2);
  await bridge.receive(message(4, '/files')); await settled(bridge);
  assert.equal(telegram.documents.length, 2);
  assert.deepEqual(telegram.documentCaptions, ['Tệp ảnh gốc 1/2', 'Tệp ảnh gốc 2/2']);
  assert.equal(runner.calls.length, 2);
});

test('unresolved API drafts keep old output and diagnostics even after a new album is acknowledged', async t => {
  const { bridge, store, runner } = await setup(t);
  let revision = 0;
  runner.hook = async () => {
    await fixture(store, 1, `r0${++revision}`);
    const dir = join(store.current()!.dir, 'drafts', 'unknown');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'status.json'), '{"state":"unknown"}');
  };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  await bridge.receive(message(2, 'Sửa')); await settled(bridge);
  const dir = store.current()!.dir;
  assert.ok(await readFile(join(dir, 'output/r01/001.png')));
  assert.ok(await readFile(join(dir, 'drafts/unknown/status.json')));
  assert.equal(store.deliveries().length, 2);
});

test('retention protects source dependencies from latest/older snapshots and root/reference symlinks', async t => {
  for (const variant of ['latest', 'older', 'older-draft', 'root-link', 'reference-link']) {
    const { bridge, store, runner, stateDir } = await setup(t);
    runner.hook = async () => { await fixture(store, 1); };
    await bridge.receive(message(1, 'Tập')); await settled(bridge);
    const task = store.current()!;
    const source = variant.includes('link') || variant === 'older-draft' ? 'drafts/original/source.txt' : 'output/r01/source.txt';
    await mkdir(join(task.dir, 'drafts', 'original'), { recursive: true });
    await writeFile(join(task.dir, source), 'Nguồn phải còn nguyên.');
    if (variant.startsWith('older')) {
      const path = join(task.dir, 'output/r01/episode.json');
      const episode = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...episode, source: { file: source } }));
    } else if (variant.includes('link')) {
      const path = variant === 'root-link' ? 'source.txt' : 'references/CUSI_01/v1/source.txt';
      await mkdir(join(task.dir, 'references/CUSI_01/v1'), { recursive: true });
      await symlink(join(task.dir, source), join(task.dir, path));
    }
    runner.hook = async () => {
      await fixture(store, 1, 'r02');
      if (variant === 'latest') {
        const path = join(task.dir, 'output/r02/episode.json');
        const episode = JSON.parse(await readFile(path, 'utf8'));
        await writeFile(path, JSON.stringify({ ...episode, source: { file: source } }));
      }
    };
    await bridge.receive(message(2, 'Sửa')); await settled(bridge);
    assert.equal(await readFile(join(task.dir, source), 'utf8'), 'Nguồn phải còn nguyên.', variant);
    if (variant.includes('link') || variant === 'older-draft') await assert.rejects(readFile(join(task.dir, 'output/r01/001.png')), { code: 'ENOENT' });
    await pruneTask(store, store.current()!, stateDir);
    assert.equal(await readFile(join(task.dir, source), 'utf8'), 'Nguồn phải còn nguyên.', `${variant}: second sweep`);
    assert.equal(store.deliveries().length, 1);
  }
});

test('local sweep previews without writes then cleans an already-delivered closed task without Pi or Telegram', async t => {
  const { bridge, store, runner, telegram, stateDir } = await setup(t);
  runner.hook = async () => { await fixture(store, 1); };
  await bridge.receive(message(1, 'Tập')); await settled(bridge);
  const task = store.current()!;
  await mkdir(join(task.dir, 'output/r00'), { recursive: true });
  await writeFile(join(task.dir, 'output/r00/old.txt'), 'old');
  await bridge.receive(message(2, '/done'));
  const closed = store.db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) as typeof task;
  const messages = telegram.texts.length;
  const preview = await pruneTask(store, closed, stateDir, false);
  assert.equal(preview.removed, 1);
  assert.equal(await readFile(join(task.dir, 'output/r00/old.txt'), 'utf8'), 'old');
  assert.equal((await pruneTask(store, closed, stateDir)).removed, 1);
  await assert.rejects(readFile(join(task.dir, 'output/r00/old.txt')), { code: 'ENOENT' });
  assert.ok(await readFile(join(task.dir, 'output/r01/001.png')));
  assert.equal((await pruneTask(store, closed, stateDir)).removed, 0);
  assert.equal(runner.calls.length, 1);
  assert.equal(telegram.sent.length, 1);
  assert.equal(telegram.texts.length, messages);
});
