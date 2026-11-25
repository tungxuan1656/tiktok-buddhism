import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cli = (draft: string, output: string) => spawnSync(process.execPath,
  ['scripts/export-slide.mjs', draft, output], { encoding: 'utf8' });

async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'export-slide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const draft = join(root, 'image.jpg');
  const output = join(root, 'output', 'r01', '001.jpg');
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  await writeFile(draft, bytes);
  return { draft, output, bytes };
}

test('exports a checked draft once and reuses matching bytes without writing again', async t => {
  const { draft, output, bytes } = await setup(t);
  const first = cli(draft, output);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), 'exported');
  const before = await stat(output);
  assert.notEqual(before.ino, (await stat(draft)).ino);

  const second = cli(draft, output);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.trim(), 'reused');
  const after = await stat(output);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(await readFile(output), bytes);
  assert.deepEqual(await readdir(dirname(output)), ['001.jpg']);
});

test('exports, verifies SHA-256 and writes a checkpoint in one invocation, including on recovery', async t => {
  const { draft, output, bytes } = await setup(t);
  const note = 'Đã đối chiếu chữ, dấu, nhân vật và bố cục.';
  const checked = () => spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', draft, output, note], { encoding: 'utf8' });
  assert.equal(cli(draft, output).status, 0); // Recover an export interrupted before its checkpoint.
  const result = checked();
  assert.equal(result.status, 0, result.stderr);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const checkpoint = join(dirname(output), 'checks', '001.jpg.json');
  assert.deepEqual(JSON.parse(result.stdout), { state: 'reused', output, checkpoint, sha256 });
  const saved = await readFile(checkpoint, 'utf8');
  assert.deepEqual(JSON.parse(saved), { image: '001.jpg', draft: '../../image.jpg', sha256, visual_check: note });
  assert.equal(checked().status, 0);
  await writeFile(output, Buffer.from('different bytes'));
  assert.equal(checked().status, 1);
  assert.equal(await readFile(checkpoint, 'utf8'), saved);
});

test('refuses different bytes and a symlink without overwriting either', async t => {
  const { draft, output, bytes } = await setup(t);
  assert.equal(cli(draft, output).status, 0);
  const other = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
  await writeFile(output, other);
  const conflict = cli(draft, output);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /does not match the draft/);
  assert.deepEqual(await readFile(output), other);

  const alias = join(dirname(output), '002.jpg');
  await symlink(draft, alias);
  assert.equal(cli(draft, alias).status, 1);
  assert.deepEqual(await readFile(draft), bytes);
});

test('binds v2 checkpoint to episode content, rejects untracked/unknown/stale drafts, and supports carry-forward', async t => {
  const root = await mkdtemp(join(tmpdir(), 'export-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'drafts', '001-r01-a1'), { recursive: true });
  await mkdir(join(root, 'drafts', '002-r01-a1'), { recursive: true });
  const d1 = join(root, 'drafts', '001-r01-a1', 'image.jpg');
  const d2 = join(root, 'drafts', '002-r01-a1', 'image.jpg');
  execFileSync('magick', ['-size', '1080x1440', 'xc:white', '-quality', '95', d1]);
  execFileSync('magick', ['-size', '1080x1440', 'xc:ivory', '-quality', '95', d2]);
  const b1 = await readFile(d1);
  const h1 = createHash('sha256').update(b1).digest('hex');

  const epPath = join(root, 'episode.json');
  await writeFile(epPath, JSON.stringify({
    mode: 'original',
    slides: [
      { text: 'Slide 1', scene: 'Cảnh 1', scene_type: 'concept', characters: [] },
      { text: 'Slide 2', scene: 'Cảnh 2', scene_type: 'concept', characters: [] },
    ],
  }));
  const { validateEpisodeData } = await import('../../scripts/lib/schema.mjs' as string);
  const val = await validateEpisodeData(JSON.parse(await readFile(epPath, 'utf8')), root, { stage: 'finalize' });

  // 1. Untracked draft (missing status.json) must fail!
  const untracked = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(untracked.status, 1);
  assert.match(untracked.stderr, /missing required status\.json/);

  // 2. Draft in `unknown` state must fail!
  await writeFile(join(root, 'drafts', '001-r01-a1', 'status.json'), JSON.stringify({
    state: 'unknown',
    plan: { file: epPath, slide: 1, character: false },
    slide_content_sha256: val.slideFingerprints[0],
    request_sha256: 'a'.repeat(64),
    output: { sha256: h1 },
  }));
  const unknownDraft = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(unknownDraft.status, 1);
  assert.match(unknownDraft.stderr, /expected "succeeded"/);

  // 3. Draft missing request_sha256 must fail!
  await writeFile(join(root, 'drafts', '001-r01-a1', 'status.json'), JSON.stringify({
    state: 'succeeded',
    plan: { file: epPath, slide: 1, character: false },
    slide_content_sha256: val.slideFingerprints[0],
    output: { sha256: h1 },
  }));
  const noReqHash = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(noReqHash.status, 1);
  assert.match(noReqHash.stderr, /missing valid request_sha256/);

  // 4. Stale slide fingerprint must fail!
  await writeFile(join(root, 'drafts', '001-r01-a1', 'status.json'), JSON.stringify({
    state: 'succeeded',
    plan: { file: epPath, slide: 1, character: false },
    slide_content_sha256: '0'.repeat(64),
    request_sha256: 'a'.repeat(64),
    output: { sha256: h1 },
  }));
  const staleRes = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(staleRes.status, 1);
  assert.match(staleRes.stderr, /missing or stale/);

  // 5. Wrong slide draft (slide 2 exported as 001.jpg) must fail!
  await writeFile(join(root, 'drafts', '002-r01-a1', 'status.json'), JSON.stringify({ state: 'succeeded', plan: { file: epPath, slide: 2, character: false } }));
  const wrongSlide = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d2, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(wrongSlide.status, 1);
  assert.match(wrongSlide.stderr, /belongs to slide 2/);

  // 6. Valid export produces bound schema_version 2 checkpoint.
  await writeFile(join(root, 'drafts', '001-r01-a1', 'status.json'), JSON.stringify({
    state: 'succeeded',
    plan: { file: epPath, slide: 1, character: false },
    slide_content_sha256: val.slideFingerprints[0],
    request_sha256: 'a'.repeat(64),
    output: { sha256: h1 },
  }));
  const draftBytes = await readFile(d1);
  await writeFile(d1, await readFile(d2));
  const mismatched = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /image SHA-256 mismatch/);
  await writeFile(d1, draftBytes);
  const outR1 = join(root, 'output', 'r01', '001.jpg');
  const ok = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, outR1, 'Đã kiểm tra'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const ck = JSON.parse(await readFile(join(root, 'output', 'r01', 'checks', '001.jpg.json'), 'utf8'));
  assert.equal(ck.schema_version, 2);
  assert.equal(ck.revision, 'r01');
  assert.equal(ck.slide, 1);
  assert.equal(ck.request_sha256, 'a'.repeat(64));
  assert.equal(ck.image_sha256, ck.sha256);
  assert.ok(ck.slide_content_sha256);
  assert.equal(ck.visual_check.passed, true);

  // 7. Carry-forward unchanged slide 1 from r01 to r02 succeeds, and fails if slide 1 text changes!
  const outR2 = join(root, 'output', 'r02', '001.jpg');
  const cfOk = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', '--carry-forward', outR1, outR2, 'Giữ nguyên từ r01'], { encoding: 'utf8' });
  assert.equal(cfOk.status, 0, cfOk.stderr);
  const ckR2 = JSON.parse(await readFile(join(root, 'output', 'r02', 'checks', '001.jpg.json'), 'utf8'));
  assert.equal(ckR2.revision, 'r02');
  assert.equal(ckR2.request_sha256, 'a'.repeat(64));
  assert.equal(ckR2.carried_from.revision, 'r01');

  const epChanged = JSON.parse(await readFile(epPath, 'utf8'));
  epChanged.slides[0].text = 'Slide 1 đã đổi!';
  await writeFile(epPath, JSON.stringify(epChanged));
  const cfStale = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', '--carry-forward', outR1, join(root, 'output', 'r03', '001.jpg'), 'fail'], { encoding: 'utf8' });
  assert.equal(cfStale.status, 1);
  assert.match(cfStale.stderr, /Cannot carry forward slide 1/);
});


test('explicit import of a legacy snapshot does not invent a request hash and can be carried forward', async t => {
  const root = await mkdtemp(join(tmpdir(), 'export-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'output', 'r01', '001.jpg');
  const r02 = join(root, 'output', 'r02', '001.jpg');
  const r03 = join(root, 'output', 'r03', '001.jpg');
  await mkdir(dirname(source), { recursive: true });
  execFileSync('magick', ['-size', '1080x1440', 'xc:white', source]);
  const episode = { mode: 'original', revision: 'r01', status: 'ready_for_review',
    slides: [{ text: 'Một câu.', scene: 'Cảnh', scene_type: 'concept', image: 'output/r01/001.jpg' }] };
  const episodePath = join(root, 'episode.json');
  await writeFile(episodePath, JSON.stringify(episode));
  await writeFile(join(dirname(source), 'episode.json'), JSON.stringify(episode));
  const checked = (option: string, from: string, to: string) => spawnSync(process.execPath,
    ['scripts/export-slide.mjs', '--checked', option, from, to, 'Đã xem lại và đối chiếu'], { encoding: 'utf8' });
  assert.equal(checked('--carry-forward', source, r02).status, 1);
  await writeFile(episodePath, JSON.stringify({ ...episode, slides: [{ ...episode.slides[0], text: 'Nội dung đã sửa.' }] }));
  assert.match(checked('--import-legacy', source, r02).stderr, /content changed/);
  await writeFile(episodePath, JSON.stringify(episode));
  const imported = checked('--import-legacy', source, r02);
  assert.equal(imported.status, 0, imported.stderr);
  const ck = JSON.parse(await readFile(join(dirname(r02), 'checks', '001.jpg.json'), 'utf8'));
  assert.equal(ck.request_sha256, null);
  assert.equal(ck.legacy_import.revision, 'r01');
  const { finalizeEpisode } = await import('../../scripts/episode-tools.mjs' as string);
  assert.equal((await finalizeEpisode(root, { revision: 'r02' })).ok, true);
  const r02Bytes = await readFile(r02);
  execFileSync('magick', ['-size', '1080x1440', 'xc:black', r02]);
  assert.match(checked('--carry-forward', r02, r03).stderr, /SHA-256 mismatch/);
  assert.match(checked('--import-legacy', r02, r03).stderr, /already has a bound checkpoint/);
  await writeFile(r02, r02Bytes);
  const reuse = checked('--carry-forward', r02, r03);
  assert.equal(reuse.status, 0, reuse.stderr);
  assert.deepEqual(await readFile(r03), await readFile(source));
  assert.equal((await finalizeEpisode(root, { revision: 'r03' })).ok, true);
  const approved = { ...JSON.parse(await readFile(episodePath, 'utf8')), status: 'approved' };
  await writeFile(episodePath, JSON.stringify(approved));
  await assert.rejects(finalizeEpisode(root, { revision: 'r02' }), /Cannot finalize older revision/);
  assert.deepEqual(JSON.parse(await readFile(episodePath, 'utf8')), approved);
});
