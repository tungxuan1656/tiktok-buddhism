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

  async call(method, data, timeout = 45_000, beforePost) {
    const localTimeout = AbortSignal.timeout(timeout);
    const options = {
      method: 'POST', redirect: 'error',
      ...(data instanceof FormData ? { body: data } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }),
      signal: this.signal ? AbortSignal.any([localTimeout, this.signal]) : localTimeout,
    };
    if (this.signal?.aborted) throw new TelegramError({ ambiguous: false, notSent: true });
    beforePost?.();
    let result;
    let status;
    try {
      const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, options);
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

  poll(offset) { return this.call('getUpdates', { offset, timeout: 15, allowed_updates: ['message', 'callback_query'] }); }

  authorizedChatFrom(chat, from) {
    // A matching sender in a group is not authorized to receive documents or trigger actions.
    return chat?.type === 'private' && chat.id === this.owner &&
      from?.id === this.owner && from.is_bot === false;
  }

  authorized(message) {
    return this.authorizedChatFrom(message?.chat, message?.from);
  }

  authorizedCallback(query) {
    return typeof query?.id === 'string' && typeof query?.data === 'string' &&
      this.authorizedChatFrom(query.message?.chat, query.from);
  }

  async send(method, data, timeout, beforePost, { retry429 = true, validate = messageId } = {}) {
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
      try { return validate(await this.call(method, data, timeout, beforePost)); }
      catch (error) {
        if (error.ambiguous || error.status !== 429) throw error;
        const retryMs = error.retryAfter * 1000;
        this.nextSendAt = Math.max(this.nextSendAt, Date.now() + (retryMs || MAX_RETRY_WAIT_MS));
        if (!retry429 || attempt || !retryMs || retryMs > MAX_RETRY_WAIT_MS) throw error;
      }
    }
  }

  say(text, beforePost, { replyMarkup, ...options } = {}) {
    return this.send('sendMessage', {
      chat_id: this.owner,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, undefined, beforePost, options);
  }

  async photo({ name, mime, bytes }, beforePost) {
    const body = new FormData();
    body.set('chat_id', String(this.owner));
    body.set('photo', new Blob([bytes], { type: mime }), name);
    return this.send('sendPhoto', body, 120_000, beforePost);
  }

  async mediaGroup(items, beforePost, { type = 'photo' } = {}) {
    if (!Array.isArray(items) || items.length < 2 || items.length > 10) {
      throw new RangeError('Telegram sendMediaGroup requires 2 to 10 items');
    }
    if (type !== 'photo' && type !== 'document') {
      throw new RangeError(`Unsupported Telegram mediaGroup type: ${type}`);
    }
    const body = new FormData();
    body.set('chat_id', String(this.owner));
    body.set('media', JSON.stringify(items.map((_, index) => ({ type, media: `attach://file${index}` }))));
    for (const [index, item] of items.entries()) {
      body.set(`file${index}`, new Blob([item.bytes], { type: item.mime }), item.name);
    }
    return this.send('sendMediaGroup', body, 120_000, beforePost, {
      validate: res => {
        if (!Array.isArray(res) || res.length !== items.length) throw new TelegramError();
        return res.map(messageId);
      },
    });
  }

  async document({ name, mime, bytes }, beforePost, { replyMarkup } = {}) {
    const body = new FormData();
    body.set('chat_id', String(this.owner));
    body.set('document', new Blob([bytes], { type: mime }), name);
    if (replyMarkup) body.set('reply_markup', JSON.stringify(replyMarkup));
    return this.send('sendDocument', body, 120_000, beforePost);
  }

  answerCallbackQuery(callbackQueryId, { text, retry429 = true } = {}, beforePost) {
    const payload = {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    };
    const validate = res => {
      if (res !== true) throw new TelegramError();
      return true;
    };
    return this.send('answerCallbackQuery', payload, undefined, beforePost, { retry429, validate });
  }

  editReplyMarkup(chatId, messageIdToEdit, replyMarkup, beforePost) {
    return this.send('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageIdToEdit,
      reply_markup: replyMarkup,
    }, undefined, beforePost, {
      validate: res => {
        if (res === true) return true;
        return messageId(res);
      },
    });
  }
}

function messageId(response) {
  if (!Number.isSafeInteger(response?.message_id) || response.message_id <= 0) throw new TelegramError();
  return response.message_id;
}
