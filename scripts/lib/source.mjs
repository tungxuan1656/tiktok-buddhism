import { resolve } from 'node:path';
import { confineRelativeLexical } from './paths.mjs';

const PRIMARY_FIELDS = ['file', 'path', 'text_path', 'text_file', 'verbatim_file'];
const ALL_SOURCE_FIELDS = [...PRIMARY_FIELDS, 'received', 'metadata'];

/**
 * Resolve the primary verbatim source file path for an episode.
 * Never silently falls back to source.txt if an explicit source field is invalid.
 */
export function resolvePrimarySource(episodeDir, episode) {
  const dir = resolve(episodeDir);
  if (typeof episode?.source === 'string') {
    const rel = episode.source;
    const full = confineRelativeLexical(dir, rel);
    return { rel, full, explicit: true };
  }
  if (episode?.source && typeof episode.source === 'object') {
    for (const key of PRIMARY_FIELDS) {
      if (episode.source[key] !== undefined && episode.source[key] !== null) {
        const rel = episode.source[key];
        const full = confineRelativeLexical(dir, rel);
        return { rel: String(rel), full, explicit: true, field: key };
      }
    }
  }
  return { rel: 'source.txt', full: confineRelativeLexical(dir, 'source.txt'), explicit: false };
}

/**
 * Resolve all declared source file dependencies for retention/protection.
 * Rejects any explicit field that attempts path traversal or absolute escape.
 */
export function resolveSourceDependencies(episodeDir, episode) {
  const dir = resolve(episodeDir);
  const candidates = [];
  if (typeof episode?.source === 'string') {
    candidates.push(episode.source);
  } else if (episode?.source && typeof episode.source === 'object') {
    for (const key of ALL_SOURCE_FIELDS) {
      const value = episode.source[key];
      if (typeof value === 'string' && value.trim()) candidates.push(value);
    }
  }
  const seen = new Set();
  const resolved = [];
  for (const rel of candidates) {
    const full = confineRelativeLexical(dir, rel);
    if (!full) throw new Error(`Unsafe source dependency path: ${rel}`);
    if (!seen.has(full)) {
      seen.add(full);
      resolved.push(full);
    }
  }
  return resolved;
}
