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

test('validateEpisode enforces strict verbatim roles/spans, rejects non-whitespace prefixes, and blocks symlink escapes', async t => {
  const { validateEpisode } = await toolsPromise;
  const root = await setupEpisode(t, 'verbatim');
  const ok = await validateEpisode(root);
  assert.equal(ok.ok, true);
  assert.equal(ok.slideCount, 2);

  // Verbatim with explicit cover role + exact source_start/source_end bounds.
  await mkdir(join(root, 'sources'), { recursive: true });
  await writeFile(join(root, 'sources', 'body.txt'), 'Không sát sinh. Không trộm cắp.');
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { role: 'cover', text: 'TỰA BÀI\nTên sách', scene: 'Bìa sen', scene_type: 'concept', characters: [] },
      { role: 'quote', source_start: 0, source_end: 15, text: 'Không sát sinh.', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
      { role: 'quote', source_start: 16, source_end: 31, text: 'Không trộm cắp.', scene: 'Cảnh 2', scene_type: 'event', characters: [] },
    ],
  }));
  assert.equal((await validateEpisode(root)).ok, true);

  // Non-whitespace exact_join_prefixes (hiding an omitted sentence) MUST be rejected!
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt', exact_join_prefixes: ['Không sát sinh. '] },
    slides: [
      { role: 'quote', text: 'Không trộm cắp.', scene: 'Cảnh', scene_type: 'concept', characters: [] },
    ],
  }));
  const omittedSentence = await validateEpisode(root);
  assert.equal(omittedSentence.ok, false);

  // Off-by-one span must fail verbatim validation.
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { role: 'cover', text: 'TỰA BÀI', scene: 'Bìa sen', scene_type: 'concept', characters: [] },
      { role: 'quote', source_start: 0, source_end: 14, text: 'Không sát sinh', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
      { role: 'quote', source_start: 16, source_end: 31, text: 'Không trộm cắp.', scene: 'Cảnh 2', scene_type: 'event', characters: [] },
    ],
  }));
  assert.equal((await validateEpisode(root)).ok, false);

  // Without role or exact_join_first_slide, slide 1 is NOT silently treated as cover.
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { text: 'Bìa không khai báo role', scene: 'Bìa', scene_type: 'concept', characters: [] },
      { text: 'Không sát sinh. Không trộm cắp.', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
    ],
  }));
  assert.equal((await validateEpisode(root)).ok, false);

  // Symlink escape is rejected.
  const outside = join(root, '..', 'outside-source.txt');
  await writeFile(outside, 'Không sát sinh. Không trộm cắp.');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, 'sources', 'escape.txt'));
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/escape.txt' },
    slides: [{ text: 'Không sát sinh. Không trộm cắp.', scene: 'Cảnh', scene_type: 'event', characters: [] }],
  }));
  assert.equal((await validateEpisode(root)).ok, false);

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

  await writeFile(join(root, 'prompts', '001-r01.txt'), 'CUSTOM PROMPT');
  await assert.rejects(buildPrompts(root, { revision: 'r01' }), /modified manually/);
  const ov = await buildPrompts(root, { revision: 'r01', override: true });
  assert.equal(ov.skipped, 2);
  assert.equal(await readFile(join(root, 'prompts', '001-r01.txt'), 'utf8'), 'CUSTOM PROMPT');

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

test('finalizeEpisode enforces provenance, handles concurrent finalize safely, and prevents overwriting snapshots', async t => {
  const { episodeStatus, finalizeEpisode, validateEpisode } = await toolsPromise;
  const root = await setupEpisode(t);
  const val = await validateEpisode(root);
  const epPath = join(root, 'episode.json');

  await mkdir(join(root, 'drafts', '001-r01-a2'), { recursive: true });
  await mkdir(join(root, 'drafts', '001-r01-a10'), { recursive: true });
  await mkdir(join(root, 'drafts', '002-r01-a1'), { recursive: true });
  await writeFile(join(root, 'drafts', '001-r01-a2', 'status.json'), JSON.stringify({ state: 'failed' }));

  const d1 = join(root, 'drafts', '001-r01-a10', 'image.jpg');
  const d2 = join(root, 'drafts', '002-r01-a1', 'image.jpg');
  const b1 = await makeValidJpg(d1, 'white');
  const b2 = await makeValidJpg(d2, 'ivory');
  const h1 = createHash('sha256').update(b1).digest('hex');
  const h2 = createHash('sha256').update(b2).digest('hex');
  await writeFile(join(root, 'drafts', '001-r01-a10', 'status.json'), JSON.stringify({
    state: 'succeeded',
    plan: { file: epPath, slide: 1, character: false },
    slide_content_sha256: val.slideFingerprints[0],
    request_sha256: 'a'.repeat(64),
    output: { sha256: h1 },
  }));
  await writeFile(join(root, 'drafts', '002-r01-a1', 'status.json'), JSON.stringify({
    state: 'succeeded',
    plan: { file: epPath, slide: 2, character: false },
    slide_content_sha256: val.slideFingerprints[1],
    request_sha256: 'b'.repeat(64),
    output: { sha256: h2 },
  }));

  const outDir = join(root, 'output', 'r01');
  execFileSync(process.execPath, [exportScript, '--checked', d1, join(outDir, '001.jpg'), 'Slide 1 ok']);
  execFileSync(process.execPath, [exportScript, d2, join(outDir, '002.jpg')]);
  const stBefore = await episodeStatus(root, { revision: 'r01' });
  assert.equal(stBefore.slides[0].checkState, 'verified');
  assert.equal(stBefore.slides[1].exportState, 'verified');
  assert.equal(stBefore.slides[1].checkState, 'missing');
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Missing check checkpoint for slide 2/);

  execFileSync(process.execPath, [exportScript, '--checked', d2, join(outDir, '002.jpg'), 'Slide 2 ok']);

  // Checkpoint missing request_sha256 MUST be rejected by finalize!
  const ck2Path = join(outDir, 'checks', '002.jpg.json');
  const ck2Orig = await readFile(ck2Path, 'utf8');
  const ck2NoReq = JSON.parse(ck2Orig);
  delete ck2NoReq.request_sha256;
  await writeFile(ck2Path, JSON.stringify(ck2NoReq));
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /missing valid request_sha256/);
  const missingImageHash = JSON.parse(ck2Orig);
  delete missingImageHash.image_sha256;
  await writeFile(ck2Path, JSON.stringify(missingImageHash));
  assert.equal((await episodeStatus(root)).slides[1].checked, false);
  await assert.rejects(finalizeEpisode(root), /SHA-256 mismatch/);
  await writeFile(ck2Path, ck2Orig);

  // Tampering episode.json text after visual check makes checkpoint stale and blocks finalize!
  const epOrig = await readFile(epPath, 'utf8');
  const epMutated = JSON.parse(epOrig);
  epMutated.slides[0].text = 'Nội dung B đã sửa sau khi check!';
  await writeFile(epPath, JSON.stringify(epMutated, null, 2));
  assert.equal((await episodeStatus(root, { revision: 'r01' })).slides[0].checkState, 'stale');
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Stale visual check for slide 1/);

  // Concurrent finalize calls succeed safely without overwriting snapshot!
  await writeFile(epPath, epOrig);
  const [f1, f2] = await Promise.all([
    finalizeEpisode(root, { revision: 'r01' }),
    finalizeEpisode(root, { revision: 'r01' }),
  ]);
  assert.equal(f1.ok, true);
  assert.equal(f2.ok, true);
  assert.ok(f1.idempotent || f2.idempotent);
  assert.deepEqual(f1.files, ['output/r01/001.jpg', 'output/r01/002.jpg']);

  // Modifying episode and re-finalizing same r01 is rejected!
  await writeFile(epPath, JSON.stringify(epMutated, null, 2));
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Stale visual check|already exists/);

  // Non-image file placed as output fails image verification even if hash matches check.
  await writeFile(epPath, epOrig);
  const fakeBytes = Buffer.from('not-an-image');
  await writeFile(join(outDir, '001.jpg'), fakeBytes);
  const fakeHash = createHash('sha256').update(fakeBytes).digest('hex');
  const ck1 = JSON.parse(await readFile(join(outDir, 'checks', '001.jpg.json'), 'utf8'));
  ck1.sha256 = fakeHash;
  ck1.image_sha256 = fakeHash;
  await writeFile(join(outDir, 'checks', '001.jpg.json'), JSON.stringify(ck1));
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Expected a PNG or JPEG image/);
});
