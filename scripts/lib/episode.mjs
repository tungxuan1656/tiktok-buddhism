import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sha256Bytes, sha256Canonical } from './fingerprint.mjs';
import { confineRelativeFile, confineTargetPath, writeAtomic } from './paths.mjs';
import { MAX_ATTEMPTS_PER_SLIDE, MAX_EPISODE_JSON_BYTES, MAX_IMAGE_BYTES } from './policy.mjs';
import { attemptIssue, blockingAttempt, episodeAttempts, readRejection, statIfPresent, verifiedDraft, visualAttempts } from './resume.mjs';
import { imageMime, isSha256, readEpisodeJson, validateEpisodeData } from './schema.mjs';

export const EPISODE_JSON = 'artifact/episode.json';
export const isEpisodeCode = value => typeof value === 'string' && /^T[1-9][0-9]{0,8}$/.test(value);
export const pad3 = n => String(n).padStart(3, '0');
export const checkPath = n => `artifact/checks/${pad3(n)}.json`;
export const imagePath = (n, extension = 'jpg') => `artifact/images/${pad3(n)}.${extension}`;
const deliverableStatuses = ['ready_for_review', 'approved', 'published'];
const maxDeliverableStatusLength = Math.max(...deliverableStatuses.map(status => status.length));
export const deliverableStatus = status => deliverableStatuses.includes(status);
const validStatus = status => ['draft', 'locked'].includes(status) || deliverableStatus(status);
const allowedImagePath = (file, n) => ['jpg', 'jpeg', 'png'].some(ext => file === imagePath(n, ext));

export async function writeEpisode(dir, ep) {
  const json = `${JSON.stringify(ep, null, 2)}\n`;
  // A locked script must still fit when finalized.
  const growth = ep.status === 'locked' ? maxDeliverableStatusLength - ep.status.length : 0;
  if (Buffer.byteLength(json) + growth > MAX_EPISODE_JSON_BYTES) throw new Error('Episode JSON too large');
  await writeAtomic(await confineTargetPath(dir, EPISODE_JSON), json);
}
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

async function slideCheck(dir, slide, fingerprint) {
  const file = checkPath(slide);
  if (!await statIfPresent(join(dir, file))) return null;
  const check = await readEpisodeJson(join(dir, file), dir).catch(() => null);
  if (!check || check.slide_content_sha256 !== fingerprint || !allowedImagePath(check.image, slide) ||
    !isSha256(check.image_sha256) || (!isSha256(check.request_sha256) && check.legacy !== true) ||
    check.visual_check?.passed !== true || typeof check.visual_check.note !== 'string' || !check.visual_check.note.trim()) return null;
  const note = await readRejection(dir, fingerprint, check.image_sha256);
  if (note) return { file: check.image, note };
  const image = await imageBytes(dir, check.image).catch(() => null);
  return image?.sha256 === check.image_sha256 ? { file: check.image, sha256: image.sha256 } : null;
}

export async function checkedSlide(dir, slide, fingerprint) {
  const check = await slideCheck(dir, slide, fingerprint);
  return check?.sha256 ? check : null;
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
  return blockingAttempt(await episodeAttempts(dir));
}

export async function pageState(dir, slide, fp, attempts) {
  const checked = await slideCheck(dir, slide, fp);
  if (checked?.sha256) return { slide, action: 'keep', ...checked };
  const relevant = attempts.filter(a => a.plan.slide === slide && a.slide_content_sha256 === fp);
  let rejected;
  for (const a of relevant.toReversed()) {
    if (a.state !== 'succeeded') continue;
    const file = `${a.path}/image.jpg`;
    const note = await readRejection(dir, fp, a.output?.sha256);
    if (note) { rejected ??= { file, note }; continue; }
    if (await verifiedDraft(dir, a)) return { slide, action: 'review', file };
    return { slide, action: 'resolve_attempt', blocked: await attemptIssue(dir, a) };
  }
  rejected ??= checked?.note ? checked : undefined;
  if (visualAttempts(relevant) >= MAX_ATTEMPTS_PER_SLIDE) return { slide, action: 'attempt_limit', rejected };
  const count = attempts.filter(a => a.plan.slide === slide).length;
  return { slide, action: rejected ? 'repair' : 'draw', rejected, attempt: `${pad3(slide)}-a${count + 1}` };
}

export async function episodePages(dir, validation, attempts) {
  const pages = [];
  for (const [i, fp] of validation.slideFingerprints.entries()) pages.push(await pageState(dir, i + 1, fp, attempts));
  return pages;
}
