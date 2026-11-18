import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assistantRequestFits, generateAssistantJson } from '../src/assistant-ai';
import { DEFAULT_ACADEMIC_ALERT_TIMES, getAcademicAlertTimes, lectureBriefOutgoing, queueLectureBriefs, type LectureBriefPayload } from '../src/academic-alerts';

vi.mock('../src/assistant-ai', async importOriginal => {
  const original = await importOriginal<typeof import('../src/assistant-ai')>();
  return { ...original, generateAssistantJson: vi.fn() };
});
const generate = vi.mocked(generateAssistantJson);
const connections: DatabaseSync[] = [];
const clock = (date: string, time = '00:00'): number => Date.parse(`${date}T${time}:00+03:00`);
function database(): D1Database {
  const sqlite = new DatabaseSync(':memory:'); connections.push(sqlite);
  for (const name of ['0001_contributions.sql', '0005_academic_ai.sql', '0008_academic_alerts.sql']) {
    sqlite.exec(readFileSync(resolve(import.meta.dirname, '../migrations', name), 'utf8'));
  }
  class Prepared {
    constructor(readonly sql: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]): Prepared { return new Prepared(this.sql, values); }
    async first<T>(): Promise<T | null> { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
    async all<T>(): Promise<{ results: T[]; success: boolean }> { return { results: sqlite.prepare(this.sql).all(...this.values) as T[], success: true }; }
    async run(): Promise<{ success: boolean; meta: { changes: number } }> { return { success: true, meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }
  return { prepare: (sql: string) => new Prepared(sql), async batch(statements: Prepared[]) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
}
async function target(db: D1Database): Promise<void> { await db.prepare('UPDATE settings SET target_chat_id=-100123,target_thread_id=8 WHERE singleton=1').run(); }
const settings = { targetChatId: -100123, targetThreadId: 8 };
async function queued(db: D1Database): Promise<LectureBriefPayload> {
  const row = await db.prepare("SELECT payload_json FROM outbox WHERE type='lecture_brief' ORDER BY due_at DESC LIMIT 1").first<{ payload_json: string }>();
  return JSON.parse(row!.payload_json) as LectureBriefPayload;
}
async function lectureChange(db: D1Database, date: string, extra: { thread?: number; certainty?: string; details?: string } = {}): Promise<void> {
  await db.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,kind,event_date,certainty,
    destination_chat_id,destination_thread_id,last_update_id,created_at,updated_at) VALUES(?,1,'طالب <اسم>',-100123,1,?,'lecture_change',?,?,-100123,?,1,1,1)`)
    .bind(`report:${date}:${extra.thread ?? 8}`, JSON.stringify({ details: extra.details ?? 'محاضرة المترجمات يوم الأحد تأجلت للساعة عشرة' }), date,
      extra.certainty ?? 'asserted', extra.thread ?? 8).run();
}
beforeEach(() => { generate.mockReset(); generate.mockResolvedValue(null); });
afterEach(() => { for (const sqlite of connections.splice(0)) sqlite.close(); });

describe('fixed academic timing', () => {
  it('ignores legacy AI plans and does not spend API tokens on choosing fixed times',async()=>{
    const db=database();await target(db);
    generate.mockResolvedValue({morningMinute:400,eveningMinute:1200});
    expect(await getAcademicAlertTimes(db,{DB:db,GROQ_API_KEY:'fake-key'},clock('2026-10-25'))).toEqual({morningMinute:960,eveningMinute:1080});
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('official lecture briefs and dated student exceptions', () => {
  it('queues once at the chosen morning time with no early/stale sends and preserves actual teachers/courses/groups/labs', async () => {
    const db = database(); await target(db); const now = clock('2026-10-24', '16:00');
    const times = { morningMinute: 405, eveningMinute: 1140 };
    expect(await queueLectureBriefs(db, now - 1, times)).toBe(0);
    expect(await queueLectureBriefs(db, now, times)).toBe(1);
    expect(await queueLectureBriefs(db, now + 60_000, times)).toBe(0);
    const payload = await queued(db);
    expect(payload).toMatchObject({ date: '2026-10-25', localDate: '2026-10-24', slot: 'evening', chatId: -100123, threadId: 8, dueAt: now });
    const outgoing = await lectureBriefOutgoing(db, payload, settings, now);
    expect(outgoing?.method).toBe('sendMessage'); expect(outgoing?.payload.message_thread_id).toBe(8);
    const text = String(outgoing?.payload.text);
    expect(text).toContain('محاضرات باچر'); expect(text).toContain('معمارية الحاسبة (نظري)'); expect(text).toContain('د. مصطفى معد');
    expect(text).toContain('د. احمد صبحي + مبرمج خبيب باسم'); expect(text).toContain('مجموعة A'); expect(text).toContain('م1');
    expect(text).toContain('مؤقتة وتقديرية'); expect(text).toContain('متزامنتان'); expect(text.length).toBeLessThan(4096);
    expect(await lectureBriefOutgoing(db, payload, settings, now - 1)).toBeNull();
    expect(await lectureBriefOutgoing(db, payload, settings, now + 30 * 60_000)).not.toBeNull();
    expect(await lectureBriefOutgoing(db, payload, settings, now + 30 * 60_000 + 1)).toBeNull();
    expect(await queueLectureBriefs(db, now + 31 * 60_000, times)).toBe(0);
  });
  it('uses Baghdad tomorrow for the evening, skips empty official days, and makes no DB reads outside active windows', async () => {
    const db = database(); await target(db);
    let reads = 0; const counted = { ...db, prepare: (sql: string) => { reads++; return db.prepare(sql); } } as D1Database;
    expect(await queueLectureBriefs(counted, clock('2026-10-24', '12:00'))).toBe(0); expect(reads).toBe(0);
    expect(await queueLectureBriefs(db, clock('2026-10-24', '07:30'))).toBe(0);
    expect(await queueLectureBriefs(db, clock('2026-10-24', '16:00'))).toBe(1);
    const payload = await queued(db); expect(payload).toMatchObject({ date: '2026-10-25', slot: 'evening' });
    const outgoing = await lectureBriefOutgoing(db, payload, settings, clock('2026-10-24', '16:00'));
    expect(outgoing?.payload.text).toContain('محاضرات باچر'); expect(outgoing?.payload.text).toContain('الأحد');
    expect(await queueLectureBriefs(db, clock('2026-10-29', '16:00'))).toBe(0);
  });
  it('appends dated same-destination student changes, marks tentative statements, escapes text and removes cancelled changes before delivery', async () => {
    const db = database(); await target(db); const now = clock('2026-10-24', '16:00');
    await lectureChange(db, '2026-10-25', { certainty: 'tentative', details: 'يجوز تتأجل محاضرة المترجمات <كلام الطالب>' });
    await lectureChange(db, '2026-10-25', { thread: 9, details: 'تبليغ بموضوع ثاني' });
    await lectureChange(db, '2026-10-26', { details: 'تبليغ لتاريخ ثاني' });
    await queueLectureBriefs(db, now); const payload = await queued(db);
    const text = String((await lectureBriefOutgoing(db, payload, settings, now))?.payload.text);
    expect(text).toContain('حسب الجدول الأسبوعي المعتمد'); expect(text).toContain('تبليغات طلاب'); expect(text).toContain('احتمال/غير مؤكد');
    expect(text).toContain('طالب &lt;اسم&gt;'); expect(text).toContain('&lt;كلام الطالب&gt;'); expect(text).not.toContain('تبليغ بموضوع ثاني'); expect(text).not.toContain('تبليغ لتاريخ ثاني');
    await db.prepare("UPDATE academic_reports SET state='cancelled' WHERE id='report:2026-10-25:8'").run();
    expect((await lectureBriefOutgoing(db, payload, settings, now))?.payload.text).not.toContain('يجوز تتأجل');
  });
  it('can notify an explicit dated lecture report on an empty official day without inventing regular classes', async () => {
    const db = database(); await target(db); const now = clock('2026-10-22', '16:00');
    await lectureChange(db, '2026-10-23', { details: 'اليوم محاضرة تعويضية للرسومات الساعة عشرة' });
    expect(await queueLectureBriefs(db, now)).toBe(1);
    const text = String((await lectureBriefOutgoing(db, await queued(db), settings, now))?.payload.text);
    expect(text).toContain('لا توجد محاضرات في الجدول الأسبوعي'); expect(text).toContain('محاضرة تعويضية للرسومات'); expect(text).toContain('حسب تبليغ الطالب');
  });
  it('invalidates old destination snapshots and never creates a third brief after a successful send', async () => {
    const db = database(); await target(db); const now = clock('2026-10-24', '16:00');
    await queueLectureBriefs(db, now); const old = await queued(db);
    await db.prepare('UPDATE settings SET target_chat_id=-100456,target_thread_id=9 WHERE singleton=1').run();
    const updatedSettings = { targetChatId: -100456, targetThreadId: 9 };
    expect(await lectureBriefOutgoing(db, old, updatedSettings, now)).toBeNull();
    expect(await queueLectureBriefs(db, now + 60_000)).toBe(1);
    const updated = await queued(db); expect(updated.chatId).toBe(-100456);
    expect(await lectureBriefOutgoing(db, updated, updatedSettings, now)).not.toBeNull();
    await db.prepare("UPDATE outbox SET state='sent' WHERE type='lecture_brief'").run();
    await db.prepare('UPDATE settings SET target_chat_id=-100789 WHERE singleton=1').run();
    expect(await queueLectureBriefs(db, now + 120_000)).toBe(0);
    expect(await queueLectureBriefs(db, clock('2026-10-25', '16:00'))).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='lecture_brief'").first<{ n: number }>())?.n).toBe(2);
  });
  it('bounds long student notices within Telegram HTML size without losing the regular timetable', async () => {
    const db = database(); await target(db); const now = clock('2026-10-24', '16:00');
    await lectureChange(db, '2026-10-25', { details: '<&>'.repeat(4000) });
    await queueLectureBriefs(db, now);
    const text = String((await lectureBriefOutgoing(db, await queued(db), settings, now))?.payload.text);
    expect(text).toContain('معمارية الحاسبة'); expect(text.length).toBeLessThan(4096); expect(text).not.toContain('<&>'); expect(text).toContain('…');
  });
});
