import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { Store } from '../store.ts';
import { Trace, eventLine } from '../trace.ts';
import { Telegram, TelegramError } from '../telegram.ts';

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'buddhism-trace-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const calls: { text: string; message?: number }[] = [];
  const telegram = new Telegram('not-a-token', 123);
  telegram.trace = async (text, message) => { calls.push({text, message}); return message ?? 55; };
  const trace = new Trace(store, telegram);
  t.after(async () => { await trace.close(); store.db.close(); await rm(dir, { recursive: true, force: true }); });
  return { trace, store, calls, telegram };
}

test('trace keeps exactly the last ten single bounded lines, including after reopening the viewer', async t => {
  const { trace, store, calls, telegram } = await setup(t);
  for (let i = 0; i < 25; i++) trace.add(`event ${i}\n${'x'.repeat(500)}`);
  assert.equal(trace.lines().length, 10);
  assert.match(trace.lines()[0], /event 15 /);
  assert.match(trace.lines()[9], /event 24 /);
  assert.equal(trace.text().split('\n').length, 10);
  assert.ok(trace.text().length <= 2000);
  assert.equal(calls.length, 0);
  const restored = new Trace(store, telegram);
  assert.equal(restored.text(), trace.text());
  await restored.close();
});

test('live trace edits one message, coalesces bursts, and stops editing when switched off', async t => {
  const { trace, calls } = await setup(t);
  await trace.setEnabled(true);
  for (let i = 0; i < 40; i++) trace.add(`event ${i}`);
  await trace.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message, 55);
  assert.equal(calls[1].text.split('\n').length, 10);
  await trace.flush();
  await trace.setEnabled(true);
  assert.equal(calls.length, 2);
  await trace.setEnabled(false);
  trace.add('still available through /log');
  await trace.flush();
  assert.equal(calls.length, 2);
  assert.match(trace.text(), /still available/);
  await trace.setEnabled(true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].message, 55);
});

test('ambiguous live send disables automatic edits but preserves /log and allows explicit re-enable', async t => {
  const { trace, telegram, calls } = await setup(t);
  telegram.trace = async () => { throw new TelegramError(true); };
  trace.add('before failure');
  await trace.setEnabled(true);
  assert.equal(trace.enabled(), false);
  trace.add('after failure');
  await trace.flush();
  assert.match(trace.text(), /after failure/);
  telegram.trace = async (text, message) => { calls.push({text,message}); return 66; };
  await trace.setEnabled(true);
  assert.equal(trace.enabled(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, undefined);
});

test('event formatting excludes commands, arbitrary paths, results and thinking/text content', () => {
  const line = (value: object) => eventLine(value as JsonAgentSessionEvent);
  const secret = 'SECRET_DO_NOT_FORWARD';
  assert.equal(line({type:'tool_execution_start',toolName:'bash',args:{command:`curl -H 'Authorization: ${secret}'`}}), 'Bắt đầu bash (ẩn lệnh và đầu ra)');
  assert.equal(line({type:'tool_execution_start',toolName:'read',args:{path:`/private/${secret}/.env`}}), 'Bắt đầu read');
  assert.equal(line({type:'tool_execution_start',toolName:secret,args:{}}), 'Bắt đầu tool');
  assert.equal(line({type:'tool_execution_start',toolName:'read',args:{path:'/task/output/r01/003.png'}}), 'Bắt đầu read: 003.png');
  assert.equal(line({type:'tool_execution_end',toolName:'bash',isError:true,result:{content:[{type:'text',text:secret}]}}), 'bash: báo lỗi');
  assert.equal(line({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:secret}}), undefined);
  assert.equal(line({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:secret}}), undefined);
});

test('Telegram trace sends and then edits only the configured private chat', async () => {
  const bodies: Record<string, unknown>[] = [];
  const methods: string[] = [];
  const telegram = new Telegram('not-a-token',123,async (url, options) => {
    methods.push(String(url).split('/').at(-1)!);
    bodies.push(JSON.parse(String(options?.body)));
    return new Response(JSON.stringify({ok:true,result:{message_id:8}}));
  });
  const id = await telegram.trace('line one');
  await telegram.trace('line two',id);
  assert.deepEqual(methods,['sendMessage','editMessageText']);
  assert.deepEqual(bodies,[{chat_id:123,text:'line one'},{chat_id:123,text:'line two',message_id:8}]);
});
