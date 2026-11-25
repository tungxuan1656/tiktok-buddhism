import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { computeRequestFingerprint, sha256Bytes } from './lib/fingerprint.mjs';
import { withEpisodeLock } from './lib/lock.mjs';
import { countsAgainstSlideBudget, draftRevision, findOutputReuse, outputRevisions, readAttemptRecord, readRejection } from './lib/resume.mjs';
import {
  confineExistingPath,
  confineTargetPath,
  isSafeAttempt,
  isSafeRevision,
  writeAtomic,
} from './lib/paths.mjs';
import {
  IMAGE_ENDPOINT,
  IMAGE_MODEL,
  IMAGE_OUTPUT_FORMAT,
  IMAGE_SIZE,
  MAX_ATTEMPTS_PER_SLIDE,
  MAX_EPISODE_JSON_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_BYTES,
  MAX_REFS,
  MAX_SLIDES,
  MAX_TOTAL_REF_BYTES,
  OUTPUT_HEIGHT,
  OUTPUT_QUALITY,
  OUTPUT_SAMPLING,
  OUTPUT_WIDTH,
  RECONCILED_STATES,
  REPO_ROOT,
  UNRESOLVED_STATES,
} from './lib/policy.mjs';
import { imageMime, isSha256, readImageInfo, validateEpisodeData } from './lib/schema.mjs';

export { imageMime };

const exec = promisify(execFile);
const pad3 = n => String(n).padStart(3, '0');

function allowedRefRoots(episodeDir) {
  return [episodeDir, join(REPO_ROOT, 'references'), join(REPO_ROOT, 'characters')];
}

function promptMetaPathFor(promptFile) {
  return promptFile.endsWith('.txt')
    ? `${promptFile.slice(0, -4)}.meta.json`
    : `${promptFile}.meta.json`;
}

async function assertCanonicalDraftDir(episodeDir, workDir, { slide, character }) {
  const draftsDir = await confineTargetPath(episodeDir, 'drafts');
  await mkdir(draftsDir, { recursive: true, mode: 0o700 });
  const confinedWork = await confineTargetPath(episodeDir, workDir);
  if (resolve(dirname(confinedWork)) !== resolve(draftsDir)) {
    throw new Error(`Draft directory must live directly under episode drafts/: ${workDir}`);
  }
  const name = basename(confinedWork);
  if (!character) {
    const m = /^(\d{3})-(r\d{2,})-([a-z0-9-]+)$/i.exec(name);
    if (!m || Number(m[1]) !== slide || !isSafeRevision(m[2]) || !isSafeAttempt(m[3])) {
      throw new Error(`Draft directory name "${name}" must follow NNN-rNN-attempt for slide ${slide} (e.g. ${pad3(slide)}-r01-a1)`);
    }
  } else if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new Error(`Invalid character draft directory name: "${name}"`);
  }
  return { draftsDir, confinedWork };
}

async function loadEpisodeAndValidate(episodeFile, { slide, character = false, allowAnySlide = false, onGate } = {}) {
  const resolvedEpisode = resolve(episodeFile);
  const episodeDir = dirname(resolvedEpisode);
  onGate?.('script_invalid');
  const checkedEp = await confineExistingPath([episodeDir], resolvedEpisode, { requireRegularFile: true });
  if (checkedEp.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Script too large');
  const episode = JSON.parse(await readFile(checkedEp.real, 'utf8'));

  onGate?.('script_count');
  if (!Array.isArray(episode.slides) || episode.slides.length < 1 || episode.slides.length > MAX_SLIDES) {
    throw new Error(`Script must contain 1-${MAX_SLIDES} slides`);
  }

  onGate?.('slide_invalid');
  const invalidSlide = episode.slides.some(page => typeof page?.text !== 'string' || !page.text.trim()) ||
    (!allowAnySlide && (character ? slide !== undefined : !Number.isSafeInteger(slide) || slide < 1 || slide > episode.slides.length));
  if (invalidSlide) throw new Error('Invalid planned slide');

  onGate?.('episode_invalid');
  const validation = await validateEpisodeData(episode, episodeDir, { stage: character ? 'character' : 'draw' });
  if (!validation.ok) {
    throw new Error(`Invalid episode schema/content: ${validation.issues.join('; ')}`);
  }
  onGate?.(undefined);
  return { episode, episodeDir, resolvedEpisode: checkedEp.real, validation };
}

async function checkAttemptHistory({ draftsDir, episodeFile, slide, character, targetDraftName, requestSha256, slideContentSha256, allowRepeat, replaceUnverified, checkBudget = true }) {
  const targetRev = draftRevision(targetDraftName);
  let attempts = 0;
  let matchingSuccess;
  let matchingDraft;
  for (const entry of await readdir(draftsDir)) {
    const entryDir = join(draftsDir, entry);
    if (!(await lstat(entryDir)).isDirectory()) continue;
    const record = await readAttemptRecord(entryDir, entry);
    if (!record || record.mode === 'normalize' || record.state === 'invalid_input') continue;
    const plan = record.plan;
    const recordedEpisode = await realpath(plan.file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return resolve(plan.file);
    });
    if (recordedEpisode !== episodeFile || plan.character !== character || (!character && plan.slide !== slide)) continue;
    if (UNRESOLVED_STATES.has(record.state)) {
      throw new Error(`Unresolved attempt "${entry}" for ${character ? 'character' : `slide ${slide}`} has state "${record.state}". Reconcile it first before creating a new attempt.`);
    }
    if (!character && countsAgainstSlideBudget(entry, targetRev)) attempts++;
    if (!character && record.state === 'succeeded') {
      if (isSha256(requestSha256) && record.request_sha256 === requestSha256) matchingSuccess = entry;
      if (isSha256(slideContentSha256) && record.slide_content_sha256 === slideContentSha256 && isSha256(record.output?.sha256)) matchingDraft = entry;
    }
  }
  if (checkBudget && !character && attempts >= MAX_ATTEMPTS_PER_SLIDE) {
    throw new Error(`Attempt limit (${MAX_ATTEMPTS_PER_SLIDE}) reached for slide ${slide}`);
  }
  if (matchingSuccess && !allowRepeat) {
    throw new Error(`Identical request already succeeded in drafts/${matchingSuccess}; reuse it or explicitly pass --allow-repeat after inspection.`);
  }
  if (matchingDraft && !replaceUnverified && !(matchingSuccess && allowRepeat)) {
    throw new Error(`Matching slide draft already succeeded in drafts/${matchingDraft}; review it before drawing a replacement.`);
  }
}

async function outputBeforeDraw(episodeDir, slide, slideSha256, draftName) {
  return findOutputReuse(episodeDir, slide, slideSha256, draftRevision(draftName), await outputRevisions(episodeDir));
}

function reuseError(slide, candidate) {
  return new Error(`Image job not sent: slide ${slide} has ${candidate.action} at ${candidate.file}; run episode-tools.mjs handoff before drawing.`);
}

async function readAndCheckReferences(references, episodeDir, { includeBytes = true, maxTotalBytes = MAX_TOTAL_REF_BYTES } = {}) {
  if (!Array.isArray(references) || references.length > MAX_REFS) {
    throw new Error(`Too many reference images (max ${MAX_REFS})`);
  }
  const roots = allowedRefRoots(episodeDir);
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

async function verifySlidePromptProvenance({ episodeDir, promptFile, slide, slideContentSha256, promptSha256, refs, characters }) {
  const metaPath = promptMetaPathFor(promptFile);
  const checkedMeta = await confineExistingPath([episodeDir], metaPath, { requireRegularFile: true }).catch(() => null);
  if (!checkedMeta) {
    throw new Error(`Missing prompt provenance metadata (${basename(metaPath)}); generate prompts via episode-tools build-prompts`);
  }
  if (checkedMeta.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Prompt metadata too large');
  const meta = JSON.parse(await readFile(checkedMeta.real, 'utf8'));
  if (meta.slide !== slide) {
    throw new Error(`Prompt metadata mismatch: expected slide ${slide}, got ${meta.slide}`);
  }
  if (meta.slide_content_sha256 !== slideContentSha256) {
    throw new Error(`Stale prompt for slide ${slide}: episode content or character snapshots changed; rebuild prompts first`);
  }
  if (meta.prompt_sha256 !== promptSha256) {
    throw new Error(`Prompt ${basename(promptFile)} was modified manually without build-prompts --override acknowledgement`);
  }
  if (!isSha256(meta.style_ref_sha256)) throw new Error(`Missing style reference provenance for slide ${slide}`);
  const required = [meta.style_ref_sha256, ...characters.flatMap(c => c.refInfos.map(r => r.sha256))];
  if (required.some((hash, i) => refs[i]?.sha256 !== hash)) {
    throw new Error(`Reference mismatch for slide ${slide}: supply the style and character snapshots in manifest order`);
  }
}

/** Execute one image generation or local normalization into a canonical draft directory. */
export async function draw({
  promptFile,
  workDir,
  references = [],
  normalizeFrom,
  episodeFile,
  slide,
  character = false,
  request = fetch,
  skipMagickCheck = false,
  expectedRequestSha256,
  allowRepeat = false,
  replaceUnverified = false,
  maxTotalRefBytes = MAX_TOTAL_REF_BYTES,
}) {
  if ((Array.isArray(references) && references.length > MAX_REFS) || (normalizeFrom && (promptFile || references.length))) {
    throw new Error('Invalid arguments');
  }
  if (!skipMagickCheck) await exec('magick', ['-version'], { timeout: 10_000 });

  if (normalizeFrom) {
    return normalizeAttempt({ normalizeFrom, workDir });
  }

  const preloaded = await loadEpisodeAndValidate(episodeFile, { slide, character }).catch(err => ({ gateFailure: err }));
  if (preloaded?.gateFailure) {
    const resolvedWork = resolve(workDir);
    const episodeDir = dirname(resolve(episodeFile));
    await confineTargetPath(episodeDir, resolvedWork);
    await mkdir(dirname(resolvedWork), { recursive: true });
    await mkdir(resolvedWork, { mode: 0o700 });
    const statusTmp = join(resolvedWork, 'status.tmp');
    let gateError = 'episode_invalid';
    if (/Script too large|JSON/.test(preloaded.gateFailure.message)) gateError = 'script_invalid';
    else if (/Script must contain/.test(preloaded.gateFailure.message)) gateError = 'script_count';
    else if (/Invalid planned slide/.test(preloaded.gateFailure.message)) gateError = 'slide_invalid';
    await writeFile(statusTmp, `${JSON.stringify({ state: 'invalid_input', gate_error: gateError }, null, 2)}\n`, { mode: 0o600 });
    await rename(statusTmp, join(resolvedWork, 'status.json'));
    throw new Error(`Image job invalid_input (${gateError}: require a saved script with 1-${MAX_SLIDES} slides and a valid slide/character selection); inspect status.json and saved response. Do not retry the API blindly.`);
  }

  const { episode, episodeDir, resolvedEpisode, validation } = preloaded;
  const { draftsDir, confinedWork } = await assertCanonicalDraftDir(episodeDir, workDir, { slide, character });

  const plan = { file: resolvedEpisode, count: episode.slides.length, slide, character };
  const slideContentSha256 = character ? null : validation.slideFingerprints[slide - 1];

  const checkedPrompt = await confineExistingPath([episodeDir], promptFile, { requireRegularFile: true });
  if (checkedPrompt.stat.size > MAX_PROMPT_BYTES) throw new Error('Prompt file too large');
  const promptBytes = await readFile(checkedPrompt.real);
  const prompt = promptBytes.toString('utf8');
  if (!prompt.trim()) throw new Error('Empty prompt');
  const promptSha256 = sha256Bytes(promptBytes);

  const { refs, images } = await readAndCheckReferences(references, episodeDir, { includeBytes: true, maxTotalBytes: maxTotalRefBytes });
  if (!character) {
    await verifySlidePromptProvenance({ episodeDir, promptFile: checkedPrompt.real, slide, slideContentSha256, promptSha256, refs, characters: validation.resolvedCharsBySlide[slide - 1] });
  }
  const requestSha256 = computeRequestFingerprint({
    slideContentSha256,
    promptSha256,
    referenceHashes: refs.map(r => r.sha256),
  });

  if (expectedRequestSha256 !== undefined && requestSha256 !== expectedRequestSha256) {
    throw new Error(`Stale manifest for slide ${slide}: request fingerprint changed before POST`);
  }

  const immutableMeta = {
    schema_version: 2,
    plan,
    model: IMAGE_MODEL,
    slide_content_sha256: slideContentSha256,
    prompt_sha256: promptSha256,
    request_sha256: requestSha256,
  };

  return withEpisodeLock(episodeDir, async () => {
    const existsWork = await lstat(confinedWork).then(() => true, err => (err.code === 'ENOENT' ? false : Promise.reject(err)));
    if (existsWork) {
      const err = new Error('Draft directory already exists; no API call was made.');
      err.code = 'EEXIST';
      throw err;
    }
    if (!character) {
      const reusable = await outputBeforeDraw(episodeDir, slide, slideContentSha256, basename(confinedWork));
      if (reusable && !(replaceUnverified && ['review_output', 'repair'].includes(reusable.action))) throw reuseError(slide, reusable);
    }
    await checkAttemptHistory({ draftsDir, episodeFile: resolvedEpisode, slide, character,
      targetDraftName: basename(confinedWork), requestSha256, slideContentSha256, allowRepeat, replaceUnverified });
    // Until the rename registers it, no POST is possible and retention must not see an unresolved attempt.
    const staging = await mkdtemp(join(episodeDir, '.register-'));
    try {
      await writeFile(join(staging, 'request.json'), `${JSON.stringify({
        ...immutableMeta, prompt, size: IMAGE_SIZE, output_format: IMAGE_OUTPUT_FORMAT, reference_count: images.length,
      })}\n`, { mode: 0o600 });
      await writeFile(join(staging, 'references.json'), `${JSON.stringify(refs, null, 2)}\n`, { mode: 0o600 });
      await saveStatus(staging, { ...immutableMeta, state: 'in_flight' });
      await rename(staging, confinedWork);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return executeRequest({ confinedWork, immutableMeta, prompt, images, request });
  }, { timeoutMs: 0 });
}

const saveStatus = (dir, record) => writeAtomic(join(dir, 'status.json'), `${JSON.stringify(record, null, 2)}\n`, 0o600);

async function normalizeImage(raw, dir) {
  const source = await readImageInfo(raw);
  const output = join(dir, 'image.jpg');
  await exec('magick', [raw, '-auto-orient', '-colorspace', 'sRGB', '-background', 'white',
    '-alpha', 'remove', '-alpha', 'off', '-resize', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`, '-gravity', 'center', '-extent', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
    '-strip', '-sampling-factor', OUTPUT_SAMPLING, '-quality', String(OUTPUT_QUALITY), output], { timeout: 60_000 });
  const final = await readImageInfo(output, { requireNormalized1080: true });
  if (final.mime !== 'image/jpeg') throw new Error('Invalid normalized output');
  return { source, output: { file: 'image.jpg', ...final, quality: OUTPUT_QUALITY, sampling: OUTPUT_SAMPLING } };
}

async function executeRequest({ confinedWork, immutableMeta, prompt, images, request }) {
  const save = record => saveStatus(confinedWork, { ...immutableMeta, ...record });
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
    await writeFile(raw, bytes, { flag: 'wx', mode: 0o600 });
    responseSha256 = sha256Bytes(bytes);
    if (!response.ok) {
      state = httpStatus >= 500 || httpStatus === 408 ? 'unknown' : 'failed';
      throw new Error('Image API did not succeed');
    }
    state = 'received';
    await save({ state, http_status: httpStatus, response_sha256: responseSha256 });
    const image = await normalizeImage(raw, confinedWork);
    await save({ state: 'succeeded', http_status: httpStatus, response_sha256: responseSha256, ...image });
    return join(confinedWork, image.output.file);
  } catch {
    const code = state === 'received' ? 'normalize_failed' : state;
    await save({ state: code, http_status: httpStatus, response_sha256: responseSha256 });
    throw new Error(`Image job ${code}; inspect status.json and saved response. Do not retry the API blindly.`);
  }
}

async function normalizeAttempt({ normalizeFrom, workDir }) {
  const input = resolve(normalizeFrom);
  const origin = dirname(input);
  const checked = await confineExistingPath([origin], input, { requireRegularFile: true });
  if (checked.stat.size > MAX_IMAGE_BYTES || checked.stat.size <= 0) throw new Error('Invalid image size');
  if (!workDir) {
    const draft = dirname(checked.real);
    const episodeDir = dirname(dirname(draft));
    if (basename(input) !== 'response.bin' || basename(dirname(draft)) !== 'drafts') {
      throw new Error('Attempt recovery requires drafts/ATTEMPT/response.bin');
    }
    return withEpisodeLock(episodeDir, async () => {
      const rec = await readAttemptRecord(draft, basename(draft));
      if (!['received', 'normalize_failed'].includes(rec?.state) || !isSha256(rec.request_sha256) || !isSha256(rec.response_sha256)) {
        throw new Error('Attempt recovery requires a received response with recorded SHA-256 provenance');
      }
      const bytes = await readFile(checked.real);
      if (bytes.length > MAX_IMAGE_BYTES || sha256Bytes(bytes) !== rec.response_sha256) throw new Error('Recorded response SHA-256 mismatch');
      try {
        const image = await normalizeImage(checked.real, draft);
        if (image.source.sha256 !== rec.response_sha256) throw new Error('Recorded response SHA-256 mismatch');
        await saveStatus(draft, { ...rec, ...image, state: 'succeeded' });
        return join(draft, image.output.file);
      } catch {
        await saveStatus(draft, { ...rec, state: 'normalize_failed' });
        throw new Error('Image job normalize_failed; inspect status.json and saved response. Do not retry the API blindly.');
      }
    }, { timeoutMs: 0 });
  }

  // A standalone conversion never inherits request provenance from its input directory.
  const target = await confineTargetPath(dirname(resolve(workDir)), basename(resolve(workDir)));
  await mkdir(target, { mode: 0o700 });
  try {
    const raw = join(target, 'response.bin');
    await writeFile(raw, await readFile(checked.real), { flag: 'wx', mode: 0o600 });
    const image = await normalizeImage(raw, target);
    await saveStatus(target, { state: 'succeeded', mode: 'normalize', ...image });
    return join(target, image.output.file);
  } catch {
    await saveStatus(target, { state: 'normalize_failed', mode: 'normalize' });
    throw new Error('Image job normalize_failed; inspect status.json and saved response. Do not retry the API blindly.');
  }
}

/** Explicitly reconcile an unresolved API attempt before creating a retry attempt. */
export async function reconcileAttempt({ workDir, resolution, note }) {
  if (!RECONCILED_STATES.has(resolution)) {
    throw new Error(`Invalid resolution "${resolution}" (expected ${[...RECONCILED_STATES].join('|')})`);
  }
  if (typeof note !== 'string' || !note.trim()) {
    throw new Error('Reconciling an attempt requires a non-empty --note describing verification');
  }
  const dir = resolve(workDir);
  const checkedDir = await confineExistingPath([dirname(dir)], dir, { requireRegularFile: false });
  if (!checkedDir.stat.isDirectory()) throw new Error(`Not a draft directory: ${workDir}`);
  const checkedStatus = await confineExistingPath([checkedDir.real], join(checkedDir.real, 'status.json'), { requireRegularFile: true });
  const current = JSON.parse(await readFile(checkedStatus.real, 'utf8'));
  if (!UNRESOLVED_STATES.has(current?.state)) {
    throw new Error(`Draft "${workDir}" is in state "${current?.state}", not an unresolved state`);
  }

  const reqPath = join(checkedDir.real, 'request.json');
  const req = await lstat(reqPath).then(s => s.isFile(), () => false)
    ? JSON.parse(await readFile(reqPath, 'utf8'))
    : null;

  const writeReconciled = async () => {
    const fresh = JSON.parse(await readFile(checkedStatus.real, 'utf8'));
    if (!UNRESOLVED_STATES.has(fresh?.state)) {
      throw new Error(`Draft "${workDir}" is already in state "${fresh?.state}"`);
    }
    const updated = {
      ...(req?.plan ? { plan: req.plan } : {}),
      ...(req?.slide_content_sha256 !== undefined ? { slide_content_sha256: req.slide_content_sha256 } : {}),
      ...(req?.prompt_sha256 !== undefined ? { prompt_sha256: req.prompt_sha256 } : {}),
      ...(req?.request_sha256 !== undefined ? { request_sha256: req.request_sha256 } : {}),
      ...fresh,
      previous_state: fresh.state,
      state: resolution,
      reconciled_at: new Date().toISOString(),
      reconcile_note: note.trim(),
    };
    const tmp = join(checkedDir.real, 'status.tmp');
    await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, join(checkedDir.real, 'status.json'));
    return updated;
  };

  const epFile = req?.plan?.file ?? current?.plan?.file;
  return epFile
    ? withEpisodeLock(dirname(resolve(epFile)), writeReconciled, { timeoutMs: 0 })
    : writeReconciled();
}

/** Validate the whole batch manifest up front, skip verified matching drafts, and run remaining slides sequentially. */
export async function drawBatch({ episodeFile, manifestFile, request = fetch }) {
  await exec('magick', ['-version'], { timeout: 10_000 });
  const { episode, episodeDir, resolvedEpisode, validation } = await loadEpisodeAndValidate(episodeFile, { allowAnySlide: true });
  const checkedManifest = await confineExistingPath([episodeDir], manifestFile, { requireRegularFile: true });
  if (checkedManifest.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Batch manifest too large');
  const entries = JSON.parse(await readFile(checkedManifest.real, 'utf8'));

  if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid batch manifest');
  if (entries.length > episode.slides.length || entries.length > MAX_SLIDES) {
    throw new Error(`Too many batch entries (${entries.length} > ${Math.min(episode.slides.length, MAX_SLIDES)})`);
  }

  const seenWorkDirs = new Set();
  const seenSlides = new Set();
  const pending = [];
  const skipped = [];

  for (const item of entries) {
    if (!Number.isSafeInteger(item?.slide) || item.slide < 1 || item.slide > episode.slides.length) {
      throw new Error(`Invalid batch slide number: ${item?.slide}`);
    }
    if (seenSlides.has(item.slide)) {
      throw new Error(`Duplicate slide ${item.slide} in batch manifest`);
    }
    seenSlides.add(item.slide);

    if (typeof item?.workDir !== 'string' || !item.workDir.trim()) {
      throw new Error(`Batch slide ${item.slide}: missing workDir`);
    }
    if (!isSha256(item.slide_content_sha256) || !isSha256(item.prompt_sha256) || !isSha256(item.request_sha256)) {
      throw new Error(`Batch slide ${item.slide}: manifest must include slide_content_sha256, prompt_sha256, and request_sha256; rebuild prompts`);
    }

    const { draftsDir, confinedWork } = await assertCanonicalDraftDir(episodeDir, item.workDir, { slide: item.slide, character: false });
    if (seenWorkDirs.has(confinedWork)) {
      throw new Error(`Duplicate batch workDir at slide ${item.slide}: ${item.workDir}`);
    }
    seenWorkDirs.add(confinedWork);

    const checkedPrompt = await confineExistingPath([episodeDir], item.promptFile, { requireRegularFile: true });
    if (checkedPrompt.stat.size > MAX_PROMPT_BYTES) throw new Error(`Batch slide ${item.slide}: promptFile too large`);
    const promptBytes = await readFile(checkedPrompt.real);
    if (!promptBytes.toString('utf8').trim()) throw new Error(`Batch slide ${item.slide}: empty promptFile`);
    const promptSha256 = sha256Bytes(promptBytes);

    const { refs } = await readAndCheckReferences(item.references ?? [], episodeDir, { includeBytes: false });
    const slideContentSha256 = validation.slideFingerprints[item.slide - 1];
    await verifySlidePromptProvenance({ episodeDir, promptFile: checkedPrompt.real, slide: item.slide, slideContentSha256, promptSha256, refs, characters: validation.resolvedCharsBySlide[item.slide - 1] });
    const expectedRequestSha256 = computeRequestFingerprint({
      slideContentSha256,
      promptSha256,
      referenceHashes: refs.map(r => r.sha256),
    });

    if (item.slide_content_sha256 !== slideContentSha256) {
      throw new Error(`Batch slide ${item.slide}: stale manifest (episode content changed); rebuild prompts`);
    }
    if (item.prompt_sha256 !== promptSha256) {
      throw new Error(`Batch slide ${item.slide}: stale manifest (prompt file changed); rebuild prompts`);
    }
    if (item.request_sha256 !== expectedRequestSha256) {
      throw new Error(`Batch slide ${item.slide}: stale manifest (request fingerprint mismatch); rebuild prompts`);
    }

    const reusable = await outputBeforeDraw(episodeDir, item.slide, slideContentSha256, basename(confinedWork));
    if (reusable?.action === 'keep') {
      skipped.push(item.slide);
      continue;
    }
    if (reusable) throw reuseError(item.slide, reusable);

    const workExists = await lstat(confinedWork).then(() => true, err => (err.code === 'ENOENT' ? false : Promise.reject(err)));
    if (workExists) {
      const checkedStatus = await confineExistingPath([confinedWork], join(confinedWork, 'status.json'), { requireRegularFile: true }).catch(() => null);
      if (!checkedStatus || checkedStatus.stat.size > MAX_EPISODE_JSON_BYTES) {
        throw new Error(`Batch stopped at slide ${item.slide}: draft directory already exists without valid status.json`);
      }
      const existing = JSON.parse(await readFile(checkedStatus.real, 'utf8'));
      if (existing.state === 'succeeded') {
        await checkAttemptHistory({
          draftsDir,
          episodeFile: resolvedEpisode,
          slide: item.slide,
          character: false,
          targetDraftName: basename(confinedWork),
          checkBudget: false,
        });
        if (existing.request_sha256 !== expectedRequestSha256 || existing.slide_content_sha256 !== slideContentSha256) {
          throw new Error(`Batch stopped at slide ${item.slide}: existing succeeded draft does not match current request fingerprint; rebuild or use a new attempt`);
        }
        const checkedImg = await confineExistingPath([confinedWork], join(confinedWork, 'image.jpg'), { requireRegularFile: true });
        const imgInfo = await readImageInfo(checkedImg.real, { requireNormalized1080: true });
        if (!existing.output?.sha256 || imgInfo.sha256 !== existing.output.sha256) {
          throw new Error(`Batch stopped at slide ${item.slide}: existing image.jpg failed SHA-256 verification`);
        }
        const file = relative(episodeDir, join(confinedWork, 'image.jpg'));
        if (await readRejection(episodeDir, slideContentSha256, imgInfo.sha256)) {
          throw reuseError(item.slide, { action: 'repair', file });
        }
        skipped.push(item.slide);
        continue;
      }
      throw new Error(`Batch stopped at slide ${item.slide}: existing draft has state ${existing.state}`);
    }

    await checkAttemptHistory({
      draftsDir,
      episodeFile: resolvedEpisode,
      slide: item.slide,
      character: false,
      targetDraftName: basename(confinedWork),
      requestSha256: expectedRequestSha256,
      slideContentSha256,
    });
    pending.push(item);
  }

  const completed = [];
  for (const item of pending) {
    try {
      const output = await draw({
        episodeFile,
        slide: item.slide,
        promptFile: item.promptFile,
        workDir: item.workDir,
        references: item.references ?? [],
        request,
        skipMagickCheck: true,
        expectedRequestSha256: item.request_sha256,
      });
      completed.push({ slide: item.slide, output });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Batch stopped at slide ${item.slide} (completed=${completed.length}, skipped=${skipped.length}): ${msg}`);
    }
  }
  return { ok: true, completed, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const slideFlags = new Set();
  if (args[0] === '--slide') {
    while (['--allow-repeat', '--replace-unverified'].includes(args.at(-1))) slideFlags.add(args.pop());
  }
  if (args[0] === '--reconcile') {
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        strict: true,
        options: {
          resolution: { type: 'string' },
          note: { type: 'string' },
        },
      });
      if (positionals.length !== 1) throw new Error('Usage: node scripts/draw-image.mjs --reconcile DRAFT_DIR --resolution reconciled_failed|reconciled_superseded --note "..."');
      console.log(JSON.stringify(await reconcileAttempt({ workDir: positionals[0], resolution: values.resolution, note: values.note })));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (!((args[0] === '--normalize' && (args.length === 2 || args.length === 3)) || (args[0] === '--batch' && args.length === 3) || (args[0] === '--slide' && args.length >= 5) || (args[0] === '--character' && args.length >= 4))) {
    console.error('Usage: node scripts/draw-image.mjs --slide EPISODE_JSON SLIDE_NUMBER PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...] [--allow-repeat] [--replace-unverified]\n       node scripts/draw-image.mjs --batch EPISODE_JSON BATCH_MANIFEST_JSON\n       node scripts/draw-image.mjs --character EPISODE_JSON PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...]\n       node scripts/draw-image.mjs --normalize RESPONSE_FILE [NEW_DRAFT_DIR]\n       node scripts/draw-image.mjs --reconcile DRAFT_DIR --resolution reconciled_failed|reconciled_superseded --note "..."');
    process.exitCode = 1;
  } else if (args[0] === '--batch') {
    try { console.log(JSON.stringify(await drawBatch({ episodeFile: args[1], manifestFile: args[2] }))); }
    catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    const options = args[0] === '--normalize' ? { normalizeFrom: args[1], workDir: args[2] }
      : args[0] === '--character' ? { episodeFile: args[1], character: true, promptFile: args[2], workDir: args[3], references: args.slice(4) }
        : { episodeFile: args[1], slide: Number(args[2]), promptFile: args[3], workDir: args[4], references: args.slice(5), allowRepeat: slideFlags.has('--allow-repeat'), replaceUnverified: slideFlags.has('--replace-unverified') };
    try { console.log(await draw(options)); }
    catch (error) {
      console.error(error.code === 'EEXIST' ? 'Draft directory already exists; no API call was made.'
        : error.message.startsWith('Image job ') || error.message.startsWith('Unresolved attempt') || error.message.startsWith('Attempt limit') || error.message.startsWith('Stale prompt') || error.message.startsWith('Missing prompt') || error.message.startsWith('Draft directory') || error.message.startsWith('Identical request') || error.message.startsWith('Reference mismatch') || error.message.startsWith('Timed out waiting for episode lock') || error.message.startsWith('Attempt recovery') || error.message.startsWith('Recorded response') || error.message.startsWith('Corrupted attempt')
          ? error.message : 'Image job could not start; check arguments and a new draft directory.');
      process.exitCode = 1;
    }
  }
}
