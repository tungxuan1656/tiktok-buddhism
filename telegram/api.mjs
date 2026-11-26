import { setTimeout as sleep } from 'node:timers/promises';

const MIN_SEND_INTERVAL_MS = 1000;
const MAX_RETRY_WAIT_MS = 30_000;

export class TelegramError extends Error {
  constructor({ ambiguous = true, status, retryAfter = 0, notSent = false } = {}) {
    super(ambiguous ? 'Telegram did not confirm the request' : 'Telegram rejected the request');
    this.ambiguous = ambiguous;
    this.status = status;
    this.retryAfter = retryAfter;
    this.notSent = notSent;
  }
}

export class Telegram {
  constructor(token, owner, { request = fetch, signal, wait = sleep } = {}) {
    this.token = token;
    this.owner = owner;
    this.request = request;
    this.signal = signal;
    this.wait = wait;
    this.nextSendAt = 0;
  }

  async call(method, data, timeout = 45_000) {
    if (this.signal?.aborted) throw new TelegramError({ ambiguous: false, notSent: true });
    const localTimeout = AbortSignal.timeout(timeout);
    let result;
    let status;
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', redirect: 'error',
        ...(data instanceof FormData ? { body: data } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
        signal: this.signal ? AbortSignal.any([localTimeout, this.signal]) : localTimeout,
      });
      status = response.status;
      result = await response.json();
    } catch { throw new TelegramError(); }
    if (status >= 200 && status < 300 && result?.ok === true) return result.result;
    if (status >= 400 && status < 500 && result?.ok === false) {
      const delay = result.parameters?.retry_after;
      throw new TelegramError({ ambiguous: false, status, retryAfter: status === 429 && Number.isSafeInteger(delay) && delay > 0 ? delay : 0 });
    }
    throw new TelegramError();
  }

  poll(offset) { return this.call('getUpdates', { offset, timeout: 15, allowed_updates: ['message'] }); }

  authorized(message) {
    // A matching sender in a group is not authorized to receive documents.
    return message?.chat?.type === 'private' && message.chat.id === this.owner &&
      message.from?.id === this.owner && message.from.is_bot === false;
  }

  async send(method, data, timeout) {
    for (let attempt = 0; ; attempt++) {
      const delay = this.nextSendAt - Date.now();
      if (delay > MAX_RETRY_WAIT_MS) {
        throw new TelegramError({ ambiguous: false, status: 429, retryAfter: Math.ceil(delay / 1000), notSent: true });
      }
      if (delay > 0) {
        try { await this.wait(delay, undefined, { signal: this.signal }); }
        catch { throw new TelegramError({ ambiguous: false, notSent: true }); }
      }
      this.nextSendAt = Date.now() + MIN_SEND_INTERVAL_MS;
      try { return messageId(await this.call(method, data, timeout)); }
      catch (error) {
        if (error.ambiguous || error.status !== 429) throw error;
        const retryMs = error.retryAfter * 1000;
        this.nextSendAt = Math.max(this.nextSendAt, Date.now() + (retryMs || MAX_RETRY_WAIT_MS));
        if (attempt || !retryMs || retryMs > MAX_RETRY_WAIT_MS) throw error;
      }
    }
  }

  say(text) { return this.send('sendMessage', { chat_id: this.owner, text }); }

  async document({ name, mime, bytes }) {
    const body = new FormData();
    body.set('chat_id', String(this.owner));
    body.set('document', new Blob([bytes], { type: mime }), name);
    return this.send('sendDocument', body, 120_000);
  }
}

function messageId(response) {
  if (!Number.isSafeInteger(response?.message_id) || response.message_id <= 0) throw new TelegramError();
  return response.message_id;
}
