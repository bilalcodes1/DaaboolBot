import { dailyPublicationOutgoing } from '../src/daily-publications';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { academicAnalysisPrompt, academicReportOutgoing, applyAcademicAnalysis, formatAcademicReport, getAcademicContext,
  getAcademicReport, listAcademicReports, parseAcademicAnalysis, queueAcademicReportReminders, readAcademicReports, undoAcademicReport,
  type AcademicAnalysis, type AcademicItem, type AcademicSource } from '../src/academic-ai';
import { EventStore } from '../src/event-store';
import { emptyEventDraft } from '../src/event-types';
import { getInlineAcademicAnswer } from '../src/inline-academic';

const NOW = new Date('2026-10-23T09:00:00Z');
const EXAMPLE = 'رسومات عملي تريد مناقشة كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج و بالخميس كوز بالمحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها كالت يمكن تجيبه mcq،و المعمارية نفسه ما تكوزنه يجوز يكوزنه الأحد';
function item(overrides: Partial<AcademicItem> = {}): AcademicItem {
  return { action: 'create', targetId: null, kind: 'quiz', course: 'graphics', courseEvidence: 'رسومات', component: null,
    date: '2026-10-29', dateEvidence: 'الخميس', time: null, timeEvidence: null, audience: null, audienceEvidence: null,
    certainty: 'asserted', coverage: '', occurrenceSlots: [], occurrenceEvidence: null,
    details: 'كوز رسومات الخميس', evidence: 'كوز رسومات الخميس', ...overrides };
}
function analysis(items: AcademicItem[], overrides: Partial<AcademicAnalysis> = {}): AcademicAnalysis {
  return { intent: 'academic', reply: '', clarification: null, items, ...overrides };
}
function exampleAnalysis(): AcademicAnalysis {
  const first = 'رسومات عملي تريد مناقشة كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج';
  const second = 'بالخميس كوز بالمحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها كالت يمكن تجيبه mcq';
  const third = 'المعمارية نفسه ما تكوزنه يجوز يكوزنه الأحد';
  return analysis([
    item({ kind: 'discussion', courseEvidence: 'رسومات عملي', component: 'practical', date: null, dateEvidence: null,
      coverage: 'كود خوارزمية DDA', details: first, evidence: first }),
    item({ courseEvidence: 'رسومات عملي', component: 'practical', coverage: 'المحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها', details: second, evidence: second }),
    item({ course: 'architecture', courseEvidence: 'المعمارية', date: '2026-10-25', dateEvidence: 'الأحد', certainty: 'tentative', details: third, evidence: third }),
  ], { clarification: 'المناقشة بأي يوم، وهاي لأي مجموعة؟' });
}
function source(updateId = 1, text = 'كوز رسومات الخميس', userId = 101): AcademicSource {
  return { updateId, userId, userName: `طالب ${userId}`, chatId: -100111, threadId: null, messageId: updateId,
    text, now: NOW.getTime() + updateId * 1000 };
}

describe('academic AI evidence validation', () => {
  it('keeps the exact messy example as three separate grounded reports', () => {
    const value = parseAcademicAnalysis({ choices: [{ message: { content: JSON.stringify(exampleAnalysis()) } }] }, EXAMPLE, NOW)!;
    expect(value.items).toHaveLength(3);
    expect(value.items[0]).toMatchObject({ kind: 'discussion', course: 'graphics', component: 'practical', date: null, audience: null });
    expect(value.items[1]).toMatchObject({ date: '2026-10-29', occurrenceSlots: [], certainty: 'asserted' });
    expect(value.items[1]!.coverage).toContain('2 و3');
    expect(value.items[2]).toMatchObject({ date: '2026-10-25', certainty: 'tentative' });
  });
  it('forces a possibility of a quiz to tentative, independently of model confidence', () => {
    const value = exampleAnalysis(); value.items[2]!.certainty = 'asserted';
    expect(parseAcademicAnalysis(value, EXAMPLE, NOW)!.items[2]!.certainty).toBe('tentative');
  });
  it('keeps the screenshot announcement as three items and limits uncertainty to architecture', () => {
    const text = 'اريد تثبت عدنا هذا الاسبوع كوز معماريه محتمل بالاحد وكوز برمجة مرئية يوم الاثنين وكوز رسومات عملي ب DDA';
    const first = 'كوز معماريه محتمل بالاحد';
    const second = 'كوز برمجة مرئية يوم الاثنين';
    const third = 'كوز رسومات عملي ب DDA';
    const value = parseAcademicAnalysis(analysis([
      item({ course: 'architecture', courseEvidence: 'معماريه', date: '2026-10-25', dateEvidence: 'الاحد', details: first, evidence: first }),
      item({ course: 'visual', courseEvidence: 'برمجة مرئية', date: '2026-10-26', dateEvidence: 'الاثنين', details: second, evidence: second }),
      item({ component: 'practical', date: null, dateEvidence: null, coverage: 'DDA', details: third, evidence: third }),
    ]), text, new Date('2026-10-24T11:32:10Z'))!;
    expect(value.items).toHaveLength(3);
    expect(value.items[0]).toMatchObject({ course: 'architecture', certainty: 'tentative', date: '2026-10-25' });
    expect(value.items[1]).toMatchObject({ course: 'visual', certainty: 'asserted', date: '2026-10-26' });
    expect(value.items[2]).toMatchObject({ course: 'graphics', certainty: 'asserted', date: null, component: 'practical', coverage: 'DDA' });
  });
  it.each([
    'محتمل كوز رسومات الخميس',
    'مُحْتَمَل كوز رسومات الخميس',
    'كوز رسومات محتمل بالخميس',
    'وكوز رسومات محتمل بالخميس',
    'كوز رسومات احتمال بالخميس',
    'كوز رسومات الخميس غير مؤكد',
    'كوز رسومات الخميس غير مُؤَكَّد',
  ])('preserves explicit assessment uncertainty in %s', text => {
    const value = parseAcademicAnalysis(analysis([item({ details: text, evidence: text })]), text, NOW)!;
    expect(value.items[0]!.certainty).toBe('tentative');
  });
  it('does not treat the possibility of MCQ format as uncertainty about the quiz', () => {
    expect(parseAcademicAnalysis(exampleAnalysis(), EXAMPLE, NOW)!.items[1]!.certainty).toBe('asserted');
  });
  it.each([
    'كوز رسومات الخميس محتمل يجي MCQ',
    'كوز رسومات الخميس محتمل تكون اسئلته mcq',
    'كوز رسومات الخميس غير مؤكد اذا MCQ',
    'كوز رسومات الخميس محتمل يكون اختيار متعدد',
  ])('keeps uncertainty about question format separate in %s', text => {
    const value = parseAcademicAnalysis(analysis([item({ details: text, evidence: text })]), text, NOW)!;
    expect(value.items[0]!.certainty).toBe('asserted');
  });
  it('rejects fabricated source details, dates, courses, audience, and time', () => {
    const changes: Partial<AcademicItem>[] = [
      { details: 'المادة كلها داخلة' }, { date: '2026-10-30' }, { course: 'mobile' },
      { audience: 'all', audienceEvidence: 'كوز' }, { time: '08:30', timeEvidence: 'الخميس' },
    ];
    for (const change of changes) expect(parseAcademicAnalysis(analysis([item(change)]), 'كوز رسومات الخميس', NOW)).toBeNull();
  });
  it('rejects coverage lecture numbers being put into occurrence slots', () => {
    const value = exampleAnalysis(); value.items[1]!.occurrenceSlots = [2, 3]; value.items[1]!.occurrenceEvidence = 'بالمحاضرة 2 و3';
    expect(parseAcademicAnalysis(value, EXAMPLE, NOW)).toBeNull();
  });
  it('accepts an explicitly supplied occurrence time, slots and audience', () => {
    const text = 'كوز رسومات الخميس وقت المحاضرة الثانية الساعة 8 صباحاً مجموعة A';
    const value = analysis([item({ details: text, evidence: text, time: '08:00', timeEvidence: 'الساعة 8 صباحاً',
      audience: 'A', audienceEvidence: 'مجموعة A', occurrenceSlots: [2], occurrenceEvidence: 'وقت المحاضرة الثانية' })]);
    expect(parseAcademicAnalysis(value, text, NOW)).not.toBeNull();
  });
  it('does not accept not-yet-quizzed as a cancellation command', () => {
    const text = 'المعمارية ما تكوزنه';
    expect(parseAcademicAnalysis(analysis([item({ action: 'cancel', course: 'architecture', courseEvidence: 'المعمارية',
      date: null, dateEvidence: null, details: text, evidence: text })]), text, NOW)).toBeNull();
  });
  it('supports ordinary conversation without creating academic records', () => {
    expect(parseAcademicAnalysis(analysis([], { intent: 'chat', reply: 'هلا بيك' }), 'هلا', NOW)).toMatchObject({ intent: 'chat', items: [] });
    expect(parseAcademicAnalysis(analysis([item()], { intent: 'lookup' }), 'كوز رسومات الخميس', NOW)).toBeNull();
  });
  it('rejects excessive batches and extra fields', () => {
    expect(parseAcademicAnalysis(analysis(Array.from({ length: 7 }, () => item())), 'كوز رسومات الخميس', NOW)).toBeNull();
    expect(parseAcademicAnalysis({ ...analysis([]), trusted: true }, '', NOW)).toBeNull();
  });
  it('uses the supplied Baghdad clock and explains source/coverage constraints', () => {
    expect(academicAnalysisPrompt(NOW)).toContain('2026-10-23');
    expect(academicAnalysisPrompt(NOW)).toContain('lecture_change');
    expect(academicAnalysisPrompt(NOW)).toContain('not daily slots');
  });
  it('does not invent an event type that has no evidence in its own clause', () => {
    const value = exampleAnalysis(); value.items[0]!.kind = 'quiz';
    expect(parseAcademicAnalysis(value, EXAMPLE, NOW)).toBeNull();
  });
});

describe('academic intake persistence and publication using local D1', () => {
  let mf: Miniflare; let db: D1Database;
  beforeAll(async () => {
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-13',
      script: 'export default { fetch() { return new Response("local only"); } }', d1Databases: { DB: 'academic-ai-test' } }));
    db = await mf.getD1Database('DB') as unknown as D1Database;
    for (const name of ['0001_contributions.sql', '0002_publication_destinations.sql', '0003_delivery_cleanup.sql', '0005_academic_ai.sql','0006_smart_reminders.sql','0010_natural_daily.sql','0012_academic_duplicates.sql']) {
      const sql = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../migrations', name), 'utf8');
      for (const statement of sql.split(';').map(text => text.trim()).filter(Boolean)) await db.prepare(statement).run();
    }
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => {
    await db.batch(['academic_report_changes', 'academic_reports', 'academic_intakes', 'outbox', 'events'].map(table => db.prepare(`DELETE FROM ${table}`)));
    await db.prepare('UPDATE settings SET owner_uid=999,target_chat_id=-100222,target_thread_id=7 WHERE singleton=1').run();
  });
  async function payload(id: string): Promise<unknown> {
    const row = await db.prepare('SELECT payload_json FROM outbox WHERE id=?').bind(id).first<{ payload_json: string }>();
    return row ? JSON.parse(row.payload_json) : null;
  }
  it('automatically saves all example items without owner/name forms and preserves original source', async () => {
    const value = parseAcademicAnalysis(exampleAnalysis(), EXAMPLE, NOW)!;
    const result = await applyAcademicAnalysis(db, source(1, EXAMPLE), value);
    expect(result.reportIds).toHaveLength(3);
    const reports = await readAcademicReports(db, 'تبليغات', NOW);
    expect(reports).toHaveLength(3);
    expect(reports.find(value => value.item.kind === 'discussion')!.item.date).toBeNull();
    expect(reports.find(value => value.item.course === 'architecture')!.item.certainty).toBe('tentative');
    expect(result.text).not.toContain('معتمدة');
    expect(result.text).toContain('احتمال');
    expect(result.text).not.toMatch(/ar-1-[0-5]/u);
    expect((await db.prepare('SELECT source_text FROM academic_intakes').first<{ source_text: string }>())!.source_text).toBe(EXAMPLE);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>())!.n).toBe(0);
  });
  it('repeated and parallel delivery of one source creates only one batch and publication job', async () => {
    const initial = source();
    const values = await Promise.all([applyAcademicAnalysis(db, initial, analysis([item()])), applyAcademicAnalysis(db, initial, analysis([item()]))]);
    expect(values[0]).toEqual(values[1]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>())!.n).toBe(0);
  });
  it('publishes to the saved destination and cancels queued work when it changes', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    const job = { payload: await payload('academic-report:ar-1-0:1') };
    const outgoing = await academicReportOutgoing(db, job, NOW.getTime() + 2000);
    expect(outgoing).toBeNull(); // Saving alone no longer publishes.
    await db.prepare('UPDATE settings SET target_chat_id=-100333 WHERE singleton=1').run();
    expect(await academicReportOutgoing(db, job, NOW.getTime() + 2000)).toBeNull();
  });
  it('updates only the author, retains prior fields, and invalidates an older publication revision', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    const oldJob = { payload: await payload('academic-report:ar-1-0:1') };
    const text = 'عدل كوز رسومات صار الأحد';
    await applyAcademicAnalysis(db, source(2, text), analysis([item({ action: 'update', targetId: 'ar-1-0', date: '2026-10-25', dateEvidence: 'الأحد', details: text, evidence: text })]));
    const value = (await getAcademicReport(db, 'ar-1-0'))!;
    expect(value).toMatchObject({ revision: 2, authorId: 101, item: { date: '2026-10-25', audience: null } });
    expect(value.item.details).toContain('كوز رسومات الخميس');
    expect(await academicReportOutgoing(db, oldJob, NOW.getTime() + 3000)).toBeNull();
    expect(await academicReportOutgoing(db, { payload: await payload('academic-report:ar-1-0:2') }, NOW.getTime() + 3000)).toBeNull();
  });
  it('stores another student correction as a separate conflicting report', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    const text = 'عدل كوز رسومات صار الأحد';
    const result = await applyAcademicAnalysis(db, source(2, text, 202), analysis([item({ action: 'update', targetId: 'ar-1-0', date: '2026-10-25', dateEvidence: 'الأحد', details: text, evidence: text })]));
    expect((await getAcademicReport(db, 'ar-1-0'))!.revision).toBe(1);
    expect((await getAcademicReport(db, result.reportIds[0]!))!.conflicts).toEqual(['ar-1-0']);
    expect(result.text).toContain('قد تختلف');
  });
  it('refuses foreign cancellation but allows owner management without review', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    const cancellation = item({ action: 'cancel', targetId: 'ar-1-0', details: 'الغي كوز رسومات', evidence: 'الغي كوز رسومات' });
    const rejected = await applyAcademicAnalysis(db, source(2, 'الغي كوز رسومات', 202), analysis([cancellation]));
    expect(rejected.reportIds).toEqual([]); expect(rejected.text).not.toContain('حفظت');
    expect((await getAcademicReport(db, 'ar-1-0'))!.state).toBe('active');
    await applyAcademicAnalysis(db, source(3, 'الغي كوز رسومات', 999), analysis([cancellation]));
    expect((await getAcademicReport(db, 'ar-1-0'))!.state).toBe('cancelled');
    expect(await readAcademicReports(db, 'تبليغات', NOW)).toHaveLength(0);
  });
  it('asks for an ambiguous update target instead of changing every matching event', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    await applyAcademicAnalysis(db, source(2, 'كوز رسومات الأحد'), analysis([item({ date: '2026-10-25', dateEvidence: 'الأحد', details: 'كوز رسومات الأحد', evidence: 'كوز رسومات الأحد' })]));
    const result = await applyAcademicAnalysis(db, source(3, 'عدل كوز رسومات'), analysis([item({ action: 'update', date: null, dateEvidence: null, details: 'عدل كوز رسومات', evidence: 'عدل كوز رسومات' })]));
    expect(result.reportIds).toEqual([]); expect(result.text).toContain('أي تبليغ');
    expect((await getAcademicReport(db, 'ar-1-0'))!.revision).toBe(1);
  });
  it('supports author undo with audit history and denies other students', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    await applyAcademicAnalysis(db, source(2, 'عدل كوز رسومات صار الأحد'), analysis([item({ action: 'update', targetId: 'ar-1-0', date: '2026-10-25', dateEvidence: 'الأحد', details: 'عدل كوز رسومات صار الأحد', evidence: 'عدل كوز رسومات صار الأحد' })]));
    expect((await undoAcademicReport(db, 'ar-1-0', 202, 999, NOW.getTime() + 3000)).reportId).toBeUndefined();
    await undoAcademicReport(db, 'ar-1-0', 101, 999, NOW.getTime() + 4000);
    expect((await getAcademicReport(db, 'ar-1-0'))!).toMatchObject({ revision: 3, state: 'active', item: { date: '2026-10-29' } });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').first<{ n: number }>())!.n).toBe(3);
  });
  it('rejects an old undo card and treats a repeated callback update as the same undo', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    await applyAcademicAnalysis(db, source(2, 'عدل كوز رسومات صار الأحد'), analysis([item({ action: 'update', targetId: 'ar-1-0', date: '2026-10-25', dateEvidence: 'الأحد', details: 'عدل كوز رسومات صار الأحد', evidence: 'عدل كوز رسومات صار الأحد' })]));
    const oldCard = await undoAcademicReport(db, 'ar-1-0', 101, 999, NOW.getTime() + 3000, 3, 1);
    expect(oldCard.reportId).toBeUndefined(); expect(oldCard.text).toContain('نسخة قديمة');
    expect((await getAcademicReport(db, 'ar-1-0'))!).toMatchObject({ revision: 2, item: { date: '2026-10-25' } });
    expect((await undoAcademicReport(db, 'ar-1-0', 101, 999, NOW.getTime() + 4000, 4, 2)).reportId).toBe('ar-1-0');
    const replay = await undoAcademicReport(db, 'ar-1-0', 101, 999, NOW.getTime() + 5000, 4, 2);
    expect(replay.reportId).toBe('ar-1-0');
    expect((await getAcademicReport(db, 'ar-1-0'))!).toMatchObject({ revision: 3, item: { date: '2026-10-29' } });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').first<{ n: number }>())!.n).toBe(3);
  });
  it('uses the first accepted extraction for concurrent replays and rejects chat mutations before writes', async () => {
    const text = 'كوز رسومات الخميس وواجب الموبايل الأحد';
    const first = analysis([item()]);
    const second = analysis([item({ kind: 'homework', course: 'mobile', courseEvidence: 'الموبايل', date: '2026-10-25', dateEvidence: 'الأحد', details: 'واجب الموبايل الأحد', evidence: 'واجب الموبايل الأحد' })]);
    const values = await Promise.all([applyAcademicAnalysis(db, source(1, text), first), applyAcademicAnalysis(db, source(1, text), second)]);
    expect(values[0]).toEqual(values[1]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n).toBe(1);
    const stored = await db.prepare('SELECT analysis_json FROM academic_intakes').first<{ analysis_json: string }>();
    const selected = JSON.parse(stored!.analysis_json) as AcademicAnalysis;
    expect((await getAcademicReport(db, 'ar-1-0'))!.item.kind).toBe(selected.items[0]!.kind);
    await expect(applyAcademicAnalysis(db, source(2), analysis([item()], { intent: 'chat' }))).rejects.toThrow('Read-only intent');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_intakes').first<{ n: number }>())!.n).toBe(1);
  });
  it('filters bounded lookup dates/groups and provides IDs only in model context', async () => {
    await applyAcademicAnalysis(db, source(1, EXAMPLE), exampleAnalysis());
    expect(await readAcademicReports(db, 'كوز', NOW, { date: '2026-10-25' })).toHaveLength(1);
    expect(await readAcademicReports(db, 'تبليغات', NOW, { audience: 'A' })).toHaveLength(0);
    expect(await readAcademicReports(db, 'تبليغات', NOW, { chatId: -100333 })).toHaveLength(0);
    expect(await readAcademicReports(db, 'تبليغات', NOW, { fromDate: '2026-10-24', toDate: '2026-10-26' })).toHaveLength(1);
    expect(await listAcademicReports(db, 'مناقشة رسومات', NOW)).toContain('DDA');
    const context = JSON.parse(await getAcademicContext(db, { now: NOW, userId: 101, chatId: -100222, limit: 2 }));
    expect(context).toHaveLength(2); expect(context[0]).toHaveProperty('own', true);
    expect(context[0]).not.toHaveProperty('authorId');
  });
  it('keeps dated student reports available without auto-publishing an 18:00 digest', async () => {
    await applyAcademicAnalysis(db, source(1, EXAMPLE), exampleAnalysis());
    const reportsBefore = (await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n;
    const evening = Date.parse('2026-10-24T15:00:00Z');
    expect(await queueAcademicReportReminders(db, evening - 1)).toBe(0);
    expect(await queueAcademicReportReminders(db, evening)).toBe(0);
    expect(await queueAcademicReportReminders(db, evening + 60_000)).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n).toBe(reportsBefore);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='daily_academic'").first<{ n: number }>())!.n).toBe(0);
  });
  it('escapes and bounds individual reports without splitting HTML entities', async () => {
    const result = await applyAcademicAnalysis(db, source(), analysis([item()]));
    const value = (await getAcademicReport(db, result.reportIds[0]!))!;
    value.item.details = '<&'.repeat(1500); value.item.coverage = '<'.repeat(1000);
    const text = formatAcademicReport(value);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain('<&');
    expect(text).not.toMatch(/&(?:a(?:m(?:p)?)?|l(?:t)?)?$/u);
  });
  it('never puts unpublished private notes into Inline or another group context', async () => {
    await db.prepare('UPDATE settings SET target_chat_id=NULL,target_thread_id=NULL WHERE singleton=1').run();
    const privateSource = { ...source(1, 'كوز رسومات الخميس'), chatId: 101 };
    await applyAcademicAnalysis(db, privateSource, analysis([item()]));
    expect(await readAcademicReports(db, 'تبليغات', NOW)).toHaveLength(0);
    expect(await readAcademicReports(db, 'تبليغات', NOW, { viewerId: 101 })).toHaveLength(1);
    expect(await readAcademicReports(db, 'تبليغات', NOW, { viewerId: 202 })).toHaveLength(0);
    expect(await readAcademicReports(db, 'تبليغات', NOW, { viewerId: 101, publicOnly: true })).toHaveLength(0);
    expect(JSON.parse(await getAcademicContext(db, { now: NOW, userId: 101, publicOnly: true }))).toHaveLength(0);
    expect(JSON.parse(await getAcademicContext(db, { now: NOW, userId: 101, scopeChatId: -100222 }))).toHaveLength(0);
    expect(JSON.parse(await getAcademicContext(db, { now: NOW, userId: 101, scopeChatId: 101 }))).toHaveLength(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>())!.n).toBe(0);
  });
  it('does not expose another destination after switching, but private context includes the public target', async () => {
    await applyAcademicAnalysis(db, source(), analysis([item()]));
    expect(JSON.parse(await getAcademicContext(db, { now: NOW, userId: 202, scopeChatId: 202 }))).toHaveLength(1);
    expect(JSON.parse(await getAcademicContext(db, { now: NOW, userId: 101, scopeChatId: -100999 }))).toHaveLength(0);
    await db.prepare('UPDATE settings SET target_chat_id=-100333 WHERE singleton=1').run();
    expect(await readAcademicReports(db, 'تبليغات', NOW, { viewerId: 101 })).toHaveLength(0);
    expect(JSON.parse(await getAcademicContext(db, { now: NOW, userId: 101, publicOnly: true }))).toHaveLength(0);
  });
  it('does not aggregate student reports into an automatic channel digest', async()=>{
    for(let i=0;i<5;i++) await applyAcademicAnalysis(db,source(i+1,`كوز رسومات الخميس ${i}`),analysis([item({details:`كوز رسومات الخميس ${i}`,evidence:`كوز رسومات الخميس ${i}`})]));
    const now=Date.parse('2026-10-28T15:00:00Z');
    expect(await queueAcademicReportReminders(db,now)).toBe(0);
    expect(await queueAcademicReportReminders(db,now+60000)).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='daily_academic'").first<{n:number}>())!.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{n:number}>())!.n).toBe(5);
  });
  it('uses one bounded duplicate/conflict prefetch for six creates and stays within 24 executed queries', async () => {
    const items = Array.from({ length: 6 }, (_, index) => item({ details: `كوز رسومات الخميس مادة ${index}`,
      evidence: `كوز رسومات الخميس مادة ${index}` }));
    const text = items.map(value => value.details).join('، ');
    const queries: string[] = [];
    const counted = { prepare(sql: string) { queries.push(sql); return db.prepare(sql); },
      batch(statements: D1PreparedStatement[]) { return db.batch(statements); } } as unknown as D1Database;
    const result = await applyAcademicAnalysis(counted, source(1, text), analysis(items));
    expect(result.reportIds).toHaveLength(6);
    expect(queries.filter(sql => sql.includes('json_each(?) wanted'))).toHaveLength(1);
    expect(queries.length).toBeLessThanOrEqual(24);
  });
  it('deduplicates equal items inside a batch using reports that were just saved', async () => {
    const result = await applyAcademicAnalysis(db, source(), analysis([item(), item()]));
    expect(result.reportIds).toEqual(['ar-1-0']);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM academic_reports').first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first<{ n: number }>())!.n).toBe(0);
  });
  it('ignores model timing and never publishes a morning reminder',async()=>{
    await applyAcademicAnalysis(db,source(1,EXAMPLE),exampleAnalysis());
    const chosen={morningMinute:405,eveningMinute:1050};
    expect(await queueAcademicReportReminders(db,Date.parse('2026-10-24T14:30:00Z'),chosen)).toBe(0);
    expect(await queueAcademicReportReminders(db,Date.parse('2026-10-25T03:45:00Z'),chosen)).toBe(0);
    expect(await queueAcademicReportReminders(db,Date.parse('2026-10-24T15:00:00Z'),chosen)).toBe(0);
  });
  it('excludes a past Monday exam from Saturday current-week queries across legacy and automatic reports', async () => {
    const saturday = new Date('2026-10-24T09:00:00Z');
    const store = new EventStore(db);
    const dates = ['2026-10-19', '2026-10-24', '2026-10-26'];
    for (const [index, date] of dates.entries()) {
      const text = `امتحان رسومات ${date} مطلوب ${index}`;
      await applyAcademicAnalysis(db, source(index + 1, text), analysis([item({ kind: 'exam', date, dateEvidence: date, details: text, evidence: text })]));
      await store.createEvent({ id: `legacy-${index}`, authorId: 303, authorName: 'طالب اختبار', sourceChatId: -100222,
        status: 'approved', approvedAt: saturday.getTime(), draft: { ...emptyEventDraft(), kind: 'exam', course: 'graphics', date,
          audience: 'all', details: `مطلوب قديم ${index}` } });
    }
    const question = 'شعدنا هذا الاسبوع امتحانات؟ @daaboolbot';
    const current = await getInlineAcademicAnswer(question, '', saturday, { DB: db, CONTRIBUTIONS_ENABLED: 'true' });
    expect(current!.references).toEqual([{ kind: 'legacy', id: 'legacy-1', revision: 1 }]);
    expect(current!.directText).not.toContain('مطلوب قديم 0');
    expect((await readAcademicReports(db, question, saturday)).map(value => value.item.date)).toEqual(['2026-10-24']);
    const next = await getInlineAcademicAnswer('شنو امتحانات الأسبوع الجاي؟', '', saturday, { DB: db, CONTRIBUTIONS_ENABLED: 'true' });
    expect(next!.references).toEqual([{ kind: 'legacy', id: 'legacy-2', revision: 1 }]);
    expect((await readAcademicReports(db, 'شنو امتحانات الأسبوع الجاي؟', saturday)).map(value => value.item.date)).toEqual(['2026-10-26']);
    const old = await getInlineAcademicAnswer('شنو امتحانات 19/10/2026؟', '', saturday, { DB: db, CONTRIBUTIONS_ENABLED: 'true' });
    expect(old!.references).toEqual([{ kind: 'legacy', id: 'legacy-0', revision: 1 }]);
    const archive = await getInlineAcademicAnswer('شعدنا هذا الأسبوع امتحانات حتى اللي صارت؟', '', saturday, { DB: db, CONTRIBUTIONS_ENABLED: 'true' });
    expect(archive!.references!.map(value => value.id)).toEqual(['legacy-0', 'legacy-1']);
  });
});
