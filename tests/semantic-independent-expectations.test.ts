import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareOptionalCreateDetails, correctedP3e03Expectation, independentEvaluationCase,
  CORRECTED_P3E03_EXPECTATION_VERSION, INDEPENDENT_EXPECTATION_VERSION } from '../eval/semantic-independent-expectations';
import { buildIndependentScenario, INDEPENDENT_SCENARIO_IDS } from '../eval/semantic-independent-scenarios';
import { FinalContractContextBuilder } from '../eval/semantic-final-contract-prompt';
import { SemanticEvaluator } from '../src/semantic-eval';
import { isModelPlanDraft, type ModelPlanDraftV1 } from '../src/semantic-draft';

const report = (version: 'v4' | 'v5') => JSON.parse(readFileSync(`output/semantic-eval/${version === 'v4'
  ? 'paced-smoke-2026-10-30T18-44-20-305Z.json' : 'paced-smoke-2026-11-02T05-23-08-027Z.json'}`, 'utf8'));
function recordedCreate(version: 'v4' | 'v5' = 'v4'): ModelPlanDraftV1 {
  const row = report(version).records.find((r: { caseId: string }) => r.caseId === 'p3e-03');
  const raw: unknown = JSON.parse(row.evidence.raw_model_content);
  if (!isModelPlanDraft(raw)) throw Error('Recorded fixture is not valid strict draft');
  return raw;
}
const corrected = (raw: unknown) => {
  const gold = correctedP3e03Expectation(); return compareOptionalCreateDetails(gold.expectedPlan, raw, gold.sources);
};
const details = (value: string | null = null) => ({ name: 'details' as const, mode: 'set' as const,
  value, dateKind: null, evidence: { sourceId: 'message', start: 0, end: 36 } });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in independent expectation tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('versioned optional-details expectation, separate from historical scoring', () => {
  it('corrects the demonstrable old requirement without changing either actual response or old score', () => {
    const old = report('v4'), current = report('v5'), before = JSON.stringify([old, current]);
    expect(old.records.find((r: { caseId: string }) => r.caseId === 'p3e-03').rawExact).toBe(false);
    expect(current.records.find((r: { caseId: string }) => r.caseId === 'p3e-03').rawExact).toBe(false);
    expect(correctedP3e03Expectation().datasetVersion).toBe(CORRECTED_P3E03_EXPECTATION_VERSION);
    expect(correctedP3e03Expectation().originalTimestamp).toBe(Date.parse('2026-10-30T09:00:00+03:00'));
    const v4 = corrected(recordedCreate()), v5 = corrected(recordedCreate('v5'));
    expect(v4.historicalComparison.exact).toBe(false); expect(v4.correctedComparison.exact).toBe(true);
    expect(v5.historicalComparison.exact).toBe(false); expect(v5.correctedComparison.exact).toBe(false);
    expect(v5.correctedComparison.action).toBe(false); expect(v5.correctedComparison.speechAct).toBe(false);
    expect(JSON.stringify([old, current])).toBe(before);
  });

  it.each(['absent', 'null', 'literal'] as const)('permits %s extra details without altering raw fields or evidence', mode => {
    const raw = recordedCreate();
    if (mode !== 'absent') raw.operations[0]!.fields!.push(details(mode === 'null' ? null : 'كوز Mobile Applications'));
    const before = structuredClone(raw), result = corrected(raw);
    expect(result.detailsValid).toBe(true); expect(result.detailsIssues).toEqual([]);
    expect(result.correctedComparison.exact).toBe(true); expect(raw).toEqual(before);
    expect(result.historicalComparison.exact).toBe(mode === 'literal');
  });

  it.each(['invented', 'empty', 'clear', 'date_kind', 'duplicate', 'unknown_source', 'out_of_bounds', 'outside_action'] as const)(
    'does not hide %s details behind the optional-field policy', fault => {
      const raw = recordedCreate(), supplied = details('كوز Mobile Applications');
      raw.operations[0]!.fields!.push(supplied);
      if (fault === 'invented') supplied.value = 'Unstated material';
      if (fault === 'empty') supplied.value = '';
      if (fault === 'clear') Object.assign(supplied, { mode: 'clear', value: null });
      if (fault === 'date_kind') Object.assign(supplied, { dateKind: 'relative' });
      if (fault === 'duplicate') raw.operations[0]!.fields!.push(structuredClone(supplied));
      if (fault === 'unknown_source') supplied.evidence.sourceId = 'missing';
      if (fault === 'out_of_bounds') supplied.evidence.end = 37;
      if (fault === 'outside_action') raw.operations[0]!.evidence.end = 30;
      const result = corrected(raw);
      expect(result.detailsValid).toBe(false); expect(result.correctedComparison.exact).toBe(false);
    });

  it('does not erase source provenance or permit a quoted create as a corrected raw match', () => {
    const gold = correctedP3e03Expectation(), raw = recordedCreate();
    gold.sources.push({ id: 'quoted', kind: 'quote', text: gold.originalText, messageStart: 0 });
    const result = compareOptionalCreateDetails(gold.expectedPlan, raw, gold.sources);
    expect(result.detailsValid).toBe(false); expect(result.correctedComparison.exact).toBe(false);
  });

  it('preserves strict JSON requirements when a nullable field key is missing', () => {
    const raw = recordedCreate(); raw.operations[0]!.fields!.push(details());
    delete (raw.operations[0]!.fields!.at(-1)! as unknown as Record<string, unknown>).value;
    const result = corrected(raw);
    expect(result.detailsValid).toBe(false); expect(result.detailsIssues[0]!.reason).toBe('invalid_model_draft');
  });

  it.each(['kind', 'course', 'date'] as const)('still requires the supplied %s meaning', missing => {
    const raw = recordedCreate(); raw.operations[0]!.fields = raw.operations[0]!.fields!.filter(f => f.name !== missing);
    expect(corrected(raw).correctedComparison.exact).toBe(false);
  });

  it('does not excuse invented time or group', () => {
    for (const field of ['time', 'audience'] as const) {
      const raw = recordedCreate(); raw.operations[0]!.fields!.push({ name: field, mode: 'set',
        value: field === 'time' ? '10:00' : 'all', dateKind: null, evidence: { ...raw.operations[0]!.evidence } });
      expect(corrected(raw).correctedComparison.exact).toBe(false);
    }
  });

  it.each(['clear_kind', 'course_date_kind', 'missing_source', 'outside_bounds', 'outside_action', 'null_course', 'irrelevant_tool'] as const)(
    'does not score structurally invalid create extraction as correct: %s', fault => {
      const raw = recordedCreate(), op = raw.operations[0]!, kind = op.fields!.find(f => f.name === 'kind')!, course = op.fields!.find(f => f.name === 'course')!;
      if (fault === 'clear_kind') kind.mode = 'clear';
      if (fault === 'course_date_kind') course.dateKind = 'relative';
      if (fault === 'missing_source') course.evidence.sourceId = 'missing';
      if (fault === 'outside_bounds') course.evidence.end = 37;
      if (fault === 'outside_action') op.evidence.end = 30;
      if (fault === 'null_course') course.value = null;
      if (fault === 'irrelevant_tool') op.tool = 'get_courses';
      const result = corrected(raw);
      expect(result.correctedComparison.exact).toBe(false); expect(result.createFieldsValid).toBe(false);
      expect(result.createFieldIssues.length).toBeGreaterThan(0);
    });
});

describe('independent expectations reuse the existing evaluator without granting authority', () => {
  it.each(INDEPENDENT_SCENARIO_IDS)('attaches labels after building %s and never changes model context', id => {
    const scenario = buildIndependentScenario(id), gold = independentEvaluationCase(id), builder = new FinalContractContextBuilder();
    expect(gold.datasetVersion).toBe(INDEPENDENT_EXPECTATION_VERSION);
    expect(gold.context).toEqual(scenario.context); expect(gold.input).toEqual(scenario.input);
    const before = builder.build(scenario.input, scenario.context).messages;
    gold.expectedPlan.operations = []; gold.expectedValidator = 'allow'; gold.expectation.note = 'FAKE GOLD ADMIN';
    expect(builder.build(gold.input, gold.context).messages).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('FAKE GOLD ADMIN');
    expect(independentEvaluationCase(id).expectedPlan.operations.length).toBe(1);
  });

  it('keeps old raw score and corrected optional-field score explicitly separate', async () => {
    const gold = independentEvaluationCase('p3h-create-positive'), raw = recordedCreate();
    const transport = vi.fn(async () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] } }));
    const evaluator = new SemanticEvaluator(transport, 'offline_mock', 1000, 1024, undefined, new FinalContractContextBuilder());
    const row = await evaluator.evaluate(gold);
    expect(row.source).toBe('offline_mock'); expect(row.rawExact).toBe(false);
    expect(row.validator.actual).toBe('allow'); expect(row.toolExecutions).toBe(0);
    const explicitV2 = compareOptionalCreateDetails(gold.expectedPlan, raw, gold.context.sources);
    expect(explicitV2.correctedComparison.exact).toBe(true); expect(row.rawExact).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('cannot grant a student publication by changing gold labels to admin success', async () => {
    const gold = independentEvaluationCase('p3h-samepublish-student'), text = gold.input.originalText;
    gold.expectedValidator = 'allow';
    const raw: ModelPlanDraftV1 = { version: 1, operations: [{ id: 'arbitrary-model-id', action: 'publish', speechAct: 'command',
      evidence: { sourceId: 'message', start: 0, end: text.length }, dependsOn: [], tool: null, arguments: null, fields: null, reply: null,
      target: null, targets: [{ type: 'previous_list', listId: 'phase3h-list', position: 2, text: null, sourceId: null, evidence: null }] }] };
    const evaluator = new SemanticEvaluator(async () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] } }),
      'offline_mock', 1000, 1024, undefined, new FinalContractContextBuilder());
    const row = await evaluator.evaluate(gold);
    expect(row.rawExact).toBe(true); expect(row.validator.actual).toBe('deny');
    expect(row.validator.reasons).toContain('permission_denied'); expect(row.toolExecutions).toBe(0);
    expect(gold.context.allowedActions).not.toContain('publish');
  });

  it('records independent scenario provenance, not a production intent supplier claim', () => {
    const gold = independentEvaluationCase('p3h-create-positive');
    expect(gold.provenance.productionIntentSupplier).toBe(false); expect(gold.provenance.annotator).toBe('synthetic_design_annotation');
    expect(gold.expectation.optionalCreateDetails).toBe(true);
    expect(independentEvaluationCase('p3h-create-missing-course').expectation.missingRequired).toEqual(['course']);
    expect(independentEvaluationCase('p3h-stalesnapshot').expectation.expectedRejection).toEqual({ stage: 'normalization', reason: 'stale_reference' });
  });
});
