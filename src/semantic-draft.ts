import { matchesReadSchema, READ_TOOL_NAMES, isReadToolInvocation, type ReadSchema, type ReadToolInvocation } from './read-tool-contracts';
import { MAX_SEMANTIC_OPERATIONS, type AnnouncementDraft, type AnnouncementPatch, type EvidenceSpan,
  type PatchField, type SemanticAction, type SemanticOperation, type SemanticPlanV1, type SemanticSource, type SemanticTarget, type SpeechAct } from './semantic-plan';

const fields: readonly PatchField[] = ['kind', 'course', 'date', 'time', 'audience', 'component', 'coverage', 'details', 'claimedCertainty'];
export interface DraftTarget {
  type: 'description' | 'reply' | 'previous_list'; text: string | null; evidence: EvidenceSpan | null;
  sourceId: string | null; listId: string | null; position: number | null;
}
export interface DraftField {
  name: PatchField; mode: 'set' | 'clear'; value: string | null; dateKind: 'absolute' | 'relative' | null; evidence: EvidenceSpan;
}
export interface DraftReadArguments {
  period: 'today' | 'tomorrow' | 'week' | null; course: string | null; group: 'A' | 'B' | null;
  reference: string | null; name: string | null; limit: number | null; archive: boolean | null;
}
export interface DraftOperation {
  id: string; action: SemanticAction; speechAct: SpeechAct; evidence: EvidenceSpan; dependsOn: string[];
  tool: ReadToolInvocation['name'] | null; arguments: DraftReadArguments | null;
  target: DraftTarget | null; targets: DraftTarget[] | null; fields: DraftField[] | null;
  reply: { subject: 'conversation' | 'clarification'; text: string } | null;
}
/** A deliberately small model-facing draft. Null means absent, never an implicit clear. */
export interface ModelPlanDraftV1 { version: 1; operations: DraftOperation[] }
const en = (...values: unknown[]): ReadSchema => ({ enum: values });
const str = (maxLength: number): ReadSchema => ({ type: 'string', minLength: 1, maxLength });
const obj = (properties: Record<string, ReadSchema>): ReadSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nullable = (schema: ReadSchema): ReadSchema => ({ anyOf: [schema, { type: 'null' }] });
const arr = (items: ReadSchema, maxItems: number): ReadSchema => ({ type: 'array', items, maxItems });
const index: ReadSchema = { type: 'integer', minimum: 0, maximum: 8192 };
const evidence = obj({ sourceId: str(64), start: index, end: { ...index, minimum: 1 } });
const target = obj({ type: en('description', 'reply', 'previous_list'), text: nullable(str(240)), evidence: nullable(evidence),
  sourceId: nullable(str(64)), listId: nullable(str(64)), position: nullable({ type: 'integer', minimum: 1, maximum: 32 }) });
const args = obj({ period: nullable(en('today', 'tomorrow', 'week')), course: nullable(str(100)), group: nullable(en('A', 'B')),
  reference: nullable(str(64)), name: nullable(str(100)), limit: nullable({ type: 'integer', minimum: 1, maximum: 10 }), archive: nullable({ type: 'boolean' }) });
export const MODEL_PLAN_DRAFT_LOCAL_SCHEMA: ReadSchema = obj({ version: en(1), operations: arr(obj({
  id: str(64), action: en('read', 'create', 'update', 'cancel', 'undo', 'publish', 'reply'),
  speechAct: en('command', 'question', 'statement', 'correction', 'negation', 'example', 'chitchat'),
  evidence, dependsOn: arr(str(64), MAX_SEMANTIC_OPERATIONS), tool: nullable(en(...READ_TOOL_NAMES)), arguments: nullable(args),
  target: nullable(target), targets: nullable(arr(target, MAX_SEMANTIC_OPERATIONS)),
  fields: nullable(arr(obj({ name: en(...fields), mode: en('set', 'clear'), value: nullable(str(2400)),
    dateKind: nullable(en('absolute', 'relative')), evidence }), fields.length)),
  reply: nullable(obj({ subject: en('conversation', 'clarification'), text: str(2000) })),
}), MAX_SEMANTIC_OPERATIONS) });

/** Conservative wire subset: bounds stay in the local validator, never rely on provider enforcement. */
function wireSchema(schema: ReadSchema): Record<string, unknown> {
  if (schema.anyOf) return { anyOf: schema.anyOf.map(wireSchema) };
  if (schema.enum) return { type: typeof schema.enum[0] === 'number' ? 'integer' : 'string', enum: schema.enum };
  if (schema.type === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(schema.properties!).map(([key, s]) => [key, wireSchema(s)])),
    required: [...schema.required!], additionalProperties: false };
  return schema.type === 'array' ? { type: 'array', items: wireSchema(schema.items!) } : { type: schema.type };
}
export const MODEL_PLAN_DRAFT_JSON_SCHEMA = wireSchema(MODEL_PLAN_DRAFT_LOCAL_SCHEMA);
export function isModelPlanDraft(value: unknown): value is ModelPlanDraftV1 { return matchesReadSchema(value, MODEL_PLAN_DRAFT_LOCAL_SCHEMA); }

class DraftFault extends Error {
  constructor(readonly reason: string, readonly missing: string[] = []) { super(reason); }
}
const fail = (reason: string, missing: string[] = []): never => { throw new DraftFault(reason, missing); };
function normalizeTarget(t: DraftTarget): SemanticTarget {
  if (t.type === 'description') {
    if (!t.text || !t.evidence || t.sourceId !== null || t.listId !== null || t.position !== null) return fail('invalid_target');
    return { type: 'description', text: t.text, evidence: t.evidence };
  }
  if (t.text !== null || t.evidence !== null || !t.position) return fail('invalid_target');
  if (t.type === 'reply' && t.sourceId && t.listId === null) return { type: 'reply', sourceId: t.sourceId, position: t.position };
  if (t.type === 'previous_list' && t.listId && t.sourceId === null) return { type: 'previous_list', listId: t.listId, position: t.position };
  return fail('invalid_target');
}
const argumentKeys: Record<ReadToolInvocation['name'], readonly (keyof DraftReadArguments)[]> = {
  get_schedule: ['period', 'course', 'group'], get_courses: ['course'], get_cohort_info: [],
  search_announcements: ['course', 'limit', 'archive'], get_announcement: ['reference', 'archive'],
  find_student: ['name', 'limit'], get_operation_status: ['reference'],
};
const requiredArgument: Partial<Record<ReadToolInvocation['name'], keyof DraftReadArguments>> = {
  get_schedule: 'period', get_announcement: 'reference', find_student: 'name', get_operation_status: 'reference',
};
function normalizeOperation(op: DraftOperation, sources: readonly SemanticSource[]): SemanticOperation {
  const base = { id: op.id, speechAct: op.speechAct, evidence: op.evidence, dependsOn: op.dependsOn };
  if (op.action === 'reply') {
    if (!op.reply || [op.tool, op.arguments, op.target, op.targets, op.fields].some(v => v !== null)) return fail('irrelevant_draft_fields');
    return { ...base, action: 'reply', ...op.reply };
  }
  if (op.reply !== null) return fail('irrelevant_draft_fields');
  if (op.action === 'read') {
    if (!op.tool || !op.arguments || [op.target, op.targets, op.fields].some(v => v !== null)) return fail('invalid_read_draft');
    if (!['command', 'question', 'correction'].includes(op.speechAct)) return fail('non_executable_read');
    const s = sources.find(s => s.id === op.evidence.sourceId);
    if (!s) return fail('invalid_evidence');
    if (s.kind !== 'current') return fail('quoted_instruction');
    if (op.evidence.end <= op.evidence.start || op.evidence.end > s.text.length) return fail('invalid_evidence');
    const query = s.text.slice(op.evidence.start, op.evidence.end);
    const input: Record<string, unknown> = op.tool === 'search_announcements' ? { query } : {};
    for (const [key, value] of Object.entries(op.arguments)) {
      if (value === null) continue;
      if (!argumentKeys[op.tool].includes(key as keyof DraftReadArguments)) return fail('irrelevant_read_argument');
      input[key] = value;
    }
    const required = requiredArgument[op.tool];
    if (required && !Object.hasOwn(input, required)) return fail('missing_information', [required]);
    const tool = { name: op.tool, version: 1, input };
    if (!isReadToolInvocation(tool)) return fail('invalid_read_argument');
    const subject = op.tool === 'get_schedule' ? 'schedule' : op.tool === 'get_operation_status' ? 'operation_status'
      : ['search_announcements', 'get_announcement'].includes(op.tool) ? 'announcements' : 'cohort';
    return { ...base, action: 'read', subject, query: { value: query, evidence: op.evidence }, tool };
  }
  if (op.tool !== null || op.arguments !== null) return fail('irrelevant_draft_fields');
  if (op.action === 'publish') {
    if (op.target !== null || op.fields !== null || !op.targets?.length) return fail('missing_information', ['target']);
    return { ...base, action: 'publish', subject: 'announcements', targets: op.targets.map(normalizeTarget) };
  }
  if (op.targets !== null) return fail('irrelevant_draft_fields');
  if (op.action === 'cancel' || op.action === 'undo') {
    if (op.fields !== null || !op.target) return fail('missing_information', ['target']);
    return { ...base, action: op.action, subject: 'announcements', target: normalizeTarget(op.target) };
  }
  if (!op.fields?.length) return fail('missing_information', ['fields']);
  const mapped: Record<string, unknown> = {};
  for (const field of op.fields) {
    if (Object.hasOwn(mapped, field.name)) return fail('duplicate_field');
    if (field.mode === 'clear') {
      if (op.action !== 'update' || field.value !== null || field.dateKind !== null) return fail('invalid_clear');
      mapped[field.name] = { mode: 'clear', evidence: field.evidence };
    } else {
      if (field.value === null || (field.name === 'date') !== (field.dateKind !== null)) return fail('invalid_field');
      const value = field.name === 'date' ? { kind: field.dateKind, text: field.value } : field.value;
      mapped[field.name] = { ...(op.action === 'update' ? { mode: 'set' } : {}), value, evidence: field.evidence };
    }
  }
  if (op.action === 'create') {
    if (op.target !== null) return fail('irrelevant_draft_fields');
    const missing = ['kind', 'course', 'details'].filter(key => !Object.hasOwn(mapped, key));
    if (missing.length) return fail('missing_information', missing);
    return { ...base, action: 'create', subject: 'announcements', data: mapped as AnnouncementDraft };
  }
  if (!op.target) return fail('missing_information', ['target']);
  return { ...base, action: 'update', subject: 'announcements', target: normalizeTarget(op.target), patch: mapped as AnnouncementPatch };
}
export type DraftNormalization = { ok: true; plan: SemanticPlanV1 }
  | { ok: false; reason: string; missing: string[] };
/** Normalization grants no roles, ownership, snapshots, versions, adoption or execution receipts. */
export function normalizeModelPlan(raw: unknown, sources: readonly SemanticSource[]): DraftNormalization {
  if (!isModelPlanDraft(raw)) return { ok: false, reason: 'invalid_model_draft', missing: [] };
  try { return { ok: true, plan: { version: 1, operations: raw.operations.map(op => normalizeOperation(op, sources)) } }; }
  catch (e) { return { ok: false, reason: e instanceof DraftFault ? e.reason : 'invalid_model_draft', missing: e instanceof DraftFault ? e.missing : [] }; }
}
