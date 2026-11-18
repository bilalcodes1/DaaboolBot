import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/bot';
import { TelegramClient, TelegramError } from '../src/telegram';
import { NluClassifier } from '../src/nlu';
import type { Env, TelegramUpdate } from '../src/types';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const databases: DatabaseSync[] = [];
function database() {
  const sql = new DatabaseSync(':memory:'); databases.push(sql);
  for (const name of readdirSync(new NodeURL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new NodeURL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  sql.prepare('UPDATE settings SET owner_uid=1,target_chat_id=-100123,target_thread_id=7 WHERE singleton=1').run();
  const prepare = (query: string, values: (string | number | null)[] = []) => ({
    bind(...next: (string | number | null)[]) { return prepare(query, next); },
    async first() { return sql.prepare(query).get(...values) ?? null; },
    async all() { return { success: true, results: sql.prepare(query).all(...values), meta: { changes: 0 } }; },
    async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; },
  });
  const db = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sql.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: '123:synthetic-social-token', WEBHOOK_SECRET_TOKEN: 'synthetic-secret',
    GROQ_API_KEY: 'synthetic-groq-key', CONTRIBUTIONS_ENABLED: 'true' };
  return { sql, env };
}
interface CapturedRequest { method: string; body: Record<string, unknown> }
function transport(reply: string, failDocument = false) {
  const requests: CapturedRequest[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const address = String(url);
    if (address === 'https://api.groq.com/openai/v1/chat/completions') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push({ method: 'groq', body });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply, needsAcademicAnalysis: false }) } }], usage: { total_tokens: 100 } });
    }
    const method = address.split('/').at(-1)!;
    if (method === 'sendDocument') {
      // Multipart PDF stays inside this mock; never copy it into captured AI data.
      expect(init?.body).toBeInstanceOf(FormData); requests.push({ method, body: { multipart: true } });
      return failDocument ? Response.json({ ok: false, error_code: 500, description: 'synthetic failure' }, { status: 500 })
        : Response.json({ ok: true, result: { message_id: 800 } });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; requests.push({ method, body });
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 999, is_bot: true, username: 'DaaboolTestBot' } });
    return Response.json({ ok: true, result: { message_id: 900 + requests.length } });
  });
  return { requests, fetcher, telegram: new TelegramClient('123:synthetic-social-token', fetcher) };
}
function update(updateId: number, text: string, userId = 2, threadId = 7): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId + 100, date: NOW / 1000,
    from: { id: userId, is_bot: false, first_name: 'synthetic' }, chat: { id: -100123, type: 'supergroup' }, message_thread_id: threadId, text } };
}
function modelHistory(requests: CapturedRequest[]) {
  const latest = requests.filter(request => request.method === 'groq').at(-1)!;
  return latest.body.messages as { role: string; content: string }[];
}
function hasNamesDeliveryContext(messages: { role: string; content: string }[]) {
  return messages.some(message => message.role === 'assistant' && /(?:ملف|PDF)/iu.test(message.content) && /(?:أسماء|اسماء|طلاب|الطلبة)/u.test(message.content));
}
afterEach(() => { vi.restoreAllMocks(); for (const sql of databases.splice(0)) sql.close(); });

describe('social conversation after a direct bot action', () => {
  it.each([
    ['ذيب انت @DaaboolTestBot', 'تسلم يا ورد، من ذوقك 🌷'],
    ['عاشت ايدك @DaaboolTestBot', 'الله يعافيك، حاضر إلك 😄'],
  ])('carries successful file-delivery context into the AI response to %s without a canned reply', async (compliment, modelReply) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); const { sql, env } = database(); const net = transport(modelReply);
    await handleUpdate(update(301, 'دعبول دزلي أسماء الطلاب'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    expect(net.requests.filter(request => request.method === 'sendDocument')).toHaveLength(1);
    await handleUpdate(update(302, compliment), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    const modelCalls = net.requests.filter(request => request.method === 'groq');
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]!.body).toMatchObject({ max_completion_tokens: 256,
      response_format: { json_schema: { schema: { required: ['reply', 'needsAcademicAnalysis'] } } } });
    const history = modelHistory(net.requests);
    expect(hasNamesDeliveryContext(history)).toBe(true);
    const summary = history.find(message => message.role === 'assistant')!.content;
    expect(summary.length).toBeLessThan(500);
    expect(JSON.stringify(history)).not.toMatch(/JVBER|%PDF-|file_id|file_unique_id|document_base64/);
    expect(net.requests.filter(request => request.method === 'sendMessage').at(-1)?.body.text).toBe(modelReply);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  });

  it.each([[3, 7], [2, 8]])('does not share direct-action context with user %s in topic %s', async (userId, threadId) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); const { env } = database(); const net = transport('تسلم، من ذوقك.');
    await handleUpdate(update(310, 'دعبول دزلي أسماء الطلاب'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    await handleUpdate(update(311, 'ذيب انت @DaaboolTestBot', userId, threadId), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    expect(hasNamesDeliveryContext(modelHistory(net.requests))).toBe(false);
    expect(modelHistory(net.requests).filter(message => message.role === 'assistant')).toEqual([]);
  });

  it('never tells the model that a failed file delivery succeeded', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); const { env } = database(); const net = transport('تسلم.', true);
    await expect(handleUpdate(update(320, 'دعبول دزلي أسماء الطلاب'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher)).rejects.toBeInstanceOf(TelegramError);
    await handleUpdate(update(321, 'ذيب انت @DaaboolTestBot'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    expect(hasNamesDeliveryContext(modelHistory(net.requests))).toBe(false);
  });

  it('remembers the group clarification without claiming that a document was delivered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW); const { env } = database(); const net = transport('تسلم، من ذوقك.');
    await handleUpdate(update(330, 'دعبول أسماء الطلاب مجموعة A'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    expect(net.requests.some(request => request.method === 'sendDocument')).toBe(false);
    await handleUpdate(update(331, 'ذيب انت @DaaboolTestBot'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    const summaries = modelHistory(net.requests).filter(message => message.role === 'assistant').map(message => message.content);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.join('\n')).not.toMatch(/(?:أرسلت|ارسلت|دزيت|تم\s+إرسال|تم\s+ارسال)\s+(?:ملف|PDF)/u);
  });

  it('does not resend or add a message when context storage fails after a successful document delivery', async () => {
    const { env } = database(); const net = transport('unused');
    env.DB = { prepare() { throw new Error('synthetic D1 outage'); } } as unknown as D1Database;
    await expect(handleUpdate(update(340, 'دعبول دزلي أسماء الطلاب'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher)).resolves.toBeUndefined();
    expect(net.requests.filter(request => request.method === 'sendDocument')).toHaveLength(1);
    expect(net.requests.some(request => request.method === 'sendMessage' || request.method === 'groq')).toBe(false);
  });

  it('continues direct file delivery without extra AI messages when AI is disabled', async () => {
    const { env } = database(); delete env.GROQ_API_KEY; const net = transport('unused');
    await handleUpdate(update(350, 'دعبول دزلي أسماء الطلاب'), net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    expect(net.requests.filter(request => request.method === 'sendDocument')).toHaveLength(1);
    expect(net.requests.some(request => request.method === 'sendMessage' || request.method === 'groq')).toBe(false);
  });
});
