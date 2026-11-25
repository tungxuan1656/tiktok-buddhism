import { createHash } from 'node:crypto';
import { IMAGE_MODEL, IMAGE_OUTPUT_FORMAT, IMAGE_SIZE, PROMPT_TEMPLATE_VERSION } from './policy.mjs';

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

/**
 * Deterministic fingerprint for a slide's content, scene, role, source bounds,
 * mode/source hash (for verbatim), and resolved character snapshots.
 */
export function computeSlideFingerprint(episode, slideIndex, resolvedChars = [], sourceSha256 = null) {
  const s = episode.slides[slideIndex];
  return sha256Canonical({
    mode: episode.mode ?? null,
    source_sha256: episode.mode === 'verbatim' ? (sourceSha256 ?? null) : null,
    slide: {
      text: s.text,
      scene: s.scene ?? null,
      scene_type: s.scene_type ?? null,
      role: s.role ?? null,
      source_start: s.source_start ?? null,
      source_end: s.source_end ?? null,
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
 * Fingerprint of everything that feeds prompt generation for one slide.
 */
export function computePromptInputFingerprint({ slideContentSha256, styleRefSha256 }) {
  return sha256Canonical({
    template_version: PROMPT_TEMPLATE_VERSION,
    slide_content_sha256: slideContentSha256,
    style_ref_sha256: styleRefSha256,
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
