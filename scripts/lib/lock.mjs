import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { confineTargetPath } from './paths.mjs';

export async function withEpisodeLock(episodeDir, fn, { timeoutMs = 10_000 } = {}) {
  const path = await confineTargetPath(episodeDir, '.episode-lock');
  const db = new DatabaseSync(path);
  const deadline = Date.now() + timeoutMs;
  try {
    // SQLite provides an OS-released file lock; no data is stored.
    while (true) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (error.errcode !== 5) throw error; // SQLITE_BUSY
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for episode lock (${path})`);
        await sleep(25);
      }
    }
    return await fn();
  } finally {
    db.close();
  }
}
