import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

// Exercise the production CLI and converter without contacting the real image provider.
const script = resolve('scripts/draw-image.mjs');
const ep = (slides: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  mode: 'original',
  slides: slides.map(s => ({ scene: 'Cảnh tĩnh', scene_type: 'concept', characters: [], ...s })),
  ...extra,
});

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'draw-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = join(root, 'source.png');
  const prompt = join(root, 'prompt.txt');
  execFileSync('magick', ['-size', '1024x1536', 'gradient:white-wheat', raw]);
  await writeFile(prompt, 'CHỮ CẦN IN\nGiữ nguyên chữ và dấu.\n');
  const episode = join(root, 'episode.json');
  await writeFile(episode, JSON.stringify(ep([{ text: 'Giữ nguyên chữ và dấu.' }])));
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
  assert.ok(savedRequest.request_sha256);
  assert.ok(savedRequest.slide_content_sha256);
  assert.equal(execFileSync('magick', ['identify', '-format', '%m %w %h %Q %[jpeg:sampling-factor]', output], { encoding: 'utf8' }), 'JPEG 1080 1440 95 1x1,1x1,1x1');
  const st = await status(work);
  assert.equal(st.state, 'succeeded');
  assert.equal(st.source.mime, 'image/png');
  assert.ok(st.output.sha256);
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
    { expected: 'unknown', request: async () => new Response('upstream error', { status: 503 }) },
    { expected: 'failed', request: async () => new Response('bad prompt', { status: 400 }) },
    { expected: 'normalize_failed', request: async () => new Response('not an image') },
  ];
  for (let i = 0; i < cases.length; i++) {
    let calls = 0;
    const work = join(root, `case-${i}`);
    await assert.rejects(draw({ promptFile: prompt, workDir: work, request: async () => { calls++; return cases[i].request(); } }), (error: Error) => !error.message.includes('EXAMPLE_PRIVATE_KEY'));
    assert.equal(calls, 1);
    const saved = await status(work);
    assert.equal(saved.state, cases[i].expected);
    assert.ok(!JSON.stringify(saved).includes('EXAMPLE_PRIVATE_KEY'));
    assert.ok(await readFile(join(work, 'request.json')));
    // Reconcile each unresolved attempt before testing the next slide-1 call.
    if (['unknown', 'normalize_failed'].includes(saved.state)) {
      const { reconcileAttempt } = await import('../../scripts/draw-image.mjs' as string);
      await reconcileAttempt({ workDir: work, resolution: 'reconciled_failed', note: 'Verified test case' });
    }
  }
  const invalid = join(root, 'invalid');
  await assert.rejects(draw({ promptFile: join(root, 'missing'), workDir: invalid, request: () => { throw new Error('must not call'); } }));
  assert.equal((await status(invalid)).state, 'invalid_input');
});

test('saved JSON and shared schema validation gate every API request; invalid scripts never POST', async t => {
  const { root, raw, prompt, draw, status, episode } = await setup(t);
  const source = await readFile(raw);
  let calls = 0;
  const request = async () => { calls++; return new Response(source); };
  const pages = (n: number) => ep(Array.from({ length: n }, () => ({ text: 'Nguyên văn.' })));
  const invalid = [
    '{',
    JSON.stringify(pages(0)),
    JSON.stringify(pages(36)),
    JSON.stringify(ep([{ text: '' }])),
    JSON.stringify({ mode: 'invalid_mode', slides: [{ text: 'Ok', scene: 'Cảnh', scene_type: 'concept' }] }),
    JSON.stringify({ mode: 'original', slides: [{ text: 'Ok', scene: '', scene_type: 'concept' }] }),
    JSON.stringify({ mode: 'original', slides: [{ text: 'Ok', scene: 'Cảnh', scene_type: 'bad_type' }] }),
  ];
  for (const [index, text] of invalid.entries()) {
    await writeFile(episode, text);
    const workDir = join(root, `invalid-plan-${index}`);
    await assert.rejects(draw({ promptFile: prompt, workDir, request }), /script_invalid|script_count|slide_invalid|episode_invalid/);
    assert.equal((await status(workDir)).state, 'invalid_input');
    assert.equal(calls, 0);
  }
  await writeFile(episode, JSON.stringify(pages(35)));
  for (const slide of [0, 36, 1.5, undefined]) {
    await assert.rejects(draw({ promptFile: prompt, workDir: join(root, `bad-index-${slide}`), slide, request }), /slide_invalid/);
  }
  assert.equal(calls, 0);
  await draw({ promptFile: prompt, workDir: join(root, 'slide-35'), slide: 35, request });
  // Character mode validates script schema without requiring missing character snapshots.
  await writeFile(episode, JSON.stringify(ep([{ text: 'Ok', characters: [{ id: 'MISSING_CHAR', version: 'v1' }] }])));
  await draw({ promptFile: prompt, workDir: join(root, 'character'), character: true, slide: undefined, request });
  assert.equal(calls, 2);
  // Slide mode fails when character snapshot is missing.
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'bad-char-slide'), slide: 1, request }), /episode_invalid/);
  assert.equal(calls, 2);
  await writeFile(episode, JSON.stringify(pages(36)));
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'bad-character'), character: true, slide: undefined, request }), /script_count/);
  assert.equal(calls, 2);
  assert.throws(() => execFileSync(process.execPath, [script, prompt, join(root, 'legacy')], { stdio: 'pipe' }));
});

test('drawBatch validates fingerprints before skipping, blocks unresolved retries until reconciled, and enforces limits', async t => {
  const { root, raw, prompt, episode } = await setup(t);
  const source = await readFile(raw);
  const { drawBatch, reconcileAttempt } = await import('../../scripts/draw-image.mjs' as string);
  await writeFile(episode, JSON.stringify(ep([{ text: '1' }, { text: '2' }, { text: '3' }])));
  const manifestFile = join(root, 'batch.json');
  await writeFile(manifestFile, JSON.stringify([
    { slide: 1, promptFile: prompt, workDir: join(root, 'd1'), references: [] },
    { slide: 2, promptFile: prompt, workDir: join(root, 'd2'), references: [] },
    { slide: 3, promptFile: prompt, workDir: join(root, 'd3'), references: [] },
  ]));
  let calls = 0;
  await assert.rejects(drawBatch({
    episodeFile: episode,
    manifestFile,
    request: async () => {
      calls++;
      if (calls === 2) throw new Error('network drop');
      return new Response(source);
    },
  }), /Batch stopped at slide 2/);
  assert.equal(calls, 2);

  // Attempting slide 2 with a new workDir d2-a2 BEFORE reconciling d2 (`unknown`) MUST be blocked!
  await writeFile(manifestFile, JSON.stringify([
    { slide: 1, promptFile: prompt, workDir: join(root, 'd1'), references: [] },
    { slide: 2, promptFile: prompt, workDir: join(root, 'd2-a2'), references: [] },
    { slide: 3, promptFile: prompt, workDir: join(root, 'd3'), references: [] },
  ]));
  await assert.rejects(drawBatch({
    episodeFile: episode,
    manifestFile,
    request: async () => { calls++; return new Response(source); },
  }), /Unresolved attempt/);
  assert.equal(calls, 2);

  // Explicitly reconcile d2 after verification; d2/status.json preserves audit history.
  const rec = await reconcileAttempt({ workDir: join(root, 'd2'), resolution: 'reconciled_failed', note: 'Checked 9Router: request dropped' });
  assert.equal(rec.previous_state, 'unknown');
  assert.equal(rec.state, 'reconciled_failed');

  const request = async () => { calls++; return new Response(source); };
  // Now resume skips verified d1 and completes d2-a2 and d3.
  const res = await drawBatch({
    episodeFile: episode,
    manifestFile,
    request,
  });
  assert.equal(calls, 4);
  assert.deepEqual(res.skipped, [1]);
  assert.deepEqual(res.completed.map((c: { slide: number }) => c.slide), [2, 3]);

  // Changing prompt or image bytes MUST refuse skipping d1.
  await writeFile(prompt, 'CHỮ ĐÃ THAY ĐỔI\n');
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /does not match current request fingerprint/);
  await writeFile(prompt, 'CHỮ CẦN IN\nGiữ nguyên chữ và dấu.\n');
  await writeFile(join(root, 'd1', 'image.jpg'), Buffer.from('corrupt'));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Expected a PNG or JPEG image|SHA-256/);

  // Reject duplicate slide in manifest and oversized manifest (> slides.length).
  await writeFile(manifestFile, JSON.stringify([
    { slide: 2, promptFile: prompt, workDir: join(root, 'dup1'), references: [] },
    { slide: 2, promptFile: prompt, workDir: join(root, 'dup2'), references: [] },
  ]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Duplicate slide 2/);

  await writeFile(manifestFile, JSON.stringify([
    { slide: 1, promptFile: prompt, workDir: join(root, 'x1'), references: [] },
    { slide: 2, promptFile: prompt, workDir: join(root, 'x2'), references: [] },
    { slide: 3, promptFile: prompt, workDir: join(root, 'x3'), references: [] },
    { slide: 1, promptFile: prompt, workDir: join(root, 'x4'), references: [] },
  ]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Too many batch entries/);

  // Reject symlink escape in promptFile or workDir.
  const outside = join(root, '..', 'outside-prompt.txt');
  await writeFile(outside, 'leak');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, 'sym-prompt.txt'));
  await writeFile(manifestFile, JSON.stringify([
    { slide: 2, promptFile: join(root, 'sym-prompt.txt'), workDir: join(root, 'sym-work'), references: [] },
  ]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Symlink is not allowed/);

  // Preflight blocks before calling API on earlier slides when a later entry is invalid/missing.
  await writeFile(manifestFile, JSON.stringify([
    { slide: 1, promptFile: prompt, workDir: join(root, 'p1'), references: [] },
    { slide: 2, promptFile: join(root, 'missing-prompt.txt'), workDir: join(root, 'p2'), references: [] },
  ]));
  await assert.rejects(drawBatch({
    episodeFile: episode,
    manifestFile,
    request: async () => { calls++; return new Response(source); },
  }), /ENOENT|missing/);
  assert.equal(calls, 4);
});

test('draw rejects oversized aggregate reference payloads before base64 encoding', async t => {
  const { root, prompt, episode } = await setup(t);
  const { MAX_TOTAL_REF_BYTES } = await import('../../scripts/lib/policy.mjs' as string);
  // Sanity check that policy sets aggregate cap well below 10 * 49MB = 490MB.
  assert.ok(MAX_TOTAL_REF_BYTES <= 100 * 1024 * 1024);

  const big = join(root, 'big.png');
  execFileSync('magick', ['-size', '3000x3000', 'plasma:fractal', big]);
  const bigStat = await readFile(big);
  const count = Math.ceil((MAX_TOTAL_REF_BYTES + 1) / bigStat.length);
  if (count <= 10) {
    const { draw } = await import('../../scripts/draw-image.mjs' as string);
    let calls = 0;
    await assert.rejects(draw({
      episodeFile: episode,
      slide: 1,
      promptFile: prompt,
      workDir: join(root, 'big-refs'),
      references: Array.from({ length: count }, () => big),
      request: async () => { calls++; return new Response(bigStat); },
    }), /Aggregate reference image payload/);
    assert.equal(calls, 0);
  }
});
