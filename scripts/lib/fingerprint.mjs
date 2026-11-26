import { createHash } from 'node:crypto';
import { IMAGE_MODEL, IMAGE_OUTPUT_FORMAT, IMAGE_SIZE } from './policy.mjs';

export const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256Canonical = value => sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));

export function normalizeObjectsValue(rawObjects) {
  if (Array.isArray(rawObjects)) {
    const items = rawObjects.map(v => String(v ?? '').trim()).filter(Boolean);
    return items.length ? items : null;
  }
  if (typeof rawObjects === 'string') {
    const trimmed = rawObjects.trim();
    return trimmed || null;
  }
  return null;
}

// Bind the page and its characters; the episode lock binds the full source.
export function computeSlideFingerprint(episode, slideIndex, resolvedChars = [], styleSha256) {
  const s = episode.slides[slideIndex];
  return sha256Canonical({
    mode: episode.mode ?? null,
    style_ref_sha256: styleSha256,
    slide: {
      text: s.text,
      scene: s.scene ?? null,
      scene_type: s.scene_type ?? null,
      role: s.role ?? null,
      objects: normalizeObjectsValue(s.objects),
    },
    characters: resolvedChars.map(c => ({
      id: c.id,
      version: c.version,
      character_json_sha256: c.jsonSha256,
      reference_hashes: c.refInfos.map(r => r.sha256),
    })),
  });
}

/**
 * Fingerprint of the exact API generation request: slide content, prompt bytes,
 * ordered reference image bytes, model, size, and output_format.
 */
export function computeRequestFingerprint({
  slideContentSha256,
  promptSha256,
  referenceHashes,
  model = IMAGE_MODEL,
  size = IMAGE_SIZE,
  outputFormat = IMAGE_OUTPUT_FORMAT,
}) {
  return sha256Canonical({
    model,
    size,
    output_format: outputFormat,
    slide_content_sha256: slideContentSha256,
    prompt_sha256: promptSha256,
    reference_hashes: referenceHashes,
  });
}
