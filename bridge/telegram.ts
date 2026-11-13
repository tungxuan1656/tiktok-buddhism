export type Update = {
  update_id: number;
  message?: { from?: { id: number; is_bot?: boolean }; chat: { id: number; type: string }; text?: string };
};

export class TelegramError extends Error {
  ambiguous: boolean;
  retryAfter: number;
  constructor(ambiguous: boolean, retryAfter = 0) {
    super(ambiguous ? 'Telegram chưa xác nhận kết quả gửi' : 'Telegram từ chối yêu cầu');
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  token: string;
  owner: number;
  request: typeof fetch;
  constructor(token: string, owner: number, request: typeof fetch = fetch) {
    this.token = token;
    this.owner = owner;
    this.request = request;
  }
  async call<T>(method: string, body: Record<string, unknown> | FormData, timeout = 45_000): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch { throw new TelegramError(true); }
    let result: { ok: boolean; result: T; parameters?: { retry_after?: number } };
    try { result = await response.json() as typeof result; }
    catch { throw new TelegramError(true); }
    if (!result.ok) throw new TelegramError(false, result.parameters?.retry_after);
    return result.result;
  }
  poll(offset: number) {
    return this.call<Update[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
  }
  authorized(update: Update) {
    const message = update.message;
    return message?.chat.type === 'private' && message.chat.id === this.owner && message.from?.id === this.owner && !message.from.is_bot;
  }
  async say(text: string) {
    await this.call('sendMessage', { chat_id: this.owner, text: text.slice(0, 4000) });
  }
  async send(bytes: Uint8Array, name: string, caption: string): Promise<number> {
    const data = new FormData();
    data.set('chat_id', String(this.owner));
    data.set('caption', caption);
    data.set('document', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
    const result = await this.call<{ message_id: number }>('sendDocument', data, 120_000);
    if (!Number.isSafeInteger(result?.message_id)) throw new TelegramError(true);
    return result.message_id;
  }
}
