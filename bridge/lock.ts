import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function acquireLock(stateDir: string): () => void {
  const db = new DatabaseSync(join(stateDir, 'bridge-lock.sqlite'));
  try {
    // A separate SQLite transaction is an OS-released process lock, not a stale PID file.
    db.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS singleton (id INTEGER PRIMARY KEY);');
  } catch {
    db.close();
    throw new Error('Bridge khác đang chạy hoặc không lấy được khóa SQLite');
  }
  return () => { db.exec('ROLLBACK'); db.close(); };
}
