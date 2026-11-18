import { isAdmin } from './admin';
import { addCalendarDays } from './calendar';
import { extractEventQuery } from './event-extract';
import { normalizeArabic } from './input';
import { COURSE_ALIASES, type CourseId } from './nlu-schema';
import { isReadToolInvocation } from './read-tool-contracts';
import { MAX_SEMANTIC_OPERATIONS, type AnnouncementPatch,
  type EvidenceSpan, type Grounded, type PatchField, type SemanticOperation, type SemanticPlanV1,
  type SemanticScope, type SemanticTarget, type SemanticValidation, type TargetSnapshot,
  type TrustedInstruction, type ValidatedOperation, type ValidationContext, type ValidationIssue,
  type ValidationReason } from './semantic-plan';

const acts = ['command', 'question', 'statement', 'correction', 'negation', 'example', 'chitchat'];
const actions = ['read', 'create', 'update', 'cancel', 'undo', 'publish', 'reply'];
const member = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const fields: PatchField[] = ['kind', 'course', 'date', 'time', 'audience', 'component', 'coverage', 'details', 'claimedCertainty'];
const digits = (s: string) => s.replace(/[٠-٩۰-۹]/gu, c => String('٠١٢٣٤٥٦٧٨٩'.includes(c) ? '٠١٢٣٤٥٦٧٨٩'.indexOf(c) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
const norm = (s: string) => digits(normalizeArabic(s).toLowerCase().replace(/ة/g, 'ه').replace(/ى/g, 'ي'));
function obj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(p => Object.hasOwn(p, 'value'));
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(k => Object.hasOwn(value, k))
    && Reflect.ownKeys(value).every(k => typeof k === 'string' && [...required, ...optional].includes(k));
}
const text = (v: unknown, max = 2400): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(v);
function denseArray(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(p => Object.hasOwn(p, 'value'));
}
function span(v: unknown): v is EvidenceSpan {
  return obj(v) && keys(v, ['sourceId', 'start', 'end']) && identifier(v.sourceId)
    && Number.isSafeInteger(v.start) && Number(v.start) >= 0 && Number.isSafeInteger(v.end) && Number(v.end) > Number(v.start);
}
function valueShape(field: string, value: unknown): boolean {
  switch (field) {
    case 'course': return typeof value === 'string' && Object.hasOwn(COURSE_ALIASES, value);
    case 'kind': return member(value, ['exam', 'quiz', 'homework', 'discussion', 'note', 'lecture_change']);
    case 'audience': return member(value, ['A', 'B', 'all']);
    case 'component': return member(value, ['theory', 'practical', 'exercises']);
    case 'claimedCertainty': return member(value, ['asserted', 'tentative', 'unclear']);
    case 'date': return obj(value) && keys(value, ['kind', 'text']) && member(value.kind, ['absolute', 'relative']) && text(value.text, 160);
    case 'time': return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
    default: return text(value);
  }
}
function grounded(v: unknown, field: string): boolean {
  return obj(v) && keys(v, ['value', 'evidence']) && span(v.evidence) && valueShape(field, v.value);
}
function target(v: unknown): v is SemanticTarget {
  if (!obj(v) || Object.hasOwn(v, 'expectedRevision') && !positive(v.expectedRevision)) return false;
  if (v.type === 'description') return keys(v, ['type', 'text', 'evidence'], ['expectedRevision']) && text(v.text, 240) && span(v.evidence);
  if (v.type === 'reply') return keys(v, ['type', 'sourceId', 'position'], ['expectedRevision']) && identifier(v.sourceId) && positive(v.position);
  return v.type === 'previous_list' && keys(v, ['type', 'listId', 'position'], ['expectedRevision']) && identifier(v.listId) && positive(v.position);
}
function patch(v: unknown): v is AnnouncementPatch {
  return obj(v) && Reflect.ownKeys(v).length > 0 && keys(v, [], fields)
    && Object.entries(v).every(([field, change]) => obj(change) && span(change.evidence)
      && (change.mode === 'set' && keys(change, ['mode', 'value', 'evidence']) && valueShape(field, change.value)
        || change.mode === 'clear' && !['kind', 'course', 'details'].includes(field) && keys(change, ['mode', 'evidence'])));
}
function operation(v: unknown): v is SemanticOperation {
  if (!obj(v) || !identifier(v.id) || !member(v.speechAct, acts) || !member(v.action, actions)
    || !span(v.evidence) || !denseArray(v.dependsOn, MAX_SEMANTIC_OPERATIONS)
    || !v.dependsOn.every(identifier)) return false;
  const base = ['id', 'action', 'subject', 'speechAct', 'evidence', 'dependsOn'];
  if (v.action === 'reply') return keys(v, [...base, 'text']) && member(v.subject, ['conversation', 'clarification']) && text(v.text, 2000);
  if (v.action === 'read') return keys(v, [...base, 'query'], ['tool']) && member(v.subject, ['schedule', 'cohort', 'announcements', 'operation_status']) && grounded(v.query, 'query')
    && (!Object.hasOwn(v, 'tool') || isReadToolInvocation(v.tool));
  if (v.subject !== 'announcements') return false;
  if (v.action === 'create') return keys(v, [...base, 'data']) && obj(v.data) && keys(v.data, ['kind', 'details'], fields)
    && Object.entries(v.data).every(([field, value]) => grounded(value, field));
  if (v.action === 'update') return keys(v, [...base, 'target', 'patch']) && target(v.target) && patch(v.patch);
  if (v.action === 'publish') return keys(v, [...base, 'targets']) && denseArray(v.targets, MAX_SEMANTIC_OPERATIONS)
    && v.targets.length > 0 && v.targets.every(target);
  return keys(v, [...base, 'target']) && target(v.target);
}
function scope(v: SemanticScope): boolean {
  return !!v && positive(v.botId) && positive(v.userId) && Number.isSafeInteger(v.chatId) && v.chatId !== 0
    && (v.threadId === null || positive(v.threadId));
}
const sameScope = (a: SemanticScope, b: SemanticScope) => a.botId === b.botId && a.chatId === b.chatId && a.threadId === b.threadId && a.userId === b.userId;
const sameSpan = (a: EvidenceSpan, b: EvidenceSpan) => a.sourceId === b.sourceId && a.start === b.start && a.end === b.end;
function sameTarget(a: SemanticTarget, b: SemanticTarget): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'description' && b.type === 'description') return a.text === b.text && sameSpan(a.evidence, b.evidence);
  if (a.type === 'reply' && b.type === 'reply') return a.sourceId === b.sourceId && a.position === b.position;
  return a.type === 'previous_list' && b.type === 'previous_list' && a.listId === b.listId && a.position === b.position;
}
/** Selector equality only; revision constraints are checked against trusted snapshots separately. */
export { sameTarget as sameSemanticTarget };
function requestedTargets(value: unknown): boolean {
  if (!denseArray(value, MAX_SEMANTIC_OPERATIONS) || value.length === 0 || !value.every(target)) return false;
  const selectors = value as SemanticTarget[];
  return selectors.every((selector, index) => !selectors.slice(0, index).some(prior => sameTarget(prior, selector)));
}

/** Isolated hints: existing aliases are reused; legacy NLU is not modified.
 * Ignore shorter matches contained within an explicit full course name.
 */
export function semanticCourseHint(input: string): CourseId | null {
  const value = norm(input), matches: { course: CourseId; start: number; end: number }[] = [];
  for (const course of Object.keys(COURSE_ALIASES) as CourseId[]) {
    const aliases: readonly string[] = [...COURSE_ALIASES[course], ...(course === 'visual' ? ['البرمجة', 'برمجة', 'visual programming'] : []),
      ...(course === 'mobile' ? ['mobile applications', 'mobile programming'] : [])];
    for (const alias of new Set(aliases.map(norm))) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      for (const match of value.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'))) {
        matches.push({ course, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  const courses = new Set(matches.filter(a => !matches.some(b => b.start <= a.start && b.end >= a.end && b.end - b.start > a.end - a.start)).map(m => m.course));
  return courses.size === 1 ? [...courses][0]! : null;
}

function validContext(c: ValidationContext): boolean {
  if (!c || typeof c.originalText !== 'string' || c.originalText.length > 8192 || !scope(c.scope)
    || !positive(c.messageId) || !Number.isSafeInteger(c.updateId) || c.updateId < 0
    || !Number.isFinite(c.originalTimestamp) || c.originalTimestamp < 0 || c.originalTimestamp > 8.64e15
    || !Number.isFinite(c.now) || c.now < c.originalTimestamp || c.now > 8.64e15
    || !Array.isArray(c.sources) || c.sources.length > 32 || !Array.isArray(c.instructions) || !Array.isArray(c.targetBindings)) return false;
  if (!c.actor || typeof c.actor.verified !== 'boolean' || !positive(c.actor.userId)
    || c.actor.ownerUid !== null && !positive(c.actor.ownerUid)
    || c.requireTargetIntent !== undefined && typeof c.requireTargetIntent !== 'boolean'
    || c.allowedActions !== undefined && (!Array.isArray(c.allowedActions) || !c.allowedActions.every(a => member(a, actions)))
    || c.instructions.length > MAX_SEMANTIC_OPERATIONS || c.targetBindings.length > 32) return false;
  if (!c.instructions.every(i => i && identifier(i.operationId) && member(i.action, ['create', 'update', 'cancel', 'undo', 'publish'])
    && member(i.speechAct, acts) && span(i.evidence)
    && (i.adoptedSourceIds === undefined || Array.isArray(i.adoptedSourceIds) && i.adoptedSourceIds.length <= 32 && i.adoptedSourceIds.every(identifier))
    && (i.requestedChanges === undefined || patch(i.requestedChanges))
    && (i.requestedTargets === undefined || requestedTargets(i.requestedTargets))
    && (i.requiredDependencies === undefined || denseArray(i.requiredDependencies, MAX_SEMANTIC_OPERATIONS)
      && i.requiredDependencies.every(identifier) && new Set(i.requiredDependencies).size === i.requiredDependencies.length))) return false;
  if (!c.targetBindings.every(b => b && target(b.selector) && scope(b.scope) && Array.isArray(b.snapshots)
    && b.snapshots.length <= MAX_SEMANTIC_OPERATIONS && b.snapshots.every((s: TargetSnapshot) => s && typeof s === 'object'
      && s.reference && typeof s.reference === 'object' && positive(s.ownerId) && member(s.state, ['active', 'cancelled'])
      && member(s.independentVerification, ['unverified', 'verified'])))) return false;
  const ids = new Set<string>();
  for (const s of c.sources) {
    if (!s || !identifier(s.id) || ids.has(s.id) || typeof s.text !== 'string' || s.text.length > 8192 || !['current', 'quote', 'reply'].includes(s.kind)) return false;
    ids.add(s.id);
    if (s.kind === 'reply') { if (s.messageStart !== null) return false; }
    else if (!Number.isSafeInteger(s.messageStart) || s.messageStart === null || s.messageStart < 0
      || c.originalText.slice(s.messageStart, s.messageStart + s.text.length) !== s.text) return false;
  }
  return c.sources.some(s => s.kind === 'current');
}
function evidenceText(e: EvidenceSpan, c: ValidationContext): { text: string; kind: 'current' | 'quote' | 'reply' } | ValidationReason {
  const source = c.sources.find(s => s.id === e.sourceId);
  if (!source || e.end > source.text.length) return 'invalid_evidence';
  if (source.kind === 'current') {
    const start = source.messageStart! + e.start, end = source.messageStart! + e.end;
    if (c.sources.some(s => s.kind === 'quote' && s.messageStart !== null && start < s.messageStart + s.text.length && end > s.messageStart)) return 'source_region_mismatch';
  }
  return { text: source.text.slice(e.start, e.end), kind: source.kind };
}
function groundedValue(field: string, value: unknown, proof: string, c: ValidationContext): boolean {
  if (field === 'course') return semanticCourseHint(proof) === value;
  if (field === 'date') {
    const date = value as { kind: string; text: string };
    if (!norm(proof).includes(norm(date.text))) return false;
    // Relative expressions remain unevaluated; the future resolver uses originalTimestamp + Baghdad.
    if (date.kind === 'relative') return !/\d{4}-\d{2}-\d{2}/u.test(digits(date.text.normalize('NFKC')))
      && (/اليوم|باجر|باچر|غدا|بكره|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت|اسبوع|\b(?:today|tomorrow|next|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/iu.test(norm(date.text))
        // ل + الـ contracts to للـ: recognise only the whole evidenced weekday,
        // without rewriting the original expression or resolving it against now.
        || /^لل(?:احد|اثنين|ثلاثاء|اربعاء|خميس|جمعه|سبت)$/u.test(norm(date.text)));
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date.text)) return false;
    try { addCalendarDays(date.text, 0); return true; } catch { return false; }
  }
  // Linguistic normalization removes punctuation, including the clock's colon.
  if (field === 'time') return new RegExp(`(?<![\\d:])${String(value)}(?![\\d:])`, 'u').test(digits(proof.normalize('NFKC')));
  if (field === 'audience') return extractEventQuery(proof, new Date(c.originalTimestamp)).audience === value;
  if (field === 'kind') {
    const words: Record<string, RegExp> = { exam: /امتحان|اختبار|\bexam\b/iu, quiz: /كوز|كويز|\bquiz\b/iu,
      homework: /واجب|تكليف|\bhomework\b/iu, discussion: /مناقشه|\bdiscussion\b/iu,
      note: /[\s\S]/u, lecture_change: /محاضره|محاضرات|\blecture\b/iu };
    return words[String(value)]!.test(norm(proof));
  }
  if (field === 'component') return ({ theory: /نظري|\btheory\b/iu, practical: /عملي|\bpractical\b/iu, exercises: /تمارين|\bexercises\b/iu }[String(value)]!)?.test(norm(proof)) === true;
  if (field === 'claimedCertainty') return ({ asserted: /اكيد|موكد|\bconfirmed\b/iu, tentative: /احتمال|يمكن|يجوز|\bmaybe\b/iu, unclear: /غير واضح|مو واضح|\bunclear\b/iu }[String(value)]!)?.test(norm(proof)) === true;
  return typeof value === 'string' && proof.includes(value);
}

/** Only explicit adjacent weekday/ISO claims. No date inference, legacy NLU or wall clock. */
function matchingWeekdayClaims(proof: string): boolean {
  const names = ['الاحد|للاحد|sunday', 'الاثنين|للاثنين|monday', 'الثلاثاء|للثلاثاء|tuesday',
    'الاربعاء|للاربعاء|wednesday', 'الخميس|للخميس|thursday', 'الجمعه|للجمعه|friday', 'السبت|للسبت|saturday'];
  // Preserve ISO punctuation while normalising Arabic letters/digits.
  const input = digits(proof.normalize('NFKC')).replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').toLowerCase();
  const iso = '(\\d{4}-\\d{2}-\\d{2})';
  for (const [weekday, words] of names.entries()) {
    const day = `(?:${words})`, separator = '(?:[\\s،,:()]|بتاريخ|الموافق|بتاريخه|on)+';
    for (const [pattern, dateIndex] of [[`${day}${separator}${iso}`, 1], [`${iso}${separator}${day}`, 1]] as const) {
      for (const match of input.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'gu'))) {
        try { if (addCalendarDays(match[dateIndex]!, 0).weekday !== weekday) return false; } catch { return false; }
      }
    }
  }
  return true;
}

/** Stable proposal identity only; durable admission/replay protection remains future executor work. */
export function semanticOperationIdentity(c: Pick<ValidationContext, 'scope' | 'updateId'>, operationId: string): string {
  return `semantic:1:${c.scope.botId}:${c.scope.chatId}:${c.scope.threadId ?? 0}:${c.scope.userId}:${c.updateId}:${operationId}`;
}

/** Pure, conservative validation. An ok plan is NOT execution or permission to skip a fresh DB/version check. */
export function validateSemanticPlan(raw: unknown, context: ValidationContext): SemanticValidation {
  const issues: ValidationIssue[] = [];
  const fail = (reason: ValidationReason, operationId: string | null = null, field?: string) => {
    issues.push({ reason, operationId, ...(field !== undefined ? { field } : {}) });
  };
  const rejected = (): SemanticValidation => ({ ok: false,
    status: issues.some(i => i.reason === 'permission_denied') ? 'denied'
      : issues.some(i => ['stale_reference', 'scope_mismatch', 'expired_reference'].includes(i.reason)) ? 'conflict'
      : issues.some(i => ['invalid_schema', 'invalid_context', 'too_many_operations', 'duplicate_operation', 'invalid_dependency', 'cyclic_dependency', 'invalid_evidence', 'source_region_mismatch'].includes(i.reason)) ? 'failed'
      : 'clarification_required', issues });
  if (!obj(raw) || !keys(raw, ['version', 'operations']) || raw.version !== 1 || !Array.isArray(raw.operations) || raw.operations.length === 0) {
    fail('invalid_schema'); return rejected();
  }
  if (raw.operations.length > MAX_SEMANTIC_OPERATIONS) { fail('too_many_operations'); return rejected(); }
  if (!denseArray(raw.operations, MAX_SEMANTIC_OPERATIONS) || !raw.operations.every(operation)) { fail('invalid_schema'); return rejected(); }
  if (!validContext(context)) { fail('invalid_context'); return rejected(); }
  // Work on an owned JSON snapshot; a caller cannot mutate a validated plan afterwards.
  const plan = JSON.parse(JSON.stringify(raw)) as SemanticPlanV1;
  const ids = new Set<string>();
  for (const op of plan.operations) {
    if (ids.has(op.id)) fail('duplicate_operation', op.id);
    ids.add(op.id);
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (op: SemanticOperation) => {
    if (visiting.has(op.id)) { fail('cyclic_dependency', op.id); return; }
    if (visited.has(op.id)) return;
    visiting.add(op.id);
    if (new Set(op.dependsOn).size !== op.dependsOn.length) fail('invalid_dependency', op.id);
    for (const id of op.dependsOn) {
      const dependency = plan.operations.find(o => o.id === id);
      if (!dependency) fail('invalid_dependency', op.id); else visit(dependency);
    }
    visiting.delete(op.id); visited.add(op.id);
  };
  plan.operations.forEach(visit);
  if (issues.length) return rejected();
  const validated: ValidatedOperation[] = [];
  for (const op of plan.operations) {
    const mutating = op.action !== 'read' && op.action !== 'reply';
    const proof = evidenceText(op.evidence, context);
    if (typeof proof === 'string') { fail(proof, op.id); continue; }
    let instruction: TrustedInstruction | undefined;
    if (mutating) {
      if (proof.kind !== 'current') fail('quoted_instruction', op.id);
      const allowedActs = op.action === 'create' ? ['command', 'statement', 'correction'] : ['command', 'correction'];
      if (!allowedActs.includes(op.speechAct)) fail('non_executable_speech_act', op.id);
      const attestations = context.instructions.filter(i => i.operationId === op.id && i.action === op.action && sameSpan(i.evidence, op.evidence));
      instruction = attestations.length === 1 ? attestations[0] : undefined;
      if (!instruction || !allowedActs.includes(instruction.speechAct)) fail('intent_not_established', op.id);
      if (instruction?.requiredDependencies !== undefined
        && (instruction.requiredDependencies.length !== op.dependsOn.length
          || instruction.requiredDependencies.some(id => !op.dependsOn.includes(id)))) fail('invalid_dependency', op.id);
      if (!context.actor?.verified || context.actor.userId !== context.scope.userId || !context.allowedActions?.includes(op.action)
        || op.action === 'publish' && !isAdmin(context.actor.userId, context.actor.ownerUid)) fail('permission_denied', op.id);
    }
    const checkEvidence = (e: EvidenceSpan, field: string): string | null => {
      const result = evidenceText(e, context);
      if (typeof result === 'string') { fail(result, op.id, field); return null; }
      if (mutating && result.kind !== 'current' && !instruction?.adoptedSourceIds?.includes(e.sourceId)) {
        fail('quoted_instruction', op.id, field); return null;
      }
      if (mutating && result.kind === 'current') {
        const source = context.sources.find(s => s.id === e.sourceId)!;
        const instructionSource = context.sources.find(s => s.id === op.evidence.sourceId)!;
        if (instructionSource.kind !== 'current' || source.messageStart! + e.start < instructionSource.messageStart! + op.evidence.start
          || source.messageStart! + e.end > instructionSource.messageStart! + op.evidence.end) {
          fail('source_region_mismatch', op.id, field); return null;
        }
      }
      return result.text;
    };
    const checkGrounded = (field: string, v: Grounded<unknown>) => {
      const literal = checkEvidence(v.evidence, field);
      if (literal !== null && (!groundedValue(field, v.value, literal, context)
        || field === 'date' && !matchingWeekdayClaims(proof.text))) fail('ungrounded_value', op.id, field);
    };
    if (op.action === 'read') checkGrounded('query', op.query);
    if (op.action === 'create') {
      if (!op.data.course) fail('missing_information', op.id, 'course');
      Object.entries(op.data).forEach(([field, value]) => checkGrounded(field, value as Grounded<unknown>));
    }
    if (op.action === 'update') {
      for (const [field, change] of Object.entries(op.patch)) {
        const requested = instruction?.requestedChanges?.[field as PatchField];
        if (!requested || requested.mode !== change.mode || !sameSpan(requested.evidence, change.evidence)
          || requested.mode === 'set' && change.mode === 'set' && JSON.stringify(requested.value) !== JSON.stringify(change.value)) fail('unrequested_patch', op.id, field);
        if (change.mode === 'set') checkGrounded(field, change); else checkEvidence(change.evidence, field);
      }
    }
    const snapshots: TargetSnapshot[] = [];
    const selectors = op.action === 'publish' ? op.targets : 'target' in op ? [op.target] : [];
    if (mutating && selectors.length > 0) {
      const requested = instruction?.requestedTargets;
      // An available record is not proof that this user requested THAT record.
      // Keep legacy contexts unchanged; aligned contexts require independent intent.
      if (requested !== undefined) {
        const unmatched = [...requested];
        let matches = requested.length === selectors.length;
        for (const selector of selectors) {
          const index = unmatched.findIndex(t => sameTarget(t, selector));
          if (index < 0) matches = false; else unmatched.splice(index, 1);
        }
        if (!matches || unmatched.length > 0) fail('unrequested_target', op.id, 'target');
      } else if (context.requireTargetIntent) fail('unrequested_target', op.id, 'target');
    }
    for (const selector of selectors) {
      if (selector.type === 'description') {
        const literal = checkEvidence(selector.evidence, 'target');
        if (literal !== null && !literal.includes(selector.text)) fail('invalid_evidence', op.id, 'target');
      }
      if (selector.type === 'reply' && context.sources.find(s => s.id === selector.sourceId)?.kind !== 'reply') { fail('invalid_evidence', op.id, 'target'); continue; }
      const bindings = context.targetBindings.filter(b => sameTarget(b.selector, selector));
      if (!bindings.length) { fail('unresolved_target', op.id); continue; }
      if (bindings.length !== 1 || bindings[0]!.snapshots.length !== 1) { fail('ambiguous_target', op.id); continue; }
      const binding = bindings[0]!, snapshot = binding.snapshots[0]!;
      const requested = instruction?.requestedTargets?.find(t => sameTarget(t, selector));
      if (!sameScope(binding.scope, context.scope)) fail('scope_mismatch', op.id);
      if (!Number.isFinite(binding.expiresAt) || binding.expiresAt <= context.now) fail('expired_reference', op.id);
      if (!positive(snapshot.currentRevision) || !positive(snapshot.reference?.revision)
        || snapshot.currentRevision !== snapshot.reference.revision
        || binding.selector.expectedRevision !== undefined && binding.selector.expectedRevision !== snapshot.currentRevision
        || requested?.expectedRevision !== undefined && requested.expectedRevision !== snapshot.currentRevision
        || selector.expectedRevision !== undefined && selector.expectedRevision !== snapshot.currentRevision) fail('stale_reference', op.id);
      if (!text(snapshot.reference?.id, 128) || !['academic', 'legacy'].includes(snapshot.reference?.kind)) fail('unresolved_target', op.id);
      if (op.action !== 'undo' && snapshot.state !== 'active') fail('stale_reference', op.id);
      if (mutating && op.action !== 'publish' && snapshot.ownerId !== context.scope.userId && !isAdmin(context.actor?.userId, context.actor?.ownerUid ?? null)) fail('permission_denied', op.id);
      if (snapshots.some(s => s.reference.kind === snapshot.reference.kind && s.reference.id === snapshot.reference.id)) fail('duplicate_operation', op.id);
      snapshots.push({ reference: { kind: snapshot.reference.kind, id: snapshot.reference.id, revision: snapshot.reference.revision },
        currentRevision: snapshot.currentRevision, ownerId: snapshot.ownerId, state: snapshot.state,
        independentVerification: snapshot.independentVerification });
    }
    validated.push({ operation: op, identity: semanticOperationIdentity(context, op.id), targets: structuredClone(snapshots), independentVerification: op.action === 'create' ? 'unverified' : null });
  }
  return issues.length ? rejected() : { ok: true, plan, operations: validated };
}

/** Scheduler hint only: no tools run here. Accepted/unknown dependencies never unlock publication. */
export function semanticDependencyState(op: Pick<SemanticOperation, 'dependsOn'>,
  results: readonly { operationId: string; status: string }[]): 'ready' | 'waiting' | 'skipped' {
  let waiting = false;
  for (const id of op.dependsOn) {
    const matches = results.filter(r => r.operationId === id);
    if (matches.length > 1) return 'skipped';
    const status = matches[0]?.status;
    if (status === undefined || status === 'accepted' || status === 'unknown') waiting = true;
    else if (status !== 'succeeded') return 'skipped';
  }
  return waiting ? 'waiting' : 'ready';
}

/** Structural check of a TRUSTED executor result, not verification against Telegram. */
export function hasConfirmedSemanticDelivery(raw: unknown): boolean {
  return obj(raw) && raw.status === 'succeeded' && identifier(raw.operationId) && obj(raw.delivery)
    && raw.delivery.state === 'sent' && positive(raw.delivery.messageId)
    && Number.isSafeInteger(raw.delivery.chatId) && raw.delivery.chatId !== 0;
}
