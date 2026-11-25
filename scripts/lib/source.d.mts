export function resolvePrimarySource(
  episodeDir: string,
  episode: { source?: unknown },
): { rel: string; full: string | null; explicit: boolean; field?: string };

export function resolveSourceDependencies(
  episodeDir: string,
  episode: { source?: unknown },
): string[];
