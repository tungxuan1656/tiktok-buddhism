import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

async function publish(output, bytes, mismatch) {
  const alreadyExported = async () => {
    const existing = await lstat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!existing) return false;
    if (!existing.isFile() || existing.size !== bytes.length || !(await readFile(output)).equals(bytes)) {
      throw new Error(mismatch);
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
  const checked = args[0] === '--checked';
  if (args.length !== (checked ? 4 : 2) || (checked && !args[3].trim())) {
    throw new Error('Usage: node scripts/export-slide.mjs [--checked] DRAFT_IMAGE OUTPUT_IMAGE [VISUAL_CHECK_NOTE]');
  }
  const [draft, output, note] = checked ? args.slice(1) : args;
  if (!(await lstat(draft)).isFile()) throw new Error('Draft is not a regular file.');
  const bytes = await readFile(draft);
  if (!bytes.length) throw new Error('Draft is empty.');
  const state = await publish(output, bytes, 'Output exists and does not match the draft; left untouched.');
  if (!checked) console.log(state);
  else {
    const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
    const hash = sha256(bytes);
    if (hash !== sha256(await readFile(output))) throw new Error('Export SHA-256 verification failed; no checkpoint saved.');
    const dir = dirname(output);
    const checkpoint = join(dir, 'checks', `${basename(output)}.json`);
    const result = { image: basename(output), draft: relative(dir, draft), sha256: hash, visual_check: note.trim() };
    await publish(checkpoint, Buffer.from(JSON.stringify(result, null, 2) + '\n'), 'Checkpoint exists with different data; left untouched.');
    console.log(JSON.stringify({ state, output, checkpoint, sha256: hash }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
