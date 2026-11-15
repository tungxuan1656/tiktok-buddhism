import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { hash } from './artifacts.ts';
import type { Run, Store, Task } from './store.ts';

async function directory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function unresolved(path: string): Promise<boolean> {
  if (!await directory(path)) return false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory() && await unresolved(full)) return true;
    if (entry.name === 'status.json') {
      if (!entry.isFile()) return true;
      try {
        if (['in_flight', 'unknown', 'received', 'normalize_failed'].includes(JSON.parse(await readFile(full, 'utf8')).state)) return true;
      } catch { return true; }
    }
  }
  return false;
}

async function sourceDependencies(base: string): Promise<string[]> {
  const protectedPaths: string[] = [];
  const protect = async (path: string) => { protectedPaths.push(resolve(path), await realpath(path)); };
  const snapshots = [join(base, 'episode.json')];
  for (const entry of await readdir(join(base, 'output'))) {
    if (/^r\d{2,}$/.test(entry) && await directory(join(base, 'output', entry))) snapshots.push(join(base, 'output', entry, 'episode.json'));
  }
  for (const path of snapshots) {
    try {
      const full = await realpath(path);
      if (!full.startsWith(base + sep) || (await lstat(full)).size > 128 * 1024) throw new Error('Unsafe snapshot');
      const episode = JSON.parse(await readFile(full, 'utf8'));
      if (typeof episode.source?.file === 'string') await protect(resolve(base, episode.source.file));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const links = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) await protect(full);
      else if (entry.isDirectory()) await links(full);
    }
  };
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) await protect(join(base, entry.name));
  }
  if (await directory(join(base, 'references'))) await links(join(base, 'references'));
  return protectedPaths;
}

// Only the newest fully acknowledged run may replace earlier files; interrupted work stays intact.
export async function pruneTask(store: Store, task: Task, stateDir: string, apply = true) {
  const skipped = (reason: string) => ({ removed: 0, skipped: reason });
  const runs = store.db.prepare('SELECT * FROM runs WHERE task=? ORDER BY rowid DESC').all(task.id) as Run[];
  const keep = runs[0];
  const files = keep ? store.deliveries(keep.id) : [];
  if (!['idle', 'closed'].includes(task.state) || keep?.state !== 'ready' || !keep.revision || !files.length || files.some(file => file.state !== 'sent')) return skipped('unfinished');
  if (!/^r\d{2,}$/.test(keep.revision) || !await directory(task.dir) || !await directory(stateDir)) return skipped('unsafe_path');
  const base = await realpath(task.dir);
  const state = await realpath(stateDir);
  if (!await directory(join(base, 'output')) || !await directory(join(base, 'output', keep.revision))) return skipped('unsafe_path');
  if (await unresolved(join(base, 'drafts'))) return skipped('unresolved_api');
  let current;
  try { current = JSON.parse(await readFile(join(base, 'episode.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (current && (!['ready_for_review', 'approved'].includes(current.status) || (current.revision && current.revision !== keep.revision))) return skipped('current_work');
  const episode = JSON.parse(await readFile(join(base, 'output', keep.revision, 'episode.json'), 'utf8'));
  if (!['ready_for_review', 'approved'].includes(episode.status) || !Array.isArray(episode.slides) || episode.slides.length !== files.length) return skipped('snapshot_mismatch');
  for (const [index, file] of files.entries()) {
    const image = episode.slides[index]?.image;
    const expected = `output/${keep.revision}/${basename(file.path)}`;
    const full = join(base, expected);
    if (image !== expected || await realpath(full) !== resolve(full) || hash(await readFile(full)) !== file.hash || hash(await readFile(file.path)) !== file.hash) return skipped('image_changed');
  }
  const targets: string[] = [];
  for (const entry of await readdir(join(base, 'output'))) {
    if (/^r\d{2,}$/.test(entry) && entry !== keep.revision) targets.push(join(base, 'output', entry));
  }
  for (const name of ['drafts', 'prompts']) {
    const path = join(base, name);
    if (await directory(path)) targets.push(path);
  }
  const older = runs.slice(1);
  for (const run of older) {
    if (!/^[a-f0-9-]{36}$/.test(run.id)) return skipped('unsafe_run');
    for (const parent of [join(base, 'handoff'), join(state, 'outbox')]) {
      if (await directory(parent) && (await readdir(parent)).includes(run.id)) targets.push(join(parent, run.id));
    }
  }
  const saved: unknown = JSON.parse(store.get(`retained_sources:${task.id}`) ?? '[]');
  if (!Array.isArray(saved) || saved.some(path => typeof path !== 'string')) throw new Error('Unsafe source dependencies');
  const dependencies = [...new Set<string>([...saved, ...await sourceDependencies(base)])];
  const disposable = targets.filter(path => !dependencies.some(source => source === path || source.startsWith(path + sep)));
  if (apply) {
    // Retire deliveries first so a crash cannot cause /resend to select deleted files.
    store.transaction(() => {
      // Keep dependency evidence even after its old episode snapshot is removed.
      store.set(`retained_sources:${task.id}`, JSON.stringify(dependencies));
      for (const run of older) {
        store.db.prepare("UPDATE runs SET state='retired' WHERE id=?").run(run.id);
        store.db.prepare('DELETE FROM deliveries WHERE run=?').run(run.id);
        store.db.prepare('DELETE FROM meta WHERE key=?').run(`delivery_format:${run.id}`);
      }
    });
    for (const path of disposable) await rm(path, { recursive: true, force: true });
  }
  return { removed: disposable.length, skipped: undefined };
}
