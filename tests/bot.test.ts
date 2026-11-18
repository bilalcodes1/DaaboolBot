import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/bot';
import { hasBotMention, isTomorrowQuery, normalizeArabic, parseUpdate } from '../src/input';
import { TelegramClient, TelegramError } from '../src/telegram';
import type { TelegramMessage, TelegramUpdate } from '../src/types';

const TOKEN = '123456:abcdefghijklmnopqrstuvwxyz_fake_token';
const BOT = { id: 123456, is_bot: true, username: 'ActualDaaboolBot' };
const HUMAN = { id: 42, is_bot: false };
const now = new Date('2026-10-13T12:00:00Z');

function message(text: string, type: TelegramMessage['chat']['type'] = 'private'): TelegramMessage {
  return { message_id: 12, chat: { id: type === 'private' ? 42 : -100123, type }, from: HUMAN, text };
}

function privateQuestion(text: string): TelegramMessage {
  return message(text);
}

function transport() {
  const sent: { method: string; body: Record<string, any> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(init!.body as string);
    sent.push({ method, body });
    return Response.json({ ok: true, result: method === 'getMe' ? BOT : true });
  });
  return { sent, fetcher, client: new TelegramClient(TOKEN, fetcher) };
}

describe('Arabic queries and targeting', () => {
  it.each([
    'شنو عدنا باجر؟', 'شنو عدنا باچر؟', 'شعدنا باجر؟', 'شعدنا باچر؟',
    'شنو عندنا باجر؟', 'باچر شنو عدنا؟', 'باجر شنو عدنا؟',
    '  شنو   عدنا باچر  ', 'شِنُو عـدنا باچر؟', '@ActualDaaboolBot شنو عدنا باچر؟',
  ])('recognizes %s', query => expect(isTomorrowQuery(query)).toBe(true));

  it.each(['باجر عندي امتحان', 'شنو عدنا اليوم؟', 'شنو عدنا باجر الخميس', 'مرحبا', ''])('ignores unrelated %s', query => {
    expect(isTomorrowQuery(query)).toBe(false);
  });

  it('handles Arabic presentation forms and invisible direction marks', () => {
    expect(normalizeArabic('\u200fشنو عدنا باچر؟')).toBe('شنو عدنا باجر');
  });

  it('uses case-insensitive exact mention entities with UTF-16 emoji offsets', () => {
    const text = '🤖 @aCtUaLdAaBoOlBoT شنو عدنا باچر؟';
    expect(hasBotMention({ ...message(text, 'supergroup'), entities: [{ type: 'mention', offset: 3, length: 17 }] }, BOT.username)).toBe(true);
    expect(hasBotMention({ ...message(text, 'group'), entities: [{ type: 'code', offset: 3, length: 17 }] }, BOT.username)).toBe(false);
  });

  it.each(['@ActualDaaboolBot_extra', '@OtherDaaboolBot', 'a@ActualDaaboolBot', '@@ActualDaaboolBot', '@ActualDaaboolBotع'])('rejects partial or unrelated mentions %s', text => {
    expect(hasBotMention(message(text, 'group'), BOT.username)).toBe(false);
  });

  it('allows punctuation and Arabic whitespace before fallback mentions', () => {
    expect(hasBotMention(message('هلا، @ACTUALDAABOOLBOT شنو عدنا باچر', 'group'), BOT.username)).toBe(true);
  });
});

describe('Telegram behavior', () => {
  it.each(['شنو عدنا باچر؟', 'شعدنا باجر', 'جدول اليوم'])('answers private questions without requiring the wake word: %s', async text => {
    const api = transport();
    const run = vi.fn();
    await handleUpdate({ update_id: 50, message: message(text) }, api.client, now, { AI: { run }, AI_FREE_TIER_CONFIRMED: 'true' });
    expect(api.sent.map(item => item.method)).toEqual(['getMe', 'sendMessage']);
    expect(api.sent.at(-1)!.body.text).toContain(text === 'جدول اليوم' ? 'جدول الثلاثاء' : 'جدول الأربعاء');
    expect(api.sent.at(-1)!.body.reply_parameters.message_id).toBe(12);
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts an exact real-username mention as an explicit private invocation', async () => {
    const api = transport();
    await handleUpdate({ update_id: 51, message: message('@ACTUALDAABOOLBOT شنو عدنا باچر؟') }, api.client, now);
    expect(api.sent.map(item => item.method)).toEqual(['getMe', 'sendMessage']);
    expect(api.sent.at(-1)!.body.text).toContain('جدول الأربعاء');
  });

  it('cycles only the three user-authored wake replies when contributions have no DB', async () => {
    const api = transport();
    for (const update_id of [0, 1, 2]) {
      await handleUpdate({ update_id, message: message('دعبول') }, api.client, now);
    }
    expect(api.sent.filter(item => item.method === 'sendMessage').map(item => item.body.text)).toEqual([
      'خير شكو 😒 ماتخلون احد ينام ؟',
      'اهوووو مو نايم شتريد/ين هسه ؟',
      'خير يم خضير شتريد/ين ؟',
    ]);
  });

  it('ignores private sender bots and uninvoked photo/document media without looking up identity', async () => {
    const api = transport();
    const inputs: TelegramMessage[] = [
      { ...message('دعبول شنو عدنا باچر؟'), from: BOT },
      { ...message('دعبول شنو عدنا باچر؟'), via_bot: BOT },
      { ...message('دعبول شنو عدنا باچر؟'), sender_chat: { id: -1001 } },
      { message_id: 12, chat: { id: 42, type: 'private' }, from: HUMAN, photo: [{ file_id: 'photo_1', width: 100, height: 100 }], caption: 'صورة عادية' },
      { message_id: 13, chat: { id: 42, type: 'private' }, from: HUMAN, document: { file_id: 'document_1', file_name: 'notes.pdf' } },
    ];
    for (const item of inputs) await handleUpdate({ update_id: item.message_id + 100, message: item }, api.client, now);
    expect(api.fetcher).not.toHaveBeenCalled();
  });

  it('replies to an ordinary private question using safe HTML', async () => {
    const api = transport();
    await handleUpdate({ update_id: 1, message: privateQuestion('شنو عدنا باچر') }, api.client, now);
    expect(api.sent.map(x => x.method)).toEqual(['getMe', 'sendMessage']);
    expect(api.sent[1]!.body).toMatchObject({ chat_id: 42, parse_mode: 'HTML', reply_parameters: { message_id: 12 } });
    expect(api.sent[1]!.body.text).toContain('جدول الأربعاء');
  });

  it('answers a clear private question in a media caption without turning the attachment into a contribution', async () => {
    const api = transport();
    await handleUpdate({ update_id: 151, message: {
      message_id: 13, chat: { id: 42, type: 'private' }, from: HUMAN,
      photo: [{ file_id: 'photo_1', width: 100, height: 100 }], caption: 'شعدنا باجر؟',
    } }, api.client, now);
    expect(api.sent.map(item => item.method)).toEqual(['getMe', 'sendMessage']);
    expect(api.sent.at(-1)!.body.text).toContain('جدول الأربعاء');
    expect(api.sent.at(-1)!.body.reply_parameters.message_id).toBe(13);
  });

  it.each(['group', 'supergroup'] as const)('uses the real getMe username in %s and replies to original thread', async type => {
    const api = transport();
    await handleUpdate({ update_id: 2, message: { ...message('@ACTUALDAABOOLBOT شنو عدنا باچر؟', type), message_thread_id: 77 } }, api.client, now);
    expect(api.sent[1]!.body).toMatchObject({ chat_id: -100123, message_thread_id: 77, reply_parameters: { message_id: 12 } });
  });

  it.each(['شنو عدنا باچر', '@DaaboolBot شنو عدنا باچر', '@ActualDaaboolBot_extra شنو عدنا باچر'])('does not answer untargeted group text %s', async text => {
    const api = transport();
    await handleUpdate({ update_id: 3, message: message(text, 'group') }, api.client, now);
    expect(api.sent.some(x => x.method === 'sendMessage')).toBe(false);
  });

  it('ignores bot messages, inline-origin messages, channels and media', async () => {
    const api = transport();
    const base = message('@ActualDaaboolBot شنو عدنا باچر', 'group');
    const inputs: TelegramMessage[] = [
      { ...base, from: BOT }, { ...base, via_bot: BOT }, { ...base, sender_chat: { id: -1001 } },
      message('شنو عدنا باچر', 'channel'), { message_id: 1, chat: { id: 42, type: 'private' } },
    ];
    for (const item of inputs) await handleUpdate({ update_id: 4, message: item }, api.client, now);
    expect(api.fetcher).not.toHaveBeenCalled();
  });

  it('answers /start privately and targeted group commands only', async () => {
    const api = transport();
    await handleUpdate({ update_id: 5, message: message('/start') }, api.client, now);
    await handleUpdate({ update_id: 6, message: message('/help@ActualDaaboolBot', 'group') }, api.client, now);
    await handleUpdate({ update_id: 7, message: message('/start@OtherBot', 'group') }, api.client, now);
    await handleUpdate({ update_id: 8, message: message('/start', 'group') }, api.client, now);
    expect(api.sent.filter(x => x.method === 'sendMessage')).toHaveLength(2);
    const replies = api.sent.filter(x => x.method === 'sendMessage');
    expect(replies[0]!.body.reply_markup).toEqual({ remove_keyboard: true });
    expect(replies[1]!.body.reply_markup).toBeUndefined();
  });

  it.each(['شنو عدنا باچر', ''])('answers inline query %s with uncached date-specific article', async query => {
    const api = transport();
    await handleUpdate({ update_id: 9, inline_query: { id: 'inline-id', from: HUMAN, query, offset: '' } }, api.client, now);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ method: 'answerInlineQuery', body: { inline_query_id: 'inline-id', cache_time: 0, is_personal: true } });
    expect(api.sent[0]!.body.results).toHaveLength(1);
    expect(api.sent[0]!.body.results[0]).toMatchObject({ id: 'tomorrow-2026-10-14', title: '📚 جدول محاضرات باچر – الأربعاء', input_message_content: { parse_mode: 'HTML' } });
    expect(api.sent[0]!.body.results[0].input_message_content.message_text).toContain('د. رقية اياد');
  });

  it('asks for clarification on unknown inline queries and ignores pagination', async () => {
    const api = transport();
    for (const [query, offset] of [['شي ثاني', ''], ['شنو عدنا باچر', 'page2']]) {
      await handleUpdate({ update_id: 10, inline_query: { id: 'id', from: HUMAN, query: query!, offset: offset! } }, api.client, now);
    }
    expect(api.sent[0]!.body.results[0].input_message_content.message_text).toContain('شنو تريد تعرف');
    expect(api.sent[1]!.body.results).toEqual([]);
  });

  it('answers today and filtered material queries locally without AI', async () => {
    const api = transport();
    const run = vi.fn();
    const env = { AI: { run }, AI_FREE_TIER_CONFIRMED: 'true' };
    await handleUpdate({ update_id: 201, message: privateQuestion('جدول اليوم') }, api.client, now, env);
    expect(api.sent.at(-1)!.body.text).toContain('جدول الثلاثاء');
    await handleUpdate({ update_id: 202, message: privateQuestion('وين الموبايل مجموعة A الأحد؟') }, api.client, now, env);
    expect(api.sent.at(-1)!.body.text).toContain('م1');
    expect(api.sent.at(-1)!.body.text).toContain('خبيب باسم');
    expect(api.sent.at(-1)!.body.text).not.toContain('الموبايل (عملي)');
    expect(run).not.toHaveBeenCalled();
  });

  it('never classifies ordinary group messages or mentions of another bot', async () => {
    const api = transport();
    const run = vi.fn();
    const env = { AI: { run }, AI_FREE_TIER_CONFIRMED: 'true' };
    await handleUpdate({ update_id: 203, message: message('شباب عطوني ترتيب حصصنا للغد', 'group') }, api.client, now, env);
    await handleUpdate({ update_id: 204, message: message('@OtherBot شباب عطوني ترتيب حصصنا للغد', 'group') }, api.client, now, env);
    expect(run).not.toHaveBeenCalled();
    expect(api.sent.some(x => x.method === 'sendMessage')).toBe(false);
  });

  it('answers the exact lab typo query privately and in a mentioned group without AI', async () => {
    const api = transport();
    const run = vi.fn();
    const env = { AI: { run }, AI_FREE_TIER_CONFIRMED: 'true' };
    for (const type of ['private', 'supergroup'] as const) {
      const text = `${type === 'private' ? '' : '@ActualDaaboolBot '}شنو عدنا مختبرات يوم الاحد مجوعة b`;
      await handleUpdate({ update_id: 250, message: message(text, type) }, api.client, now, env);
      const reply = api.sent.at(-1)!.body.text as string;
      expect(reply.match(/📖/g)).toHaveLength(2);
      expect(reply).toContain('شبكات الحاسبة | مجموعة B | م2');
      expect(reply).toContain('برمجة تطبيقات الموبايل | مجموعة B | م1');
      expect(reply).not.toMatch(/مجموعة A|معمارية/);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('next and current time questions work locally and through uncached inline results', async () => {
    const api = transport();
    const run = vi.fn();
    const env = { AI: { run }, AI_FREE_TIER_CONFIRMED: 'true' };
    const clock = new Date('2026-10-18T06:45:00Z');
    await handleUpdate({ update_id: 251, message: privateQuestion('ايمتى المحاضره الجايه مجموعة B') }, api.client, clock, env);
    expect(api.sent.at(-1)!.body.text).toContain('تبدي بعد 45 دقيقة');
    expect(api.sent.at(-1)!.body.text).toContain('برمجة تطبيقات الموبايل | مجموعة B | م1');
    await handleUpdate({ update_id: 252, inline_query: {
      id: 'time-inline', from: HUMAN, query: 'شنو عدنا هسه مجموعة B', offset: '',
    } }, api.client, clock, env);
    const result = api.sent.at(-1)!;
    expect(result.body.cache_time).toBe(0);
    const text = result.body.results[0].input_message_content.message_text;
    expect(text).toContain('شبكات الحاسبة | مجموعة B | م2');
    expect(text).toContain('الأوقات مؤقتة وتقديرية');
    await handleUpdate({ update_id: 253, message: privateQuestion('شنو المحاضرة الحالية يوم الأحد مجموعة B') }, api.client, clock, env);
    expect(api.sent.at(-1)!.body.text).toContain('شبكات الحاسبة | مجموعة B | م2');
    await handleUpdate({ update_id: 254, message: privateQuestion('شنو المحاضرة الحالية يوم الاثنين مجموعة B') }, api.client, clock, env);
    expect(api.sent.at(-1)!.body.text).not.toContain('📖');
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the exact narrow-scope reply and asks rather than guessing unknown references', async () => {
    const api = transport();
    await handleUpdate({ update_id: 205, message: privateQuestion('اشرحلي الشبكات') }, api.client, now);
    expect(api.sent.at(-1)!.body.text).toBe('حبيبي آني دعبول، مختص بجدول محاضرات المرحلة الثالثة 😂❤️');
    await handleUpdate({ update_id: 206, message: privateQuestion('نفسها مثل قبل') }, api.client, now);
    expect(api.sent.at(-1)!.body.text).toContain('شنو تريد تعرف');
  });

  it('ignores inline queries from bots', async () => {
    const api = transport();
    await handleUpdate({ update_id: 11, inline_query: { id: 'id', from: BOT, query: '', offset: '' } }, api.client, now);
    expect(api.fetcher).not.toHaveBeenCalled();
  });
});

describe('student names routing', () => {
  function namesTransport() {
    const sent: { method: string; body: FormData | Record<string, any> }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const method = String(url).split('/').at(-1)!;
      const body = init!.body instanceof FormData ? init!.body : JSON.parse(init!.body as string);
      sent.push({ method, body });
      return Response.json({ ok: true, result: method === 'getMe' ? BOT : true });
    });
    return { sent, fetcher, client: new TelegramClient(TOKEN, fetcher) };
  }

  it.each([false, true])('answers private names requests before AI or contribution storage (linked reply: %s)', async linked => {
    const api = namesTransport();
    const run = vi.fn();
    const prepare = vi.fn(() => { throw new Error('D1 unavailable'); });
    const input = { ...message('دعبول دزلي الاسماء مال الطلاب'), ...(linked ? {
      reply_to_message: { message_id: 99, chat: { id: 42, type: 'private' as const }, from: BOT },
    } : {}) };
    await handleUpdate({ update_id: 301, message: input }, api.client, now, {
      DB: { prepare } as unknown as D1Database, CONTRIBUTIONS_ENABLED: 'true',
      AI: { run }, AI_FREE_TIER_CONFIRMED: 'true',
    });
    expect(api.sent.map(item => item.method)).toEqual(['getMe', 'sendDocument']);
    const form = api.sent[1]!.body as FormData;
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('message_thread_id')).toBeNull();
    expect(JSON.parse(form.get('reply_parameters') as string).message_id).toBe(12);
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(input.reply_to_message?.message_id).toBe(linked ? 99 : undefined);
  });

  it.each([
    ['group', 'دعبول أسماء الطلاب'],
    ['supergroup', '@ACTUALDAABOOLBOT قائمة أسماء طلاب المرحلة الثالثة'],
  ] as const)('answers a targeted %s names request in its topic', async (type, text) => {
    const api = namesTransport();
    await handleUpdate({ update_id: 302, message: { ...message(text, type), message_thread_id: 77 } }, api.client, now);
    expect(api.sent.map(item => item.method)).toEqual(['getMe', 'sendDocument']);
    const form = api.sent[1]!.body as FormData;
    expect(form.get('chat_id')).toBe('-100123');
    expect(form.get('message_thread_id')).toBe('77');
    expect(JSON.parse(form.get('reply_parameters') as string)).toEqual({ message_id: 12, allow_sending_without_reply: true });
  });

  it.each(['أسماء الطلاب', 'دزلي ملف الاسماء', '@OtherBot أسماء الطلاب'])('keeps an unaddressed group request silent: %s', async text => {
    const api = namesTransport();
    const run = vi.fn();
    await handleUpdate({ update_id: 303, message: message(text, 'group') }, api.client, now, { AI: { run }, AI_FREE_TIER_CONFIRMED: 'true' });
    expect(api.sent.every(item => item.method === 'getMe')).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps sender and chat guards ahead of the names route', async () => {
    const api = namesTransport();
    for (const input of [
      { ...message('أسماء الطلاب'), from: BOT },
      { ...message('أسماء الطلاب'), via_bot: BOT },
      { ...message('أسماء الطلاب'), sender_chat: { id: -1001 } },
      message('دعبول أسماء الطلاب', 'channel'),
    ]) await handleUpdate({ update_id: 304, message: input }, api.client, now);
    expect(api.fetcher).not.toHaveBeenCalled();
  });
});

describe('validated update boundary', () => {
  it.each([null, [], {}, { update_id: -1 }, { update_id: 1.2 }, { update_id: 1, message: {} },
    { update_id: 1, message: { ...message('x'), from: { is_bot: false } } },
    { update_id: 1, message: { ...message('x'), entities: [{ type: 'mention', offset: 9, length: 2 }] } },
    { update_id: 1, inline_query: { id: 'id', from: HUMAN, query: '', offset: 3 } },
  ])('rejects malformed update %#', input => expect(parseUpdate(input)).toBeNull());

  it('accepts old unwanted update types without processing them', () => {
    expect(parseUpdate({ update_id: 100, edited_message: {} })).toMatchObject({ update_id: 100 });
  });

  it('rejects simultaneous message and inline query', () => {
    expect(parseUpdate({ update_id: 1, message: message('x'), inline_query: { id: 'id', from: HUMAN, query: '', offset: '' } })).toBeNull();
  });
});

describe('Telegram client reliability and redaction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('caches getMe for ten minutes and coalesces concurrent lookups', async () => {
    const api = transport();
    await Promise.all([api.client.getMe(), api.client.getMe()]);
    await api.client.getMe();
    expect(api.fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    await api.client.getMe();
    expect(api.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503, 401, 404])('marks %i retryable without exposing raw response', async code => {
    const client = new TelegramClient(TOKEN, vi.fn<typeof fetch>(async () => Response.json({ ok: false, error_code: code, description: TOKEN, parameters: { retry_after: 30 } }, { status: code })));
    await expect(client.call('sendMessage')).rejects.toMatchObject({ code, retryable: true, retryAfter: 30 });
    await expect(client.call('sendMessage')).rejects.not.toThrow(TOKEN);
  });

  it('sanitizes network exceptions that contain request credentials', async () => {
    const client = new TelegramClient(TOKEN, vi.fn<typeof fetch>(async () => { throw new Error(`failed https://api.telegram.org/bot${TOKEN}/getMe`); }));
    await expect(client.getMe()).rejects.toThrow(TelegramError);
    await expect(client.getMe()).rejects.not.toThrow(TOKEN);
  });

  it('allows getMe to retry after failure and validates the returned identity', async () => {
    const api = transport();
    api.fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: { id: 1, is_bot: true, username: '<invalid>' } }));
    await expect(api.client.getMe()).rejects.toMatchObject({ retryable: true });
    await expect(api.client.getMe()).resolves.toMatchObject(BOT);
  });
});
