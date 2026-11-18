import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { UNDERSTANDING_CASES } from '../eval/semantic-understanding-fixtures';
import { normalizeAlignedModelPlan, orderSemanticProposals } from '../src/semantic-contract-alignment';
import { normalizeModelPlan, type ModelPlanDraftV1 } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';
import type { SemanticPlanV1, SemanticTarget } from '../src/semantic-plan';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const archivePath = 'output/semantic-eval/paced-smoke-2026-10-30T18-44-20-305Z.json';
const listTarget = (position: number): SemanticTarget => ({ type: 'previous_list', listId: 'phase3e-list', position });
/** Independently specified target intent; never copied from evaluated output or gold plans. */
function fixture(id = 'p3e-18') {
  const c = structuredClone(UNDERSTANDING_CASES.find(c => c.id === id)!);
  const manifest: Record<string, Record<string, number[]>> = {
    'p3e-18': { a: [1] }, 'p3e-19': { a: [1] }, 'p3e-23a': { a: [2] },
    'p3e-23s': { a: [2] }, 'p3e-31': { a: [1], b: [1] },
  };
  c.context.requireTargetIntent = true;
  c.context.instructions = c.context.instructions.map(i => ({ ...i,
    ...(manifest[id]?.[i.operationId] ? { requestedTargets: manifest[id]![i.operationId]!.map(listTarget) } : {}),
  }));
  return c;
}
function recorded(id: string): ModelPlanDraftV1 {
  return JSON.parse(readFileSync(archivePath, 'utf8')).records.find((r: { caseId: string }) => r.caseId === id).evidence.parsed_model_plan;
}
const aligned = (id = 'p3e-18') => { const c = fixture(id); return { c, draft: mockDraftFromGold(c.expectedPlan) }; };
const reason = (result: ReturnType<typeof normalizeAlignedModelPlan>) => result.ok ? null : result.reason;

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in contract alignment tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('canonical targets with independently bound intent', () => {
  it('accepts one canonical targets[] update, with deterministic singular internal target', () => {
    const { c, draft } = aligned();
    draft.operations[0]!.targets = [draft.operations[0]!.target!]; draft.operations[0]!.target = null;
    const result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    expect(result.plan.operations[0]).toMatchObject({ action: 'update', target: listTarget(1), patch: { time: { mode: 'set', value: '09:45' } } });
    expect(result.adjustments.map(a => a.kind)).toContain('target_container');
    expect(validateSemanticPlan(result.plan, c.context).ok).toBe(true);
  });

  it('accepts equivalent legacy singular publication but keeps canonical internal targets[]', () => {
    const { c, draft } = aligned('p3e-23a');
    draft.operations[0]!.target = draft.operations[0]!.targets![0]!; draft.operations[0]!.targets = null;
    expect(normalizeModelPlan(draft, c.context.sources).ok).toBe(false);
    const result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    expect(result.plan.operations[0]).toMatchObject({ action: 'publish', targets: [listTarget(2)] });
    expect(result.adjustments.map(a => a.kind)).toContain('target_container');
    expect(validateSemanticPlan(result.plan, c.context).ok).toBe(true);
  });

  it('keeps multiple publication targets without silently reducing to one record', () => {
    const { c, draft } = aligned('p3e-23a');
    const text = 'انشر التبليغ الأول والثاني للطلاب.';
    c.input.originalText = text; c.context.originalText = text;
    c.context.sources = c.context.sources.map(s => s.kind === 'current' ? { ...s, text } : s);
    const evidence = { sourceId: 'message', start: 0, end: text.length };
    c.context.instructions[0]!.evidence = evidence; draft.operations[0]!.evidence = evidence;
    c.context.instructions[0]!.requestedTargets = [listTarget(2), listTarget(1)];
    const second = structuredClone(draft.operations[0]!.targets![0]!); second.position = 1;
    draft.operations[0]!.targets!.push(second);
    const result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    expect(result.plan.operations[0]).toMatchObject({ action: 'publish', targets: [listTarget(2), listTarget(1)] });
    expect(validateSemanticPlan(result.plan, c.context).ok).toBe(true);
  });

  it('rejects both target containers even when they appear equivalent', () => {
    const { c, draft } = aligned(); draft.operations[0]!.targets = [structuredClone(draft.operations[0]!.target!)];
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('conflicting_targets');
  });

  it('rejects multiple update targets instead of choosing a record', () => {
    const { c, draft } = aligned(), first = draft.operations[0]!.target!, second = structuredClone(first); second.position = 2;
    draft.operations[0]!.target = null; draft.operations[0]!.targets = [first, second];
    c.context.instructions[0]!.requestedTargets = [listTarget(1), listTarget(2)];
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('ambiguous_target');
  });

  it('rejects the wrong otherwise-resolvable target and missing target intent', () => {
    const { c, draft } = aligned(); draft.operations[0]!.target!.position = 2;
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('unrequested_target');
    draft.operations[0]!.target!.position = 1; delete c.context.instructions[0]!.requestedTargets;
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('unrequested_target');
  });

  it.each(['missing', 'duplicate', 'multiple'] as const)('rejects %s snapshot resolution', variant => {
    const { c, draft } = aligned(), first = c.context.targetBindings[0]!;
    if (variant === 'missing') c.context.targetBindings = [];
    else if (variant === 'duplicate') c.context.targetBindings = [first, structuredClone(first)];
    else first.snapshots = [...first.snapshots, structuredClone(first.snapshots[0]!)];
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe(variant === 'missing' ? 'unresolved_target' : 'ambiguous_target');
  });

  it.each(['botId', 'chatId', 'threadId', 'userId'] as const)('rejects cross-%s selector resolution', axis => {
    const { c, draft } = aligned(), binding = c.context.targetBindings[0]!;
    binding.scope = { ...binding.scope, [axis]: axis === 'threadId' ? 77 : binding.scope[axis]! + 1 };
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('scope_mismatch');
  });

  it.each([0, Infinity, NaN])('rejects expired or invalid expiry %s', expiresAt => {
    const { c, draft } = aligned(); c.context.targetBindings[0]!.expiresAt = expiresAt;
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('expired_reference');
  });

  it('rejects a stale version rather than repairing it', () => {
    const { c, draft } = aligned(); c.context.targetBindings[0]!.snapshots[0]!.currentRevision = 2;
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('stale_reference');
  });
});

describe('evidence, field omission and identity equivalence', () => {
  it('replays the original publication/update drafts without mutating raw results or trusted context', () => {
    const before = readFileSync(archivePath, 'utf8');
    for (const id of ['p3e-23a', 'p3e-23s', 'p3e-18']) {
      const c = fixture(id), draft = recorded(id), rawBefore = structuredClone(draft), trustedBefore = structuredClone(c.context);
      const result = normalizeAlignedModelPlan(draft, c.context);
      expect(result.ok).toBe(true); if (!result.ok) throw Error('Recorded equivalent form should align');
      expect(result.adjustments.map(a => a.kind)).toContain('operation_id');
      expect(result.adjustments.map(a => a.kind)).toContain('list_annotation');
      expect(draft).toEqual(rawBefore); expect(c.context).toEqual(trustedBefore);
      const checked = validateSemanticPlan(result.plan, c.context);
      if (id === 'p3e-23s') {
        expect(checked.ok).toBe(false); if (checked.ok) throw Error('Student publish must fail');
        expect(checked.issues.map(i => i.reason)).toContain('permission_denied');
      } else expect(checked.ok).toBe(true);
    }
    expect(readFileSync(archivePath, 'utf8')).toBe(before);
  });

  it('keeps required details missing and does not fabricate optional fields in the real create output', () => {
    const c = fixture('p3e-03'), draft = recorded('p3e-03'), before = structuredClone(draft);
    const result = normalizeAlignedModelPlan(draft, c.context);
    expect(result).toMatchObject({ ok: false, reason: 'missing_information', missing: ['details'] });
    expect(draft).toEqual(before); expect(draft.operations[0]!.fields!.map(f => f.name)).toEqual(['kind', 'course', 'date']);
  });

  it('canonicalizes only an evidenced course alias and leaves absent optional business data absent', () => {
    const { c, draft } = aligned('p3e-03');
    draft.operations[0]!.fields!.find(f => f.name === 'course')!.value = 'Mobile Applications';
    const result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    const op = result.plan.operations[0]!; if (op.action !== 'create') throw Error('Expected create');
    expect(op.data.course!.value).toBe('mobile');
    for (const key of ['time', 'audience', 'coverage', 'component', 'claimedCertainty']) expect(op.data).not.toHaveProperty(key);
    expect(result.adjustments.map(a => a.kind)).toContain('course_alias');
    expect(validateSemanticPlan(result.plan, c.context).ok).toBe(true);
  });

  it('rejects an alias contradicted by its real source span', () => {
    const { c, draft } = aligned('p3e-03'); draft.operations[0]!.fields!.find(f => f.name === 'course')!.value = 'Networks';
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('ungrounded_value');
  });

  it('does not turn explicit clear into omission or invent replacement data', () => {
    const { c, draft } = aligned('p3e-19'), result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    const op = result.plan.operations[0]!; if (op.action !== 'update') throw Error('Expected update');
    expect(Object.keys(op.patch)).toEqual(['time']); expect(op.patch.time).toMatchObject({ mode: 'clear' });
    expect(op.patch.time).not.toHaveProperty('value');
  });

  it.each(['unknown_source', 'wrong_annotation_source', 'outside_bounds', 'quote', 'overlap_quote'] as const)('rejects %s evidence instead of fabricating source provenance', variant => {
    const c = fixture('p3e-18'), draft = recorded('p3e-18'), op = draft.operations[0]!;
    if (variant === 'unknown_source') op.evidence.sourceId = 'missing';
    if (variant === 'wrong_annotation_source') op.target!.sourceId = 'missing';
    if (variant === 'outside_bounds') op.evidence.end = c.input.originalText.length + 1;
    if (variant === 'quote') op.target!.evidence = { sourceId: 'prior-list', start: 0, end: 1 };
    if (variant === 'overlap_quote') c.context.sources = [...c.context.sources,
      { id: 'marked-quote', kind: 'quote', text: c.input.originalText.slice(0, 3), messageStart: 0 }];
    const result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(false); expect(['invalid_evidence', 'quoted_instruction', 'source_region_mismatch']).toContain(reason(result));
  });

  it('localizes broad update field evidence only to the independently attested matching value', () => {
    const c = fixture('p3e-18'), raw = recorded('p3e-18'), result = normalizeAlignedModelPlan(raw, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    const op = result.plan.operations[0]!; if (op.action !== 'update') throw Error('Expected update');
    expect(op.patch.time).toEqual(c.context.instructions[0]!.requestedChanges!.time);
    expect(result.adjustments.map(a => a.kind)).toContain('field_evidence');
    raw.operations[0]!.fields![0]!.value = '10:45';
    const wrong = normalizeAlignedModelPlan(raw, c.context);
    expect(wrong.ok).toBe(true); if (!wrong.ok) throw Error('Keep unaligned field for validator rejection');
    const rejected = validateSemanticPlan(wrong.plan, c.context);
    expect(rejected.ok).toBe(false); if (rejected.ok) throw Error('Unrequested value cannot pass');
    expect(rejected.issues.map(i => i.reason)).toContain('unrequested_patch');
  });

  it('rejects localization from a source span that does not contain the independently attested value', () => {
    const c = fixture('p3e-18'), raw = recorded('p3e-18'); raw.operations[0]!.fields![0]!.evidence = { sourceId: 'message', start: 0, end: 3 };
    expect(reason(normalizeAlignedModelPlan(raw, c.context))).toBe('invalid_evidence');
  });

  it('does not create an instruction from a model operation or claimed role', () => {
    const c = fixture('p3e-18'), raw = recorded('p3e-18'); c.context.instructions = [];
    expect(reason(normalizeAlignedModelPlan(raw, c.context))).toBe('intent_not_established');
    const student = fixture('p3e-23s'), publish = recorded('p3e-23s');
    const result = normalizeAlignedModelPlan(publish, student.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Correct shape remains unauthorized');
    const rejected = validateSemanticPlan(result.plan, student.context);
    expect(rejected.ok).toBe(false); if (rejected.ok) throw Error('No model-provided admin authority');
    expect(rejected.issues.map(i => i.reason)).toContain('permission_denied');
  });

  it('rejects ambiguous independent attestations rather than selecting an operation identity', () => {
    const { c, draft } = aligned(); c.context.instructions = [...c.context.instructions, { ...c.context.instructions[0]!, operationId: 'second' }];
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe('intent_not_established');
  });

  it('maps operation IDs bijectively and remaps only dependency references', () => {
    const { c, draft } = aligned('p3e-31'); draft.operations[0]!.id = 'op-update'; draft.operations[1]!.id = 'op-publish';
    draft.operations[1]!.dependsOn = ['op-update'];
    const rawBefore = structuredClone(draft), contextBefore = structuredClone(c.context), result = normalizeAlignedModelPlan(draft, c.context);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('Expected normalization');
    expect(result.plan.operations.map(o => [o.id, o.dependsOn])).toEqual([['a', []], ['b', ['a']]]);
    expect(result.adjustments.filter(a => a.kind === 'operation_id')).toHaveLength(2);
    expect(result.plan.operations.map(o => o.speechAct)).toEqual(['correction', 'command']);
    expect(draft).toEqual(rawBefore); expect(c.context).toEqual(contextBefore);
    expect(validateSemanticPlan(result.plan, c.context).ok).toBe(true);
  });

  it.each(['missing', 'duplicate', 'empty'] as const)('rejects %s operation/dependency identities', variant => {
    const { c, draft } = aligned('p3e-31');
    if (variant === 'missing') draft.operations[1]!.dependsOn = ['absent'];
    if (variant === 'duplicate') draft.operations[1]!.id = draft.operations[0]!.id;
    if (variant === 'empty') draft.operations[0]!.id = '';
    expect(reason(normalizeAlignedModelPlan(draft, c.context))).toBe(variant === 'missing' ? 'invalid_dependency' : variant === 'duplicate' ? 'duplicate_operation' : 'invalid_model_draft');
  });
});

describe('static proposal dependency order without execution', () => {
  it('returns an owned topological order without claiming execution or changing the input', () => {
    const plan = fixture('p3e-31').expectedPlan, before = structuredClone(plan);
    plan.operations.reverse(); const reversed = structuredClone(plan);
    const result = orderSemanticProposals(plan);
    expect(result.map(o => o.id)).toEqual(['a', 'b']); expect(plan).toEqual(reversed);
    expect(result).not.toBe(plan.operations); expect(Object.keys(result[0]!)).not.toContain('status');
    expect(Object.keys(result[1]!)).not.toContain('delivery');
    expect(before.operations.map(o => o.id)).toEqual(['a', 'b']);
  });

  it.each(['cycle', 'self_cycle', 'unknown', 'duplicate'] as const)('rejects %s dependency graphs', kind => {
    const plan: SemanticPlanV1 = fixture('p3e-31').expectedPlan;
    if (kind === 'cycle') plan.operations[0]!.dependsOn = ['b'];
    if (kind === 'self_cycle') plan.operations[0]!.dependsOn = ['a'];
    if (kind === 'unknown') plan.operations[0]!.dependsOn = ['missing'];
    if (kind === 'duplicate') plan.operations[1]!.id = 'a';
    expect(() => orderSemanticProposals(plan)).toThrow(/dependency/iu);
  });
  it('bounds static proposal ordering before traversing oversized input', () => {
    const op=fixture('p3e-31').expectedPlan.operations[0]!;
    expect(()=>orderSemanticProposals({version:1,operations:Array.from({length:13},(_,i)=>({...op,id:`op${i}`,dependsOn:[]}))})).toThrow('Too many proposal operations');
  });
});
