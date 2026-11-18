import { describe, expect, it } from 'vitest';
import { hasBotMention, parseUpdate } from '../src/input';
import { TelegramClient } from '../src/telegram';

const actor = { id: 42, is_bot: false };
const base = { message_id: 7, from: actor, chat: { id: 42, type: 'private' } };
const photo = { file_id: 'AgAC_test-1', file_unique_id: 'unique_1', width: 320, height: 240, file_size: 4000 };
const callback = { id: 'callback-1', from: actor, chat_instance: 'instance', message: base, data: 'publish:draft1' };

describe('academic contribution input boundaries', () => {
  it('accepts photo, document and caption references without downloading content', () => {
    expect(parseUpdate({ update_id: 1, message: { ...base, photo: [photo], caption: 'الأحد كوز شبكات' } })?.message?.photo?.[0]?.file_id).toBe(photo.file_id);
    expect(parseUpdate({ update_id: 2, message: { ...base, document: { file_id: 'BQAC_file', file_name: 'واجب.pdf', mime_type: 'application/pdf' } } })?.message?.document?.file_name).toBe('واجب.pdf');
  });

  it.each([
    { is_topic_message:'yes' }, {reply_to_message:{message_id:4,chat:base.chat,is_topic_message:1}}, { photo: [] }, { photo: Array(11).fill(photo) }, { photo: [{ ...photo, file_id: 'https://evil.example/x' }] },
    { photo: [{ ...photo, file_id: 'x'.repeat(513) }] }, { photo: [{ ...photo, width: -1 }] },
    { photo: [{ ...photo, file_size: Number.MAX_SAFE_INTEGER + 1 }] },
    { document: { file_id: '../file' } }, { document: { file_id: 'valid', mime_type: 'x'.repeat(129) } },
    { caption: 'x'.repeat(2049) }, { photo: [photo], document: { file_id: 'file' } },
  ])('rejects malformed or oversized attachment metadata: %j', extra => {
    expect(parseUpdate({ update_id: 1, message: { ...base, ...extra } })).toBeNull();
  });

  it('matches real mentions in captions using Telegram UTF-16 offsets', () => {
    const message = parseUpdate({ update_id: 1, message: {
      ...base, photo: [photo], caption: '📚 @DaaboolBot الأحد كوز', caption_entities: [{ type: 'mention', offset: 3, length: 11 }],
    } })?.message;
    expect(message).toBeDefined();
    expect(hasBotMention(message!, 'daaboolbot')).toBe(true);
    expect(hasBotMention(message!, 'anotherbot')).toBe(false);
    expect(parseUpdate({ update_id: 2, message: { ...base, caption: 'a', caption_entities: [{ type: 'mention', offset: 0, length: 2 }] } })).toBeNull();
  });

  it('accepts minimal reply references and shared-chat request identifiers', () => {
    expect(parseUpdate({ update_id: 1, message: { ...base,
      reply_to_message: { message_id: 4, chat: base.chat, date: 1793307599, via_bot:{id:999,is_bot:true}, from: { id: 999, is_bot: true } },
      chat_shared: { request_id: -99, chat_id: -100123, title: 'طلاب المرحلة الثالثة' },
    } })?.message?.chat_shared?.chat_id).toBe(-100123);
    for (const invalid of [
      { reply_to_message: { message_id: 0, chat: base.chat } },
      { reply_to_message: { message_id: 4, chat: base.chat, date: -1 } },
      { reply_to_message: { message_id: 4, chat: base.chat, via_bot: {id:0,is_bot:true} } },
      { reply_to_message: { message_id: 4, chat: base.chat, date: '2026-10-29' } },
      { reply_to_message: { message_id: 4, chat: base.chat, date: 4_294_967_296 } },
      { chat_shared: { request_id: 2147483648, chat_id: -100123 } },
      { chat_shared: { request_id: 1, chat_id: 0 } },
    ]) expect(parseUpdate({ update_id: 1, message: { ...base, ...invalid } })).toBeNull();
  });

  it('validates callback actors and their target message before exposing actions', () => {
    expect(parseUpdate({ update_id: 1, callback_query: callback })?.callback_query?.from.id).toBe(42);
    for (const invalid of [
      { ...callback, from: { id: 0, is_bot: false } }, { ...callback, from: { id: 42 } },
      { ...callback, message: { ...base, message_id: 0 } }, { ...callback, message: undefined },
      { ...callback, data: 'a'.repeat(65) }, { ...callback, data: 'ع'.repeat(33) }, { ...callback, chat_instance: '' },
    ]) expect(parseUpdate({ update_id: 1, callback_query: invalid })).toBeNull();
    expect(parseUpdate({ update_id: 1, callback_query: { ...callback, data: 'ع'.repeat(32) } })).not.toBeNull();
  });

  it('rejects conflicting update kinds and preserves bot/via/sender identity', () => {
    expect(parseUpdate({ update_id: 1, message: base, callback_query: callback })).toBeNull();
    expect(parseUpdate({ update_id: 1, callback_query: callback, inline_query: { id: '1', from: actor, query: '', offset: '' } })).toBeNull();
    const incoming = { ...base, from: { id: 999, is_bot: true }, via_bot: { id: 888, is_bot: true }, sender_chat: { id: -1004 } };
    expect(parseUpdate({ update_id: 1, message: incoming })?.message).toEqual(incoming);
  });
});

it('new Telegram methods use JSON POST without redirects or attachment downloads', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const client = new TelegramClient(`123456:${'x'.repeat(30)}`, async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return Response.json({ ok: true, result: true });
  });
  for (const method of ['sendPhoto', 'sendDocument', 'answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup', 'getChat', 'getChatMember'] as const) {
    await client.call(method, { chat_id: 42, photo: photo.file_id });
  }
  expect(calls).toHaveLength(7);
  expect(calls.every(call => call.options.method === 'POST' && call.options.redirect === 'manual')).toBe(true);
  expect(calls.every(call => call.url.startsWith('https://api.telegram.org/bot'))).toBe(true);
});
