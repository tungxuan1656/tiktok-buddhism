import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { withEpisodeLock } from '../scripts/lib/lock.mjs';
import { REPO_ROOT } from '../scripts/lib/policy.mjs';
import { Telegram } from './api.mjs';
import { Bot, openDelivery } from './bot.mjs';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const id = process.env.TELEGRAM_USER_ID ?? '';
  const owner = Number(id);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token ?? '') || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(owner)) {
    throw new Error('Configure TELEGRAM_BOT_TOKEN and the numeric TELEGRAM_USER_ID.');
  }
  if (process.argv[2] === '--check') {
    console.log('Telegram configuration present; no network requests made.');
    return;
  }
  const state = join(REPO_ROOT, '.telegram');
  await mkdir(state, { recursive: true });
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
      while (!controller.signal.aborted) {
        try {
          await bot.scan();
          const updates = await telegram.poll(delivery.offset());
          if (!Array.isArray(updates)) throw new Error('Invalid Telegram update batch');
          for (const update of updates) {
            if (controller.signal.aborted) break;
            try { await bot.update(update); }
            catch { console.warn('Telegram command did not complete.'); }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.warn('Telegram poll unavailable.');
            await sleep(Math.max(5, error.retryAfter || 0) * 1000, undefined, { signal: controller.signal }).catch(() => {});
          }
        }
      }
    } finally { delivery.close(); }
  }, { timeoutMs: 0 });
}

main().catch(() => {
  console.error('Telegram bot could not start; check configuration, state directory and single-instance lock.');
  process.exitCode = 1;
}).finally(() => {
  if (process.connected) process.disconnect();
});
