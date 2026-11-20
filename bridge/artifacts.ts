import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Delivery, Run, Task } from './store.ts';

const exec = promisify(execFile);
export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function confined(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Đường dẫn không hợp lệ');
  const base = await realpath(root);
  const full = await realpath(join(base, path));
  if (!relative(base, full) || relative(base, full).startsWith(`..${sep}`) || isAbsolute(relative(base, full))) {
    throw new Error('File nằm ngoài thư mục tác vụ');
  }
  if (!(await lstat(full)).isFile()) throw new Error('Kết quả không phải file thường');
  return full;
}

async function json(root: string, path: string, sha256?: string) {
  const full = await confined(root, path);
  if ((await stat(full)).size > 128 * 1024) throw new Error('JSON kết quả quá lớn');
  const bytes = await readFile(full);
  if (sha256 !== undefined && hash(bytes) !== sha256) throw new Error('Snapshot đã thay đổi sau khi kiểm tra');
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Không đọc được JSON kết quả'); }
}

export async function manualHandoff(task: Task): Promise<Record<string, unknown> | undefined> {
  const path = 'handoff/manual.json';
  const entry = await lstat(join(task.dir, path)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!entry) return;
  if (!entry.isFile()) throw new Error('Biên bản thủ công không phải file thường');
  const report = await json(task.dir, path);
  if (!report || report.task_id !== task.id || report.status !== 'ready_for_review' || report.checked !== true) {
    throw new Error('Biên bản thủ công không khớp tập hoặc chưa kiểm tra');
  }
  return report;
}

export function imageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  throw new Error('File không phải PNG/JPEG');
}

export async function imageBytes(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size > 49_000_000) throw new Error('Ảnh vượt giới hạn gửi Telegram');
  const bytes = await readFile(path);
  const format = imageMime(bytes) === 'image/png' ? 'PNG' : 'JPEG';
  const extension = extname(path);
  if (format === 'PNG' ? extension !== '.png' : !['.jpg', '.jpeg'].includes(extension)) throw new Error('Đuôi file không khớp PNG/JPEG');
  const { stdout } = await exec('magick', ['identify', '-regard-warnings', '-format', '%m %w %h %n', path], { timeout: 30_000 });
  if (stdout !== `${format} 1080 1440 1`) throw new Error('PNG/JPEG không đúng 1080 x 1440 hoặc không đọc được');
  return bytes;
}

export type Result = { status: 'ready_for_review' | 'blocked' | 'needs_input'; message: string; revision?: string; files: Omit<Delivery, 'state' | 'message'>[] };

export async function collect(task: Task, run: Run, stateDir: string, manual = false): Promise<Result> {
  const report = await json(task.dir, `handoff/${run.id}/result.json`);
  if (report.run_id !== run.id || report.task_id !== task.id) throw new Error('Kết quả không thuộc lượt đang chạy');
  if (typeof report.message !== 'string' || report.message.length > 2000) throw new Error('Thiếu lời nhắn kết quả hợp lệ');
  if (report.status === 'blocked' || report.status === 'needs_input') {
    return { status: report.status, message: report.message, files: [] };
  }
  if (report.status !== 'ready_for_review' || report.checked !== true || !/^r\d{2,}$/.test(report.revision)) {
    throw new Error('Kết quả chưa có xác nhận kiểm tra thị giác hoặc revision hợp lệ');
  }
  if (!Array.isArray(report.files) || !report.files.length || report.files.length > 35) throw new Error('Danh sách ảnh không hợp lệ (1-35 ảnh, giới hạn một bài TikTok)');
  const prefix = `output/${report.revision}/`;
  if (manual) {
    if (typeof report.snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.snapshot_sha256)
      || !Array.isArray(report.sha256) || report.sha256.length !== report.files.length) {
      throw new Error('Biên bản thủ công thiếu hash đã kiểm tra');
    }
    await json(task.dir, 'episode.json', report.snapshot_sha256);
  }
  const episode = await json(task.dir, `${prefix}episode.json`, manual ? report.snapshot_sha256 : undefined);
  if (episode.status !== 'ready_for_review' || !Array.isArray(episode.slides) || episode.slides.length !== report.files.length) {
    throw new Error('Snapshot kịch bản không khớp kết quả');
  }
  const files: Result['files'] = [];
  const outbox = join(stateDir, 'outbox', run.id);
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  for (let i = 0; i < report.files.length; i++) {
    const path = report.files[i];
    if (typeof path !== 'string' || !path.startsWith(prefix) || !/\/\d{3}\.(?:jpg|jpeg|png)$/.test(path) || episode.slides[i]?.image !== path || report.files.indexOf(path) !== i) {
      throw new Error('Ảnh không đúng revision, thứ tự hoặc bị trùng');
    }
    const full = await confined(task.dir, path);
    const bytes = await imageBytes(full);
    const digest = hash(bytes);
    if (manual && digest !== report.sha256[i]) throw new Error('Ảnh thủ công đã thay đổi sau khi kiểm tra');
    const target = join(outbox, `${String(i + 1).padStart(3, '0')}${extname(path)}`);
    try { await copyFile(full, target, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (hash(await readFile(target)) !== digest) throw new Error('Ảnh thay đổi trong lúc chốt bàn giao');
    files.push({ run: run.id, position: i + 1, path: target, hash: digest });
  }
  return { status: 'ready_for_review', message: report.message, revision: report.revision, files };
}
