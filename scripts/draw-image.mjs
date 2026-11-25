import { lstat, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { computeRequestFingerprint, sha256Bytes } from './lib/fingerprint.mjs';
import {
  confineExistingPath,
  confineTargetPath,
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
import { imageMime, readImageInfo, validateEpisodeData } from './lib/schema.mjs';

export { imageMime };

const exec = promisify(execFile);

function allowedRefRoots(episodeDir) {
  return [episodeDir, join(REPO_ROOT, 'references'), join(REPO_ROOT, 'characters')];
}

function revisionFromDraftName(name) {
  const m = /^\d{3}-(r\d{2,})(?:-|$)/i.exec(name);
  return m ? m[1] : null;
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
  return { episode, episodeDir, resolvedEpisode, validation };
}

async function checkAttemptHistory({ draftsParent, episodeFile, slide, character, targetDraftName, checkBudget = true }) {
  const exists = await lstat(draftsParent).then(st => st.isDirectory(), () => false);
  if (!exists) return;
  const targetRev = revisionFromDraftName(targetDraftName);
  const resolvedEpisode = resolve(episodeFile);
  let attempts = 0;

  for (const entry of await readdir(draftsParent)) {
    const statusPath = join(draftsParent, entry, 'status.json');
    const stFile = await lstat(statusPath).catch(() => null);
    if (!stFile?.isFile()) continue;
    let rec;
    try { rec = JSON.parse(await readFile(statusPath, 'utf8')); }
    catch { continue; }

    if (rec?.mode === 'normalize') continue;
    const plan = rec?.plan;
    if (!plan || resolve(String(plan.file ?? '')) !== resolvedEpisode) continue;
    if (Boolean(plan.character) !== Boolean(character)) continue;
    if (!character && plan.slide !== slide) continue;

    if (UNRESOLVED_STATES.has(rec.state)) {
      throw new Error(`Unresolved attempt "${entry}" for ${character ? 'character' : `slide ${slide}`} has state "${rec.state}". Reconcile it first before creating a new attempt.`);
    }
    const entryRev = revisionFromDraftName(entry);
    if (!character && rec.state !== 'invalid_input' && (!targetRev || !entryRev || entryRev === targetRev)) {
      attempts++;
    }
  }
  if (checkBudget && !character && attempts >= MAX_ATTEMPTS_PER_SLIDE) {
    throw new Error(`Attempt limit (${MAX_ATTEMPTS_PER_SLIDE}) reached for slide ${slide}`);
  }
}

async function readAndCheckReferences(references, episodeDir) {
  if (!Array.isArray(references) || references.length > MAX_REFS) {
    throw new Error(`Too many reference images (max ${MAX_REFS})`);
  }
  const roots = allowedRefRoots(episodeDir);
  const refs = [];
  const images = [];
  let totalBytes = 0;

  for (const refPath of references) {
    const checked = await confineExistingPath(roots, refPath, { requireRegularFile: true });
    const info = await readImageInfo(checked.real, { includeBytes: true });
    totalBytes += info.bytes;
    if (totalBytes > MAX_TOTAL_REF_BYTES) {
      throw new Error(`Aggregate reference image payload (${totalBytes} bytes) exceeds limit (${MAX_TOTAL_REF_BYTES} bytes)`);
    }
    images.push(`data:${info.mime};base64,${info.buffer.toString('base64')}`);
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

/** Execute one image generation or local normalization into a fresh draft directory. */
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
}) {
  if ((Array.isArray(references) && references.length > MAX_REFS) || (normalizeFrom && (promptFile || references.length))) {
    throw new Error('Invalid arguments');
  }

  let preloaded = null;
  if (!normalizeFrom) {
    preloaded = await loadEpisodeAndValidate(episodeFile, { slide, character }).catch(err => ({ gateFailure: err }));
    if (preloaded?.gateFailure) {
      // Preserve durable invalid_input status artifact when workDir doesn't exist yet (mirrors historical behavior).
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

    const confinedWork = await confineTargetPath(preloaded.episodeDir, workDir);
    const existsWork = await lstat(confinedWork).then(() => true, err => (err.code === 'ENOENT' ? false : Promise.reject(err)));
    if (existsWork) {
      const err = new Error('Draft directory already exists; no API call was made.');
      err.code = 'EEXIST';
      throw err;
    }
    await checkAttemptHistory({
      draftsParent: dirname(confinedWork),
      episodeFile,
      slide,
      character,
      targetDraftName: basename(confinedWork),
    });
  }

  // Exclusive directory creation prevents duplicate calls and overwriting a previous attempt.
  const workRoot = normalizeFrom
    ? await confineTargetPath(dirname(resolve(workDir)), basename(resolve(workDir)))
    : await confineTargetPath(preloaded.episodeDir, workDir);
  await mkdir(dirname(workRoot), { recursive: true });
  await mkdir(workRoot, { mode: 0o700 });
  const save = async record => {
    await writeFile(join(workRoot, 'status.tmp'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(join(workRoot, 'status.tmp'), join(workRoot, 'status.json'));
  };

  let state = 'prepared';
  let httpStatus;
  let source;
  let plan;
  let gateError;
  let slideContentSha256 = null;
  let promptSha256 = null;
  let requestSha256 = null;

  try {
    if (!skipMagickCheck) await exec('magick', ['-version'], { timeout: 10_000 });
    const raw = join(workRoot, 'response.bin');
    if (normalizeFrom) {
      const checkedNorm = await confineExistingPath([dirname(resolve(normalizeFrom))], normalizeFrom, { requireRegularFile: true });
      if (checkedNorm.stat.size > MAX_IMAGE_BYTES || checkedNorm.stat.size <= 0) throw new Error('Invalid image size');
      const bytes = await readFile(checkedNorm.real);
      await writeFile(raw, bytes, { flag: 'wx', mode: 0o600 });
      state = 'received';
      await save({ state, mode: 'normalize', source: checkedNorm.real });
    } else {
      const { episode, episodeDir, validation } = preloaded;
      plan = { file: resolve(episodeFile), count: episode.slides.length, slide, character };
      slideContentSha256 = character ? null : validation.slideFingerprints[slide - 1];

      const checkedPrompt = await confineExistingPath([episodeDir], promptFile, { requireRegularFile: true });
      if (checkedPrompt.stat.size > MAX_PROMPT_BYTES) throw new Error('Prompt file too large');
      const promptBytes = await readFile(checkedPrompt.real);
      const prompt = promptBytes.toString('utf8');
      if (!prompt.trim()) throw new Error('Empty prompt');
      promptSha256 = sha256Bytes(promptBytes);

      const { refs, images } = await readAndCheckReferences(references, episodeDir);
      requestSha256 = computeRequestFingerprint({
        slideContentSha256,
        promptSha256,
        referenceHashes: refs.map(r => r.sha256),
      });

      const payload = { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, output_format: IMAGE_OUTPUT_FORMAT, images };
      await writeFile(
        join(workRoot, 'request.json'),
        `${JSON.stringify({
          ...payload,
          images: undefined,
          reference_count: images.length,
          plan,
          slide_content_sha256: slideContentSha256,
          prompt_sha256: promptSha256,
          request_sha256: requestSha256,
        })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await writeFile(join(workRoot, 'references.json'), `${JSON.stringify(refs, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await save({ state: 'in_flight', model: payload.model, plan, slide_content_sha256: slideContentSha256, request_sha256: requestSha256 });

      state = 'unknown';
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
      await writeFile(raw, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
      if (!response.ok) {
        state = httpStatus >= 500 || httpStatus === 408 ? 'unknown' : 'failed';
        throw new Error('Image API did not succeed');
      }
      state = 'received';
      await save({ state, http_status: httpStatus, slide_content_sha256: slideContentSha256, request_sha256: requestSha256 });
    }

    source = await readImageInfo(raw);
    const output = join(workRoot, 'image.jpg');
    await exec('magick', [raw, '-auto-orient', '-colorspace', 'sRGB', '-background', 'white',
      '-alpha', 'remove', '-alpha', 'off', '-resize', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`, '-gravity', 'center', '-extent', `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
      '-strip', '-sampling-factor', OUTPUT_SAMPLING, '-quality', String(OUTPUT_QUALITY), output], { timeout: 60_000 });
    const final = await readImageInfo(output, { requireNormalized1080: true });
    if (final.mime !== 'image/jpeg') throw new Error('Invalid normalized output');
    await save({
      state: 'succeeded',
      http_status: httpStatus,
      slide_content_sha256: slideContentSha256,
      prompt_sha256: promptSha256,
      request_sha256: requestSha256,
      source,
      output: { file: 'image.jpg', ...final, quality: OUTPUT_QUALITY, sampling: OUTPUT_SAMPLING },
    });
    return output;
  } catch (err) {
    const code = state === 'received' ? 'normalize_failed' : state === 'prepared' ? 'invalid_input' : state;
    await save({
      state: code,
      http_status: httpStatus,
      source,
      gate_error: gateError,
      plan,
      slide_content_sha256: slideContentSha256,
      request_sha256: requestSha256,
    });
    const detail = err instanceof Error && code === 'invalid_input' ? ` (${err.message})` : '';
    throw new Error(`Image job ${code}${gateError ? ` (${gateError}: require a saved script with 1-${MAX_SLIDES} slides and a valid slide/character selection)` : detail}; inspect status.json and saved response. Do not retry the API blindly.`);
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
  const updated = {
    ...current,
    previous_state: current.state,
    state: resolution,
    reconciled_at: new Date().toISOString(),
    reconcile_note: note.trim(),
  };
  const tmp = join(checkedDir.real, 'status.tmp');
  await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(checkedDir.real, 'status.json'));
  return updated;
}

/** Validate the whole batch manifest up front, skip verified matching drafts, and run remaining slides sequentially. */
export async function drawBatch({ episodeFile, manifestFile, request = fetch }) {
  await exec('magick', ['-version'], { timeout: 10_000 });
  const { episode, episodeDir, validation } = await loadEpisodeAndValidate(episodeFile, { allowAnySlide: true });
  const checkedManifest = await confineExistingPath([episodeDir], manifestFile, { requireRegularFile: true });
  const entries = JSON.parse(await readFile(checkedManifest.real, 'utf8'));

  if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid batch manifest');
  if (entries.length > episode.slides.length || entries.length > MAX_SLIDES) {
    throw new Error(`Too many batch entries (${entries.length} > ${Math.min(episode.slides.length, MAX_SLIDES)})`);
  }

  const seenWorkDirs = new Set();
  const seenSlides = new Set();
  const pending = [];
  const skipped = [];

  // Preflight every entry before any API POST so an invalid or stale later item never triggers partial spend.
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
    const confinedWork = await confineTargetPath(episodeDir, item.workDir);
    if (seenWorkDirs.has(confinedWork)) {
      throw new Error(`Duplicate batch workDir at slide ${item.slide}: ${item.workDir}`);
    }
    seenWorkDirs.add(confinedWork);

    const checkedPrompt = await confineExistingPath([episodeDir], item.promptFile, { requireRegularFile: true });
    if (checkedPrompt.stat.size > MAX_PROMPT_BYTES) throw new Error(`Batch slide ${item.slide}: promptFile too large`);
    const promptBytes = await readFile(checkedPrompt.real);
    if (!promptBytes.toString('utf8').trim()) throw new Error(`Batch slide ${item.slide}: empty promptFile`);
    const promptSha256 = sha256Bytes(promptBytes);

    const { refs } = await readAndCheckReferences(item.references ?? [], episodeDir);
    const slideContentSha256 = validation.slideFingerprints[item.slide - 1];
    const expectedRequestSha256 = computeRequestFingerprint({
      slideContentSha256,
      promptSha256,
      referenceHashes: refs.map(r => r.sha256),
    });

    if (item.slide_content_sha256 && item.slide_content_sha256 !== slideContentSha256) {
      throw new Error(`Batch slide ${item.slide}: stale manifest (episode content changed); rebuild prompts`);
    }
    if (item.prompt_sha256 && item.prompt_sha256 !== promptSha256) {
      throw new Error(`Batch slide ${item.slide}: stale manifest (prompt file changed); rebuild prompts`);
    }
    if (item.request_sha256 && item.request_sha256 !== expectedRequestSha256) {
      throw new Error(`Batch slide ${item.slide}: stale manifest (request fingerprint mismatch); rebuild prompts`);
    }

    const workExists = await lstat(confinedWork).then(() => true, err => (err.code === 'ENOENT' ? false : Promise.reject(err)));
    if (workExists) {
      const checkedStatus = await confineExistingPath([confinedWork], join(confinedWork, 'status.json'), { requireRegularFile: true }).catch(() => null);
      if (!checkedStatus) {
        throw new Error(`Batch stopped at slide ${item.slide}: draft directory already exists without status.json`);
      }
      const existing = JSON.parse(await readFile(checkedStatus.real, 'utf8'));
      if (existing.state === 'succeeded') {
        await checkAttemptHistory({
          draftsParent: dirname(confinedWork),
          episodeFile,
          slide: item.slide,
          character: false,
          targetDraftName: basename(confinedWork),
          checkBudget: false,
        });
        if (existing.request_sha256 !== expectedRequestSha256) {
          throw new Error(`Batch stopped at slide ${item.slide}: existing succeeded draft does not match current request fingerprint; rebuild or use a new attempt`);
        }
        const checkedImg = await confineExistingPath([confinedWork], join(confinedWork, 'image.jpg'), { requireRegularFile: true });
        const imgInfo = await readImageInfo(checkedImg.real, { requireNormalized1080: true });
        if (!existing.output?.sha256 || imgInfo.sha256 !== existing.output.sha256) {
          throw new Error(`Batch stopped at slide ${item.slide}: existing image.jpg failed SHA-256 verification`);
        }
        skipped.push(item.slide);
        continue;
      }
      throw new Error(`Batch stopped at slide ${item.slide}: existing draft has state ${existing.state}`);
    }

    await checkAttemptHistory({
      draftsParent: dirname(confinedWork),
      episodeFile,
      slide: item.slide,
      character: false,
      targetDraftName: basename(confinedWork),
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
  } else if (!((args[0] === '--normalize' && args.length === 3) || (args[0] === '--batch' && args.length === 3) || (args[0] === '--slide' && args.length >= 5) || (args[0] === '--character' && args.length >= 4))) {
    console.error('Usage: node scripts/draw-image.mjs --slide EPISODE_JSON SLIDE_NUMBER PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...]\n       node scripts/draw-image.mjs --batch EPISODE_JSON BATCH_MANIFEST_JSON\n       node scripts/draw-image.mjs --character EPISODE_JSON PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...]\n       node scripts/draw-image.mjs --normalize RESPONSE_FILE NEW_DRAFT_DIR\n       node scripts/draw-image.mjs --reconcile DRAFT_DIR --resolution reconciled_failed|reconciled_superseded --note "..."');
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
        : { episodeFile: args[1], slide: Number(args[2]), promptFile: args[3], workDir: args[4], references: args.slice(5) };
    try { console.log(await draw(options)); }
    catch (error) {
      console.error(error.code === 'EEXIST' ? 'Draft directory already exists; no API call was made.'
        : error.message.startsWith('Image job ') || error.message.startsWith('Unresolved attempt') || error.message.startsWith('Attempt limit')
          ? error.message : 'Image job could not start; check arguments and a new draft directory.');
      process.exitCode = 1;
    }
  }
}
