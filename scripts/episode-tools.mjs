import { access, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STYLE_REL = join('references', 'user-style-v1', 'example-01-original.png');
const VALID_MODES = ['original', 'adaptation', 'verbatim'];
const VALID_SCENE_TYPES = ['event', 'simile', 'concept'];
const INTERNAL_PATTERNS = [
  /\bbản bạn cung cấp\b/i,
  /\btheo yêu cầu của bạn\b/i,
  /\bbản nháp\b/i,
  /\bđã kiểm tra\b/i,
  /\bready_for_review\b/i,
  /^\s*Tập\s+\d+\s*[-–:]/i,
  /^\s*Phần\s+\d+(\.\d+)?\s*[-–:]/i,
];

const pad3 = n => String(n).padStart(3, '0');
const exists = path => access(path).then(() => true, () => false);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeEol = text => text.replace(/\r\n/g, '\n').trim();

async function writeAtomic(target, content) {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}

function confineRelative(baseDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || isAbsolute(relPath)) return null;
  const base = resolve(baseDir);
  const full = resolve(base, relPath);
  const rel = relative(base, full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return null;
  return full;
}

function resolveSourceFile(episodeDir, ep) {
  const candidates = typeof ep.source === 'string'
    ? [ep.source]
    : ep.source && typeof ep.source === 'object'
      ? [ep.source.file, ep.source.path, ep.source.text_path, ep.source.verbatim_file, 'source.txt']
      : ['source.txt'];
  for (const rel of candidates) {
    if (typeof rel !== 'string' || !rel.trim()) continue;
    const full = confineRelative(episodeDir, rel);
    return { rel, full };
  }
  return { rel: 'source.txt', full: join(resolve(episodeDir), 'source.txt') };
}

function sequenceMatchesSource(seq, src, prefixes) {
  if (!seq.length) return false;
  if (Array.isArray(prefixes) && prefixes.length === seq.length) {
    const joined = normalizeEol(seq.map((s, i) => `${prefixes[i] ?? ''}${s?.text ?? ''}`).join(''));
    if (joined === src) return true;
  }
  const rawJoined = normalizeEol(seq.map(s => s?.text ?? '').join(''));
  if (rawJoined === src) return true;
  const nlJoined = normalizeEol(seq.map(s => s?.text ?? '').join('\n'));
  if (nlJoined === src) return true;
  const spaceJoined = normalizeEol(seq.map(s => String(s?.text ?? '').trim()).join(' ')).replace(/\s+/g, ' ');
  return spaceJoined === src.replace(/\s+/g, ' ');
}

function matchesVerbatim(slides, src, sourceMeta) {
  const prefixes = Array.isArray(sourceMeta?.exact_join_prefixes) ? sourceMeta.exact_join_prefixes : undefined;
  const firstSlide = Number.isSafeInteger(sourceMeta?.exact_join_first_slide) ? sourceMeta.exact_join_first_slide : undefined;
  if (firstSlide !== undefined) {
    if (firstSlide < 1 || firstSlide > slides.length) return false;
    return sequenceMatchesSource(slides.slice(firstSlide - 1), src, prefixes);
  }
  if (sequenceMatchesSource(slides, src, prefixes && prefixes.length === slides.length ? prefixes : undefined)) {
    return true;
  }
  if (slides.length > 1) {
    const body = slides.slice(1);
    return sequenceMatchesSource(body, src, prefixes && prefixes.length === body.length ? prefixes : undefined);
  }
  return false;
}

async function loadChar(episodeDir, ref) {
  const relDir = join('references', ref.id, ref.version);
  const absDir = join(episodeDir, relDir);
  const jsonPath = join(absDir, 'character.json');
  if (!(await exists(jsonPath))) return { error: `Missing character snapshot: ${relDir}/character.json` };
  const data = await readJson(jsonPath);
  const refs = Array.isArray(data.references) ? data.references : [];
  if (!refs.length) return { error: `No reference images in ${relDir}/character.json` };
  const refPaths = [];
  for (const r of refs) {
    const full = confineRelative(absDir, r);
    if (!full || !(await exists(full))) return { error: `Missing character image: ${join(relDir, String(r))}` };
    refPaths.push(join(relDir, r));
  }
  return { id: ref.id, version: ref.version, data, refPaths };
}

/** Validate episode JSON schema, editorial text checks, verbatim source match, and character snapshots. */
export async function validateEpisode(episodeDir) {
  const dir = resolve(episodeDir);
  const issues = [];
  const epPath = join(dir, 'episode.json');
  if (!(await exists(epPath))) return { ok: false, issues: ['Missing episode.json'] };
  const ep = await readJson(epPath);
  if (!VALID_MODES.includes(ep.mode)) {
    issues.push(`mode must be one of ${VALID_MODES.join('|')} (got "${ep.mode}")`);
  }
  if (!Array.isArray(ep.slides) || ep.slides.length < 1 || ep.slides.length > 35) {
    issues.push(`slides[] must have 1-35 items (got ${Array.isArray(ep.slides) ? ep.slides.length : 'none'})`);
  }
  const seenChars = new Map();
  for (let i = 0; i < (Array.isArray(ep.slides) ? ep.slides.length : 0); i++) {
    const s = ep.slides[i];
    const num = i + 1;
    if (typeof s?.text !== 'string' || !s.text.trim()) issues.push(`Slide ${num}: empty text`);
    else {
      for (const pat of INTERNAL_PATTERNS) {
        if (pat.test(s.text)) issues.push(`Slide ${num}: possible internal/management text matching ${pat}`);
      }
    }
    if (typeof s?.scene !== 'string' || !s.scene.trim()) issues.push(`Slide ${num}: empty scene`);
    if (!VALID_SCENE_TYPES.includes(s?.scene_type)) issues.push(`Slide ${num}: invalid scene_type "${s?.scene_type}"`);
    if (s?.characters !== undefined && !Array.isArray(s.characters)) {
      issues.push(`Slide ${num}: characters must be an array`);
      continue;
    }
    let refCount = 1; // Style reference is always included as image 1.
    for (const c of s?.characters ?? []) {
      if (typeof c?.id !== 'string' || !c.id.trim() || typeof c?.version !== 'string' || !c.version.trim()) {
        issues.push(`Slide ${num}: invalid character reference (require id and version)`);
        continue;
      }
      const key = `${c.id}@${c.version}`;
      if (!seenChars.has(key)) seenChars.set(key, await loadChar(dir, c));
      const loaded = seenChars.get(key);
      if (loaded.error) issues.push(`Slide ${num}: ${loaded.error}`);
      else refCount += loaded.refPaths.length;
    }
    if (refCount > 10) issues.push(`Slide ${num}: ${refCount} reference images exceed API maximum of 10`);
  }
  if (ep.mode === 'verbatim') {
    const { rel, full } = resolveSourceFile(dir, ep);
    if (!full) issues.push(`Invalid verbatim source path: ${rel}`);
    else if (!(await exists(full))) issues.push(`Mode verbatim requires ${rel}`);
    else if (Array.isArray(ep.slides)) {
      const src = normalizeEol(await readFile(full, 'utf8'));
      const sourceMeta = ep.source && typeof ep.source === 'object' ? ep.source : undefined;
      if (!matchesVerbatim(ep.slides, src, sourceMeta)) {
        issues.push(`Verbatim check failed: joined slides[].text does not match ${rel}`);
      }
    }
  }
  return { ok: issues.length === 0, mode: ep.mode, slideCount: Array.isArray(ep.slides) ? ep.slides.length : 0, issues };
}

function formatCharDesc(loaded) {
  const id = loaded.data.identity ?? {};
  const parts = [id.face, id.hair, id.body, id.clothing].filter(Boolean).join('; ');
  const keep = Array.isArray(loaded.data.keep) && loaded.data.keep.length ? ` Giữ: ${loaded.data.keep.join('; ')}.` : '';
  const avoid = Array.isArray(loaded.data.avoid) && loaded.data.avoid.length ? ` Tránh: ${loaded.data.avoid.join('; ')}.` : '';
  return `${loaded.id}/${loaded.version} (${parts}${keep}${avoid})`;
}

function formatAllowedObjects(rawObjects) {
  if (Array.isArray(rawObjects)) {
    const items = rawObjects.map(v => String(v ?? '').trim()).filter(Boolean);
    return items.length ? items.join(', ') : null;
  }
  if (typeof rawObjects === 'string') {
    const text = rawObjects.trim();
    return text || null;
  }
  return null;
}

async function resolveStyleRef(episodeDir, styleRef) {
  if (styleRef) {
    const candidates = isAbsolute(styleRef) ? [styleRef] : [resolve(styleRef), resolve(REPO_ROOT, styleRef)];
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    throw new Error(`Missing style reference: ${styleRef}`);
  }
  const epSnapshot = join(episodeDir, DEFAULT_STYLE_REL);
  if (await exists(epSnapshot)) return epSnapshot;
  const repoDefault = join(REPO_ROOT, DEFAULT_STYLE_REL);
  if (await exists(repoDefault)) return repoDefault;
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

/** Generate slide prompt files and batch manifest JSON from episode.json and character snapshots. */
export async function buildPrompts(episodeDir, { revision = 'r01', attempt = 'a1', slides: onlySlides, force = false, styleRef } = {}) {
  if (!/^r\d{2,}$/.test(revision)) throw new Error(`Invalid revision "${revision}" (expected r01, r02...)`);
  if (!/^[a-z0-9-]+$/i.test(attempt)) throw new Error(`Invalid attempt "${attempt}"`);
  const dir = resolve(episodeDir);
  const ep = await readJson(join(dir, 'episode.json'));
  if (!Array.isArray(ep.slides) || ep.slides.length < 1 || ep.slides.length > 35) {
    throw new Error('episode.json must have 1-35 slides');
  }
  if (onlySlides) {
    if (!Array.isArray(onlySlides) || !onlySlides.length || onlySlides.some(n => !Number.isSafeInteger(n) || n < 1 || n > ep.slides.length)) {
      throw new Error(`Invalid slides selection for 1-${ep.slides.length}`);
    }
  }
  const resolvedStyleRef = await resolveStyleRef(dir, styleRef);
  await mkdir(join(dir, 'prompts'), { recursive: true });

  const charCache = new Map();
  const generated = [];
  const skipped = [];
  const manifest = [];

  for (let i = 0; i < ep.slides.length; i++) {
    const num = i + 1;
    if (onlySlides && !onlySlides.includes(num)) continue;
    const s = ep.slides[i];
    const refs = [resolvedStyleRef];
    const refLabels = ['1. Ảnh phong cách (chỉ tham chiếu nét chì, kiểu chữ, nền giấy và khoảng trắng; không chép chữ/người/vật)'];
    const charDescs = [];

    for (const c of s.characters ?? []) {
      const key = `${c.id}@${c.version}`;
      if (!charCache.has(key)) {
        const loaded = await loadChar(dir, c);
        if (loaded.error) throw new Error(loaded.error);
        charCache.set(key, loaded);
      }
      const loaded = charCache.get(key);
      charDescs.push(formatCharDesc(loaded));
      for (const relImg of loaded.refPaths) {
        refs.push(join(dir, relImg));
        refLabels.push(`${refs.length}. Định danh ${loaded.id}/${loaded.version} (giữ khuôn mặt, tóc, vóc dáng, y phục; không chép tư thế/nền mẫu)`);
      }
    }
    if (refs.length > 10) throw new Error(`Slide ${num}: ${refs.length} reference images exceed API maximum of 10`);

    const symbolic = s.scene_type === 'simile' || s.scene_type === 'concept'
      ? ' Hình biểu trưng, không dựng thành sự kiện lịch sử.' : '';
    const allowedObjects = formatAllowedObjects(s.objects);
    const objectLine = allowedObjects
      ? `Vật thể được phép: ${allowedObjects}. Không thêm người, vật thể, hào quang hay hiệu ứng ngoài danh sách.`
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

    const promptRel = join('prompts', `${pad3(num)}-${revision}.txt`);
    const promptAbs = join(dir, promptRel);
    if (!force && (await exists(promptAbs))) skipped.push(promptRel);
    else {
      await writeFile(promptAbs, content, 'utf8');
      generated.push(promptRel);
    }
    manifest.push({
      slide: num,
      promptFile: promptAbs,
      workDir: join(dir, 'drafts', `${pad3(num)}-${revision}-${attempt}`),
      references: refs,
    });
  }

  const manifestPath = join(dir, 'prompts', `batch-${revision}.json`);
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, revision, attempt, generated: generated.length, skipped: skipped.length, batchManifest: manifestPath };
}

/** Report draft, export, and visual-check status for every slide in the given revision. */
export async function episodeStatus(episodeDir, { revision = 'r01' } = {}) {
  const dir = resolve(episodeDir);
  const ep = await readJson(join(dir, 'episode.json'));
  const draftsDir = join(dir, 'drafts');
  const draftEntries = (await exists(draftsDir))
    ? (await readdir(draftsDir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  const slides = [];
  for (let i = 0; i < (ep.slides?.length ?? 0); i++) {
    const num = i + 1;
    const prefix = `${pad3(num)}-${revision}`;
    const matching = draftEntries.filter(name => name === prefix || name.startsWith(`${prefix}-`));
    const latestDraft = matching.at(-1);
    let draftState = null;
    if (latestDraft) {
      const stPath = join(draftsDir, latestDraft, 'status.json');
      if (await exists(stPath)) draftState = (await readJson(stPath)).state ?? null;
    }
    const outDir = join(dir, 'output', revision);
    const outImg = join(outDir, `${pad3(num)}.jpg`);
    const checkFile = join(outDir, 'checks', `${pad3(num)}.jpg.json`);
    slides.push({
      slide: num,
      draft: latestDraft ?? null,
      draftState,
      exported: await exists(outImg),
      checked: await exists(checkFile),
    });
  }
  return { episodeDir: dir, revision, slideCount: slides.length, slides };
}

/** Verify exported outputs and SHA-256 check files, then update episode.json and save the revision snapshot. */
export async function finalizeEpisode(episodeDir, { revision = 'r01' } = {}) {
  if (!/^r\d{2,}$/.test(revision)) throw new Error(`Invalid revision "${revision}" (expected r01, r02...)`);
  const dir = resolve(episodeDir);
  const epPath = join(dir, 'episode.json');
  const ep = await readJson(epPath);
  if (!Array.isArray(ep.slides) || ep.slides.length < 1 || ep.slides.length > 35) {
    throw new Error('episode.json must have 1-35 slides');
  }
  const outDir = join(dir, 'output', revision);
  const files = [];
  for (let i = 0; i < ep.slides.length; i++) {
    const num = i + 1;
    const base = pad3(num);
    let imgName;
    for (const ext of ['.jpg', '.jpeg', '.png']) {
      const candidate = join(outDir, `${base}${ext}`);
      const stat = await lstat(candidate).catch(() => null);
      if (stat?.isFile()) { imgName = `${base}${ext}`; break; }
    }
    if (!imgName) throw new Error(`Missing exported image for slide ${num} in output/${revision}/`);
    const imgPath = join(outDir, imgName);
    const checkPath = join(outDir, 'checks', `${imgName}.json`);
    const checkStat = await lstat(checkPath).catch(() => null);
    if (!checkStat?.isFile()) throw new Error(`Missing check checkpoint for slide ${num}: output/${revision}/checks/${imgName}.json`);
    const check = await readJson(checkPath);
    if (check?.image !== imgName || typeof check?.visual_check !== 'string' || !check.visual_check.trim()) {
      throw new Error(`Invalid check checkpoint for slide ${num}`);
    }
    const actualHash = sha256(await readFile(imgPath));
    if (check.sha256 !== actualHash) throw new Error(`SHA-256 mismatch for slide ${num} (${imgName})`);
    const relPath = `output/${revision}/${imgName}`;
    ep.slides[i].image = relPath;
    files.push(relPath);
  }
  ep.revision = revision;
  ep.status = 'ready_for_review';
  const serialized = `${JSON.stringify(ep, null, 2)}\n`;
  const snapshotPath = join(outDir, 'episode.json');
  await writeAtomic(snapshotPath, serialized);
  await writeAtomic(epPath, serialized);
  return { ok: true, revision, status: ep.status, episodeSnapshot: snapshotPath, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const flag = name => {
    const idx = rest.indexOf(name);
    if (idx === -1) return undefined;
    if (idx + 1 >= rest.length) throw new Error(`Missing value for ${name}`);
    return rest[idx + 1];
  };
  try {
    if (cmd === 'validate' && dir) {
      const res = await validateEpisode(dir);
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) process.exitCode = 1;
    } else if (cmd === 'build-prompts' && dir) {
      const revision = flag('--revision') ?? 'r01';
      const attempt = flag('--attempt') ?? 'a1';
      const ep = await readJson(join(resolve(dir), 'episode.json'));
      const slides = parseSlidesSpec(flag('--slides'), Array.isArray(ep.slides) ? ep.slides.length : 0);
      const res = await buildPrompts(dir, { revision, attempt, slides, force: rest.includes('--force') });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'status' && dir) {
      const revision = flag('--revision') ?? 'r01';
      console.log(JSON.stringify(await episodeStatus(dir, { revision }), null, 2));
    } else if (cmd === 'finalize' && dir) {
      const revision = flag('--revision') ?? 'r01';
      console.log(JSON.stringify(await finalizeEpisode(dir, { revision }), null, 2));
    } else {
      console.error('Usage: node scripts/episode-tools.mjs <validate|build-prompts|status|finalize> EPISODE_DIR [--revision r01] [--attempt a1] [--slides 1,2-5] [--force]');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
