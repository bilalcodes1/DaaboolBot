import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { contractReplayCase, replayContractResults } from '../eval/semantic-contract-replay';
import { UNDERSTANDING_CASES, UNDERSTANDING_SMOKE_IDS } from '../eval/semantic-understanding-fixtures';

const path = 'output/semantic-eval/paced-smoke-2026-10-30T18-44-20-305Z.json';
const bytes = readFileSync(path);
const original = JSON.parse(bytes.toString('utf8'));
const originalGold = JSON.stringify(UNDERSTANDING_CASES);
type Result = Awaited<ReturnType<typeof replayContractResults>>;
let result: Result;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const row = (id: string) => result.results.find(r => r.caseId === id)!;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('Public network forbidden in contract replay'); }));
  result = await replayContractResults(structuredClone(original));
});
afterAll(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  expect(readFileSync(path)).toEqual(bytes);
  expect(JSON.stringify(UNDERSTANDING_CASES)).toBe(originalGold);
});

describe('unchanged six-case recorded Groq outputs replayed offline', () => {
  it('pins the original live file and preserves raw content, gold and historical measurements', () => {
    expect(hash(bytes)).toBe('4842c421798ed6f9fe3cb4032f509d4db02487f3a277c2326cc014d898bf46e0');
    expect(result.results.map(r => r.caseId)).toEqual(UNDERSTANDING_SMOKE_IDS);
    expect(result.sourceEvidenceHash).toBe(hash(JSON.stringify(original)));
    for (const [index, replay] of result.results.entries()) {
      const archived = original.records[index];
      expect(replay.rawModelContent).toBe(archived.evidence.raw_model_content);
      expect(replay.parsedModelPlan).toEqual(archived.evidence.parsed_model_plan);
      expect(replay.expectedGoldPlan).toEqual(archived.evidence.expected_gold_plan);
      expect(replay.originalLive).toEqual({ usage: archived.usage, latencyMs: archived.latencyMs,
        validator: archived.evidence.validator, normalization: archived.evidence.normalization });
    }
    expect(original.summary.unnecessaryClarification).toBe(0);
    expect(result.summary.rawUnnecessaryClarifications).toBe(1);
    expect(original.summary.primaryGoldMatches).toBe(0);
  });

  it('separates raw model scores, contract acceptance, permission decisions and execution', () => {
    expect(result).toMatchObject({ mode: 'offline_recorded_replay', liveRequests: 0, toolsExecuted: 0,
      goldFrozen: true, rawOutputsUnchanged: true });
    expect(result.summary).toMatchObject({ cases: 6, rawExactGoldMatches: 0, rawUnnecessaryClarifications: 1,
      alignedNormalizedGoldMatches: 2, alignedValidatorAccepted: 4, acceptedAuthorizedWriteProposals: 2,
      unsafeWriteProposalsAccepted: 0, provenValidatorFalseRejections: 0,
      executionSuccessMeasured: false, modelImprovementMeasured: false });
    expect(result.results.every(r => r.safety.toolsExecuted === 0 && r.safety.telegramSends === 0 && r.safety.productionWrites === 0)).toBe(true);
  });

  it('keeps omitted required details a real model/contract failure without inventing business content', () => {
    const replay = row('p3e-03');
    expect(replay.offlineRawRescore.exact).toBe(false);
    expect(replay.alignedContract).toMatchObject({ ok: false, reason: 'missing_information', missing: ['details'], normalizedPlan: null, validator: null });
    expect(replay.parsedModelPlan.operations[0].fields.map((f: { name: string }) => f.name)).not.toContain('details');
    expect(replay.diagnostics.modelErrors).toContain('wrong_entity');
    expect(replay.safety.acceptedWriteProposal).toBe(false);
  });

  it('admits an admin publication proposal but actually checks and denies the schema-valid student counterpart', () => {
    const admin = row('p3e-23a'), student = row('p3e-23s');
    for (const r of [admin, student]) {
      expect(r.alignedContract.ok).toBe(true);
      expect(r.alignedContract.normalizedComparison?.exact).toBe(true);
      expect(r.alignedContract.normalizedPlan!.operations[0]).toMatchObject({ action: 'publish', speechAct: 'command',
        targets: [{ type: 'previous_list', listId: 'phase3e-list', position: 2 }] });
      expect(r.diagnostics.validatorReached).toBe(true);
      expect(r.originalLive.validator).toBeNull();
      expect(r.alignedContract.contextOverlay).toBe('independent_app_intent_fixture_v1_not_historical_context');
    }
    expect(admin.alignedContract.validator).toEqual({ ok: true, issues: [] });
    expect(admin.safety.acceptedWriteProposal).toBe(true);
    expect(student.alignedContract.validator?.ok).toBe(false);
    expect(student.diagnostics.validatorReasons).toContain('permission_denied');
    expect(student.safety.acceptedWriteProposal).toBe(false);
  });

  it('retains the original wrong speech-act label while normalizing only the evidenced time patch', () => {
    const replay = row('p3e-18'), plan = replay.alignedContract.normalizedPlan!;
    expect(replay.offlineRawRescore.exact).toBe(false);
    expect(replay.alignedContract.normalizedComparison?.exact).toBe(false);
    expect(replay.alignedContract.validator).toEqual({ ok: true, issues: [] });
    const op = plan.operations[0]!;
    expect(op).toMatchObject({ action: 'update', speechAct: 'command', target: { type: 'previous_list', listId: 'phase3e-list', position: 1 } });
    if (op.action !== 'update') throw Error('Expected normalized update');
    expect(Object.keys(op.patch)).toEqual(['time']);
    expect(op.patch.time).toMatchObject({ mode: 'set', value: '09:45', evidence: { sourceId: 'message', start: 36, end: 41 } });
    expect(replay.parsedModelPlan.operations[0].fields[0].evidence).toEqual({ sourceId: 'message', start: 0, end: 42 });
    expect(replay.alignedContract.adjustments.some(a => a.kind === 'field_evidence')).toBe(true);
    expect(replay.diagnostics.modelErrors).toContain('wrong_speech_act');
  });

  it('keeps the unnecessary negation clarification and necessary ambiguous clarification distinct', () => {
    const negated = row('p3e-13'), ambiguous = row('p3e-30');
    expect(negated.offlineRawRescore.unnecessaryClarification).toBe(true);
    expect(negated.offlineRawRescore.failures).toContain('unnecessary_clarification');
    expect(ambiguous.offlineRawRescore.unnecessaryClarification).toBe(false);
    for (const r of [negated, ambiguous]) {
      expect(r.alignedContract.normalizedPlan!.operations[0]).toMatchObject({ action: 'reply', subject: 'clarification', speechAct: 'question' });
      expect(r.alignedContract.validator).toEqual({ ok: true, issues: [] });
      expect(r.safety.acceptedWriteProposal).toBe(false);
    }
    expect(ambiguous.diagnostics.modelErrors).toEqual(['wrong_speech_act']);
  });

  it('uses explicit independent application intent overlays and does not let model IDs or expected-plan mutations supply authority', () => {
    const admin = contractReplayCase('p3e-23a'), student = contractReplayCase('p3e-23s'), update = contractReplayCase('p3e-18');
    expect(admin.context.actor.verified).toBe(true); expect(student.context.actor.verified).toBe(true);
    expect(admin.context.actor.userId).toBe(admin.context.actor.ownerUid);
    expect(student.context.actor.userId).not.toBe(student.context.actor.ownerUid);
    expect(admin.context.allowedActions).toContain('publish'); expect(student.context.allowedActions).not.toContain('publish');
    for (const c of [admin, student]) {
      expect(c.context.requireTargetIntent).toBe(true);
      expect(c.context.instructions[0]).toMatchObject({ operationId: 'a', requiredDependencies: [],
        requestedTargets: [{ type: 'previous_list', listId: 'phase3e-list', position: 2 }] });
    }
    expect(update.context.instructions[0]!.requestedTargets).toEqual([{ type: 'previous_list', listId: 'phase3e-list', position: 1 }]);
    student.expectedPlan.operations = [];
    expect(contractReplayCase('p3e-23s').context.instructions[0]!.requestedTargets).toEqual([{ type: 'previous_list', listId: 'phase3e-list', position: 2 }]);
    expect(original.records[3].evidence.parsed_model_plan.operations[0].id).toBe('op1');
    expect(contractReplayCase('p3e-23s').context.actor).toEqual(student.context.actor);
  });

  const invalid: [string, (report: typeof original) => void][] = [
    ['missing case', r => r.records.pop()],
    ['wrong order', r => r.records.reverse()],
    ['missing evidence', r => { delete r.records[0].evidence; }],
    ['incomplete evidence', r => { r.records[0].evidence.complete = false; }],
    ['redacted original', r => { r.records[0].evidence.redacted = true; }],
    ['truncated original', r => { r.records[0].evidence.raw_truncated = true; }],
    ['malformed raw JSON', r => { r.records[0].evidence.raw_model_content = '{'; }],
    ['changed raw versus parsed plan', r => { const e = r.records[0].evidence; e.raw_model_content = JSON.stringify({ ...e.parsed_model_plan, operations: [] }); }],
    ['changed parsed versus raw plan', r => { r.records[0].evidence.parsed_model_plan.operations = []; }],
    ['jointly changed raw and parsed plan', r => { const e = r.records[0].evidence; e.parsed_model_plan.operations = []; e.raw_model_content = JSON.stringify(e.parsed_model_plan); }],
    ['changed source region inventory', r => { r.records[0].evidence.source_regions = []; }],
    ['changed recorded evidence verdict', r => { r.records[0].evidence.evidence_spans[0].checks.sourceExists = false; }],
    ['changed experiment identity', r => { r.identity.model = 'unapproved-model'; }],
    ['changed original source message', r => { r.records[0].evidence.original_message += ' changed'; }],
    ['changed frozen gold', r => { r.records[0].evidence.expected_gold_plan.operations = []; }],
  ];
  it.each(invalid)('rejects %s instead of fabricating missing historical evidence', async (_name, mutate) => {
    const changed = structuredClone(original); mutate(changed);
    await expect(replayContractResults(changed)).rejects.toThrow();
  });
});
