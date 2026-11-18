import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleUpdate } from '../src/bot';
import { NluClassifier } from '../src/nlu';
import { PRIMARY_ADMIN } from '../src/admin';
import { TelegramClient } from '../src/telegram';
import { dispatchEventJobs } from '../src/event-jobs';
import { EventStore } from '../src/event-store';
import type { TelegramUpdate } from '../src/types';

const NOW = Date.parse('2026-10-27T09:00:00+03:00');
const CHANNEL = -1002222222222;
const databases: DatabaseSync[] = [];
function database() {
  const sql = new DatabaseSync(':memory:'); databases.push(sql);
  const directory = resolve(import.meta.dirname, '../migrations');
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(resolve(directory, name), 'utf8'));
  sql.exec(`UPDATE settings SET owner_uid=${PRIMARY_ADMIN},target_chat_id=${CHANNEL},target_thread_id=NULL`);
  let queries = 0;
  const admit = () => { if (++queries > 50) throw Error('Exceeded free D1 query allowance'); };
  class Prepared {
    constructor(readonly query: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]) { return new Prepared(this.query, values); }
    async first<T>() { admit(); return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
    async all<T>() { admit(); return { success: true, results: sql.prepare(this.query).all(...this.values) as T[] }; }
    async run() { admit(); return { success: true, meta: { changes: Number(sql.prepare(this.query).run(...this.values).changes) } }; }
  }
  const db = { prepare: (query: string) => new Prepared(query), batch: async (statements: Prepared[]) => {
    sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { db, sql, count: () => queries, reset: () => { queries = 0; } };
}
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

describe('natural save and manual publish request budget', () => {
  it.each([
    { size: 1, anonymous: false, fallback: false },
    { size: 3, anonymous: false, fallback: false },
    { size: 6, anonymous: false, fallback: false },
    { size: 6, anonymous: true, fallback: false },
    { size: 6, anonymous: false, fallback: true },
    { size: 6, anonymous: true, fallback: true },
    { size: 3, anonymous: false, fallback: false, mixed: true },
  ])('defers $size items (anonymous=$anonymous, fallback=$fallback, mixed=$mixed) within the free budget', async ({ size, anonymous, fallback, mixed = false }) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { db, sql, count, reset } = database();
    const courses = mixed ? ['رسومات', 'معمارية', 'برمجة مرئية'] : Array(size).fill('رسومات') as string[];
    const dates = Array.from({ length: size }, (_, index) => mixed ? `2026-10-${28 + index}` : 'باچر');
    const clauses = Array.from({ length: size }, (_, index) => `كوز ${courses[index]} ${dates[index]} موضوع ${index}`);
    const text = `احفظ عدنا ${clauses.join('، ')} انشر هسه`;
    const analysis = { intent: 'academic', reply: '', clarification: null, items: clauses.map((clause, index) => ({
      action: 'create', targetId: null, kind: 'quiz', course: mixed ? ['graphics', 'architecture', 'visual'][index] : 'graphics', courseEvidence: courses[index],
      date: mixed ? dates[index] : '2026-10-28', dateEvidence: dates[index], time: null, timeEvidence: null, audience: null, audienceEvidence: null,
      certainty: 'asserted', component: null, coverage: '', occurrenceSlots: [], occurrenceEvidence: null, details: clause, evidence: clause,
    })) };
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes('api.groq.com')) return fallback
        ? Response.json({ error: 'synthetic busy minute' }, { status: 429, headers: { 'retry-after': '60' } })
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }], usage: { total_tokens: 800 } });
      if (String(url).includes('generativelanguage.googleapis.com')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(analysis) }] } }], usageMetadata: { totalTokenCount: 800 } });
      calls.push({ method: String(url).split('/').at(-1)!, body: JSON.parse(String(init?.body)) });
      if (String(url).endsWith('/getMe')) return Response.json({ ok: true, result: { id: 123456, is_bot: true, username: 'daaboolbot' } });
      return Response.json({ ok: true, result: { message_id: 100 + calls.length } });
    };
    const telegram = new TelegramClient('123:synthetic-test', fetcher);
    const update: TelegramUpdate = { update_id: 99, message: { message_id: 99, date: NOW / 1000,
      from: { id: PRIMARY_ADMIN, is_bot: false }, chat: { id: PRIMARY_ADMIN, type: 'private' }, text,
      reply_to_message: { message_id: 88, chat: { id: PRIMARY_ADMIN, type: 'private' } } } };
    let invocation = text;
    if (anonymous) {
      const original = { ...update.message!, message_id: 12, chat: { id: -1001111111111, type: 'supergroup' }, sender_chat: { id: -1001111111111 } };
      sql.prepare('INSERT INTO anonymous_requests(id,chat_id,message_id,body,message_json,expires_at) VALUES(?,?,?,?,?,?)')
        .run('abcdef123456', original.chat.id, original.message_id, text, JSON.stringify(original), NOW + 15 * 60_000);
      invocation = 'تأكيد طلب abcdef123456';
      update.message!.text = invocation;
    }
    const env = { DB: db, GROQ_API_KEY: 'synthetic-groq-key', ...(fallback ? { GEMINI_API_KEY: 'synthetic_gemini_test' } : {}) };
    await handleUpdate(update, telegram, new Date(NOW), env, new NluClassifier(), fetcher);
    expect(count()).toBeLessThanOrEqual(50);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(size);
    expect(sql.prepare("SELECT state FROM outbox WHERE type='manual_academic'").get()?.state).toBe('pending');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
    expect(calls.some(call => call.body.chat_id === CHANNEL)).toBe(false);
    expect(calls.at(-1)?.body.text).toContain('بانتظار الإرسال');

    reset();
    await dispatchEventJobs(new EventStore(db), telegram, NOW + 60_000, { limit: 1, types: ['manual_academic'], sleep: async () => {} });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(size);
    expect(calls.filter(call => call.body.chat_id === CHANNEL)).toHaveLength(1);
    reset();
    await handleUpdate(update, telegram, new Date(NOW + 120_000), env, new NluClassifier(), fetcher);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(size);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='manual_academic'").get()?.n).toBe(1);
    expect(calls.filter(call => call.body.chat_id === CHANNEL)).toHaveLength(1);
  });
});
