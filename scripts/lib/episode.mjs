import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sha256Bytes, sha256Canonical } from './fingerprint.mjs';
import { confineRelativeFile, confineTargetPath, writeAtomic } from './paths.mjs';
import { MAX_ATTEMPTS_PER_SLIDE, MAX_IMAGE_BYTES } from './policy.mjs';
import { blockingAttempt, episodeAttempts, imageError, readRejection, statIfPresent } from './resume.mjs';
import { imageMime, isSha256, readEpisodeJson, validateEpisodeData } from './schema.mjs';

export const EPISODE_JSON = 'artifact/episode.json';
export const isEpisodeCode = value => typeof value === 'string' && /^T[1-9][0-9]{0,8}$/.test(value);
export const pad3 = n => String(n).padStart(3, '0');
export const checkPath = n => `artifact/checks/${pad3(n)}.json`;
export const imagePath = (n, extension = 'jpg') => `artifact/images/${pad3(n)}.${extension}`;
export const deliverableStatus = status => ['ready_for_review', 'approved', 'published'].includes(status);
const validStatus = status => ['draft', 'locked'].includes(status) || deliverableStatus(status);
const allowedImagePath = (file, n) => ['jpg', 'jpeg', 'png'].some(ext => file === imagePath(n, ext));

export const writeEpisode = async (dir, ep) => writeAtomic(await confineTargetPath(dir, EPISODE_JSON), `${JSON.stringify(ep, null, 2)}\n`);
export const readEpisode = dir => readEpisodeJson(join(dir, EPISODE_JSON), dir);

export function assertEpisodeIdentity(dir, ep) {
  if (!isEpisodeCode(ep?.code) || ep.code !== basename(resolve(dir)) || !validStatus(ep.status) ||
    typeof ep.title !== 'string' || !ep.title.trim() || ep.title.length > 200) throw new Error('Invalid episode code, title, or status');
}

export function planHash(ep, validation) {
  const { status: _status, locked_sha256: _locked, ...plan } = ep;
  return sha256Canonical({ plan, source_sha256: validation.sourceSha256, fingerprints: validation.slideFingerprints });
}

export async function loadValidated(dir, { character = false, requireLock = !character } = {}) {
  const episode = await readEpisode(dir);
  assertEpisodeIdentity(dir, episode);
  // Only already-published imports may retain a recorded historical verbatim mismatch.
  const legacyVerbatimIssue = episode.status === 'published' && episode.legacy?.bundle === 'verified'
    ? episode.legacy.verbatim_issue : undefined;
  const validation = await validateEpisodeData(episode, dir, { includeCharacterSnapshots: !character, legacyVerbatimIssue });
  if (!validation.ok) throw new Error(`Invalid episode: ${validation.issues.join('; ')}`);
  if (requireLock && (episode.status === 'draft' || episode.locked_sha256 !== planHash(episode, validation))) {
    throw new Error('Script not locked or changed since lock; run handoff before proceeding');
  }
  return { episode, validation };
}

export async function imageBytes(dir, file) {
  const checked = await confineRelativeFile(dir, file);
  if (checked.stat.size < 3 || checked.stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid image size');
  const bytes = await readFile(checked.real);
  if (bytes.length !== checked.stat.size) throw new Error('Image changed while reading');
  const mime = imageMime(bytes);
  if ((mime === 'image/png') !== file.endsWith('.png')) throw new Error('Image extension does not match bytes');
  return { bytes, mime, sha256: sha256Bytes(bytes) };
}

export async function checkedSlide(dir, slide, fingerprint) {
  const file = checkPath(slide);
  if (!await statIfPresent(join(dir, file))) return null;
  const check = await readEpisodeJson(join(dir, file), dir);
  if (check.slide_content_sha256 !== fingerprint || !allowedImagePath(check.image, slide) ||
    !isSha256(check.image_sha256) || (!isSha256(check.request_sha256) && check.legacy !== true) ||
    check.visual_check?.passed !== true || typeof check.visual_check.note !== 'string' || !check.visual_check.note.trim() ||
    await readRejection(dir, fingerprint, check.image_sha256)) return null;
  if (!await statIfPresent(join(dir, check.image))) return null;
  const image = await imageBytes(dir, check.image);
  return image.sha256 === check.image_sha256 ? { file: check.image, sha256: image.sha256 } : null;
}

export async function episodeBundle(dir) {
  const { episode, validation } = await loadValidated(dir);
  if (!deliverableStatus(episode.status)) throw new Error('Episode is not complete');
  if (await blockingEpisodeAttempt(dir)) throw new Error('Episode has a blocking attempt');
  const files = [];
  for (const [index, fp] of validation.slideFingerprints.entries()) {
    const checked = await checkedSlide(dir, index + 1, fp);
    if (!checked) throw new Error(`Slide ${index + 1} is not verified`);
    files.push(checked);
  }
  return { episode, files, key: sha256Canonical([episode.locked_sha256, ...files.map(f => f.sha256)]) };
}

export async function blockingEpisodeAttempt(dir) {
  const attempt = blockingAttempt(await episodeAttempts(dir));
  if (!attempt) return null;
  return { path: attempt.path, state: attempt.state, slide: attempt.plan.slide ?? null,
    character: attempt.plan.character ? attempt.plan.target : null,
    code: imageError(attempt), raw_recoverable: isSha256(attempt.response_sha256) && ['received', 'normalize_failed'].includes(attempt.state) };
}

export async function pageState(dir, slide, fp, attempts) {
  const checked = await checkedSlide(dir, slide, fp);
  if (checked) return { slide, action: 'keep', ...checked };
  const relevant = attempts.filter(a => a.plan.slide === slide && a.slide_content_sha256 === fp);
  let rejected;
  for (const a of relevant.toReversed()) {
    if (a.state !== 'succeeded' || !isSha256(a.output?.sha256)) continue;
    const file = `${a.path}/image.jpg`;
    const note = await readRejection(dir, fp, a.output.sha256);
    if (note) { rejected ??= { file, note }; continue; }
    if (await statIfPresent(join(dir, file)) && (await imageBytes(dir, file)).sha256 === a.output.sha256) {
      return { slide, action: 'review', file };
    }
    throw new Error(`Verified API draft missing or changed: ${file}; inspect the saved attempt before proceeding`);
  }
  if (relevant.length >= MAX_ATTEMPTS_PER_SLIDE) return { slide, action: 'attempt_limit', rejected };
  const count = attempts.filter(a => a.plan.slide === slide).length;
  return { slide, action: rejected ? 'repair' : 'draw', rejected, attempt: `${pad3(slide)}-a${count + 1}` };
}

export async function episodePages(dir, validation, attempts) {
  const pages = [];
  for (const [i, fp] of validation.slideFingerprints.entries()) pages.push(await pageState(dir, i + 1, fp, attempts));
  return pages;
}
