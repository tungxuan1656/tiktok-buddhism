import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import install, { BOT_MODEL } from '../model.ts';

type Model = Parameters<ExtensionAPI['setModel']>[0];
const model: Model = {
  id: BOT_MODEL.id, provider: BOT_MODEL.provider, name: 'Local alias',
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', reasoning: true, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
  thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' }, headers: { 'X-Test': 'keep' },
};

function fixture(found: Model | undefined, authenticated = true) {
  let start!: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
  let selected: Model | undefined;
  let thinking: string | undefined;
  const api = {
    on(event: string, handler: typeof start) { assert.equal(event, 'session_start'); start = handler; },
    async setModel(value: Model) { selected = value; return authenticated; },
    setThinkingLevel(level: string) { thinking = level; },
  };
  install(api as unknown as ExtensionAPI);
  const ctx = { modelRegistry: { find(provider: string, id: string) {
    assert.equal(provider, BOT_MODEL.provider); assert.equal(id, BOT_MODEL.id); return found;
  } } } as unknown as ExtensionContext;
  return { run: () => start({ type: 'session_start', reason: 'startup' }, ctx), state: () => ({ selected, thinking }) };
}

test('bot re-applies xhigh to a session-only copy without replacing provider metadata', async () => {
  const before = structuredClone(model);
  for (let i = 0; i < 2; i++) {
    const f = fixture(model);
    await f.run();
    const { selected, thinking } = f.state();
    assert.ok(selected);
    assert.notEqual(selected, model);
    assert.deepEqual(selected, { ...before, thinkingLevelMap: { ...before.thinkingLevelMap, xhigh: 'xhigh' } });
    assert.equal(selected.baseUrl, model.baseUrl);
    assert.equal(selected.headers, model.headers);
    assert.equal(thinking, 'xhigh');
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
