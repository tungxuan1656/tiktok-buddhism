import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createEpisode, changeEpisode, episodeHandoff, rejectImage } from '../scripts/episode-tools.mjs';
import { draw, recoverAttempt } from '../scripts/draw-image.mjs';
import { exportSlide } from '../scripts/export-slide.mjs';
import { checkPath, EPISODE_JSON, episodeBundle, loadValidated, readEpisode, writeEpisode } from '../scripts/lib/episode.mjs';
import { sha256Bytes } from '../scripts/lib/fingerprint.mjs';
import { LOOKAHEAD_LOCK, withEpisodeLock } from '../scripts/lib/lock.mjs';
import { LOOKAHEAD_GUARD } from '../scripts/lib/resume.mjs';
import { MAX_EPISODE_JSON_BYTES } from '../scripts/lib/policy.mjs';

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
  await assert.rejects(rejectImage(dir, `./drafts/../${relative(dir, a)}`, 'Wrong diacritic'), /escaping/);
  await rejectImage(dir, `./${relative(dir, a)}`, 'Wrong diacritic');
  assert.equal((await episodeHandoff(dir)).next, 'repair');
  await assert.rejects(exportSlide(dir, relative(dir, a), 'checked'), /rejected/);
  const b = await call(1);
  const first = await exportSlide(dir, `./${relative(dir, b)}`, 'Read pixels and checked all accents');
  assert.notEqual((await stat(b)).ino, (await stat(join(dir, first.file))).ino);
  assert.deepEqual(await readFile(b), await readFile(join(dir, first.file)));
  assert.equal((await exportSlide(dir, relative(dir, b), 'checked')).action, 'reused');
  assert.equal(await call(1), join(dir, first.file));
  await assert.rejects(changeEpisode(dir, 'finalize'), /Missing verified/);
  const c = await call(2);
  await exportSlide(dir, relative(dir, c), 'checked');
  const finalized = await changeEpisode(dir, 'finalize');
  assert.deepEqual(await changeEpisode(dir, 'finalize'), finalized);
  await assert.rejects(changeEpisode(dir, 'approve'), /Unknown state transition/);
  const bundle = await episodeBundle(dir);
  assert.equal(bundle.files.length, 2);
  await writeEpisode(dir, { ...await readEpisode(dir), status: 'approved' });
  await assert.rejects(episodeBundle(dir), /Invalid episode/);
  await writeEpisode(dir, { ...await readEpisode(dir), status: 'ready_for_review' });
  assert.equal((await changeEpisode(dir, 'publish')).status, 'published');
  assert.equal((await changeEpisode(dir, 'publish')).status, 'published');
  await changeEpisode(dir, 'reopen');
  await assert.rejects(episodeBundle(dir));
  const ep = await readEpisode(dir);
  ep.slides[1].text = 'Sửa trang hai.';
  await writeEpisode(dir, ep);
  await changeEpisode(dir, 'lock');
  assert.deepEqual((await episodeHandoff(dir)).kept, [1]);
  assert.equal((await episodeHandoff(dir)).page.slide, 2);
  await changeEpisode(dir, 'reopen');
  ep.slides.pop();
  await writeEpisode(dir, { ...await readEpisode(dir), slides: ep.slides });
  await changeEpisode(dir, 'lock');
  assert.deepEqual(await changeEpisode(dir, 'finalize'), finalized);
  await assert.rejects(stat(join(dir, checkPath(2))), { code: 'ENOENT' });
  await assert.rejects(stat(join(dir, 'artifact/images/002.jpg')), { code: 'ENOENT' });
  assert.equal(calls, 3);
});

test('lookahead overlaps review only one slide ahead, and keeps its draft through a repair', async t => {
  const dir = await locked(t, [page('First.'), page('Second.'), page('Third.')]);
  const job = { episodeDir: dir };
  const image = png('white');
  const drawSlide = async (slide, raw = image) => relative(dir, await draw({ ...job, slide, request: () => new Response(raw) }));
  const noPost = () => assert.fail('unexpected POST');
  await assert.rejects(draw({ ...job, slide: 2, lookahead: true, request: noPost }), /current review draft/);
  const first = await drawSlide(1);
  assert.equal((await episodeHandoff(dir)).lookahead, 2);
  await assert.rejects(draw({ ...job, slide: 3, lookahead: true, request: noPost }), /next unfinished slide/);

  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const pending = draw({ ...job, slide: 2, lookahead: true, request: () => {
    started.resolve();
    return response.promise;
  } });
  try {
    await Promise.race([started.promise, pending]);
    let handoff = await episodeHandoff(dir);
    assert.equal(handoff.next, 'review');
    assert.equal(handoff.page.file, first);
    assert.equal(handoff.in_progress.slide, 2);
    assert.equal(handoff.lookahead, undefined);
    await assert.rejects(draw({ ...job, slide: 3, lookahead: true, request: noPost }), /Episode blocked/);
    await assert.rejects(changeEpisode(dir, 'reopen'), /Episode blocked/);
    await assert.rejects(recoverAttempt(dir, handoff.in_progress.path, { note: 'Cannot reconcile a live request' }), /Wait for the lookahead/);
    await rejectImage(dir, first, 'Independently checked; wrong diacritic');
    handoff = await episodeHandoff(dir);
    assert.equal(handoff.next, 'wait_for_image');
    await assert.rejects(draw({ ...job, slide: 1, request: noPost }), /Episode blocked/);
  } finally {
    response.resolve(new Response(image));
    await pending;
  }

  const second = relative(dir, await pending);
  assert.equal((await episodeHandoff(dir)).next, 'repair');
  await assert.rejects(exportSlide(dir, second, 'Out of order'), /current review draft/);
  await assert.rejects(rejectImage(dir, second, 'Out of order'), /current review draft/);
  const repaired = await drawSlide(1, png('blue'));
  await exportSlide(dir, repaired, 'Checked repair');
  assert.equal((await episodeHandoff(dir)).page.file, second);
  assert.equal(await draw({ ...job, slide: 2, request: noPost }), join(dir, second));
  await exportSlide(dir, second, 'Checked reused lookahead JPEG');
});

test('handoff reports lock contention as busy, not an image failure', async t => {
  const dir = await locked(t);
  await withEpisodeLock(dir, async () => {
    assert.deepEqual(await episodeHandoff(dir), { next: 'busy' });
  });
  assert.equal((await episodeHandoff(dir)).next, 'draw');
});

for (const checkpoint of ['draft', 'guard']) {
  test(`a lookahead killed just after publishing its ${checkpoint} can be reconciled as unsent`, { timeout: 12_000 }, async t => {
    const dir = await locked(t);
    const image = png('white');
    await draw({ episodeDir: dir, slide: 1, request: () => new Response(image) });
    const destination = join(dir, checkpoint === 'draft' ? 'drafts/002-a1' : LOOKAHEAD_GUARD);
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { promises as fs } from 'node:fs';
      import { once } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (to === process.argv[2]) {
          process.send('checkpoint');
          await once(process, 'message');
        }
      };
      syncBuiltinESMExports();
      const { draw } = await import(${JSON.stringify(new URL('../scripts/draw-image.mjs', import.meta.url).href)});
      await draw({ episodeDir: process.argv[1], slide: 2, lookahead: true, request: () => {
        throw new Error('Unexpected POST before the test checkpoint');
      } });
    `, dir, destination], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      assert.equal(await Promise.race([once(child, 'message').then(([message]) => message), exited]), 'checkpoint');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const handoff = await episodeHandoff(dir);
    assert.equal(handoff.next, 'resolve_attempt');
    assert.equal(handoff.blocked.path, 'drafts/002-a1');
    assert.equal(handoff.blocked.code, 'IMG_NOT_SENT');
    await recoverAttempt(dir, handoff.blocked.path, { note: 'Stopped before POST' });
    await assert.rejects(stat(join(dir, LOOKAHEAD_GUARD)), { code: 'ENOENT' });
    assert.equal((await episodeHandoff(dir)).lookahead, 2);
    assert.equal(await draw({ episodeDir: dir, slide: 2, lookahead: true, request: () => new Response(image) }), join(dir, 'drafts/002-a2/image.jpg'));
  });
}

test('a killed lookahead leaves recoverable raw while the episode lock is busy', { timeout: 12_000 }, async t => {
  const dir = await locked(t);
  const image = png('white');
  await draw({ episodeDir: dir, slide: 1, request: () => new Response(image) });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { once } from 'node:events';
    import { draw } from ${JSON.stringify(new URL('../scripts/draw-image.mjs', import.meta.url).href)};
    await draw({ episodeDir: process.argv[1], slide: 2, lookahead: true, request: async () => {
      process.send('post');
      const [base64] = await once(process, 'message');
      return new Response(Buffer.from(base64, 'base64'));
    } });
  `, dir], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exit = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exit; });
  assert.equal(await Promise.race([once(child, 'message').then(([message]) => message), exit]), 'post');
  assert.equal((await episodeHandoff(dir)).in_progress.slide, 2);

  const work = join(dir, 'drafts/002-a1');
  await withEpisodeLock(dir, async () => {
    child.send(image.toString('base64'));
    const deadline = Date.now() + 5_000;
    while (true) {
      const raw = await readFile(join(work, 'response.bin')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (raw?.equals(image)) break;
      assert.ok(Date.now() < deadline, 'raw checkpoint should not need the episode lock');
      await sleep(25);
    }
    assert.equal(JSON.parse(await readFile(join(work, 'status.json'))).response_sha256, sha256Bytes(image));
    child.kill('SIGKILL');
    assert.deepEqual(await exit, [null, 'SIGKILL']);
  });
  const handoff = await episodeHandoff(dir);
  assert.equal(handoff.next, 'resolve_attempt');
  assert.equal(handoff.blocked.raw_recoverable, true);
  assert.equal(await recoverAttempt(dir, handoff.blocked.path), join(work, 'image.jpg'));
  await assert.rejects(stat(join(dir, LOOKAHEAD_GUARD)), { code: 'ENOENT' });
  await exportSlide(dir, 'drafts/001-a1/image.jpg', 'Checked first slide');
  assert.equal((await episodeHandoff(dir)).page.file, 'drafts/002-a1/image.jpg');
});

for (const missing of ['drafts/002-a1', LOOKAHEAD_LOCK]) {
  test(`a live lookahead blocks drawing and recovery after losing ${missing}`, async t => {
    const dir = await locked(t);
    const image = png('white');
    const first = relative(dir, await draw({ episodeDir: dir, slide: 1, request: () => new Response(image) }));
    const started = Promise.withResolvers();
    const response = Promise.withResolvers();
    const pending = draw({ episodeDir: dir, slide: 2, lookahead: true, request: () => {
      started.resolve();
      return response.promise;
    } });
    await Promise.race([started.promise, pending]);
    const file = join(dir, missing);
    const backup = join(dir, '.test-backup');
    await rename(file, backup);
    try {
      const mismatch = /Lookahead lock and attempt records do not match/;
      const assertBlocked = async () => {
        assert.equal((await episodeHandoff(dir)).next, 'inspect_attempt');
        await assert.rejects(draw({ episodeDir: dir, slide: 2, request: () => assert.fail('unexpected POST') }), mismatch);
        await assert.rejects(recoverAttempt(dir, '002-a1', { note: 'Must not reconcile a live request' }), mismatch);
        await assert.rejects(exportSlide(dir, first, 'Must not write during inconsistent state'), mismatch);
      };
      await assertBlocked();
      await assert.rejects(stat(file), { code: 'ENOENT' });
      if (missing === LOOKAHEAD_LOCK) {
        await writeFile(file, '');
        await assertBlocked();
      }
    } finally {
      await rename(backup, file);
      response.resolve(new Response(image));
      await pending;
    }
  });
}

test('an interrupted legacy lookahead can be recovered after its worker exits', async t => {
  const dir = await locked(t);
  const image = png('white');
  const request = () => new Response(image);
  const first = relative(dir, await draw({ episodeDir: dir, slide: 1, request }));
  const second = await draw({ episodeDir: dir, slide: 2, lookahead: true, request });
  await rm(second);
  await rm(join(second, '..', 'response.bin'));
  await writeFile(join(second, '..', 'status.json'), JSON.stringify({ state: 'in_flight' }));
  const handoff = await episodeHandoff(dir);
  assert.equal(handoff.next, 'resolve_attempt');
  assert.equal(handoff.blocked.slide, 2);
  assert.equal(handoff.in_progress, undefined);
  await assert.rejects(exportSlide(dir, first, 'Checked'), /unblocked episode/);
  await recoverAttempt(dir, handoff.blocked.path, { note: 'Confirmed request did not complete' });
  assert.equal((await episodeHandoff(dir)).next, 'review');
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
    await recoverAttempt(dir, blocked.path, { note: 'Verified no usable result and resolved the cause' });
    assert.equal((await episodeHandoff(dir)).page.attempt, '001-a2');
  });
}

test('normalization recovers the recorded response without sending another POST', async t => {
  const dir = await locked(t);
  const raw = png('white');
  let calls = 0;
  const work = await draw({ episodeDir: dir, slide: 1, request: () => { calls++; return new Response(raw); } });
  const saved = await readFile(work);
  await rm(work);
  let handoff = await episodeHandoff(dir);
  assert.equal(handoff.next, 'resolve_attempt');
  assert.equal(handoff.blocked.code, 'IMG_DRAFT_DAMAGED');
  assert.equal(handoff.blocked.raw_recoverable, true);
  const receipt = join(dir, handoff.blocked.path, 'status.json');
  const before = await readFile(receipt);
  await assert.rejects(recoverAttempt(dir, handoff.blocked.path, { note: 'Discard' }), /use --normalize/);
  assert.deepEqual(await readFile(receipt), before);
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => assert.fail('unexpected POST') }), /run handoff/);
  const output = execFileSync(process.execPath, ['scripts/draw-image.mjs', '--normalize', dir, `./${handoff.blocked.path}`], { encoding: 'utf8' });
  assert.equal(output.trim(), work);
  assert.deepEqual(await readFile(work), saved);
  assert.equal((await episodeHandoff(dir)).next, 'review');

  const status = join(work, '..', 'status.json');
  const response = join(work, '..', 'response.bin');
  await writeFile(status, JSON.stringify({ ...JSON.parse(await readFile(status)), state: 'received', output: undefined }));
  await rm(response);
  assert.equal((await episodeHandoff(dir)).blocked.raw_recoverable, false);
  await writeFile(response, raw.subarray(0, 20));
  assert.equal((await episodeHandoff(dir)).blocked.raw_recoverable, false);
  await assert.rejects(recoverAttempt(dir, '001-a1'), /No verified response/);
  await writeFile(response, raw);
  handoff = await episodeHandoff(dir);
  assert.equal(handoff.blocked.raw_recoverable, true);
  assert.equal(await recoverAttempt(dir, handoff.blocked.name), work);
  assert.equal((await episodeHandoff(dir)).next, 'review');
  assert.equal(calls, 1);
});

test('a missing or failing decoder cannot discard a saved image', async t => {
  const dir = await locked(t, [page('Page one.')]);
  const raw = png('white');
  const draft = await draw({ episodeDir: dir, slide: 1, request: () => new Response(raw) });
  await rm(draft);
  const { blocked } = await episodeHandoff(dir);
  const status = join(dir, blocked.path, 'status.json');
  const saved = await readFile(status);
  const bin = await temp(t);
  const run = (script, ...args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], {
    encoding: 'utf8', env: { PATH: bin },
  });
  for (const unavailable of [true, false]) {
    if (!unavailable) await writeFile(join(bin, 'magick'), `#!/bin/sh
printf "identify: memory allocation failed \\140%s' @ error/png.c/ReadPNGImage/1.\\n" "$5" >&2
exit 1
`, { mode: 0o700 });
    const result = run('draw-image', '--reconcile', dir, blocked.path, '--note', 'Discard');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ImageMagick.*before reconciling/);
    assert.deepEqual(await readFile(status), saved);
    const handoff = run('episode-tools', 'handoff', dir);
    assert.equal(handoff.status, 0);
    const resultState = JSON.parse(handoff.stdout);
    assert.equal(resultState.next, 'resolve_attempt');
    assert.equal(resultState.blocked.raw_recoverable, null);
    assert.match(resultState.blocked.raw_issue, /ImageMagick/);
  }
  assert.equal(await recoverAttempt(dir, blocked.path), draft);
});

test('a hash-valid HTTP 200 JSON response is not a recoverable image', async t => {
  const dir = await locked(t, [page('Page one.')]);
  const response = '{"message":"no image"}';
  await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => new Response(response) }), /Do not retry/);
  const { blocked } = await episodeHandoff(dir);
  assert.equal(blocked.state, 'normalize_failed');
  assert.equal(blocked.raw_recoverable, false);
  assert.equal(await readFile(join(dir, blocked.path, 'response.bin'), 'utf8'), response);
  await assert.rejects(recoverAttempt(dir, blocked.path), /No verified response image/);
  await recoverAttempt(dir, blocked.path, { note: 'Confirmed no image and resolved the cause' });
  assert.equal((await episodeHandoff(dir)).next, 'draw');
});

test('a confirmed corrupt image stays on disk and requires reconciliation before another draw', async t => {
  const pngBytes = png('white');
  const jpegBytes = execFileSync('magick', ['-size', '20x30', 'xc:white', 'jpeg:-']);
  const badCrc = Buffer.from(pngBytes);
  badCrc[29] ^= 1; // First byte of the IHDR checksum.
  for (const [label, raw] of [
    ['truncated PNG header', pngBytes.subarray(0, 20)],
    ['truncated PNG data', pngBytes.subarray(0, -2)],
    ['bad PNG header checksum', badCrc],
    ['truncated JPEG data', jpegBytes.subarray(0, -2)],
  ]) await t.test(label, async t => {
    const dir = await locked(t, [page('Page one.')]);
    await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => new Response(raw) }), /Do not retry/);
    const { blocked, next } = await episodeHandoff(dir);
    assert.equal(next, 'resolve_attempt');
    assert.equal(blocked.state, 'normalize_failed');
    assert.equal(blocked.raw_recoverable, false);
    await assert.rejects(recoverAttempt(dir, blocked.path), /No verified response image/);
    await assert.rejects(draw({ episodeDir: dir, slide: 1, request: () => assert.fail('unexpected POST') }), /Episode blocked/);
    const note = `Confirmed the saved image is corrupt: ${label}`;
    await recoverAttempt(dir, blocked.path, { note });
    const dirAttempt = join(dir, blocked.path);
    assert.equal(JSON.parse(await readFile(join(dirAttempt, 'status.json'))).reconcile_note, note);
    assert.deepEqual(await readFile(join(dirAttempt, 'response.bin')), raw);
    assert.equal((await episodeHandoff(dir)).page.attempt, '001-a2');
  });
});

test('malformed slide receipts leave the intact draft available for review and export', async t => {
  const dir = await locked(t, [page('Page one.')]);
  const draft = relative(dir, await draw({ episodeDir: dir, slide: 1, request: () => new Response(png('white')) }));
  await exportSlide(dir, draft, 'Original check');
  for (const invalid of ['{', 'null']) {
    await writeFile(join(dir, checkPath(1)), invalid);
    assert.equal((await episodeHandoff(dir)).next, 'review');
    assert.equal((await exportSlide(dir, draft, 'Checked the same draft again')).action, 'exported');
  }
  assert.equal((await episodeHandoff(dir)).next, 'finalize');
});

test('export cannot replace the final JPEG when the receipt is a directory', async t => {
  const dir = await locked(t, [page('Page one.')]);
  const draft = relative(dir, await draw({ episodeDir: dir, slide: 1, request: () => new Response(png('white')) }));
  const { file } = await exportSlide(dir, draft, 'Original check');
  const receipt = join(dir, checkPath(1));
  await rm(receipt);
  await mkdir(receipt);
  const previous = execFileSync('magick', ['-size', '1080x1440', 'xc:green', 'jpg:-']);
  await writeFile(join(dir, file), previous);
  await assert.rejects(exportSlide(dir, draft, 'Checked draft'), /receipt destination is not a regular file/);
  assert.deepEqual(await readFile(join(dir, file)), previous);
});

test('locking cannot replace a readable episode with JSON over the size limit', async t => {
  const { dir } = await createEpisode(await temp(t), 'Test', 'Original request');
  const ep = { ...await readEpisode(dir), slides: [page('Page one.')], padding: '' };
  const size = Buffer.byteLength(`${JSON.stringify(ep, null, 2)}\n`);
  ep.padding = 'x'.repeat(MAX_EPISODE_JSON_BYTES - size);
  await writeEpisode(dir, ep);
  const file = join(dir, EPISODE_JSON);
  const old = await readFile(file);
  assert.equal(old.length, MAX_EPISODE_JSON_BYTES);
  await assert.rejects(changeEpisode(dir, 'lock'), /Episode JSON too large/);
  assert.deepEqual(await readFile(file), old);
  assert.equal((await episodeHandoff(dir)).next, 'prepare_script');
});

test('locking reserves space for the final status at the JSON size limit', async t => {
  const { dir } = await createEpisode(await temp(t), 'Test', 'Original request');
  const ep = { ...await readEpisode(dir), slides: [page('Page one.')], padding: '' };
  const size = Buffer.byteLength(`${JSON.stringify({ ...ep, locked_sha256: '0'.repeat(64), status: 'ready_for_review' }, null, 2)}\n`);
  ep.padding = 'x'.repeat(MAX_EPISODE_JSON_BYTES - size + 1);
  await writeEpisode(dir, ep);
  await assert.rejects(changeEpisode(dir, 'lock'), /Episode JSON too large/);
  assert.equal((await readEpisode(dir)).status, 'draft');

  ep.padding = ep.padding.slice(1);
  await writeEpisode(dir, ep);
  await changeEpisode(dir, 'lock');
  const draft = await draw({ episodeDir: dir, slide: 1, request: () => new Response(png('white')) });
  await exportSlide(dir, relative(dir, draft), 'Checked');
  assert.equal((await changeEpisode(dir, 'finalize')).status, 'ready_for_review');
  assert.equal((await stat(join(dir, EPISODE_JSON))).size, MAX_EPISODE_JSON_BYTES);
});

test('a rejected migrated artifact supplies the repair note without a draft', async t => {
  const dir = await locked(t, [page('Imported page.')]);
  const file = 'artifact/images/001.png';
  const bytes = png('white');
  const { episode, validation } = await loadValidated(dir);
  await mkdir(join(dir, 'artifact/images'));
  await mkdir(join(dir, 'artifact/checks'));
  await writeFile(join(dir, file), bytes);
  await writeFile(join(dir, checkPath(1)), JSON.stringify({ image: file, image_sha256: sha256Bytes(bytes),
    slide_content_sha256: validation.slideFingerprints[0], legacy: true, visual_check: { passed: true, note: 'Imported original' } }));
  await writeEpisode(dir, { ...episode, status: 'published', legacy: { bundle: 'verified' } });
  await changeEpisode(dir, 'reopen');
  await rejectImage(dir, `./${file}`, 'Repair the left border');
  await changeEpisode(dir, 'lock');
  assert.equal((await episodeHandoff(dir)).next, 'repair');
  await draw({ episodeDir: dir, slide: 1, request: (_url, { body }) => {
    assert.match(JSON.parse(body).prompt, /Repair the left border/);
    return new Response(png('green'));
  } });
});

test('only visual drafts count toward the attempt limit', async t => {
  const dir = await locked(t, [page('Page one.')]);
  const job = { episodeDir: dir, slide: 1 };
  await assert.rejects(draw({ ...job, request: () => new Response('', { status: 503 }) }), /Do not retry/);
  const { blocked } = await episodeHandoff(dir);
  const resolved = execFileSync(process.execPath, ['scripts/draw-image.mjs', '--reconcile', dir, blocked.path,
    '--note', 'Verified no usable response'], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(resolved), { reconciled: 'drafts/001-a1' });
  for (const [index, color] of ['blue', 'red', 'yellow'].entries()) {
    const draft = await draw({ ...job, request: () => new Response(png(color)) });
    assert.equal(relative(dir, draft), `drafts/001-a${index + 2}/image.jpg`);
    await rejectImage(dir, relative(dir, draft), 'Not usable');
  }
  assert.equal((await episodeHandoff(dir)).next, 'attempt_limit');
  await assert.rejects(draw({ ...job, request: () => assert.fail('unexpected POST') }), /Attempt limit/);
});

test('approved style overrides are confined, sent first and pinned at lock', async t => {
  const dir = await locked(t, [page('A styled page.')]);
  const art = png('pink');
  await changeEpisode(dir, 'reopen');
  const ep = await readEpisode(dir);
  await writeEpisode(dir, { ...ep, style_ref: '../style.png' });
  await assert.rejects(changeEpisode(dir, 'lock'), /Invalid style_ref/);
  await writeFile(join(dir, 'style.png'), art);
  await writeEpisode(dir, { ...ep, style_ref: './style.png' });
  await changeEpisode(dir, 'lock');
  const job = { episodeDir: dir, slide: 1 };
  await draw({ ...job, request: (_url, { body }) => {
    assert.equal(JSON.parse(body).images[0], `data:image/png;base64,${art.toString('base64')}`);
    return new Response(art);
  } });
  await writeFile(join(dir, 'style.png'), png('orange'));
  await assert.rejects(draw({ ...job, request: () => assert.fail('unexpected POST') }), /changed since lock/);
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

test('an unused successful character draft does not block handoff but unresolved attempts do', async t => {
  const { dir } = await createEpisode(await temp(t), 'Test', 'Original request');
  const ep = await readEpisode(dir);
  const id = 'TEST_CHARACTER';
  const version = 'v1';
  const slides = [{ ...page('A person.'), characters: [{ id, version }] }];
  await writeEpisode(dir, { ...ep, slides });
  const promptFile = join(dir, 'character-prompt.txt');
  await writeFile(promptFile, 'One character, no text.');
  const draft = await draw({ episodeDir: dir, target: `${id}/${version}`, promptFile, request: () => new Response(png('white')) });
  await rm(draft);
  assert.equal((await episodeHandoff(dir)).blocked.code, 'IMG_DRAFT_DAMAGED');
  await writeEpisode(dir, { ...ep, slides: [page('No characters.')] });
  assert.equal((await episodeHandoff(dir)).next, 'prepare_script');
  const status = join(draft, '..', 'status.json');
  await writeFile(status, JSON.stringify({ ...JSON.parse(await readFile(status)), state: 'in_flight' }));
  assert.equal((await episodeHandoff(dir)).next, 'resolve_attempt');
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
