import type { AcademicCertainty, AcademicKind, AcademicItem } from './academic-ai';
import type { AssistantReference } from './assistant-references';
import type { CourseId } from './nlu-schema';
import type { ReadToolInvocation } from './read-tool-contracts';

/** Offline contract only. No production handler imports this module. */
export const SEMANTIC_PLAN_VERSION = 1;
export const SEMANTIC_TIME_ZONE = 'Asia/Baghdad';
export const MAX_SEMANTIC_OPERATIONS = 12;
export type SpeechAct = 'command' | 'question' | 'statement' | 'correction' | 'negation' | 'example' | 'chitchat';
export type SemanticAction = 'read' | 'create' | 'update' | 'cancel' | 'undo' | 'publish' | 'reply';
export type MutationAction = Exclude<SemanticAction, 'read' | 'reply'>;

/** UTF-16 offsets, as used by Telegram entities and String.slice. End is exclusive. */
export interface EvidenceSpan { sourceId: string; start: number; end: number }
export interface Grounded<T> { value: T; evidence: EvidenceSpan }
export type SemanticDate = { kind: 'absolute'; text: string } | { kind: 'relative'; text: string };
export interface AnnouncementFields {
  kind: AcademicKind;
  course: CourseId;
  date: SemanticDate;
  time: string;
  audience: NonNullable<AcademicItem['audience']>;
  component: NonNullable<AcademicItem['component']>;
  coverage: string;
  details: string;
  claimedCertainty: AcademicCertainty;
}
export type PatchField = keyof AnnouncementFields;
export type PatchChange<T> = { mode: 'set'; value: T; evidence: EvidenceSpan }
  | { mode: 'clear'; evidence: EvidenceSpan };
/** Omission preserves the old field; clearing is never represented by null/empty text. */
export type AnnouncementPatch = { [K in PatchField]?: PatchChange<AnnouncementFields[K]> };
export type AnnouncementDraft = { [K in PatchField]?: Grounded<AnnouncementFields[K]> }
  & { kind: Grounded<AcademicKind>; details: Grounded<string> };

/** These are selectors, never database IDs or permission grants. */
export type SemanticTarget = (
  | { type: 'description'; text: string; evidence: EvidenceSpan }
  | { type: 'reply'; sourceId: string; position: number }
  | { type: 'previous_list'; listId: string; position: number }
) & { expectedRevision?: number };
interface OperationBase {
  id: string;
  speechAct: SpeechAct;
  evidence: EvidenceSpan;
  dependsOn: string[];
}
export type SemanticOperation = OperationBase & (
  // Proposed prose only. A renderer must never use it as an execution receipt.
  | { action: 'reply'; subject: 'conversation' | 'clarification'; text: string }
  | { action: 'read'; subject: 'schedule' | 'cohort' | 'announcements' | 'operation_status'; query: Grounded<string>; tool?: ReadToolInvocation }
  | { action: 'create'; subject: 'announcements'; data: AnnouncementDraft }
  | { action: 'update'; subject: 'announcements'; target: SemanticTarget; patch: AnnouncementPatch }
  | { action: 'cancel' | 'undo'; subject: 'announcements'; target: SemanticTarget }
  | { action: 'publish'; subject: 'announcements'; targets: SemanticTarget[] }
);
export interface SemanticPlanV1 { version: 1; operations: SemanticOperation[] }

export interface SemanticScope { botId: number; chatId: number; threadId: number | null; userId: number }
export interface SemanticSource {
  id: string;
  kind: 'current' | 'quote' | 'reply';
  text: string;
  /** Location in originalText; null is reserved for an external reply. */
  messageStart: number | null;
}
export interface TargetSnapshot {
  reference: AssistantReference;
  currentRevision: number;
  ownerId: number;
  state: 'active' | 'cancelled';
  independentVerification: 'unverified' | 'verified';
}
export interface TargetBinding {
  selector: SemanticTarget;
  scope: SemanticScope;
  expiresAt: number;
  snapshots: readonly TargetSnapshot[];
}
/** Supplied by an independent application check, NOT copied from the model.
 * Merely matching a span or the model's speechAct cannot create this attestation.
 * If intent/adoption/change scope cannot be established, omit it and fail closed.
 */
export interface TrustedInstruction {
  operationId: string;
  action: MutationAction;
  speechAct: SpeechAct;
  evidence: EvidenceSpan;
  adoptedSourceIds?: readonly string[];
  /** Exact independently established field edits (including set versus clear). */
  requestedChanges?: Readonly<AnnouncementPatch>;
  /** Independently established selectors, never derived from a model proposal. */
  requestedTargets?: readonly SemanticTarget[];
  /** Independently established prerequisite IDs; model dependency edges cannot replace them. */
  requiredDependencies?: readonly string[];
}
export interface ValidationContext {
  originalText: string;
  originalTimestamp: number;
  messageId: number;
  updateId: number;
  now: number;
  scope: SemanticScope;
  sources: readonly SemanticSource[];
  actor: { verified: boolean; userId: number; ownerUid: number | null };
  /** Locally established capabilities; absence denies writes. */
  allowedActions?: readonly SemanticAction[];
  /** Opt-in fail-closed target intent binding for aligned offline planning. */
  requireTargetIntent?: boolean;
  instructions: readonly TrustedInstruction[];
  targetBindings: readonly TargetBinding[];
}

/** Results originate from the application after execution, never from a proposed plan. */
export type OperationState = 'succeeded' | 'accepted' | 'partial' | 'clarification_required'
  | 'denied' | 'conflict' | 'failed' | 'unknown';
export type SemanticOperationResult = { operationId: string } & (
  | { status: 'succeeded'; delivery: { state: 'not_applicable' } | {
    state: 'sent'; messageId: number; chatId: number } }
  | { status: 'accepted'; delivery: { state: 'queued' } }
  | { status: 'unknown'; delivery: { state: 'unknown' } }
  | { status: Exclude<OperationState, 'succeeded' | 'accepted' | 'unknown'>; delivery: { state: 'not_sent' } }
);
export type ValidationReason = 'invalid_schema' | 'invalid_context' | 'too_many_operations'
  | 'duplicate_operation' | 'invalid_dependency' | 'cyclic_dependency'
  | 'invalid_evidence' | 'source_region_mismatch' | 'quoted_instruction'
  | 'non_executable_speech_act' | 'intent_not_established' | 'permission_denied'
  | 'missing_information' | 'unresolved_target' | 'ambiguous_target' | 'expired_reference'
  | 'scope_mismatch' | 'stale_reference' | 'unrequested_patch' | 'unrequested_target' | 'ungrounded_value';
export interface ValidationIssue { operationId: string | null; reason: ValidationReason; field?: string }
export interface ValidatedOperation {
  operation: SemanticOperation;
  identity: string;
  targets: readonly TargetSnapshot[];
  /** New student reports remain unverified, irrespective of claimedCertainty. */
  independentVerification: 'unverified' | null;
}
export type SemanticValidation = {
  ok: true; plan: SemanticPlanV1; operations: readonly ValidatedOperation[];
} | {
  ok: false; status: 'failed' | 'clarification_required' | 'denied' | 'conflict'; issues: ValidationIssue[];
};
