import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { createEpisode, changeEpisode } from '../scripts/episode-tools.mjs';
import { draw } from '../scripts/draw-image.mjs';
import { exportSlide } from '../scripts/export-slide.mjs';
import { readEpisode, writeEpisode } from '../scripts/lib/episode.mjs';
import { Telegram } from '../telegram/api.mjs';
import { Bot, openDelivery } from '../telegram/bot.mjs';

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
function mock(root, request) {
  const messages = [];
  const docs = [];
  const telegram = new Telegram('1:fake', 100, { request: async (url, { body }) => {
    const method = url.split('/').at(-1);
    if (method === 'sendMessage') {
      const data = JSON.parse(body);
      assert.equal(data.chat_id, 100);
      messages.push(data.text);
    } else if (method === 'sendDocument') {
      assert.equal(body.get('chat_id'), '100');
      docs.push(body.get('document'));
    } else assert.fail(`Unexpected Telegram method ${method}`);
    return request ? request(method) : Response.json({ ok: true, result: { message_id: 1 } });
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
});
