import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_INSTRUCTIONS, CONTRACT_PROMPT_VERSION, ContractContextBuilder } from '../eval/semantic-contract-prompt';
import { UNDERSTANDING_CASES } from '../eval/semantic-understanding-fixtures';
import { UNDERSTANDING_INSTRUCTIONS } from '../eval/semantic-understanding-prompt';
import { isModelPlanDraft, normalizeModelPlan } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';
import type { EvidenceSpan, SemanticOperation, SemanticPlanV1, SpeechAct } from '../src/semantic-plan';
import type { ReadExecutionContext } from '../src/read-tools';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

/** Design-time contrasts, independent of model output. Mocks do not measure AI accuracy. */
const cases: readonly { id: string; text: string; speechAct: SpeechAct; write: boolean; quote?: string }[] = [
  { id: 'negated', text: 'لا تضيف كوز الموبايل باچر', speechAct: 'negation', write: false },
  { id: 'affirmative', text: 'ضيف كوز الموبايل باچر', speechAct: 'command', write: true },
  // Contextless rising-question phrasing has no independent write attestation.
  { id: 'question', text: 'ضيف كوز الموبايل باچر؟', speechAct: 'question', write: false },
  { id: 'quoted', text: 'هذا مثال فقط: «ضيف كوز الموبايل باچر».', speechAct: 'example', write: false, quote: 'ضيف كوز الموبايل باچر' },
  { id: 'hypothetical', text: 'افترض فقط إضافة كوز الموبايل باچر، هذا مو طلب حفظ.', speechAct: 'example', write: false },
  { id: 'mixed-negation', text: "Don't add كوز الموبايل tomorrow.", speechAct: 'negation', write: false },
];
const span = (text: string, literal = text): EvidenceSpan => {
  const start = text.indexOf(literal);
  if (start < 0) throw Error('Invalid independent fixture');
  return { sourceId: 'message', start, end: start + literal.length };
};
function context(c: typeof cases[number]): ReadExecutionContext {
  const result = structuredClone(UNDERSTANDING_CASES[0]!.context);
  result.originalText = c.text;
  result.sources = [{ id: 'message', kind: 'current', text: c.text, messageStart: 0 },
    ...(c.quote ? [{ id: 'quoted-example', kind: 'quote' as const, text: c.quote, messageStart: c.text.indexOf(c.quote) }] : [])];
  // Capability alone is deliberately available in all contrasts. Only the independently
  // classified affirmative current request receives a write attestation.
  result.allowedActions = ['read', 'create'];
  result.instructions = c.write ? [{ operationId: 'app-create', action: 'create', speechAct: 'command', evidence: span(c.text) }] : [];
  result.targetBindings = []; result.announcementReferences = []; result.operationReferences = [];
  return result;
}
function create(c: typeof cases[number]): SemanticOperation {
  const literal = 'كوز الموبايل';
  return { id: 'app-create', action: 'create', subject: 'announcements', speechAct: 'command', evidence: span(c.text), dependsOn: [],
    data: { kind: { value: 'quiz', evidence: span(c.text, 'كوز') }, course: { value: 'mobile', evidence: span(c.text, 'الموبايل') },
      details: { value: literal, evidence: span(c.text, literal) }, date: { value: { kind: 'relative', text: c.text.includes('tomorrow') ? 'tomorrow' : 'باچر' },
        evidence: span(c.text, c.text.includes('tomorrow') ? 'tomorrow' : 'باچر') } } };
}
function reply(c: typeof cases[number]): SemanticOperation {
  return { id: 'reply', action: 'reply', subject: c.id === 'question' ? 'clarification' : 'conversation', speechAct: c.speechAct,
    evidence: span(c.text, c.quote ? 'هذا مثال فقط:' : c.text), dependsOn: [], text: 'رد توضيحي بلا حفظ أو ادعاء تنفيذ.' };
}
const plan = (op: SemanticOperation): SemanticPlanV1 => ({ version: 1, operations: [op] });

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in contract-language tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('contract alignment language and independent intent attestations', () => {
  it.each(cases)('$id preserves the independent speech act and never infers write authority from wording', c => {
    const trusted = context(c), expected = c.write ? create(c) : reply(c), draft = mockDraftFromGold(plan(expected));
    expect(isModelPlanDraft(draft)).toBe(true);
    const normalized = normalizeModelPlan(draft, trusted.sources);
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw Error('Normalization failed');
    expect(normalized.plan.operations[0]!.speechAct).toBe(c.speechAct);
    expect(validateSemanticPlan(normalized.plan, trusted).ok).toBe(true);
    if (!c.write) {
      const malicious = create(c), checked = validateSemanticPlan(plan(malicious), trusted);
      expect(checked.ok).toBe(false); if (checked.ok) throw Error('Unattested create accepted');
      expect(checked.issues.map(i => i.reason)).toContain(c.quote ? 'source_region_mismatch' : 'intent_not_established');
      expect(trusted.allowedActions).toContain('create');
    }
  });

  it('does not invent required details or optional time/group when no field was proposed', () => {
    const c = cases.find(c => c.write)!, trusted = context(c), draft = mockDraftFromGold(plan(create(c)));
    const fields = draft.operations[0]!.fields!;
    expect(fields.map(f => f.name)).not.toContain('time'); expect(fields.map(f => f.name)).not.toContain('audience');
    draft.operations[0]!.fields = fields.filter(f => f.name !== 'details');
    expect(normalizeModelPlan(draft, trusted.sources)).toEqual({ ok: false, reason: 'missing_information', missing: ['details'] });
  });

  it('keeps the optional date absent without changing required event content', () => {
    const c = cases.find(c => c.write)!, trusted = context(c), raw = mockDraftFromGold(plan(create(c)));
    raw.operations[0]!.fields = raw.operations[0]!.fields!.filter(f => f.name !== 'date');
    const normalized = normalizeModelPlan(raw, trusted.sources);
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw Error('Normalization failed');
    expect(validateSemanticPlan(normalized.plan, trusted).ok).toBe(true);
    const op = normalized.plan.operations[0]!;
    expect(op.action === 'create' && op.data.date).toBeUndefined();
  });

  it('keeps V4 frozen and only substitutes the isolated V5 planner prefix', () => {
    const c = cases[0]!, trusted = context(c), before = structuredClone(trusted);
    const old = UNDERSTANDING_INSTRUCTIONS;
    const built = new ContractContextBuilder().build({ originalText: c.text }, trusted);
    expect(CONTRACT_PROMPT_VERSION).toBe('semantic-brain-v5-contract-alignment');
    expect(built.messages[0]!.content).toBe(CONTRACT_INSTRUCTIONS);
    expect(CONTRACT_INSTRUCTIONS).not.toBe(old); expect(UNDERSTANDING_INSTRUCTIONS).toBe(old);
    expect(trusted).toEqual(before);
    expect(CONTRACT_INSTRUCTIONS.length).toBeLessThanOrEqual(UNDERSTANDING_INSTRUCTIONS.length + 500);
    for (const part of ['targets[], even for one; target=null', 'text/evidence/sourceId=null', 'Missing details is invalid',
      'independent trusted intent', 'Operation id is a free label', 'negation=negation', 'records=correction']) {
      expect(CONTRACT_INSTRUCTIONS).toContain(part);
    }
  });
});
