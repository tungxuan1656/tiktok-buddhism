import { lstat, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const isSafeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export const isSafeVersion = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value) && !value.includes('..');

export async function writeAtomic(target, content, mode = 0o644) {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf8', mode });
  await rename(tmp, target);
}

export const stripDotSlash = value => value.replace(/^(?:\.\/)+/, '');

/** Check lexical containment of a relative path within baseDir without hitting disk. */
export function confineRelativeLexical(baseDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0') || isAbsolute(relPath)) return null;
  if (relPath.split(/[\\/]/).includes('..')) return null;
  const base = resolve(baseDir);
  const full = resolve(base, relPath);
  const rel = relative(base, full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null;
  return full;
}

function isInsideReal(realBase, realTarget, allowSame = false) {
  const rel = relative(realBase, realTarget);
  if (!rel) return allowSame;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Resolve and verify an existing file or directory is confined inside at least one allowed root.
 * Rejects symlinks by default and checks realpath() to block symlink traversal.
 */
export async function confineExistingPath(allowedRoots, targetPath, {
  requireRegularFile = true,
  allowSymlink = false,
  allowRootItself = false,
} = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || targetPath.includes('\0')) {
    throw new Error('Invalid empty or malformed path');
  }
  const abs = resolve(targetPath);
  const lst = await lstat(abs);
  if (!allowSymlink && lst.isSymbolicLink()) {
    throw new Error(`Symlink is not allowed: ${targetPath}`);
  }
  const realTarget = await realpath(abs);
  const st = await stat(realTarget);
  if (requireRegularFile && !st.isFile()) {
    throw new Error(`Not a regular file: ${targetPath}`);
  }
  for (const root of allowedRoots) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot && isInsideReal(realRoot, realTarget, allowRootItself)) {
      return { abs, real: realTarget, stat: st };
    }
  }
  throw new Error(`Path escapes allowed directory: ${targetPath}`);
}

/**
 * Confine a relative path strictly inside baseDir, verifying no symlink escapes via realpath().
 */
export async function confineRelativeFile(baseDir, relPath, opts = {}) {
  const lexical = confineRelativeLexical(baseDir, relPath);
  if (!lexical) throw new Error(`Invalid or escaping relative path: ${String(relPath)}`);
  return confineExistingPath([baseDir], lexical, { requireRegularFile: true, ...opts });
}

/**
 * Verify a target path (which may not exist yet) has its closest existing ancestor strictly inside baseDir.
 */
export async function confineTargetPath(baseDir, targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim() || targetPath.includes('\0')) {
    throw new Error('Invalid target path');
  }
  const realBase = await realpath(baseDir);
  const absTarget = resolve(baseDir, targetPath);
  if (!isInsideReal(realBase, absTarget, false) && !isInsideReal(resolve(baseDir), absTarget, false)) {
    throw new Error(`Target path escapes episode directory: ${targetPath}`);
  }
  // Walk upward until an existing directory/entry is found to verify no symlink redirects outside baseDir.
  let probe = absTarget;
  while (true) {
    const lst = await lstat(probe).catch(err => (err.code === 'ENOENT' ? null : Promise.reject(err)));
    if (lst) {
      if (lst.isSymbolicLink()) throw new Error(`Target path traverses a symlink: ${targetPath}`);
      const realProbe = await realpath(probe);
      if (!isInsideReal(realBase, realProbe, true)) {
        throw new Error(`Target path escapes episode directory via symlink: ${targetPath}`);
      }
      return absTarget;
    }
    const parent = dirname(probe);
    if (parent === probe) throw new Error(`Invalid target path: ${targetPath}`);
    probe = parent;
  }
}
