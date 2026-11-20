import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.ts';
import { Telegram, TelegramError } from './telegram.ts';
import { PiRunner } from './pi.ts';
import { Bridge } from './bridge.ts';
import { acquireLock } from './lock.ts';
import { pruneTask } from './retention.ts';
import type { Task } from './store.ts';

process.umask(0o077);
const root = fileURLToPath(new URL('../', import.meta.url));
const stateDir = join(root, '.telegram');

async function main() {
  const check = process.argv.includes('--check');
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const owner = Number(process.env.TELEGRAM_USER_ID);
  const validToken = /^\d+:[A-Za-z0-9_-]{20,}$/.test(token);
  const configured = validToken && Number.isSafeInteger(owner) && owner > 0;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(stateDir);
  let store: Store | undefined;
  const runner = new PiRunner(root, stateDir);
  try {
    if (process.argv.includes('--prune')) {
      store = new Store(join(stateDir, 'state.sqlite'));
      const tasks = store.db.prepare('SELECT * FROM tasks').all() as Task[];
      for (const task of tasks) {
        const result = await pruneTask(store, task, stateDir, process.argv.includes('--apply'));
        console.log(JSON.stringify({ task: task.id, mode: process.argv.includes('--apply') ? 'apply' : 'preview', ...result }));
      }
      return;
    }
    if (process.argv.includes('--identify')) {
      if (!validToken) throw new Error('Thiếu TELEGRAM_BOT_TOKEN; cấu hình cục bộ, không gửi token vào chat');
      const updates = await new Telegram(token, 0).poll(0);
      const ids = [...new Set(updates.filter(update => update.message?.chat.type === 'private' && update.message.text === '/start' && !update.message.from?.is_bot && update.message.from?.id === update.message.chat.id).map(update => update.message!.chat.id))];
      console.log(ids.length ? `ID private chat đã gửi /start: ${ids.join(', ')}. Tự chọn ID của bạn để điền TELEGRAM_USER_ID; không tự cấp quyền cho người gửi đầu tiên.` : 'Chưa thấy /start. Hãy tự nhắn /start cho bot rồi chạy lại npm run identify.');
      return;
    }
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
    if (check) {
      const client = await runner.connect('telegram-readiness-check');
      const state = await client.getState();
      console.log(`Node + SQLite + ImageMagick + Pi RPC: OK. Model: ${state.model ? `${state.model.provider}/${state.model.id}` : 'chưa chọn'}; thinking: ${state.thinkingLevel}.`);
      console.log(configured ? 'Cấu hình Telegram: có (chưa gọi Telegram/model/image API).' : 'Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_USER_ID; xem bridge/README.md.');
      if (!configured) process.exitCode = 2;
      return;
    }
    if (!configured) throw new Error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_USER_ID; cấu hình cục bộ theo bridge/README.md, không gửi token vào chat');
    const telegram = new Telegram(token, owner);
    const bot = await telegram.call<{ username: string }>('getMe', {});
    console.log(`Đã kết nối bot @${bot.username}; chờ xác nhận private chat chủ bot.`);
    const hook = await telegram.call<{ url: string }>('getWebhookInfo', {});
    if (hook.url) throw new Error('Bot đang có webhook; gỡ webhook của bot trước khi dùng long polling');
    store = new Store(join(stateDir, 'state.sqlite'));
    const interrupted = store.recover();
    const bridge = new Bridge(store, telegram, runner, root, stateDir);
    let quitting = false;
    let shutdown: Promise<void> | undefined;
    const stop = () => { quitting = true; shutdown ??= bridge.shutdown(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await telegram.say(interrupted
        ? 'Mình vừa khởi động lại nên công việc trước đó bị gián đoạn. Phần đã làm vẫn được giữ lại và mình sẽ không tự vẽ lại. Bạn dùng /status để xem tình hình nhé.'
        : 'Mình sẵn sàng rồi. Bạn cứ nhắn nội dung muốn làm nhé.');
      console.log('Telegram bridge sẵn sàng (một chủ bot, private chat). Ctrl+C để dừng.');
      while (!quitting) {
        try {
          await bridge.tick();
          const updates = await telegram.poll(Number(store.get('offset') ?? 0));
          for (const update of updates) {
            if (quitting) break;
            await bridge.receive(update);
          }
        } catch (error) {
          if (!(error instanceof TelegramError)) throw error;
          console.error('Telegram tạm chưa truy cập được; giữ tiến độ, thử polling lại.');
          await delay(Math.max(3000, error.retryAfter * 1000));
        }
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await (shutdown ?? bridge.shutdown());
    }
  } finally {
    await runner.stop();
    store?.db.close();
    release();
  }
}

main().catch(error => {
  // Never print fetch/RPC errors: URLs, stderr and prompts can contain credentials.
  if (error instanceof TelegramError) {
    console.error('Không kết nối được Telegram. Kiểm tra token/mạng; không tự tạo ảnh.');
  } else if (error instanceof Error && /^(Thiếu |Bot đang |Bridge khác|Lock không|Không khởi động)/.test(error.message)) {
    console.error(error.message);
  } else {
    console.error('Bridge dừng vì lỗi cục bộ. Kiểm tra Node 24, ImageMagick, quyền ghi và chạy npm run check.');
  }
  process.exitCode = 1;
}).finally(() => {
  // PM2 keeps an IPC handle open after cleanup; finish the managed process explicitly.
  process.exit(process.exitCode ?? 0);
});
