import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIndependentScenario } from '../eval/semantic-independent-scenarios';
import { finalContractCase } from '../eval/semantic-final-contract';
import { FinalContractContextBuilder, FINAL_CONTRACT_INSTRUCTIONS } from '../eval/semantic-final-contract-prompt';
import { UnderstandingContextBuilder, UNDERSTANDING_INSTRUCTIONS } from '../eval/semantic-understanding-prompt';
import { UNDERSTANDING_CASES } from '../eval/semantic-understanding-fixtures';
import { GroqPlanner } from '../src/groq-planner';
import { SemanticCompiler } from '../src/semantic-compiler';
import { normalizeFinalContractModelPlan } from '../src/semantic-contract-alignment';
import { isModelPlanDraft, type DraftOperation, type ModelPlanDraftV1 } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';

const message = 'Create كوز Mobile Applications باچر.';
const whole = { sourceId: 'message', start: 0, end: message.length };
function field(name: 'kind' | 'course' | 'date' | 'details', value: string | null, literal: string) {
  const start = message.indexOf(literal);
  return { name, mode: 'set' as const, value, dateKind: name === 'date' ? 'relative' as const : null,
    evidence: { sourceId: 'message', start, end: start + literal.length } };
}
/** Independently authored proposals; no gold-to-model response generator. */
function createDraft(): ModelPlanDraftV1 {
  return { version: 1, operations: [{ id: 'model-request', action: 'create', speechAct: 'command', evidence: { ...whole },
    tool: null, arguments: null, target: null, targets: null, dependsOn: [], reply: null,
    fields: [field('kind', 'quiz', 'كوز'), field('course', 'mobile', 'Mobile Applications'), field('date', 'باچر', 'باچر')] }] };
}
function replyDraft(text: string, subject: 'conversation' | 'clarification', speechAct: DraftOperation['speechAct']): ModelPlanDraftV1 {
  return { version: 1, operations: [{ id: 'model-reply', action: 'reply', speechAct,
    evidence: { sourceId: 'message', start: 0, end: text.length }, dependsOn: [], tool: null, arguments: null,
    target: null, targets: null, fields: null, reply: { subject, text: subject === 'conversation' ? 'حاضر، ما أضيفه.' : 'أي مادة تقصد؟' } }] };
}
async function compile(raw: ModelPlanDraftV1, id: Parameters<typeof buildIndependentScenario>[0] = 'p3h-create-positive') {
  const scenario = buildIndependentScenario(id);
  const transport = vi.fn(async () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] } }));
  const compiler = new SemanticCompiler(new GroqPlanner(transport), new FinalContractContextBuilder(), normalizeFinalContractModelPlan);
  const result = await compiler.compile(scenario.input, scenario.context);
  expect(transport).toHaveBeenCalledTimes(1);
  return { scenario, result };
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in create integrity tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('independent create data sufficiency, without semantic output repair', () => {
  it.each(['omitted', 'null', 'literal'] as const)('accepts %s optional details, preserving actual supplied fields only', async mode => {
    const raw = createDraft();
    if (mode !== 'omitted') raw.operations[0]!.fields!.push(field('details', mode === 'null' ? null : 'كوز Mobile Applications', mode === 'null' ? message : 'كوز Mobile Applications'));
    const untouched = structuredClone(raw), { result } = await compile(raw);
    expect(result.status).toBe('proposal_only'); expect(result.validation?.ok).toBe(true);
    const op = result.plan!.operations[0]!;
    if (op.action !== 'create') throw Error('Expected create proposal');
    expect(op.data.kind.value).toBe('quiz'); expect(op.data.course?.value).toBe('mobile');
    expect(op.data.date?.value).toEqual({ kind: 'relative', text: 'باچر' });
    expect(op.data.details.value).toBe(mode === 'literal' ? 'كوز Mobile Applications' : message);
    for (const absent of ['time', 'audience', 'coverage', 'component', 'claimedCertainty']) expect(op.data).not.toHaveProperty(absent);
    expect(raw).toEqual(untouched);
  });

  it.each(['kind', 'course'] as const)('still rejects genuinely missing required %s', async missing => {
    const raw = createDraft(); raw.operations[0]!.fields = raw.operations[0]!.fields!.filter(f => f.name !== missing);
    const { result } = await compile(raw);
    expect(result.validation?.ok).not.toBe(true); expect(result.plan).toBeNull();
    expect(result.metrics.normalizationError).toBe('missing_information');
  });

  it('does not make optional date/time/group mandatory when absent from a create proposal', async () => {
    const raw = createDraft(); raw.operations[0]!.fields = raw.operations[0]!.fields!.filter(f => f.name !== 'date');
    const { result } = await compile(raw); expect(result.validation?.ok).toBe(true);
    const op = result.plan!.operations[0]!;
    if (op.action !== 'create') throw Error('Expected create');
    expect(op.data.date).toBeUndefined(); expect(op.data.time).toBeUndefined(); expect(op.data.audience).toBeUndefined();
    // A scorer must separately flag omission of the date actually supplied in this message.
  });

  it('does not turn a clarification into create using fixture annotations', async () => {
    const raw = replyDraft(message, 'clarification', 'question'), { result } = await compile(raw);
    expect(result.plan!.operations[0]!.action).toBe('reply'); expect(raw.operations[0]!.action).toBe('reply');
    expect(result.validation?.ok).toBe(true); // Safe reply acceptance is not semantic task success.
  });

  it('preserves explicit negation without an unnecessary question or a write attestation', async () => {
    const scenario = buildIndependentScenario('p3h-negated-create');
    const raw = replyDraft(scenario.input.originalText, 'conversation', 'negation');
    const { result } = await compile(raw, scenario.id);
    expect(scenario.context.instructions).toEqual([]); expect(result.validation?.ok).toBe(true);
    expect(result.plan!.operations).toMatchObject([{ action: 'reply', speechAct: 'negation', subject: 'conversation' }]);
  });

  it('blocks a false create proposal on negated input even with a verified actor and create capability', async () => {
    const scenario = buildIndependentScenario('p3h-negated-create'), raw = createDraft();
    raw.operations[0]!.evidence = { sourceId: 'message', start: 0, end: scenario.input.originalText.length };
    expect(scenario.context.allowedActions).toContain('create');
    const { result } = await compile(raw, scenario.id);
    expect(result.plan).toBeNull(); expect(result.metrics.normalizationError).toBe('intent_not_established');
  });

  it('clarifies a genuinely unspecified course without inventing one or granting a save', async () => {
    const scenario = buildIndependentScenario('p3h-create-missing-course');
    const raw = replyDraft(scenario.input.originalText, 'clarification', 'command');
    const { result } = await compile(raw, scenario.id);
    expect(scenario.context.instructions).toEqual([]); expect(result.validation?.ok).toBe(true);
    expect(result.plan!.operations[0]).toMatchObject({ action: 'reply', speechAct: 'command', subject: 'clarification' });
  });

  it('keeps strict field-entry keys required, even when details value is nullable', () => {
    const raw = createDraft(); raw.operations[0]!.fields!.push(field('details', null, message));
    delete (raw.operations[0]!.fields!.at(-1)! as unknown as Record<string, unknown>).value;
    expect(isModelPlanDraft(raw)).toBe(false);
  });

  it('rejects invented details rather than treating them as absent', () => {
    const scenario = buildIndependentScenario('p3h-create-positive'), raw = createDraft();
    raw.operations[0]!.fields!.push(field('details', 'Unstated exam contents', message));
    const normalized = normalizeFinalContractModelPlan(raw, scenario.context);
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw Error('Expected validator to inspect grounded value');
    const checked = validateSemanticPlan(normalized.plan, scenario.context);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.map(i => i.reason)).toContain('ungrounded_value');
  });
});

describe('frozen experiment input integrity', () => {
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  it('reconstructs both actual create request message hashes and identical dynamic context', () => {
    const old = structuredClone(UNDERSTANDING_CASES.find(c => c.id === 'p3e-03')!), current = finalContractCase('p3e-03');
    const v4 = new UnderstandingContextBuilder().build(old.input, old.context);
    const v5 = new FinalContractContextBuilder().build(current.input, current.context);
    expect(hash(v4.messages)).toBe('98f3a36766f4be545eb40df0713ed2ce68e0b031ae0ae2708aee360053fc6279');
    expect(hash(v5.messages)).toBe('38096fcc56619e14d9a31786641cf3382464b783a621ff214516d8b7dc3462a5');
    expect(v4.messages.slice(1)).toEqual(v5.messages.slice(1));
    const metadata = JSON.parse(v5.messages[1]!.content).trusted_metadata;
    expect(metadata.baghdadDate).toBe('2026-10-30'); expect(metadata.originalISO).toBe('2026-10-30T06:00:00.000Z');
  });

  it('retains the exact V4/V5 prefixes instead of introducing an unproven prompt revision', () => {
    expect(hash(UNDERSTANDING_INSTRUCTIONS)).toBe('872570171e1646c3bcea381a3ccdf9b524f96fa0f6255e8bbe96bca8e46fa314');
    expect(hash(FINAL_CONTRACT_INSTRUCTIONS)).toBe('79dbd9072b964e6620cee8e63818778699fdb0ecd57e4c1eaf626aef96a16450');
  });

  it.each([
    ['paced-smoke-2026-10-30T18-44-20-305Z.json', '4842c421798ed6f9fe3cb4032f509d4db02487f3a277c2326cc014d898bf46e0'],
    ['paced-smoke-2026-11-02T05-23-08-027Z.json', '32be67e399831b720c0f43a0cdfade5a51805e8034e8bd2ad88dccc02ffd5c64'],
  ])('leaves historical output bytes unchanged: %s', (file, expectedHash) => {
    expect(createHash('sha256').update(readFileSync(`output/semantic-eval/${file}`)).digest('hex')).toBe(expectedHash);
  });
});
