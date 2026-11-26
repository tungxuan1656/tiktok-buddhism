import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertEpisodeIdentity, blockingEpisodeAttempt, deliverableStatus, episodeBundle, imageBytes, isEpisodeCode, readEpisode } from '../scripts/lib/episode.mjs';
import { withEpisodeLock } from '../scripts/lib/lock.mjs';
import { imageError, statIfPresent } from '../scripts/lib/resume.mjs';
import { TelegramError } from './api.mjs';

const states = { draft: 'đang soạn hoặc chỉnh', locked: 'đang làm ảnh', ready_for_review: 'đã xong, chờ duyệt', approved: 'đã duyệt', published: 'đã đăng' };
const label = ep => `${ep.code}: "${ep.title.replace(/\s+/g, ' ').trim()}"`;
const encoder = new TextEncoder();
const content = ep => `${ep.title}\n\n${ep.slides.map((page, i) => `--- ${i + 1} ---\n${page.text}`).join('\n\n')}\n`;
const number = code => Number(code.slice(1));
// A fetched update can already be a day old; Telegram resets IDs after a week of inactivity.
const CURSOR_TTL_MS = 5 * 24 * 60 * 60 * 1000;

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
    const message = update.message;
    const authorized = this.telegram.authorized(message) && typeof message.text === 'string';
    const [command, arg, ...extra] = authorized ? message.text.trim().split(/\s+/) : [];
    if (command === '/get' && isEpisodeCode(arg) && !extra.length) await this.sendEpisode(arg, consume);
    else if (command === '/episodes' && !arg) await this.list(consume);
    else if (command === '/start' || command === '/help' || command === '/get') {
      await this.telegram.say('Dùng /episodes để xem danh sách. Ví dụ: /get T34 để lấy ảnh gốc cùng nội dung.', consume);
    } else consume();
    return consumed;
  }

  async list(beforePost) {
    let text = 'Danh sách tập:\n';
    let count = 0;
    for (const code of await this.codes()) {
      let ep;
      try { ep = await this.episode(code); } catch { continue; }
      const line = `${label(ep)} — ${states[ep.status]}\n`;
      if (text.length + line.length > 3900) { await this.telegram.say(text.trimEnd(), beforePost); text = ''; }
      count++;
      text += line;
    }
    await this.telegram.say(count ? text.trimEnd() : 'Chưa có tập nào.', beforePost);
  }

  async sendEpisode(code, beforePost) {
    const dir = join(this.root, code);
    const say = text => this.telegram.say(text, beforePost);
    if (!(await statIfPresent(dir))?.isDirectory()) return say(`Không tìm thấy ${code}.`);
    let sent = 0;
    let total = 0;
    try {
      await withEpisodeLock(dir, async () => {
        const ep = await this.episode(code);
        if (!deliverableStatus(ep.status)) return say(`${label(ep)} đang làm hoặc đang chỉnh; chưa có bộ ảnh để gửi.`);
        let bundle;
        try { bundle = await episodeBundle(dir); }
        catch { return say(`${label(ep)} ${ep.status === 'published' ? 'đã đăng nhưng không có' : 'chưa có'} đủ ảnh thành phẩm xác minh được.`); }
        total = bundle.files.length + 1;
        for (const file of bundle.files) {
          const image = await imageBytes(dir, file.file);
          if (image.sha256 !== file.sha256) throw new Error('Image changed after verification');
          await this.telegram.document({ name: `${code}-${file.file.split('/').at(-1)}`, ...image }, beforePost);
          sent++;
        }
        await this.telegram.document({ name: `${code}-noi-dung.txt`, mime: 'text/plain; charset=utf-8', bytes: encoder.encode(content(bundle.episode)) }, beforePost);
        sent++;
      }, { timeoutMs: 0 });
    } catch (error) {
      if (total) {
        if (this.telegram.signal?.aborted || error.status === 403) return;
        if (!sent && !(error instanceof TelegramError)) throw error;
        try { await say(`${code}: Telegram xác nhận ${sent}/${total} tệp. Hãy kiểm tra chat trước khi dùng lại /get ${code}.`); }
        catch { this.log('Telegram partial delivery status not confirmed.'); }
      } else if (error.message.startsWith('Timed out waiting for episode lock')) await say(`${code} đang được xử lý; thử lại khi tập đã xong.`);
      else throw error;
    }
  }

  async notice(key, message) {
    const status = this.delivery.noticeStatus(key);
    if (status !== 'due') return status === 'settled';
    if (this.telegram.signal?.aborted) return false;
    let reserved = false;
    try {
      const id = await this.telegram.say(message, () => {
        // Reserve only at dispatch so a crash during the send delay leaves the notice due.
        this.delivery.markNotice(key);
        reserved = true;
      }, { retry429: false });
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
          return { key: `done:${code}:${bundle.key}`, message: `${label(ep)} đã xong.` };
        }, { timeoutMs: 0 });
        if (pending === false || (pending && await this.notice(pending.key, pending.message) && pending.key.startsWith('done:'))) {
          this.scanned.set(code, version);
        }
      } catch (error) {
        if (!error.message.startsWith('Timed out waiting for episode lock')) this.log(`Could not verify ${code} for notifications.`);
      }
    }
  }
}
