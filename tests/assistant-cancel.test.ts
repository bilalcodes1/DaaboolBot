import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { cancelReferencedAnnouncement, referencedCancellationIntent, type AnnouncementReference } from '../src/assistant-cancel';
import { EventStore } from '../src/event-store';
import { emptyEventDraft } from '../src/event-types';
import { applyAcademicAnalysis, getAcademicReport, undoAcademicReport, type AcademicItem, type AcademicSource } from '../src/academic-ai';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const connections: DatabaseSync[] = [];
function database() {
  const sqlite = new DatabaseSync(':memory:'); connections.push(sqlite);
  for (const name of readdirSync(new NodeURL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new NodeURL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  class Prepared {
    constructor(readonly sql: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: SQLInputValue[]): Prepared { return new Prepared(this.sql, values); }
    async first<T>(): Promise<T | null> { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
    async all<T>(): Promise<{ success: boolean; results: T[] }> { return { success: true, results: sqlite.prepare(this.sql).all(...this.values) as T[] }; }
    async run(): Promise<{ success: boolean; meta: { changes: number } }> { return { success: true, meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }
  const db = { prepare: (sql: string) => new Prepared(sql), async batch(statements: Prepared[]) {
    sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  sqlite.prepare('UPDATE settings SET owner_uid=1,target_chat_id=-100123,target_thread_id=NULL WHERE singleton=1').run();
  return { db, sqlite, store: new EventStore(db) };
}
function source(updateId = 20, userId = 1, text = 'هذا قديم التبليغ احذفه @daaboolbot'): AcademicSource {
  return { updateId, userId, userName: userId === 1 ? 'المالك' : 'طالب', chatId: -100333, threadId: 5,
    messageId: updateId + 100, text, now: NOW + updateId };
}
async function legacy(store: EventStore, id = 'legacy-1') {
  const created = await store.createEvent({ id, authorId: 2, authorName: 'بلال', sourceChatId: 2, sourceMessageId: 7,
    draft: { ...emptyEventDraft(), kind: 'quiz', course: 'graphics', date: '2026-10-19', audience: 'all', details: 'المحاضرة 2 و3، المهم الخوارزميات' },
    status: 'approved', submittedAt: NOW - 86_400_000, approvedAt: NOW - 86_400_000 });
  await store.markPublished(created.id, created.revision, 80, -100123);
  return { kind: 'legacy', id: created.id, revision: created.revision } satisfies AnnouncementReference;
}
async function academic(db: D1Database) {
  const text = 'كوز رسومات 2026-10-29';
  const item: AcademicItem = { action: 'create', targetId: null, kind: 'quiz', course: 'graphics', courseEvidence: 'رسومات', component: null,
    date: '2026-10-29', dateEvidence: '2026-10-29', time: null, timeEvidence: null, audience: null, audienceEvidence: null,
    certainty: 'asserted', coverage: '', occurrenceSlots: [], occurrenceEvidence: null, details: text, evidence: text };
  const saved = await applyAcademicAnalysis(db, source(10, 2, text), { intent: 'academic', reply: '', clarification: null, items: [item] });
  return { kind: 'academic', id: saved.reportIds[0]!, revision: 1 } satisfies AnnouncementReference;
}
afterEach(() => { for (const sqlite of connections.splice(0)) sqlite.close(); });

describe('explicit referenced cancellation commands', () => {
  it.each(['هذا قديم التبليغ احذفه @daaboolbot', 'احذف هذا', 'امسحه', 'شيله من الجدول', 'هذا مو صحيح احذفه', 'أريد حذف هذا التبليغ'])('recognizes deletion command %s', text => {
    expect(referencedCancellationIntent(text)).toBe('delete');
  });
  it.each(['ألغيه', 'الغي هذا التبليغ', 'إلغاء التبليغ', 'اريد الغاء التبليغ'])('recognizes cancellation command %s', text => {
    expect(referencedCancellationIntent(text)).toBe('cancel');
  });
  it.each(['لا تحذفه', 'لا تلغي التبليغ', 'ما أريد تحذفه', 'إذا صار قديم احذفه', 'مثلاً احذفه', 'شلون احذفه', 'شنو معنى احذفه', 'هذا قديم', 'الطالب حذفه', 'ليش تم إلغاء التبليغ؟', 'احذفه؟', 'الطالب قال احذفه', 'هو يكول امسحه'])('does not execute negated, hypothetical or descriptive text %s', text => {
    expect(referencedCancellationIntent(text)).toBeNull();
  });
});

describe('legacy record cancellation from grounded replies', () => {
  it('allows the owner to remove the exact legacy record from a linked discussion and queues deletion only of known bot publications', async () => {
    const { db, store, sqlite } = database(); const reference = await legacy(store);
    await store.enqueueJob({ id: 'published-attachment', type: 'publish', payload: { eventId: reference.id, revision: 1, part: 'attachment' }, dueAt: NOW - 1000 });
    sqlite.prepare("UPDATE outbox SET state='sent',message_id=81,delivered_chat_id=-100123 WHERE id='published-attachment'").run();
    const outcome = await cancelReferencedAnnouncement(db, source(), reference);
    expect(outcome?.text).toContain('انحذف'); expect(outcome?.eventIds).toEqual([reference.id]);
    const saved = await store.getEvent(reference.id);
    expect(saved).toMatchObject({ status: 'cancelled', revision: 2, publicationDeletionRevision: 2 });
    expect(await store.listApproved()).toEqual([]);
    const jobs = sqlite.prepare("SELECT payload_json FROM outbox WHERE type='publication_delete' ORDER BY id").all();
    expect(jobs).toHaveLength(2);
    expect(jobs.map(row => JSON.parse(String(row.payload_json)) as { chatId: number; messageId: number }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ chatId: -100123, messageId: 80 }), expect.objectContaining({ chatId: -100123, messageId: 81 })]));
    expect((await store.getEvent(reference.id))?.draft.details).toContain('الخوارزميات');
  });
  it('allows an author to soft-cancel their own legacy note without granting publication deletion permission', async () => {
    const { db, store, sqlite } = database(); const reference = await legacy(store);
    const outcome = await cancelReferencedAnnouncement(db, source(21, 2), reference);
    expect(outcome?.text).toContain('ألغيت'); expect(await store.getEvent(reference.id)).toMatchObject({ status: 'cancelled', revision: 2, publicationDeletionRevision: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='publication_delete'").get()?.n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='status'").get()?.n).toBe(1);
  });
  it('does not allow another student to cancel an owner/author record', async () => {
    const { db, store, sqlite } = database(); const reference = await legacy(store);
    const outcome = await cancelReferencedAnnouncement(db, source(22, 3), reference);
    expect(outcome?.text).toContain('لصاحبه أو للمالك'); expect(await store.getEvent(reference.id)).toMatchObject({ status: 'approved', revision: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
  });
  it('rejects a stale reply rather than cancelling a newer revision', async () => {
    const { db, store } = database(); const reference = await legacy(store);
    await store.updateEvent(reference.id, 1, { authorName: 'بلال الجديد' });
    expect((await cancelReferencedAnnouncement(db, source(), reference))?.text).toContain('آخر نسخة');
    expect(await store.getEvent(reference.id)).toMatchObject({ status: 'approved', revision: 2 });
  });
  it('journals retries and repairs interrupted legacy deletion enqueue without another revision', async () => {
    const { db, store, sqlite } = database(); const reference = await legacy(store); let failOnce = true;
    const interrupted = { ...db, prepare: (sql: string) => {
      if (failOnce && sql.startsWith('SELECT chat_id,message_id,MAX(part)')) { failOnce = false; throw Error('interrupted after CAS'); }
      return db.prepare(sql);
    } } as D1Database;
    await expect(cancelReferencedAnnouncement(interrupted, source(), reference)).rejects.toThrow('interrupted');
    expect(await store.getEvent(reference.id)).toMatchObject({ status: 'cancelled', revision: 2 });
    const recovered = await cancelReferencedAnnouncement(db, source(), reference);
    expect(recovered?.eventIds).toEqual([reference.id]);
    const repeated = await cancelReferencedAnnouncement(db, source(), reference);
    expect(repeated).toEqual(recovered); expect(await store.getEvent(reference.id)).toMatchObject({ revision: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='publication_delete'").get()?.n).toBe(1);
  });
  it('does not mutate without an explicit current instruction and rejects update identity reuse', async () => {
    const { db, store } = database(); const reference = await legacy(store);
    expect(await cancelReferencedAnnouncement(db, source(23, 1, 'هذا قديم'), reference)).toBeNull();
    await cancelReferencedAnnouncement(db, source(), reference);
    await expect(cancelReferencedAnnouncement(db, source(20, 3), reference)).rejects.toThrow('identity mismatch');
  });
});

describe('atomic academic cancellation with undo/audit', () => {
  it('cancels the exact referenced revision, retains details, records undo snapshot without enqueuing a channel message', async () => {
    const { db, sqlite } = database(); const reference = await academic(db);
    const outcome = await cancelReferencedAnnouncement(db, source(30, 2, 'هذا قديم احذفه'), reference);
    expect(outcome?.reportIds).toEqual([reference.id]);
    expect(await getAcademicReport(db, reference.id)).toMatchObject({ revision: 2, state: 'cancelled', item: { details: 'كوز رسومات 2026-10-29' }, lastUpdateId: 30 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM academic_report_changes WHERE report_id=?').get(reference.id)?.n).toBe(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id=?").get(`academic-report:${reference.id}:2`)?.n).toBe(0);
    const undone = await undoAcademicReport(db, reference.id, 2, 1, NOW + 1000, 31, 2);
    expect(undone.reportId).toBe(reference.id); expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 3 });
  });
  it('allows owner cancellation, denies unrelated students and rejects newer academic revisions', async () => {
    const { db, sqlite } = database(); const reference = await academic(db);
    expect((await cancelReferencedAnnouncement(db, source(31, 3), reference))?.text).toContain('لصاحبه أو للمالك');
    expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 1 });
    sqlite.prepare('UPDATE academic_reports SET revision=2 WHERE id=?').run(reference.id);
    expect((await cancelReferencedAnnouncement(db, source(32, 1), reference))?.text).toContain('آخر نسخة');
    expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 2 });
    expect((await cancelReferencedAnnouncement(db, source(33, 1), { ...reference, revision: 2 }))?.reportIds).toEqual([reference.id]);
  });
  it('cannot write audit/outbox records if a concurrent edit defeats the academic CAS', async () => {
    const { db, sqlite } = database(); const reference = await academic(db); let editOnce = true;
    const raced = { ...db, async batch(statements: D1PreparedStatement[]) {
      if (editOnce) { editOnce = false; sqlite.prepare('UPDATE academic_reports SET revision=revision+1 WHERE id=?').run(reference.id); }
      return db.batch(statements);
    } } as D1Database;
    expect((await cancelReferencedAnnouncement(raced, source(), reference))?.text).toContain('بنفس الوقت');
    expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
  });
  it('replays a saved academic command without repeating cancellation or undoing a later restoration', async () => {
    const { db, sqlite } = database(); const reference = await academic(db); const command = source(40, 2, 'الغي هذا');
    const saved = await cancelReferencedAnnouncement(db, command, reference);
    expect(await cancelReferencedAnnouncement(db, command, reference)).toEqual(saved);
    await undoAcademicReport(db, reference.id, 2, 1, NOW + 1000, 41, 2);
    expect(await cancelReferencedAnnouncement(db, command, reference)).toEqual(saved);
    expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id=?").get(`academic-report:${reference.id}:2`)?.n).toBe(0);
  });
});

describe('explicit cancellation selectors must match the grounded reply', () => {
  for (const kind of ['legacy', 'academic'] as const) {
    it.each(['احذف كوز المترجمات', 'احذف كوز الرسومات باچر', 'احذف امتحان الرسومات', 'احذف كوز الرسومات مجموعة A'])
      (`rejects a conflicting ${kind} course/date/kind/audience selector: %s`, async text => {
        const { db, store, sqlite } = database();
        const reference = kind === 'legacy' ? await legacy(store) : await academic(db);
        const jobsBefore = sqlite.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n;
        const outcome = await cancelReferencedAnnouncement(db, source(50, 1, text), reference);
        expect(outcome?.text).toContain('ما ألغيت'); expect(outcome?.reportIds).toEqual([]); expect(outcome?.eventIds).toEqual([]);
        if (kind === 'legacy') expect(await store.getEvent(reference.id)).toMatchObject({ status: 'approved', revision: 1 });
        else expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 1 });
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(jobsBefore);
      });
    it(`asks about ambiguous ${kind} selectors instead of cancelling the replied record`, async () => {
      const { db, store } = database(); const reference = kind === 'legacy' ? await legacy(store) : await academic(db);
      const outcome = await cancelReferencedAnnouncement(db, source(51, 1, 'احذف كوز الرسومات والمترجمات'), reference);
      expect(outcome?.text).toContain('ما ألغيت');
      if (kind === 'legacy') expect(await store.getEvent(reference.id)).toMatchObject({ status: 'approved', revision: 1 });
      else expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'active', revision: 1 });
    });
    it(`accepts explicit selectors matching the referenced ${kind} record`, async () => {
      const { db, store } = database(); const reference = kind === 'legacy' ? await legacy(store) : await academic(db);
      const text = kind === 'legacy' ? 'احذف كوز رسومات 2026-10-19 للكل' : 'احذف كوز رسومات 2026-10-29';
      const outcome = await cancelReferencedAnnouncement(db, source(52, 1, text), reference);
      expect(outcome?.text).not.toContain('ما ألغيت');
      if (kind === 'legacy') expect(await store.getEvent(reference.id)).toMatchObject({ status: 'cancelled', revision: 2 });
      else expect(await getAcademicReport(db, reference.id)).toMatchObject({ state: 'cancelled', revision: 2 });
    });
  }
});
