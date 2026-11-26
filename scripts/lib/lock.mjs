import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { confineTargetPath } from './paths.mjs';

export const LOOKAHEAD_LOCK = '.lookahead-lock';

export class EpisodeLockBusyError extends Error {}

export async function acquireEpisodeLock(episodeDir, { timeoutMs = 10_000, name = '.episode-lock', probe = false } = {}) {
  const path = await confineTargetPath(episodeDir, name);
  const db = new DatabaseSync(path, { readOnly: probe });
  const deadline = Date.now() + timeoutMs;
  try {
    // SQLite provides an OS-released file lock; no data is stored.
    while (true) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        return () => db.close();
      } catch (error) {
        if (error.errcode !== 5) throw error; // SQLITE_BUSY
        if (Date.now() >= deadline) {
          if (!probe) throw new EpisodeLockBusyError(`Timed out waiting for episode lock (${path})`);
          db.close();
          return null;
        }
        await sleep(25);
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function withEpisodeLock(episodeDir, fn, { timeoutMs } = {}) {
  const release = await acquireEpisodeLock(episodeDir, { timeoutMs });
  try { return await fn(); }
  finally { release(); }
}
