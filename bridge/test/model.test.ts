import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContextEvent, ExtensionAPI, ExtensionContext, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import install, { BOT_MODEL, imageWindow } from '../model.ts';

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

test('context hook keeps the latest eight images and all text/tool ordering without editing history', () => {
  const original = Array.from({ length: 12 }, (_, i) => imageMessage(i));
  const before = structuredClone(original);
  const projected = fixture(model).project(original);
  assert.deepEqual(images(projected).map(image => image.data), Array.from({ length: 8 }, (_, i) => `image-${i + 4}`));
  assert.deepEqual(projected.map(message => message.timestamp), original.map(message => message.timestamp));
  assert.match(JSON.stringify(projected[0]), /không suy đoán/);
  assert.match(JSON.stringify(projected[0]), /image 0/);
  assert.deepEqual(original, before);
  assert.deepEqual(imageWindow(projected), projected);
});

test('image byte budget also bounds a few large images, while original data stays available', () => {
  const data = 'A'.repeat(16 * 1024 * 1024);
  const original = [imageMessage(1, data), imageMessage(2, data), imageMessage(3, data)];
  const projected = imageWindow(original);
  assert.equal(images(projected).length, 2);
  assert.equal(images(projected).reduce((bytes, image) => bytes + image.data.length, 0), 32 * 1024 * 1024);
  assert.equal(images(original).length, 3);
  assert.deepEqual(imageWindow([{ role: 'user', content: 'keep this text', timestamp: 1 }]), [{ role: 'user', content: 'keep this text', timestamp: 1 }]);
});
