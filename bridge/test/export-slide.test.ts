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

test('binds v2 checkpoint to episode content and rejects stale or mismatched drafts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'export-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'drafts', '001-r01-a1'), { recursive: true });
  await mkdir(join(root, 'drafts', '002-r01-a1'), { recursive: true });
  const d1 = join(root, 'drafts', '001-r01-a1', 'image.jpg');
  const d2 = join(root, 'drafts', '002-r01-a1', 'image.jpg');
  execFileSync('magick', ['-size', '1080x1440', 'xc:white', '-quality', '95', d1]);
  execFileSync('magick', ['-size', '1080x1440', 'xc:ivory', '-quality', '95', d2]);
  await writeFile(join(root, 'episode.json'), JSON.stringify({
    mode: 'original',
    slides: [
      { text: 'Slide 1', scene: 'Cảnh 1', scene_type: 'concept', characters: [] },
      { text: 'Slide 2', scene: 'Cảnh 2', scene_type: 'concept', characters: [] },
    ],
  }));
  await writeFile(join(root, 'drafts', '001-r01-a1', 'status.json'), JSON.stringify({
    state: 'succeeded',
    plan: { slide: 1 },
    slide_content_sha256: '0'.repeat(64),
  }));
  // Stale draft fingerprint must be refused at export time!
  const staleRes = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(staleRes.status, 1);
  assert.match(staleRes.stderr, /is stale/);

  // Wrong slide draft (slide 2 exported as 001.jpg) must be refused!
  await writeFile(join(root, 'drafts', '002-r01-a1', 'status.json'), JSON.stringify({ state: 'succeeded', plan: { slide: 2 } }));
  const wrongSlide = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d2, join(root, 'output', 'r01', '001.jpg'), 'ok'], { encoding: 'utf8' });
  assert.equal(wrongSlide.status, 1);
  assert.match(wrongSlide.stderr, /belongs to slide 2/);

  // Valid export produces bound schema_version 2 checkpoint.
  await writeFile(join(root, 'drafts', '001-r01-a1', 'status.json'), JSON.stringify({ state: 'succeeded', plan: { slide: 1 } }));
  const ok = spawnSync(process.execPath, ['scripts/export-slide.mjs', '--checked', d1, join(root, 'output', 'r01', '001.jpg'), 'Đã kiểm tra'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const ck = JSON.parse(await readFile(join(root, 'output', 'r01', 'checks', '001.jpg.json'), 'utf8'));
  assert.equal(ck.schema_version, 2);
  assert.equal(ck.revision, 'r01');
  assert.equal(ck.slide, 1);
  assert.equal(ck.image_sha256, ck.sha256);
  assert.ok(ck.slide_content_sha256);
  assert.equal(ck.visual_check.passed, true);
});
