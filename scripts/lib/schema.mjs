import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { computeSlideFingerprint, sha256Bytes } from './fingerprint.mjs';
import {
  confineExistingPath,
  confineRelativeFile,
  isSafeId,
  isSafeVersion,
} from './paths.mjs';
import {
  INTERNAL_PATTERNS,
  MAX_EPISODE_JSON_BYTES,
  MAX_IMAGE_BYTES,
  MAX_REFS,
  MAX_SLIDES,
  MAX_SOURCE_BYTES,
  MAX_TOTAL_REF_BYTES,
  MIN_SLIDES,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  VALID_MODES,
  VALID_SCENE_TYPES,
  VALID_SLIDE_ROLES,
} from './policy.mjs';
import { resolvePrimarySource } from './source.mjs';

const exec = promisify(execFile);
const normalizeEol = text => text.replace(/\r\n/g, '\n');

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('Expected a PNG or JPEG image');
}

export async function readImageInfo(path, { requireNormalized1080 = false, includeBytes = false, maxBytes = MAX_IMAGE_BYTES } = {}) {
  const st = await stat(path);
  if (!st.isFile() || st.size <= 0 || st.size > maxBytes) throw new Error('Invalid image size');
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > maxBytes) throw new Error('Invalid image size');
  const mime = imageMime(bytes);
  const { stdout } = await exec('magick', ['identify', '-regard-warnings', '-format', '%m %w %h %n', path], { timeout: 30_000 });
  const match = /^(PNG|JPEG) (\d+) (\d+) 1$/.exec(stdout);
  if (!match || (mime === 'image/png') !== (match[1] === 'PNG')) throw new Error('Invalid or multiple images');
  const width = Number(match[2]);
  const height = Number(match[3]);
  if (requireNormalized1080 && (width !== OUTPUT_WIDTH || height !== OUTPUT_HEIGHT)) {
    throw new Error(`Expected ${OUTPUT_WIDTH}x${OUTPUT_HEIGHT} image, got ${width}x${height}`);
  }
  const info = { mime, width, height, bytes: bytes.length, sha256: sha256Bytes(bytes) };
  if (includeBytes) info.buffer = bytes;
  return info;
}

export const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function readEpisodeJson(episodeFile, episodeDir) {
  const { real, stat } = await confineExistingPath([episodeDir], episodeFile, { requireRegularFile: true });
  if (stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Episode JSON too large');
  const raw = await readFile(real, 'utf8');
  return JSON.parse(raw);
}

export async function loadCharacterSnapshot(episodeDir, ref) {
  if (!isSafeId(ref?.id) || !isSafeVersion(ref?.version)) {
    return { error: `Invalid character reference identifier (${String(ref?.id)}/${String(ref?.version)})` };
  }
  const relDir = join('references', ref.id, ref.version);
  let jsonCheck;
  try {
    jsonCheck = await confineRelativeFile(episodeDir, join(relDir, 'character.json'));
  } catch (err) {
    return { error: `Missing or unsafe character snapshot: ${relDir}/character.json (${err.message})` };
  }
  if (jsonCheck.stat.size > MAX_EPISODE_JSON_BYTES) {
    return { error: `Character JSON too large: ${relDir}/character.json` };
  }
  const rawJson = await readFile(jsonCheck.real);
  const data = JSON.parse(rawJson.toString('utf8'));
  const refs = Array.isArray(data.references) ? data.references : [];
  if (!refs.length) return { error: `No reference images in ${relDir}/character.json` };

  const refDir = join(resolve(episodeDir), relDir);
  const refPaths = [];
  const refInfos = [];
  for (const r of refs) {
    if (typeof r !== 'string' || !r.trim()) {
      return { error: `Invalid reference path in ${relDir}/character.json` };
    }
    try {
      // Must stay confined both inside the character version folder and inside the episode directory.
      await confineRelativeFile(refDir, r);
      const checked = await confineRelativeFile(episodeDir, join(relDir, r));
      if (checked.stat.size > MAX_IMAGE_BYTES || checked.stat.size <= 0) {
        return { error: `Invalid character image size: ${join(relDir, r)}` };
      }
      const bytes = await readFile(checked.real);
      refPaths.push(join(relDir, r));
      refInfos.push({ path: join(relDir, r), bytes: bytes.length, sha256: sha256Bytes(bytes) });
    } catch (err) {
      return { error: `Missing or unsafe character image ${join(relDir, String(r))}: ${err.message}` };
    }
  }
  return { id: ref.id, version: ref.version, data, jsonSha256: sha256Bytes(rawJson), refPaths, refInfos };
}

function exactJoinMatches(seq, srcTrimmed, prefixes) {
  if (!seq.length) return false;
  if (prefixes !== undefined) {
    if (!Array.isArray(prefixes) || prefixes.length !== seq.length || prefixes.some(p => typeof p !== 'string' || !/^\s*$/.test(p))) {
      return false;
    }
    const joined = normalizeEol(seq.map((s, i) => `${prefixes[i]}${s?.text ?? ''}`).join('')).trim();
    return joined === srcTrimmed;
  }
  for (const sep of ['', '\n', '\n\n', ' ']) {
    const joined = normalizeEol(seq.map(s => s?.text ?? '').join(sep)).trim();
    if (joined === srcTrimmed) return true;
  }
  return false;
}

function verifyVerbatim(slides, srcRawRaw, sourceMeta) {
  const srcRaw = normalizeEol(srcRawRaw);
  const srcTrimmed = srcRaw.trim();
  const hasAnyRole = slides.some(s => s?.role !== undefined || s?.source_start !== undefined || s?.source_end !== undefined);
  const prefixes = sourceMeta?.exact_join_prefixes;

  if (hasAnyRole) {
    if (slides.some(s => !VALID_SLIDE_ROLES.includes(s?.role))) {
      return 'Every slide must specify a valid role (cover|quote|commentary|closing) when role metadata is used';
    }
    const quoteSlides = slides.filter(s => s.role === 'quote');
    if (!quoteSlides.length) return 'Verbatim episode with role annotations must contain at least one quote slide';

    const hasSpans = quoteSlides.some(s => s.source_start !== undefined || s.source_end !== undefined);
    if (hasSpans) {
      let cursor = 0;
      for (const s of quoteSlides) {
        if (!Number.isSafeInteger(s.source_start) || !Number.isSafeInteger(s.source_end) || s.source_start < 0 || s.source_start >= s.source_end || s.source_end > srcRaw.length) {
          return 'Quote slide has invalid source_start/source_end bounds';
        }
        if (s.source_start < cursor) return 'Quote slide source spans overlap or are out of order';
        if (srcRaw.slice(cursor, s.source_start).trim() !== '') {
          return 'Uncovered non-whitespace source text between quote slides';
        }
        if (normalizeEol(srcRaw.slice(s.source_start, s.source_end)) !== normalizeEol(s.text)) {
          return 'Quote slide text does not match source_start..source_end slice exactly';
        }
        cursor = s.source_end;
      }
      if (srcRaw.slice(cursor).trim() !== '') return 'Trailing uncovered non-whitespace text in source';
      return null;
    }

    if (!exactJoinMatches(quoteSlides, srcTrimmed, prefixes)) {
      return 'Verbatim check failed: joined quote slides do not match source';
    }
    return null;
  }

  if (sourceMeta?.exact_join_first_slide !== undefined) {
    const first = sourceMeta.exact_join_first_slide;
    if (!Number.isSafeInteger(first) || first < 1 || first > slides.length) {
      return `Invalid exact_join_first_slide: ${String(first)}`;
    }
    if (!exactJoinMatches(slides.slice(first - 1), srcTrimmed, prefixes)) {
      return 'Verbatim check failed: joined slides from exact_join_first_slide do not match source';
    }
    return null;
  }

  if (!exactJoinMatches(slides, srcTrimmed, prefixes)) {
    return 'Verbatim check failed: joined slides[].text does not match source (annotate cover/commentary with role or exact_join_first_slide)';
  }
  return null;
}

/**
 * Shared validation and page fingerprints for authoring, drawing and delivery.
 */
export async function validateEpisodeData(ep, episodeDir, {
  includeCharacterSnapshots = true, legacyVerbatimIssue,
} = {}) {
  const dir = resolve(episodeDir);
  const issues = [];
  if (!ep || typeof ep !== 'object' || Array.isArray(ep)) {
    return { ok: false, issues: ['Episode JSON must be an object'], mode: null, slideCount: 0, sourceSha256: null, resolvedCharsBySlide: [], slideFingerprints: [] };
  }
  if (!VALID_MODES.includes(ep.mode)) {
    issues.push(`mode must be one of ${VALID_MODES.join('|')} (got "${ep.mode}")`);
  }
  if (!Array.isArray(ep.slides) || ep.slides.length < MIN_SLIDES || ep.slides.length > MAX_SLIDES) {
    issues.push(`slides[] must have ${MIN_SLIDES}-${MAX_SLIDES} items (got ${Array.isArray(ep.slides) ? ep.slides.length : 'none'})`);
  }

  let styleReference;
  if (ep.style_ref !== undefined) {
    try {
      const { real, stat } = await confineRelativeFile(dir, ep.style_ref);
      if (stat.size < 3 || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid image size');
      const bytes = await readFile(real);
      if (bytes.length !== stat.size) throw new Error('Image changed while reading');
      imageMime(bytes);
      styleReference = { path: real, sha256: sha256Bytes(bytes), bytes: bytes.length };
    } catch (error) { issues.push(`Invalid style_ref: ${error.message}`); }
  }

  const seenChars = new Map();
  const resolvedCharsBySlide = [];
  const slides = Array.isArray(ep.slides) ? ep.slides : [];

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const num = i + 1;
    const slideChars = [];
    if (typeof s?.text !== 'string' || !s.text.trim()) {
      issues.push(`Slide ${num}: empty text`);
    } else {
      for (const pat of INTERNAL_PATTERNS) {
        if (pat.test(s.text)) issues.push(`Slide ${num}: possible internal/management text matching ${pat}`);
      }
    }
    if (typeof s?.scene !== 'string' || !s.scene.trim()) issues.push(`Slide ${num}: empty scene`);
    if (!VALID_SCENE_TYPES.includes(s?.scene_type)) issues.push(`Slide ${num}: invalid scene_type "${s?.scene_type}"`);
    if (s?.role !== undefined && !VALID_SLIDE_ROLES.includes(s.role)) {
      issues.push(`Slide ${num}: invalid role "${s.role}"`);
    }
    if ((s?.source_start !== undefined || s?.source_end !== undefined) && s?.role !== undefined && s.role !== 'quote') {
      issues.push(`Slide ${num}: source_start/source_end only allowed on quote slides`);
    }
    if (s?.objects !== undefined && typeof s.objects !== 'string' && (!Array.isArray(s.objects) || s.objects.some(o => typeof o !== 'string'))) {
      issues.push(`Slide ${num}: objects must be a string or array of strings`);
    }
    if (s?.characters !== undefined && !Array.isArray(s.characters)) {
      issues.push(`Slide ${num}: characters must be an array`);
      resolvedCharsBySlide.push(slideChars);
      continue;
    }

    let refCount = 1; // Style reference image is always slot 1.
    let refBytes = styleReference?.bytes ?? 0;
    for (const c of s?.characters ?? []) {
      if (!isSafeId(c?.id) || !isSafeVersion(c?.version)) {
        issues.push(`Slide ${num}: invalid character reference (require safe id and version)`);
        continue;
      }
      if (!includeCharacterSnapshots) continue;
      const key = `${c.id}@${c.version}`;
      if (!seenChars.has(key)) seenChars.set(key, await loadCharacterSnapshot(dir, c));
      const loaded = seenChars.get(key);
      if (loaded.error) {
        issues.push(`Slide ${num}: ${loaded.error}`);
      } else {
        slideChars.push(loaded);
        refCount += loaded.refPaths.length;
        refBytes += loaded.refInfos.reduce((sum, r) => sum + r.bytes, 0);
      }
    }
    if (refCount > MAX_REFS) issues.push(`Slide ${num}: ${refCount} reference images exceed API maximum of ${MAX_REFS}`);
    if (refBytes > MAX_TOTAL_REF_BYTES) {
      issues.push(`Slide ${num}: aggregate reference payload (${refBytes} bytes) exceeds ${MAX_TOTAL_REF_BYTES} limit`);
    }
    resolvedCharsBySlide.push(slideChars);
  }

  let sourceSha256 = null;
  if (ep.mode === 'verbatim') {
    const { rel, full } = resolvePrimarySource(dir, ep);
    if (full) {
      try {
        const checked = await confineRelativeFile(dir, rel);
        if (checked.stat.size > MAX_SOURCE_BYTES) {
          issues.push(`Source file exceeds ${MAX_SOURCE_BYTES} bytes limit: ${rel}`);
        } else {
          const srcBytes = await readFile(checked.real);
          sourceSha256 = sha256Bytes(srcBytes);
          const sourceMeta = ep.source && typeof ep.source === 'object' ? ep.source : undefined;
          if (typeof sourceMeta?.sha256 === 'string' && sourceMeta.sha256 !== sourceSha256) {
            issues.push(`Source SHA-256 mismatch for ${rel}`);
          }
          if (Array.isArray(ep.slides)) {
            const errMsg = verifyVerbatim(ep.slides, srcBytes.toString('utf8'), sourceMeta);
            const issue = errMsg && `${errMsg} (${rel})`;
            if (issue && issue !== legacyVerbatimIssue) issues.push(issue);
          }
        }
      } catch (err) {
        issues.push(`Mode verbatim requires confined regular file ${rel}: ${err.message}`);
      }
    } else {
      issues.push(`Invalid or escaping verbatim source path: ${rel}`);
    }
  }

  const slideFingerprints = issues.length === 0
    ? slides.map((_, idx) => computeSlideFingerprint(ep, idx, resolvedCharsBySlide[idx] ?? [], styleReference?.sha256))
    : [];

  return {
    ok: issues.length === 0,
    mode: ep.mode ?? null,
    slideCount: slides.length,
    sourceSha256,
    resolvedCharsBySlide,
    styleReference,
    slideFingerprints,
    issues,
  };
}
