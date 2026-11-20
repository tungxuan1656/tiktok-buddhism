import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import install, { BOT_MODEL, projectImages } from '../model.ts';

type Model = Parameters<ExtensionAPI['setModel']>[0];
const model: Model = {
  id: BOT_MODEL.id, provider: BOT_MODEL.provider, name: 'Local alias',
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', reasoning: true, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
  thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' }, headers: { 'X-Test': 'keep' },
};

function fixture(found: Model | undefined, authenticated = true) {
  let start!: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
  let project!: (event: ContextEvent) => { messages: ContextEvent['messages'] };
  let selected: Model | undefined;
  let thinking: string | undefined;
  const api = {
    on(event: string, handler: unknown) {
      if (event === 'session_start') start = handler as typeof start;
      else { assert.equal(event, 'context'); project = handler as typeof project; }
    },
    async setModel(value: Model) { selected = value; return authenticated; },
    setThinkingLevel(level: string) { thinking = level; },
  };
  install(api as unknown as ExtensionAPI);
  const ctx = { modelRegistry: { find(provider: string, id: string) {
    assert.equal(provider, BOT_MODEL.provider); assert.equal(id, BOT_MODEL.id); return found;
  } } } as unknown as ExtensionContext;
  return { run: () => start({ type: 'session_start', reason: 'startup' }, ctx), state: () => ({ selected, thinking }), project: (messages: ContextEvent['messages']) => project({ type: 'context', messages }).messages };
}

test('bot re-applies high without changing provider metadata or supported thinking levels', async () => {
  const before = structuredClone(model);
  for (let i = 0; i < 2; i++) {
    const f = fixture(model);
    await f.run();
    const { selected, thinking } = f.state();
    assert.ok(selected);
    assert.equal(selected, model);
    assert.deepEqual(selected, before);
    assert.equal(selected.baseUrl, model.baseUrl);
    assert.equal(selected.headers, model.headers);
    assert.equal(thinking, 'high');
  }
  assert.deepEqual(model, before);
});

test('missing/nonreasoning model or missing auth cannot silently select a fallback', async () => {
  for (const [found, authenticated] of [[undefined, true], [{ ...model, reasoning: false }, true], [model, false]] as const) {
    const f = fixture(found, authenticated);
    await assert.rejects(f.run());
    assert.equal(f.state().thinking, undefined);
  }
});

function imageMessage(index: number, data = `image-${index}`): ContextEvent['messages'][number] {
  return { role: 'toolResult', toolCallId: `read-${index}`, toolName: 'read', timestamp: index, isError: false,
    content: [{ type: 'text', text: `image ${index}` }, { type: 'image', data, mimeType: 'image/png' }] };
}
function images(messages: ContextEvent['messages']) {
  return messages.flatMap(message => (message.role === 'toolResult' || message.role === 'user') && Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'image') : []);
}

function assistant(...indices: number[]): ContextEvent['messages'][number] {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return { role: 'assistant', timestamp: 0, api: 'openai-completions', provider: BOT_MODEL.provider, model: BOT_MODEL.id,
    stopReason: 'toolUse', usage: { ...tokens, totalTokens: 0, cost: { ...tokens, total: 0 } },
    content: indices.map(index => ({ type: 'toolCall', id: `read-${index}`, name: 'read', arguments: { path: `${index}.jpg` } })) };
}

test('context only shows the latest deliberate reads and never changes earlier projected history', () => {
  const attached = { role: 'user', timestamp: 1, content: [{ type: 'image', data: 'attachment', mimeType: 'image/png' }] } as const;
  const original: ContextEvent['messages'] = [{ ...attached, content: [...attached.content] }, assistant(0), imageMessage(0), assistant(1, 2), imageMessage(1), imageMessage(2)];
  const before = structuredClone(original);
  const projected = fixture(model).project(original);
  assert.deepEqual(images(projected).map(image => image.data), ['image-1', 'image-2']);
  assert.deepEqual(projected.map(message => message.timestamp), original.map(message => message.timestamp));
  assert.match(JSON.stringify(projected[2]), /không suy đoán/);
  assert.match(JSON.stringify(projected[2]), /image 0/);
  assert.deepEqual(original, before);
  const next = projectImages([...original, assistant(3), imageMessage(3)]);
  assert.deepEqual(next.slice(0, 4), projected.slice(0, 4));
  assert.deepEqual(images(next).map(image => image.data), ['image-3']);
  assert.deepEqual(images(projectImages([...original, { role: 'user', content: 'Next request', timestamp: 3 }])), []);
});

test('the image budget applies only to fresh reads; other tool and custom images are not sent', () => {
  const data = 'A'.repeat(16 * 1024 * 1024);
  const original = [assistant(1, 2, 3), imageMessage(1, data), imageMessage(2, data), imageMessage(3, data)];
  const projected = projectImages(original);
  assert.equal(images(projected).length, 2);
  assert.equal(images(original).length, 3);
  const [result] = images([imageMessage(1)]);
  const unsolicited = projectImages([assistant(1), { ...imageMessage(1), toolName: 'other' } as ContextEvent['messages'][number],
    { role: 'custom', customType: 'test', display: true, content: [result], timestamp: 1 }]);
  assert.doesNotMatch(JSON.stringify(unsolicited), /"type":"image"/);
});
