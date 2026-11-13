import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);

test('PM2 runs one native TypeScript process, loads secrets locally, and allows graceful shutdown', () => {
  const config = require('../../ecosystem.config.cjs');
  assert.equal(config.apps.length, 1);
  const app = config.apps[0];
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(app.name, 'buddhism-telegram');
  assert.equal(app.script, join(root, 'bridge/main.ts'));
  assert.equal(app.interpreter, process.execPath);
  assert.deepEqual(app.node_args, [`--env-file=${join(root, '.env')}`]);
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.instances, 1);
  assert.equal(app.watch, false);
  assert.ok(app.kill_timeout >= 180000);
  assert.deepEqual(app.filter_env, ['TELEGRAM_']);
  assert.deepEqual(Object.keys(app.env), ['PATH']);
});

test('main exits after cleanup even when a process manager holds its IPC channel open', async () => {
  const child = fork(fileURLToPath(new URL('./ipc-fixture.mjs', import.meta.url)), [], {
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_USER_ID: '' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], timeout: 5000,
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(signal, null);
});
