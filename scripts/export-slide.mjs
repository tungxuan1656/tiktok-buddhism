import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function exportSlide(draft, output) {
  if (!(await lstat(draft)).isFile()) throw new Error('Draft is not a regular file.');
  const bytes = await readFile(draft);
  if (!bytes.length) throw new Error('Draft is empty.');

  const alreadyExported = async () => {
    const existing = await lstat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!existing) return false;
    if (!existing.isFile() || existing.size !== bytes.length || !(await readFile(output)).equals(bytes)) {
      throw new Error('Output exists and does not match the draft; left untouched.');
    }
    return true;
  };

  if (await alreadyExported()) return 'reused';
  const dir = dirname(output);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(dir, '.export-'));
  try {
    const temp = join(tempDir, 'image');
    await writeFile(temp, bytes, { mode: 0o600 });
    // Publish the complete file atomically without replacing an existing output.
    try { await link(temp, output); }
    catch (error) {
      if (error.code === 'EEXIST' && await alreadyExported()) return 'reused';
      throw error;
    }
    return 'exported';
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
try {
  if (args.length !== 2) throw new Error('Usage: node scripts/export-slide.mjs DRAFT_IMAGE OUTPUT_IMAGE');
  console.log(await exportSlide(...args));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
