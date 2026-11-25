import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_EPISODE_JSON_BYTES, RECONCILED_STATES, UNRESOLVED_STATES } from './policy.mjs';
import { confineRelativeFile } from './paths.mjs';
import { isSha256 } from './schema.mjs';

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
  if (!validState || (rec.state !== 'invalid_input' && rec.mode !== 'normalize' &&
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

export function blockingAttempt(attempts) {
  return attempts.find(a => a.state === 'failed' || UNRESOLVED_STATES.has(a.state));
}

export function imageError(attempt) {
  if (!attempt) return null;
  const { state, http_status: status } = attempt;
  if (state === 'normalize_failed' || state === 'received') return 'IMG_NORMALIZE';
  if (Number.isInteger(status) && status >= 300 && status <= 599) return `IMG_HTTP_${status}`;
  return attempt.error_code === 'IMG_TIMEOUT' ? 'IMG_TIMEOUT' : 'IMG_UNKNOWN';
}
