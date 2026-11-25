import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_EPISODE_JSON_BYTES, MAX_IMAGE_BYTES, OUTPUT_HEIGHT, OUTPUT_WIDTH, RECONCILED_STATES, UNRESOLVED_STATES } from './policy.mjs';
import { confineRelativeFile, isSafeRevision } from './paths.mjs';
import { checkpointIssue, isSha256 } from './schema.mjs';
import { sha256Bytes } from './fingerprint.mjs';

export const statIfPresent = path => lstat(path).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
});

export async function outputRevisions(dir) {
  const output = await statIfPresent(join(dir, 'output'));
  if (!output) return [];
  if (!output.isDirectory()) throw new Error('Episode output must be a real directory');
  return (await readdir(join(dir, 'output'))).filter(isSafeRevision)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

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

export async function outputSlideFiles(dir, revision, slide) {
  const folder = `output/${revision}`;
  const folderStat = await statIfPresent(join(dir, folder));
  if (!folderStat) return [];
  if (!folderStat.isDirectory()) throw new Error(`Not a real directory: ${folder}`);
  const files = [];
  for (const ext of ['jpg', 'jpeg', 'png']) {
    const file = `${folder}/${String(slide).padStart(3, '0')}.${ext}`;
    if (await statIfPresent(join(dir, file))) files.push(file);
  }
  return files;
}

async function verifiedCheckpoint(dir, path, context) {
  const check = await confineRelativeFile(dir, path);
  if (check.stat.size > MAX_EPISODE_JSON_BYTES) return null;
  const raw = await readFile(check.real, 'utf8');
  let record;
  try { record = JSON.parse(raw); } catch { return null; }
  if (!isSha256(record?.slide_content_sha256) ||
      checkpointIssue(record, { ...context, slideSha256: record.slide_content_sha256 })) return null;
  return record;
}

export async function findOutputReuse(dir, slide, slideSha256, targetRevision, revisions) {
  const targetFiles = await outputSlideFiles(dir, targetRevision, slide);
  const conflict = source => ({ action: 'output_conflict', file: targetFiles[0], targetFiles, source });
  let target;
  let unverified;
  let rejected;
  for (const revision of [targetRevision, ...revisions.toReversed().filter(r => r !== targetRevision)]) {
    const atTarget = revision === targetRevision;
    const folder = `output/${revision}`;
    for (const file of atTarget ? targetFiles : await outputSlideFiles(dir, revision, slide)) {
      const image = file.slice(folder.length + 1);
      const artifact = await confineRelativeFile(dir, file);
      const imageSha256 = artifact.stat.size <= MAX_IMAGE_BYTES ? sha256Bytes(await readFile(artifact.real)) : null;
      const note = await readRejection(dir, slideSha256, imageSha256);
      const checkPath = `${folder}/checks/${image}.json`;
      const checkpointExists = Boolean(await statIfPresent(join(dir, checkPath)));
      if (atTarget) target = { image, imageSha256, checkpointExists };
      if (note) {
        rejected ??= { action: 'repair', file, note };
        continue;
      }
      const record = checkpointExists && await verifiedCheckpoint(dir, checkPath, { revision, slide, image, imageSha256 });
      if (record?.slide_content_sha256 === slideSha256) {
        if (targetFiles.length > 1) return conflict(file);
        const action = atTarget ? 'keep'
          : BigInt(revision.slice(1)) < BigInt(targetRevision.slice(1)) ? 'carry_forward' : 'use_newer_revision';
        if (action === 'carry_forward' && target &&
            (target.image !== image || target.imageSha256 !== imageSha256 || target.checkpointExists)) return conflict(file);
        return { action, file };
      }
      if (atTarget || !record) unverified ??= { action: 'review_output', file };
    }
  }
  return targetFiles.length > 1 ? conflict(null) : unverified ?? rejected;
}

export const draftRevision = name => /^\d{3}-(r\d{2,})-[a-z0-9-]+$/i.exec(name)?.[1]?.toLowerCase();

export function countsAgainstSlideBudget(name, revision) {
  const recordedRevision = draftRevision(name);
  return !recordedRevision || BigInt(recordedRevision.slice(1)) === BigInt(revision.slice(1));
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
  // Old standalone conversions lost their mode on success, but never wrote API request/reference metadata.
  if (rec?.state === 'succeeded' && !reqStat && Object.keys(rec).every(key => ['state', 'source', 'output'].includes(key)) &&
      rec.output?.file === 'image.jpg' && rec.output.mime === 'image/jpeg' &&
      rec.output.width === OUTPUT_WIDTH && rec.output.height === OUTPUT_HEIGHT &&
      !await statIfPresent(join(draftDirPath, 'references.json'))) {
    return { ...rec, mode: 'normalize' };
  }
  const validState = ['invalid_input', 'succeeded', 'failed'].includes(rec?.state) || UNRESOLVED_STATES.has(rec?.state) || RECONCILED_STATES.has(rec?.state);
  if (!validState || (rec.state !== 'invalid_input' && rec.mode !== 'normalize' &&
      (typeof plan?.file !== 'string' || typeof plan.character !== 'boolean' || (!plan.character && !Number.isSafeInteger(plan.slide))))) {
    throw new Error(`Corrupted attempt metadata in drafts/${entryName}`);
  }
  return { ...rec, plan, request_sha256: req?.request_sha256 ?? rec.request_sha256 };
}
