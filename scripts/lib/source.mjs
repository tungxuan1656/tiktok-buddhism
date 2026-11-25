import { resolve } from 'node:path';
import { confineRelativeLexical } from './paths.mjs';

const PRIMARY_FIELDS = ['file', 'path', 'text_path', 'text_file', 'verbatim_file'];

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
