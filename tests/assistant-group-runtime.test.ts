import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';
import type { AcademicItem } from '../src/academic-ai';

const TOKEN = `123456789:${'synthetic'.repeat(5)}`;
const SECRET = 'synthetic-group-runtime-webhook-secret-0123456789';
const ANSWER = 'هلا بيك، آني بخير. شلونك إنت؟';

/** Full webhook -> routing -> actual D1 -> provider -> outbox -> Telegram path.
 * All external calls are intercepted; no real bot, user data or messages. */
describe('addressed group chat in the actual Worker runtime', () => {
  let mf: Miniflare; let db: D1Database;
  let modelAnswer: unknown;
  const calls: { host: string; method: string; payload: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
      import { createWorker } from './src/index';
      const worker = createWorker();
      export default { async fetch(request, env) {
        let queries = 0;
        const admit = (count = 1) => { queries += count; if (queries > 50) throw new Error('Synthetic free-plan D1 query limit exceeded.'); };
        const wrap = statement => ({
          raw: statement,
          bind(...values) { return wrap(statement.bind(...values)); },
          async first(...args) { admit(); return statement.first(...args); },
          async all(...args) { admit(); return statement.all(...args); },
          async run(...args) { admit(); return statement.run(...args); }
        });
        const DB = { prepare(sql) { return wrap(env.DB.prepare(sql)); },
          async batch(statements) { admit(statements.length); return env.DB.batch(statements.map(statement => statement.raw)); } };
        const response = await worker.fetch(request, { ...env, DB });
        const headers = new Headers(response.headers); headers.set('X-Synthetic-D1-Queries', String(queries));
        return new Response(response.body, { status: response.status, headers });
      } };
    ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-13',
      script: bundle.outputFiles[0]!.text, d1Databases: { DB: 'assistant-group-runtime-test' },
      bindings: { TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET_TOKEN: SECRET, GROQ_API_KEY: 'groq-runtime-synthetic-key', CONTRIBUTIONS_ENABLED: 'true' },
      outboundService: async request => {
        const url = new URL(request.url);
        const payload = await request.json() as Record<string, unknown>;
        const method = url.pathname.split('/').at(-1)!;
        calls.push({ host: url.hostname, method, payload });
        if (url.hostname === 'api.groq.com') return RuntimeResponse.json({ choices: [{ finish_reason: 'stop',
          message: { content: JSON.stringify(modelAnswer) } }], usage: { total_tokens: 200 } });
        if (url.hostname !== 'api.telegram.org') throw new Error('Unexpected external target.');
        return RuntimeResponse.json({ ok: true, result: method === 'getMe'
          ? { id: 202, is_bot: true, username: 'daaboolbot', can_read_all_group_messages: false, supports_inline_queries: true }
          : method === 'sendMessage' ? { message_id: 900 + calls.length } : true });
      },
    }));
    db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of (await readdir(resolve(root, 'migrations'))).filter(value => value.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(root, 'migrations', name), 'utf8');
      for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
    await db.prepare('UPDATE settings SET owner_uid=101,target_chat_id=-100123,target_thread_id=NULL WHERE singleton=1').run();
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => {
    calls.length = 0;
    modelAnswer = { reply: ANSWER, needsAcademicAnalysis: false };
    await db.batch(['assistant_ai_requests', 'assistant_ai_usage', 'assistant_turns', 'assistant_user_limits',
      'assistant_inline_limits', 'academic_report_changes', 'academic_reports', 'academic_intakes',
      'outbox', 'delivery_slots'].map(table => db.prepare(`DELETE FROM ${table}`)));
  });
  function message(updateId: number, text: string, entities?: { type: string; offset: number; length: number }[]) {
    return { update_id: updateId, message: { message_id: updateId + 100, date: Math.floor(Date.now() / 1000),
      from: { id: 101, is_bot: false, first_name: 'طالب اختبار' }, chat: { id: -100123, type: 'supergroup' }, text,
      ...(entities ? { entities } : {}) } };
  }
  async function post(update: unknown) {
    return mf.dispatchFetch('https://runtime.test/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(update) });
  }
  it('answers the exact reported @mention if Telegram delivers it, within the 50-query limit', async () => {
    const response = await post(message(1, '@daaboolbot ها دعبول شلونك ؟', [{ type: 'mention', offset: 0, length: 11 }]));
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('X-Synthetic-D1-Queries'))).toBeLessThanOrEqual(50);
    const sent = calls.filter(value => value.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ chat_id: -100123, text: ANSWER, reply_parameters: { message_id: 101 } });
    expect(calls.filter(value => value.host === 'api.groq.com')).toHaveLength(1);
    expect((await db.prepare('SELECT state,question FROM assistant_turns').first<{ state: string; question: string }>())!)
      .toEqual({ state: 'ready', question: 'ها دعبول شلونك ؟' });
    expect((await db.prepare("SELECT state FROM outbox WHERE type='assistant_reply'").first<{ state: string }>())!.state).toBe('sent');
  });
  it('recognizes case-insensitive mention text when an update has no entities', async () => {
    const response = await post(message(2, '@DaaboolBot ها دعبول شلونك ؟'));
    expect(response.status).toBe(200);
    expect(calls.find(value => value.method === 'sendMessage')!.payload.text).toBe(ANSWER);
  });
  it('uses Telegram UTF-16 offsets correctly after emoji', async () => {
    const response = await post(message(3, '🔥 @daaboolbot شلونك ؟', [{ type: 'mention', offset: 3, length: 11 }]));
    expect(response.status).toBe(200);
    expect(calls.find(value => value.method === 'sendMessage')!.payload.text).toBe(ANSWER);
  });
  it('keeps an unrelated bot mention silent without calling the AI or touching D1', async () => {
    const response = await post(message(4, '@otherbot ها دعبول شلونك ؟', [{ type: 'mention', offset: 0, length: 9 }]));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Synthetic-D1-Queries')).toBe('0');
    expect(calls.filter(value => value.host === 'api.groq.com' || value.method === 'sendMessage')).toHaveLength(0);
  });
  it('retries a busy free minute without completing the announcement or charging its author twice', async () => {
    const now = Date.now();
    const sourceNow = Date.parse('2026-10-24T11:32:10Z');
    const text = 'اريد تثبت عدنا هذا الاسبوع كوز معماريه محتمل بالاحد وكوز برمجة مرئية يوم الاثنين وكوز رسومات عملي ب DDA';
    const clauses = ['كوز معماريه محتمل بالاحد', 'كوز برمجة مرئية يوم الاثنين', 'كوز رسومات عملي ب DDA'];
    const item = (overrides: Partial<AcademicItem>): AcademicItem => ({ action: 'create', targetId: null, kind: 'quiz',
      course: 'graphics', courseEvidence: 'رسومات', component: null, date: null, dateEvidence: null,
      time: null, timeEvidence: null, audience: null, audienceEvidence: null, certainty: 'asserted',
      coverage: '', occurrenceSlots: [], occurrenceEvidence: null, details: 'رسومات', evidence: 'رسومات', ...overrides });
    modelAnswer = { intent: 'academic', reply: '', clarification: null, items: [
      item({ course: 'architecture', courseEvidence: 'معماريه', date: '2026-10-25', dateEvidence: 'الاحد',
        certainty: 'tentative', details: clauses[0]!, evidence: clauses[0]! }),
      item({ course: 'visual', courseEvidence: 'برمجة مرئية', date: '2026-10-26', dateEvidence: 'الاثنين',
        details: clauses[1]!, evidence: clauses[1]! }),
      item({ component: 'practical', coverage: 'DDA', details: clauses[2]!, evidence: clauses[2]! }),
    ] };
    await db.prepare(`INSERT INTO assistant_ai_usage(provider,day_start,minute_start,day_requests,minute_requests,day_tokens,minute_tokens)
      VALUES('groq',?,?,4,4,4000,4000)`).bind(Math.floor(now / 86_400_000), Math.floor(now / 60_000)).run();
    const update = message(5, `@daaboolbot ${text}`, [{ type: 'mention', offset: 0, length: 11 }]);
    update.message.date = sourceNow / 1000;

    const busy = await post(update);
    expect(busy.status).toBe(503);
    expect(Number(busy.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(busy.headers.get('X-Synthetic-D1-Queries'))).toBeLessThanOrEqual(50);
    expect(await db.prepare('SELECT state,user_admitted FROM assistant_turns').first()).toMatchObject({ state: 'processing', user_admitted: 1 });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n).toBe(0);
    expect(calls.filter(value => value.host === 'api.groq.com')).toHaveLength(0);
    expect(calls.filter(value => value.method === 'sendMessage')).toHaveLength(1);
    expect(calls.find(value => value.method === 'sendMessage')!.payload.text).toContain('قيد المعالجة');

    // Simulate the end of this provider minute and its retry cache lease.
    await db.batch([
      db.prepare("UPDATE assistant_ai_usage SET minute_start=0,minute_requests=0,minute_tokens=0 WHERE provider='groq'"),
      db.prepare("UPDATE assistant_ai_requests SET expires_at=0 WHERE state='error'"),
    ]);
    const retried = await post(update);
    expect(retried.status).toBe(200);
    expect(Number(retried.headers.get('X-Synthetic-D1-Queries'))).toBeLessThanOrEqual(50);
    const reports = (await db.prepare('SELECT body_json,created_at FROM academic_reports ORDER BY id')
      .all<{ body_json: string; created_at: number }>()).results;
    expect(reports).toHaveLength(3);
    const items = reports.map(row => JSON.parse(row.body_json) as AcademicItem);
    expect(items[0]).toMatchObject({ course: 'architecture', date: '2026-10-25', certainty: 'tentative' });
    expect(items[1]).toMatchObject({ course: 'visual', date: '2026-10-26' });
    expect(items[2]).toMatchObject({ course: 'graphics', component: 'practical', date: null, coverage: 'DDA' });
    expect(reports.every(row => row.created_at === sourceNow)).toBe(true);
    expect((await db.prepare('SELECT requests FROM assistant_user_limits WHERE user_id=101').first<{ requests: number }>())!.requests).toBe(1);
    expect((await db.prepare('SELECT state FROM assistant_turns').first<{ state: string }>())!.state).toBe('ready');
    expect(calls.filter(value => value.host === 'api.groq.com')).toHaveLength(1);
    const completedCalls = calls.length;
    expect((await post(update)).status).toBe(200);
    expect(calls).toHaveLength(completedCalls);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n).toBe(3);
  });
});
