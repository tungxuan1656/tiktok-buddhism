import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertEpisodeIdentity, blockingEpisodeAttempt, bundleTag, deliverableStatus, episodeBundle, episodePages, EpisodeStateError, imageBytes, isEpisodeCode, loadValidated, planHash, readEpisode, writeEpisode } from './lib/episode.mjs';
import { withEpisodeLock } from './lib/lock.mjs';
import { confineTargetPath, stripDotSlash, writeAtomic } from './lib/paths.mjs';
import { REPO_ROOT } from './lib/policy.mjs';
import { attemptIssue, episodeAttempts, imageError, readRejection, rejectionPath, statIfPresent, verifiedDraft } from './lib/resume.mjs';
import { slidePrompt } from './lib/prompt.mjs';

export async function createEpisode(root, title, request) {
  if (!title?.trim() || title.length > 200 || !request?.trim() || Buffer.byteLength(request) > 32_000) {
    throw new Error('Provide a title (up to 200 characters) and the original request (up to 32 KB)');
  }
  await mkdir(root, { recursive: true });
  return withEpisodeLock(root, async () => {
    const entries = await readdir(root);
    if (entries.some(name => /^telegram-/.test(name))) throw new Error('Finish migration before allocating an episode code');
    const largest = Math.max(0, ...entries.filter(isEpisodeCode).map(code => Number(code.slice(1))));
    const code = `T${largest + 1}`;
    if (!isEpisodeCode(code)) throw new Error('Episode codes exhausted');
    const staging = await mkdtemp(join(root, '.new-'));
    const dir = join(root, code);
    try {
      await writeEpisode(staging, { code, title: title.trim(), request, mode: 'original', status: 'draft', source: null, slides: [] });
      await rename(staging, dir);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return { code, dir };
  });
}

async function ensureUnblocked(dir) {
  const attempt = await blockingEpisodeAttempt(dir);
  if (attempt) throw new EpisodeStateError(`Episode blocked by ${attempt.path} (${imageError(attempt)}); run handoff`);
}

export async function changeEpisode(dir, command, { lockTimeoutMs, expectedBundleTag } = {}) {
  return withEpisodeLock(dir, async () => {
    await ensureUnblocked(dir);
    const episode = await readEpisode(dir);
    assertEpisodeIdentity(dir, episode);
    if (command === 'reopen') {
      episode.status = 'draft';
      delete episode.locked_sha256;
    } else if (command === 'lock') {
      if (episode.status !== 'draft') throw new EpisodeStateError('Reopen before changing a locked script');
      const { validation } = await loadValidated(dir, { requireLock: false });
      episode.locked_sha256 = planHash(episode, validation);
      episode.status = 'locked';
    } else if (command === 'finalize') {
      if (episode.status !== 'locked') {
        await episodeBundle(dir);
        return { code: episode.code, status: episode.status };
      }
      const { validation } = await loadValidated(dir);
      const pages = await episodePages(dir, validation, await episodeAttempts(dir));
      if (pages.some(p => p.action !== 'keep')) throw new EpisodeStateError('Missing verified images; run handoff');
      const files = new Set(pages.map(p => p.file));
      await removeObsolete(dir, 'artifact/images', /^\d{3}\.(?:jpg|jpeg|png)$/, name => files.has(`artifact/images/${name}`));
      await removeObsolete(dir, 'artifact/checks', /^\d{3}\.json$/, name => {
        const slide = Number(name.slice(0, 3));
        return slide >= 1 && slide <= pages.length;
      });
      episode.status = 'ready_for_review';
    } else if (command === 'publish') {
      if (expectedBundleTag !== undefined) {
        const bundle = await episodeBundle(dir);
        if (bundleTag(bundle.key) !== expectedBundleTag) {
          throw new EpisodeStateError('Episode bundle changed since button was sent', 'STALE_BUNDLE');
        }
        if (episode.status === 'published') return { code: episode.code, status: 'published' };
        episode.status = 'published';
      } else if (episode.status !== 'published') {
        await episodeBundle(dir);
        episode.status = 'published';
      }
    } else throw new Error(`Unknown state transition: ${command}`);
    await writeEpisode(dir, episode);
    return { code: episode.code, status: episode.status };
  }, lockTimeoutMs === undefined ? undefined : { timeoutMs: lockTimeoutMs });
}

async function removeObsolete(dir, path, pattern, keep) {
  const folder = await confineTargetPath(dir, path);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && pattern.test(entry.name) && !keep(entry.name)) await rm(join(folder, entry.name));
  }
}

export async function episodeHandoff(dir) {
  return withEpisodeLock(dir, async () => {
    const episode = await readEpisode(dir);
    assertEpisodeIdentity(dir, episode);
    const base = { code: episode.code, title: episode.title, status: episode.status };
    const blocked = await blockingEpisodeAttempt(dir);
    if (blocked) return { ...base, next: 'resolve_attempt', blocked: await attemptIssue(dir, blocked) };
    if (deliverableStatus(episode.status)) {
      try { return { ...base, next: 'done', files: (await episodeBundle(dir)).files.map(f => f.file) }; }
      catch (error) { return { ...base, next: 'inspect_artifact', issue: error.message }; }
    }
    const attempts = await episodeAttempts(dir);
    if (episode.status === 'draft') {
      const planned = new Set((Array.isArray(episode.slides) ? episode.slides : []).flatMap(slide =>
        Array.isArray(slide?.characters) ? slide.characters.map(c => `${c?.id}/${c?.version}`) : []));
      const character_drafts = [];
      for (const a of attempts.filter(a => a.plan.character && a.state === 'succeeded' && planned.has(a.plan.target))) {
        const [id, version] = a.plan.target.split('/');
        if (!await statIfPresent(join(dir, 'references', id, version, 'character.json')) &&
            !await readRejection(dir, a.slide_content_sha256, a.output?.sha256)) {
          if (!await verifiedDraft(dir, a)) return { ...base, next: 'resolve_attempt', blocked: await attemptIssue(dir, a) };
          character_drafts.push({ target: a.plan.target, file: `${a.path}/image.jpg` });
        }
      }
      return { ...base, next: 'prepare_script', character_drafts };
    }
    const { validation } = await loadValidated(dir);
    const pages = await episodePages(dir, validation, attempts);
    const next = pages.find(p => p.action !== 'keep');
    return { ...base, kept: pages.filter(p => p.action === 'keep').map(p => p.slide), total: pages.length,
      next: next?.action ?? 'finalize', page: next, blocked: next?.blocked };
  }, { timeoutMs: 0 });
}

export async function rejectImage(dir, input, note) {
  if (typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 4000) throw new Error('Describe the visual fault (up to 4000 bytes)');
  const file = stripDotSlash(input);
  return withEpisodeLock(dir, async () => {
    await ensureUnblocked(dir);
    const episode = await readEpisode(dir);
    assertEpisodeIdentity(dir, episode);
    if (deliverableStatus(episode.status)) throw new Error('Reopen this episode before rejecting a checked image');
    const image = await imageBytes(dir, file);
    const attempts = await episodeAttempts(dir);
    const attempt = attempts.find(a => `${a.path}/image.jpg` === file && a.state === 'succeeded' && a.output?.sha256 === image.sha256);
    let fp = attempt?.slide_content_sha256;
    if (file.startsWith('artifact/images/')) {
      const { validation: current } = await loadValidated(dir, { requireLock: false });
      const page = (await episodePages(dir, current, attempts)).find(p => p.file === file && p.sha256 === image.sha256);
      if (page) fp = current.slideFingerprints[page.slide - 1];
    } else if (attempt && !attempt.plan.character) {
      const { validation } = await loadValidated(dir);
      if (fp !== validation.slideFingerprints[attempt.plan.slide - 1]) fp = undefined;
    }
    if (!fp) throw new Error('Image is not a recorded draft or checked page');
    await writeAtomic(await confineTargetPath(dir, rejectionPath(fp, image.sha256)), `${JSON.stringify({
      slide_content_sha256: fp, image_sha256: image.sha256, note: note.trim(),
    }, null, 2)}\n`);
    return { rejected: file };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, arg, ...rest] = process.argv.slice(2);
  try {
    if (!arg) throw new Error('Usage: episode-tools.mjs new TITLE REQUEST | validate|lock|reopen|handoff|status|finalize|publish DIR | prompt DIR N | reject DIR FILE --note NOTE');
    const dir = resolve(arg);
    let result;
    if (command === 'new' && rest.length === 1) result = await createEpisode(join(REPO_ROOT, 'episodes'), arg, rest[0]);
    else if (command === 'validate' && !rest.length) result = (await loadValidated(dir, { requireLock: false })).validation;
    else if (['handoff', 'status'].includes(command) && !rest.length) result = await episodeHandoff(dir);
    else if (['lock', 'reopen', 'finalize', 'publish'].includes(command) && !rest.length) result = await changeEpisode(dir, command);
    else if (command === 'reject' && rest.length === 3 && rest[1] === '--note') result = await rejectImage(dir, rest[0], rest[2]);
    else if (command === 'prompt' && rest.length === 1) {
      const slide = Number(rest[0]);
      const { episode, validation } = await loadValidated(dir);
      if (!Number.isInteger(slide) || slide < 1 || slide > episode.slides.length) throw new Error('Invalid slide number');
      const state = (await episodeHandoff(dir)).page;
      result = slidePrompt(dir, episode, validation, slide, state?.slide === slide ? state.rejected?.note : undefined);
    } else throw new Error('Unknown command or invalid arguments');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
