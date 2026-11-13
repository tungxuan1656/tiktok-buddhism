import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock } from '../lock.ts';

// No network or models: race real OS processes against SQLite's file lock.
test('concurrent starts have one winner; SIGKILL automatically releases the process lock', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buddhism-lock-'));
  const code = `import { acquireLock } from ${JSON.stringify(new URL('../lock.ts', import.meta.url).href)};
    try { acquireLock(${JSON.stringify(dir)}); process.send('locked'); setInterval(() => {}, 1000); }
    catch { process.send('busy'); process.exit(0); }`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    await rm(dir, { recursive: true, force: true });
  });
  const states = await Promise.all(children.map(child => once(child, 'message').then(([state]) => state)));
  assert.deepEqual([...states].sort(), ['busy', 'locked']);
  assert.throws(() => acquireLock(dir), /Bridge khác/);
  const winner = children[states.indexOf('locked')];
  const exited = once(winner, 'exit'); winner.kill('SIGKILL'); await exited;
  const release = acquireLock(dir);
  release();
});
