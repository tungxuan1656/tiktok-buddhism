import { RpcClient } from '@earendil-works/pi-coding-agent';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface Runner {
  run(session: string, prompt: string, phase: (text: string) => void, signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
}

export class PiRunner implements Runner {
  root: string;
  stateDir: string;
  client?: RpcClient;
  session?: string;
  fail?: (error: Error) => void;
  constructor(root: string, stateDir: string) { this.root = root; this.stateDir = stateDir; }

  async connect(session: string) {
    if (this.client && this.session === session) return this.client;
    await this.stop();
    await mkdir(join(this.stateDir, 'sessions'), { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('TELEGRAM_')).map(key => [key, '']));
    this.client = new RpcClient({
      cliPath: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry')),
      cwd: this.root, env, model: process.env.PI_MODEL || undefined,
      args: ['--session-dir', join(this.stateDir, 'sessions'), '--session-id', session,
        '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes',
        '--no-approve', '--tools', 'read,bash,edit,write',
        '--append-system-prompt', join(this.root, 'bridge/agent.md')],
    });
    this.session = session;
    try {
      await this.client.start();
      await this.client.getState();
      await this.client.setAutoRetry(false);
      return this.client;
    } catch {
      await this.stop();
      throw new Error('Không khởi động được Pi RPC; kiểm tra cấu hình Pi cục bộ');
    }
  }

  async run(session: string, prompt: string, phase: (text: string) => void, signal: AbortSignal) {
    const client = await this.connect(session);
    if (signal.aborted) throw new Error('Đã hủy trước khi bắt đầu');
    let off = () => {};
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const settled = new Promise<void>((resolve, reject) => {
      this.fail = reject;
      off = client.onEvent(event => {
        if (event.type === 'agent_settled') {
          if (event.aborted) reject(new Error('Pi đã dừng trước khi hoàn thành'));
          else resolve();
        }
        if (event.type === 'tool_execution_start') {
          phase(event.toolName === 'read' ? 'Đang đọc tài liệu hoặc kiểm tra ảnh' : 'Đang thực hiện công việc và lưu kết quả');
        }
      });
      timer = setTimeout(() => reject(new Error('Pi vượt giới hạn 45 phút; cần kiểm tra tiến độ')), 45 * 60_000);
      let checking = false;
      heartbeat = setInterval(() => {
        if (checking) return;
        checking = true;
        void client.getState().catch(() => reject(new Error('Mất kết nối Pi; không tự chạy lại'))).finally(() => { checking = false; });
      }, 15_000);
    });
    // The listener exists before prompt; a fast settlement must not be lost.
    const accepted = client.prompt(prompt).then(disposition => {
      if (disposition !== 'started') throw new Error('Pi không bắt đầu lượt xử lý');
    });
    try { await Promise.all([accepted, settled]); }
    catch (error) { await this.cancel(); throw error; }
    finally { off(); clearTimeout(timer); clearInterval(heartbeat); this.fail = undefined; }
  }
  async cancel() {
    const client = this.client;
    if (!client) return;
    try { await client.clearQueue(); await client.abort(); }
    catch {
      await this.stop();
      this.fail?.(new Error('Đã đóng Pi; trạng thái yêu cầu API có thể chưa rõ'));
    }
  }
  async stop() {
    const client = this.client;
    this.client = undefined;
    this.session = undefined;
    if (client) await client.stop();
  }
}
