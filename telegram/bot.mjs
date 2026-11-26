import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertEpisodeIdentity, blockingEpisodeAttempt, deliverableStatus, episodeBundle, imageBytes, isEpisodeCode, readEpisode } from '../scripts/lib/episode.mjs';
import { withEpisodeLock } from '../scripts/lib/lock.mjs';
import { statIfPresent } from '../scripts/lib/resume.mjs';

const states = { draft: 'đang soạn hoặc chỉnh', locked: 'đang làm ảnh', ready_for_review: 'đã xong, chờ duyệt', approved: 'đã duyệt', published: 'đã đăng' };
const label = ep => `${ep.code}: "${ep.title.replace(/\s+/g, ' ').trim()}"`;
const encoder = new TextEncoder();
const content = ep => `${ep.title}\n\n${ep.slides.map((page, i) => `--- ${i + 1} ---\n${page.text}`).join('\n\n')}\n`;
const number = code => Number(code.slice(1));

export function openDelivery(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id = 1), offset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (key TEXT PRIMARY KEY, message_id INTEGER, retry_at INTEGER);`);
  const updateOffset = db.prepare('INSERT INTO cursor VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET offset = excluded.offset WHERE excluded.offset > offset');
  const getNotice = db.prepare('SELECT * FROM notices WHERE key = ?');
  const markNotice = db.prepare('INSERT OR REPLACE INTO notices VALUES (?, ?, ?)');
  return {
    close: () => db.close(),
    offset: () => db.prepare('SELECT offset FROM cursor WHERE id = 1').get()?.offset ?? 0,
    consume: offset => updateOffset.run(offset).changes === 1,
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

  async update(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !this.delivery.consume(update.update_id + 1)) return;
    const message = update.message;
    if (!this.telegram.authorized(message) || typeof message.text !== 'string') return;
    const [command, arg, ...extra] = message.text.trim().split(/\s+/);
    if (command === '/episodes' && !arg) return this.list();
    if (command === '/get' && isEpisodeCode(arg) && !extra.length) return this.sendEpisode(arg);
    if (command === '/start' || command === '/help' || command === '/get') {
      await this.telegram.say('Dùng /episodes để xem danh sách. Ví dụ: /get T34 để lấy ảnh gốc cùng nội dung.');
    }
  }

  async list() {
    let text = 'Danh sách tập:\n';
    let count = 0;
    for (const code of await this.codes()) {
      let ep;
      try { ep = await this.episode(code); } catch { continue; }
      const line = `${label(ep)} — ${states[ep.status]}\n`;
      if (text.length + line.length > 3900) { await this.telegram.say(text.trimEnd()); text = ''; }
      count++;
      text += line;
    }
    await this.telegram.say(count ? text.trimEnd() : 'Chưa có tập nào.');
  }

  async sendEpisode(code) {
    const dir = join(this.root, code);
    if (!(await statIfPresent(dir))?.isDirectory()) return this.telegram.say(`Không tìm thấy ${code}.`);
    let sent = 0;
    let total = 0;
    try {
      await withEpisodeLock(dir, async () => {
        const ep = await this.episode(code);
        if (!deliverableStatus(ep.status)) return this.telegram.say(`${label(ep)} đang làm hoặc đang chỉnh; chưa có bộ ảnh để gửi.`);
        let bundle;
        try { bundle = await episodeBundle(dir); }
        catch { return this.telegram.say(`${label(ep)} ${ep.status === 'published' ? 'đã đăng nhưng không có' : 'chưa có'} đủ ảnh thành phẩm xác minh được.`); }
        total = bundle.files.length + 1;
        for (const file of bundle.files) {
          const image = await imageBytes(dir, file.file);
          if (image.sha256 !== file.sha256) throw new Error('Image changed after verification');
          await this.telegram.document({ name: `${code}-${file.file.split('/').at(-1)}`, ...image });
          sent++;
        }
        await this.telegram.document({ name: `${code}-noi-dung.txt`, mime: 'text/plain; charset=utf-8', bytes: encoder.encode(content(bundle.episode)) });
        sent++;
      }, { timeoutMs: 0 });
    } catch (error) {
      if (total) {
        if (this.telegram.signal?.aborted || error.status === 403) return;
        try { await this.telegram.say(`${code}: Telegram xác nhận ${sent}/${total} tệp. Hãy kiểm tra chat trước khi dùng lại /get ${code}.`); }
        catch { this.log('Telegram partial delivery status not confirmed.'); }
      } else if (error.message.startsWith('Timed out waiting for episode lock')) await this.telegram.say(`${code} đang được xử lý; thử lại khi tập đã xong.`);
      else throw error;
    }
  }

  async notice(key, message) {
    const status = this.delivery.noticeStatus(key);
    if (status !== 'due') return status === 'settled';
    if (this.telegram.signal?.aborted) return false;
    // Reserving before the POST avoids repeating an unconfirmed send after a crash.
    this.delivery.markNotice(key);
    try { this.delivery.markNotice(key, await this.telegram.say(message)); }
    catch (error) {
      this.log('Telegram notification not confirmed.');
      if (!error.ambiguous && (error.notSent || error.status === 429 || error.status === 403)) {
        let delay = 0;
        if (error.status === 403) delay = 60;
        else if (error.status === 429) delay = error.retryAfter || 30;
        this.delivery.markNotice(key, null, Date.now() + delay * 1000);
        return false;
      }
    }
    return true;
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
            return { key: `error:${code}:${error.path}:${error.code}`, message: `${label(ep)} đang dừng ở ${error.slide ? `ảnh ${error.slide}` : 'mẫu nhân vật'} — ${error.code}${uncertain ? ', chưa rõ API đã tạo ảnh hay chưa' : ''}.` };
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
