import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEpisode, changeEpisode, episodeHandoff, rejectImage } from '../scripts/episode-tools.mjs';
import { draw, recoverAttempt } from '../scripts/draw-image.mjs';
import { exportSlide } from '../scripts/export-slide.mjs';
import { episodeBundle, loadValidated, readEpisode, writeEpisode } from '../scripts/lib/episode.mjs';

const page = text => ({ text, scene: 'A simple scene', scene_type: 'concept', characters: [] });
const png = color => execFileSync('magick', ['-size', '20x30', `xc:${color}`, 'png:-']);
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'buddhism-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function locked(t, pages = [page('Giữ nguyên chữ và dấu.'), page('Trang hai.')]) {
  const { dir } = await createEpisode(await temp(t), 'Test', 'Original request');
  await writeEpisode(dir, { ...await readEpisode(dir), slides: pages });
  await changeEpisode(dir, 'lock');
  return dir;
}

test('allocator is concurrent-safe and ignores the historical fixture', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'local-api-e2e-20261111-v1'), 'fixture');
  const result = await Promise.all(Array.from({ length: 4 }, () => createEpisode(root, 'Title', 'Request')));
  assert.deepEqual(result.map(r => r.code).sort(), ['T1', 'T2', 'T3', 'T4']);
});

test('sequential draws reuse bytes, require an immediate visual check, and reopen only changed pages', async t => {
  const dir = await locked(t);
  const colors = [png('green'), png('orange'), png('blue')];
  let calls = 0;
  const call = slide => draw({ episodeDir: dir, slide, request: async (url, { method, body }) => {
    assert.equal(method, 'POST');
    assert.equal(url, 'http://localhost:20128/v1/images/generations?response_format=binary');
    const data = JSON.parse(body);
    assert.equal(data.model, 'cx/gpt-image-2.6-flare');
    assert.match(data.prompt, /Giữ nguyên chữ và dấu\.|Trang hai\./);
    assert.match(data.images[0], /^data:image\/png;base64,/);
    assert.equal(data.output_format, 'jpeg');
    assert.equal(data.size, '1024x1536');
    const attempt = `${String(slide).padStart(3, '0')}-a${calls > 0 && slide === 1 ? 2 : 1}`;
    assert.equal(JSON.parse(await readFile(join(dir, 'drafts', attempt, 'status.json'))).state, 'in_flight');
    return new Response(colors[calls++]);
  } });
  await assert.rejects(call(2), /first unfinished/);
  const a = await call(1);
  assert.equal(await call(1), a);
  assert.equal((await episodeHandoff(dir)).next, 'review');
  await assert.rejects(call(2), /first unfinished/);
  assert.deepEqual(await readFile(join(a, '..', 'response.bin')), colors[0]);
  assert.equal(execFileSync('magick', ['identify', '-format', '%m %w %h %Q %[jpeg:sampling-factor]', a], { encoding: 'utf8' }), 'JPEG 1080 1440 95 1x1,1x1,1x1');
  await rejectImage(dir, relative(dir, a), 'Wrong diacritic');
  assert.equal((await episodeHandoff(dir)).next, 'repair');
  await assert.rejects(exportSlide(dir, relative(dir, a), 'checked'), /rejected/);
  const b = await call(1);
  const first = await exportSlide(dir, relative(dir, b), 'Read pixels and checked all accents');
  assert.equal((await stat(b)).ino, (await stat(join(dir, first.file))).ino);
  assert.equal((await exportSlide(dir, relative(dir, b), 'checked')).action, 'reused');
  assert.equal(await call(1), join(dir, first.file));
  await assert.rejects(changeEpisode(dir, 'finalize'), /Missing verified/);
  const c = await call(2);
  await exportSlide(dir, relative(dir, c), 'checked');
  await changeEpisode(dir, 'finalize');
  const bundle = await episodeBundle(dir);
  assert.equal(bundle.files.length, 2);
  await changeEpisode(dir, 'reopen');
  await assert.rejects(episodeBundle(dir));
  const ep = await readEpisode(dir);
  ep.slides[1].text = 'Sửa trang hai.';
  await writeEpisode(dir, ep);
  await changeEpisode(dir, 'lock');
  assert.deepEqual((await episodeHandoff(dir)).kept, [1]);
  assert.equal((await episodeHandoff(dir)).page.slide, 2);
  assert.equal(calls, 3);
});

for (const [label, response, code] of [
  ['HTTP 429', () => new Response('private diagnostic', { status: 429 }), 'IMG_HTTP_429'],
  ['timeout', () => { throw new DOMException('private diagnostic', 'TimeoutError'); }, 'IMG_TIMEOUT'],
]) {
  test(`${label} blocks the episode, including requests for another page`, async t => {
    const dir = await locked(t);
    let calls = 0;
    const request = () => { calls++; return response(); };
    await assert.rejects(draw({ episodeDir: dir, slide: 1, request }), /Do not retry/);
    for (const slide of [1, 2]) await assert.rejects(draw({ episodeDir: dir, slide, request }), /Episode blocked/);
    await assert.rejects(changeEpisode(dir, 'reopen'), /Episode blocked/);
    const { blocked } = await episodeHandoff(dir);
    assert.equal(blocked.code, code);
    assert.equal(blocked.slide, 1);
    assert.equal(calls, 1);
    await recoverAttempt(dir, '001-a1', { note: 'Verified no usable result and resolved the cause' });
    assert.equal((await episodeHandoff(dir)).page.attempt, '001-a2');
  });
}

test('normalization recovers the recorded response without sending another POST', async t => {
  const dir = await locked(t);
  const raw = png('white');
  let calls = 0;
  const work = await draw({ episodeDir: dir, slide: 1, request: () => { calls++; return new Response(raw); } });
  const status = join(work, '..', 'status.json');
  await writeFile(status, JSON.stringify({ ...JSON.parse(await readFile(status)), state: 'received', output: undefined }));
  await rm(work);
  assert.equal((await episodeHandoff(dir)).blocked.raw_recoverable, true);
  assert.equal(await recoverAttempt(dir, '001-a1'), work);
  assert.equal((await episodeHandoff(dir)).next, 'review');
  assert.equal(calls, 1);
});

test('a tampered locked script cannot send a request, and invalid verbatim cannot lock', async t => {
  const dir = await locked(t);
  const ep = await readEpisode(dir);
  ep.slides[0].text = 'Changed without reopening';
  await writeEpisode(dir, ep);
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => assert.fail('unexpected POST') }), /changed since lock/);
  await changeEpisode(dir, 'reopen');
  await writeEpisode(dir, { ...await readEpisode(dir), mode: 'verbatim' });
  await assert.rejects(changeEpisode(dir, 'lock'), /source.txt/);
});

test('historical quote exceptions do not apply when an episode is reopened', async t => {
  const dir = await locked(t, [page('Historical text.')]);
  await writeFile(join(dir, 'source.txt'), 'Different original source.');
  const ep = await readEpisode(dir);
  ep.status = 'published';
  ep.mode = 'verbatim';
  ep.legacy = { bundle: 'verified', verbatim_issue: 'Verbatim check failed: joined slides[].text does not match source (annotate cover/commentary with role or exact_join_first_slide) (source.txt)' };
  await writeEpisode(dir, ep);
  assert.equal((await loadValidated(dir, { requireLock: false })).validation.ok, true);
  await changeEpisode(dir, 'reopen');
  await assert.rejects(changeEpisode(dir, 'lock'), /Verbatim check failed/);
});

test('missing character is generated once and its pinned image is sent with the slide', async t => {
  const { dir } = await createEpisode(await temp(t), 'Test', 'Original request');
  const id = 'TEST_CHARACTER';
  const version = 'v1';
  const ep = await readEpisode(dir);
  await writeEpisode(dir, { ...ep, slides: [{ ...page('A person.'), characters: [{ id, version }] }] });
  await assert.rejects(changeEpisode(dir, 'lock'), /Missing or unsafe character snapshot/);
  const promptFile = join(dir, 'character-prompt.txt');
  await writeFile(promptFile, 'One character, no text.');
  const job = { episodeDir: dir, target: `${id}/${version}`, promptFile };
  let calls = 0;
  const art = png('purple');
  const draft = await draw({ ...job, request: () => { calls++; return new Response(art); } });
  assert.equal(await draw({ ...job, request: () => assert.fail('unexpected character POST') }), draft);
  const reference = join(dir, 'references', id, version);
  await mkdir(reference, { recursive: true });
  const bytes = await readFile(draft);
  await writeFile(join(reference, 'reference.jpg'), bytes);
  await writeFile(join(reference, 'character.json'), JSON.stringify({ references: ['reference.jpg'], identity: { face: 'Round face' } }));
  await changeEpisode(dir, 'lock');
  await draw({ episodeDir: dir, slide: 1, request: (_url, { body }) => {
    calls++;
    const { images, prompt } = JSON.parse(body);
    assert.match(prompt, /Round face/);
    assert.equal(images.length, 2);
    assert.equal(images[1], `data:image/jpeg;base64,${bytes.toString('base64')}`);
    return new Response(art);
  } });
  assert.equal(calls, 2);
});
