import type { TelegramUser } from './types';
import { englishDisplay, telegramDisplayPayload } from './notification-format';

export type Fetcher = typeof fetch;
export type TelegramMethod = 'getMe' | 'sendMessage' | 'answerInlineQuery' | 'sendPhoto' | 'sendVideo' | 'sendDocument'
  | 'getFile'
  | 'sendChatAction'
  | 'answerCallbackQuery' | 'editMessageText' | 'editMessageCaption' | 'editMessageReplyMarkup' | 'deleteMessage' | 'getChat' | 'getChatMember';

export class TelegramError extends Error {
  constructor(public readonly code: number, public readonly retryable: boolean, public readonly retryAfter = 0) {
    // Never include raw Telegram responses, request URLs or nested fetch errors.
    super(`Telegram API failed (${code})`);
    this.name = 'TelegramError';
  }
}

export class TelegramClient {
  private preservePrivateKeyboard = false;
  setPreservePrivateKeyboard(value:boolean):void { this.preservePrivateKeyboard=value; }
  private identity?: { value: TelegramUser & { username: string }; expires: number };
  private identityPending: Promise<TelegramUser & { username: string }> | undefined;

  constructor(private readonly token: string, private readonly fetcher: Fetcher = fetch) {}

  async call<T>(method: TelegramMethod, payload: unknown = {}): Promise<T> {
    let response: Response;
    const multipart = payload instanceof FormData;
    if (multipart) {
      for (const key of ['text', 'caption']) {
        const value = (payload as FormData).get(key);
        if (typeof value === 'string') (payload as FormData).set(key, englishDisplay(value));
      }
    } else payload = telegramDisplayPayload(payload);
    if (!this.preservePrivateKeyboard && !multipart && ['sendMessage','sendPhoto','sendDocument'].includes(method) && payload && typeof payload === 'object') {
      const body = payload as Record<string, unknown>;
      const markup=body.reply_markup as {inline_keyboard?:unknown;keyboard?:unknown;force_reply?:boolean}|undefined;
      // Inline message actions and ForceReply are not persistent command keyboards.
      if (typeof body.chat_id === 'number' && body.chat_id > 0 && !markup?.inline_keyboard && !markup?.force_reply) payload = { ...body, reply_markup: { remove_keyboard: true } };
    }
    if (!this.preservePrivateKeyboard && multipart && Number((payload as FormData).get('chat_id')) > 0) (payload as FormData).set('reply_markup', JSON.stringify({ remove_keyboard: true }));
    try {
      // Calling this.fetcher(...) would bind workerd's global fetch to this client.
      const fetcher = this.fetcher;
      response = await fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        ...(multipart ? {} : { headers: { 'Content-Type': 'application/json' } }),
        body: multipart ? payload as FormData : JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
        // workerd accepts only manual/follow. Never forward the bot token through a redirect.
        redirect: 'manual',
      });
    } catch {
      throw new TelegramError(0, true);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new TelegramError(response.status, true);
    }
    let data: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } };
    try {
      data = await response.json();
    } catch {
      throw new TelegramError(response.status, true);
    }
    if (!response.ok || data.ok !== true) {
      const code = Number.isInteger(data.error_code) ? data.error_code! : response.status;
      const retryAfter = Number.isInteger(data.parameters?.retry_after)
        ? Math.min(3600, Math.max(0, data.parameters!.retry_after!)) : 0;
      throw new TelegramError(code, code === 429 || code >= 500 || code === 401 || code === 404, retryAfter);
    }
    return data.result as T;
  }

  async getMe(): Promise<TelegramUser & { username: string }> {
    if (this.identity && this.identity.expires > Date.now()) return this.identity.value;
    if (this.identityPending) return this.identityPending;
    const pending = this.call<TelegramUser>('getMe').then(value => {
      if (!value || value.is_bot !== true || !Number.isSafeInteger(value.id)
        || typeof value.username !== 'string' || !/^[a-z0-9_]{5,32}$/i.test(value.username)) {
        throw new TelegramError(502, true);
      }
      const bot = value as TelegramUser & { username: string };
      this.identity = { value: bot, expires: Date.now() + 10 * 60_000 };
      return bot;
    });
    this.identityPending = pending;
    try { return await pending; }
    finally { this.identityPending = undefined; }
  }
}
