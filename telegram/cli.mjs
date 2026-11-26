import { main } from './main.mjs';

main().catch(() => {
  console.error('Telegram bot could not start; check configuration, ImageMagick, .telegram permissions and single-instance lock.');
  process.exitCode = 1;
}).finally(() => {
  if (process.connected) process.disconnect();
});
