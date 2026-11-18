import { readAcademicReports, getAcademicReport, type AcademicListOptions, type AcademicReport } from './academic-ai';
import { academicHistoricalRequest } from './academic-history';
import { sharesDestination } from './admin';
import { COHORT_COURSES, findRosterNames } from './assistant-knowledge';
import { addCalendarDays, getBaghdadNow } from './calendar';
import { COHORT_PROFILE, COHORT_SIZE } from './cohort';
import { EventStore } from './event-store';
import { COURSE_LABELS } from './event-format';
import { extractEventQuery } from './event-extract';
import { emptyResult } from './nlu-schema';
import { renderQuery } from './query';
import { SEMANTIC_TIME_ZONE, type SemanticOperation, type SemanticScope, type ValidationContext } from './semantic-plan';
import { semanticCourseHint } from './semantic-validator';
import { READ_TOOL_NAMES, READ_INPUT_SCHEMAS, READ_OUTPUT_SCHEMAS, matchesReadSchema,
  type AnnouncementView, type ReadToolName, type ReadToolInputs, type ReadToolOutputs, type ReadSchema } from './read-tool-contracts';
import type { AssistantReference } from './assistant-references';

export type ReadPermission = 'schedule.read' | 'cohort.read' | 'announcements.read' | 'roster.read' | 'operations.read_own';
export interface ScopedReadReference {
  handle: string; scope: SemanticScope; expiresAt: number;
  reference: AssistantReference; destination: { chatId: number; threadId: number | null } | null;
}
export interface ScopedOperationReference {
  handle: string; jobId: string; ownerId: number; scope: SemanticScope; expiresAt: number;
}
export interface ReadExecutionContext extends ValidationContext {
  authorization: { scope: SemanticScope; expiresAt: number; permissions: readonly ReadPermission[];
    classroom: { chatId: number; threadId: number | null } | null };
  announcementReferences: readonly ScopedReadReference[];
  operationReferences: readonly ScopedOperationReference[];
}
export interface ReadOperationSnapshot {
  id: string; ownerId: number; scope: SemanticScope; state: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  messageId: number | null; deliveredChatId: number | null;
}
/** Narrow injected readers. No run/batch, Telegram client, fetcher, or AI binding. */
export interface ReadBackends {
  searchAnnouncements(request: { query: string; now: Date; options: AcademicListOptions }, signal: AbortSignal): Promise<AcademicReport[]>;
  getAnnouncement(reference: AssistantReference, signal: AbortSignal): Promise<AcademicReport | null>;
  getOperation(access: ScopedOperationReference, signal: AbortSignal): Promise<ReadOperationSnapshot | null>;
}

/** SELECT-only facade also protects against a future side effect inside a reused reader. */
export function createReadBackends(db: D1Database): ReadBackends {
  const readonlyDb = { prepare(sql: string) {
    if (!/^\s*SELECT\b/iu.test(sql) || sql.includes(';')) throw Error('Read adapter attempted a non-SELECT statement');
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: statement.first.bind(statement), all: statement.all.bind(statement),
    } as D1PreparedStatement);
    return wrap(db.prepare(sql));
  } } as D1Database;
  return {
    async searchAnnouncements(request, signal) {
      if (signal.aborted) throw Error('Aborted');
      return readAcademicReports(readonlyDb, request.query, request.now, request.options);
    },
    async getAnnouncement(reference, signal) {
      if (signal.aborted) throw Error('Aborted');
      if (reference.kind !== 'academic') return null; // Legacy details require a separate reviewed adapter.
      return getAcademicReport(readonlyDb, reference.id);
    },
    async getOperation(access, signal) {
      if (signal.aborted) throw Error('Aborted');
      const job = await new EventStore(readonlyDb).getJob(access.jobId);
      // Ownership is an APPLICATION attestation; getJob alone cannot establish it.
      return job ? { id: job.id, ownerId: access.ownerId, scope: access.scope, state: job.state,
        messageId: job.messageId, deliveredChatId: job.deliveredChatId } : null;
    },
  };
}
export type ReadFailure = 'not_found' | 'denied' | 'rejected' | 'failed' | 'timeout' | 'skipped' | 'conflict' | 'clarification_required';
export type ToolResult<K extends ReadToolName = ReadToolName> = K extends ReadToolName ? (
  { tool: K; version: 1; operationId: string; status: 'succeeded'; data: ReadToolOutputs[K] }
  | { tool: K; version: 1; operationId: string; status: ReadFailure; reason: string }
) : never;
export type DispatchResult = ToolResult | { tool: string; version: 1; operationId: string; status: ReadFailure; reason: string };
type ReadOperation = Extract<SemanticOperation, { action: 'read' }>;
export interface ReadToolDefinition<K extends ReadToolName> {
  name: K; version: 1; inputSchema: ReadSchema; outputSchema: ReadSchema;
  permission: ReadPermission; limits: { timeoutMs: number; maxResults: number; maxOutputBytes: number };
  handler(input: ReadToolInputs[K], context: ReadExecutionContext, operation: ReadOperation, signal: AbortSignal): Promise<ReadToolOutputs[K]>;
}
class ToolFault extends Error { constructor(readonly status: ReadFailure, readonly reason: string) { super(reason); } }
const fault = (status: ReadFailure, reason: string): never => { throw new ToolFault(status, reason); };
export const sameReadScope = (a: SemanticScope, b: SemanticScope) => !!a && !!b && a.botId === b.botId && a.userId === b.userId && a.chatId === b.chatId && a.threadId === b.threadId;
const validScope = (s: SemanticScope) => !!s && Number.isSafeInteger(s.botId) && s.botId > 0
  && Number.isSafeInteger(s.userId) && s.userId > 0 && Number.isSafeInteger(s.chatId) && s.chatId !== 0
  && (s.threadId === null || Number.isSafeInteger(s.threadId) && s.threadId > 0);
function authorized(c: ReadExecutionContext, permission: ReadPermission): void {
  if (!c?.actor?.verified || !validScope(c.scope) || !Number.isFinite(c.now) || !Number.isFinite(c.originalTimestamp)
    || c.actor.userId !== c.scope.userId || !Array.isArray(c.allowedActions) || !c.allowedActions.includes('read')
    || !c.authorization || !sameReadScope(c.authorization.scope, c.scope)
    || !Number.isFinite(c.authorization.expiresAt) || c.authorization.expiresAt <= c.now
    || !Array.isArray(c.authorization.permissions) || c.authorization.permissions.length > 5
    || !c.authorization.permissions.includes(permission)) fault('denied', 'missing_read_permission');
  if (c.scope.chatId < 0 && c.authorization.classroom
    && (!sharesDestination(c.scope.chatId, c.authorization.classroom.chatId)
      || c.scope.threadId !== c.authorization.classroom.threadId)) fault('denied', 'classroom_scope_mismatch');
}
function scopedAccess<T extends { scope: SemanticScope; expiresAt: number }>(values: readonly T[], c: ReadExecutionContext): T {
  if (values.length !== 1) return fault('rejected', 'unknown_or_ambiguous_reference');
  const access = values[0]!;
  if (!sameReadScope(access.scope, c.scope) || !Number.isFinite(access.expiresAt) || access.expiresAt <= c.now) fault('denied', 'reference_scope_or_expiry');
  return access;
}
function visible(report: AcademicReport, c: ReadExecutionContext): boolean {
  const classroom = c.authorization.classroom;
  if (report.destinationChatId === null) return c.scope.chatId > 0 && report.authorId === c.scope.userId
    && report.sourceChatId === c.scope.chatId && report.sourceThreadId === c.scope.threadId;
  return !!classroom && sharesDestination(c.scope.chatId, classroom.chatId)
    && report.destinationChatId === classroom.chatId && report.destinationThreadId === classroom.threadId;
}
function historical(c: ReadExecutionContext, op: ReadOperation): boolean {
  const s = c.sources.find(s => s.id === op.evidence.sourceId);
  return s?.kind === 'current' && academicHistoricalRequest(s.text.slice(op.evidence.start, op.evidence.end), new Date(c.originalTimestamp));
}
function view(report: AcademicReport, c: ReadExecutionContext): AnnouncementView {
  return { reference: { kind: 'academic', id: report.id, revision: report.revision }, kind: report.item.kind,
    course: report.item.course, date: report.item.date, audience: report.item.audience, certainty: report.item.certainty,
    details: report.item.details.slice(0, 1000), coverage: report.item.coverage.slice(0, 300),
    provenance: { kind: 'student_report', sourceMessageId: report.sourceChatId < 0 || report.authorId === c.scope.userId ? report.sourceMessageId : null } };
}
const subject: Record<ReadToolName, ReadOperation['subject']> = { get_schedule: 'schedule', get_courses: 'cohort', get_cohort_info: 'cohort',
  find_student: 'cohort', search_announcements: 'announcements', get_announcement: 'announcements', get_operation_status: 'operation_status' };

/** Fixed catalog: callers cannot register arbitrary functions or pass database/API handles. */
export class ToolRegistry {
  private readonly tools: { [K in ReadToolName]: ReadToolDefinition<K> };
  constructor(backends: ReadBackends) {
    const define = <K extends ReadToolName>(name: K, permission: ReadPermission, handler: ReadToolDefinition<K>['handler']): ReadToolDefinition<K> => ({
      name, version: 1, permission, inputSchema: READ_INPUT_SCHEMAS[name], outputSchema: READ_OUTPUT_SCHEMAS[name],
      limits: { timeoutMs: 1000, maxResults: 10, maxOutputBytes: 16384 },
      handler: async (input, c, op, signal) => { authorized(c, permission); return handler(input, c, op, signal); } });
    const course = (input: string | undefined) => input === undefined ? undefined : semanticCourseHint(input) ?? fault('clarification_required', 'unknown_course');
    this.tools = {
      get_schedule: define('get_schedule', 'schedule.read', async (input, c) => {
        const query = { ...emptyResult('schedule'), day: input.period === 'week' ? 'current_week' as const : input.period,
          course: course(input.course) ?? null, group: input.group ?? null };
        const date = new Date(c.originalTimestamp);
        return { text: renderQuery(query, date).text, referenceDate: getBaghdadNow(date).date, timezone: SEMANTIC_TIME_ZONE,
          officialOnly: true, sources: ['src/schedule.ts'] };
      }),
      get_courses: define('get_courses', 'cohort.read', async input => {
        const selected = course(input.course);
        return { courses: COHORT_COURSES.filter(c => !selected || c.id === selected).map(c => ({ id: c.id, label: c.label, instructors: [...c.teachers] })), sources: ['src/schedule.ts'] };
      }),
      get_cohort_info: define('get_cohort_info', 'cohort.read', async () => ({ profile: COHORT_PROFILE,
        studentCount: COHORT_SIZE, courseCount: COHORT_COURSES.length, sources: ['src/cohort.ts'] })),
      find_student: define('find_student', 'roster.read', async input => {
        const names = findRosterNames(input.name), limit = input.limit ?? 8;
        return { names: names.slice(0, limit), ambiguous: names.length > 1, truncated: names.length > limit, sources: ['src/roster.ts'] };
      }),
      search_announcements: define('search_announcements', 'announcements.read', async (input, c, op, signal) => {
        if (input.query !== op.query.value) fault('rejected', 'query_evidence_mismatch');
        const archive = input.archive === true;
        if (archive && !historical(c, op)) fault('denied', 'archive_not_requested');
        const selected = course(input.course);
        let query = input.query;
        if (selected && input.course) {
          // Canonicalize a literal alias only; retain every date/kind/audience filter.
          const start = query.toLowerCase().indexOf(input.course.toLowerCase());
          if (start >= 0) query = query.slice(0, start) + COURSE_LABELS[selected] + query.slice(start + input.course.length);
        }
        const selection = extractEventQuery(query, new Date(c.originalTimestamp));
        if (selection.clarification) fault('clarification_required', 'ambiguous_search');
        const limit = input.limit ?? 8, today = getBaghdadNow(new Date(c.now)).date;
        const rows = await backends.searchAnnouncements({ query, now: new Date(c.originalTimestamp), options: {
          viewerId: c.scope.userId, chatId: c.scope.chatId, limit: limit + 1, ...(selected ? { course: selected } : {}),
          ...(selection.date ? { date: selection.date } : {}),
          ...(archive ? { toDate: addCalendarDays(today, -1).date } : { fromDate: today }),
        } }, signal);
        if (!Array.isArray(rows) || rows.length > 30) fault('failed', 'backend_result_limit');
        const selectedCourse = selected ?? selection.course;
        const allowed = rows.filter(r => visible(r, c) && r.state === 'active' && (!selectedCourse || r.item.course === selectedCourse)
          && (!selection.kinds || selection.kinds.some(k => k === r.item.kind)) && (!selection.kind || r.item.kind === selection.kind)
          && (!selection.audience || r.item.audience === selection.audience || selection.audience !== 'all' && r.item.audience === 'all')
          && (archive ? !!r.item.date && r.item.date < today : !r.item.date || r.item.date >= today)
          && (!selection.date || r.item.date === selection.date)
          && (!selection.dateRange || !!r.item.date && r.item.date >= selection.dateRange.fromDate && r.item.date <= selection.dateRange.toDate));
        return { announcements: allowed.slice(0, limit).map(r => view(r, c)), truncated: allowed.length > limit, sources: ['academic_reports'] };
      }),
      get_announcement: define('get_announcement', 'announcements.read', async (input, c, op, signal) => {
        const access = scopedAccess((c.announcementReferences ?? []).filter(r => r.handle === input.reference), c);
        if (access.reference.kind !== 'academic') fault('rejected', 'legacy_detail_adapter_unavailable');
        if (input.archive && !historical(c, op)) fault('denied', 'archive_not_requested');
        const report = await backends.getAnnouncement(structuredClone(access.reference), signal);
        if (!report) return fault('not_found', 'announcement_not_found');
        if (!visible(report, c) || report.destinationChatId !== (access.destination?.chatId ?? null)
          || report.destinationThreadId !== (access.destination?.threadId ?? null)) fault('denied', 'record_scope_mismatch');
        if (report.id !== access.reference.id || report.revision !== access.reference.revision) fault('conflict', 'stale_reference');
        if (report.state !== 'active' || !input.archive && report.item.date !== null && report.item.date < getBaghdadNow(new Date(c.now)).date) fault('not_found', 'announcement_not_active');
        return { announcement: view(report, c), sources: ['academic_reports'] };
      }),
      get_operation_status: define('get_operation_status', 'operations.read_own', async (input, c, _op, signal) => {
        const access = scopedAccess((c.operationReferences ?? []).filter(r => r.handle === input.reference), c);
        if (access.ownerId !== c.scope.userId) fault('denied', 'operation_owner_mismatch');
        const row = await backends.getOperation(structuredClone(access), signal);
        if (!row) return fault('not_found', 'operation_not_found');
        if (row.id !== access.jobId || row.ownerId !== c.scope.userId || !sameReadScope(row.scope, c.scope)) fault('denied', 'operation_owner_or_scope');
        return { state: row.state, delivery: row.state === 'sent' ? Number.isSafeInteger(row.messageId) && row.messageId! > 0
          && Number.isSafeInteger(row.deliveredChatId) && row.deliveredChatId !== 0 ? 'confirmed_sent' : 'unknown'
          : row.state === 'sending' ? 'unknown' : row.state === 'pending' ? 'queued' : row.state, sources: ['outbox', 'application_ownership_grant'] };
      }),
    };
  }
  describe() { return READ_TOOL_NAMES.map(name => { const { handler: _handler, ...definition } = this.tools[name]; return structuredClone(definition); }); }
  async dispatch(name: string, input: unknown, c: ReadExecutionContext, op: ReadOperation, version = 1): Promise<DispatchResult> {
    const error = (status: ReadFailure, reason: string): DispatchResult => ({ tool: name, version: 1, operationId: op.id, status, reason });
    if (!READ_TOOL_NAMES.includes(name as ReadToolName) || version !== 1) return error('rejected', 'unknown_tool_or_version');
    const tool = this.tools[name as ReadToolName];
    if (!matchesReadSchema(input, tool.inputSchema)) return error('rejected', 'invalid_tool_input');
    if (op.action !== 'read' || subject[name as ReadToolName] !== op.subject) return error('rejected', 'tool_subject_mismatch');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      c = structuredClone(c);
      if ((c.announcementReferences?.length ?? 0) > 64 || (c.operationReferences?.length ?? 0) > 64) return error('rejected', 'context_reference_limit');
      authorized(c, tool.permission);
      const invoke = tool.handler as (input: unknown, c: ReadExecutionContext, op: ReadOperation, signal: AbortSignal) => Promise<ReadToolOutputs[ReadToolName]>;
      const data = await Promise.race([Promise.resolve().then(() => invoke(structuredClone(input), c, op, controller.signal)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ToolFault('timeout', 'read_timeout')); }, tool.limits.timeoutMs); })]);
      if (!matchesReadSchema(data, tool.outputSchema)) return error('failed', 'invalid_tool_output');
      if (new TextEncoder().encode(JSON.stringify(data)).byteLength > tool.limits.maxOutputBytes) return error('failed', 'output_size_limit');
      return { tool: name, version: 1, operationId: op.id, status: 'succeeded', data } as ToolResult;
    } catch (e) { return e instanceof ToolFault ? error(e.status, e.reason) : error('failed', 'read_backend_failed'); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
