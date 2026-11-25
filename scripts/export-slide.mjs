import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CHECKPOINT_SCHEMA_VERSION } from './lib/policy.mjs';
import { confineExistingPath, confineTargetPath, isSafeRevision } from './lib/paths.mjs';
import { readEpisodeJson, readImageInfo, validateEpisodeData } from './lib/schema.mjs';

async function publish(output, bytes, mismatch) {
  const alreadyExported = async () => {
    const existing = await lstat(output).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!existing) return false;
    if (existing.isSymbolicLink() || !existing.isFile() || existing.size !== bytes.length || !(await readFile(output)).equals(bytes)) {
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

async function resolveBoundContext(draftPath, outputPath, explicitEpisode, explicitRevision, explicitSlide) {
  let episodePath = explicitEpisode ? resolve(explicitEpisode) : null;
  if (!episodePath) {
    const outDir = dirname(resolve(outputPath));
    if (basename(dirname(outDir)) === 'output') {
      const candidate = resolve(outDir, '..', '..', 'episode.json');
      const st = await lstat(candidate).catch(() => null);
      if (st?.isFile()) episodePath = candidate;
    }
  }
  if (!episodePath) return null;

  const epDir = dirname(episodePath);
  await confineExistingPath([epDir], draftPath, { requireRegularFile: true });
  await confineTargetPath(epDir, outputPath);
  const ep = await readEpisodeJson(episodePath, epDir);
  const validation = await validateEpisodeData(ep, epDir, { stage: 'finalize' });
  if (!validation.ok) {
    throw new Error(`Episode validation failed before export: ${validation.issues.join('; ')}`);
  }

  const revision = explicitRevision ?? basename(dirname(resolve(outputPath)));
  if (!isSafeRevision(revision)) throw new Error(`Invalid revision "${revision}" for checkpoint binding`);
  const numMatch = /^(\d{3})\.(?:jpg|jpeg|png)$/i.exec(basename(outputPath));
  const slide = explicitSlide !== undefined ? Number(explicitSlide) : (numMatch ? Number(numMatch[1]) : NaN);
  if (!Number.isSafeInteger(slide) || slide < 1 || slide > ep.slides.length) {
    throw new Error(`Cannot determine valid slide index for output ${outputPath}`);
  }

  const imgInfo = await readImageInfo(draftPath, { requireNormalized1080: true });
  const liveSlideFp = validation.slideFingerprints[slide - 1];

  const draftStatusPath = join(dirname(resolve(draftPath)), 'status.json');
  const draftStatusStat = await lstat(draftStatusPath).catch(() => null);
  let draftRequestSha256 = null;
  if (draftStatusStat?.isFile()) {
    const draftStatus = JSON.parse(await readFile(draftStatusPath, 'utf8'));
    if (draftStatus?.plan?.slide !== undefined && draftStatus.plan.slide !== slide) {
      throw new Error(`Draft ${draftPath} belongs to slide ${draftStatus.plan.slide}, not slide ${slide}`);
    }
    if (draftStatus?.slide_content_sha256 && draftStatus.slide_content_sha256 !== liveSlideFp) {
      throw new Error(`Draft ${draftPath} is stale: slide ${slide} content or character snapshots changed since draft generation`);
    }
    draftRequestSha256 = draftStatus?.request_sha256 ?? null;
  }

  return { epDir, revision, slide, slideContentSha256: liveSlideFp, requestSha256: draftRequestSha256, imageSha256: imgInfo.sha256 };
}

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      checked: { type: 'boolean', default: false },
      episode: { type: 'string' },
      revision: { type: 'string' },
      slide: { type: 'string' },
    },
  });
  const checked = values.checked;
  if (positionals.length !== (checked ? 3 : 2) || (checked && !positionals[2].trim())) {
    throw new Error('Usage: node scripts/export-slide.mjs [--checked] [--episode EPISODE_JSON] [--revision rNN] [--slide N] DRAFT_IMAGE OUTPUT_IMAGE [VISUAL_CHECK_NOTE]');
  }
  const [draft, output, note] = positionals;
  const draftStat = await lstat(draft);
  if (draftStat.isSymbolicLink() || !draftStat.isFile()) throw new Error('Draft is not a regular file.');
  await confineExistingPath([dirname(resolve(draft))], draft, { requireRegularFile: true });
  const bytes = await readFile(draft);
  if (!bytes.length) throw new Error('Draft is empty.');

  const bound = checked ? await resolveBoundContext(draft, output, values.episode, values.revision, values.slide) : null;
  const state = await publish(output, bytes, 'Output exists and does not match the draft; left untouched.');
  if (!checked) {
    console.log(state);
  } else {
    const sha256 = b => createHash('sha256').update(b).digest('hex');
    const hash = sha256(bytes);
    if (hash !== sha256(await readFile(output))) throw new Error('Export SHA-256 verification failed; no checkpoint saved.');
    const dir = dirname(output);
    const checkpoint = join(dir, 'checks', `${basename(output)}.json`);

    const result = bound
      ? {
        schema_version: CHECKPOINT_SCHEMA_VERSION,
        revision: bound.revision,
        slide: bound.slide,
        image: basename(output),
        draft: relative(dir, draft),
        sha256: hash,
        image_sha256: bound.imageSha256,
        slide_content_sha256: bound.slideContentSha256,
        request_sha256: bound.requestSha256,
        visual_check: {
          passed: true,
          text: true,
          characters: true,
          composition: true,
          note: note.trim(),
        },
      }
      : { image: basename(output), draft: relative(dir, draft), sha256: hash, visual_check: note.trim() };

    await publish(checkpoint, Buffer.from(JSON.stringify(result, null, 2) + '\n'), 'Checkpoint exists with different data; left untouched.');
    console.log(JSON.stringify({ state, output, checkpoint, sha256: hash }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
