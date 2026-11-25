export class TelegramError extends Error {
  constructor({ ambiguous = true, retryAfter = 0 } = {}) {
    super(ambiguous ? 'Telegram did not confirm the request' : 'Telegram rejected the request');
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  constructor(token, owner, { request = fetch, signal } = {}) {
    this.token = token;
    this.owner = owner;
    this.request = request;
    this.signal = signal;
  }

  async call(method, data, timeout = 45_000) {
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
      throw new TelegramError({ ambiguous: false, retryAfter: status === 429 ? (Number.isSafeInteger(delay) && delay > 0 ? delay : 30) : 0 });
    }
    throw new TelegramError();
  }

  poll(offset) { return this.call('getUpdates', { offset, timeout: 15, allowed_updates: ['message'] }); }

  authorized(message) {
    // A matching sender in a group is not authorized to receive documents.
    return message?.chat?.type === 'private' && message.chat.id === this.owner &&
      message.from?.id === this.owner && message.from.is_bot === false;
  }

  async say(text) {
    return messageId(await this.call('sendMessage', { chat_id: this.owner, text }));
  }

  async document({ name, mime, bytes }) {
    const body = new FormData();
    body.set('chat_id', String(this.owner));
    body.set('document', new Blob([bytes], { type: mime }), name);
    return messageId(await this.call('sendDocument', body, 120_000));
  }
}

function messageId(response) {
  if (!Number.isSafeInteger(response?.message_id) || response.message_id <= 0) throw new TelegramError();
  return response.message_id;
}
