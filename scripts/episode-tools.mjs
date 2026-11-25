import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  computePromptInputFingerprint,
  computeRequestFingerprint,
  normalizeObjectsValue,
  sha256Bytes,
} from './lib/fingerprint.mjs';
import { withEpisodeLock } from './lib/lock.mjs';
import {
  confineExistingPath,
  confineRelativeFile,
  confineTargetPath,
  isSafeAttempt,
  isSafeRevision,
  publishExclusive,
  writeAtomic,
} from './lib/paths.mjs';
import {
  DEFAULT_STYLE_REL,
  MAX_REFS,
  MAX_EPISODE_JSON_BYTES,
  REPO_ROOT,
  UNRESOLVED_STATES,
} from './lib/policy.mjs';
import { checkpointIssue, readEpisodeJson, readImageInfo, validateEpisodeData } from './lib/schema.mjs';

const pad3 = n => String(n).padStart(3, '0');

function formatCharDesc(loaded) {
  const id = loaded.data.identity ?? {};
  const parts = [id.face, id.hair, id.body, id.clothing].filter(Boolean).join('; ');
  const keep = Array.isArray(loaded.data.keep) && loaded.data.keep.length ? ` Giữ: ${loaded.data.keep.join('; ')}.` : '';
  const avoid = Array.isArray(loaded.data.avoid) && loaded.data.avoid.length ? ` Tránh: ${loaded.data.avoid.join('; ')}.` : '';
  return `${loaded.id}/${loaded.version} (${parts}${keep}${avoid})`;
}

async function resolveStyleRef(episodeDir, styleRef) {
  const allowedRoots = [episodeDir, join(REPO_ROOT, 'references')];
  if (styleRef) {
    const candidates = isAbsolute(styleRef) ? [styleRef] : [resolve(episodeDir, styleRef), resolve(REPO_ROOT, styleRef)];
    for (const candidate of candidates) {
      const checked = await confineExistingPath(allowedRoots, candidate, { requireRegularFile: true }).catch(() => null);
      if (checked) return checked.real;
    }
    throw new Error(`Missing or unsafe style reference: ${styleRef}`);
  }
  const epCandidate = join(episodeDir, DEFAULT_STYLE_REL);
  const epChecked = await confineExistingPath([episodeDir], epCandidate, { requireRegularFile: true }).catch(() => null);
  if (epChecked) return epChecked.real;
  const repoCandidate = join(REPO_ROOT, DEFAULT_STYLE_REL);
  const repoChecked = await confineExistingPath([join(REPO_ROOT, 'references')], repoCandidate, { requireRegularFile: true }).catch(() => null);
  if (repoChecked) return repoChecked.real;
  throw new Error(`Missing style reference: ${DEFAULT_STYLE_REL}`);
}

export function parseSlidesSpec(spec, maxSlide) {
  if (spec === undefined) return undefined;
  const selected = new Set();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Invalid --slides entry: "${spec}"`);
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end > maxSlide) throw new Error(`Slide range "${part}" out of 1-${maxSlide}`);
      for (let n = start; n <= end; n++) selected.add(n);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`Invalid slide number "${part}" in --slides`);
    const num = Number(part);
    if (num < 1 || num > maxSlide) throw new Error(`Slide ${num} out of 1-${maxSlide}`);
    selected.add(num);
  }
  if (!selected.size) throw new Error('Empty --slides selection');
  return [...selected].sort((a, b) => a - b);
}

/** Validate episode JSON schema, editorial text checks, verbatim source match, and character snapshots. */
export async function validateEpisode(episodeDir) {
  const dir = resolve(episodeDir);
  const epPath = join(dir, 'episode.json');
  const exists = await lstat(epPath).then(() => true, () => false);
  if (!exists) return { ok: false, issues: ['Missing episode.json'] };
  const ep = await readEpisodeJson(epPath, dir);
  const res = await validateEpisodeData(ep, dir, { stage: 'validate' });
  return {
    ok: res.ok,
    mode: res.mode,
    slideCount: res.slideCount,
    sourceSha256: res.sourceSha256,
    slideFingerprints: res.slideFingerprints,
    issues: res.issues,
  };
}

/** Generate slide prompt files and batch manifest JSON from validated episode.json and character snapshots. */
export async function buildPrompts(episodeDir, {
  revision = 'r01',
  attempt = 'a1',
  slides: onlySlides,
  force = false,
  override = false,
  styleRef,
} = {}) {
  if (!isSafeRevision(revision)) throw new Error(`Invalid revision "${revision}" (expected r01, r02...)`);
  if (!isSafeAttempt(attempt)) throw new Error(`Invalid attempt "${attempt}"`);
  const dir = resolve(episodeDir);
  const ep = await readEpisodeJson(join(dir, 'episode.json'), dir);
  const validation = await validateEpisodeData(ep, dir, { stage: 'build' });
  if (!validation.ok) {
    throw new Error(`Episode validation failed before build-prompts:\n- ${validation.issues.join('\n- ')}`);
  }

  if (onlySlides) {
    if (!Array.isArray(onlySlides) || !onlySlides.length || onlySlides.some(n => !Number.isSafeInteger(n) || n < 1 || n > ep.slides.length)) {
      throw new Error(`Invalid slides selection for 1-${ep.slides.length}`);
    }
  }

  const resolvedStyleRef = await resolveStyleRef(dir, styleRef);
  const styleInfo = await readImageInfo(resolvedStyleRef);
  await confineTargetPath(dir, 'prompts');
  await mkdir(join(dir, 'prompts'), { recursive: true });

  const generated = [];
  const skipped = [];
  const manifest = [];

  for (let i = 0; i < ep.slides.length; i++) {
    const num = i + 1;
    if (onlySlides && !onlySlides.includes(num)) continue;
    const s = ep.slides[i];
    const resolvedChars = validation.resolvedCharsBySlide[i] ?? [];
    const slideContentSha256 = validation.slideFingerprints[i];
    const inputSha256 = computePromptInputFingerprint({
      slideContentSha256,
      styleRefSha256: styleInfo.sha256,
    });

    const refs = [resolvedStyleRef];
    const refHashes = [styleInfo.sha256];
    const refLabels = ['1. Ảnh phong cách (chỉ tham chiếu nét chì, kiểu chữ, nền giấy và khoảng trắng; không chép chữ/người/vật)'];
    const charDescs = [];

    for (const loaded of resolvedChars) {
      charDescs.push(formatCharDesc(loaded));
      for (let idx = 0; idx < loaded.refPaths.length; idx++) {
        refs.push(join(dir, loaded.refPaths[idx]));
        refHashes.push(loaded.refInfos[idx].sha256);
        refLabels.push(`${refs.length}. Định danh ${loaded.id}/${loaded.version} (giữ khuôn mặt, tóc, vóc dáng, y phục; không chép tư thế/nền mẫu)`);
      }
    }
    if (refs.length > MAX_REFS) throw new Error(`Slide ${num}: ${refs.length} reference images exceed API maximum of ${MAX_REFS}`);

    const symbolic = s.scene_type === 'simile' || s.scene_type === 'concept'
      ? ' Hình biểu trưng, không dựng thành sự kiện lịch sử.' : '';
    const allowedObjects = normalizeObjectsValue(s.objects);
    const allowedObjectsText = Array.isArray(allowedObjects) ? allowedObjects.join(', ') : allowedObjects;
    const objectLine = allowedObjectsText
      ? `Vật thể được phép: ${allowedObjectsText}. Không thêm người, vật thể, hào quang hay hiệu ứng ngoài danh sách.`
      : 'Không thêm người, vật thể, hào quang hay hiệu ứng ngoài cảnh yêu cầu.';
    const content = [
      'Tạo 1 slide minh họa Phật giáo 2D hoàn chỉnh (khung dọc 3:4, mục tiêu 1080 × 1440), có đúng đoạn chữ tiếng Việt bên dưới.',
      '- Phong cách: nét chì màu mảnh, vàng đất/nâu dịu; nền giấy gần trắng, sáng trung tính, không phủ kem/vàng; 1 cụm minh họa gọn, ít chi tiết, nhiều khoảng trắng; biểu cảm trang nghiêm, hiền hòa. Không ảnh chụp, 3D, anime, khung, bong bóng thoại, logo, watermark hay chữ trang trí.',
      '- Bố cục & chữ: bố cục linh hoạt, tranh và chữ đầy đủ, rõ ràng, không che nhau/cắt mép; không thu nhỏ chữ để ép khung. Dùng chữ KHÔNG CHÂN, nét tròn mềm, đều nét, hơi giống chữ viết tay, rõ dấu tiếng Việt, cỡ tương đương 44–52 px khi xuất, màu nâu sẫm #4B2F1E, canh giữa, lề thoáng. Không dùng serif, chữ sách cổ hoặc nét đậm nặng.',
      '',
      'CHỮ CẦN IN — chỉ in nguyên văn phần giữa hai dòng phân cách (không in dòng phân cách/nhãn, không sửa/thêm/bớt từ hay dấu, không thêm ngoặc kép/tiêu đề/số trang/chú thích, không chép chữ từ ảnh mẫu):',
      '--- BẮT ĐẦU VĂN BẢN ---',
      s.text,
      '--- KẾT THÚC VĂN BẢN ---',
      '',
      'Ảnh tham chiếu gửi kèm (theo đúng thứ tự, tối đa 10 ảnh):',
      ...refLabels,
      '',
      `Loại cảnh: ${s.scene_type}.${symbolic}`,
      `Cảnh: ${s.scene}`,
      `Nhân vật: ${charDescs.length ? charDescs.join('; ') : 'không có'}.`,
      objectLine,
      '',
    ].join('\n');

    const generatedPromptSha256 = sha256Bytes(Buffer.from(content, 'utf8'));
    const promptRel = join('prompts', `${pad3(num)}-${revision}.txt`);
    const metaRel = join('prompts', `${pad3(num)}-${revision}.meta.json`);
    const promptAbs = await confineTargetPath(dir, promptRel);
    const metaAbs = await confineTargetPath(dir, metaRel);

    const promptExists = await lstat(promptAbs).then(() => true, () => false);
    let finalPromptSha256 = generatedPromptSha256;

    if (promptExists && !force) {
      const checkedPrompt = await confineRelativeFile(dir, promptRel);
      const checkedMeta = await confineRelativeFile(dir, metaRel).catch(() => null);
      if (!checkedMeta) {
        throw new Error(`Untracked or missing metadata for existing prompt ${promptRel}; rebuild with --force`);
      }
      const meta = JSON.parse(await readFile(checkedMeta.real, 'utf8'));
      if (meta?.input_sha256 !== inputSha256 || meta?.slide_content_sha256 !== slideContentSha256) {
        throw new Error(`Stale prompt for slide ${num} (${promptRel}): episode content or references changed; rebuild with --force or use a new revision`);
      }
      const existingPromptBytes = await readFile(checkedPrompt.real);
      const actualPromptSha256 = sha256Bytes(existingPromptBytes);
      if (actualPromptSha256 !== meta.prompt_sha256) {
        if (!override) {
          throw new Error(`Prompt ${promptRel} was modified manually; pass --override to acknowledge manual edit or --force to regenerate`);
        }
        await writeAtomic(metaAbs, `${JSON.stringify({
          ...meta,
          prompt_sha256: actualPromptSha256,
          override: true,
        }, null, 2)}\n`);
      }
      finalPromptSha256 = actualPromptSha256;
      skipped.push(promptRel);
    } else {
      await writeAtomic(promptAbs, content);
      await writeAtomic(metaAbs, `${JSON.stringify({
        schema_version: 1,
        revision,
        slide: num,
        input_sha256: inputSha256,
        slide_content_sha256: slideContentSha256,
        prompt_sha256: generatedPromptSha256,
        style_ref_sha256: styleInfo.sha256,
        override: false,
      }, null, 2)}\n`);
      generated.push(promptRel);
    }

    const workDir = await confineTargetPath(dir, join('drafts', `${pad3(num)}-${revision}-${attempt}`));
    const requestSha256 = computeRequestFingerprint({
      slideContentSha256,
      promptSha256: finalPromptSha256,
      referenceHashes: refHashes,
    });
    manifest.push({
      slide: num,
      promptFile: promptAbs,
      workDir,
      references: refs,
      slide_content_sha256: slideContentSha256,
      prompt_sha256: finalPromptSha256,
      request_sha256: requestSha256,
    });
  }

  const manifestPath = await confineTargetPath(dir, join('prompts', `batch-${revision}.json`));
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, revision, attempt, generated: generated.length, skipped: skipped.length, batchManifest: manifestPath };
}

function attemptSortKey(name) {
  const m = /-a(\d+)$/i.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Report draft, export, and verified visual-check status for every slide in the given revision. */
export async function episodeStatus(episodeDir, { revision = 'r01' } = {}) {
  if (!isSafeRevision(revision)) throw new Error(`Invalid revision "${revision}" (expected r01, r02...)`);
  const dir = resolve(episodeDir);
  const ep = await readEpisodeJson(join(dir, 'episode.json'), dir);
  const validation = await validateEpisodeData(ep, dir, { stage: 'validate' });
  const draftsDir = join(dir, 'drafts');
  const draftEntries = await lstat(draftsDir).then(st => st.isDirectory(), () => false)
    ? (await readdir(draftsDir)).sort((a, b) => {
      const diff = attemptSortKey(a) - attemptSortKey(b);
      return diff !== 0 ? diff : a.localeCompare(b, undefined, { numeric: true });
    })
    : [];

  const slides = [];
  for (let i = 0; i < (ep.slides?.length ?? 0); i++) {
    const num = i + 1;
    const prefix = `${pad3(num)}-${revision}`;
    const matching = draftEntries.filter(name => name === prefix || name.startsWith(`${prefix}-`));
    const latestDraft = matching.at(-1) ?? null;
    let draftState = null;
    const unresolvedAttempts = [];
    for (const d of matching) {
      const checked = await confineRelativeFile(dir, join('drafts', d, 'status.json')).catch(() => null);
      if (!checked) continue;
      const rec = JSON.parse(await readFile(checked.real, 'utf8'));
      if (d === latestDraft) draftState = rec.state ?? null;
      if (UNRESOLVED_STATES.has(rec.state)) unresolvedAttempts.push({ draft: d, state: rec.state });
    }

    let imgName = null;
    let exportState = 'missing';
    let actualImgHash = null;
    for (const ext of ['.jpg', '.jpeg', '.png']) {
      const relOut = join('output', revision, `${pad3(num)}${ext}`);
      const candidateExists = await lstat(join(dir, relOut)).then(() => true, () => false);
      if (!candidateExists) continue;
      imgName = `${pad3(num)}${ext}`;
      try {
        const checkedOut = await confineRelativeFile(dir, relOut);
        const info = await readImageInfo(checkedOut.real, { requireNormalized1080: true });
        actualImgHash = info.sha256;
        exportState = 'verified';
      } catch {
        exportState = 'corrupted';
      }
      break;
    }

    let checkState = 'missing';
    if (imgName) {
      const relCheck = join('output', revision, 'checks', `${imgName}.json`);
      const checkExists = await lstat(join(dir, relCheck)).then(() => true, () => false);
      if (checkExists) {
        try {
          const checkedFile = await confineRelativeFile(dir, relCheck);
          if (checkedFile.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error('Checkpoint too large');
          const ck = JSON.parse(await readFile(checkedFile.real, 'utf8'));
          const issue = checkpointIssue(ck, { revision, slide: num, image: imgName, imageSha256: actualImgHash, slideSha256: validation.slideFingerprints[i] });
          checkState = !issue ? 'verified' : /^(Stale visual check|SHA-256 mismatch)/.test(issue) ? 'stale' : 'corrupted';
        } catch {
          checkState = 'corrupted';
        }
      }
    }

    slides.push({
      slide: num,
      draft: latestDraft,
      draftState,
      unresolvedAttempts,
      exported: exportState === 'verified',
      exportState,
      checked: checkState === 'verified',
      checkState,
    });
  }
  return { episodeDir: dir, revision, valid: validation.ok, slideCount: slides.length, slides };
}

/** Verify exported outputs, image validity, and bound visual-check checkpoints, then immutably commit the revision snapshot. */
export async function finalizeEpisode(episodeDir, { revision = 'r01' } = {}) {
  if (!isSafeRevision(revision)) throw new Error(`Invalid revision "${revision}" (expected r01, r02...)`);
  const dir = resolve(episodeDir);
  return withEpisodeLock(dir, async () => {
    const epPath = join(dir, 'episode.json');
    const ep = await readEpisodeJson(epPath, dir);
    const validation = await validateEpisodeData(ep, dir, { stage: 'finalize' });
    if (!validation.ok) {
      throw new Error(`Episode validation failed before finalize:\n- ${validation.issues.join('\n- ')}`);
    }
    if (isSafeRevision(ep.revision) && BigInt(ep.revision.slice(1)) > BigInt(revision.slice(1))) {
      throw new Error(`Cannot finalize older revision ${revision}; current revision is ${ep.revision}`);
    }
    if (ep.status === 'approved' && ep.revision === revision) {
      throw new Error(`Revision ${revision} is already approved and cannot be re-finalized`);
    }

    const outRelDir = join('output', revision);
    await confineTargetPath(dir, outRelDir);
    const files = [];

    for (let i = 0; i < ep.slides.length; i++) {
      const num = i + 1;
      const base = pad3(num);
      let imgName;
      let checkedImg;
      for (const ext of ['.jpg', '.jpeg', '.png']) {
        const relCandidate = join(outRelDir, `${base}${ext}`);
        const candidateExists = await lstat(join(dir, relCandidate)).then(() => true, () => false);
        if (candidateExists) {
          checkedImg = await confineRelativeFile(dir, relCandidate);
          imgName = `${base}${ext}`;
          break;
        }
      }
      if (!imgName || !checkedImg) {
        throw new Error(`Missing exported image for slide ${num} in output/${revision}/`);
      }
      const imgInfo = await readImageInfo(checkedImg.real, { requireNormalized1080: true });
      const checkRel = join(outRelDir, 'checks', `${imgName}.json`);
      const checkedCk = await confineRelativeFile(dir, checkRel).catch(() => null);
      if (!checkedCk) {
        throw new Error(`Missing check checkpoint for slide ${num}: output/${revision}/checks/${imgName}.json`);
      }
      if (checkedCk.stat.size > MAX_EPISODE_JSON_BYTES) throw new Error(`Checkpoint too large for slide ${num}`);
      const check = JSON.parse(await readFile(checkedCk.real, 'utf8'));
      const issue = checkpointIssue(check, { revision, slide: num, image: imgName, imageSha256: imgInfo.sha256, slideSha256: validation.slideFingerprints[i] });
      if (issue) throw new Error(issue);
      const relPath = `output/${revision}/${imgName}`;
      ep.slides[i].image = relPath;
      files.push(relPath);
    }

    ep.revision = revision;
    ep.status = 'ready_for_review';
    const serialized = `${JSON.stringify(ep, null, 2)}\n`;
    const snapshotRel = join(outRelDir, 'episode.json');
    const snapshotTarget = await confineTargetPath(dir, snapshotRel);

    const publishState = await publishExclusive(
      snapshotTarget,
      Buffer.from(serialized, 'utf8'),
      `Finalized snapshot output/${revision}/episode.json already exists with different content; create a new revision instead of overwriting`,
      0o644,
    );
    const currentEpRaw = await readFile(epPath, 'utf8');
    if (currentEpRaw !== serialized) await writeAtomic(epPath, serialized);
    return {
      ok: true,
      ...(publishState === 'reused' ? { idempotent: true } : {}),
      revision,
      status: ep.status,
      episodeSnapshot: snapshotTarget,
      files,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        revision: { type: 'string' },
        attempt: { type: 'string' },
        slides: { type: 'string' },
        force: { type: 'boolean', default: false },
        override: { type: 'boolean', default: false },
        'style-ref': { type: 'string' },
      },
    });
    const [cmd, dir, ...extra] = positionals;
    if (!cmd || !dir || extra.length) {
      throw new Error('Usage: node scripts/episode-tools.mjs <validate|build-prompts|status|finalize> EPISODE_DIR [--revision r01] [--attempt a1] [--slides 1,2-5] [--force] [--override] [--style-ref PATH]');
    }
    if (cmd === 'validate') {
      const res = await validateEpisode(dir);
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
    } else if (cmd === 'build-prompts') {
      const revision = values.revision ?? 'r01';
      const attempt = values.attempt ?? 'a1';
      const resolvedDir = resolve(dir);
      const ep = await readEpisodeJson(join(resolvedDir, 'episode.json'), resolvedDir);
      const slides = parseSlidesSpec(values.slides, Array.isArray(ep.slides) ? ep.slides.length : 0);
      const res = await buildPrompts(dir, {
        revision,
        attempt,
        slides,
        force: values.force,
        override: values.override,
        styleRef: values['style-ref'],
      });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'status') {
      const revision = values.revision ?? 'r01';
      console.log(JSON.stringify(await episodeStatus(dir, { revision }), null, 2));
    } else if (cmd === 'finalize') {
      const revision = values.revision ?? 'r01';
      console.log(JSON.stringify(await finalizeEpisode(dir, { revision }), null, 2));
    } else {
      throw new Error(`Unknown command "${cmd}". Expected validate|build-prompts|status|finalize`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
