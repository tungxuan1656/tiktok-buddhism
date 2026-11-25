import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const toolsPromise = import('../../scripts/episode-tools.mjs' as string);
const exportScript = join(process.cwd(), 'scripts', 'export-slide.mjs');

async function makeValidJpg(path: string, color = 'white') {
  execFileSync('magick', ['-size', '1080x1440', `xc:${color}`, '-quality', '95', path]);
  return readFile(path);
}

async function setupEpisode(t: test.TestContext, mode: 'original' | 'verbatim' = 'original') {
  const root = await mkdtemp(join(tmpdir(), 'ep-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const charDir = join(root, 'references', 'PHAT_01', 'v1');
  await mkdir(charDir, { recursive: true });
  await makeValidJpg(join(charDir, 'reference.jpg'), 'wheat');
  await writeFile(join(charDir, 'character.json'), JSON.stringify({
    id: 'PHAT_01',
    version: 'v1',
    identity: { face: 'hiền hòa', hair: 'tóc xoắn ốc', body: 'cân đối', clothing: 'y nâu đất' },
    keep: ['y nâu đất'],
    avoid: ['Không râu hoặc hào quang'],
    references: ['reference.jpg'],
  }));
  const ep = {
    title: 'Test',
    request: 'Req',
    mode,
    status: 'draft',
    source: mode === 'verbatim' ? { file: 'source.txt' } : null,
    slides: [
      { role: mode === 'verbatim' ? 'quote' : undefined, text: 'Câu một.', scene: 'Đứng tĩnh lặng bên đèn dầu', scene_type: 'concept', evidence: 'minh họa', characters: [{ id: 'PHAT_01', version: 'v1' }] },
      { role: mode === 'verbatim' ? 'quote' : undefined, text: 'Câu hai.', scene: 'Ngồi thiền', scene_type: 'event', evidence: 'minh họa', characters: [] },
    ],
  };
  await writeFile(join(root, 'episode.json'), JSON.stringify(ep, null, 2));
  if (mode === 'verbatim') await writeFile(join(root, 'source.txt'), 'Câu một.\nCâu hai.\n');
  return root;
}

test('validateEpisode enforces strict verbatim roles/spans, path confinement, and rejects implicit cover skip', async t => {
  const { validateEpisode } = await toolsPromise;
  const root = await setupEpisode(t, 'verbatim');
  const ok = await validateEpisode(root);
  assert.equal(ok.ok, true);
  assert.equal(ok.slideCount, 2);

  // Verbatim with explicit cover role + exact source_start/source_end bounds.
  await mkdir(join(root, 'sources'), { recursive: true });
  await writeFile(join(root, 'sources', 'body.txt'), 'Câu một.\nCâu hai.');
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { role: 'cover', text: 'TỰA BÀI\nTên sách', scene: 'Bìa sen', scene_type: 'concept', characters: [] },
      { role: 'quote', source_start: 0, source_end: 8, text: 'Câu một.', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
      { role: 'quote', source_start: 9, source_end: 17, text: 'Câu hai.', scene: 'Cảnh 2', scene_type: 'event', characters: [] },
    ],
  }));
  assert.equal((await validateEpisode(root)).ok, true);

  // Whitespace-collapsing tricks or off-by-one span must fail verbatim validation.
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { role: 'cover', text: 'TỰA BÀI', scene: 'Bìa sen', scene_type: 'concept', characters: [] },
      { role: 'quote', source_start: 0, source_end: 7, text: 'Câu một', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
      { role: 'quote', source_start: 9, source_end: 17, text: 'Câu hai.', scene: 'Cảnh 2', scene_type: 'event', characters: [] },
    ],
  }));
  const badSpan = await validateEpisode(root);
  assert.equal(badSpan.ok, false);

  // Without role or exact_join_first_slide, slide 1 is NOT silently treated as cover.
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { text: 'Bìa không khai báo role', scene: 'Bìa', scene_type: 'concept', characters: [] },
      { text: 'Câu một.\nCâu hai.', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
    ],
  }));
  const implicitCover = await validateEpisode(root);
  assert.equal(implicitCover.ok, false);

  // Path traversal and symlink escape are rejected.
  const outside = join(root, '..', 'outside-source.txt');
  await writeFile(outside, 'Câu một.\nCâu hai.');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, 'sources', 'escape.txt'));
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/escape.txt' },
    slides: [{ text: 'Câu một.\nCâu hai.', scene: 'Cảnh', scene_type: 'event', characters: [] }],
  }));
  const symlinkEscape = await validateEpisode(root);
  assert.equal(symlinkEscape.ok, false);

  // Unsafe character id and internal management text fail.
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'original',
    slides: [
      { text: 'Nguyên văn theo bản bạn cung cấp.', scene: 'Cảnh', scene_type: 'concept', characters: [{ id: '../PHAT', version: 'v1' }] },
    ],
  }));
  const badText = await validateEpisode(root);
  assert.equal(badText.ok, false);
  assert.ok(badText.issues.some((i: string) => i.includes('internal/management text')));
  assert.ok(badText.issues.some((i: string) => i.includes('invalid character reference')));
});

test('buildPrompts rejects stale prompts on episode/reference changes and enforces explicit override', async t => {
  const { buildPrompts, parseSlidesSpec } = await toolsPromise;
  const root = await setupEpisode(t);
  const res1 = await buildPrompts(root, { revision: 'r01' });
  assert.equal(res1.generated, 2);
  assert.equal(res1.skipped, 0);
  const p1 = await readFile(join(root, 'prompts', '001-r01.txt'), 'utf8');
  assert.ok(p1.includes('Câu một.'));
  assert.ok(p1.includes('PHAT_01/v1'));
  assert.ok(p1.includes('Tránh: Không râu hoặc hào quang.'));
  assert.ok(p1.includes('44–52 px'));
  assert.ok(!p1.includes('Vật thể được phép: không có'));
  const manifest = JSON.parse(await readFile(res1.batchManifest, 'utf8'));
  assert.equal(manifest.length, 2);
  assert.equal(manifest[0].references.length, 2);
  assert.ok(manifest[0].slide_content_sha256);
  assert.ok(manifest[0].request_sha256);
  assert.ok(isAbsolute(manifest[0].references[0]));

  // Manual prompt edit without --override fails, with --override succeeds.
  await writeFile(join(root, 'prompts', '001-r01.txt'), 'CUSTOM PROMPT');
  await assert.rejects(buildPrompts(root, { revision: 'r01' }), /modified manually/);
  const ov = await buildPrompts(root, { revision: 'r01', override: true });
  assert.equal(ov.skipped, 2);
  assert.equal(await readFile(join(root, 'prompts', '001-r01.txt'), 'utf8'), 'CUSTOM PROMPT');

  // Changing episode.json invalidates even overridden prompt unless --force is passed!
  const ep = JSON.parse(await readFile(join(root, 'episode.json'), 'utf8'));
  ep.slides[0].text = 'Hãy giữ tâm tỉnh thức.';
  ep.slides[0].objects = 'Đèn dầu nhỏ';
  ep.slides[1].objects = ['Bát đất', 'Chiếu mộc'];
  await writeFile(join(root, 'episode.json'), JSON.stringify(ep, null, 2));
  await assert.rejects(buildPrompts(root, { revision: 'r01' }), /Stale prompt/);
  await assert.rejects(buildPrompts(root, { revision: 'r01', override: true }), /Stale prompt/);

  await buildPrompts(root, { revision: 'r01', attempt: 'a2', slides: parseSlidesSpec('1-2', 2), force: true });
  const p1Forced = await readFile(join(root, 'prompts', '001-r01.txt'), 'utf8');
  const p2Forced = await readFile(join(root, 'prompts', '002-r01.txt'), 'utf8');
  assert.ok(p1Forced.includes('Hãy giữ tâm tỉnh thức.'));
  assert.ok(p1Forced.includes('Vật thể được phép: Đèn dầu nhỏ.'));
  assert.ok(p2Forced.includes('Vật thể được phép: Bát đất, Chiếu mộc.'));

  assert.throws(() => parseSlidesSpec('1,abc', 2), /Invalid slide number/);
  assert.throws(() => parseSlidesSpec('1-3', 2), /out of 1-2/);
});

test('finalizeEpisode verifies bound checkpoints and image validity, rejects stale checks, and prevents overwriting snapshots', async t => {
  const { episodeStatus, finalizeEpisode } = await toolsPromise;
  const root = await setupEpisode(t);
  await mkdir(join(root, 'drafts', '001-r01-a2'), { recursive: true });
  await mkdir(join(root, 'drafts', '001-r01-a10'), { recursive: true });
  await writeFile(join(root, 'drafts', '001-r01-a2', 'status.json'), JSON.stringify({ state: 'failed' }));
  await writeFile(join(root, 'drafts', '001-r01-a10', 'status.json'), JSON.stringify({ state: 'succeeded' }));

  const d1 = join(root, 'drafts', '001-r01-a10', 'image.jpg');
  const d2Dir = join(root, 'drafts', '002-r01-a1');
  await mkdir(d2Dir, { recursive: true });
  const d2 = join(d2Dir, 'image.jpg');
  await makeValidJpg(d1, 'white');
  await makeValidJpg(d2, 'ivory');

  const outDir = join(root, 'output', 'r01');
  execFileSync(process.execPath, [exportScript, '--checked', d1, join(outDir, '001.jpg'), 'Slide 1 ok']);

  // Slide 2 exported without --checked yet.
  execFileSync(process.execPath, [exportScript, d2, join(outDir, '002.jpg')]);
  const stBefore = await episodeStatus(root, { revision: 'r01' });
  assert.equal(stBefore.slides[0].checkState, 'verified');
  assert.equal(stBefore.slides[1].exportState, 'verified');
  assert.equal(stBefore.slides[1].checkState, 'missing');
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Missing check checkpoint for slide 2/);

  // Export slide 2 with --checked.
  execFileSync(process.execPath, [exportScript, '--checked', d2, join(outDir, '002.jpg'), 'Slide 2 ok']);

  // Tampering episode.json text after visual check MUST make checkpoint stale and block finalize!
  const epOrig = await readFile(join(root, 'episode.json'), 'utf8');
  const epMutated = JSON.parse(epOrig);
  epMutated.slides[0].text = 'Nội dung B đã sửa sau khi check!';
  await writeFile(join(root, 'episode.json'), JSON.stringify(epMutated, null, 2));
  const stStale = await episodeStatus(root, { revision: 'r01' });
  assert.equal(stStale.slides[0].checkState, 'stale');
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Stale visual check for slide 1/);

  // Restore original episode.json -> finalize succeeds.
  await writeFile(join(root, 'episode.json'), epOrig);
  const fin = await finalizeEpisode(root, { revision: 'r01' });
  assert.equal(fin.ok, true);
  assert.equal(fin.status, 'ready_for_review');
  assert.deepEqual(fin.files, ['output/r01/001.jpg', 'output/r01/002.jpg']);

  // Reconcile/idempotent repeat works; modifying episode and re-finalizing same r01 is rejected!
  const idem = await finalizeEpisode(root, { revision: 'r01' });
  assert.equal(idem.idempotent, true);

  await writeFile(join(root, 'episode.json'), JSON.stringify(epMutated, null, 2));
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Stale visual check|already exists/);

  // Non-image file placed as output fails image verification even if hash matches check.
  await writeFile(join(root, 'episode.json'), epOrig);
  const fakeBytes = Buffer.from('not-an-image');
  await writeFile(join(outDir, '001.jpg'), fakeBytes);
  const fakeHash = createHash('sha256').update(fakeBytes).digest('hex');
  const ck1 = JSON.parse(await readFile(join(outDir, 'checks', '001.jpg.json'), 'utf8'));
  ck1.sha256 = fakeHash;
  ck1.image_sha256 = fakeHash;
  await writeFile(join(outDir, 'checks', '001.jpg.json'), JSON.stringify(ck1));
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Expected a PNG or JPEG image/);
});
