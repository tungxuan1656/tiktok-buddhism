import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPath, checkedSlide, episodePages, imagePath, loadValidated } from './lib/episode.mjs';
import { withEpisodeLock } from './lib/lock.mjs';
import { confineRelativeFile, confineTargetPath, stripDotSlash, writeAtomic } from './lib/paths.mjs';
import { blockingAttempt, episodeAttempts, readRejection } from './lib/resume.mjs';
import { readImageInfo } from './lib/schema.mjs';

export async function exportSlide(dir, file, note) {
  if (typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 4000) throw new Error('Provide the visual check note (up to 4000 bytes)');
  file = stripDotSlash(file);
  return withEpisodeLock(dir, async () => {
    const { episode, validation } = await loadValidated(dir);
    const attempts = await episodeAttempts(dir);
    const attempt = attempts.find(a => `${a.path}/image.jpg` === file);
    const slide = attempt?.plan.slide;
    if (!attempt || attempt.plan.character || attempt.state !== 'succeeded' || !Number.isInteger(slide) ||
        slide < 1 || slide > episode.slides.length || blockingAttempt(attempts)) throw new Error('Expected a successful slide draft in an unblocked episode');
    const fp = validation.slideFingerprints[slide - 1];
    const input = await confineRelativeFile(dir, file);
    const info = await readImageInfo(input.real, { requireNormalized1080: true, includeBytes: true });
    if (info.mime !== 'image/jpeg' || info.sha256 !== attempt.output?.sha256 || fp !== attempt.slide_content_sha256 ||
        await readRejection(dir, fp, info.sha256)) throw new Error('Draft changed, is stale, or was rejected');
    const existing = await checkedSlide(dir, slide, fp);
    if (existing?.sha256 === info.sha256) return { action: 'reused', file: existing.file };
    const next = (await episodePages(dir, validation, attempts)).find(p => p.action !== 'keep');
    if (episode.status !== 'locked' || next?.action !== 'review' || next.file !== file) throw new Error('Only the current review draft may be exported');
    const image = imagePath(slide);
    const output = await confineTargetPath(dir, image);
    const check = await confineTargetPath(dir, checkPath(slide));
    await mkdir(dirname(output), { recursive: true });
    // Keep the draft reachable until the check is published; a crash is recoverable without another POST.
    const staging = await mkdtemp(join(dirname(output), '.export-'));
    try {
      const temp = join(staging, 'image.jpg');
      await writeFile(temp, info.buffer);
      await rename(temp, output);
      await writeAtomic(check, `${JSON.stringify({ image, image_sha256: info.sha256, slide_content_sha256: fp,
        request_sha256: attempt.request_sha256, visual_check: { passed: true, note: note.trim() } }, null, 2)}\n`);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return { action: 'exported', file: image };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, dir, draft, note, ...rest] = process.argv.slice(2);
  try {
    if (flag !== '--checked' || !dir || !draft || !note || rest.length) throw new Error('Usage: export-slide.mjs --checked DIR DRAFT_RELATIVE "visual check note"');
    console.log(JSON.stringify(await exportSlide(resolve(dir), draft, note)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
