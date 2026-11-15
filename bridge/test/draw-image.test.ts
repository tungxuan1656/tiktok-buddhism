import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

// Exercise the production CLI and converter without contacting the real image provider.
const script = resolve('scripts/draw-image.mjs');
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'draw-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = join(root, 'source.png');
  const prompt = join(root, 'prompt.txt');
  execFileSync('magick', ['-size', '1024x1536', 'gradient:white-wheat', raw]);
  await writeFile(prompt, 'CHỮ CẦN IN\nGiữ nguyên chữ và dấu.\n');
  const episode = join(root, 'episode.json');
  await writeFile(episode, JSON.stringify({ slides: [{ text: 'Giữ nguyên chữ và dấu.' }] }));
  const production = (await import('../../scripts/draw-image.mjs' as string)).draw;
  const draw = (options: Record<string, unknown>) => production({ episodeFile: episode, slide: 1, ...options });
  const status = async (work: string) => JSON.parse(await readFile(join(work, 'status.json'), 'utf8'));
  return { root, raw, prompt, draw, status, episode };
}

test('wrapper posts once with real reference MIME, preserves raw, then produces JPEG95 at 1080x1440', async t => {
  const { root, raw, prompt, draw, status } = await setup(t);
  const source = await readFile(raw);
  const jpegPath = join(root, 'reference.jpeg');
  execFileSync('magick', [raw, jpegPath]);
  const jpeg = await readFile(jpegPath);
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'cx/gpt-image-2.6-flare');
    assert.equal(payload.prompt, await readFile(prompt, 'utf8'));
    assert.equal(payload.size, '1024x1536');
    assert.equal(payload.output_format, 'jpeg');
    assert.deepEqual(payload.images, [`data:image/png;base64,${source.toString('base64')}`, `data:image/jpeg;base64,${jpeg.toString('base64')}`]);
    assert.equal(payload.output_compression, undefined);
    res.end(source);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address() as { port: number };
  const work = join(root, 'draft');
  const output = await draw({ promptFile: prompt, workDir: work, references: [raw, jpegPath], request: (_url: string, init: RequestInit) => fetch(`http://127.0.0.1:${address.port}`, init) });
  assert.equal(calls, 1);
  assert.equal(output, join(work, 'image.jpg'));
  assert.deepEqual(await readFile(join(work, 'response.bin')), source);
  const savedRequest = JSON.parse(await readFile(join(work, 'request.json'), 'utf8'));
  assert.equal(savedRequest.images, undefined);
  assert.equal(savedRequest.reference_count, 2);
  assert.equal(savedRequest.plan.slide, 1);
  assert.equal(execFileSync('magick', ['identify', '-format', '%m %w %h %Q %[jpeg:sampling-factor]', output], { encoding: 'utf8' }), 'JPEG 1080 1440 95 1x1,1x1,1x1');
  assert.equal((await status(work)).state, 'succeeded');
  assert.equal((await status(work)).source.mime, 'image/png');
  await assert.rejects(draw({ promptFile: prompt, workDir: work }), { code: 'EEXIST' });
  assert.equal(calls, 1);
});

test('normalize-only CLI reuses existing bytes without an API call and keeps a fresh directory', async t => {
  const { root, raw, status } = await setup(t);
  const work = join(root, 'local');
  execFileSync(process.execPath, [script, '--normalize', raw, work]);
  assert.equal((await status(work)).state, 'succeeded');
  assert.deepEqual(await readFile(join(work, 'response.bin')), await readFile(raw));
  assert.ok(!(await readdir(work)).includes('request.json'));
  assert.throws(() => execFileSync(process.execPath, [script, '--normalize', raw, work], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }));
});

test('API and conversion errors have durable safe states, with no automatic retry', async t => {
  const { root, prompt, draw, status } = await setup(t);
  const cases = [
    { expected: 'unknown', request: async () => { throw new Error('EXAMPLE_PRIVATE_KEY'); } },
    { expected: 'failed', request: async () => new Response('EXAMPLE_PRIVATE_KEY', { status: 401 }) },
    { expected: 'unknown', request: async () => new Response('unavailable', { status: 503 }) },
    { expected: 'normalize_failed', request: async () => new Response('{"error":"not an image"}') },
    { expected: 'unknown', request: async () => new Response('too big', { headers: { 'content-length': '49000001' } }) },
    { expected: 'unknown', request: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')); } })) },
  ];
  for (let i = 0; i < cases.length; i++) {
    const work = join(root, `failed-${i}`);
    let calls = 0;
    await assert.rejects(draw({ promptFile: prompt, workDir: work, request: async () => { calls++; return cases[i].request(); } }), (error: Error) => !error.message.includes('EXAMPLE_PRIVATE_KEY'));
    assert.equal(calls, 1);
    const saved = await status(work);
    assert.equal(saved.state, cases[i].expected);
    assert.ok(!JSON.stringify(saved).includes('EXAMPLE_PRIVATE_KEY'));
    assert.ok(await readFile(join(work, 'request.json')));
  }
  const invalid = join(root, 'invalid');
  await assert.rejects(draw({ promptFile: join(root, 'missing'), workDir: invalid, request: () => { throw new Error('must not call'); } }));
  assert.equal((await status(invalid)).state, 'invalid_input');
});


test('saved JSON gates every API request, including characters; invalid scripts never POST', async t => {
  const { root, raw, prompt, draw, status, episode } = await setup(t);
  const source = await readFile(raw);
  let calls = 0;
  const request = async () => { calls++; return new Response(source); };
  const pages = (n: number) => ({ slides: Array.from({ length: n }, () => ({ text: 'Nguyên văn.' })) });
  const invalid = ['{', JSON.stringify(pages(0)), JSON.stringify(pages(36)), JSON.stringify({ slides: [{ text: '' }] })];
  for (const [index, text] of invalid.entries()) {
    await writeFile(episode, text);
    const workDir = join(root, `invalid-plan-${index}`);
    await assert.rejects(draw({ promptFile: prompt, workDir, request }), /script_invalid|script_count|slide_invalid/);
    assert.equal((await status(workDir)).state, 'invalid_input');
    assert.equal(calls, 0);
  }
  await writeFile(episode, JSON.stringify(pages(35)));
  for (const slide of [0, 36, 1.5, undefined]) {
    await assert.rejects(draw({ promptFile: prompt, workDir: join(root, `bad-index-${slide}`), slide, request }), /slide_invalid/);
  }
  assert.equal(calls, 0);
  await draw({ promptFile: prompt, workDir: join(root, 'slide-35'), slide: 35, request });
  await draw({ promptFile: prompt, workDir: join(root, 'character'), character: true, slide: undefined, request });
  assert.equal(calls, 2);
  await writeFile(episode, JSON.stringify(pages(36)));
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'bad-character'), character: true, slide: undefined, request }), /script_count/);
  assert.equal(calls, 2);
  assert.throws(() => execFileSync(process.execPath, [script, prompt, join(root, 'legacy')], { stdio: 'pipe' }));
});
