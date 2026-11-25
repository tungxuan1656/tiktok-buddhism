import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

const fpPromise = import('../../scripts/lib/fingerprint.mjs' as string);
const schemaPromise = import('../../scripts/lib/schema.mjs' as string);

const script = resolve('scripts/draw-image.mjs');
const ep = (slides: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  mode: 'original',
  slides: slides.map(s => ({ scene: 'Cảnh tĩnh', scene_type: 'concept', characters: [], ...s })),
  ...extra,
});

async function writePromptWithMeta(episodeDir: string, promptPath: string, slide: number, text: string, styleRefPath?: string) {
  const { computePromptInputFingerprint, sha256Bytes } = await fpPromise;
  const { validateEpisodeData } = await schemaPromise;
  await writeFile(promptPath, text);
  const epData = JSON.parse(await readFile(join(episodeDir, 'episode.json'), 'utf8'));
  const val = await validateEpisodeData(epData, episodeDir, { stage: 'draw' });
  const promptSha = sha256Bytes(Buffer.from(text, 'utf8'));
  const styleSha = sha256Bytes(await readFile(styleRefPath ?? join(episodeDir, 'source.png')));
  const metaPath = promptPath.endsWith('.txt') ? `${promptPath.slice(0, -4)}.meta.json` : `${promptPath}.meta.json`;
  await writeFile(metaPath, JSON.stringify({
    schema_version: 1,
    revision: 'r01',
    slide,
    input_sha256: computePromptInputFingerprint({ slideContentSha256: val.slideFingerprints[slide - 1], styleRefSha256: styleSha }),
    slide_content_sha256: val.slideFingerprints[slide - 1],
    prompt_sha256: promptSha,
    style_ref_sha256: styleSha,
    override: false,
  }, null, 2));
}

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'draw-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = join(root, 'source.png');
  const prompt = join(root, 'prompt.txt');
  execFileSync('magick', ['-size', '1024x1536', 'gradient:white-wheat', raw]);
  const episode = join(root, 'episode.json');
  await writeFile(episode, JSON.stringify(ep([{ text: 'Giữ nguyên chữ và dấu.' }])));
  await writePromptWithMeta(root, prompt, 1, 'CHỮ CẦN IN\nGiữ nguyên chữ và dấu.\n', raw);
  const mod = await import('../../scripts/draw-image.mjs' as string);
  const draw = (options: Record<string, unknown>) => mod.draw({ episodeFile: episode, slide: 1, references: [raw], ...options });
  const status = async (work: string) => JSON.parse(await readFile(join(work, 'status.json'), 'utf8'));
  return { root, raw, prompt, draw, status, episode, mod };
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
  const work = join(root, 'drafts', '001-r01-a1');
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
  assert.ok(st.plan);
  assert.equal(st.plan.slide, 1);
  assert.equal(st.source.mime, 'image/png');
  assert.ok(st.output.sha256);
  await assert.rejects(draw({ promptFile: prompt, workDir: work }), { code: 'EEXIST' });
  assert.equal(calls, 1);
});

test('normalize-only CLI reuses existing bytes without an API call and preserves request provenance on recovery', async t => {
  const { root, raw, prompt, draw, status } = await setup(t);
  const work = join(root, 'local');
  execFileSync(process.execPath, [script, '--normalize', raw, work]);
  assert.equal((await status(work)).state, 'succeeded');
  assert.deepEqual(await readFile(join(work, 'response.bin')), await readFile(raw));
  assert.ok(!(await readdir(work)).includes('request.json'));
  assert.throws(() => execFileSync(process.execPath, [script, '--normalize', raw, work], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }));

  const draft = join(root, 'drafts', '001-r01-a1');
  const original = await draw({ promptFile: prompt, workDir: draft, request: async () => new Response(await readFile(raw)) });
  const saved = await status(draft);
  const source = join(draft, 'response.bin');
  await writeFile(join(draft, 'status.json'), JSON.stringify({ ...saved, state: 'received', output: undefined }));
  await rm(original);
  const unrelated = join(draft, 'unrelated.png');
  await writeFile(unrelated, await readFile(raw));
  const local = join(root, 'converted');
  execFileSync(process.execPath, [script, '--normalize', unrelated, local]);
  assert.equal((await status(local)).request_sha256, undefined);
  const exportAttempt = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', join(local, 'image.jpg'), join(root, 'output', 'r01', '001.jpg'), 'Checked'], { encoding: 'utf8' });
  assert.equal(exportAttempt.status, 1);
  await writeFile(source, 'different raw response');
  assert.throws(() => execFileSync(process.execPath, [script, '--normalize', source], { stdio: 'pipe' }), /Recorded response SHA-256 mismatch/);
  await writeFile(source, await readFile(raw));
  execFileSync(process.execPath, [script, '--normalize', source]);
  const recSt = await status(draft);
  assert.equal(recSt.state, 'succeeded');
  assert.equal(recSt.plan.slide, 1);
  assert.equal(recSt.request_sha256, saved.request_sha256);
  assert.equal(recSt.response_sha256, saved.response_sha256);
  assert.equal(recSt.output.sha256, saved.output.sha256);
});

test('API and conversion errors (401, 503, oversized, interrupted stream) have durable safe states, with no automatic retry', async t => {
  const { root, draw, status, episode } = await setup(t);
  const slides = Array.from({ length: 6 }, (_, idx) => ({ text: `Câu ${idx + 1}.` }));
  await writeFile(episode, JSON.stringify(ep(slides)));
  const cases = [
    { expected: 'unknown', request: async () => { throw new Error('EXAMPLE_PRIVATE_KEY'); } },
    { expected: 'failed', request: async () => new Response('EXAMPLE_PRIVATE_KEY', { status: 401 }) },
    { expected: 'unknown', request: async () => new Response('unavailable', { status: 503 }) },
    { expected: 'normalize_failed', request: async () => new Response('{"error":"not an image"}') },
    { expected: 'unknown', request: async () => new Response('too big', { headers: { 'content-length': '49000001' } }) },
    { expected: 'unknown', request: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')); } })) },
  ];
  for (let i = 0; i < cases.length; i++) {
    const slide = i + 1;
    const pFile = join(root, `p-${slide}.txt`);
    await writePromptWithMeta(root, pFile, slide, `Prompt ${slide}`);
    let calls = 0;
    const work = join(root, 'drafts', `00${slide}-r01-a1`);
    await assert.rejects(draw({ slide, promptFile: pFile, workDir: work, request: async () => { calls++; return cases[i].request(); } }), (error: Error) => !error.message.includes('EXAMPLE_PRIVATE_KEY'));
    assert.equal(calls, 1);
    const saved = await status(work);
    assert.equal(saved.state, cases[i].expected);
    assert.ok(saved.plan);
    assert.ok(saved.request_sha256);
    assert.ok(!JSON.stringify(saved).includes('EXAMPLE_PRIVATE_KEY'));
    assert.ok(await readFile(join(work, 'request.json')));
  }
  const invalid = join(root, 'drafts', '001-r01-invalid');
  await assert.rejects(draw({ promptFile: join(root, 'missing'), workDir: invalid, request: () => { throw new Error('must not call'); } }));
});

test('direct --slide rejects stale/untracked prompts, enforces attempt budget on succeeded drafts, and blocks concurrent duplicates', async t => {
  const { root, raw, prompt, draw, episode } = await setup(t);
  const source = await readFile(raw);
  let calls = 0;

  // Stale prompt after editing episode.json must perform zero POSTs.
  await writeFile(episode, JSON.stringify(ep([{ text: 'Nội dung đã đổi!' }])));
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a1'), request: async () => { calls++; return new Response(source); } }), /Stale prompt/);
  assert.equal(calls, 0);

  // Untracked prompt without .meta.json must perform zero POSTs.
  const untracked = join(root, 'untracked.txt');
  await writeFile(untracked, 'Untracked');
  await assert.rejects(draw({ promptFile: untracked, workDir: join(root, 'drafts', '001-r01-a1'), request: async () => { calls++; return new Response(source); } }), /Missing prompt provenance/);
  assert.equal(calls, 0);

  // Restore matching prompt provenance.
  await writePromptWithMeta(root, prompt, 1, 'CHỮ CẦN IN\nGiữ nguyên chữ và dấu.\n');

  // Concurrent draws for the same logical job produce at most ONE POST!
  const slowRequest = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 80));
    return new Response(source);
  };
  const [r1, r2] = await Promise.allSettled([
    draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a1'), request: slowRequest }),
    draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a2'), request: slowRequest }),
  ]);
  assert.equal(calls, 1);
  assert.equal([r1, r2].filter(r => r.status === 'fulfilled').length, 1);
  assert.equal([r1, r2].filter(r => r.status === 'rejected').length, 1);

  // Alternate parent directory outside drafts/ is rejected (cannot bypass attempt history).
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'other-drafts', '001-r01-a2'), request: async () => { calls++; return new Response(source); } }), /directly under episode drafts/);
  assert.equal(calls, 1);

  // A second draw may finish preflight after the first succeeds (not just while in flight).
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a3'), request: slowRequest }), /Identical request already succeeded/);
  assert.equal(calls, 1);
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-R01-a3'), request: slowRequest }), /must follow NNN-rNN/);

  const okRequest = async () => { calls++; return new Response(source); };
  await draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a3'), request: okRequest, allowRepeat: true });
  await draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a4'), request: okRequest, allowRepeat: true });
  assert.equal(calls, 3);
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r001-a5'), request: okRequest, allowRepeat: true }), /Attempt limit \(3\) reached/);
  assert.equal(calls, 3);
});

test('canonical attempt history refuses aliases after an unknown response and refuses malformed registered state', async t => {
  const { root, raw, prompt, draw, episode } = await setup(t);
  const a1 = join(root, 'drafts', '001-r01-a1');
  await assert.rejects(draw({ promptFile: prompt, workDir: a1, request: async () => { throw new Error('mock disconnect'); } }), /unknown/);
  const alias = join(root, 'alias');
  await symlink(root, alias);
  assert.equal(await realpath(join(alias, 'episode.json')), await realpath(episode));
  let calls = 0;
  const options = { episodeFile: join(alias, 'episode.json'), workDir: join(alias, 'drafts', '001-r01-a2'), promptFile: prompt,
    request: async () => { calls++; return new Response(await readFile(raw)); } };
  await assert.rejects(draw(options), /Unresolved attempt/);
  await writeFile(join(a1, 'status.json'), '{}');
  await assert.rejects(draw(options), /Corrupted attempt metadata/);
  assert.equal(calls, 0);
});

test('a legacy local conversion does not block new draws or excuse broken API metadata', async t => {
  const { root, raw, prompt, draw } = await setup(t);
  const legacy = join(root, 'drafts', '001-r01-local-fix');
  const statusPath = join(legacy, 'status.json');
  const source = await readFile(raw);
  const converted = {
    state: 'succeeded',
    source: { mime: 'image/png', width: 1024, height: 1536, bytes: source.length },
    output: { file: 'image.jpg', mime: 'image/jpeg', width: 1080, height: 1440, bytes: 100, quality: 95, sampling: '4:4:4' },
  };
  await mkdir(legacy, { recursive: true });
  let calls = 0;
  const request = async () => { calls++; return new Response(source); };
  const options = { promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a1'), request };

  await writeFile(statusPath, JSON.stringify({ ...converted, http_status: 200 }));
  await assert.rejects(draw(options), /Corrupted attempt metadata/);
  await writeFile(statusPath, JSON.stringify(converted));
  const references = join(legacy, 'references.json');
  await writeFile(references, '[]');
  await assert.rejects(draw(options), /Corrupted attempt metadata/);
  assert.equal(calls, 0);

  await rm(references);
  const originalStatus = await readFile(statusPath);
  assert.equal(await draw(options), join(options.workDir, 'image.jpg'));
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(statusPath), originalStatus);
});

test('episode lock survives no stale owner after SIGKILL, and reconcile cannot race a live POST', async t => {
  const { root, raw, prompt, draw, mod } = await setup(t);
  const { withEpisodeLock } = await import('../../scripts/lib/lock.mjs' as string);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withEpisodeLock } from './scripts/lib/lock.mjs';
    await withEpisodeLock(process.argv[1], () => new Promise(() => {
      process.stdout.write('held');
      setInterval(() => {}, 1000);
    }));`, root]);
  t.after(() => child.kill());
  const ready = await Promise.race([once(child.stdout!, 'data').then(([data]) => String(data)), once(child, 'exit').then(() => 'exited')]);
  assert.equal(ready, 'held');
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  assert.equal(await withEpisodeLock(root, () => 'recovered', { timeoutMs: 200 }), 'recovered');
  const orphan = await mkdtemp(join(root, '.register-'));
  await writeFile(join(orphan, 'status.json'), JSON.stringify({ state: 'in_flight' }));

  let release!: () => void;
  let posted!: () => void;
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const postedPromise = new Promise<void>(resolve => { posted = resolve; });
  const workDir = join(root, 'drafts', '001-r01-a1');
  const running = draw({ workDir, promptFile: prompt, request: async () => {
    posted();
    await releasePromise;
    return new Response(await readFile(raw));
  } });
  try {
    await Promise.race([postedPromise, running]);
    await assert.rejects(mod.reconcileAttempt({ workDir, resolution: 'reconciled_failed', note: 'mock owner still active' }), /Timed out waiting for episode lock/);
  } finally {
    release();
    await running;
  }
});

test('crash after received state blocks new attempt until reconciled or normalized', async t => {
  const { root, raw, prompt, draw } = await setup(t);
  const source = await readFile(raw);
  const d1 = join(root, 'drafts', '001-r01-a1');
  await mkdir(d1, { recursive: true });
  // Simulate process crash right after writing received status.json.
  await writeFile(join(d1, 'request.json'), JSON.stringify({ plan: { file: episodePath(root), slide: 1, character: false } }));
  await writeFile(join(d1, 'status.json'), JSON.stringify({ state: 'received' }));
  let calls = 0;
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a2'), request: async () => { calls++; return new Response(source); } }), /Unresolved attempt/);
  assert.equal(calls, 0);
});

function episodePath(root: string) { return join(root, 'episode.json'); }

test('saved JSON and shared schema validation gate every API request, including characters; invalid scripts never POST', async t => {
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
    const workDir = join(root, 'drafts', `invalid-plan-${index}`);
    await assert.rejects(draw({ promptFile: prompt, workDir, request }), /script_invalid|script_count|slide_invalid|episode_invalid/);
    assert.equal((await status(workDir)).state, 'invalid_input');
    assert.equal(calls, 0);
  }
  await writeFile(episode, JSON.stringify(pages(35)));
  await writePromptWithMeta(root, prompt, 35, 'Prompt 35');
  for (const slide of [0, 36, 1.5, undefined]) {
    await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', `bad-index-${slide}`), slide, request }), /slide_invalid/);
  }
  assert.equal(calls, 0);
  await draw({ promptFile: prompt, workDir: join(root, 'drafts', '035-r01-a1'), slide: 35, request });
  await writeFile(episode, JSON.stringify(ep([{ text: 'Ok', characters: [{ id: 'MISSING_CHAR', version: 'v1' }] }])));
  await draw({ promptFile: prompt, workDir: join(root, 'drafts', 'char-missing-a1'), character: true, slide: undefined, request });
  assert.equal(calls, 2);
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', '001-r01-a1'), slide: 1, request }), /episode_invalid/);
  assert.equal(calls, 2);
  await writeFile(episode, JSON.stringify(pages(36)));
  await assert.rejects(draw({ promptFile: prompt, workDir: join(root, 'drafts', 'char-36-a1'), character: true, slide: undefined, request }), /script_count/);
  assert.equal(calls, 2);
  assert.throws(() => execFileSync(process.execPath, [script, prompt, join(root, 'legacy')], { stdio: 'pipe' }));
});

test('drawBatch validates fingerprints before skipping, blocks unresolved retries until reconciled, and enforces limits', async t => {
  const { root, raw, episode, mod } = await setup(t);
  const source = await readFile(raw);
  const { drawBatch, reconcileAttempt } = mod;
  const { buildPrompts } = await import('../../scripts/episode-tools.mjs' as string);
  await writeFile(episode, JSON.stringify(ep([{ text: '1' }, { text: '2' }, { text: '3' }])));
  const built = await buildPrompts(root, { revision: 'r01', styleRef: raw });
  const manifestFile = built.batchManifest;

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

  // Attempting slide 2 with a new attempt a2 BEFORE reconciling a1 (`unknown`) MUST be blocked!
  const builtA2 = await buildPrompts(root, { revision: 'r01', attempt: 'a2', slides: [1, 2, 3], styleRef: raw });
  const manifest = JSON.parse(await readFile(builtA2.batchManifest, 'utf8'));
  manifest[0].workDir = join(root, 'drafts', '001-r01-a1'); // Keep slide 1 pointing to succeeded a1
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  await assert.rejects(drawBatch({
    episodeFile: episode,
    manifestFile,
    request: async () => { calls++; return new Response(source); },
  }), /Unresolved attempt/);
  assert.equal(calls, 2);

  // Explicitly reconcile 002-r01-a1 after verification.
  const rec = await reconcileAttempt({ workDir: join(root, 'drafts', '002-r01-a1'), resolution: 'reconciled_failed', note: 'Checked 9Router: request dropped' });
  assert.equal(rec.previous_state, 'unknown');
  assert.equal(rec.state, 'reconciled_failed');

  const request = async () => { calls++; return new Response(source); };
  const res = await drawBatch({ episodeFile: episode, manifestFile, request });
  assert.equal(calls, 4);
  assert.deepEqual(res.skipped, [1]);
  assert.deepEqual(res.completed.map((c: { slide: number }) => c.slide), [2, 3]);
  const legacy = join(root, 'drafts', '001-r01');
  await mkdir(legacy);
  await writeFile(join(legacy, 'status.json'), JSON.stringify({ state: 'succeeded', plan: { file: episode, slide: 1, character: false } }));
  assert.deepEqual((await drawBatch({ episodeFile: episode, manifestFile, request })).skipped, [1, 2, 3]);

  // Manifest missing required fingerprints is rejected.
  const badManifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  delete badManifest[0].request_sha256;
  await writeFile(manifestFile, JSON.stringify(badManifest));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /manifest must include/);

  // Changing prompt or image bytes refuses skipping 001-r01-a1.
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(join(root, 'prompts', '001-r01.txt'), 'CHỮ ĐÃ THAY ĐỔI\n');
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /modified manually|stale manifest/);
  await buildPrompts(root, { revision: 'r01', force: true, styleRef: raw });
  await writeFile(join(root, 'drafts', '001-r01-a1', 'image.jpg'), Buffer.from('corrupt'));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Expected a PNG or JPEG image|SHA-256/);

  // Reject duplicate slide in manifest and oversized manifest (> slides.length).
  await writeFile(manifestFile, JSON.stringify([manifest[1], { ...manifest[1], workDir: join(root, 'drafts', '002-r01-a3') }]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Duplicate slide 2/);

  await writeFile(manifestFile, JSON.stringify([...manifest, { ...manifest[0], workDir: join(root, 'drafts', '001-r01-a3') }]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Too many batch entries/);

  // Reject symlink escape in promptFile.
  const outside = join(root, '..', 'outside-prompt.txt');
  await writeFile(outside, 'leak');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, 'prompts', 'sym.txt'));
  await writeFile(manifestFile, JSON.stringify([{ ...manifest[1], promptFile: join(root, 'prompts', 'sym.txt'), workDir: join(root, 'drafts', '002-r01-a3') }]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /Symlink is not allowed/);

  // A fresh first job must not POST when a later entry has a missing promptFile.
  await writeFile(manifestFile, JSON.stringify([
    { ...manifest[0], workDir: join(root, 'drafts', '001-r02-a1') },
    { ...manifest[1], promptFile: join(root, 'prompts', 'missing.txt'), workDir: join(root, 'drafts', '002-r01-a3') },
  ]));
  await assert.rejects(drawBatch({ episodeFile: episode, manifestFile, request }), /ENOENT|missing/);
  assert.equal(calls, 4);
});

test('slide references must match the manifest and a batch never posts an updated override under an old request hash', async t => {
  const { root, raw, episode, draw, mod } = await setup(t);
  const { buildPrompts } = await import('../../scripts/episode-tools.mjs' as string);
  const charDir = join(root, 'references', 'TEST', 'v1');
  await mkdir(charDir, { recursive: true });
  const ref = join(charDir, 'ref.png');
  execFileSync('magick', ['-size', '10x10', 'xc:black', ref]);
  await writeFile(join(charDir, 'character.json'), JSON.stringify({ references: ['ref.png'] }));
  await writeFile(episode, JSON.stringify(ep([{ text: 'Một.' }, { text: 'Hai.', characters: [{ id: 'TEST', version: 'v1' }] }])));
  const { batchManifest } = await buildPrompts(root, { styleRef: raw });
  const [, item] = JSON.parse(await readFile(batchManifest, 'utf8'));
  let calls = 0;
  const request = async () => { calls++; return new Response(await readFile(raw)); };
  for (const references of [[], [raw], [raw, raw]]) {
    await assert.rejects(draw({ ...item, references, request }), /Reference mismatch/);
  }
  assert.equal(calls, 0);
  await assert.rejects(mod.drawBatch({ episodeFile: episode, manifestFile: batchManifest, request: async () => {
    const response = await request();
    await writeFile(item.promptFile, (await readFile(item.promptFile, 'utf8')) + '\nĐiều chỉnh bố cục.');
    await buildPrompts(root, { styleRef: raw, override: true });
    return response;
  } }), /request fingerprint changed before POST/);
  assert.equal(calls, 1);
});

test('draw always enforces aggregate reference payload cap without skipping assertions', async t => {
  const { root, raw, prompt, draw } = await setup(t);
  const rawBytes = await readFile(raw);
  assert.ok(rawBytes.length > 500);
  let calls = 0;
  await assert.rejects(draw({
    promptFile: prompt,
    workDir: join(root, 'drafts', '001-r01-a1'),
    references: [raw, raw],
    maxTotalRefBytes: rawBytes.length, // Strictly < 2 * rawBytes.length -> guaranteed execution!
    request: async () => { calls++; return new Response(rawBytes); },
  }), /Aggregate reference image payload/);
  assert.equal(calls, 0);
});
