import { execFileSync } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { withEpisodeLock } from '../scripts/lib/lock.mjs';
import { REPO_ROOT } from '../scripts/lib/policy.mjs';
import { Telegram } from './api.mjs';
import { Bot, openDelivery } from './bot.mjs';

export async function pollUpdates({ telegram, bot, delivery, signal, wait = sleep, log = console.warn }) {
  while (!signal.aborted) {
    try {
      await bot.scan();
      if (signal.aborted) break;
      const updates = await telegram.poll(delivery.offset());
      if (!Array.isArray(updates)) throw new Error('Invalid Telegram update batch');
      for (const update of updates) {
        if (signal.aborted) break;
        try { await bot.update(update); }
        catch { log('Telegram command did not complete.'); }
      }
    } catch (error) {
      if (signal.aborted) break;
      log('Telegram poll unavailable.');
      await wait(Math.max(5, error.retryAfter || 0) * 1000, undefined, { signal }).catch(() => {});
    }
  }
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id = process.env.TELEGRAM_USER_ID ?? '';
  const owner = Number(id);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token ?? '') || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(owner)) {
    throw new Error('Configure TELEGRAM_BOT_TOKEN and the numeric TELEGRAM_USER_ID.');
  }
  const state = join(REPO_ROOT, '.telegram');
  const check = process.argv[2] === '--check';
  if (!check) await mkdir(state, { recursive: true, mode: 0o700 });
  const info = await lstat(state).catch(error => {
    if (!check || error.code !== 'ENOENT') throw error;
    return null;
  });
  if (info && (!info.isDirectory() || (info.mode & 0o077) !== 0)) {
    throw new Error('.telegram must be a private directory (chmod 700).');
  }
  if (check) {
    try { execFileSync('magick', ['-version'], { stdio: 'ignore', timeout: 10_000 }); }
    catch { throw new Error('ImageMagick is unavailable: magick -version failed.'); }
    console.log('Telegram configuration and ImageMagick checked; no network requests made.');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await withEpisodeLock(state, async () => {
    const telegram = new Telegram(token, owner, { signal: controller.signal });
    const delivery = openDelivery(join(state, 'delivery.sqlite'));
    const bot = new Bot({ root: join(REPO_ROOT, 'episodes'), telegram, delivery });
    try {
      console.log('Telegram delivery bot started.');
      await pollUpdates({ telegram, bot, delivery, signal: controller.signal });
    } finally { delivery.close(); }
  }, { timeoutMs: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Telegram bot could not start; check configuration, ImageMagick, .telegram permissions and single-instance lock.');
    process.exitCode = 1;
  }).finally(() => {
    if (process.connected) process.disconnect();
  });
}
