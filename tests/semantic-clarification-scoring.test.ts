import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { UNDERSTANDING_CASES } from '../eval/semantic-understanding-fixtures';
import { UnderstandingContextBuilder } from '../eval/semantic-understanding-prompt';
import { summarizeQualityGate } from '../eval/semantic-quality-gate';
import { isUnsafeAcceptedSideEffect, SemanticEvaluator, summarizeEvaluation, type SemanticGoldCase } from '../src/semantic-eval';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const path = 'output/semantic-eval/paced-smoke-2026-10-30T18-44-20-305Z.json';
const fixture = (id: string) => structuredClone(UNDERSTANDING_CASES.find(c => c.id === id)!);
const archived = () => JSON.parse(readFileSync(path, 'utf8')) as { records: { caseId: string; evidence: { parsed_model_plan: unknown } }[] };
const evaluate = (gold: SemanticGoldCase, raw: unknown) => new SemanticEvaluator(async () => ({ status: 200,
  body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] } }),
'offline_mock', 1000, 1024, undefined, new UnderstandingContextBuilder()).evaluate(gold);

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in clarification scoring tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('observed clarification scoring independent of safe abstention', () => {
  it('counts the real V4 negation clarification without inflating understanding or security failures', async () => {
    const before = readFileSync(path, 'utf8'), gold = fixture('p3e-13');
    expect(gold.abstentionExpected).toBe(true); expect(gold.ambiguity).toBe(false);
    const raw = archived().records.find(r => r.caseId === gold.id)!.evidence.parsed_model_plan;
    const row = await evaluate(gold, raw);
    expect(row.unnecessaryClarification).toBe(true); expect(row.failures).toContain('unnecessary_clarification');
    expect(row.ambiguityCorrect).toBe(false); expect(row.validator.actual).toBe('allow');
    expect(row.rawExact).toBe(false); expect(row.correctCompletion).toBe(false);
    expect(row.safeAbstention).toBe(true); expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    expect(summarizeQualityGate([row], [gold], 'understanding-v4')).toMatchObject({
      unnecessaryClarification: 1, primaryGoldMatches: 0, unsafePlanAcceptance: 0,
      taskCompletion: { measured: false, value: null },
    });
    expect(summarizeEvaluation([row], [gold]).usability.unnecessaryClarification).toMatchObject({ correct: 1, total: 1 });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('does not count the real V4 ambiguous-target clarification as unnecessary or exact semantic success', async () => {
    const gold = fixture('p3e-30'), raw = archived().records.find(r => r.caseId === gold.id)!.evidence.parsed_model_plan;
    const row = await evaluate(gold, raw);
    expect(row.unnecessaryClarification).toBe(false); expect(row.ambiguityCorrect).toBe(true);
    expect(row.failures).not.toContain('unnecessary_clarification'); expect(row.failures).not.toContain('missed_ambiguity');
    expect(row.rawExact).toBe(false); expect(row.failures).toContain('wrong_speech_act');
    expect(row.correctCompletion).toBe(false); expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
  });

  it('keeps a correctly understood negation safe without inventing clarification', async () => {
    const gold = fixture('p3e-13'), row = await evaluate(gold, mockDraftFromGold(gold.expectedPlan));
    expect(row.rawExact).toBe(true); expect(row.ambiguityCorrect).toBe(true);
    expect(row.unnecessaryClarification).toBe(false); expect(row.failures).not.toContain('unnecessary_clarification');
    expect(row.toolExecutions).toBe(0);
  });

  it('counts an unnecessary student-publish clarification even when rejection was expected', async () => {
    const gold = fixture('p3e-23s'), draft = mockDraftFromGold(gold.alternatives![0]!.plan);
    draft.operations[0]!.reply!.subject = 'clarification';
    const row = await evaluate(gold, draft);
    expect(row.validator.actual).toBe('allow'); expect(row.unnecessaryClarification).toBe(true);
    expect(row.failures).toContain('unnecessary_clarification'); expect(row.rawExact).toBe(false);
    expect(row.correctCompletion).toBe(false); expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
  });

  it('keeps a safe refusal distinct from unnecessary clarification and primary intent success', async () => {
    const gold = fixture('p3e-23s'), row = await evaluate(gold, mockDraftFromGold(gold.alternatives![0]!.plan));
    expect(row.unnecessaryClarification).toBe(false); expect(row.failures).not.toContain('unnecessary_clarification');
    expect(row.safeAbstention).toBe(true); expect(isUnsafeAcceptedSideEffect(row)).toBe(false);
    expect(summarizeQualityGate([row], [gold], 'understanding-v4')).toMatchObject({
      primaryGoldMatches: 0, acceptedSafeAlternatives: 1, unnecessaryClarification: 0,
      taskCompletion: { measured: false, value: null },
    });
  });

  it('records genuinely missed ambiguity only when a valid model plan was observed', async () => {
    const gold = fixture('p3e-30'), draft = mockDraftFromGold(gold.expectedPlan);
    draft.operations[0]!.reply!.subject = 'conversation';
    const row = await evaluate(gold, draft);
    expect(row.unnecessaryClarification).toBe(false); expect(row.ambiguityCorrect).toBe(false);
    expect(row.failures).toContain('missed_ambiguity'); expect(row.failures).not.toContain('unnecessary_clarification');
  });

  it.each(['p3e-13', 'p3e-30'])('leaves absent output unscored for clarification in %s', async id => {
    const gold = fixture(id), row = await new SemanticEvaluator(async () => ({ status: 503, body: {} }),
      'offline_mock', 1000, 1024, undefined, new UnderstandingContextBuilder()).evaluate(gold);
    expect(row.modelOutputReceived).toBe(false); expect(row.unnecessaryClarification).toBe(false);
    expect(row.failures).not.toContain('unnecessary_clarification'); expect(row.failures).not.toContain('missed_ambiguity');
    expect(row.correctCompletion).toBe(false);
    const summary = summarizeEvaluation([row], [gold]);
    expect(summary.understanding.ambiguity.total).toBe(0); expect(summary.understanding.rawPlan.total).toBe(0);
    expect(summarizeQualityGate([row], [gold], 'understanding-v4').intent).toMatchObject({ total: 0, unscored: 1 });
  });

  it('does not pretend malformed JSON expressed or missed clarification', async () => {
    const gold = fixture('p3e-30'), row = await new SemanticEvaluator(async () => ({ status: 200,
      body: { choices: [{ finish_reason: 'stop', message: { content: '{invalid-json' } }] } }),
    'offline_mock', 1000, 1024, undefined, new UnderstandingContextBuilder()).evaluate(gold);
    expect(row.modelOutputReceived).toBe(true); expect(row.modelPlan).toBeNull();
    expect(row.unnecessaryClarification).toBe(false); expect(row.correctCompletion).toBe(false);
    expect(row.failures).not.toContain('unnecessary_clarification'); expect(row.failures).not.toContain('missed_ambiguity');
    expect(row.failures).toContain('invalid_or_unsupported_plan');
  });
});
