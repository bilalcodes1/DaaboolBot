import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRIMARY_ADMIN, SECONDARY_ADMIN, DISCUSSION_GROUP, DISCUSSION_CHANNEL as CHANNEL } from '../src/admin';
import { COHORT_COURSES } from '../src/assistant-knowledge';
import type { AcademicItem, AcademicReport } from '../src/academic-ai';
import { emptyResult } from '../src/nlu-schema';
import { renderQuery } from '../src/query';
import { ReadPlanExecutor } from '../src/read-plan-executor';
import { ToolRegistry, createReadBackends, type ReadBackends, type ReadExecutionContext,
  type ScopedOperationReference, type ReadOperationSnapshot } from '../src/read-tools';
import { READ_TOOL_NAMES, matchesReadSchema, READ_OUTPUT_SCHEMAS, type ReadToolInvocation } from '../src/read-tool-contracts';
import type { SemanticOperation, SemanticPlanV1 } from '../src/semantic-plan';

const NOW = Date.parse('2026-10-29T22:30:00Z'); // Already Friday in Baghdad.
const ACTOR = 123;
function context(text = 'اعرض التبليغات', userId = ACTOR): ReadExecutionContext {
  const scope = { botId: 999, chatId: DISCUSSION_GROUP, threadId: null, userId };
  return { originalText: text, originalTimestamp: NOW, now: NOW + 1, messageId: 10, updateId: 20, scope,
    sources: [{ id: 'message', kind: 'current', text, messageStart: 0 }], actor: { verified: true, userId, ownerUid: PRIMARY_ADMIN },
    allowedActions: ['read'], instructions: [], targetBindings: [],
    authorization: { scope: { ...scope }, expiresAt: NOW + 60000,
      permissions: ['schedule.read', 'cohort.read', 'announcements.read', 'roster.read', 'operations.read_own'],
      classroom: { chatId: CHANNEL, threadId: null } }, announcementReferences: [], operationReferences: [] };
}
function operation(c: ReadExecutionContext, tool: ReadToolInvocation, id = 'read1', dependsOn: string[] = []): Extract<SemanticOperation, { action: 'read' }> {
  const evidence = { sourceId: 'message', start: 0, end: c.originalText.length };
  const subject = tool.name === 'get_schedule' ? 'schedule' : tool.name === 'get_operation_status' ? 'operation_status'
    : ['get_announcement', 'search_announcements'].includes(tool.name) ? 'announcements' : 'cohort';
  return { id, action: 'read', subject, speechAct: 'question', evidence, dependsOn, query: { value: c.originalText, evidence }, tool };
}
const plan = (...operations: SemanticOperation[]): SemanticPlanV1 => ({ version: 1, operations });
function report(id = 'ar-1-0', changes: Partial<AcademicReport> = {}, fields: Partial<AcademicItem> = {}): AcademicReport {
  return { id, revision: 1, state: 'active', authorId: ACTOR, authorName: 'طالب', sourceChatId: DISCUSSION_GROUP,
    sourceThreadId: null, sourceMessageId: 77, destinationChatId: CHANNEL, destinationThreadId: null,
    lastUpdateId: 1, createdAt: NOW, updatedAt: NOW, conflicts: [],
    item: { action: 'create', targetId: null, kind: 'exam', course: 'networks', courseEvidence: 'الشبكات', component: null,
      date: '2026-11-05', dateEvidence: '5/11', time: null, timeEvidence: null, audience: 'all', audienceEvidence: 'للكل',
      certainty: 'asserted', coverage: '', occurrenceSlots: [], occurrenceEvidence: null, details: 'امتحان الشبكات', evidence: 'عدنا امتحان الشبكات', ...fields }, ...changes };
}
function harness(rows: AcademicReport[] = []) {
  const backend: ReadBackends = { searchAnnouncements: vi.fn(async () => rows),
    getAnnouncement: vi.fn(async ref => rows.find(r => r.id === ref.id) ?? null), getOperation: vi.fn(async () => null) };
  const registry = new ToolRegistry(backend), executor = new ReadPlanExecutor(registry);
  return { backend, registry, executor, run: (c: ReadExecutionContext, tool: ReadToolInvocation) => executor.execute(plan(operation(c, tool)), c) };
}
function grant(c: ReadExecutionContext, r: AcademicReport) {
  c.announcementReferences = [{ handle: 'selected', scope: { ...c.scope }, expiresAt: NOW + 10000,
    reference: { kind: 'academic', id: r.id, revision: r.revision },
    destination: r.destinationChatId === null ? null : { chatId: r.destinationChatId, threadId: r.destinationThreadId } }];
}
function ownOperation(c: ReadExecutionContext): ScopedOperationReference {
  const ref = { handle: 'my-request', jobId: 'real-job-7', ownerId: c.scope.userId, scope: { ...c.scope }, expiresAt: NOW + 10000 };
  c.operationReferences = [ref]; return ref;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('offline read catalog and existing official data', () => {
  it('defines exactly seven versioned, closed, bounded tools and excludes send_roster', () => {
    const tools = harness().registry.describe();
    expect(tools.map(t => t.name)).toEqual(READ_TOOL_NAMES);
    for (const t of tools) {
      expect(t.version).toBe(1); expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.outputSchema.additionalProperties).toBe(false); expect(t.permission).toMatch(/read/);
      expect(t.limits).toEqual({ timeoutMs: 1000, maxResults: 10, maxOutputBytes: 16384 }); expect('handler' in t).toBe(false);
    }
    tools[0]!.limits.timeoutMs = 100000;
    expect(harness().registry.describe()[0]!.limits.timeoutMs).toBe(1000);
  });
  it.each(['today', 'tomorrow', 'week'] as const)('renders %s using the existing official source and original Baghdad timestamp', async period => {
    const c = context('جدولنا'), h = harness(), tool = { name: 'get_schedule', version: 1, input: { period } } as const;
    const result = (await h.run(c, tool)).results[0]!;
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded' && 'data' in result && result.tool === 'get_schedule') {
      expect(result.data).toMatchObject({ timezone: 'Asia/Baghdad', referenceDate: '2026-10-30', officialOnly: true });
      expect(result.data.text).toBe(renderQuery({ ...emptyResult('schedule'), day: period === 'week' ? 'current_week' : period }, new Date(c.originalTimestamp)).text);
      expect(result.data.sources).toEqual(['src/schedule.ts']);
    }
    expect(h.backend.searchAnnouncements).not.toHaveBeenCalled();
  });
  it('keeps the reference date fixed even if the clock moves to the next Baghdad day', async () => {
    const c = context('جدول اليوم'); c.now += 86400000; c.authorization.expiresAt = c.now + 10000;
    const result = await harness().run(c, { name: 'get_schedule', version: 1, input: { period: 'today' } });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { referenceDate: '2026-10-30' } });
  });
  it('returns courses and all instructors from the existing derived catalog', async () => {
    const result = await harness().run(context('شنو موادنا ومدرسينا'), { name: 'get_courses', version: 1, input: {} });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { courses: COHORT_COURSES.map(c => ({ id: c.id, label: c.label, instructors: [...c.teachers] })) } });
  });
  it.each([['البرمجة', 'visual'], ['برمجة', 'visual'], ['visual programming', 'visual'], ['mobile programming', 'mobile'],
    ['الشبكات', 'networks'], ['architecture', 'architecture'], ['الرسوميات', 'graphics'], ['compilers', 'compilers']])('uses Phase 1 alias %s', async (course, id) => {
    const result = await harness().run(context(course), { name: 'get_courses', version: 1, input: { course: course! } });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { courses: [{ id }] } });
  });
  it('does not silently drop an unknown course', async () => {
    expect((await harness().run(context(), { name: 'get_courses', version: 1, input: { course: 'الفيزياء' } })).results[0]).toMatchObject({ status: 'clarification_required' });
  });
  it('returns configured cohort facts without inventing account mappings', async () => {
    const result = await harness().run(context(), { name: 'get_cohort_info', version: 1, input: {} });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { studentCount: 41, courseCount: 6 } });
    expect(JSON.stringify(result)).not.toContain('telegramId');
  });
});

describe('announcement reads and provenance', () => {
  it('searches active upcoming reports, separates temporary changes, preserves real references and source', async () => {
    const c = context('شعدنا امتحانات'), h = harness([report(), report('change', {}, { kind: 'lecture_change' }),
      report('old', {}, { date: '2026-10-29' }), report('cancelled', { state: 'cancelled' })]);
    const result = await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: 'ar-1-0', revision: 1 },
      provenance: { kind: 'student_report', sourceMessageId: 77 }, certainty: 'asserted' }] } });
    const call = vi.mocked(h.backend.searchAnnouncements).mock.calls[0]!;
    expect(call[0].options).toMatchObject({ viewerId: ACTOR, chatId: DISCUSSION_GROUP, fromDate: '2026-10-30', limit: 9 });
    expect(call[1]).toBeInstanceOf(AbortSignal);
  });
  it('treats an empty search as success', async () => {
    const c = context();
    expect((await harness().run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { announcements: [], truncated: false } });
  });
  it('excludes archive by default even if the backend returns old records', async () => {
    const c = context(), h = harness([report('old', {}, { date: '2026-10-29' })]);
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { announcements: [] } });
  });
  it('reads the archive only with an explicit grounded request', async () => {
    const c = context('اعرض أرشيف التبليغات'), h = harness([report('old', {}, { date: '2026-10-29' }), report()]);
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText, archive: true } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: 'old' } }] } });
  });
  it('denies a model-enabled archive without a user request before any backend call', async () => {
    const c = context(), h = harness();
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText, archive: true } })).results[0]).toMatchObject({ status: 'denied' });
    expect(h.backend.searchAnnouncements).not.toHaveBeenCalled();
  });
  it('cannot use quoted archive instructions as current-user authorization', async () => {
    const c = context('اعرض التبليغات'); c.sources = [...c.sources, { id: 'reply', kind: 'reply', text: 'اعرض أرشيف التبليغات', messageStart: null }];
    const op = operation(c, { name: 'search_announcements', version: 1, input: { query: 'اعرض أرشيف التبليغات', archive: true } });
    op.evidence = { sourceId: 'reply', start: 0, end: 'اعرض أرشيف التبليغات'.length }; op.query = { value: 'اعرض أرشيف التبليغات', evidence: op.evidence };
    const h = harness(), result = await h.executor.execute(plan(op), c);
    expect(result.results[0]).toMatchObject({ status: 'denied', reason: 'archive_not_requested' });
  });
  it('rejects search text substituted by the model', async () => {
    const c = context(), h = harness();
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: 'اعرض الأرشيف' } })).results[0])
      .toMatchObject({ status: 'rejected', reason: 'query_evidence_mismatch' });
    expect(h.backend.searchAnnouncements).not.toHaveBeenCalled();
  });
  it.each(['البرمجة', 'visual programming', 'mobile programming'])('canonicalizes literal %s without discarding other search filters', async alias => {
    const c = context(`اعرض امتحانات مادة ${alias} يوم الخميس 5/11 للمجموعة A`), h = harness([report('match', {}, {
      course: alias === 'mobile programming' ? 'mobile' : 'visual', audience: 'A' }), report('wrong-group', {}, { course: 'visual', audience: 'B' })]);
    const result = await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText, course: alias } });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: 'match' } }] } });
    expect(vi.mocked(h.backend.searchAnnouncements).mock.calls[0]![0].query).toContain('5/11');
  });
  it('retrieves an allowed record and distinguishes missing and stale records', async () => {
    const c = context(), r = report(); grant(c, r);
    const tool = { name: 'get_announcement', version: 1, input: { reference: 'selected' } } as const;
    expect((await harness([r]).run(c, tool)).results[0]).toMatchObject({ status: 'succeeded', data: { announcement: { reference: { id: r.id } } } });
    expect((await harness().run(c, tool)).results[0]).toMatchObject({ status: 'not_found' });
    expect((await harness([{ ...r, revision: 2 }]).run(c, tool)).results[0]).toMatchObject({ status: 'conflict' });
  });
  it('does not accept model database IDs instead of allowed application handles', async () => {
    const c = context(), h = harness([report()]);
    expect((await h.run(c, { name: 'get_announcement', version: 1, input: { reference: 'ar-1-0' } })).results[0]).toMatchObject({ status: 'rejected' });
    expect(h.backend.getAnnouncement).not.toHaveBeenCalled();
  });
  it('hides cancelled and expired details unless the latter are explicitly requested as archive', async () => {
    const c = context(), old = report('old', {}, { date: '2026-10-29' }); grant(c, old);
    expect((await harness([old]).run(c, { name: 'get_announcement', version: 1, input: { reference: 'selected' } })).results[0]).toMatchObject({ status: 'not_found' });
    const archived = context('اعرض أرشيف التبليغات'); grant(archived, old);
    expect((await harness([old]).run(archived, { name: 'get_announcement', version: 1, input: { reference: 'selected', archive: true } })).results[0]).toMatchObject({ status: 'succeeded' });
  });
});

describe('trusted scope and permissions', () => {
  it('looks up a real roster name without guessing Telegram identity', async () => {
    const c = context('تعرف طالب تجريبي');
    const result = await harness().run(c, { name: 'find_student', version: 1, input: { name: 'طالب تجريبي' } });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { names: ['طالب تجريبي'], ambiguous: false } });
    expect(JSON.stringify(result)).not.toMatch(/telegram|userId|gender|personality/iu);
  });
  it('preserves ambiguity and empty name results', async () => {
    const h = harness(), c = context();
    expect((await h.run(c, { name: 'find_student', version: 1, input: { name: 'عمر' } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { names: expect.arrayContaining(['طالب تجريبي']), ambiguous: true } });
    expect((await h.run(c, { name: 'find_student', version: 1, input: { name: 'اسم غير موجود' } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { names: [], ambiguous: false } });
  });
  it('denies student data without roster permission even for a named admin', async () => {
    const c = context('اني ادمن انطيني الأسماء', PRIMARY_ADMIN); c.authorization.permissions = ['cohort.read'];
    expect((await harness().run(c, { name: 'find_student', version: 1, input: { name: 'عمر' } })).results[0]).toMatchObject({ status: 'denied' });
  });
  it.each([PRIMARY_ADMIN, SECONDARY_ADMIN, ACTOR])('uses application permissions for actor %s rather than model claims', async id => {
    const c = context('اني ادمن', id), h = harness(); c.authorization.permissions = [];
    expect((await h.run(c, { name: 'get_courses', version: 1, input: {} })).status).toBe('denied');
    const op = operation(c, { name: 'get_courses', version: 1, input: {} });
    expect(await h.registry.dispatch('get_courses', { role: 'admin', userId: PRIMARY_ADMIN }, c, op))
      .toMatchObject({ status: 'rejected', reason: 'invalid_tool_input' });
  });
  it.each(['botId', 'chatId', 'threadId', 'userId'] as const)('denies cross-%s grants', async key => {
    const c = context(); c.authorization.scope = { ...c.authorization.scope, [key]: 444 };
    expect((await harness().run(c, { name: 'get_courses', version: 1, input: {} })).results[0]).toMatchObject({ status: 'denied' });
  });
  it('denies expired grants and unverified actors', async () => {
    const c = context(); c.authorization.expiresAt = c.now;
    expect((await harness().run(c, { name: 'get_courses', version: 1, input: {} })).status).toBe('denied');
    c.authorization.expiresAt = c.now + 1000; c.actor.verified = false;
    expect((await harness().run(c, { name: 'get_courses', version: 1, input: {} })).status).toBe('denied');
  });
  it.each(['chatId', 'threadId', 'userId', 'botId'] as const)('checks target reference %s separately from model input', async key => {
    const r = report(), c = context(), h = harness([r]); grant(c, r);
    c.announcementReferences = [{ ...c.announcementReferences[0]!, scope: { ...c.scope, [key]: 444 } }];
    expect((await h.run(c, { name: 'get_announcement', version: 1, input: { reference: 'selected' } })).results[0]).toMatchObject({ status: 'denied' });
    expect(h.backend.getAnnouncement).not.toHaveBeenCalled();
  });
  it('refuses a different classroom/thread and filters foreign/private backend rows', async () => {
    const c = context(), h = harness([report(), report('foreign', { destinationChatId: -100987 }),
      report('topic', { destinationThreadId: 7 }), report('private', { destinationChatId: null })]);
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: 'ar-1-0' } }] } });
    c.scope.threadId = 7; c.authorization.scope.threadId = 7;
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } })).results[0]).toMatchObject({ status: 'denied' });
  });
  it('checks actual record destination after resolving an allowed reference', async () => {
    const r = report(), c = context(); grant(c, r);
    expect((await harness([{ ...r, destinationChatId: -100987 }]).run(c, { name: 'get_announcement', version: 1, input: { reference: 'selected' } })).results[0])
      .toMatchObject({ status: 'denied' });
  });
  it('returns only the actor’s own private draft and authorized classroom rows in private chat', async () => {
    const c = context(); c.scope.chatId = ACTOR; c.authorization.scope.chatId = ACTOR;
    const h = harness([report('own', { destinationChatId: null, sourceChatId: ACTOR }),
      report('other', { destinationChatId: null, sourceChatId: 456, authorId: 456 }), report()]);
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: 'own' } }, { reference: { id: 'ar-1-0' } }] } });
  });
});

describe('owned operation status and honest delivery', () => {
  it.each(['pending', 'sending', 'sent', 'failed', 'cancelled'] as const)('reads %s without exposing payload or inferring delivery', async state => {
    const c = context(), access = ownOperation(c), h = harness();
    vi.mocked(h.backend.getOperation).mockResolvedValue({ id: access.jobId, ownerId: ACTOR, scope: { ...c.scope }, state, messageId: null, deliveredChatId: null });
    const result = await h.run(c, { name: 'get_operation_status', version: 1, input: { reference: access.handle } });
    expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { state, delivery: state === 'pending' ? 'queued' : state === 'sent' || state === 'sending' ? 'unknown' : state } });
    expect(JSON.stringify(result)).not.toMatch(/payload|lastError|real-job-7/);
  });
  it('reports confirmed delivery only with an actual nonzero chat/message receipt', async () => {
    const c = context(), access = ownOperation(c), h = harness();
    vi.mocked(h.backend.getOperation).mockResolvedValue({ id: access.jobId, ownerId: ACTOR, scope: c.scope, state: 'sent', messageId: 33, deliveredChatId: CHANNEL });
    expect((await h.run(c, { name: 'get_operation_status', version: 1, input: { reference: access.handle } })).results[0])
      .toMatchObject({ status: 'succeeded', data: { delivery: 'confirmed_sent' } });
  });
  it('requires ownership before lookup, including for an admin', async () => {
    const c = context('حالة العملية', PRIMARY_ADMIN), ref = ownOperation(c), h = harness(); ref.ownerId = ACTOR;
    expect((await h.run(c, { name: 'get_operation_status', version: 1, input: { reference: ref.handle } })).results[0]).toMatchObject({ status: 'denied' });
    expect(h.backend.getOperation).not.toHaveBeenCalled();
  });
  it.each(['owner', 'scope', 'id'] as const)('rechecks backend operation %s', async field => {
    const c = context(), ref = ownOperation(c), h = harness();
    const row: ReadOperationSnapshot = { id: ref.jobId, ownerId: ACTOR, scope: { ...c.scope }, state: 'pending', messageId: null, deliveredChatId: null };
    if (field === 'owner') row.ownerId = 456; else if (field === 'scope') row.scope.threadId = 7; else row.id = 'different';
    vi.mocked(h.backend.getOperation).mockResolvedValue(row);
    expect((await h.run(c, { name: 'get_operation_status', version: 1, input: { reference: ref.handle } })).results[0]).toMatchObject({ status: 'denied' });
  });
  it('distinguishes unknown handles from missing backend records', async () => {
    const c = context(), h = harness(), tool = { name: 'get_operation_status', version: 1, input: { reference: 'my-request' } } as const;
    expect((await h.run(c, tool)).results[0]).toMatchObject({ status: 'rejected' });
    ownOperation(c); expect((await h.run(c, tool)).results[0]).toMatchObject({ status: 'not_found' });
  });
});

describe('executor bounds, dependencies and read-only isolation', () => {
  it('runs multiple independent reads and a forward dependency in a bounded topological order', async () => {
    const c = context(), h = harness();
    const a = operation(c, { name: 'get_courses', version: 1, input: {} }, 'a');
    const b = operation(c, { name: 'get_cohort_info', version: 1, input: {} }, 'b', ['a']);
    const d = operation(c, { name: 'find_student', version: 1, input: { name: 'عمر' } }, 'd');
    const result = await h.executor.execute(plan(b, d, a), c);
    expect(result.status).toBe('succeeded'); expect(result.results.map(r => r.operationId)).toEqual(['d', 'a', 'b']);
  });
  it('skips dependent reads after denied access but still executes independent reads', async () => {
    const c = context(), h = harness(); c.authorization.permissions = ['cohort.read'];
    const a = operation(c, { name: 'find_student', version: 1, input: { name: 'عمر' } }, 'a');
    const b = operation(c, { name: 'get_courses', version: 1, input: {} }, 'b', ['a']);
    const d = operation(c, { name: 'get_cohort_info', version: 1, input: {} }, 'd');
    expect((await h.executor.execute(plan(a, b, d), c)).results.map(r => r.status)).toEqual(['denied', 'skipped', 'succeeded']);
  });
  it('rejects cycles and missing dependencies before any backend execution', async () => {
    const c = context(), h = harness();
    const a = operation(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } }, 'a', ['a']);
    expect((await h.executor.execute(plan(a), c)).status).toBe('rejected');
    a.dependsOn = ['missing']; expect((await h.executor.execute(plan(a), c)).status).toBe('rejected');
    expect(h.backend.searchAnnouncements).not.toHaveBeenCalled();
  });
  it.each(['create', 'update', 'cancel', 'undo', 'publish'])('never executes a plan containing %s', async action => {
    const c = context('امتحان الشبكات'), h = harness();
    const a = operation(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } });
    const target = { type: 'description', text: c.originalText, evidence: a.evidence };
    const write = { id: 'write', action, subject: 'announcements', speechAct: 'command', evidence: a.evidence, dependsOn: [],
      ...(action === 'create' ? { data: { kind: { value: 'exam', evidence: a.evidence }, details: a.query } }
        : action === 'publish' ? { targets: [target] } : { target, ...(action === 'update' ? { patch: { details: { mode: 'set', value: c.originalText, evidence: a.evidence } } } : {}) }) };
    const result = await h.executor.execute({ version: 1, operations: [a, write] }, c);
    expect(result.status).not.toBe('succeeded'); expect(result.results).toEqual([]); expect(h.backend.searchAnnouncements).not.toHaveBeenCalled();
  });
  it('rejects an independently authorized valid mutation too, without running earlier reads', async () => {
    const c = context('امتحان الشبكات'); c.allowedActions = ['read', 'create'];
    const a = operation(c, { name: 'get_courses', version: 1, input: {} });
    const create: SemanticOperation = { id: 'write', action: 'create', subject: 'announcements', speechAct: 'statement', evidence: a.evidence, dependsOn: [],
      data: { kind: { value: 'exam', evidence: a.evidence }, course: { value: 'networks', evidence: a.evidence }, details: a.query } };
    c.instructions = [{ operationId: 'write', action: 'create', speechAct: 'statement', evidence: a.evidence }];
    expect(await harness().executor.execute(plan(a, create), c)).toMatchObject({ status: 'rejected', results: [], reason: 'write_action_not_supported' });
  });
  it('rejects unknown tools, SQL, extra AI permissions, unsupported versions and wrong subjects', async () => {
    const c = context(), h = harness(), op = operation(c, { name: 'get_courses', version: 1, input: {} });
    for (const name of ['unknown', 'send_roster', 'publish', 'SELECT * FROM students']) expect(await h.registry.dispatch(name, {}, c, op)).toMatchObject({ status: 'rejected' });
    for (const input of [null, [], { admin: true }, { sql: 'SELECT 1' }, { role: 'admin' }, { course: 33 }])
      expect(await h.registry.dispatch('get_courses', input, c, op)).toMatchObject({ status: 'rejected' });
    expect(await h.registry.dispatch('get_courses', {}, c, op, 2)).toMatchObject({ status: 'rejected' });
    expect(await h.registry.dispatch('get_schedule', { period: 'today' }, c, op)).toMatchObject({ status: 'rejected' });
    const raw = plan(op); (raw.operations[0] as unknown as { tool: unknown }).tool = { name: 'unknown', version: 1, input: {} };
    expect((await h.executor.execute(raw, c)).status).toBe('rejected');
  });
  it.each([undefined, null, {}, { actor: { verified: false } }])('rejects missing/invalid application context %j', async ctx => {
    const c = context(), raw = plan(operation(c, { name: 'get_courses', version: 1, input: {} }));
    expect((await harness().executor.execute(raw, ctx as ReadExecutionContext)).status).not.toBe('succeeded');
  });
  it('requires read grants in addition to a valid Phase 1 context', async () => {
    const c = context(); delete (c as Partial<ReadExecutionContext>).authorization;
    expect((await harness().run(c, { name: 'get_courses', version: 1, input: {} })).status).toBe('denied');
  });
  it('preserves Phase 1 reads but refuses to guess a tool when none is supplied', async () => {
    const c = context(), op = operation(c, { name: 'get_courses', version: 1, input: {} }); delete op.tool;
    expect((await harness().executor.execute(plan(op), c)).results[0]).toMatchObject({ status: 'rejected', reason: 'explicit_read_tool_required' });
  });
  it('maps backend failure to a typed error without leaking its message or pretending success', async () => {
    const c = context(), h = harness(); vi.mocked(h.backend.searchAnnouncements).mockRejectedValue(Error('secret payload token'));
    const result = await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } });
    expect(result.results[0]).toMatchObject({ status: 'failed', reason: 'read_backend_failed' }); expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('times out and aborts a stalled backend, discards late completion and bounds dependent execution', async () => {
    vi.useFakeTimers(); const c = context(), h = harness(); let finish!: (rows: AcademicReport[]) => void;
    vi.mocked(h.backend.searchAnnouncements).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const a = operation(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } }, 'a');
    const b = operation(c, { name: 'get_courses', version: 1, input: {} }, 'b', ['a']);
    const pending = h.executor.execute(plan(a, b), c); await vi.advanceTimersByTimeAsync(1001);
    const result = await pending; expect(result.results.map(r => r.status)).toEqual(['timeout', 'skipped']);
    expect(vi.mocked(h.backend.searchAnnouncements).mock.calls[0]![1].aborted).toBe(true);
    finish([report()]); await Promise.resolve(); expect(result.results[0]!.status).toBe('timeout');
  });
  it('bounds input sizes, operation counts, output rows, references and source text', async () => {
    const c = context(), h = harness(Array.from({ length: 20 }, (_, i) => report(`row-${i}`, {}, { details: 'x'.repeat(4000) })));
    const tool = { name: 'search_announcements', version: 1, input: { query: c.originalText, limit: 2 } } as const;
    const result = (await h.run(c, tool)).results[0];
    expect(result).toMatchObject({ status: 'succeeded', data: { announcements: expect.any(Array), truncated: true } });
    if (result?.status === 'succeeded' && 'data' in result && result.tool === 'search_announcements') {
      expect(result.data.announcements).toHaveLength(2); expect(result.data.announcements[0]!.details).toHaveLength(1000);
      expect(matchesReadSchema(result.data, READ_OUTPUT_SCHEMAS.search_announcements)).toBe(true);
    }
    expect((await h.run(c, { ...tool, input: { ...tool.input, limit: 11 } })).status).toBe('rejected');
    expect((await h.run(c, { name: 'find_student', version: 1, input: { name: 'a'.repeat(101) } })).status).toBe('rejected');
    const op = operation(c, { name: 'get_courses', version: 1, input: {} });
    expect((await h.executor.execute(plan(...Array.from({ length: 13 }, (_, i) => ({ ...op, id: `o${i}` }))), c)).status).toBe('rejected');
  });
  it('detects excessive backend output and oversized total result payloads', async () => {
    const c = context(), h = harness(Array.from({ length: 31 }, (_, i) => report(`r${i}`)));
    expect((await h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } })).results[0])
      .toMatchObject({ status: 'failed', reason: 'backend_result_limit' });
    vi.mocked(h.backend.searchAnnouncements).mockResolvedValue(Array.from({ length: 8 }, (_, i) => report(`r${i}`, {}, { details: 'a'.repeat(1000) })));
    const reads = Array.from({ length: 12 }, (_, i) => operation(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } }, `r${i}`));
    const result = await h.executor.execute(plan(...reads), c);
    expect(result.results.some(r => 'reason' in r && r.reason === 'plan_output_limit')).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(65536);
  });
  it('does not mutate plans, grants, references or caller-owned records', async () => {
    const c = context(), r = report(); grant(c, r); const raw = plan(operation(c, { name: 'get_announcement', version: 1, input: { reference: 'selected' } }));
    const before = structuredClone({ c, r, raw }); await harness([r]).executor.execute(raw, c);
    expect({ c, r, raw }).toEqual(before);
  });
  it('uses a snapshot of application context across asynchronous backend waits', async () => {
    const c = context(), h = harness(); let finish!: (rows: AcademicReport[]) => void;
    vi.mocked(h.backend.searchAnnouncements).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.run(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } });
    await Promise.resolve(); await Promise.resolve();
    c.authorization.classroom!.chatId = -100987; finish([report('foreign', { destinationChatId: -100987 }), report()]);
    expect((await pending).results[0]).toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: 'ar-1-0' } }] } });
  });
});

describe('actual existing SELECT adapters against an offline in-memory database', () => {
  it('reuses academic readers and EventStore.getJob with zero writes, sends or external calls during execution', async () => {
    const sql = new DatabaseSync(':memory:'); const statements: string[] = [], external = vi.fn(() => { throw Error('External call forbidden'); });
    vi.stubGlobal('fetch', external);
    try {
      for (const name of readdirSync(resolve(import.meta.dirname, '../migrations')).filter(n => n.endsWith('.sql')).sort())
        sql.exec(readFileSync(resolve(import.meta.dirname, '../migrations', name), 'utf8'));
      sql.prepare('UPDATE settings SET owner_uid=?,target_chat_id=?,target_thread_id=NULL').run(PRIMARY_ADMIN, CHANNEL);
      const r = report();
      sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,audience,
        certainty,destination_chat_id,last_update_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r.id, ACTOR, r.authorName, DISCUSSION_GROUP, 77, JSON.stringify(r.item), 'networks', 'exam', r.item.date, 'all', 'asserted', CHANNEL, 1, NOW, NOW);
      sql.prepare("INSERT INTO outbox(id,type,payload_json,state,due_at,message_id,delivered_chat_id) VALUES('real-job-7','assistant_reply','{}','sent',?,33,?)").run(NOW, CHANNEL);
      class P {
        constructor(readonly query: string, readonly values: SQLInputValue[] = []) {}
        bind(...values: SQLInputValue[]) { return new P(this.query, values); }
        async first<T>() { statements.push(this.query); return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
        async all<T>() { statements.push(this.query); return { success: true, results: sql.prepare(this.query).all(...this.values) as T[] }; }
        async run() { throw Error('D1 write forbidden'); }
      }
      const db = { prepare: (query: string) => new P(query), batch: external, exec: external } as unknown as D1Database;
      const c = context(); grant(c, r); ownOperation(c);
      const h = new ReadPlanExecutor(new ToolRegistry(createReadBackends(db)));
      const raw = plan(operation(c, { name: 'search_announcements', version: 1, input: { query: c.originalText } }, 'search'),
        operation(c, { name: 'get_announcement', version: 1, input: { reference: 'selected' } }, 'one'),
        operation(c, { name: 'get_operation_status', version: 1, input: { reference: 'my-request' } }, 'status'));
      const before = sql.prepare('SELECT total_changes() AS n').get()!.n;
      const result = await h.execute(raw, c);
      expect(result.status).toBe('succeeded'); expect(result.results[0]).toMatchObject({ status: 'succeeded', data: { announcements: [{ reference: { id: r.id } }] } });
      expect(result.results[2]).toMatchObject({ status: 'succeeded', data: { delivery: 'confirmed_sent' } });
      expect(sql.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
      expect(statements.length).toBeGreaterThan(0); expect(statements.length).toBeLessThanOrEqual(6);
      expect(statements.every(q => /^\s*SELECT\b/u.test(q))).toBe(true); expect(external).not.toHaveBeenCalled();
    } finally { sql.close(); }
  });
});
