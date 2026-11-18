import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REMINDER_CATALOG, validateReminderCatalog } from '../src/reminder-catalog';
import { assistantRequestFits, type AssistantAiMessage, type AssistantAiOptions } from '../src/assistant-ai';
import { addCalendarDays } from '../src/calendar';
import { buildSmartReminderPlan, eligibleReminderEntries, fetchTrustedCurrentContext, formatReminder,
  getSmartReminderOutgoing, getSmartReminderState, previewSmartReminders, queueSmartReminders,
  reminderSlots, setSmartRemindersEnabled, type ReminderHistory, type SmartReminderPayload } from '../src/smart-reminders';

const DAY = 86_400_000;
const clock = (date: string, time = '00:00'): number => Date.parse(`${date}T${time}:00+03:00`);
const NOW = clock('2026-10-23');
const connections: DatabaseSync[] = [];
function database(): D1Database {
  const sqlite = new DatabaseSync(':memory:'); connections.push(sqlite);
  for (const name of ['0001_contributions.sql','0005_academic_ai.sql','0006_smart_reminders.sql']) sqlite.exec(readFileSync(resolve(import.meta.dirname,'../migrations',name),'utf8'));
  class Prepared {
    constructor(readonly sql: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]): Prepared { return new Prepared(this.sql, values); }
    async first<T>(): Promise<T | null> { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
    async all<T>(): Promise<{ results: T[]; success: boolean }> {
      return { results: sqlite.prepare(this.sql).all(...this.values) as T[], success: true };
    }
    async run(): Promise<{ success: boolean; meta: { changes: number } }> {
      return { success: true, meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } };
    }
  }
  return { prepare: (sql: string) => new Prepared(sql), async batch(statements: Prepared[]) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
}
afterEach(() => { for (const sqlite of connections.splice(0)) sqlite.close(); });

describe('source-backed reminders and bounded AI decisions', () => {
  it('contains 69 checked entries, six Friday choices, explicit sources and separate editorial benefit/action', () => {
    expect(REMINDER_CATALOG).toHaveLength(69);
    expect(validateReminderCatalog()).toEqual([]);
    expect(REMINDER_CATALOG.filter(entry => entry.fridayOnly)).toHaveLength(6);
    for (const entry of REMINDER_CATALOG) {
      const text = formatReminder(entry);
      expect(text.split('\n')).toHaveLength(6);
      expect(text).toContain('مقتطف:'); expect(text).toContain('فائدة:'); expect(text).toContain('تطبيق اختياري:');
      expect(text).toContain(entry.source.url); expect(text.length).toBeLessThan(4096);
    }
  });
  it('uses Baghdad days, Wednesday evening and Friday morning defaults with ±30-minute windows', () => {
    expect(reminderSlots('2026-10-21').map(slot => slot.defaultMinute)).toEqual([420,1230]);
    expect(reminderSlots('2026-10-23').map(slot => slot.defaultMinute)).toEqual([600]);
    expect(reminderSlots('2026-10-24').map(slot => slot.defaultMinute)).toEqual([420]);
    expect(reminderSlots('2026-10-23')[0]).toMatchObject({ friday: true, fromMinute: 600, toMinute: 600 });
  });
  it('simulates a full year without exhaustion, same-hadith repetition within30days, meaning repetition within14days or successive topic repetition', async () => {
    const history: ReminderHistory[] = [];
    for (let day = 0; day < 365; day++) {
      const date = addCalendarDays('2026-10-23', day).date;
      const plan = await buildSmartReminderPlan({}, date, history, clock(date));
      expect(plan.skipped, date).toEqual([]); expect(plan.items, date).toHaveLength(reminderSlots(date).length);
      for (const item of plan.items) {
        expect(item.topic).not.toBe(history.at(-1)?.topic);
        for (const old of history) {
          if (old.hadithKey === item.hadithKey) expect(item.dueAt - old.scheduledAt).toBeGreaterThanOrEqual(30 * DAY);
          if (old.meaningKey === item.meaningKey) expect(item.dueAt - old.scheduledAt).toBeGreaterThanOrEqual(14 * DAY);
        }
        history.push({ ...item, scheduledAt: item.dueAt });
      }
    }
    expect(history).toHaveLength(417);
  });
  it('skips an exhausted catalog and keeps identity cooldowns across edited IDs', () => {
    const slot = reminderSlots('2026-10-24')[0]!;
    const at = clock(slot.date,'07:00');
    const history = REMINDER_CATALOG.map(entry => ({ entryId: 'old-'+entry.id, hadithKey: entry.hadithKey,
      meaningKey: entry.meaningKey, topic: entry.topic, scheduledAt: at-DAY }));
    expect(eligibleReminderEntries(slot, history)).toEqual([]);
  });
  it('rejects invented IDs and unbounded times, and revalidates the second model choice against the actual first', async () => {
    const db = database();
    const entry = REMINDER_CATALOG[0]!;
    const generate = vi.fn(async () => ({ slots: [{ slot: 0,id: entry.id,offsetMinutes: 900 },{ slot: 1,id: entry.id,offsetMinutes: -30 }] }));
    const plan = await buildSmartReminderPlan({ DB: db,GROQ_API_KEY: 'fake-secret-key' },'2026-10-28',[],NOW,{ generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(plan.items[0]).toMatchObject({ entryId: entry.id,dueAt: clock('2026-10-28','07:00') });
    expect(plan.items[1]?.entryId).not.toBe(entry.id);
    expect(plan.items[1]?.dueAt).toBe(clock('2026-10-28','20:30'));
  });
  it('uses only a fetched dated source in slot2 and refuses religious historical claims', async () => {
    const db = database(); const env = { DB: db,GROQ_API_KEY: 'fake-secret-key' };
    const generate = vi.fn(async () => ({ slots: [{ slot: 0,id: 'invented' },{ slot: 1,id: 'news:test',offsetMinutes: 15 }] }));
    const source = { id: 'news:test',kind: 'news' as const,title: 'عنوان منشور من المصدر',url: 'https://www.bbc.com/arabic/articles/example',date: new Date(NOW-60_000).toISOString(),fetchedAt: NOW };
    const plan = await buildSmartReminderPlan(env,'2026-10-23',[],NOW,{ generate,sources: [source] });
    expect(plan.items[0]?.kind).toBe('hadith');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.text).not.toContain(source.url);
    const historyGenerate = vi.fn(async () => ({ slots: [{ slot: 1,id: 'history:test' }] }));
    const rejected = await buildSmartReminderPlan(env,'2026-10-23',[],NOW,{ generate: historyGenerate,sources: [{ ...source,id: 'history:test',kind: 'history',title: 'حدث عن الرسول في تاريخ كذا',url: 'https://ar.wikipedia.org/wiki/example',date: '900-10-23' }] });
    expect(rejected.items.every(item => item.kind === 'hadith')).toBe(true);
  });
  it('keeps the normal-day planner inside the free API minute allowance even with long academic/news context', async () => {
    const db = database();
    const generate = vi.fn(async (_env: unknown, messages: AssistantAiMessage[],_key: string,options?: AssistantAiOptions) => {
      expect(assistantRequestFits(messages, options)).toBe(true);
      const payload = JSON.parse(messages[1]!.content) as { candidates: { choices: unknown[] }[] };
      expect(payload.candidates.every(candidate => candidate.choices.length <= 12)).toBe(true);
      return null;
    });
    const sources = Array.from({ length: 10 },(_,i) => ({ id: `news:${i}`,kind: 'news' as const,title: 'عنوان خبر موثوق '.repeat(15),
      url: `https://www.bbc.com/arabic/articles/${i}`,date: new Date(NOW).toISOString(),fetchedAt: NOW }));
    await buildSmartReminderPlan({ DB: db,GROQ_API_KEY: 'fake-secret-key' },'2026-10-24',[],NOW,{ generate,sources,academic: 'سياق دراسة وامتحان '.repeat(300) });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('fetches bounded official publisher RSS and linked encyclopaedia history, filters stale and unsafe links, and tolerates outages', async () => {
    const rss = `<rss><channel><item><title><![CDATA[خبر <b>مهم</b>]]></title><link>https://www.bbc.com/arabic/articles/test</link><pubDate>${new Date(NOW-60_000).toUTCString()}</pubDate></item><item><title>خبر قديم</title><link>https://www.bbc.com/arabic/articles/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item><item><title>رابط خارجي</title><link>https://evil.example/</link><pubDate>${new Date(NOW).toUTCString()}</pubDate></item></channel></rss>`;
    const fetcher = vi.fn(async (url: unknown) => String(url).includes('bbci.co.uk') ? new Response(rss)
      : new Response(JSON.stringify({ events: [{ year: 1998,text: 'افتتاح مكتبة علمية عامة',pages: [{ content_urls: { desktop: { page: 'https://ar.wikipedia.org/wiki/library' } } }] }] })));
    const results = await fetchTrustedCurrentContext(NOW,fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(results).toHaveLength(2);
    expect(results.map(item => item.kind)).toEqual(['news','history']);
    expect(results[0]?.title).toBe('خبر مهم');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/feed/onthisday/events/10/23'))).toBe(true);
    expect(await fetchTrustedCurrentContext(NOW,(async () => { throw Error('offline'); }) as typeof fetch)).toEqual([]);
  });
  it('uses Worker-compatible manual requests and rejects source redirects without following them', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url,init) => {
      expect(init?.redirect).toBe('manual');
      return new Response('redirected source', { status: 302,headers: { Location: 'https://untrusted.invalid/' } });
    });
    expect(await fetchTrustedCurrentContext(NOW,fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => !String(url).includes('untrusted.invalid'))).toBe(true);
  });
});

describe('persisted plans and delivery snapshots with SQLite', () => {
  it('replaces a pre-upgrade plan without violating non-null queue markers or retaining its old time', async () => {
    const db = database(); const before = clock('2026-10-24','05:00');
    await db.prepare('UPDATE settings SET target_chat_id=-100123 WHERE singleton=1').run();
    await setSmartRemindersEnabled(db,true,before);
    const current = await buildSmartReminderPlan({},'2026-10-24',[],before,{academic:''});
    const {policy:_policy,...legacy} = current;
    legacy.items = legacy.items.map(item => ({...item,dueAt:item.dueAt+17*60_000}));
    await db.prepare('INSERT INTO smart_reminder_plans(local_date,body_json,created_at,queued_generation,queued_destination) VALUES(?,?,?,?,?)')
      .bind('2026-10-24',JSON.stringify(legacy),before,1,'-100123:0').run();
    expect(await queueSmartReminders(db,{},before,{academic:''})).toBe(1);
    const row = await db.prepare('SELECT body_json,queued_generation,queued_destination FROM smart_reminder_plans').first<{body_json:string;queued_generation:number;queued_destination:string}>();
    const plan = JSON.parse(row!.body_json);
    expect(plan.policy).toBe(2);
    expect(plan.items[0].dueAt).toBe(clock('2026-10-24','07:00'));
    expect(row!.queued_generation).toBe(1);
    expect(row!.queued_destination).toBe('-100123:0');
  });
  it('defaults disabled, plans exactly once after activation, persists two deterministic jobs, and retries the original text', async () => {
    const db = database(); const before = clock('2026-10-24','05:00');
    await db.prepare('UPDATE settings SET target_chat_id=-100123,target_thread_id=9 WHERE singleton=1').run();
    expect(await queueSmartReminders(db,{},before)).toBe(0);
    expect((await getSmartReminderState(db,before)).enabled).toBe(false);
    await setSmartRemindersEnabled(db,true,before);
    expect(await queueSmartReminders(db,{},before+60_000,{ sources: [],academic: '' })).toBe(1);
    expect(await queueSmartReminders(db,{},before+120_000)).toBe(0);
    const jobs = await db.prepare("SELECT payload_json FROM outbox WHERE type='smart_reminder' ORDER BY due_at").all<{ payload_json: string }>();
    expect(jobs.results).toHaveLength(1);
    const payload = JSON.parse(jobs.results[0]!.payload_json) as SmartReminderPayload;
    const settings = { targetChatId: -100123,targetThreadId: 9 };
    const outgoing = await getSmartReminderOutgoing(db,payload,settings,payload.dueAt);
    expect(outgoing?.payload).toMatchObject({ text: payload.text,chat_id: -100123,message_thread_id: 9 });
    expect((await getSmartReminderOutgoing(db,payload,settings,payload.dueAt+60_000))?.payload.text).toBe(payload.text);
    expect(await getSmartReminderOutgoing(db,payload,settings,payload.dueAt+31*60_000)).toBeNull();
    expect(await getSmartReminderOutgoing(db,{ ...payload,text: 'tampered' },settings,payload.dueAt)).toBeNull();
    expect(await getSmartReminderOutgoing(db,payload,{ ...settings,targetThreadId: 10 },payload.dueAt)).toBeNull();
    expect(await previewSmartReminders(db,before)).toContain('معاينة:');
    expect((await getSmartReminderState(db,before)).history).toHaveLength(1);
  });
  it('resumes at the next future slot, cancels disabled deliveries, and never resurrects an already sent slot', async () => {
    const db = database(); const before = clock('2026-10-28','05:00');
    await db.prepare('UPDATE settings SET target_chat_id=-100123 WHERE singleton=1').run();
    await setSmartRemindersEnabled(db,true,before); await queueSmartReminders(db,{},before,{ sources: [],academic: '' });
    await db.prepare("UPDATE outbox SET state='sent' WHERE id='smart-reminder:2026-10-28:0'").run();
    await setSmartRemindersEnabled(db,false,clock('2026-10-28','08:00'));
    const payload = JSON.parse((await db.prepare("SELECT payload_json FROM outbox WHERE id='smart-reminder:2026-10-28:1'").first<{ payload_json: string }>())!.payload_json) as SmartReminderPayload;
    expect(await getSmartReminderOutgoing(db,payload,{ targetChatId: -100123,targetThreadId: null },payload.dueAt)).toBeNull();
    await setSmartRemindersEnabled(db,true,clock('2026-10-28','09:00'));
    expect(await queueSmartReminders(db,{},clock('2026-10-28','09:01'))).toBe(1);
    const jobs = await db.prepare('SELECT state FROM outbox ORDER BY id').all<{ state: string }>();
    expect(jobs.results.map(item => item.state)).toEqual(['sent','pending']);
  });
  it('reuses the daily plan at a changed destination and invalidates the old delivery snapshot', async () => {
    const db = database(); const before = clock('2026-10-24','05:00');
    await db.prepare('UPDATE settings SET target_chat_id=-100123 WHERE singleton=1').run();
    await setSmartRemindersEnabled(db,true,before); await queueSmartReminders(db,{},before,{ sources: [],academic: '' });
    const old = JSON.parse((await db.prepare("SELECT payload_json FROM outbox WHERE id='smart-reminder:2026-10-24:0'").first<{ payload_json: string }>())!.payload_json) as SmartReminderPayload;
    await db.prepare('UPDATE settings SET target_chat_id=-100456,target_thread_id=4 WHERE singleton=1').run();
    expect(await queueSmartReminders(db,{},before+60_000)).toBe(1);
    const updated = JSON.parse((await db.prepare("SELECT payload_json FROM outbox WHERE id='smart-reminder:2026-10-24:0'").first<{ payload_json: string }>())!.payload_json) as SmartReminderPayload;
    expect(updated).toMatchObject({ text: old.text,dueAt: old.dueAt,chatId: -100456,threadId: 4 });
    expect(await getSmartReminderOutgoing(db,old,{ targetChatId: -100456,targetThreadId: 4 },old.dueAt)).toBeNull();
    expect(await getSmartReminderOutgoing(db,updated,{ targetChatId: -100456,targetThreadId: 4 },old.dueAt)).not.toBeNull();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>())?.n).toBe(1);
  });
  it('loads current academic metadata once per plan without sending author names or raw private reports to AI', async () => {
    const db = database(); const before = clock('2026-10-24','05:00');
    await db.prepare('UPDATE settings SET target_chat_id=-100123 WHERE singleton=1').run();
    await db.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at)
      VALUES('r1',42,'اسم خاص',42,6,?, 'graphics','quiz','2026-10-24','tentative',-100123,1,?,?)`)
      .bind(JSON.stringify({ time: '10:00',details: 'نص خاص يجب ألا يغادر الخادم' }),before,before).run();
    const generate = vi.fn(async (_env: unknown,messages: AssistantAiMessage[]) => {
      const request = messages.map(message => message.content).join('\n');
      expect(request).toContain('graphics'); expect(request).toContain('tentative'); expect(request).toContain('10:00');
      expect(request).not.toContain('اسم خاص'); expect(request).not.toContain('نص خاص');
      return null;
    });
    const env = { DB: db,GROQ_API_KEY: 'fake-secret-key' };
    await setSmartRemindersEnabled(db,true,before);
    expect(await queueSmartReminders(db,env,before,{ generate,sources: [] })).toBe(1);
    expect(await queueSmartReminders(db,env,before+60_000,{ generate,sources: [] })).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
