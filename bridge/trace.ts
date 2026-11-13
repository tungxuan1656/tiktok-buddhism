import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { basename } from 'node:path';
import { Store } from './store.ts';
import { Telegram } from './telegram.ts';

export function eventLine(event: JsonAgentSessionEvent): string | undefined {
  if (event.type === 'agent_start') return 'Pi bắt đầu xử lý';
  if (event.type === 'agent_settled') return event.aborted ? 'Pi đã dừng do hủy' : 'Pi đã dừng tự chạy; chưa xác nhận chất lượng';
  if (event.type === 'compaction_start') return 'Đang rút gọn ngữ cảnh';
  if (event.type === 'compaction_end') return event.aborted || event.errorMessage ? 'Rút gọn ngữ cảnh chưa hoàn tất' : 'Đã rút gọn ngữ cảnh';
  if (event.type === 'message_update') {
    if (event.assistantMessageEvent.type === 'thinking_start') return 'Model bắt đầu suy luận';
    if (event.assistantMessageEvent.type === 'text_start') return 'Model bắt đầu viết phản hồi';
  }
  if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
  const tool = ['read', 'bash', 'edit', 'write'].includes(event.toolName) ? event.toolName : 'tool';
  if (event.type === 'tool_execution_end') return `${tool}: ${event.isError ? 'báo lỗi' : 'kết thúc thành công'}`;
  // Never expose commands, results or arbitrary filenames; those may contain credentials.
  const args = event.args as { path?: unknown } | undefined;
  const name = typeof args?.path === 'string' ? basename(args.path) : '';
  const safeName = /^(?:AGENTS\.md|WORKFLOW\.md|README\.md|episode\.json|notes\.md|source\.txt|request\.json|result\.json|\d{3}\.(?:png|jpg|jpeg|webp))$/.test(name) ? `: ${name}` : '';
  return `Bắt đầu ${tool}${tool === 'bash' ? ' (ẩn lệnh và đầu ra)' : safeName}`;
}

export class Trace {
  store: Store;
  telegram: Telegram;
  message?: number;
  lastText = '';
  timer?: NodeJS.Timeout;
  pending?: Promise<void>;
  closed = false;
  constructor(store: Store, telegram: Telegram) { this.store = store; this.telegram = telegram; }
  enabled() { return this.store.get('trace_enabled') === '1'; }
  lines(): string[] {
    try {
      const value: unknown = JSON.parse(this.store.get('trace_lines') ?? '[]');
      return Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string').slice(-10).map(line => line.replace(/\s+/g, ' ').slice(0, 200)) : [];
    } catch { return []; }
  }
  text() { return this.lines().join('\n') || 'Chưa có sự kiện trong lượt này.'; }
  reset() {
    this.store.set('trace_lines', '[]');
    this.schedule();
  }
  add(line: string) {
    const time = new Date().toTimeString().slice(0, 8);
    const lines = [...this.lines(), `${time}  ${line.replace(/\s+/g, ' ').slice(0, 180)}`].slice(-10);
    this.store.set('trace_lines', JSON.stringify(lines));
    this.schedule();
  }
  schedule() {
    if (this.closed || !this.enabled() || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 3000);
    this.timer.unref();
  }
  async setEnabled(enabled: boolean) {
    await this.pending;
    clearTimeout(this.timer); this.timer = undefined;
    this.store.set('trace_enabled', enabled ? '1' : '0');
    if (enabled) await this.flush();
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.pending) {
      await this.pending;
      if (!this.closed && this.enabled() && this.text() !== this.lastText) await this.flush();
      return;
    }
    const text = this.text();
    if (this.closed || !this.enabled() || text === this.lastText) return;
    this.pending = (async () => {
      try {
        this.message = await this.telegram.trace(text, this.message);
        this.lastText = text;
      } catch {
        // Unknown status-message sends are not retried automatically.
        this.store.set('trace_enabled', '0');
        this.message = undefined; this.lastText = '';
        console.error('Trace live tạm tắt vì Telegram chưa xác nhận; /log vẫn xem được.');
      }
    })();
    try { await this.pending; }
    finally {
      this.pending = undefined;
      if (!this.closed && this.enabled() && this.text() !== this.lastText) this.schedule();
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    await this.pending;
  }
}
