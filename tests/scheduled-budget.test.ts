import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorker } from '../src/index';
import { emptyEventDraft } from '../src/event-types';

const databases: DatabaseSync[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); });

describe('scheduled publication stays within the free database budget', () => {
  const scenarios = [
    ...['18:45', '18:46', '18:47'].flatMap(time => [false, true].flatMap(fallback =>
      [false, true].map(deletions => ({ at: `2026-10-28T${time}:00+03:00`, fallback, deletions })))),
    ...['2026-10-28T20:30:00+03:00', '2026-10-30T10:00:00+03:00', '2026-10-28T07:00:00+03:00', '2026-10-28T03:00:00+03:00']
      .map(at => ({ at, fallback: true, deletions: true })),
  ];
  it.each(scenarios)('delivers pending work at $at (fallback=$fallback, deletions=$deletions)', async ({ at, fallback, deletions }) => {
    const now = Date.parse(at); vi.spyOn(Date, 'now').mockReturnValue(now);
    const sql = new DatabaseSync(':memory:'); databases.push(sql);
    const directory = resolve(import.meta.dirname, '../migrations');
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(resolve(directory, name), 'utf8'));
    sql.exec('UPDATE settings SET owner_uid=111111111,target_chat_id=-1002222222222,target_thread_id=NULL; UPDATE smart_reminder_config SET enabled=1,generation=1,enabled_at=0');
    for (let index = 0; index < 2; index++) {
      const id = `legacy-${index}`;
      const body = { ...emptyEventDraft(), kind: 'quiz', course: 'graphics', date: '2026-10-29', audience: 'all', details: 'كوز',
        attachment: { kind: 'document', fileId: 'synthetic-file', fileName: 'test.pdf' } };
      sql.prepare(`INSERT INTO events(id,author_id,author_name,source_chat_id,body_json,status,event_date,course,kind,audience,submitted_at,fingerprint,
        published_message_id,published_chat_id,publication_delete_revision) VALUES(?,5,'طالب',-1001111111111,?,?,'2026-10-29','graphics','quiz','all',?,?,?,?,?)`)
        .run(id, JSON.stringify(body), deletions ? 'cancelled' : 'pending', now, id, deletions ? 10 + index : null, deletions ? -1002222222222 : null, deletions ? 1 : null);
      if (deletions) for (let part = 0; part < 2; part++) {
        sql.prepare(`INSERT INTO outbox(id,type,payload_json,due_at,state,message_id,delivered_chat_id) VALUES(?,'publish',?,?,'sent',?,-1002222222222)`)
          .run(`historical-${index}-${part}`, JSON.stringify({ eventId: id, revision: 1, part: 'attachment' }), now - 1000, 20 + index * 2 + part);
      }
    }
    const refs = [];
    for (let index = 0; index < 6; index++) {
      const id = `academic-${index}`;
      const item = { action: 'create', targetId: null, kind: 'quiz', course: 'graphics', date: '2026-10-29', time: null, audience: 'all',
        certainty: 'asserted', component: null, coverage: 'DDA', occurrenceSlots: [], details: `خوارزمية DDA موضوع ${index}`,
        evidence: 'كوز رسومات', courseEvidence: 'رسومات', dateEvidence: 'الخميس', timeEvidence: null, audienceEvidence: 'للكل', occurrenceEvidence: null };
      sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,
        destination_chat_id,last_update_id,created_at,updated_at) VALUES(?,5,'طالب',-1001111111111,1,?,'graphics','quiz','2026-10-29','asserted',-1002222222222,1,?,?)`)
        .run(id, JSON.stringify(item), now, now);
      refs.push({ kind: 'academic', id, revision: 1 });
    }
    sql.prepare("INSERT INTO outbox(id,type,payload_json,due_at) VALUES('manual-test','manual_academic',?,?)")
      .run(JSON.stringify({ version: 1, date: '2026-10-29', chatId: -1002222222222, threadId: null, dueAt: now - 60000,
        expiresAt: now + 30 * 60000, manual: true, refs }), now - 60000);
    let queries = 0;
    const admit = () => { if (++queries > 50) throw Error('Exceeded free database query allowance'); };
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
    let publications = 0;
    const answer = { title: 'تطوير روبوت', summary: 'درس الباحثون روبوتاً ضمن تجربة مختبرية لاختبار الحركة.', why: 'تطبيق الخوارزميات.' };
    const fetcher: typeof fetch = async url => {
      if (String(url).includes('api.groq.com')) return fallback
        ? Response.json({}, { status: 429, headers: { 'retry-after': '60' } })
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }], usage: { total_tokens: 800 } });
      if (String(url).includes('generativelanguage.googleapis.com')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { totalTokenCount: 800 } });
      if (String(url).includes('api.telegram.org')) { publications++; return Response.json({ ok: true, result: { message_id: 100 } }); }
      return new Response(`<rss><item><title>Robotics research</title><link>https://${new URL(String(url)).hostname}/2026/robot</link><description>${'A team studied a laboratory robot. '.repeat(5)}</description><pubDate>${new Date(now).toUTCString()}</pubDate></item></rss>`);
    };
    await createWorker(fetcher).scheduled({} as ScheduledController, { DB: db, TELEGRAM_BOT_TOKEN: '123456:synthetic_token_long_enough',
      WEBHOOK_SECRET_TOKEN: 'synthetic_secret_12345678901234567890', CONTRIBUTIONS_ENABLED: 'true', GROQ_API_KEY: 'synthetic-groq-key',
      ...(fallback ? { GEMINI_API_KEY: 'synthetic_gemini_test' } : {}) });
    expect(queries).toBeLessThanOrEqual(50);
    expect(publications).toBe(1);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(6);
    expect(sql.prepare("SELECT state FROM outbox WHERE id='manual-test'").get()?.state).toBe('sent');
  });
});
