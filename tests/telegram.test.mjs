import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createEpisode, changeEpisode, episodeHandoff } from '../scripts/episode-tools.mjs';
import { draw, recoverAttempt } from '../scripts/draw-image.mjs';
import { exportSlide } from '../scripts/export-slide.mjs';
import { bundleTag, episodeBundle, readEpisode, writeEpisode } from '../scripts/lib/episode.mjs';
import { LOOKAHEAD_LOCK, withEpisodeLock } from '../scripts/lib/lock.mjs';
import { Telegram } from '../telegram/api.mjs';
import { Bot, openDelivery, splitChunks } from '../telegram/bot.mjs';
import { pollUpdates } from '../telegram/main.mjs';

async function setup(t, title, texts, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddhism-bot-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { dir } = await createEpisode(root, title, extra.request ?? 'Original request');
  const slides = texts.map(item => typeof item === 'string'
    ? { text: item, scene: 'A quiet scene', scene_type: 'concept', characters: [] }
    : { scene: 'A quiet scene', scene_type: 'concept', characters: [], ...item });
  await writeEpisode(dir, { ...await readEpisode(dir), ...extra.episode, slides });
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
const ok = (method, count = 1) => {
  if (method === 'sendMediaGroup') {
    return Response.json({ ok: true, result: Array.from({ length: count }, (_, index) => ({ message_id: index + 1 })) });
  }
  if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true });
  return Response.json({ ok: true, result: { message_id: 1 } });
};
const reject = (status, delay) => Response.json({ ok: false, parameters: { retry_after: delay } }, { status });

function mock(root, request, options) {
  const messages = [];
  const sentMessages = [];
  const photos = [];
  const photoCalls = [];
  const callbacks = [];
  const edits = [];
  const callOrder = [];
  const docs = [];
  const telegram = new Telegram('1:fake', 100, { wait: async () => {}, ...options, request: async (url, { body }) => {
    const method = url.split('/').at(-1);
    callOrder.push(method);
    let batchNames = [];
    let count = 1;
    let payload;
    if (method === 'sendMessage') {
      payload = JSON.parse(body);
      assert.equal(payload.chat_id, 100);
      messages.push(payload.text);
      sentMessages.push({ text: payload.text, reply_markup: payload.reply_markup });
    } else if (method === 'sendPhoto') {
      assert.equal(body.get('chat_id'), '100');
      const photo = body.get('photo');
      photos.push(photo);
      batchNames = [photo.name];
      photoCalls.push({ method, type: 'photo', names: batchNames });
    } else if (method === 'sendDocument') {
      assert.equal(body.get('chat_id'), '100');
      const doc = body.get('document');
      payload = JSON.parse(body.get('reply_markup') ?? 'null');
      docs.push(doc);
      batchNames = [doc.name];
      photoCalls.push({ method, type: 'document', names: batchNames });
    } else if (method === 'sendMediaGroup') {
      assert.equal(body.get('chat_id'), '100');
      const media = JSON.parse(body.get('media'));
      count = media.length;
      const groupType = media[0]?.type;
      batchNames = media.map((item, idx) => {
        assert.equal(item.type, groupType);
        assert.equal(item.media, `attach://file${idx}`);
        const file = body.get(`file${idx}`);
        if (groupType === 'document') docs.push(file);
        else photos.push(file);
        return file.name;
      });
      photoCalls.push({ method, type: groupType, names: batchNames });
    } else if (method === 'answerCallbackQuery') {
      payload = JSON.parse(body);
      callbacks.push(payload);
    } else if (method === 'editMessageReplyMarkup') {
      payload = JSON.parse(body);
      edits.push(payload);
    } else {
      assert.fail(`Unexpected Telegram method ${method}`);
    }
    return (request ? request(method, batchNames.at(-1), { batchNames, payload }) : undefined) ?? ok(method, count);
  } });
  const delivery = openDelivery(join(root, 'test.sqlite'));
  return { messages, sentMessages, photos, docs, photoCalls, callbacks, edits, callOrder, delivery, bot: new Bot({ root, telegram, delivery, log: () => {} }) };
}
const update = (id, text, from = 100, type = 'private', chat = 100) => ({ update_id: id, message: { text, from: { id: from, is_bot: false }, chat: { type, id: chat } } });
const cbUpdate = (id, data, { from = 100, isBot = false, type = 'private', chat = 100, messageId = 55 } = {}) => ({
  update_id: id,
  callback_query: {
    id: `cb-${id}`,
    data,
    from: { id: from, is_bot: isBot },
    message: { message_id: messageId, from: { id: 999, is_bot: true }, chat: { type, id: chat } },
  },
});

test('notifies completion with view button, supports case-insensitive get, and handles publish callback safely', async t => {
  const { root, dir } = await setup(t, 'Tập kiểm thử', ['Chữ có dấu.', 'Trang số hai.']);
  const { bot, delivery, messages, sentMessages, photos, photoCalls, callbacks, edits } = mock(root);
  t.after(delivery.close);
  await bot.scan();
  assert.deepEqual(messages, []);
  const expected = await fill(dir, 2);
  await bot.scan();
  bot.scanned.clear();
  await bot.scan();
  assert.deepEqual(messages, ['T1: "Tập kiểm thử" đã xong.']);
  assert.deepEqual(sentMessages[0].reply_markup, { inline_keyboard: [[{ text: 'Xem nội dung', callback_data: 'view:T1' }]] });
  assert.equal(photos.length, 0);

  await bot.update(update(10, 'get t1', 200));
  await bot.update(update(11, 'get t1', 100, 'group'));
  await bot.update(update(12, 'get t1', 100, 'private', 101));
  await bot.update(update(13, 'get ../T1'));
  await bot.update(cbUpdate(14, 'publish:T1', { from: 200 }));
  await bot.update(cbUpdate(15, 'view:T1', { type: 'group' }));
  await bot.update(cbUpdate(16, 'publish:T1', { isBot: true }));
  assert.equal(photos.length, 0);
  assert.equal(callbacks.length, 0);
  assert.equal((await readEpisode(dir)).status, 'ready_for_review');

  await bot.update(update(17, 'episodes'));
  assert.match(messages.at(-1), /T1: "Tập kiểm thử" — đã xong, chờ đăng/);
  await bot.update(update(18, 'get t1'));
  await bot.update(update(18, 'get t1'));
  assert.deepEqual(photoCalls, [{ method: 'sendMediaGroup', type: 'photo', names: ['T1-001.jpg', 'T1-002.jpg'] }]);
  assert.deepEqual(await Promise.all(photos.map(async p => Buffer.from(await p.arrayBuffer()))), expected);
  assert.equal(messages.at(-1), 'Original request');
  const publishCb = sentMessages.at(-1).reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
  assert.match(publishCb, /^publish:T1:[A-Za-z0-9_-]{32}$/);
  assert.equal(sentMessages.at(-1).reply_markup.inline_keyboard[0][0].text, 'Đã đăng bài');

  await bot.update(cbUpdate(19, publishCb, { messageId: 88 }));
  assert.equal((await readEpisode(dir)).status, 'published');
  assert.deepEqual(callbacks.at(-1), { callback_query_id: 'cb-19', text: 'T1 đã được đánh dấu đã đăng.' });
  assert.deepEqual(edits.at(-1), { chat_id: 100, message_id: 88, reply_markup: { inline_keyboard: [[{ text: '✓ Đã đăng bài', callback_data: 'published:T1' }]] } });

  await bot.update(cbUpdate(20, 'published:T1', { messageId: 88 }));
  assert.deepEqual(callbacks.at(-1), { callback_query_id: 'cb-20', text: 'Bản T1 trong tin nhắn này đã được đánh dấu đã đăng.' });

  await bot.update(update(21, '/GET T1'));
  assert.equal(sentMessages.at(-1).reply_markup, undefined);

  await changeEpisode(dir, 'reopen');
  await bot.update(cbUpdate(22, 'published:T1', { messageId: 88 }));
  assert.equal(callbacks.at(-1).text, 'Bản T1 trong tin nhắn này đã được đánh dấu đã đăng.');
  assert.equal((await readEpisode(dir)).status, 'draft');
  await bot.update(update(23, 'get t1'));
  assert.match(messages.at(-1), /đang chỉnh/);
  assert.equal(photos.length, 4);
});

test('publish buttons distinguish caption-only edits and reject the old delivery format', async t => {
  const { root, dir } = await setup(t, 'Sửa riêng nội dung copy', ['Slide giữ nguyên.']);
  await fill(dir, 1);
  const { bot, delivery, sentMessages, callbacks } = mock(root);
  t.after(delivery.close);
  const first = await episodeBundle(dir);
  const oldFormatTag = Buffer.from(first.key, 'hex').subarray(0, 24).toString('base64url');
  await bot.update(cbUpdate(1, `publish:T1:${oldFormatTag}`));
  assert.match(callbacks.at(-1).text, /xem bản mới/);
  assert.equal((await readEpisode(dir)).status, 'ready_for_review');

  await bot.update(update(2, 'get T1'));
  const oldButton = sentMessages.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  await changeEpisode(dir, 'reopen');
  const request = 'Nội dung copy đã sửa.';
  await writeEpisode(dir, { ...await readEpisode(dir), request });
  await changeEpisode(dir, 'lock');
  await changeEpisode(dir, 'finalize');
  assert.deepEqual((await episodeBundle(dir)).files, first.files);
  await bot.update(cbUpdate(3, oldButton));
  assert.equal((await readEpisode(dir)).status, 'ready_for_review');
  await bot.update(update(4, 'get T1'));
  assert.equal(sentMessages.at(-1).text, request);
  assert.notEqual(sentMessages.at(-1).reply_markup.inline_keyboard[0][0].callback_data, oldButton);
});

test('stale publish buttons cannot publish a revised bundle or stall polling while draft/blocked', async t => {
  const { root, dir } = await setup(t, 'Tập sửa lại', ['Bản đầu.', 'Trang hai.']);
  await fill(dir, 2);
  const { bot, delivery, sentMessages, callbacks, edits, messages } = mock(root);
  t.after(delivery.close);

  await bot.update(update(1, 'get t1'));
  const oldPublishCb = sentMessages.at(-1).reply_markup.inline_keyboard[0][0].callback_data;

  // Clicking an old publish button while reopened (draft) or locked or blocked must answer & advance queue.
  await changeEpisode(dir, 'reopen');
  const controller = new AbortController();
  let polls = 0;
  await pollUpdates({
    telegram: {
      poll: async () => {
        if (++polls > 1) controller.abort();
        return [cbUpdate(2, oldPublishCb, { messageId: 40 }), update(3, 'episodes')];
      },
    },
    bot,
    delivery,
    signal: controller.signal,
    wait: async () => assert.fail('draft publish callback should not stall polling'),
    log: () => {},
  });
  assert.equal(delivery.offset(), 4);
  assert.match(callbacks.at(-1).text, /chưa thể đánh dấu đã đăng/);
  assert.match(messages.at(-1), /T1: "Tập sửa lại" — đang soạn hoặc chỉnh/);

  // Re-edit script, draw, finalize to create bundle B, then click old button from bundle A.
  const ep = await readEpisode(dir);
  ep.slides[0].text = 'Bản đã sửa.';
  await writeEpisode(dir, ep);
  await changeEpisode(dir, 'lock');
  const d1 = await draw({ episodeDir: dir, slide: 1, request: async () => new Response(png()) });
  await exportSlide(dir, relative(dir, d1), 'Visually checked');
  await changeEpisode(dir, 'finalize');

  await bot.update(cbUpdate(4, oldPublishCb, { messageId: 40 }));
  assert.equal((await readEpisode(dir)).status, 'ready_for_review');
  assert.match(callbacks.at(-1).text, /đã cập nhật bản mới/);
  assert.deepEqual(edits.at(-1), { chat_id: 100, message_id: 40, reply_markup: { inline_keyboard: [] } });

  // Also test blocked episode while locked with old button.
  await changeEpisode(dir, 'reopen');
  const epBlocked = await readEpisode(dir);
  epBlocked.slides[0].text = 'Bản đang sửa.';
  await writeEpisode(dir, epBlocked);
  await changeEpisode(dir, 'lock');
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => new Response('', { status: 429 }) }));
  assert.equal(await bot.update(cbUpdate(5, oldPublishCb, { messageId: 40 })), true);
  assert.match(callbacks.at(-1).text, /chưa thể đánh dấu đã đăng/);

  // Reconcile, draw, finalize, fetch new bundle B, and publish with B's button.
  const { blocked } = await (await import('../scripts/episode-tools.mjs')).episodeHandoff(dir);
  await (await import('../scripts/draw-image.mjs')).recoverAttempt(dir, blocked.path, { note: 'Recovered' });
  const d2 = await draw({ episodeDir: dir, slide: 1, request: async () => new Response(png()) });
  await exportSlide(dir, relative(dir, d2), 'Visually checked');
  await changeEpisode(dir, 'finalize');
  await bot.update(update(6, 'get t1'));
  const newPublishCb = sentMessages.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
  assert.notEqual(newPublishCb, oldPublishCb);
  await bot.update(cbUpdate(7, newPublishCb, { messageId: 41 }));
  assert.equal((await readEpisode(dir)).status, 'published');
});

test('batches 21 photos, acks view before sending, and sends the corrected request verbatim', async t => {
  const slides = [
    { role: 'cover', text: 'NHỮNG GIA ĐÌNH\nTrích sách: "LỜI PHẬT DẠY"' },
    { role: 'quote', text: 'Một thời, Thế Tôn gọi các Tỳ kheo:' },
    { role: 'quote', text: 'Này các Tỳ kheo, phần một;' },
    { role: 'quote', text: 'và phần hai đã sửa chính tả.' },
    { role: 'commentary', text: 'LỜI BÀN\nĐoạn bình thứ nhất,' },
    { role: 'commentary', text: 'nối tiếp ý bình.' },
    ...Array.from({ length: 15 }, (_, i) => ({ role: 'commentary', text: `Câu bổ sung số ${i + 1}.` })),
  ];
  const request = 'NHỮNG GIA ĐÌNH\r\nTrích sách: "LỜI PHẬT DẠY"\r\n\r\nNội dung đã sửa.  🙏\r\n#tutap #phatgiao';
  const { root, dir } = await setup(t, 'NHỮNG GIA ĐÌNH', slides, {
    request: 'Nội dung trước khi báo và sửa.',
    episode: { request, source: { hashtags: ['#khongtuchem'] } },
  });
  await fill(dir, 21);
  const { bot, delivery, photoCalls, messages, sentMessages, callbacks, callOrder } = mock(root);
  t.after(delivery.close);
  await bot.update(cbUpdate(1, 'view:T1'));
  assert.equal(callOrder[0], 'answerCallbackQuery');
  assert.equal(callOrder[1], 'sendMediaGroup');
  assert.deepEqual(photoCalls.map(c => [c.method, c.type, c.names.length]), [
    ['sendMediaGroup', 'photo', 10],
    ['sendMediaGroup', 'photo', 10],
    ['sendPhoto', 'photo', 1],
  ]);
  assert.equal(callbacks.length, 1);
  assert.deepEqual(messages, [request]);
  assert.match(sentMessages.at(-1).reply_markup.inline_keyboard[0][0].callback_data, /^publish:T1:[A-Za-z0-9_-]{32}$/);
});

test('uses documents for images over 10 MB and keeps view callbacks pending during cooldown', async t => {
  const { root, dir } = await setup(t, 'Ảnh lớn', ['Một.', 'Hai.', 'Ba.']);
  await fill(dir, 3);
  const { sha256Bytes } = await import('../scripts/lib/fingerprint.mjs');
  const makeLarge = fillByte => {
    const buf = Buffer.alloc(10 * 1024 * 1024 + 1, fillByte);
    buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
    return buf;
  };
  const setImage = async (num, bytes) => {
    const pad = String(num).padStart(3, '0');
    await writeFile(join(dir, `artifact/images/${pad}.jpg`), bytes);
    const check = JSON.parse(await readFile(join(dir, `artifact/checks/${pad}.json`), 'utf8'));
    check.image_sha256 = sha256Bytes(bytes);
    await writeFile(join(dir, `artifact/checks/${pad}.json`), JSON.stringify(check));
  };
  // Slides 1 & 2 > 10 MB -> sendMediaGroup(document, 2); Slide 3 <= 10 MB -> sendPhoto(1)
  await setImage(1, makeLarge(1));
  await setImage(2, makeLarge(2));

  const first = mock(root);
  await first.bot.update(cbUpdate(1, 'view:T1'));
  assert.equal(first.callbacks.length, 1);
  assert.deepEqual(first.photoCalls.map(c => [c.method, c.type, c.names]), [
    ['sendMediaGroup', 'document', ['T1-001.jpg', 'T1-002.jpg']],
    ['sendPhoto', 'photo', ['T1-003.jpg']],
  ]);
  first.delivery.close();

  // Slide 1 > 10 MB alone, Slides 2 & 3 <= 10 MB -> sendDocument(1), then sendMediaGroup(photo, 2)
  await setImage(2, await readFile(join(dir, 'artifact/images/003.jpg')));
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let limited = true;
  const retryable = mock(root, method => {
    if (method === 'answerCallbackQuery' && !limited) return Response.json({ ok: false, description: 'query is too old' }, { status: 400 });
    if (limited) return reject(429, 31);
    return ok(method, 2);
  }, { wait: async ms => { t.mock.timers.tick(ms); } });
  t.after(retryable.delivery.close);
  await assert.rejects(retryable.bot.update(update(10, '/start')), { status: 429 });
  limited = false;
  retryable.messages.length = 0;
  const viewCb = cbUpdate(11, 'view:T1');
  await assert.rejects(retryable.bot.update(viewCb), { status: 429, notSent: true });
  assert.equal(retryable.callbacks.length, 0);
  assert.equal(retryable.delivery.offset(), 11);
  t.mock.timers.tick(31_000);
  assert.equal(await retryable.bot.update(viewCb), true);
  assert.equal(retryable.delivery.offset(), 12);
  assert.deepEqual(retryable.photoCalls.map(c => [c.method, c.type, c.names]), [
    ['sendDocument', 'document', ['T1-001.jpg']],
    ['sendMediaGroup', 'photo', ['T1-002.jpg', 'T1-003.jpg']],
  ]);
});

test('splits long copyable caption on Unicode grapheme boundaries and attaches publish button only to the last message', async t => {
  const emojiLine = `${'a'.repeat(3899)}🙏${'b'.repeat(20)}`;
  const chunks = splitChunks(emojiLine, 3900);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], 'a'.repeat(3899));
  assert.equal(chunks[1], `🙏${'b'.repeat(20)}`);
  assert.ok(chunks.every(chunk => chunk.isWellFormed()));

  const longSlides = Array.from({ length: 20 }, (_, i) => `Câu dài số ${i + 1}: ${'a'.repeat(240)}.`);
  const request = `Mở đầu\r\n\r\n${emojiLine}  \n${'a\u0301' + '\u0301'.repeat(4100)}\nKết bài.  `;
  const { root, dir } = await setup(t, 'Bài dài', longSlides, { request });
  await fill(dir, 20);
  const { bot, delivery, sentMessages, photoCalls } = mock(root);
  t.after(delivery.close);
  await bot.update(update(1, 'get t1'));
  assert.deepEqual(photoCalls.map(c => [c.method, c.type, c.names.length]), [['sendMediaGroup', 'photo', 10], ['sendMediaGroup', 'photo', 10]]);
  assert.ok(sentMessages.length > 1);
  assert.ok(sentMessages.every(m => m.text.length <= 3900 && m.text.isWellFormed()));
  assert.equal(sentMessages.map(m => m.text).join(''), request);
  assert.ok(sentMessages.slice(0, -1).every(m => m.reply_markup === undefined));
  assert.match(sentMessages.at(-1).reply_markup.inline_keyboard[0][0].callback_data, /^publish:T1:[A-Za-z0-9_-]{32}$/);
});

test('missing legacy copy text does not stall a verified episode or fall back to slides', async t => {
  const { root, dir } = await setup(t, 'Tập cũ', ['Slide không phải caption.'], {
    episode: { request: { legacy: true } },
  });
  await fill(dir, 1);
  const { bot, delivery, photos, messages } = mock(root);
  t.after(delivery.close);
  assert.equal(await bot.update(update(1, 'get T1')), true);
  assert.equal(photos.length, 1);
  assert.deepEqual(messages, ['T1 chưa có nội dung để copy trong kịch bản.']);
  assert.equal(delivery.offset(), 2);
});

test('sends a UTF-8 text file if splitting the request would create a blank message', async t => {
  const request = `Mở đầu\n${' '.repeat(8000)}\nKết bài.`;
  const { root, dir } = await setup(t, 'Caption có khoảng trắng dài', ['Một trang.'], { request });
  await fill(dir, 1);
  let markup;
  const { bot, delivery, docs, messages } = mock(root, (method, _name, { payload }) => {
    if (method === 'sendDocument') markup = payload;
  });
  t.after(delivery.close);
  await bot.update(update(1, 'get T1'));
  assert.deepEqual(messages, []);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, 'T1.txt');
  assert.equal(await docs[0].text(), request);
  assert.match(markup.inline_keyboard[0][0].callback_data, /^publish:T1:[A-Za-z0-9_-]{32}$/);
});

test('reports only the safe image error code and does not repeat an ambiguous Telegram send', async t => {
  const { root, dir } = await setup(t, 'Lắng Nghe', ['Một trang.']);
  const first = mock(root, () => { throw new Error('private detail'); });
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: async () => new Response('private API response', { status: 429 }) }));
  await first.bot.scan();
  first.delivery.close();
  assert.deepEqual(first.messages, ['T1: "Lắng Nghe" đang dừng ở ảnh 1 — IMG_HTTP_429.']);
  assert.equal(first.sentMessages[0].reply_markup, undefined);
  const next = mock(root);
  t.after(next.delivery.close);
  await next.bot.scan();
  assert.deepEqual(next.messages, []);
});

test('a live lookahead does not alert the owner, but its API failure stops the episode', async t => {
  const { root, dir } = await setup(t, 'Vẽ gối đầu', ['Một trang.', 'Hai.']);
  const { bot, delivery, messages } = mock(root);
  t.after(delivery.close);
  const first = await draw({ episodeDir: dir, slide: 1, request: () => new Response(png()) });
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const draining = Promise.withResolvers();
  const finishBody = Promise.withResolvers();
  const body = new ReadableStream({
    async pull(controller) {
      draining.resolve();
      await finishBody.promise;
      controller.enqueue(new TextEncoder().encode('private API response'));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const pending = assert.rejects(draw({ episodeDir: dir, slide: 2, lookahead: true, request: () => {
    started.resolve();
    return response.promise;
  } }), /Do not retry/);
  try {
    await Promise.race([started.promise, pending]);
    await bot.scan();
    assert.deepEqual(messages, []);
    await exportSlide(dir, relative(dir, first), 'Checked while lookahead runs');
    response.resolve(new Response(body, { status: 429 }));
    await Promise.race([draining.promise, pending]);
    const handoff = await episodeHandoff(dir);
    assert.equal(handoff.next, 'wait_for_image');
    assert.equal(handoff.blocked.code, 'IMG_HTTP_429');
    await assert.rejects(exportSlide(dir, relative(dir, first), 'No review writes after failure'), /unblocked episode/);
    await assert.rejects(recoverAttempt(dir, handoff.in_progress.path, { note: 'Cannot reconcile a draining request' }), /Wait for the lookahead/);
    await bot.scan();
    assert.deepEqual(messages, ['T1: "Vẽ gối đầu" đang dừng ở ảnh 2 — IMG_HTTP_429.']);
  } finally {
    response.resolve(new Response('', { status: 429 }));
    finishBody.resolve();
    await pending;
  }
  assert.equal((await episodeHandoff(dir)).next, 'resolve_attempt');
  await assert.rejects(draw({ episodeDir: dir, slide: 2, request: () => assert.fail('unexpected POST') }), /Episode blocked/);
  await bot.scan();
  assert.deepEqual(messages, ['T1: "Vẽ gối đầu" đang dừng ở ảnh 2 — IMG_HTTP_429.']);
});

test('inspect_attempt alerts once and an old publish button does not stall polling', async t => {
  const { root, dir } = await setup(t, 'Vẽ lại', ['Một trang.', 'Hai.']);
  await fill(dir, 2);
  const oldTag = bundleTag((await episodeBundle(dir)).key);
  await changeEpisode(dir, 'reopen');
  const edited = await readEpisode(dir);
  edited.slides[0].text = 'Trang đầu đã sửa.';
  edited.slides[1].text = 'Trang hai đã sửa.';
  await writeEpisode(dir, edited);
  await changeEpisode(dir, 'lock');
  await draw({ episodeDir: dir, slide: 1, request: () => new Response(png()) });
  await assert.rejects(draw({ episodeDir: dir, slide: 2, lookahead: true,
    request: () => new Response('private API response', { status: 429 }),
  }), /Do not retry/);
  assert.equal((await episodeHandoff(dir)).blocked.code, 'IMG_HTTP_429');
  await rm(join(dir, LOOKAHEAD_LOCK));
  assert.equal((await episodeHandoff(dir)).next, 'inspect_attempt');

  const fixture = mock(root);
  const { bot, delivery, messages, callbacks, edits } = fixture;
  const controller = new AbortController();
  const offsets = [];
  const batch = [cbUpdate(1, `publish:T1:${oldTag}`), update(2, 'episodes')];
  try {
    await pollUpdates({ telegram: { poll: async offset => {
      offsets.push(offset);
      if (offsets.length === 2) controller.abort();
      return batch;
    } }, bot, delivery, signal: controller.signal, log: () => {}, wait: async () => {} });
    assert.deepEqual(offsets, [0, 3]);
    assert.deepEqual(callbacks, [{ callback_query_id: 'cb-1', text: 'T1 cần kiểm tra trước khi tiếp tục. Hãy chạy handoff cho tập này.' }]);
    assert.deepEqual(messages, [callbacks[0].text, 'Danh sách tập:\nT1: "Vẽ lại" — đang làm ảnh']);
    assert.deepEqual(edits, []);
    assert.equal((await readEpisode(dir)).status, 'locked');
  } finally { delivery.close(); }

  const restarted = mock(root);
  t.after(restarted.delivery.close);
  await restarted.bot.scan();
  assert.deepEqual(restarted.messages, []);
});

test('a corrupt lookahead lock blocks publishing without stalling Telegram polling', async t => {
  const { root, dir } = await setup(t, 'Đã hoàn tất', ['Một trang.']);
  await fill(dir, 1);
  const tag = bundleTag((await episodeBundle(dir)).key);
  const lock = join(dir, LOOKAHEAD_LOCK);
  await writeFile(lock, 'not a SQLite database');
  assert.equal((await episodeHandoff(dir)).next, 'inspect_attempt');

  const { bot, delivery, callbacks, messages } = mock(root);
  t.after(delivery.close);
  const controller = new AbortController();
  const offsets = [];
  await pollUpdates({ telegram: { poll: async offset => {
    offsets.push(offset);
    if (offsets.length === 2) controller.abort();
    return [cbUpdate(1, `publish:T1:${tag}`), update(2, 'episodes')];
  } }, bot, delivery, signal: controller.signal, log: () => {}, wait: async () => {} });

  assert.deepEqual(offsets, [0, 3]);
  assert.match(callbacks[0]?.text, /T1 cần kiểm tra.*handoff/);
  assert.deepEqual(messages, [callbacks[0].text, 'Danh sách tập:\nT1: "Đã hoàn tất" — đã xong, chờ đăng']);
  assert.equal((await readEpisode(dir)).status, 'ready_for_review');
  assert.equal(await readFile(lock, 'utf8'), 'not a SQLite database');
});

test('published legacy without certified originals gets no notices or draft substitutes', async t => {
  const { root, dir } = await setup(t, 'Đã đăng', ['Một trang.']);
  const ep = await readEpisode(dir);
  await writeEpisode(dir, { ...ep, status: 'published', legacy: { id: 'legacy-id' } });
  const { bot, delivery, messages, photos } = mock(root);
  t.after(delivery.close);
  await bot.scan();
  assert.deepEqual(messages, []);
  await bot.update(update(1, 'get T1'));
  assert.match(messages[0], /đã đăng nhưng không có đủ ảnh thành phẩm/);
  assert.equal(photos.length, 0);
});

test('an unconfirmed media send stops the bundle and does not replay the same update', async t => {
  const { root, dir } = await setup(t, 'Gửi tài liệu', ['Một trang.', 'Hai.']);
  await fill(dir, 2);
  const first = mock(root, method => {
    if (method === 'sendMediaGroup') throw new Error('timeout');
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await first.bot.update(update(123, 'get t1'));
  first.delivery.close();
  assert.equal(first.photoCalls.length, 1);
  assert.match(first.messages[0], /xác nhận 0\/3 phần/);
  const restarted = mock(root);
  t.after(restarted.delivery.close);
  await restarted.bot.update(update(123, 'get t1'));
  assert.equal(restarted.photos.length, 0);

  const partial = mock(root, method => method === 'sendMessage' ? reject(429, 120) : Promise.reject(new Error('timeout')));
  t.after(partial.delivery.close);
  await partial.bot.update(update(124, 'get t1'));
  assert.equal(partial.photoCalls.length, 1);
  assert.equal(partial.messages.length, 1);
});

test('shutdown before the first get POST leaves the command pending across restart', async t => {
  for (const code of ['T1', 'T2']) {
    await t.test(code, { timeout: 10_000 }, async t => {
      const { root, dir } = await setup(t, 'Pending delivery', ['First']);
      if (code === 'T1') await fill(dir, 1);
      t.mock.timers.enable({ apis: ['Date'], now: 1000 });
      const controller = new AbortController();
      const fixture = mock(root, undefined, { signal: controller.signal, wait: async () => {
        controller.abort();
        throw controller.signal.reason;
      } });
      await fixture.bot.update(update(10, '/start'));
      const command = update(11, `get ${code}`);
      await pollUpdates({ telegram: { poll: async offset => {
        assert.equal(offset, 11);
        return [command, update(12, '/start')];
      } }, bot: { scan: async () => {}, update: fixture.bot.update.bind(fixture.bot) },
      delivery: fixture.delivery, signal: controller.signal, log: () => {} });
      assert.equal(fixture.delivery.offset(), 11);
      assert.equal(fixture.photos.length, 0);
      assert.equal(fixture.messages.length, 1);
      fixture.delivery.close();

      const restarted = mock(root, (method, _name, { batchNames }) => {
        assert.equal(restarted.delivery.offset(), 12);
        return ok(method, batchNames.length);
      });
      t.after(restarted.delivery.close);
      await restarted.bot.update(command);
      await restarted.bot.update(command);
      if (code === 'T1') {
        assert.deepEqual(restarted.photos.map(photo => photo.name), ['T1-001.jpg']);
        assert.equal(restarted.messages.at(-1), 'Original request');
      } else assert.deepEqual(restarted.messages, ['Không tìm thấy T2.']);
    });
  }
});

test('polling does not skip a command after a cursor write failure or cooldown', async t => {
  for (const cooldown of [false, true]) {
    await t.test(cooldown ? 'cooldown before dispatch' : 'cursor write failure', { timeout: 10_000 }, async t => {
      const { root, dir } = await setup(t, 'Pending command', ['First']);
      await fill(dir, 1);
      t.mock.timers.enable({ apis: ['Date'], now: 1000 });
      const controller = new AbortController();
      let throttled = cooldown;
      const fixture = mock(root, method => throttled ? reject(429, 120) : ok(method), {
        signal: controller.signal, wait: async ms => { t.mock.timers.tick(ms); },
      });
      t.after(fixture.delivery.close);
      const db = new DatabaseSync(join(root, 'test.sqlite'));
      t.after(() => db.close());
      if (cooldown) {
        await assert.rejects(fixture.bot.update(update(9, '/start')), { status: 429 });
        throttled = false;
        fixture.messages.length = 0;
      } else {
        await fixture.bot.update(update(9, '', 200));
        db.exec(`CREATE TRIGGER block_cursor BEFORE INSERT ON cursor WHEN NEW.offset = 11
          BEGIN SELECT RAISE(ABORT, 'fixture cursor error'); END;`);
      }
      const offsets = [];
      const pending = [];
      await pollUpdates({ telegram: { poll: async offset => {
        offsets.push(offset);
        if (offsets.length >= 3) controller.abort();
        return [update(10, 'get t1'), update(11, '/start')];
      } }, bot: { scan: async () => {}, update: fixture.bot.update.bind(fixture.bot) },
      delivery: fixture.delivery, signal: controller.signal, log: () => {}, wait: async ms => {
        pending.push([ms, fixture.delivery.offset(), fixture.photos.length, fixture.messages.length]);
        if (cooldown) t.mock.timers.tick(120_000);
        else db.exec('DROP TRIGGER IF EXISTS block_cursor');
      } });
      assert.deepEqual(pending, [[5000, 10, 0, 0]]);
      assert.deepEqual(offsets, [10, 10, 12]);
      assert.deepEqual(fixture.photos.map(photo => photo.name), ['T1-001.jpg']);
      assert.equal(fixture.messages.length, 2);
    });
  }
});

test('crossing the cooldown boundary before the first photo leaves get pending', async t => {
  const { root, dir } = await setup(t, 'Rate limit', ['First']);
  await fill(dir, 1);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let limited = true;
  const { bot, delivery, messages, photos } = mock(root, method => limited ? reject(429, 31) : ok(method), {
    wait: async ms => { t.mock.timers.tick(ms); },
  });
  t.after(delivery.close);
  await assert.rejects(bot.update(update(1, '/start')), { status: 429 });
  limited = false;
  messages.length = 0;
  t.mock.timers.tick(999);
  const photo = bot.telegram.photo.bind(bot.telegram);
  t.mock.method(bot.telegram, 'photo', (...args) => photo(...args).catch(error => {
    t.mock.timers.tick(2);
    throw error;
  }));
  const command = update(2, 'get t1');
  assert.equal(await bot.update(command), false);
  assert.equal(delivery.offset(), 2);
  assert.deepEqual(messages, []);
  assert.deepEqual(photos, []);
  assert.equal(await bot.update(command), true);
  assert.equal(delivery.offset(), 3);
  assert.deepEqual(photos.map(p => p.name), ['T1-001.jpg']);
  assert.equal(messages.at(-1), 'Original request');
});

test('missing or malformed scripts do not hold up later Telegram commands', async t => {
  const { root, dir } = await setup(t, 'Invalid script', ['First']);
  await writeFile(join(dir, 'artifact', 'episode.json'), '{');
  await mkdir(join(root, 'T2'));
  const { bot, delivery, messages, photos } = mock(root);
  t.after(delivery.close);
  const controller = new AbortController();
  let polls = 0;
  await pollUpdates({ telegram: { poll: async () => {
    if (++polls > 1) controller.abort();
    return [update(1, 'get t1'), update(2, '/get T2'), update(3, '/start')];
  } }, bot, delivery, signal: controller.signal, wait: async () => controller.abort(), log: () => {} });
  assert.equal(delivery.offset(), 4);
  assert.deepEqual(messages.slice(0, 2), ['T1 chưa có kịch bản hợp lệ.', 'T2 chưa có kịch bản hợp lệ.']);
  assert.match(messages[2], /Dùng \/episodes/);
  assert.deepEqual(photos, []);

  const ioError = Object.assign(new Error('fixture read failure'), { code: 'EIO' });
  t.mock.method(bot, 'episode', async () => { throw ioError; });
  await assert.rejects(bot.update(update(4, 'get t2')), ioError);
  assert.equal(delivery.offset(), 4);
});

test('a definitive 429 retries only the same batch, and long waits stop the bundle', async t => {
  const { root, dir } = await setup(t, 'Rate limit', Array.from({ length: 11 }, (_, i) => `Slide ${i + 1}.`));
  await fill(dir, 11);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const waits = [];
  const wait = async ms => { waits.push(ms); t.mock.timers.tick(ms); };
  let first = true;
  const fixture = mock(root, method => {
    if (method === 'sendPhoto' && first) { first = false; return reject(429, 2); }
    return ok(method, 10);
  }, { wait });
  t.after(fixture.delivery.close);
  await fixture.bot.update(update(1, 'get t1'));
  assert.equal(fixture.photoCalls.length, 3);
  assert.equal(fixture.messages.at(-1), 'Original request');
  assert.deepEqual(waits.splice(0), [1000, 2000, 1000]);

  const repeated = mock(root, method => method === 'sendPhoto' ? reject(429, 2) : ok(method, 10), { wait });
  t.after(repeated.delivery.close);
  await repeated.bot.update(update(2, 'get t1'));
  assert.equal(repeated.photoCalls.length, 3);
  assert.match(repeated.messages[0], /Telegram xác nhận 10\/12 phần/);
  assert.deepEqual(waits.splice(0), [1000, 2000, 2000]);

  const long = mock(root, method => method === 'sendPhoto' ? reject(429, 120) : ok(method, 10), { wait });
  t.after(long.delivery.close);
  await long.bot.update(update(3, 'get t1'));
  assert.equal(long.photoCalls.length, 2);
  assert.deepEqual(long.messages, []);
  assert.deepEqual(waits, [1000]);
});

test('short and long 429s persist a notice retry without waiting inline', async t => {
  for (const seconds of [20, 60]) {
    await t.test(`${seconds} seconds`, async t => {
      const { root, dir } = await setup(t, 'Rate-limited notice', ['First']);
      await fill(dir, 1);
      t.mock.timers.enable({ apis: ['Date'], now: 1000 });
      const waits = [];
      const limited = mock(root, () => reject(429, seconds), { wait: async ms => { waits.push(ms); } });
      try { await limited.bot.scan(); }
      finally { limited.delivery.close(); }
      assert.equal(limited.messages.length, 1);
      assert.deepEqual(waits, []);

      const restarted = mock(root);
      t.after(restarted.delivery.close);
      t.mock.timers.tick(seconds * 1000 - 1);
      await restarted.bot.scan();
      assert.deepEqual(restarted.messages, []);
      t.mock.timers.tick(1);
      await restarted.bot.scan();
      await restarted.bot.scan();
      assert.deepEqual(restarted.messages, ['T1: "Rate-limited notice" đã xong.']);
    });
  }
});

test('notices survive a definitive 403 and a shutdown before dispatch', async t => {
  const { root, dir } = await setup(t, 'Notice', ['First']);
  await fill(dir, 1);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const beforeStart = mock(root, () => reject(403));
  await beforeStart.bot.scan();
  beforeStart.delivery.close();
  assert.equal(beforeStart.messages.length, 1);
  const key = `done:T1:${(await episodeBundle(dir)).key}`;
  const controller = new AbortController();
  let duringWait;
  const shuttingDown = mock(root, undefined, { signal: controller.signal, wait: async () => {
    duringWait = shuttingDown.delivery.noticeStatus(key);
    controller.abort();
    throw new DOMException('shutdown', 'AbortError');
  } });
  await shuttingDown.bot.scan();
  assert.equal(shuttingDown.messages.length, 0);
  t.mock.timers.tick(60_000);
  await shuttingDown.bot.update(update(1, '/start'));
  await shuttingDown.bot.scan();
  assert.equal(duringWait, 'due');
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
  const { bot, messages, photos, delivery } = mock(root);
  t.after(delivery.close);
  await bot.update(update(1, 'EPISODES'));
  assert.equal(messages.length, 2);
  assert.ok(messages.every(s => s.length < 3900));
  assert.deepEqual([...messages.join('\n').matchAll(/^T(\d+):/gm)].map(m => Number(m[1])), Array.from({ length: 21 }, (_, i) => 21 - i));
  await withEpisodeLock(dir, () => bot.update(update(2, 'get t1')));
  assert.match(messages.at(-1), /đang được xử lý/);
  assert.equal(photos.length, 0);
});

test('view ack rate limit keeps the cursor pending and polling observes retry_after', async t => {
  const { root } = await setup(t, 'Đang làm', ['Một trang.']);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const tick = async ms => { t.mock.timers.tick(ms); };
  const { bot, delivery, callbacks, callOrder } = mock(root, method => {
    if (method === 'answerCallbackQuery' && callbacks.length === 1) return reject(429, 45);
  }, { wait: tick });
  t.after(delivery.close);
  const controller = new AbortController();
  const offsets = [];
  const batch = [cbUpdate(1, 'view:T1'), update(2, '/start')];
  await pollUpdates({ telegram: { poll: async offset => {
    offsets.push(offset);
    if (offsets.length === 3) controller.abort();
    return batch;
  } }, bot, delivery, signal: controller.signal, log: () => {}, wait: async ms => {
    assert.equal(ms, 45_000);
    assert.equal(delivery.offset(), 0);
    assert.deepEqual(callOrder, ['answerCallbackQuery']);
    await tick(ms);
  } });
  assert.deepEqual(offsets, [0, 0, 3]);
  assert.deepEqual(callOrder, ['answerCallbackQuery', 'answerCallbackQuery', 'sendMessage', 'sendMessage']);
});

test('polling honors a reported delay and stops processing the batch on shutdown', async () => {
  const controller = new AbortController();
  const waits = [];
  const events = [];
  const telegram = new Telegram('1:fake', 100, { signal: controller.signal, request: async (url, { body }) => {
    assert.equal(url.split('/').at(-1), 'getUpdates');
    assert.deepEqual(JSON.parse(body), { offset: 23, timeout: 15, allowed_updates: ['message', 'callback_query'] });
    events.push('poll');
    return waits.length ? Response.json({ ok: true, result: [23, 24] }) : reject(429, 6);
  } });
  const bot = { scan: async () => events.push('scan'), update: async id => { events.push(id); controller.abort(); } };
  await pollUpdates({ telegram, bot, delivery: { pollCursor: () => ({ offset: 23 }) }, signal: controller.signal,
    wait: async ms => { waits.push(ms); }, log: () => {} });
  assert.deepEqual(waits, [6000]);
  assert.deepEqual(events, ['scan', 'poll', 'scan', 'poll', 23]);
});

test('expired Telegram offsets are reset before polling, even after empty or failed polls', { timeout: 10_000 }, async t => {
  const { root } = await setup(t, 'Idle', ['Page']);
  const day = 24 * 60 * 60 * 1000;
  const { bot, delivery } = mock(root);
  t.after(delivery.close);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  await bot.update(update(500, '', 200));
  delivery.markNotice('already-sent', 1);
  t.mock.timers.tick(4 * day);
  const offsets = [];
  const controller = new AbortController();
  const telegram = { poll: async offset => {
    offsets.push(offset);
    if (offsets.length === 1) return [];
    if (offsets.length === 2) throw new Error('poll failed');
    return [update(3, '', 200)];
  } };
  await pollUpdates({ telegram, delivery, signal: controller.signal, log: () => {},
    bot: { scan: async () => {}, update: async (item, fetchedAt) => {
      t.mock.timers.tick(5000);
      await bot.update(item, fetchedAt);
      controller.abort();
    } }, wait: async () => { t.mock.timers.tick(day); } });
  assert.deepEqual(offsets, [501, 501, 0]);
  assert.equal(delivery.offset(), 4);
  assert.equal(delivery.noticeStatus('already-sent'), 'settled');
  t.mock.timers.tick(5 * day - 5000);
  assert.deepEqual(delivery.pollCursor(), { offset: 0 });
});

test('a legacy cursor probes without acknowledging conflicting updates or erasing notices', { timeout: 10_000 }, async t => {
  const { root } = await setup(t, 'Upgrade', ['Page']);
  const path = join(root, 'test.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE cursor (id INTEGER PRIMARY KEY CHECK(id = 1), offset INTEGER NOT NULL);
    INSERT INTO cursor VALUES (1, 501);
    CREATE TABLE notices (key TEXT PRIMARY KEY, message_id INTEGER, retry_at INTEGER);
    INSERT INTO notices VALUES ('already-sent', 12, NULL);`);
  legacy.close();
  const { bot, delivery } = mock(root);
  t.after(delivery.close);
  assert.equal(delivery.offset(), 501);
  const controller = new AbortController();
  const offsets = [];
  const logs = [];
  const handled = [];
  const telegram = { poll: async offset => {
    offsets.push(offset);
    return offsets.length === 1 ? [update(500, 'get t1')] : offsets.length === 2 ? [] : [update(3, '', 200)];
  } };
  await pollUpdates({ telegram, delivery, signal: controller.signal, log: message => logs.push(message),
    bot: { scan: async () => {}, update: async (item, fetchedAt) => {
      handled.push(item.update_id);
      await bot.update(item, fetchedAt);
      controller.abort();
    } }, wait: async ms => { assert.equal(ms, 60_000); assert.equal(delivery.offset(), 501); } });
  assert.deepEqual(offsets, [0, 0, 0]);
  assert.deepEqual(handled, [3]);
  assert.match(logs[0], /legacy cursor conflicts/);
  assert.equal(delivery.offset(), 4);
  assert.equal(delivery.noticeStatus('already-sent'), 'settled');
});

test('PM2 can import the entry point under its wrapper and leaves private state to the bot', () => {
  const require = createRequire(import.meta.url);
  const { apps: [app] } = require('../ecosystem.config.cjs');
  assert.equal(app.out_file, undefined);
  assert.equal(app.error_file, undefined);
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    process.argv = [process.execPath, 'ProcessContainerFork.js', '--check'];
    globalThis.fetch = () => { throw new Error('Unexpected network request'); };
    await import(${JSON.stringify(pathToFileURL(app.script).href)});
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: '1:fake', TELEGRAM_USER_ID: '100' } });
  assert.match(output, /ImageMagick checked; no network requests made/);
});
