import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const ENDPOINT = 'http://localhost:20128/v1/images/generations?response_format=binary';
const MAX_BYTES = 49_000_000;

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('Expected a PNG or JPEG image');
}

async function imageInfo(path) {
  if ((await stat(path)).size > MAX_BYTES) throw new Error('Invalid image size');
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid image size');
  const mime = imageMime(bytes);
  const { stdout } = await exec('magick', ['identify', '-regard-warnings', '-format', '%m %w %h %n', path], { timeout: 30_000 });
  const match = /^(PNG|JPEG) (\d+) (\d+) 1$/.exec(stdout);
  if (!match || (mime === 'image/png') !== (match[1] === 'PNG')) throw new Error('Invalid or multiple images');
  return { mime, width: Number(match[2]), height: Number(match[3]), bytes: bytes.length };
}

async function validateEpisodePlan(episodeFile, { slide, character = false, allowAnySlide = false, onGate } = {}) {
  onGate?.('script_invalid');
  const bytes = await readFile(episodeFile);
  if (bytes.length > 128 * 1024) throw new Error('Script too large');
  const episode = JSON.parse(bytes.toString('utf8'));
  onGate?.('script_count');
  if (!Array.isArray(episode.slides) || episode.slides.length < 1 || episode.slides.length > 35) {
    throw new Error('Script must contain 1-35 slides');
  }
  onGate?.('slide_invalid');
  const invalidSlide = episode.slides.some(page => typeof page?.text !== 'string' || !page.text.trim()) ||
    (!allowAnySlide && (character ? slide !== undefined : !Number.isSafeInteger(slide) || slide < 1 || slide > episode.slides.length));
  if (invalidSlide) throw new Error('Invalid planned slide');
  onGate?.(undefined);
  return episode;
}

export async function draw({ promptFile, workDir, references = [], normalizeFrom, episodeFile, slide, character = false, request = fetch }) {
  if (references.length > 10 || (normalizeFrom && (promptFile || references.length))) throw new Error('Invalid arguments');
  // Exclusive directory creation prevents duplicate calls and overwriting a previous attempt.
  await mkdir(dirname(resolve(workDir)), { recursive: true });
  await mkdir(workDir, { mode: 0o700 });
  const save = async record => {
    await writeFile(join(workDir, 'status.tmp'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(join(workDir, 'status.tmp'), join(workDir, 'status.json'));
  };
  let state = 'prepared';
  let httpStatus;
  let source;
  let plan;
  let gateError;
  try {
    await exec('magick', ['-version'], { timeout: 10_000 });
    const raw = join(workDir, 'response.bin');
    if (normalizeFrom) {
      if ((await stat(normalizeFrom)).size > MAX_BYTES) throw new Error('Invalid image size');
      const bytes = await readFile(normalizeFrom);
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid image size');
      await writeFile(raw, bytes, { flag: 'wx', mode: 0o600 });
      state = 'received';
      await save({ state, mode: 'normalize', source: resolve(normalizeFrom) });
    } else {
      const episode = await validateEpisodePlan(episodeFile, {
        slide,
        character,
        onGate: code => { gateError = code; },
      });
      plan = { file: resolve(episodeFile), count: episode.slides.length, slide, character };
      const prompt = await readFile(promptFile, 'utf8');
      if (!prompt.trim()) throw new Error('Empty prompt');
      const images = [];
      const refs = [];
      for (const path of references) {
        const info = await imageInfo(path);
        images.push(`data:${info.mime};base64,${(await readFile(path)).toString('base64')}`);
        refs.push({ path: resolve(path), ...info });
      }
      const payload = { model: 'cx/gpt-image-2.6-flare', prompt, size: '1024x1536', output_format: 'jpeg', images };
      await writeFile(join(workDir, 'request.json'), `${JSON.stringify({ ...payload, images: undefined, reference_count: images.length, plan })}\n`, { flag: 'wx', mode: 0o600 });
      await writeFile(join(workDir, 'references.json'), `${JSON.stringify(refs, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await save({ state: 'in_flight', model: payload.model, plan });
      state = 'unknown';
      const headers = { 'content-type': 'application/json' };
      if (process.env.NINEROUTER_KEY) headers.authorization = `Bearer ${process.env.NINEROUTER_KEY}`;
      const response = await request(ENDPOINT, {
        method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(300_000),
      });
      httpStatus = response.status;
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Response too large');
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.byteLength;
        if (length > MAX_BYTES) throw new Error('Response too large');
        chunks.push(chunk);
      }
      await writeFile(raw, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
      if (!response.ok) {
        state = httpStatus >= 500 || httpStatus === 408 ? 'unknown' : 'failed';
        throw new Error('Image API did not succeed');
      }
      state = 'received';
      await save({ state, http_status: httpStatus });
    }
    source = await imageInfo(raw);
    const output = join(workDir, 'image.jpg');
    await exec('magick', [raw, '-auto-orient', '-colorspace', 'sRGB', '-background', 'white',
      '-alpha', 'remove', '-alpha', 'off', '-resize', '1080x1440', '-gravity', 'center', '-extent', '1080x1440',
      '-strip', '-sampling-factor', '4:4:4', '-quality', '95', output], { timeout: 60_000 });
    const final = await imageInfo(output);
    if (final.mime !== 'image/jpeg' || final.width !== 1080 || final.height !== 1440) throw new Error('Invalid normalized output');
    await save({ state: 'succeeded', http_status: httpStatus, source, output: { file: 'image.jpg', ...final, quality: 95, sampling: '4:4:4' } });
    return output;
  } catch {
    const code = state === 'received' ? 'normalize_failed' : state === 'prepared' ? 'invalid_input' : state;
    await save({ state: code, http_status: httpStatus, source, gate_error: gateError, plan });
    throw new Error(`Image job ${code}${gateError ? ` (${gateError}: require a saved script with 1-35 slides and a valid slide/character selection)` : ''}; inspect status.json and saved response. Do not retry the API blindly.`);
  }
}

/** Validate the whole batch manifest up front, skip succeeded drafts, and run remaining slides sequentially without retrying failures. */
export async function drawBatch({ episodeFile, manifestFile, request = fetch }) {
  const entries = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid batch manifest');
  await exec('magick', ['-version'], { timeout: 10_000 });
  const episode = await validateEpisodePlan(episodeFile, { allowAnySlide: true });
  const seenWorkDirs = new Set();
  const pending = [];
  const skipped = [];

  // Preflight every entry before any API POST so an invalid later item never triggers partial spend.
  for (const item of entries) {
    if (!Number.isSafeInteger(item?.slide) || item.slide < 1 || item.slide > episode.slides.length) {
      throw new Error(`Invalid batch slide number: ${item?.slide}`);
    }
    if (typeof item?.workDir !== 'string' || !item.workDir.trim()) {
      throw new Error(`Batch slide ${item.slide}: missing workDir`);
    }
    const resolvedWorkDir = resolve(item.workDir);
    if (seenWorkDirs.has(resolvedWorkDir)) {
      throw new Error(`Duplicate batch workDir at slide ${item.slide}: ${item.workDir}`);
    }
    seenWorkDirs.add(resolvedWorkDir);

    const statusPath = join(item.workDir, 'status.json');
    const existing = await readFile(statusPath, 'utf8').then(s => JSON.parse(s), () => null);
    if (existing) {
      if (existing.state === 'succeeded') {
        const outStat = await stat(join(item.workDir, 'image.jpg'));
        if (!outStat.isFile() || outStat.size <= 0) throw new Error(`Batch stopped at slide ${item.slide}: missing image.jpg`);
        skipped.push(item.slide);
        continue;
      }
      throw new Error(`Batch stopped at slide ${item.slide}: existing draft has state ${existing.state}`);
    }
    if (await stat(item.workDir).then(() => true, err => err.code !== 'ENOENT')) {
      throw new Error(`Batch stopped at slide ${item.slide}: draft directory already exists without status.json`);
    }
    if (typeof item?.promptFile !== 'string' || !(await readFile(item.promptFile, 'utf8')).trim()) {
      throw new Error(`Batch slide ${item.slide}: missing or empty promptFile`);
    }
    const refs = item.references ?? [];
    if (!Array.isArray(refs) || refs.length > 10) {
      throw new Error(`Batch slide ${item.slide}: invalid references (max 10)`);
    }
    for (const ref of refs) await imageInfo(ref);
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
  if (!((args[0] === '--normalize' && args.length === 3) || (args[0] === '--batch' && args.length === 3) || (args[0] === '--slide' && args.length >= 5) || (args[0] === '--character' && args.length >= 4))) {
    console.error('Usage: node scripts/draw-image.mjs --slide EPISODE_JSON SLIDE_NUMBER PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...]\n       node scripts/draw-image.mjs --batch EPISODE_JSON BATCH_MANIFEST_JSON\n       node scripts/draw-image.mjs --character EPISODE_JSON PROMPT_FILE NEW_DRAFT_DIR [REFERENCE ...]\n       node scripts/draw-image.mjs --normalize RESPONSE_FILE NEW_DRAFT_DIR');
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
        : error.message.startsWith('Image job ') ? error.message : 'Image job could not start; check arguments and a new draft directory.');
      process.exitCode = 1;
    }
  }
}
