import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { UNDERSTANDING_CASES, UNDERSTANDING_LABELS, UNDERSTANDING_GOLD_VERSION, UNDERSTANDING_PROFILE, UNDERSTANDING_SMOKE_IDS } from '../eval/semantic-understanding-fixtures';
import { UNDERSTANDING_INSTRUCTIONS, UNDERSTANDING_PROMPT_VERSION, UnderstandingContextBuilder } from '../eval/semantic-understanding-prompt';
import { isUnderstandingSelection, prepareUnderstandingSmoke, UNDERSTANDING_LIMITS } from '../eval/semantic-understanding-gate';
import { QualityContextBuilder, QUALITY_INSTRUCTIONS } from '../eval/semantic-quality-prompt';
import { qualityCase, summarizeQualityGate } from '../eval/semantic-quality-gate';
import { checkpointIdentity, validateCheckpoint, type EvalCheckpoint } from '../eval/semantic-checkpoint';
import { parseLabArgs, runLab } from '../eval/run-semantic-lab';
import { MODEL_PLAN_DRAFT_JSON_SCHEMA, isModelPlanDraft, normalizeModelPlan, type ModelPlanDraftV1 } from '../src/semantic-draft';
import { assertEvalRequest, EVAL_COMPLETION_TOKENS, GuardedGroqEvaluation } from '../src/semantic-eval-guard';
import { compareMeaning, isUnsafeAcceptedSideEffect, SemanticEvaluator, semanticPlanMeaning, type SemanticGoldCase } from '../src/semantic-eval';
import { validateSemanticPlan } from '../src/semantic-validator';
import type { GroqPlanRequest, PlannerTransport } from '../src/groq-planner';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const fixture = (id: string) => structuredClone(UNDERSTANDING_CASES.find(c => c.id === id)!);
const dynamic = (c: SemanticGoldCase) => JSON.parse(new UnderstandingContextBuilder().build(c.input, c.context).messages[1]!.content);
const envelope = (draft: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }],
  usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200 } });
function mockEvaluator(draft: unknown, builder = new UnderstandingContextBuilder()) {
  const transport = vi.fn<PlannerTransport>(async () => ({ status: 200, body: envelope(draft) }));
  return { transport, evaluator: new SemanticEvaluator(transport, 'offline_mock', 1000, EVAL_COMPLETION_TOKENS, undefined, builder) };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in understanding tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('35 independent V4 understanding fixtures through the offline draft pipeline', () => {
  it('keeps complete unique labels and returns independent owned smoke copies', () => {
    expect(UNDERSTANDING_CASES).toHaveLength(35); expect(UNDERSTANDING_LABELS).toHaveLength(35);
    expect(new Set(UNDERSTANDING_CASES.map(c => c.id)).size).toBe(35);
    expect(UNDERSTANDING_LABELS.map(l => l.id)).toEqual(UNDERSTANDING_CASES.map(c => c.id));
    expect(UNDERSTANDING_LABELS.every(l => l.labelNote.length > 25)).toBe(true);
    expect(UNDERSTANDING_CASES.every(c => c.synthetic && c.datasetVersion === UNDERSTANDING_GOLD_VERSION && c.evaluationProfile === UNDERSTANDING_PROFILE)).toBe(true);
    const before = JSON.stringify(UNDERSTANDING_CASES), selected = prepareUnderstandingSmoke();
    selected.cases[0]!.context.instructions = []; selected.cases[0]!.expectedPlan.operations = [];
    expect(JSON.stringify(UNDERSTANDING_CASES)).toBe(before);
  });

  it.each(UNDERSTANDING_CASES)('$id preserves meaning/evidence and independently enforces the labelled validator policy', async original => {
    const c = structuredClone(original), before = structuredClone(c), draft = mockDraftFromGold(c.expectedPlan);
    expect(isModelPlanDraft(draft)).toBe(true);
    const normalized = normalizeModelPlan(draft, c.context.sources);
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw Error('Normalization failed');
    expect(compareMeaning(semanticPlanMeaning(c.expectedPlan), semanticPlanMeaning(normalized.plan)).exact).toBe(true);
    const built = new UnderstandingContextBuilder().build(c.input, c.context), checked = validateSemanticPlan(normalized.plan, built.context);
    if (c.expectedValidator === 'allow') expect(checked.ok).toBe(true);
    else {
      expect(checked.ok).toBe(false); if (checked.ok) throw Error('Expected rejection');
      const label = UNDERSTANDING_LABELS.find(l => l.id === c.id)!;
      expect(checked.issues.map(i => i.reason)).toContain(label.validatorReason);
      expect(checked.status).toBe(c.expectedValidator === 'deny' ? 'denied' : 'conflict');
    }
    const { evaluator, transport } = mockEvaluator(draft), row = await evaluator.evaluate(c);
    expect(transport).toHaveBeenCalledTimes(1); assertEvalRequest(transport.mock.calls[0]![0], 'understanding-v4');
    expect(row.source).toBe('offline_mock'); expect(row.rawExact).toBe(true);
    expect(row.stages.localSchemaValid).toBe(true); expect(row.stages.normalization).toBe('ok');
    expect(row.validator.actual === 'allow').toBe(c.expectedValidator === 'allow'); expect(row.validator.correct).toBe(true);
    expect(row.invalidPlan).toBe(false); expect(row.unnecessaryClarification).toBe(false);
    expect(row.falseWriteProposal).toBe(false); expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    expect(row.toolExecutions).toBe(0); expect(c).toEqual(before);
  });

  it('keeps optional create fields absent and preserves the explicit optional contrast', () => {
    for (const id of ['p3e-01', 'p3e-02', 'p3e-03']) {
      const c = fixture(id), op = c.expectedPlan.operations[0]!;
      if (op.action !== 'create') throw Error('Create fixture');
      expect(op.data.time).toBeUndefined(); expect(op.data.audience).toBeUndefined();
      expect(op.data.component).toBeUndefined(); expect(op.data.claimedCertainty).toBeUndefined();
      if (id === 'p3e-02') expect(op.data.date).toBeUndefined();
      expect(c.ambiguity).toBe(false);
    }
    const explicit = fixture('p3e-04').expectedPlan.operations[0]!;
    if (explicit.action !== 'create') throw Error('Create fixture');
    expect(explicit.data.time?.value).toBe('10:15'); expect(explicit.data.audience?.value).toBe('B');
    expect(UNDERSTANDING_INSTRUCTIONS).toContain('Audience=A/B/all');
    const coverage = fixture('p3e-05').expectedPlan;
    expect(coverage.operations).toHaveLength(1);
    expect(coverage.operations[0]!.action === 'create' && coverage.operations[0]!.data.coverage?.value).toBe('3 محاضرات');
  });

  it('asks for missing essentials while preserving supplied values and date ambiguity labels', () => {
    for (const [id, required] of [['p3e-06', ['course']], ['p3e-07', ['course']], ['p3e-08', ['kind', 'course', 'details']]] as const) {
      expect(UNDERSTANDING_LABELS.find(l => l.id === id)!.missingRequired).toEqual(required);
      expect(fixture(id).expectedPlan.operations[0]).toMatchObject({ action: 'reply', subject: 'clarification', speechAct: 'command' });
    }
    for (const id of ['p3e-33', 'p3e-34']) {
      expect(fixture(id).ambiguity).toBe(true);
      expect(fixture(id).expectedPlan.operations[0]).toMatchObject({ action: 'reply', subject: 'clarification' });
    }
    expect(fixture('p3e-09').input.originalText).toBe(fixture('p3e-10').input.originalText);
    expect(fixture('p3e-09').expectedPlan.operations[0]).toMatchObject({ action: 'read', tool: { name: 'get_operation_status' } });
    expect(fixture('p3e-10').expectedPlan.operations[0]).toMatchObject({ action: 'reply', subject: 'clarification' });
    expect(fixture('p3e-11').expectedPlan.operations[0]).toMatchObject({ action: 'read', tool: { name: 'search_announcements' } });
  });

  it('distinguishes negative commands, negative questions and untrusted quoted save examples', () => {
    for (const id of ['p3e-13', 'p3e-14']) expect(fixture(id).expectedPlan.operations[0]).toMatchObject({ action: 'reply', speechAct: 'negation' });
    expect(fixture('p3e-15').expectedPlan.operations[0]).toMatchObject({ action: 'read', speechAct: 'command', tool: { name: 'get_schedule' } });
    expect(fixture('p3e-16').expectedPlan.operations[0]).toMatchObject({ action: 'read', speechAct: 'question', tool: { name: 'search_announcements' } });
    const quoted = fixture('p3e-12'), op = quoted.expectedPlan.operations[0]!, quote = quoted.context.sources.find(s => s.kind === 'quote')!;
    expect(op).toMatchObject({ action: 'reply', speechAct: 'example' });
    expect(op.evidence.start).toBeGreaterThanOrEqual(quote.messageStart! + quote.text.length);
    expect(quoted.context.instructions).toEqual([]);
  });

  it('preserves update set/clear scope, new-versus-existing intent and real dependencies', async () => {
    const time = fixture('p3e-18').expectedPlan.operations[0]!, clear = fixture('p3e-19').expectedPlan.operations[0]!;
    if (time.action !== 'update' || clear.action !== 'update') throw Error('Update fixtures');
    expect(Object.keys(time.patch)).toEqual(['time']); expect(time.patch.time).toMatchObject({ mode: 'set', value: '09:45' });
    expect(Object.keys(clear.patch)).toEqual(['time']); expect(clear.patch.time).toMatchObject({ mode: 'clear' });
    const clearDraft = mockDraftFromGold(fixture('p3e-19').expectedPlan).operations[0]!;
    expect(clearDraft.fields).toMatchObject([{ name: 'time', mode: 'clear', value: null, dateKind: null }]);
    expect(fixture('p3e-21').expectedPlan.operations[0]!.action).toBe('create'); expect(fixture('p3e-22').expectedPlan.operations[0]!.action).toBe('update');
    const dependent = fixture('p3e-31'), draft = mockDraftFromGold(dependent.expectedPlan);
    expect(draft.operations[1]!.dependsOn).toEqual(['a']); draft.operations[1]!.dependsOn = [];
    const row = await mockEvaluator(draft).evaluator.evaluate(dependent);
    expect(row.comparison.dependency).toBe(false); expect(row.rawExact).toBe(false); expect(row.toolExecutions).toBe(0);
    expect(fixture('p3e-32').expectedPlan.operations[0]).toMatchObject({ action: 'reply', subject: 'clarification' });
  });
});

describe('V4 projections preserve trusted authority boundaries and fresh scope', () => {
  it('exposes role capability independently from expected actions or local action attestations', () => {
    const students = ['p3e-03', 'p3e-13', 'p3e-18', 'p3e-23s'].map(fixture);
    expect(new Set(students.flatMap(c => c.expectedPlan.operations.map(op => op.action))).size).toBe(4);
    for (const c of students) {
      const d = dynamic(c);
      expect(d.app_capabilities).toEqual({ publicationRoleEligible: false, execution: 'disabled_proposals_only' });
      expect(d.app_capabilities).not.toHaveProperty('allowedActions');
      c.context.allowedActions = ['read', 'create', 'update', 'cancel', 'undo', 'publish', 'reply'];
      expect(dynamic(c).app_capabilities).toEqual(d.app_capabilities);
      expect(d.trusted_metadata.actorRole).toBe('student');
    }
    const admin = fixture('p3e-23a'), student = fixture('p3e-23s');
    expect(semanticPlanMeaning(admin.expectedPlan)).toEqual(semanticPlanMeaning(student.expectedPlan));
    expect(dynamic(admin).app_capabilities).toEqual({ publicationRoleEligible: true, execution: 'disabled_proposals_only' });
    expect(dynamic(fixture('p3e-24')).trusted_metadata.actorRole).toBe('student');
  });

  it('maps fresh selectors to handles without publishing DB identities, revisions or authority', () => {
    const c = fixture('p3e-25'), before = structuredClone(c.context), d = dynamic(c);
    expect(d.target_selectors).toEqual([1, 2].map(position => ({ selector: { type: 'previous_list', listId: 'phase3e-list', position }, candidates: 1, handles: [`p3e-item-${position}`] })));
    expect(JSON.stringify(d)).not.toMatch(/phase3e-record-|currentRevision|expectedRevision|ownerId|targetBindings|allowedActions/u);
    expect(d.trusted_metadata).not.toHaveProperty('scope'); expect(d.trusted_metadata).not.toHaveProperty('originalTimestamp');
    expect(d.trusted_metadata.timezone).toBe('Asia/Baghdad'); expect(d.trusted_metadata.baghdadDate).toBe('2026-10-30');
    expect(c.context).toEqual(before);
    for (const id of ['p3e-26', 'p3e-27', 'p3e-28']) {
      const stale = dynamic(fixture(id)); expect(stale.target_selectors).toEqual([]); expect(stale.references).toEqual([]);
      expect(stale.conversation).toEqual([]); expect(stale.pending).toBeNull();
    }
    expect(dynamic(fixture('p3e-30')).target_selectors.some((selector: { candidates: number }) => selector.candidates === 2)).toBe(true);
  });

  it.each(['botId', 'chatId', 'threadId', 'userId'] as const)('excludes foreign %s selectors and handles', field => {
    const c = fixture('p3e-25'), foreign = { ...c.context.scope, [field]: field === 'threadId' ? 5 : c.context.scope[field]! + 1 };
    c.context.targetBindings = c.context.targetBindings.map(b => ({ ...b, scope: foreign }));
    c.context.announcementReferences = c.context.announcementReferences.map(r => ({ ...r, scope: foreign }));
    const d = dynamic(c); expect(d.target_selectors).toEqual([]); expect(d.references).toEqual([]);
  });

  it.each([Infinity, -Infinity, NaN, 0])('excludes invalid/nonfinite expiration %s', expiresAt => {
    const c = fixture('p3e-25');
    c.context.targetBindings = c.context.targetBindings.map(b => ({ ...b, expiresAt }));
    c.context.announcementReferences = c.context.announcementReferences.map(r => ({ ...r, expiresAt }));
    if (c.input.conversation) c.input.conversation.expiresAt = expiresAt;
    const d = dynamic(c); expect(d.target_selectors).toEqual([]); expect(d.references).toEqual([]); expect(d.conversation).toEqual([]);
  });
});

function runnerHarness(ids: readonly string[] = UNDERSTANDING_SMOKE_IDS, proposed: (c: SemanticGoldCase) => ModelPlanDraftV1 = c => mockDraftFromGold(c.expectedPlan)) {
  let now = Date.parse('2026-10-30T10:00:00Z');
  const cases = prepareUnderstandingSmoke(ids).cases, checkpoints: EvalCheckpoint[] = [], requests: GroqPlanRequest[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init!.body)) as GroqPlanRequest;
    assertEvalRequest(request, UNDERSTANDING_PROFILE); requests.push(request);
    const payload = JSON.parse(request.messages[1]!.content);
    const role = payload.trusted_metadata.actorRole;
    const c = cases.find(c => c.input.originalText === payload.user_instruction[0].text
      && (c.context.actor.userId === c.context.actor.ownerUid ? 'admin' : 'student') === role)!;
    return Response.json(envelope(proposed(c)));
  });
  return { cases, checkpoints, requests, fetcher, clock: () => now, runtime: { clock: () => now,
    sleep: async (ms: number) => { now += ms; }, persist: async (cp: EvalCheckpoint) => { checkpoints.push(structuredClone(cp)); } } };
}

describe('bounded six-case V4 preflight, strict request and simulated runner', () => {
  it('pins model/schema/prompt identity and keeps six full reservations within local limits', () => {
    const prepared = prepareUnderstandingSmoke();
    expect(prepared.cases.map(c => c.id)).toEqual(UNDERSTANDING_SMOKE_IDS);
    expect(prepared.selection.count).toBe(6); expect(prepared.selection.totalReserved).toBeLessThanOrEqual(50000);
    expect(prepared.selection.selected.every(c => c.tokens <= 5000 && c.reservation.outputReserved === 1024)).toBe(true);
    expect(prepared.schema).toMatchObject({ model: 'openai/gpt-oss-120b', strict: true, streaming: false, tools: false,
      schemaHash: '8e0983deadf3b0c8cb3452de7023cb1f64d470165771b2c441e6ad5fe53074b4' });
    const identity = checkpointIdentity(prepared.cases);
    expect(identity).toMatchObject({ datasetVersion: UNDERSTANDING_GOLD_VERSION, promptVersion: 'semantic-brain-v4-contract', executionLimits: UNDERSTANDING_LIMITS });
    expect(prepared.promptVersion).toBe(UNDERSTANDING_PROMPT_VERSION);
    expect(prepared.promptHash).toBe(createHash('sha256').update(UNDERSTANDING_INSTRUCTIONS).digest('hex'));
    expect(isUnderstandingSelection(prepared.cases)).toBe(true);
    expect(() => prepareUnderstandingSmoke(undefined, { tokensPerMinute: 100 })).toThrow('budget');
    expect(() => prepareUnderstandingSmoke(undefined, { remainingRequests: 5 })).toThrow('budget');
  });

  it('rejects unknown, duplicate, empty, seventh-case and cross-profile selections before any transport', async () => {
    for (const ids of [[], ['unknown'], ['p3e-03', 'p3e-03'], [...UNDERSTANDING_SMOKE_IDS, 'p3e-01']]) expect(() => prepareUnderstandingSmoke(ids)).toThrow();
    expect(() => parseLabArgs(['--understanding', '--quality'])).toThrow('mutually exclusive');
    expect(() => parseLabArgs(['--understanding', '--understanding'])).toThrow();
    expect(() => parseLabArgs(['--understanding', '--cases', 'questions_commands-05'])).toThrow('Unknown understanding');
    expect(() => parseLabArgs(['--quality', '--cases', 'p3e-03'])).toThrow();
    expect(() => parseLabArgs(['--cases', 'p3e-03'])).toThrow();
    const fetcher = vi.fn();
    await expect(runLab(['--understanding', '--live', '--smoke', '--cases', 'unknown'], {}, fetcher as typeof fetch)).rejects.toThrow('Unknown understanding');
    expect(fetcher).not.toHaveBeenCalled();
    const offline = await runLab(['--understanding'], {}, fetcher as typeof fetch);
    expect(offline).toMatchObject({ mode: 'offline', evaluationProfile: UNDERSTANDING_PROFILE, datasetCases: 6, liveRequests: 0, realModelAccuracy: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never silently falls back from V4 prompt/schema/model or permits a seventh request', async () => {
    const c = fixture('p3e-03'), { evaluator, transport } = mockEvaluator(mockDraftFromGold(c.expectedPlan));
    await evaluator.evaluate(c); const original = transport.mock.calls[0]![0]; assertEvalRequest(original, UNDERSTANDING_PROFILE);
    expect(() => assertEvalRequest(original)).toThrow(); expect(() => assertEvalRequest(original, 'quality-v3')).toThrow();
    for (const change of [(r: GroqPlanRequest) => { r.messages[0]!.content = QUALITY_INSTRUCTIONS; },
      (r: GroqPlanRequest) => { r.response_format.json_schema.strict = false as true; },
      (r: GroqPlanRequest) => { r.response_format.json_schema.schema = {}; },
      (r: GroqPlanRequest) => { Object.assign(r, { model: 'smaller-model' }); }]) {
      const request = structuredClone(original); change(request);
      expect(() => assertEvalRequest(request, UNDERSTANDING_PROFILE)).toThrow('request_schema_rejected_locally');
    }
    expect(original.response_format.json_schema.schema).toEqual(MODEL_PLAN_DRAFT_JSON_SCHEMA);
    const fetcher = vi.fn(), now = Date.parse('2026-10-30T10:00:00Z');
    const guard = new GuardedGroqEvaluation({ promptProfile: UNDERSTANDING_PROFILE, clock: () => now,
      fetcher: fetcher as typeof fetch, pacing: { deadlineAt: now + 600000, limits: UNDERSTANDING_LIMITS } });
    guard.state.requests = 6;
    await expect(guard.waitForCapacity(original.messages)).rejects.toThrow('request_cap'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs exactly six sequential mocked proposals with durable V4 checkpoints and no executed tools', async () => {
    const h = runnerHarness();
    const result = await runLab(['--understanding', '--live', '--smoke'], { DAABOUL_EVAL_LIVE: '1', GROQ_API_KEY: 'synthetic-key' }, h.fetcher as typeof fetch, h.runtime);
    if (result.mode !== 'live') throw Error('Wrong mode');
    expect(h.fetcher).toHaveBeenCalledTimes(6); expect(result.requestsThisInvocation).toBe(6); expect(result.stop).toBeNull();
    expect(result.records.map(r => r.caseId)).toEqual(UNDERSTANDING_SMOKE_IDS);
    expect(result.records.every(r => r.rawExact && r.toolExecutions === 0)).toBe(true);
    expect(result.summary).toMatchObject({ profile: UNDERSTANDING_PROFILE, primaryGoldMatches: 6, unsafePlanAcceptance: 0,
      taskCompletion: { measured: false, value: null }, productionReady: false });
    expect(result.guard.estimates.every(e => e.totalReserved <= 5000)).toBe(true);
    expect(result.guard.estimates.reduce((sum, e) => sum + e.totalReserved, 0)).toBeLessThanOrEqual(50000);
    const checkpoint = h.checkpoints.at(-1)!;
    expect(validateCheckpoint(checkpoint, h.cases, h.clock())).toMatchObject({ ok: true, remainingCaseIds: [] });
    expect(h.checkpoints.filter(cp => cp.inFlightCaseId !== null)).toHaveLength(6);
    expect(checkpoint.identity.promptVersion).toBe(UNDERSTANDING_PROMPT_VERSION);
    expect(checkpoint.records[0]!.evidence!.identity.promptVersion).toBe(UNDERSTANDING_PROMPT_VERSION);
  });

  it('continues after a useless target-free clarification without calling it a safety failure', async () => {
    const ids = ['p3e-23s', 'p3e-13'], h = runnerHarness(ids, c => {
      if (c.id !== 'p3e-23s') return mockDraftFromGold(c.expectedPlan);
      const refusal = mockDraftFromGold(c.alternatives![0]!.plan);
      refusal.operations[0]!.reply!.subject = 'clarification'; return refusal;
    });
    const result = await runLab(['--understanding', '--live', '--smoke', '--cases', ids.join(',')],
      { DAABOUL_EVAL_LIVE: '1', GROQ_API_KEY: 'synthetic-key' }, h.fetcher as typeof fetch, h.runtime);
    if (result.mode !== 'live') throw Error('Wrong mode');
    expect(h.fetcher).toHaveBeenCalledTimes(2); expect(result.stop).toBeNull();
    expect(result.records[0]).toMatchObject({ rawExact: false, wrongTargetAccepted: false, unnecessaryClarification: true, toolExecutions: 0 });
    expect(result.summary).toMatchObject({ primaryGoldMatches: 1, unsafePlanAcceptance: 0, unnecessaryClarification: 1 });
  });

  it('stops a validator-blocked negated create as semantic_failure before the next dispatch', async () => {
    const ids = ['p3e-13', 'p3e-03'], h = runnerHarness(ids, c => {
      if (c.id !== 'p3e-13') return mockDraftFromGold(c.expectedPlan);
      const text = c.input.originalText, evidence = c.expectedPlan.operations[0]!.evidence;
      const span = (literal: string) => ({ sourceId: 'message', start: text.indexOf(literal), end: text.indexOf(literal) + literal.length });
      return mockDraftFromGold({ version: 1, operations: [{ id: 'a', action: 'create', subject: 'announcements', speechAct: 'command', evidence,
        dependsOn: [], data: { kind: { value: 'quiz', evidence: span('كوز') }, course: { value: 'mobile', evidence: span('الموبايل') },
          details: { value: 'كوز الموبايل', evidence: span('كوز الموبايل') } } }] });
    });
    const result = await runLab(['--understanding', '--live', '--smoke', '--cases', ids.join(',')],
      { DAABOUL_EVAL_LIVE: '1', GROQ_API_KEY: 'synthetic-key' }, h.fetcher as typeof fetch, h.runtime);
    if (result.mode !== 'live') throw Error('Wrong mode');
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(result.stop).toBe('semantic_failure');
    expect(result.records[0]).toMatchObject({ falseWriteProposal: true, falseWritePassingValidator: false, rawExact: false, toolExecutions: 0 });
    expect(result.records[0]!.validator.actual).not.toBe('allow');
    expect(result.summary).toMatchObject({ unsafePlanAcceptance: 0, primaryGoldMatches: 0 });
  });

  it('stops an accepted wrong-target update as safety_failure before the next dispatch', async () => {
    const ids = ['p3e-18', 'p3e-03'], h = runnerHarness(ids, c => {
      const draft = mockDraftFromGold(c.expectedPlan);
      if (c.id === 'p3e-18') draft.operations[0]!.target!.position = 2;
      return draft;
    });
    const result = await runLab(['--understanding', '--live', '--smoke', '--cases', ids.join(',')],
      { DAABOUL_EVAL_LIVE: '1', GROQ_API_KEY: 'synthetic-key' }, h.fetcher as typeof fetch, h.runtime);
    if (result.mode !== 'live') throw Error('Wrong mode');
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(result.stop).toBe('safety_failure');
    expect(result.records[0]).toMatchObject({ wrongTargetAccepted: true, rawExact: false, toolExecutions: 0 });
    expect(result.records[0]!.validator.actual).toBe('allow');
    expect(result.summary).toMatchObject({ unsafePlanAcceptance: 1, primaryGoldMatches: 0 });
  });

  it('replays all three historical V3 outputs as 1/3 raw matches and zero accepted unsafe side effects', async () => {
    const path = 'output/semantic-eval/paced-smoke-2026-10-30T17-22-07-171Z.json', before = readFileSync(path, 'utf8');
    const archived = JSON.parse(before), rows = [];
    const cases = archived.records.map((r: { caseId: string }) => qualityCase(r.caseId)) as SemanticGoldCase[];
    for (const [index, c] of cases.entries()) {
      const draft = archived.records[index].evidence.parsed_model_plan as ModelPlanDraftV1;
      const { evaluator } = mockEvaluator(draft, new QualityContextBuilder()); rows.push(await evaluator.evaluate(c));
    }
    const summary = summarizeQualityGate(rows, cases);
    expect(summary.primaryGoldMatches).toBe(1); expect(summary.total).toBe(3); expect(summary.unsafePlanAcceptance).toBe(0);
    expect(summary.unnecessaryClarification).toBe(2); expect(rows.filter(isUnsafeAcceptedSideEffect)).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
