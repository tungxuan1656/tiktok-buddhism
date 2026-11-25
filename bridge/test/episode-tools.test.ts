import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const toolsPromise = import('../../scripts/episode-tools.mjs' as string);

async function setupEpisode(t: test.TestContext, mode: 'original' | 'verbatim' = 'original') {
  const root = await mkdtemp(join(tmpdir(), 'ep-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const charDir = join(root, 'references', 'PHAT_01', 'v1');
  await mkdir(charDir, { recursive: true });
  await writeFile(join(charDir, 'reference.jpg'), 'fakejpg');
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
      { text: 'Câu một.', scene: 'Đứng tĩnh lặng bên đèn dầu', scene_type: 'concept', evidence: 'minh họa', characters: [{ id: 'PHAT_01', version: 'v1' }] },
      { text: 'Câu hai.', scene: 'Ngồi thiền', scene_type: 'event', evidence: 'minh họa', characters: [] },
    ],
  };
  await writeFile(join(root, 'episode.json'), JSON.stringify(ep, null, 2));
  if (mode === 'verbatim') await writeFile(join(root, 'source.txt'), 'Câu một.\nCâu hai.\n');
  return root;
}

test('validateEpisode passes valid episode, supports cover slide and custom source path, and flags mismatches', async t => {
  const { validateEpisode } = await toolsPromise;
  const root = await setupEpisode(t, 'verbatim');
  const ok = await validateEpisode(root);
  assert.equal(ok.ok, true);
  assert.equal(ok.slideCount, 2);

  // Verbatim episode with a title/book cover as slide 1 and body in source.file starting at slide 2.
  await mkdir(join(root, 'sources'), { recursive: true });
  await writeFile(join(root, 'sources', 'body.txt'), 'Câu một.\nCâu hai.');
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'verbatim',
    source: { path: 'sources/body.txt' },
    slides: [
      { text: 'TỰA BÀI\nTên sách', scene: 'Bìa sen', scene_type: 'concept', characters: [] },
      { text: 'Câu một.', scene: 'Cảnh 1', scene_type: 'event', characters: [] },
      { text: 'Câu hai.', scene: 'Cảnh 2', scene_type: 'event', characters: [] },
    ],
  }));
  assert.equal((await validateEpisode(root)).ok, true);

  await writeFile(join(root, 'sources', 'body.txt'), 'Câu một.\nCâu khác.\n');
  const badVerbatim = await validateEpisode(root);
  assert.equal(badVerbatim.ok, false);
  assert.ok(badVerbatim.issues.some((i: string) => i.includes('Verbatim check failed')));

  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'original',
    slides: [
      { text: 'Nguyên văn theo bản bạn cung cấp.', scene: 'Cảnh', scene_type: 'concept', characters: [{ id: 'PHAT_01' }] },
    ],
  }));
  const badText = await validateEpisode(root);
  assert.equal(badText.ok, false);
  assert.ok(badText.issues.some((i: string) => i.includes('internal/management text')));
  assert.ok(badText.issues.some((i: string) => i.includes('invalid character reference')));
});

test('buildPrompts handles objects, character avoid rules, style ref path, --slides range, and preserves existing prompts without --force', async t => {
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
  // Slide 1 omits `objects`: must NOT print "Vật thể được phép: không có" contradicting the scene.
  assert.ok(!p1.includes('Vật thể được phép: không có'));
  assert.ok(p1.includes('ngoài cảnh yêu cầu'));
  const manifest = JSON.parse(await readFile(res1.batchManifest, 'utf8'));
  assert.equal(manifest.length, 2);
  assert.equal(manifest[0].references.length, 2);
  assert.ok(isAbsolute(manifest[0].references[0]));

  // String `objects` and array `objects` are both supported.
  const ep = JSON.parse(await readFile(join(root, 'episode.json'), 'utf8'));
  ep.slides[0].objects = 'Đèn dầu nhỏ';
  ep.slides[1].objects = ['Bát đất', 'Chiếu mộc'];
  await writeFile(join(root, 'episode.json'), JSON.stringify(ep, null, 2));
  await buildPrompts(root, { revision: 'r01', attempt: 'a2', slides: parseSlidesSpec('1-2', 2), force: true });
  const p1Forced = await readFile(join(root, 'prompts', '001-r01.txt'), 'utf8');
  const p2Forced = await readFile(join(root, 'prompts', '002-r01.txt'), 'utf8');
  assert.ok(p1Forced.includes('Vật thể được phép: Đèn dầu nhỏ.'));
  assert.ok(p2Forced.includes('Vật thể được phép: Bát đất, Chiếu mộc.'));
  const manifest2 = JSON.parse(await readFile(join(root, 'prompts', 'batch-r01.json'), 'utf8'));
  assert.ok(manifest2[0].workDir.endsWith(join('drafts', '001-r01-a2')));

  assert.throws(() => parseSlidesSpec('1,abc', 2), /Invalid slide number/);
  assert.throws(() => parseSlidesSpec('1-3', 2), /out of 1-2/);

  await writeFile(join(root, 'prompts', '001-r01.txt'), 'CUSTOM PROMPT');
  const res2 = await buildPrompts(root, { revision: 'r01' });
  assert.equal(res2.generated, 0);
  assert.equal(res2.skipped, 2);
  assert.equal(await readFile(join(root, 'prompts', '001-r01.txt'), 'utf8'), 'CUSTOM PROMPT');
});

test('episodeStatus sorts numeric attempts properly and finalizeEpisode verifies checkpoints and writes snapshot', async t => {
  const { episodeStatus, finalizeEpisode } = await toolsPromise;
  const root = await setupEpisode(t);
  await mkdir(join(root, 'drafts', '001-r01-a2'), { recursive: true });
  await mkdir(join(root, 'drafts', '001-r01-a10'), { recursive: true });
  await writeFile(join(root, 'drafts', '001-r01-a2', 'status.json'), JSON.stringify({ state: 'failed' }));
  await writeFile(join(root, 'drafts', '001-r01-a10', 'status.json'), JSON.stringify({ state: 'succeeded' }));

  const outDir = join(root, 'output', 'r01');
  await mkdir(join(outDir, 'checks'), { recursive: true });
  const b1 = Buffer.from('img1');
  const b2 = Buffer.from('img2');
  await writeFile(join(outDir, '001.jpg'), b1);
  await writeFile(join(outDir, '002.jpg'), b2);
  const h1 = createHash('sha256').update(b1).digest('hex');
  const h2 = createHash('sha256').update(b2).digest('hex');
  await writeFile(join(outDir, 'checks', '001.jpg.json'), JSON.stringify({ image: '001.jpg', sha256: h1, visual_check: 'ok' }));

  const st = await episodeStatus(root, { revision: 'r01' });
  assert.equal(st.slideCount, 2);
  assert.deepEqual(st.slides[0], { slide: 1, draft: '001-r01-a10', draftState: 'succeeded', exported: true, checked: true });
  assert.deepEqual(st.slides[1], { slide: 2, draft: null, draftState: null, exported: true, checked: false });

  // Refuses finalize when slide 2 lacks check file or hash mismatches.
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /Missing check checkpoint for slide 2/);
  await writeFile(join(outDir, 'checks', '002.jpg.json'), JSON.stringify({ image: '002.jpg', sha256: '0'.repeat(64), visual_check: 'ok' }));
  await assert.rejects(finalizeEpisode(root, { revision: 'r01' }), /SHA-256 mismatch/);

  await writeFile(join(outDir, 'checks', '002.jpg.json'), JSON.stringify({ image: '002.jpg', sha256: h2, visual_check: 'ok' }));
  const fin = await finalizeEpisode(root, { revision: 'r01' });
  assert.equal(fin.ok, true);
  assert.equal(fin.status, 'ready_for_review');
  assert.deepEqual(fin.files, ['output/r01/001.jpg', 'output/r01/002.jpg']);
  const epSaved = JSON.parse(await readFile(join(root, 'episode.json'), 'utf8'));
  const snapSaved = JSON.parse(await readFile(join(outDir, 'episode.json'), 'utf8'));
  assert.equal(epSaved.status, 'ready_for_review');
  assert.equal(epSaved.revision, 'r01');
  assert.equal(epSaved.slides[0].image, 'output/r01/001.jpg');
  assert.deepEqual(snapSaved, epSaved);
});
