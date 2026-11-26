import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { computeRequestFingerprint, sha256Bytes, sha256Canonical } from './lib/fingerprint.mjs';
import { canLookahead, EPISODE_JSON, episodePages, loadValidated } from './lib/episode.mjs';
import { acquireEpisodeLock, LOOKAHEAD_LOCK, withEpisodeLock } from './lib/lock.mjs';
import { activeLookahead, blockingAttempt, episodeAttempts, readRejection, statIfPresent, verifiedDraft, verifiedRawResponse, visualAttempts } from './lib/resume.mjs';
import { confineExistingPath, confineTargetPath, isSafeId, isSafeVersion, stripDotSlash, writeAtomic } from './lib/paths.mjs';
import { slidePrompt } from './lib/prompt.mjs';
import {
  IMAGE_ENDPOINT, IMAGE_MODEL, IMAGE_OUTPUT_FORMAT, IMAGE_SIZE, MAX_ATTEMPTS_PER_SLIDE,
  MAX_EPISODE_JSON_BYTES, MAX_IMAGE_BYTES, MAX_PROMPT_BYTES, MAX_REFS, MAX_TOTAL_REF_BYTES,
  OUTPUT_HEIGHT, OUTPUT_QUALITY, OUTPUT_SAMPLING, OUTPUT_WIDTH, REPO_ROOT,
} from './lib/policy.mjs';
import { readEpisodeJson, readImageInfo } from './lib/schema.mjs';

const exec = promisify(execFile);
const saveStatus = (dir, record) => writeAtomic(join(dir, 'status.json'), `${JSON.stringify(record, null, 2)}\n`, 0o600);

async function readAndCheckReferences(references, episodeDir, { includeBytes = true, maxTotalBytes = MAX_TOTAL_REF_BYTES } = {}) {
  if (!Array.isArray(references) || references.length > MAX_REFS) {
    throw new Error(`Too many reference images (max ${MAX_REFS})`);
  }
  const roots = [episodeDir, join(REPO_ROOT, 'references'), join(REPO_ROOT, 'characters')];
  const refs = [];
  const images = [];
  let totalBytes = 0;

  for (const refPath of references) {
    const checked = await confineExistingPath(roots, refPath, { requireRegularFile: true });
    if (totalBytes + checked.stat.size > maxTotalBytes) {
      throw new Error(`Aggregate reference image payload exceeds limit (${maxTotalBytes} bytes)`);
    }
    const info = await readImageInfo(checked.real, { includeBytes });
    totalBytes += info.bytes;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Aggregate reference image payload (${totalBytes} bytes) exceeds limit (${maxTotalBytes} bytes)`);
    }
    if (includeBytes) images.push(`data:${info.mime};base64,${info.buffer.toString('base64')}`);
    refs.push({
      path: checked.real,
      mime: info.mime,
      width: info.width,
      height: info.height,
      bytes: info.bytes,
      sha256: info.sha256,
    });
  }
  return { refs, images };
}

async function characterJob(dir, episode, target, promptFile, references, attempts) {
  const [id, version, extra] = (target ?? '').split('/');
  if (!isSafeId(id) || !isSafeVersion(version) || extra !== undefined || episode.status !== 'draft' ||
    !episode.slides.some(s => s.characters?.some(c => c.id === id && c.version === version))) {
    throw new Error('Character must be planned in the draft script as ID/VERSION');
  }
  for (const root of [join(REPO_ROOT, 'characters'), join(dir, 'references')]) {
    if (await statIfPresent(join(root, id, version, 'character.json'))) throw new Error('Character snapshot already exists; inspect and reuse it');
  }
  const fp = sha256Canonical(target);
  const previous = attempts.filter(a => a.plan.target === target);
  for (const a of previous.toReversed()) {
    if (a.state !== 'succeeded' || await readRejection(dir, fp, a.output?.sha256)) continue;
    if (!await verifiedDraft(dir, a)) throw new Error(`Character draft missing or changed: ${a.path}; run handoff`);
    return { reuse: join(dir, a.path, 'image.jpg') };
  }
  if (visualAttempts(previous) >= MAX_ATTEMPTS_PER_SLIDE) throw new Error('Character attempt limit reached');
  const input = await confineExistingPath([dir], promptFile);
  if (input.stat.size > MAX_PROMPT_BYTES) throw new Error('Prompt too large');
  return { prompt: await readFile(input.real, 'utf8'), references, fp, name: `character-${id}-${version}-a${previous.length + 1}` };
}

export async function draw({ episodeDir, slide, target, promptFile, references = [], lookahead = false, request = fetch }) {
  const dir = resolve(episodeDir);
  let release;
  const result = await withEpisodeLock(dir, async () => {
    const character = target !== undefined;
    if (character && lookahead) throw new Error('Lookahead is only for slides');
    const { episode, validation } = await loadValidated(dir, { character });
    const attempts = await episodeAttempts(dir);
    const blocked = blockingAttempt(attempts);
    if (blocked) throw new Error(`Episode blocked by ${blocked.path} (${blocked.state}); run handoff`);
    let job;
    if (character) {
      job = await characterJob(dir, episode, target, promptFile, references, attempts);
      if (job.reuse) return job.reuse;
    } else {
      if (episode.status !== 'locked' || !Number.isInteger(slide) || slide < 1 || slide > episode.slides.length) {
        throw new Error('Drawing requires a locked script and a valid slide number');
      }
      const pages = await episodePages(dir, validation, attempts);
      const [current, following] = pages.filter(p => p.action !== 'keep');
      if (lookahead && (!canLookahead(current, following) || following.slide !== slide)) {
        throw new Error('Lookahead requires a current review draft and the next unfinished slide to draw; run handoff');
      }
      if (pages[slide - 1].action === 'keep') return join(dir, pages[slide - 1].file);
      const next = lookahead ? following : current;
      if (!next || next.slide !== slide) throw new Error(`Only the first unfinished slide may be drawn (next: ${next?.slide ?? 'none'})`);
      if (next.action === 'review') return join(dir, next.file);
      if (next.action === 'attempt_limit') throw new Error(`Attempt limit reached for slide ${slide}`);
      if (next.action === 'resolve_attempt') throw new Error(`Draft missing or changed: ${next.blocked.path}; run handoff`);
      job = { ...slidePrompt(dir, episode, validation, slide, next.rejected?.note),
        fp: validation.slideFingerprints[slide - 1], name: next.attempt };
    }
    if (!job.prompt.trim() || Buffer.byteLength(job.prompt) > MAX_PROMPT_BYTES) throw new Error('Invalid prompt size');
    const { refs, images } = await readAndCheckReferences(job.references, dir);
    if (!character) {
      if (validation.styleReference && refs[0]?.sha256 !== validation.styleReference.sha256) throw new Error('Pinned style reference changed');
      const required = validation.resolvedCharsBySlide[slide - 1].flatMap(c => c.refInfos.map(r => r.sha256));
      if (required.some((hash, i) => hash !== refs[i + 1]?.sha256)) throw new Error('Pinned character references changed');
    }
    const promptSha256 = sha256Bytes(job.prompt);
    const data = JSON.stringify({ plan: { file: EPISODE_JSON, code: episode.code, slide, character, target, lookahead: lookahead ? true : undefined },
      slide_content_sha256: job.fp, prompt_sha256: promptSha256,
      request_sha256: computeRequestFingerprint({ slideContentSha256: job.fp, promptSha256, referenceHashes: refs.map(r => r.sha256) }),
      model: IMAGE_MODEL, size: IMAGE_SIZE, output_format: IMAGE_OUTPUT_FORMAT, prompt: job.prompt, references: refs }, null, 2);
    if (Buffer.byteLength(data) + 1 > MAX_EPISODE_JSON_BYTES) throw new Error('Request record too large');
    const work = await confineTargetPath(dir, `drafts/${job.name}`);
    if (await statIfPresent(work)) throw new Error('Attempt directory already exists; inspect it before proceeding');
    await exec('magick', ['-version'], { timeout: 10_000 });
    await mkdir(dirname(work), { recursive: true, mode: 0o700 });
    if (lookahead) release = await acquireEpisodeLock(dir, { name: LOOKAHEAD_LOCK });
    const staging = await mkdtemp(join(dir, '.register-'));
    try {
      await writeFile(join(staging, 'request.json'), `${data}\n`, { mode: 0o600 });
      await saveStatus(staging, { state: 'in_flight' });
      await rename(staging, work);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const args = { confinedWork: work, prompt: job.prompt, images, request, lookaheadDir: lookahead ? dir : undefined };
    return lookahead ? args : executeRequest(args);
  }, { timeoutMs: lookahead ? 10_000 : 0 }).catch(error => {
    release?.();
    throw error;
  });
  if (!release) return result;
  try { return await executeRequest(result); }
  finally { release(); }
}

async function normalizeImage(raw, dir, expectedHash) {
  const source = await readImageInfo(raw, { expectedSha256: expectedHash });
  const staging = await mkdtemp(join(dir, '.normalize-'));
  try {
    const output = join(staging, 'image.jpg');
    await exec('magick', [raw, '-auto-orient', '-colorspace', 'sRGB', '-background', 'white',
      '-alpha', 'remove', '-alpha', 'off', '-resize', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`, '-gravity', 'center', '-extent', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
      '-strip', '-sampling-factor', OUTPUT_SAMPLING, '-quality', String(OUTPUT_QUALITY), output], { timeout: 60_000 });
    const final = await readImageInfo(output, { requireNormalized1080: true });
    if (final.mime !== 'image/jpeg') throw new Error('Invalid normalized output');
    if (sha256Bytes(await readFile(raw)) !== expectedHash) throw new Error('Recorded response changed');
    await rename(output, join(dir, 'image.jpg'));
    return { source, output: { file: 'image.jpg', ...final, quality: OUTPUT_QUALITY, sampling: OUTPUT_SAMPLING } };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function executeRequest({ confinedWork, prompt, images, request, lookaheadDir }) {
  // Keep the lease and buffered response until the checkpoint can be written.
  const save = record => lookaheadDir
    ? withEpisodeLock(lookaheadDir, () => saveStatus(confinedWork, record), { timeoutMs: Infinity })
    : saveStatus(confinedWork, record);
  let state = 'unknown';
  let httpStatus;
  let responseSha256;
  try {
    const payload = { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, output_format: IMAGE_OUTPUT_FORMAT, images };
    const headers = { 'content-type': 'application/json' };
    if (process.env.NINEROUTER_KEY) headers.authorization = `Bearer ${process.env.NINEROUTER_KEY}`;
    const response = await request(IMAGE_ENDPOINT, {
      method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(300_000),
    });
    httpStatus = response.status;
    if (!response.ok) {
      state = httpStatus >= 500 || httpStatus === 408 ? 'unknown' : 'failed';
      if (lookaheadDir) await save({ state, http_status: httpStatus });
    }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Response too large');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.byteLength;
      if (length > MAX_IMAGE_BYTES) throw new Error('Response too large');
      chunks.push(chunk);
    }
    const raw = join(confinedWork, 'response.bin');
    const bytes = Buffer.concat(chunks);
    responseSha256 = sha256Bytes(bytes);
    if (response.ok) {
      state = 'received';
      // Record the expected hash first so a complete raw file survives a crash after writing.
      await save({ state, http_status: httpStatus, response_sha256: responseSha256 });
    }
    await writeFile(raw, bytes, { flag: 'wx', mode: 0o600 });
    if (!response.ok) throw new Error('Image API did not succeed');
    const image = await normalizeImage(raw, confinedWork, responseSha256);
    await save({ state: 'succeeded', http_status: httpStatus, response_sha256: responseSha256, ...image });
    return join(confinedWork, image.output.file);
  } catch (error) {
    const code = state === 'received' ? 'normalize_failed' : state;
    await save({ state: code, http_status: httpStatus, response_sha256: responseSha256,
      error_code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'IMG_TIMEOUT' : undefined });
    throw new Error(`Image job ${code}; inspect status.json and saved response. Do not retry the API blindly.`);
  }
}

export async function recoverAttempt(episodeDir, name, { note } = {}) {
  const dir = resolve(episodeDir);
  return withEpisodeLock(dir, async () => {
    const attempts = await episodeAttempts(dir);
    const selected = stripDotSlash(name);
    const attempt = attempts.find(a => a.name === selected || a.path === selected);
    const blocked = blockingAttempt(attempts);
    if (await activeLookahead(dir, blocked)) throw new Error('Wait for the lookahead request to finish; run handoff');
    const damaged = attempt?.state === 'succeeded' && !await verifiedDraft(dir, attempt);
    if (!attempt || (blocked ? attempt !== blocked : !damaged)) throw new Error('Select the blocking or damaged attempt from handoff');
    const work = join(dir, attempt.path);
    const status = await readEpisodeJson(join(work, 'status.json'), dir);
    const raw = await verifiedRawResponse(dir, attempt);
    if (note !== undefined) {
      if (typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 4000) throw new Error('Reconciliation requires an explanation (up to 4000 bytes)');
      if (raw) throw new Error('Verified response image is recoverable; use --normalize instead of --reconcile');
      await saveStatus(work, { ...status, previous_state: status.state, state: 'reconciled_failed', reconcile_note: note.trim() });
      return { reconciled: attempt.path };
    }
    if (!raw) throw new Error('No verified response image to recover; reconcile with the server before resending');
    try {
      const result = await normalizeImage(raw, work, attempt.response_sha256);
      await saveStatus(work, { ...status, ...result, state: 'succeeded' });
      return join(work, result.output.file);
    } catch {
      if (!damaged) await saveStatus(work, { ...status, state: 'normalize_failed' });
      throw new Error('Local image normalization failed; no API call made');
    }
  }, { timeoutMs: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, dir, arg, extra, ...rest] = process.argv.slice(2);
  try {
    let result;
    if (['--slide', '--lookahead'].includes(command) && dir && arg && extra === undefined) {
      result = await draw({ episodeDir: dir, slide: Number(arg), lookahead: command === '--lookahead' });
    } else if (command === '--character' && dir && arg && extra) result = await draw({ episodeDir: dir, target: arg, promptFile: extra, references: rest });
    else if (command === '--normalize' && dir && arg && extra === undefined) result = await recoverAttempt(dir, arg);
    else if (command === '--reconcile' && dir && arg && extra === '--note' && rest.length === 1) result = await recoverAttempt(dir, arg, { note: rest[0] });
    else throw new Error('Usage: draw-image.mjs --slide|--lookahead DIR N | --character DIR ID/VERSION PROMPT [REF ...] | --normalize DIR ATTEMPT | --reconcile DIR ATTEMPT --note "verified outcome"');
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
