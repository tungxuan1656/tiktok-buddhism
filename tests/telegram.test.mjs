import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { createEpisode, changeEpisode } from '../scripts/episode-tools.mjs';
import { draw } from '../scripts/draw-image.mjs';
import { exportSlide } from '../scripts/export-slide.mjs';
import { readEpisode, writeEpisode } from '../scripts/lib/episode.mjs';
import { withEpisodeLock } from '../scripts/lib/lock.mjs';
import { Telegram } from '../telegram/api.mjs';
import { Bot, openDelivery } from '../telegram/bot.mjs';
import { pollUpdates } from '../telegram/main.mjs';

async function setup(t, title, texts) {
  const root = await mkdtemp(join(tmpdir(), 'buddhism-bot-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { dir } = await createEpisode(root, title, 'Original request');
  const slides = texts.map(text => ({ text, scene: 'A quiet scene', scene_type: 'concept', characters: [] }));
  await writeEpisode(dir, { ...await readEpisode(dir), slides });
  await changeEpisode(dir, 'lock');
  return { root, dir };
}
const png = () => execFileSync('magick', ['-size', '12x16', 'xc:green', 'png:-']);
async function fill(dir, total) {
  const completed = [];
  for (let slide = 1; slide <= total; slide++) {
    const file = await draw({ episodeDir: dir, slide, request: async () => new Response(png()) });
    await exportSlide(dir, relative(dir, file), 'Visually checked');
    completed.push(await readFile(file));
  }
  await changeEpisode(dir, 'finalize');
  return completed;
}
const ok = () => Response.json({ ok: true, result: { message_id: 1 } });
const reject = (status, delay) => Response.json({ ok: false, parameters: { retry_after: delay } }, { status });

function mock(root, request, options) {
  const messages = [];
  const docs = [];
  const telegram = new Telegram('1:fake', 100, { wait: async () => {}, ...options, request: async (url, { body }) => {
    const method = url.split('/').at(-1);
    if (method === 'sendMessage') {
      const data = JSON.parse(body);
      assert.equal(data.chat_id, 100);
      messages.push(data.text);
    } else if (method === 'sendDocument') {
      assert.equal(body.get('chat_id'), '100');
      docs.push(body.get('document'));
    } else assert.fail(`Unexpected Telegram method ${method}`);
    return request ? request(method, docs.at(-1)?.name) : ok();
  } });
  const delivery = openDelivery(join(root, 'test.sqlite'));
  return { messages, docs, delivery, bot: new Bot({ root, telegram, delivery, log: () => {} }) };
}
const update = (id, text, from = 100, type = 'private', chat = 100) => ({ update_id: id, message: { text, from: { id: from, is_bot: false }, chat: { type, id: chat } } });

test('notifies completion once, then serves original ordered documents only to the configured private chat', async t => {
  const { root, dir } = await setup(t, 'Tập kiểm thử', ['Chữ có dấu.', 'Trang số hai.']);
  const { bot, delivery, messages, docs } = mock(root);
  t.after(delivery.close);
  await bot.scan();
  assert.deepEqual(messages, []);
  const expected = await fill(dir, 2);
  await bot.scan();
  bot.scanned.clear();
  await bot.scan();
  assert.deepEqual(messages, ['T1: "Tập kiểm thử" đã xong.']);
  assert.equal(docs.length, 0);
  await bot.update(update(10, '/get T1', 200));
  await bot.update(update(11, '/get T1', 100, 'group'));
  await bot.update(update(12, '/get T1', 100, 'private', 101));
  await bot.update(update(13, '/get ../T1'));
  assert.equal(docs.length, 0);
  await bot.update(update(14, '/episodes'));
  assert.match(messages.at(-1), /T1: "Tập kiểm thử" — đã xong, chờ duyệt/);
  await bot.update(update(15, '/get T1'));
  await bot.update(update(15, '/get T1'));
  assert.deepEqual(docs.map(d => d.name), ['T1-001.jpg', 'T1-002.jpg', 'T1-noi-dung.txt']);
  assert.deepEqual(await Promise.all(docs.slice(0, 2).map(async d => Buffer.from(await d.arrayBuffer()))), expected);
  assert.equal(await docs[2].text(), 'Tập kiểm thử\n\n--- 1 ---\nChữ có dấu.\n\n--- 2 ---\nTrang số hai.\n');
  await changeEpisode(dir, 'reopen');
  await bot.update(update(16, '/get T1'));
  assert.match(messages.at(-1), /đang chỉnh/);
  assert.equal(docs.length, 3);
});

test('reports only the safe image error code and does not repeat an ambiguous Telegram send', async t => {
  const { root, dir } = await setup(t, 'Lắng Nghe', ['Một trang.']);
  const first = mock(root, () => { throw new Error('private detail'); });
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: async () => new Response('private API response', { status: 429 }) }));
  await first.bot.scan();
  first.delivery.close();
  assert.deepEqual(first.messages, ['T1: "Lắng Nghe" đang dừng ở ảnh 1 — IMG_HTTP_429.']);
  const next = mock(root);
  t.after(next.delivery.close);
  await next.bot.scan();
  assert.deepEqual(next.messages, []);
});

test('published legacy without certified originals gets no notices or draft substitutes', async t => {
  const { root, dir } = await setup(t, 'Đã đăng', ['Một trang.']);
  const ep = await readEpisode(dir);
  await writeEpisode(dir, { ...ep, status: 'published', legacy: { id: 'legacy-id' } });
  const { bot, delivery, messages, docs } = mock(root);
  t.after(delivery.close);
  await bot.scan();
  assert.deepEqual(messages, []);
  await bot.update(update(1, '/get T1'));
  assert.match(messages[0], /đã đăng nhưng không có đủ ảnh thành phẩm/);
  assert.equal(docs.length, 0);
});

test('an unconfirmed document stops the send and does not replay the same update', async t => {
  const { root, dir } = await setup(t, 'Gửi tài liệu', ['Một trang.', 'Hai.']);
  await fill(dir, 2);
  const first = mock(root, method => {
    if (method === 'sendDocument') throw new Error('timeout');
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await first.bot.update(update(123, '/get T1'));
  first.delivery.close();
  assert.equal(first.docs.length, 1);
  assert.match(first.messages[0], /xác nhận 0\/3 tệp/);
  const restarted = mock(root);
  t.after(restarted.delivery.close);
  await restarted.bot.update(update(123, '/get T1'));
  assert.equal(restarted.docs.length, 0);

  const partial = mock(root, method => method === 'sendMessage' ? reject(429, 120) : Promise.reject(new Error('timeout')));
  t.after(partial.delivery.close);
  await partial.bot.update(update(124, '/get T1'));
  assert.equal(partial.docs.length, 1);
  assert.equal(partial.messages.length, 1);
});

test('a definitive 429 retries only the same document, and long waits stop the bundle', async t => {
  const { root, dir } = await setup(t, 'Rate limit', ['First', 'Second']);
  await fill(dir, 2);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const waits = [];
  const wait = async ms => { waits.push(ms); t.mock.timers.tick(ms); };
  let first = true;
  const fixture = mock(root, (_method, name) => {
    if (name === 'T1-002.jpg' && first) { first = false; return reject(429, 2); }
    return ok();
  }, { wait });
  t.after(fixture.delivery.close);
  await fixture.bot.update(update(1, '/get T1'));
  assert.deepEqual(fixture.docs.map(d => d.name), ['T1-001.jpg', 'T1-002.jpg', 'T1-002.jpg', 'T1-noi-dung.txt']);
  assert.deepEqual(waits.splice(0), [1000, 2000, 1000]);

  const repeated = mock(root, (method, name) => method === 'sendDocument' && name === 'T1-002.jpg' ? reject(429, 2) : ok(), { wait });
  t.after(repeated.delivery.close);
  await repeated.bot.update(update(2, '/get T1'));
  assert.deepEqual(repeated.docs.map(d => d.name), ['T1-001.jpg', 'T1-002.jpg', 'T1-002.jpg']);
  assert.match(repeated.messages[0], /Telegram xác nhận 1\/3 tệp/);
  assert.deepEqual(waits.splice(0), [1000, 2000, 2000]);

  const long = mock(root, (_method, name) => name === 'T1-002.jpg' ? reject(429, 120) : ok(), { wait });
  t.after(long.delivery.close);
  await long.bot.update(update(3, '/get T1'));
  assert.deepEqual(long.docs.map(d => d.name), ['T1-001.jpg', 'T1-002.jpg']);
  assert.deepEqual(long.messages, []);
  assert.deepEqual(waits, [1000]);
});

test('a definitive 429 defers the notice across bot restarts', async t => {
  const { root, dir } = await setup(t, 'Rate-limited notice', ['First']);
  await fill(dir, 1);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const limited = mock(root, () => reject(429, 60));
  try { await limited.bot.scan(); }
  finally { limited.delivery.close(); }
  assert.equal(limited.messages.length, 1);

  const restarted = mock(root);
  t.after(restarted.delivery.close);
  t.mock.timers.tick(59_999);
  await restarted.bot.scan();
  assert.deepEqual(restarted.messages, []);
  t.mock.timers.tick(1);
  await restarted.bot.scan();
  await restarted.bot.scan();
  assert.deepEqual(restarted.messages, ['T1: "Rate-limited notice" đã xong.']);
});

test('notices survive a definitive 403 and a shutdown before dispatch', async t => {
  const { root, dir } = await setup(t, 'Notice', ['First']);
  await fill(dir, 1);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const beforeStart = mock(root, () => reject(403));
  await beforeStart.bot.scan();
  beforeStart.delivery.close();
  assert.equal(beforeStart.messages.length, 1);
  const controller = new AbortController();
  const shuttingDown = mock(root, undefined, { signal: controller.signal, wait: async () => {
    controller.abort();
    throw new DOMException('shutdown', 'AbortError');
  } });
  await shuttingDown.bot.scan();
  assert.equal(shuttingDown.messages.length, 0);
  t.mock.timers.tick(60_000);
  await shuttingDown.bot.update(update(1, '/start'));
  await shuttingDown.bot.scan();
  shuttingDown.delivery.close();
  assert.equal(shuttingDown.messages.length, 1);
  assert.equal(controller.signal.aborted, true);

  const restarted = mock(root);
  t.after(restarted.delivery.close);
  await restarted.bot.scan();
  await restarted.bot.scan();
  assert.deepEqual(restarted.messages, ['T1: "Notice" đã xong.']);
});

test('in-flight and unknown image attempts explain that the outcome is uncertain', async t => {
  const { root, dir } = await setup(t, 'Uncertain', ['One page.']);
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => new Response('private', { status: 500 }) }));
  const { bot, messages, delivery } = mock(root);
  t.after(delivery.close);
  await bot.scan();
  await writeFile(join(dir, 'drafts/001-a1/status.json'), JSON.stringify({ state: 'in_flight' }));
  await bot.scan();
  assert.equal(messages.length, 2);
  assert.match(messages[0], /IMG_HTTP_500, chưa rõ API đã tạo ảnh hay chưa/);
  assert.match(messages[1], /IMG_UNKNOWN, chưa rõ API đã tạo ảnh hay chưa/);
});

test('a long episode list splits on rows and a locked episode is not sent', async t => {
  const { root, dir } = await setup(t, 'Locked', ['Page']);
  const title = 'L'.repeat(199);
  for (let n = 2; n <= 21; n++) await createEpisode(root, title, 'Request');
  const { bot, messages, docs, delivery } = mock(root);
  t.after(delivery.close);
  await bot.update(update(1, '/episodes'));
  assert.equal(messages.length, 2);
  assert.ok(messages.every(s => s.length < 3900));
  assert.deepEqual([...messages.join('\n').matchAll(/^T(\d+):/gm)].map(m => Number(m[1])), Array.from({ length: 21 }, (_, i) => 21 - i));
  await withEpisodeLock(dir, () => bot.update(update(2, '/get T1')));
  assert.match(messages.at(-1), /đang được xử lý/);
  assert.equal(docs.length, 0);
});

test('polling honors a reported delay and stops processing the batch on shutdown', async () => {
  const controller = new AbortController();
  const waits = [];
  const events = [];
  const telegram = new Telegram('1:fake', 100, { signal: controller.signal, request: async (url, { body }) => {
    assert.equal(url.split('/').at(-1), 'getUpdates');
    assert.deepEqual(JSON.parse(body), { offset: 23, timeout: 15, allowed_updates: ['message'] });
    events.push('poll');
    return waits.length ? Response.json({ ok: true, result: [23, 24] }) : reject(429, 6);
  } });
  const bot = { scan: async () => events.push('scan'), update: async id => { events.push(id); controller.abort(); } };
  await pollUpdates({ telegram, bot, delivery: { offset: () => 23 }, signal: controller.signal,
    wait: async ms => { waits.push(ms); }, log: () => {} });
  assert.deepEqual(waits, [6000]);
  assert.deepEqual(events, ['scan', 'poll', 'scan', 'poll', 23]);
});
