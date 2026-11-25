import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CHECKPOINT_SCHEMA_VERSION, MAX_EPISODE_JSON_BYTES, MAX_IMAGE_BYTES } from './lib/policy.mjs';
import { confineExistingPath, confineTargetPath, isSafeRevision, publishExclusive } from './lib/paths.mjs';
import { checkpointIssue, isSha256, readEpisodeJson, readImageInfo, validateEpisodeData } from './lib/schema.mjs';
import { readRejection } from './lib/resume.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function resolveBoundContext(draftPath, outputPath, explicitEpisode, explicitRevision, explicitSlide, carryForward, importLegacy, recheckLegacy) {
  const outDir = dirname(resolve(outputPath));
  let episodePath = explicitEpisode ? resolve(explicitEpisode) : null;
  if (!episodePath) {
    if (basename(dirname(outDir)) === 'output') {
      const candidate = resolve(outDir, '..', '..', 'episode.json');
      const st = await lstat(candidate).catch(() => null);
      if (st?.isFile()) episodePath = candidate;
    }
  }
  if (!episodePath) {
    if (carryForward || importLegacy || recheckLegacy) throw new Error('Reuse requires an episode context (output/rNN/NNN.jpg or --episode)');
    return null;
  }

  const epDir = dirname(episodePath);
  const revision = basename(outDir);
  if (!isSafeRevision(revision) || outDir !== resolve(epDir, 'output', revision)) {
    throw new Error('Checked export must use the episode\'s output directory: output/rNN/NNN.jpg (or .jpeg/.png)');
  }
  if (explicitRevision !== undefined && explicitRevision !== revision) {
    throw new Error('--revision must match the output directory');
  }
  const numMatch = /^(\d{3})\.(?:jpg|jpeg|png)$/.exec(basename(outputPath));
  const slide = numMatch ? Number(numMatch[1]) : NaN;
  if (explicitSlide !== undefined && Number(explicitSlide) !== slide) {
    throw new Error('--slide must match the output filename');
  }

  const realEpPath = await realpath(episodePath);
  await confineExistingPath([epDir], draftPath, { requireRegularFile: true });
  await confineTargetPath(epDir, outputPath);
  const ep = await readEpisodeJson(episodePath, epDir);
  const validation = await validateEpisodeData(ep, epDir, { stage: 'finalize' });
  if (!validation.ok) {
    throw new Error(`Episode validation failed before export: ${validation.issues.join('; ')}`);
  }

  if (!Number.isSafeInteger(slide) || slide < 1 || slide > ep.slides.length) {
    throw new Error(`Cannot determine valid slide index for output ${outputPath}`);
  }

  const imgInfo = await readImageInfo(draftPath, { requireNormalized1080: true });
  const liveSlideFp = validation.slideFingerprints[slide - 1];
  if (await readRejection(epDir, liveSlideFp, imgInfo.sha256)) {
    throw new Error(`Cannot export visually rejected image: ${draftPath}`);
  }

  if (carryForward || importLegacy || recheckLegacy) {
    const srcDir = dirname(resolve(draftPath));
    const srcRev = basename(srcDir);
    const srcImgName = basename(draftPath);
    if (!isSafeRevision(srcRev) || resolve(epDir, 'output', srcRev) !== srcDir || BigInt(srcRev.slice(1)) >= BigInt(revision.slice(1)) ||
        !srcImgName.match(new RegExp(`^${String(slide).padStart(3, '0')}\\.(jpg|jpeg|png)$`, 'i'))) {
      throw new Error('Reuse requires the same slide from an earlier output revision');
    }
    const bound = { epDir, revision, slide, slideContentSha256: liveSlideFp, imageSha256: imgInfo.sha256 };
    const srcCheckPath = join(srcDir, 'checks', `${srcImgName}.json`);
    if (importLegacy || recheckLegacy) {
      let priorCheckHash;
      const priorCheck = await lstat(srcCheckPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (priorCheck) {
        const checked = await confineExistingPath([epDir], srcCheckPath, { requireRegularFile: true });
        if (checked.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Legacy checkpoint too large');
        const raw = await readFile(checked.real);
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.image === srcImgName && checkpoint.sha256 === imgInfo.sha256) priorCheckHash = sha256(raw);
        if ((checkpoint?.schema_version ?? 0) >= CHECKPOINT_SCHEMA_VERSION || checkpoint?.slide_content_sha256 !== undefined) {
          throw new Error('Source already has a bound checkpoint; verify it with --carry-forward');
        }
        if (checkpoint?.sha256 && checkpoint.sha256 !== imgInfo.sha256) throw new Error('Legacy image SHA-256 mismatch');
      }
      const snapshotPath = join(srcDir, 'episode.json');
      if (recheckLegacy) {
        if (await lstat(snapshotPath).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        })) throw new Error('Legacy snapshot exists; use --import-legacy');
        if (!priorCheckHash) throw new Error('--recheck-legacy requires a legacy checkpoint with the exact image name and SHA-256');
        return { ...bound, requestSha256: null, legacyImport: { revision: srcRev, rechecked_from_sha256: priorCheckHash } };
      }
      const checked = await confineExistingPath([epDir], snapshotPath, { requireRegularFile: true });
      if (checked.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Legacy snapshot too large');
      const raw = await readFile(checked.real);
      const snapshot = JSON.parse(raw.toString('utf8'));
      if ((snapshot.revision && snapshot.revision !== srcRev) || !['ready_for_review', 'approved'].includes(snapshot.status) ||
          snapshot.slides?.[slide - 1]?.image !== `output/${srcRev}/${srcImgName}`) {
        throw new Error('Legacy snapshot does not identify this image and slide');
      }
      const prior = await validateEpisodeData(snapshot, epDir, { stage: 'finalize' });
      if (!prior.ok || prior.slideFingerprints[slide - 1] !== liveSlideFp) throw new Error('Cannot import legacy image: slide or episode content changed');
      return { ...bound, requestSha256: null, legacyImport: { revision: srcRev, snapshot_sha256: sha256(raw) } };
    }
    const checkedSrcCk = await confineExistingPath([epDir], srcCheckPath, { requireRegularFile: true }).catch(() => null);
    if (!checkedSrcCk || checkedSrcCk.stat.size > MAX_EPISODE_JSON_BYTES) {
      throw new Error(`--carry-forward requires a verified source checkpoint at ${srcCheckPath}`);
    }
    const raw = await readFile(checkedSrcCk.real);
    const srcCk = JSON.parse(raw.toString('utf8'));
    const issue = checkpointIssue(srcCk, { revision: srcRev, slide, image: srcImgName, imageSha256: imgInfo.sha256, slideSha256: liveSlideFp });
    if (issue) throw new Error(`Cannot carry forward slide ${slide}: ${issue}`);
    return { ...bound, requestSha256: srcCk.request_sha256, legacyImport: srcCk.legacy_import,
      carriedFrom: { revision: srcRev, image: srcImgName, check_sha256: sha256(raw) } };
  }

  const draftStatusPath = join(dirname(resolve(draftPath)), 'status.json');
  const checkedStatus = await confineExistingPath([epDir], draftStatusPath, { requireRegularFile: true }).catch(() => null);
  if (!checkedStatus || checkedStatus.stat.size > MAX_EPISODE_JSON_BYTES) {
    throw new Error(`Draft ${draftPath} is missing required status.json provenance`);
  }
  const draftStatus = JSON.parse(await readFile(checkedStatus.real, 'utf8'));
  if (draftStatus?.state !== 'succeeded') {
    throw new Error(`Draft ${draftPath} is in state "${draftStatus?.state}", expected "succeeded"`);
  }
  if (!draftStatus?.plan?.file || (await realpath(draftStatus.plan.file).catch(() => null)) !== realEpPath || draftStatus.plan.character) {
    throw new Error(`Draft ${draftPath} does not belong to episode ${episodePath}`);
  }
  if (draftStatus.plan.slide !== slide) {
    throw new Error(`Draft ${draftPath} belongs to slide ${draftStatus.plan.slide}, not slide ${slide}`);
  }
  if (draftStatus.slide_content_sha256 !== liveSlideFp) {
    throw new Error(`Draft ${draftPath} is missing or stale: slide ${slide} content or character snapshots changed`);
  }
  if (!isSha256(draftStatus.request_sha256)) {
    throw new Error(`Draft ${draftPath} is missing valid request_sha256 provenance`);
  }
  if (draftStatus.output?.sha256 !== imgInfo.sha256) {
    throw new Error(`Draft ${draftPath} image SHA-256 mismatch against status.output.sha256`);
  }

  return {
    epDir,
    revision,
    slide,
    slideContentSha256: liveSlideFp,
    requestSha256: draftStatus.request_sha256,
    imageSha256: imgInfo.sha256,
    carriedFrom: null,
  };
}

try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      checked: { type: 'boolean', default: false },
      'carry-forward': { type: 'boolean', default: false },
      'import-legacy': { type: 'boolean', default: false },
      'recheck-legacy': { type: 'boolean', default: false },
      episode: { type: 'string' },
      revision: { type: 'string' },
      slide: { type: 'string' },
    },
  });
  const checked = values.checked;
  const carryForward = values['carry-forward'];
  const importLegacy = values['import-legacy'];
  const recheckLegacy = values['recheck-legacy'];
  const reuseFlags = [carryForward, importLegacy, recheckLegacy].filter(Boolean).length;
  if (reuseFlags > 1 || (reuseFlags && !checked)) {
    throw new Error('Choose at most one of --carry-forward, --import-legacy, or --recheck-legacy and use it with --checked');
  }
  if (positionals.length !== (checked ? 3 : 2) || (checked && !positionals[2].trim())) {
    throw new Error('Usage: node scripts/export-slide.mjs [--checked] [--carry-forward|--import-legacy|--recheck-legacy] [--episode EPISODE_JSON] [--revision rNN] [--slide N] DRAFT_IMAGE OUTPUT_IMAGE [VISUAL_CHECK_NOTE]');
  }
  const [draft, output, note] = positionals;
  const draftStat = await lstat(draft);
  if (draftStat.isSymbolicLink() || !draftStat.isFile()) throw new Error('Draft is not a regular file.');
  await confineExistingPath([dirname(resolve(draft))], draft, { requireRegularFile: true });
  if (!draftStat.size || draftStat.size > MAX_IMAGE_BYTES) throw new Error('Invalid draft image size.');
  const bytes = await readFile(draft);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid draft image size.');

  const bound = checked ? await resolveBoundContext(draft, output, values.episode, values.revision, values.slide, carryForward, importLegacy, recheckLegacy) : null;
  const hash = sha256(bytes);
  if (bound && bound.imageSha256 !== hash) throw new Error('Draft changed during provenance validation.');
  const dir = dirname(output);
  const checkpointPath = resolve(dir, 'checks', `${basename(output)}.json`);
  if (bound) {
    await confineTargetPath(bound.epDir, resolve(dir, 'checks'));
    await confineTargetPath(bound.epDir, checkpointPath);
  }
  const state = await publishExclusive(output, bytes, 'Output exists and does not match the draft; left untouched.');
  if (!checked) {
    console.log(state);
  } else {
    if (hash !== sha256(await readFile(output))) throw new Error('Export SHA-256 verification failed; no checkpoint saved.');
    await confineTargetPath(dir, 'checks');
    const checkpoint = await confineTargetPath(dir, checkpointPath);
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
        ...(bound.legacyImport ? { legacy_import: bound.legacyImport } : {}),
        ...(bound.carriedFrom ? { carried_from: bound.carriedFrom } : {}),
        visual_check: {
          passed: true,
          text: true,
          characters: true,
          composition: true,
          note: note.trim(),
        },
      }
      : { image: basename(output), draft: relative(dir, draft), sha256: hash, visual_check: note.trim() };

    await publishExclusive(checkpoint, Buffer.from(JSON.stringify(result, null, 2) + '\n'), 'Checkpoint exists with different data; left untouched.');
    console.log(JSON.stringify({ state, output, checkpoint, sha256: hash }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
