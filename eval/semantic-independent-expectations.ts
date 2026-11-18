import { buildIndependentScenario, type BuiltIndependentScenario, type IndependentScenarioId } from './semantic-independent-scenarios';
import { compareMeaning, draftPlanMeaning, semanticPlanMeaning, type Comparison, type PlanMeaning, type SemanticGoldCase } from '../src/semantic-eval';
import { isModelPlanDraft } from '../src/semantic-draft';
import type { EvidenceSpan, SemanticOperation, SemanticPlanV1, SemanticSource, SpeechAct } from '../src/semantic-plan';

/** New authored labels; neither historical gold nor model output supplies these expectations. */
export const INDEPENDENT_EXPECTATION_VERSION = 'daaboul-independent-understanding-gold-v1';
export const CORRECTED_P3E03_EXPECTATION_VERSION = 'daaboul-p3e03-optional-details-expectation-v1';
export interface IndependentExpectationLabels {
  note: string;
  missingRequired: readonly string[];
  optionalCreateDetails: boolean;
  expectedRejection?: { stage: 'normalization' | 'validator'; reason: 'permission_denied' | 'stale_reference' };
}
export type IndependentEvaluationCase = SemanticGoldCase & {
  expectation: IndependentExpectationLabels;
  provenance: BuiltIndependentScenario['provenance'];
};

function proof(text: string, literal = text): EvidenceSpan {
  const start = text.indexOf(literal);
  if (start < 0 || !literal.length) throw Error('Independent expectation no longer matches its authored message');
  return { sourceId: 'message', start, end: start + literal.length };
}
const base = (text: string, speechAct: SpeechAct) => ({ id: 'current-request', speechAct, evidence: proof(text), dependsOn: [] as string[] });
const reply = (text: string, speechAct: SpeechAct, clarification: boolean): SemanticOperation => ({
  ...base(text, speechAct), action: 'reply', subject: clarification ? 'clarification' : 'conversation',
  text: clarification ? 'حدد المعلومة أو التبليغ المقصود.' : 'تمام، ما أضيفه.',
});
const publish = (text: string): SemanticOperation => ({ ...base(text, 'command'), action: 'publish', subject: 'announcements',
  targets: [{ type: 'previous_list', listId: 'phase3h-list', position: 2 }] });
function create(text: string): SemanticOperation {
  return { ...base(text, 'command'), action: 'create', subject: 'announcements', data: {
    kind: { value: 'quiz', evidence: proof(text, 'كوز') },
    course: { value: 'mobile', evidence: proof(text, 'Mobile Applications') },
    date: { value: { kind: 'relative', text: 'باچر' }, evidence: proof(text, 'باچر') },
    // Normalized display/provenance text remains required; extra raw details do not.
    details: { value: text, evidence: proof(text) },
  } };
}

/** Build application facts FIRST. Labels are attached afterwards and never feed the context builder. */
export function independentEvaluationCase(id: IndependentScenarioId): IndependentEvaluationCase {
  const scenario = buildIndependentScenario(id), text = scenario.input.originalText;
  let operation: SemanticOperation, expectedValidator: SemanticGoldCase['expectedValidator'] = 'allow';
  let ambiguity = false, abstentionExpected = false;
  const expectation: IndependentExpectationLabels = { note: '', missingRequired: [], optionalCreateDetails: false };
  switch (id) {
    case 'p3h-samepublish-admin':
    case 'p3h-wrongtarget':
      operation = publish(text); expectation.note = 'The explicit request selects list position 2; position 1 is not an alternative.'; break;
    case 'p3h-samepublish-student':
      operation = publish(text); expectedValidator = 'deny'; abstentionExpected = true;
      expectation.note = 'The same publication request remains a publication intent; the authenticated student cannot publish.';
      expectation.expectedRejection = { stage: 'validator', reason: 'permission_denied' }; break;
    case 'p3h-stalesnapshot':
      operation = publish(text); expectedValidator = 'clarify'; abstentionExpected = true;
      expectation.note = 'Position 2 is intended; the application rejects its outdated snapshot before validation.';
      expectation.expectedRejection = { stage: 'normalization', reason: 'stale_reference' }; break;
    case 'p3h-create-positive':
      operation = create(text); expectation.optionalCreateDetails = true;
      expectation.note = 'Explicit mixed-language create: quiz/mobile, supplied relative date, no invented time or audience.'; break;
    case 'p3h-negated-create':
      operation = reply(text, 'negation', false); abstentionExpected = true;
      expectation.note = 'Negation requests no create, even though kind/course/date words are present.'; break;
    case 'p3h-create-missing-course':
      operation = reply(text, 'command', true); ambiguity = true; abstentionExpected = true;
      expectation.missingRequired = ['course']; expectation.note = 'The original command lacks a course; ask only for essential missing information.'; break;
    case 'p3h-time-only-update':
      operation = { ...base(text, 'correction'), action: 'update', subject: 'announcements',
        target: { type: 'previous_list', listId: 'phase3h-list', position: 1 },
        patch: { time: { mode: 'set', value: '09:45', evidence: proof(text, '09:45') } } };
      expectation.note = 'Update only the time on position 1; omitted date/audience/details remain untouched.'; break;
    case 'p3h-ambiguous-publish':
      operation = reply(text, 'command', true); ambiguity = true; abstentionExpected = true;
      expectation.note = 'Position 2 has two candidates; clarify without selecting a record.'; break;
  }
  return { id, datasetVersion: INDEPENDENT_EXPECTATION_VERSION, evaluationProfile: 'contract-v5',
    synthetic: true, categories: ['independent_context', id], input: scenario.input, context: scenario.context,
    expectedPlan: { version: 1, operations: [operation] }, expectedValidator, ambiguity, abstentionExpected,
    contextResolution: !['p3h-create-positive', 'p3h-negated-create', 'p3h-create-missing-course'].includes(id),
    expectation, provenance: scenario.provenance };
}

export interface OptionalDetailsIssue { operationId: string; reason: string }
export interface OptionalCreateDetailsComparison {
  historicalComparison: Comparison;
  correctedComparison: Comparison;
  detailsValid: boolean;
  detailsIssues: OptionalDetailsIssue[];
  createFieldsValid: boolean;
  createFieldIssues: OptionalDetailsIssue[];
}
/** Exact current, unquoted source text only. This checks provenance, never intent or permission. */
function currentLiteral(e: EvidenceSpan, sources: readonly SemanticSource[]): string | null {
  const matches = sources.filter(s => s.id === e.sourceId), source = matches[0];
  if (matches.length !== 1 || !source || source.kind !== 'current' || source.messageStart === null
    || !Number.isSafeInteger(source.messageStart) || source.messageStart < 0
    || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end) || e.start < 0 || e.end <= e.start || e.end > source.text.length) return null;
  const start = source.messageStart + e.start, end = source.messageStart + e.end;
  if (sources.some(s => s.kind === 'quote' && s.messageStart !== null && start < s.messageStart + s.text.length && end > s.messageStart)) return null;
  const literal = source.text.slice(e.start, e.end);
  return literal.trim() && literal.length <= 2400 ? literal : null;
}

/** Opt-in raw comparison only. The original score, draft, normalized contract and wire schema stay untouched.
 * Select this policy only for an expectation whose additional create details are optional.
 * A supplied string must be an exact literal within its current action/field evidence, never a paraphrase.
 */
export function compareOptionalCreateDetails(expectedPlan: SemanticPlanV1, raw: unknown,
  sources: readonly SemanticSource[]): OptionalCreateDetailsComparison {
  const expected = semanticPlanMeaning(expectedPlan), historicalComparison = compareMeaning(expected, draftPlanMeaning(raw, true));
  const detailsIssues: OptionalDetailsIssue[] = [], createFieldIssues: OptionalDetailsIssue[] = [];
  if (!isModelPlanDraft(raw)) return { historicalComparison, correctedComparison: historicalComparison,
    detailsValid: false, detailsIssues: [{ operationId: '', reason: 'invalid_model_draft' }],
    createFieldsValid: false, createFieldIssues: [{ operationId: '', reason: 'invalid_model_draft' }] };
  for (const op of raw.operations) {
    if (op.action !== 'create') continue;
    const issues: string[] = [], details = op.fields?.filter(f => f.name === 'details') ?? [];
    if (new Set(op.fields?.map(f => f.name)).size !== (op.fields?.length ?? 0)) issues.push('duplicate_field');
    const actionText = currentLiteral(op.evidence, sources);
    if (actionText === null) issues.push('invalid_action_evidence');
    const fieldIssues: string[] = [];
    if ([op.tool, op.arguments, op.target, op.targets, op.reply].some(value => value !== null)) fieldIssues.push('irrelevant_draft_fields');
    // The meaning projection intentionally omits extraction modes and spans.
    // Check these before relaxing one optional slot; no validator authority or
    // model field/evidence is manufactured by this comparison.
    for (const field of op.fields ?? []) {
      if (field.name === 'details') continue;
      if (field.mode !== 'set' || field.value === null || !field.value.trim()
        || (field.name === 'date') !== (field.dateKind !== null)) fieldIssues.push('invalid_create_field');
      if (currentLiteral(field.evidence, sources) === null || field.evidence.sourceId !== op.evidence.sourceId
        || field.evidence.start < op.evidence.start || field.evidence.end > op.evidence.end) fieldIssues.push('invalid_field_evidence');
    }
    for (const reason of new Set(fieldIssues)) createFieldIssues.push({ operationId: op.id, reason });
    for (const field of details) {
      const literal = currentLiteral(field.evidence, sources);
      if (field.mode !== 'set' || field.dateKind !== null) issues.push('invalid_details_mode');
      if (literal === null || field.evidence.sourceId !== op.evidence.sourceId
        || field.evidence.start < op.evidence.start || field.evidence.end > op.evidence.end) issues.push('invalid_details_evidence');
      if (field.value !== null && (!field.value.trim() || literal === null || !literal.includes(field.value))) issues.push('ungrounded_details');
    }
    for (const reason of new Set(issues)) detailsIssues.push({ operationId: op.id, reason });
  }
  // Compare the independently versioned requirement set. Do not manufacture a
  // draft field/value/evidence to make an omitted optional extraction look present.
  const withoutExtraDetails = (meaning: PlanMeaning): PlanMeaning => {
    const projected = structuredClone(meaning);
    for (const op of projected.operations) {
      if (op !== null && typeof op === 'object' && !Array.isArray(op) && op.action === 'create'
        && op.slots !== null && typeof op.slots === 'object' && !Array.isArray(op.slots)) delete op.slots.details;
    }
    return projected;
  };
  const actual = draftPlanMeaning(raw, true);
  let correctedComparison = compareMeaning(withoutExtraDetails(expected), actual ? withoutExtraDetails(actual) : null);
  if (detailsIssues.length || createFieldIssues.length) correctedComparison = { ...correctedComparison, exact: false, slots: false };
  return { historicalComparison, correctedComparison, detailsValid: detailsIssues.length === 0, detailsIssues,
    createFieldsValid: createFieldIssues.length === 0, createFieldIssues };
}

/** Separately authored correction for the OLD Oct 30 message clock; no historical fixture is imported or modified. */
export function correctedP3e03Expectation() {
  const originalText = 'Create كوز Mobile Applications باچر.';
  return { id: 'p3e-03', datasetVersion: CORRECTED_P3E03_EXPECTATION_VERSION,
    originalText, originalTimestamp: Date.parse('2026-10-30T09:00:00+03:00'),
    sources: [{ id: 'message', kind: 'current', text: originalText, messageStart: 0 }] as SemanticSource[],
    expectedPlan: { version: 1, operations: [create(originalText)] } as SemanticPlanV1,
    optionalCreateDetails: true as const,
    note: 'Supplied kind/course/relative date are required meaning; additional details are optional. Historical gold/results remain unchanged.' };
}
