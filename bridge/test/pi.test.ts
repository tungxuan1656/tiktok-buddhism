import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { PiRunner } from '../pi.ts';

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'buddhism-rpc-'));
  const log = join(dir, 'rpc.log');
  const client = new RpcClient({ cliPath: fileURLToPath(new URL('./rpc-fixture.mjs', import.meta.url)), env: { TEST_RPC_LOG: log } });
  await client.start();
  const runner = new PiRunner(dir, dir);
  runner.client = client; runner.session = 'test';
  t.after(async () => { await runner.stop(); await rm(dir, { recursive: true, force: true }); });
  return { client, runner, log };
}

test('RpcClient listener catches agent_settled before the prompt acceptance response', async t => {
  const { runner } = await setup(t);
  await runner.run('test', 'fast\u2028completion\u2029still one JSONL record', () => {}, new AbortController().signal);
});

test('cancel clears queued input before abort and waits for settlement', async t => {
  const { runner, log } = await setup(t);
  let started = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = runner.run('test', 'hold', started, new AbortController().signal);
  const rejected = assert.rejects(pending, /dừng/);
  await entered;
  await runner.cancel();
  await rejected;
  const commands = (await readFile(log, 'utf8')).trim().split('\n');
  assert.deepEqual(commands.slice(1, 3), ['clear_queue', 'abort']);
});

test('a handled prompt rejects immediately rather than waiting for a settlement that cannot happen', async t => {
  const { runner } = await setup(t);
  await assert.rejects(runner.run('test', 'handled', () => {}, new AbortController().signal), /không bắt đầu/);
});
