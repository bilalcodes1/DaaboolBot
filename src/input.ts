import type { InlineQuery, MessageEntity, TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from './types';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min = Number.MIN_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min;
}

function user(value: unknown): value is TelegramUser {
  return record(value) && integer(value.id, 1) && typeof value.is_bot === 'boolean'
    && (value.first_name === undefined || boundedString(value.first_name, 256))
    && (value.last_name === undefined || boundedString(value.last_name, 256));
}

function boundedString(value: unknown, maximum: number, minimum = 0): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function chat(value: unknown): boolean {
  return record(value) && integer(value.id) && value.id !== 0
    && ['private', 'group', 'supergroup', 'channel'].includes(value.type as string);
}

function fileReference(value: unknown): boolean {
  if (!record(value) || typeof value.file_id !== 'string' || !/^[a-z0-9_-]{1,512}$/i.test(value.file_id)) return false;
  if (value.file_unique_id !== undefined && (typeof value.file_unique_id !== 'string'
    || !/^[a-z0-9_-]{1,256}$/i.test(value.file_unique_id))) return false;
  return value.file_size === undefined || integer(value.file_size, 0);
}

function photo(value: unknown): boolean {
  return record(value) && fileReference(value)
    && integer(value.width, 1) && value.width <= 100_000
    && integer(value.height, 1) && value.height <= 100_000;
}

function replyReference(value: unknown): boolean {
  return record(value) && integer(value.message_id, 1) && chat(value.chat)
    && (value.is_topic_message === undefined || typeof value.is_topic_message === 'boolean')
    && (value.date === undefined || integer(value.date,0) && value.date <= 4_294_967_295)
    && (value.via_bot === undefined || user(value.via_bot))
    && (value.from === undefined || user(value.from))
    && (value.text === undefined || boundedString(value.text, 8192))
    && (value.caption === undefined || boundedString(value.caption, 2048));
}

function entity(value: unknown, textLength: number): value is MessageEntity {
  return record(value) && typeof value.type === 'string' && integer(value.offset, 0)
    && integer(value.length, 1) && value.offset + value.length <= textLength;
}

function message(value: unknown): value is TelegramMessage {
  if (!record(value) || !integer(value.message_id, 1) || !chat(value.chat)) return false;
  if (value.is_topic_message !== undefined && typeof value.is_topic_message !== 'boolean') return false;
  if (value.date !== undefined && (!integer(value.date, 0) || value.date > 4_294_967_295)) return false;
  if (value.from !== undefined && !user(value.from)) return false;
  if (value.via_bot !== undefined && !user(value.via_bot)) return false;
  if (value.sender_chat !== undefined && (!record(value.sender_chat) || !integer(value.sender_chat.id))) return false;
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 8192)) return false;
  if (value.caption !== undefined && !boundedString(value.caption, 2048)) return false;
  if (value.photo !== undefined && (!Array.isArray(value.photo) || value.photo.length < 1
    || value.photo.length > 10 || !value.photo.every(photo))) return false;
  if (value.document !== undefined && (!record(value.document) || !fileReference(value.document)
    || (value.document.file_name !== undefined && !boundedString(value.document.file_name, 512))
    || (value.document.mime_type !== undefined && !boundedString(value.document.mime_type, 128)))) return false;
  if (['photo', 'document', 'video', 'animation', 'sticker', 'poll'].filter(key => value[key] !== undefined).length > 1) return false;
  if (value.reply_to_message !== undefined && !replyReference(value.reply_to_message)) return false;
  if (value.chat_shared !== undefined && (!record(value.chat_shared)
    || !integer(value.chat_shared.request_id, -2147483648) || value.chat_shared.request_id > 2147483647
    || !integer(value.chat_shared.chat_id) || value.chat_shared.chat_id === 0
    || (value.chat_shared.title !== undefined && !boundedString(value.chat_shared.title, 512))
    || (value.chat_shared.username !== undefined && !boundedString(value.chat_shared.username, 64)))) return false;
  if (value.message_thread_id !== undefined && !integer(value.message_thread_id, 1)) return false;
  if (value.entities !== undefined && (!Array.isArray(value.entities) || value.entities.length > 100
    || !value.entities.every(e => entity(e, typeof value.text === 'string' ? value.text.length : 0)))) return false;
  if (value.caption_entities !== undefined && (!Array.isArray(value.caption_entities) || value.caption_entities.length > 100
    || !value.caption_entities.every(e => entity(e, typeof value.caption === 'string' ? value.caption.length : 0)))) return false;
  return true;
}

function callback(value: unknown): value is TelegramCallbackQuery {
  return record(value) && boundedString(value.id, 256, 1) && user(value.from)
    && boundedString(value.chat_instance, 256, 1)
    && (value.message === undefined || message(value.message))
    && (value.inline_message_id === undefined || boundedString(value.inline_message_id, 256, 1))
    && (value.message !== undefined || value.inline_message_id !== undefined)
    && (value.data === undefined || boundedString(value.data, 64, 1) && new TextEncoder().encode(value.data).length <= 64);
}

function inline(value: unknown): value is InlineQuery {
  return record(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
    && user(value.from) && typeof value.query === 'string' && value.query.length <= 512
    && typeof value.offset === 'string' && value.offset.length <= 256;
}

export function parseUpdate(value: unknown): TelegramUpdate | null {
  if (!record(value) || !integer(value.update_id, 0)) return null;
  if (value.channel_post !== undefined && !message(value.channel_post)) return null;
  if (value.message !== undefined && !message(value.message)) return null;
  if (value.inline_query !== undefined && !inline(value.inline_query)) return null;
  if (value.callback_query !== undefined && !callback(value.callback_query)) return null;
  if (['message', 'channel_post', 'inline_query', 'callback_query', 'poll'].filter(key => value[key] !== undefined).length > 1) return null;
  // Other valid update kinds are acknowledged and ignored (including old queued updates).
  return value as unknown as TelegramUpdate;
}

/** Telegram entity offsets and JavaScript slice both use UTF-16 code units. */
export function hasBotMention(message: TelegramMessage, username: string): boolean {
  const text = message.text ?? message.caption ?? '';
  const target = `@${username.toLowerCase()}`;
  const entities = message.text !== undefined ? message.entities : message.caption_entities;
  if (entities) {
    return entities.some(e => e.type === 'mention'
      && text.slice(e.offset, e.offset + e.length).toLowerCase() === target);
  }
  // Fallback for clients/fixtures without entities, with full username boundaries.
  return Array.from(text.matchAll(/(^|[^\p{L}\p{N}_@])@([a-z0-9_]+)(?![\p{L}\p{N}_])/giu))
    .some(match => match[2]?.toLowerCase() === username.toLowerCase());
}

export function stripMentions(text: string): string {
  return text.replace(/@[a-z0-9_]+/gi, ' ');
}

export function normalizeArabic(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/چ/g, 'ج')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function isTomorrowQuery(text: string): boolean {
  const query = normalizeArabic(stripMentions(text));
  return /^(?:(?:شنو (?:عدنا|عندنا)|شعدنا) باجر|باجر (?:شنو (?:عدنا|عندنا)|شعدنا))$/.test(query);
}
