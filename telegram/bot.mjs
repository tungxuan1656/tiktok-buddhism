import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { changeEpisode } from '../scripts/episode-tools.mjs';
import { assertEpisodeIdentity, blockingEpisodeAttempt, bundleTag, deliverableStatus, episodeBundle, EpisodeStateError, imageBytes, isEpisodeCode, readEpisode } from '../scripts/lib/episode.mjs';
import { withEpisodeLock } from '../scripts/lib/lock.mjs';
import { imageError, statIfPresent } from '../scripts/lib/resume.mjs';
import { TelegramError } from './api.mjs';

const states = { draft: 'đang soạn hoặc chỉnh', locked: 'đang làm ảnh', ready_for_review: 'đã xong, chờ đăng', published: 'đã đăng' };
const label = ep => `${ep.code}: "${ep.title.replace(/\s+/g, ' ').trim()}"`;
const number = code => Number(code.slice(1));
const MEDIA_GROUP_SIZE = 10;
const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 3900;
const graphemeSegmenter = new Intl.Segmenter('vi', { granularity: 'grapheme' });
// A fetched update can already be a day old; Telegram resets IDs after a week of inactivity.
const CURSOR_TTL_MS = 5 * 24 * 60 * 60 * 1000;

const viewMarkup = code => ({ inline_keyboard: [[{ text: 'Xem nội dung', callback_data: `view:${code}` }]] });
const publishMarkup = (code, tag) => ({ inline_keyboard: [[{ text: 'Đã đăng bài', callback_data: `publish:${code}:${tag}` }]] });
const publishedMarkup = code => ({ inline_keyboard: [[{ text: '✓ Đã đăng bài', callback_data: `published:${code}` }]] });

export function splitChunks(text, limit = MAX_MESSAGE_CHARS) {
  const chunks = [];
  let current = '';
  const append = piece => {
    if (current && current.length + piece.length > limit) {
      chunks.push(current);
      current = '';
    }
    current += piece;
  };
  for (const line of text.split(/(?<=\n)/u)) {
    if (line.length <= limit) append(line);
    else for (const { segment } of graphemeSegmenter.segment(line)) {
      if (segment.length <= limit) append(segment);
      else for (const codePoint of segment) append(codePoint);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function batchPhotos(photos) {
  const batches = [];
  let current = [];
  let currentType = null;
  for (const photo of photos) {
    const type = photo.bytes.length > TELEGRAM_MAX_PHOTO_BYTES ? 'document' : 'photo';
    if (current.length && (type !== currentType || current.length >= MEDIA_GROUP_SIZE)) {
      batches.push({ type: currentType, items: current });
      current = [];
    }
    current.push(photo);
    currentType = type;
  }
  if (current.length) batches.push({ type: currentType, items: current });
  return batches;
}

export function openDelivery(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id = 1), offset INTEGER NOT NULL, fetched_at INTEGER);
    CREATE TABLE IF NOT EXISTS notices (key TEXT PRIMARY KEY, message_id INTEGER, retry_at INTEGER);`);
  if (!db.prepare('PRAGMA table_info(cursor)').all().some(column => column.name === 'fetched_at')) {
    db.exec('ALTER TABLE cursor ADD COLUMN fetched_at INTEGER');
  }
  const cursor = db.prepare('SELECT offset, fetched_at FROM cursor WHERE id = 1');
  const clearCursor = db.prepare('DELETE FROM cursor WHERE id = 1');
  const updateOffset = db.prepare(`INSERT INTO cursor (id, offset, fetched_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET offset = excluded.offset, fetched_at = excluded.fetched_at WHERE excluded.offset > offset`);
  const getNotice = db.prepare('SELECT * FROM notices WHERE key = ?');
  const markNotice = db.prepare('INSERT OR REPLACE INTO notices VALUES (?, ?, ?)');
  return {
    close: () => db.close(),
    offset: () => cursor.get()?.offset ?? 0,
    pollCursor: () => {
      const row = cursor.get();
      if (!row) return { offset: 0 };
      if (row.fetched_at === null) return { offset: 0, legacyOffset: row.offset };
      if (Date.now() - row.fetched_at < CURSOR_TTL_MS) return { offset: row.offset };
      clearCursor.run();
      return { offset: 0 };
    },
    clearCursor: () => clearCursor.run(),
    consume: (offset, fetchedAt) => updateOffset.run(offset, fetchedAt).changes === 1,
    noticeStatus: key => {
      const row = getNotice.get(key);
      if (!row || row.retry_at !== null && row.retry_at <= Date.now()) return 'due';
      return row.retry_at === null ? 'settled' : 'waiting';
    },
    markNotice: (key, id = null, retryAt = null) => markNotice.run(key, id, retryAt),
  };
}

export class Bot {
  constructor({ root, telegram, delivery, log = console.warn }) {
    this.root = root;
    this.telegram = telegram;
    this.delivery = delivery;
    this.log = log;
    this.scanned = new Map();
  }

  async codes() {
    return (await readdir(this.root, { withFileTypes: true })).filter(e => e.isDirectory() && isEpisodeCode(e.name))
      .map(e => e.name).sort((a, b) => number(b) - number(a));
  }

  async episode(code) {
    const dir = join(this.root, code);
    const ep = await readEpisode(dir);
    assertEpisodeIdentity(dir, ep);
    return ep;
  }

  async update(update, fetchedAt = Date.now()) {
    const id = update?.update_id;
    if (!Number.isSafeInteger(id) || id < 0 || id === Number.MAX_SAFE_INTEGER) return;
    const offset = id + 1;
    if (offset <= this.delivery.offset()) return;
    let consumed = false;
    const consume = () => {
      if (!consumed) {
        if (!this.delivery.consume(offset, fetchedAt)) throw new Error('Telegram update already consumed');
        consumed = true;
      }
    };
    if (update?.callback_query) {
      const query = update.callback_query;
      if (this.telegram.authorizedCallback(query)) await this.handleCallback(query, consume);
      else consume();
      return consumed;
    }
    const message = update?.message;
    const authorized = this.telegram.authorized(message) && typeof message.text === 'string';
    const [rawCommand = '', rawArg, ...extra] = authorized ? message.text.trim().split(/\s+/) : [];
    const command = rawCommand.toLowerCase();
    const arg = rawArg?.toUpperCase();
    if ((command === '/get' || command === 'get') && isEpisodeCode(arg) && !extra.length) {
      await this.sendEpisode(arg, consume);
    } else if ((command === '/episodes' || command === 'episodes') && !rawArg) {
      await this.list(consume);
    } else if (command === '/start' || command === '/help' || command === '/get' || command === 'get') {
      await this.telegram.say('Dùng /episodes (hoặc episodes) để xem danh sách. Ví dụ: get T37 để nhận ảnh và nội dung.', consume);
    } else {
      consume();
    }
    return consumed;
  }

  async handleCallback(query, consume) {
    const match = /^(view|publish|published):(T[1-9][0-9]{0,8})(?::([A-Za-z0-9_-]+))?$/.exec(query.data);
    if (!match) {
      await this.telegram.answerCallbackQuery(query.id, {}, consume);
      return;
    }
    const [, action, code, tag] = match;
    if (action === 'view' && !tag) {
      try {
        await this.telegram.answerCallbackQuery(query.id, { retry429: false });
      } catch (error) {
        if (this.telegram.signal?.aborted || error?.status === 429 || error?.notSent) throw error;
      }
      await this.sendEpisode(code, consume);
    } else if (action === 'publish') {
      await this.publishEpisode(code, tag, query, consume);
    } else if (action === 'published') {
      await this.telegram.answerCallbackQuery(query.id, { text: `Bản ${code} trong tin nhắn này đã được đánh dấu đã đăng.` }, consume);
    } else {
      await this.telegram.answerCallbackQuery(query.id, {}, consume);
    }
  }

  async publishEpisode(code, expectedBundleTag, query, consume) {
    const dir = join(this.root, code);
    const answer = text => this.telegram.answerCallbackQuery(query.id, { text }, consume);
    const clearButtons = () => this.telegram.editReplyMarkup(query.message.chat.id, query.message.message_id, { inline_keyboard: [] }).catch(() => {});
    if (!expectedBundleTag) {
      await answer(`Nút này đã cũ; hãy lấy lại ${code} trước khi đánh dấu đã đăng.`);
      await clearButtons();
      return;
    }
    if (!(await statIfPresent(dir))?.isDirectory()) return answer(`Không tìm thấy ${code}.`);
    try {
      await changeEpisode(dir, 'publish', { lockTimeoutMs: 0, expectedBundleTag });
    } catch (error) {
      if (error.message.startsWith('Timed out waiting for episode lock')) {
        return answer(`${code} đang được xử lý; thử lại sau.`);
      }
      if (error instanceof EpisodeStateError && error.code === 'STALE_BUNDLE') {
        await answer(`${code} đã cập nhật bản mới; hãy xem bản mới trước khi đánh dấu đã đăng.`);
        await clearButtons();
        return;
      }
      if (error instanceof EpisodeStateError || error instanceof SyntaxError || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return answer(`${code} đang chỉnh hoặc chưa hoàn tất; chưa thể đánh dấu đã đăng.`);
      }
      throw error;
    }
    await answer(`${code} đã được đánh dấu đã đăng.`);
    await this.telegram.editReplyMarkup(query.message.chat.id, query.message.message_id, publishedMarkup(code)).catch(() => {});
  }

  async list(beforePost) {
    const lines = [];
    for (const code of await this.codes()) {
      let ep;
      try { ep = await this.episode(code); } catch { continue; }
      lines.push(`${label(ep)} — ${states[ep.status]}`);
    }
    if (!lines.length) return this.telegram.say('Chưa có tập nào.', beforePost);
    for (const chunk of splitChunks(`Danh sách tập:\n${lines.join('\n')}`)) {
      await this.telegram.say(chunk, beforePost);
    }
  }

  async sendEpisode(code, beforePost) {
    const dir = join(this.root, code);
    const say = text => this.telegram.say(text, beforePost);
    if (!(await statIfPresent(dir))?.isDirectory()) return say(`Không tìm thấy ${code}.`);
    let sent = 0;
    let total = 0;
    try {
      await withEpisodeLock(dir, async () => {
        let ep;
        try { ep = await this.episode(code); }
        catch (error) {
          if (!(error instanceof EpisodeStateError) && !(error instanceof SyntaxError) && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
          return say(`${code} chưa có kịch bản hợp lệ.`);
        }
        if (!deliverableStatus(ep.status)) return say(`${label(ep)} đang làm hoặc đang chỉnh; chưa có bộ ảnh để gửi.`);
        let bundle;
        try { bundle = await episodeBundle(dir); }
        catch (error) {
          if (!(error instanceof EpisodeStateError)) throw error;
          return say(`${label(ep)} ${ep.status === 'published' ? 'đã đăng nhưng không có' : 'chưa có'} đủ ảnh thành phẩm xác minh được.`);
        }
        const photos = [];
        for (const file of bundle.files) {
          const image = await imageBytes(dir, file.file);
          if (image.sha256 !== file.sha256) throw new Error('Image changed after verification');
          photos.push({ name: `${code}-${file.file.split('/').at(-1)}`, ...image });
        }
        const { request, status } = bundle.episode;
        const textChunks = typeof request === 'string' && request.trim()
          ? splitChunks(request)
          : [`${code} chưa có nội dung để copy trong kịch bản.`];
        // Telegram rejects messages made entirely of whitespace.
        const copyAsFile = textChunks.some(chunk => !chunk.trim());
        const replyMarkup = status === 'published' ? undefined : publishMarkup(code, bundleTag(bundle.key));
        total = photos.length + (copyAsFile ? 1 : textChunks.length);
        for (const { type, items } of batchPhotos(photos)) {
          if (items.length === 1) {
            if (type === 'document') await this.telegram.document(items[0], beforePost);
            else await this.telegram.photo(items[0], beforePost);
          } else {
            await this.telegram.mediaGroup(items, beforePost, { type });
          }
          sent += items.length;
        }
        if (copyAsFile) {
          await this.telegram.document({ name: `${code}.txt`, mime: 'text/plain', bytes: Buffer.from(request) }, beforePost, { replyMarkup });
          sent++;
        } else for (const [index, chunk] of textChunks.entries()) {
          await this.telegram.say(chunk, beforePost, { replyMarkup: index === textChunks.length - 1 ? replyMarkup : undefined });
          sent++;
        }
      }, { timeoutMs: 0 });
    } catch (error) {
      if (total) {
        if (this.telegram.signal?.aborted || error.status === 403 || (!sent && error.notSent)) return;
        if (!sent && !(error instanceof TelegramError)) throw error;
        try { await say(`${code}: Telegram xác nhận ${sent}/${total} phần. Hãy kiểm tra chat trước khi dùng lại get ${code}.`); }
        catch { this.log('Telegram partial delivery status not confirmed.'); }
      } else if (error.message.startsWith('Timed out waiting for episode lock')) await say(`${code} đang được xử lý; thử lại khi tập đã xong.`);
      else throw error;
    }
  }

  async notice(key, message, replyMarkup) {
    const status = this.delivery.noticeStatus(key);
    if (status !== 'due') return status === 'settled';
    if (this.telegram.signal?.aborted) return false;
    let reserved = false;
    try {
      const id = await this.telegram.say(message, () => {
        // Reserve only at dispatch so a crash during the send delay leaves the notice due.
        this.delivery.markNotice(key);
        reserved = true;
      }, { retry429: false, replyMarkup });
      this.delivery.markNotice(key, id);
    } catch (error) {
      this.log('Telegram notification not confirmed.');
      if (error instanceof TelegramError && !error.ambiguous && (error.notSent || error.status === 429 || error.status === 403)) {
        let delay = 0;
        if (error.status === 403) delay = 60;
        else if (error.status === 429) delay = error.retryAfter || 30;
        this.delivery.markNotice(key, null, Date.now() + delay * 1000);
        return false;
      }
    }
    return reserved;
  }

  async scan() {
    for (const code of await this.codes()) {
      if (this.telegram.signal?.aborted) break;
      const dir = join(this.root, code);
      try {
        const version = (await statIfPresent(join(dir, 'artifact/episode.json')))?.mtimeMs;
        if (version === undefined || this.scanned.get(code) === version) continue;
        const pending = await withEpisodeLock(dir, async () => {
          const ep = await this.episode(code);
          if (ep.status === 'published' && ep.legacy) return false;
          const error = await blockingEpisodeAttempt(dir);
          if (error) {
            const uncertain = error.state === 'in_flight' || error.state === 'unknown';
            const errorCode = imageError(error);
            return { key: `error:${code}:${error.path}:${errorCode}`, message: `${label(ep)} đang dừng ở ${error.plan.slide ? `ảnh ${error.plan.slide}` : 'mẫu nhân vật'} — ${errorCode}${uncertain ? ', chưa rõ API đã tạo ảnh hay chưa' : ''}.` };
          }
          if (!deliverableStatus(ep.status)) return null;
          const bundle = await episodeBundle(dir);
          return { key: `done:${code}:${bundle.key}`, message: `${label(ep)} đã xong.`, replyMarkup: viewMarkup(code) };
        }, { timeoutMs: 0 });
        if (pending === false || (pending && await this.notice(pending.key, pending.message, pending.replyMarkup) && pending.key.startsWith('done:'))) {
          this.scanned.set(code, version);
        }
      } catch (error) {
        if (!error.message.startsWith('Timed out waiting for episode lock')) this.log(`Could not verify ${code} for notifications.`);
      }
    }
  }
}
