import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes } from './fingerprint.mjs';
import { MAX_EPISODE_JSON_BYTES, MAX_IMAGE_BYTES, RECONCILED_STATES, UNRESOLVED_STATES } from './policy.mjs';
import { acquireEpisodeLock, LOOKAHEAD_LOCK } from './lock.mjs';
import { confineRelativeFile, confineTargetPath, writeAtomic } from './paths.mjs';
import { ImageDecoderError, isSha256, readImageInfo } from './schema.mjs';

export const statIfPresent = path => lstat(path).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});

export function rejectionPath(slideSha256, imageSha256) {
  return `rejections/${slideSha256}-${imageSha256}.json`;
}

export async function readRejection(dir, slideSha256, imageSha256) {
  if (!isSha256(slideSha256) || !isSha256(imageSha256)) return null;
  const marker = rejectionPath(slideSha256, imageSha256);
  if (!await statIfPresent(join(dir, marker))) return null;
  const check = await confineRelativeFile(dir, marker);
  if (check.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error(`Rejection checkpoint too large: ${marker}`);
  const record = JSON.parse(await readFile(check.real, 'utf8'));
  if (record?.image_sha256 !== imageSha256 || record.slide_content_sha256 !== slideSha256 ||
      typeof record.note !== 'string' || !record.note.trim()) throw new Error(`Invalid rejection checkpoint: ${marker}`);
  return record.note;
}

export async function readAttemptRecord(draftDirPath, entryName) {
  const statusPath = join(draftDirPath, 'status.json');
  const reqPath = join(draftDirPath, 'request.json');
  const stStat = await statIfPresent(statusPath);
  const reqStat = await statIfPresent(reqPath);
  if (!stStat && !reqStat) return null;

  if (reqStat && (!reqStat.isFile() || reqStat.size > MAX_EPISODE_JSON_BYTES)) {
    throw new Error(`Corrupted request.json in drafts/${entryName}`);
  }
  let req = null;
  if (reqStat) {
    try {
      req = JSON.parse(await readFile(reqPath, 'utf8'));
      if (!req?.plan || typeof req.plan.file !== 'string') throw new Error('Missing request plan');
    } catch {
      throw new Error(`Corrupted request.json in drafts/${entryName}`);
    }
  }

  if (!stStat) {
    throw new Error(`Missing status.json for registered attempt drafts/${entryName}`);
  }
  if (!stStat.isFile() || stStat.size > MAX_EPISODE_JSON_BYTES) {
    throw new Error(`Corrupted status.json in drafts/${entryName}`);
  }
  let rec;
  try { rec = JSON.parse(await readFile(statusPath, 'utf8')); }
  catch { throw new Error(`Corrupted status.json in drafts/${entryName}`); }

  const plan = req?.plan ?? rec?.plan;
  const validState = ['invalid_input', 'succeeded', 'failed'].includes(rec?.state) || UNRESOLVED_STATES.has(rec?.state) || RECONCILED_STATES.has(rec?.state);
  if (!validState || (rec.state === 'prepared' && plan?.lookahead !== true) || (rec.state !== 'invalid_input' && rec.mode !== 'normalize' &&
      (typeof plan?.file !== 'string' || typeof plan.character !== 'boolean' || (!plan.character && !Number.isSafeInteger(plan.slide))))) {
    throw new Error(`Corrupted attempt metadata in drafts/${entryName}`);
  }
  if (!req || !isSha256(req.request_sha256) || !isSha256(req.slide_content_sha256)) {
    throw new Error(`Missing request provenance in drafts/${entryName}`);
  }
  return { ...rec, plan, slide_content_sha256: req.slide_content_sha256, request_sha256: req.request_sha256 };
}

export async function episodeAttempts(dir) {
  const parent = join(dir, 'drafts');
  const st = await statIfPresent(parent);
  if (!st) return [];
  if (!st.isDirectory()) throw new Error('Invalid drafts directory');
  const attempts = [];
  for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
    if (!entry.isDirectory()) continue;
    const record = await readAttemptRecord(join(parent, entry.name), entry.name);
    if (!record || record.mode === 'normalize' || record.state === 'invalid_input') continue;
    if (record.plan.file !== 'artifact/episode.json') throw new Error('Unexpected attempt provenance');
    attempts.push({ ...record, name: entry.name, path: `drafts/${entry.name}` });
  }
  return attempts;
}

export const lookaheadCanReview = attempt => ['in_flight', 'received'].includes(attempt?.state);
export const LOOKAHEAD_GUARD = '.lookahead-active.json';

export class LookaheadStateError extends Error {
  constructor() {
    super('Lookahead lock and attempt records do not match; preserve the files and inspect the running request before recovery');
  }
}

async function lookaheadLockId(dir) {
  const file = join(dir, LOOKAHEAD_LOCK);
  const stat = await lstat(file, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (stat && !stat.isFile()) throw new LookaheadStateError();
  return stat ? `${stat.dev}:${stat.ino}` : null;
}

export async function claimLookahead(dir, path, requestSha256, publishDraft) {
  const file = await confineTargetPath(dir, LOOKAHEAD_LOCK);
  if (!await lookaheadLockId(dir)) await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  const lock = await lookaheadLockId(dir);
  const release = await acquireEpisodeLock(dir, { name: LOOKAHEAD_LOCK, timeoutMs: 0 });
  try {
    await publishDraft();
    if (!lock || await lookaheadLockId(dir) !== lock) throw new LookaheadStateError();
    await writeAtomic(await confineTargetPath(dir, LOOKAHEAD_GUARD), JSON.stringify({ path, requestSha256, lock }), 0o600);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

async function readLookaheadGuard(dir) {
  const guardPath = join(dir, LOOKAHEAD_GUARD);
  const stat = await statIfPresent(guardPath);
  let guard;
  if (stat) {
    if (!stat.isFile() || stat.size > 4096) throw new LookaheadStateError();
    try { guard = JSON.parse(await readFile(guardPath, 'utf8')); }
    catch { throw new LookaheadStateError(); }
    if (!guard?.lock || !isSha256(guard.requestSha256)) throw new LookaheadStateError();
  }
  return guard;
}

// Inspect under the episode lock. The guard survives deletion of either the draft or the lock file.
export async function attemptState(dir) {
  const guard = await readLookaheadGuard(dir);
  const attempts = await episodeAttempts(dir).catch(error => {
    throw guard ? new LookaheadStateError() : error;
  });
  const blocked = attempts.find(a => a.state === 'failed' || UNRESOLVED_STATES.has(a.state));
  const lock = await lookaheadLockId(dir);
  const claimed = guard && attempts.find(a => a.path === guard.path && a.request_sha256 === guard.requestSha256 && a.plan.lookahead === true);
  if ((guard && (!claimed || guard.lock !== lock)) ||
      (!lock && blocked?.plan.lookahead === true && blocked.state !== 'prepared')) throw new LookaheadStateError();
  if (!lock) return { attempts, blocked, running: false };
  let release;
  try { release = await acquireEpisodeLock(dir, { name: LOOKAHEAD_LOCK, timeoutMs: 0, probe: true }); }
  catch { throw new LookaheadStateError(); }
  finally {
    release?.();
    if (await lookaheadLockId(dir) !== lock) throw new LookaheadStateError();
  }
  const running = !release;
  if (running && (!claimed || claimed !== blocked)) throw new LookaheadStateError();
  return { attempts, blocked, running, guarded: claimed };
}

// Reconciled transport failures did not use up an image review attempt.
export const visualAttempts = attempts => attempts.filter(a => a.state === 'succeeded' || a.previous_state === 'succeeded').length;

async function verifiedFile(dir, path, hash) {
  if (!isSha256(hash)) return null;
  try {
    const { real, stat } = await confineRelativeFile(dir, path);
    if (!stat.size || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = await readFile(real);
    return bytes.length === stat.size && sha256Bytes(bytes) === hash ? real : null;
  } catch { return null; }
}

export const verifiedDraft = (dir, attempt) => verifiedFile(dir, `${attempt.path}/image.jpg`, attempt.output?.sha256);

export async function verifiedRawResponse(dir, attempt) {
  if (!['received', 'normalize_failed', 'succeeded'].includes(attempt.state) || !isSha256(attempt.response_sha256)) return null;
  try {
    const { real } = await confineRelativeFile(dir, `${attempt.path}/response.bin`);
    await readImageInfo(real, { expectedSha256: attempt.response_sha256 });
    return real;
  } catch (error) {
    if (error instanceof ImageDecoderError) throw new ImageDecoderError(`${error.message}; resolve the decoder failure before reconciling`, { cause: error });
    return null;
  }
}

export async function attemptIssue(dir, attempt) {
  const issue = { path: attempt.path, name: attempt.name, state: attempt.state, slide: attempt.plan.slide ?? null,
    character: attempt.plan.character ? attempt.plan.target : null,
    code: attempt.state === 'succeeded' ? 'IMG_DRAFT_DAMAGED' : imageError(attempt) };
  try { return { ...issue, raw_recoverable: !!await verifiedRawResponse(dir, attempt) }; }
  catch (error) {
    if (!(error instanceof ImageDecoderError)) throw error;
    return { ...issue, raw_recoverable: null, raw_issue: error.message };
  }
}

export function imageError(attempt) {
  if (!attempt) return null;
  const { state, http_status: status } = attempt;
  if (state === 'prepared') return 'IMG_NOT_SENT';
  if (state === 'normalize_failed' || state === 'received') return 'IMG_NORMALIZE';
  if (Number.isInteger(status) && status >= 300 && status <= 599) return `IMG_HTTP_${status}`;
  return attempt.error_code === 'IMG_TIMEOUT' ? 'IMG_TIMEOUT' : 'IMG_UNKNOWN';
}
