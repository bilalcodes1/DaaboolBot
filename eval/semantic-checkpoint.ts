import { createHash } from 'node:crypto';
import { SEMANTIC_BRAIN_INSTRUCTIONS, SEMANTIC_BRAIN_PROMPT_VERSION, ContextBuilder } from '../src/semantic-compiler';
import { EVAL_COMPLETION_TOKENS, PACED_EVAL_LIMITS, LIVE_EVAL_LIMITS, estimateEvalReservation, type GuardSnapshot } from '../src/semantic-eval-guard';
import { semanticPlanMeaning, type EvalRecord, type SemanticGoldCase } from '../src/semantic-eval';
import { plainReadObject as object } from '../src/read-tool-contracts';
import { evalSchemaPreflight } from './semantic-preflight';
import { GOLD_DATASET_VERSION } from './semantic-gold';
import { isContrastSelection, CONTRAST_LIMITS } from './semantic-case-selection';
import { EVAL_OUTPUT_LIMITS, evidenceIdentity, validEvaluationEvidence } from './semantic-evidence';
import { isQualitySelection, QUALITY_GOLD_VERSION } from './semantic-gold-v2';
import { QualityContextBuilder, QUALITY_INSTRUCTIONS, QUALITY_PROMPT_VERSION } from './semantic-quality-prompt';
import { isUnderstandingSelection, UNDERSTANDING_LIMITS } from './semantic-understanding-gate';
import { UNDERSTANDING_GOLD_VERSION } from './semantic-understanding-fixtures';
import { UnderstandingContextBuilder, UNDERSTANDING_INSTRUCTIONS, UNDERSTANDING_PROMPT_VERSION } from './semantic-understanding-prompt';
import { isFinalContractSelection,FINAL_CONTRACT_LIMITS } from './semantic-final-contract';
import { FinalContractContextBuilder,FINAL_CONTRACT_INSTRUCTIONS,FINAL_CONTRACT_PROMPT_VERSION } from './semantic-final-contract-prompt';
import { FINAL_CONTRACT_NORMALIZATION_VERSION } from '../src/semantic-contract-alignment';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const closed = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function checkpointIdentity(cases: readonly SemanticGoldCase[]) {
  const schema = evalSchemaPreflight();
  const contract=isFinalContractSelection(cases),quality=isQualitySelection(cases),understanding=isUnderstandingSelection(cases),builder=contract?new FinalContractContextBuilder():understanding?new UnderstandingContextBuilder():quality?new QualityContextBuilder():new ContextBuilder();
  const limits:{executionLimits?:{requests:number;totalReservedTokens:number;minuteTokens:number;durationMs:number}}=contract?{executionLimits:FINAL_CONTRACT_LIMITS}:understanding?{executionLimits:UNDERSTANDING_LIMITS}:isContrastSelection(cases)||quality?{executionLimits:CONTRAST_LIMITS}:{};
  return { model: schema.model, modelHash: createHash('sha256').update(schema.model).digest('hex'), modelHashKind:'identifier_sha256' as const,
    schemaVersion: schema.schemaVersion, schemaHash: schema.schemaHash,
    promptVersion: contract?FINAL_CONTRACT_PROMPT_VERSION:understanding?UNDERSTANDING_PROMPT_VERSION:quality?QUALITY_PROMPT_VERSION:SEMANTIC_BRAIN_PROMPT_VERSION,
    promptHash: hash(contract?FINAL_CONTRACT_INSTRUCTIONS:understanding?UNDERSTANDING_INSTRUCTIONS:quality?QUALITY_INSTRUCTIONS:SEMANTIC_BRAIN_INSTRUCTIONS),
    ...(contract?{normalizationVersion:FINAL_CONTRACT_NORMALIZATION_VERSION}:{}),
    datasetVersion: contract||understanding?UNDERSTANDING_GOLD_VERSION:quality?QUALITY_GOLD_VERSION:GOLD_DATASET_VERSION,
    goldAndContextHash: hash(cases), completionTokens: EVAL_COMPLETION_TOKENS,
    cases: cases.map(c => ({ id: c.id, requestHash: hash(builder.build(c.input, c.context).messages) })),
    ...limits };
}
export interface EvalCheckpoint {
  checkpointVersion: 2; identity: ReturnType<typeof checkpointIdentity>;
  startedAt: number; deadlineAt: number; savedAt: number;
  completedCaseIds: string[]; inFlightCaseId: string | null; records: EvalRecord[];
  receipts: { caseId: string; admittedAt: number; settledAt: number; reservedTokens: number; reportedTokens: number | null; headers: GuardSnapshot['state']['headers'] }[];
  guard: GuardSnapshot; integrity: string;
}
export function sealCheckpoint(value: Omit<EvalCheckpoint, 'integrity'>): EvalCheckpoint {
  const owned = structuredClone(value); return { ...owned, integrity: hash(owned) };
}

/** A local checkpoint is a ledger, never an authority for production actions. */
function recordShape(v: unknown, gold: SemanticGoldCase): v is EvalRecord {
  if (!closed(v, ['caseId','categories','source','attempted','modelOutputReceived','stages','modelPlan','expectedPlan','comparison','validator',
    'failures','rawExact','correctCompletion','ambiguityCorrect','falseWriteProposal','falseWritePassingValidator','unauthorizedProposal',
    'wrongTargetAccepted','hallucinatedFields','invalidPlan','unnecessaryClarification','safeAbstention','latencyMs','usage','plannerError','toolExecutions','evidence'])) return false;
  const strings = (x: unknown) => Array.isArray(x) && x.length <= 32 && x.every(s => typeof s === 'string' && s.length <= 120);
  if (v.caseId !== gold.id || v.source !== 'live_groq' || v.attempted !== true || v.toolExecutions !== 0 || !strings(v.categories)
    || JSON.stringify(v.categories) !== JSON.stringify(gold.categories) || !strings(v.failures)
    || !integer(v.hallucinatedFields) || !(v.latencyMs === null || typeof v.latencyMs === 'number' && Number.isFinite(v.latencyMs) && v.latencyMs >= 0)
    || !(v.plannerError === null || typeof v.plannerError === 'string' && /^[a-z_]{1,80}$/u.test(v.plannerError))) return false;
  for (const key of ['modelOutputReceived','rawExact','correctCompletion','ambiguityCorrect','falseWriteProposal','falseWritePassingValidator',
    'unauthorizedProposal','wrongTargetAccepted','invalidPlan','unnecessaryClarification','safeAbstention']) if (typeof v[key] !== 'boolean') return false;
  const expected = [gold.expectedPlan, ...(gold.alternatives ?? []).map(a => a.plan)].map(semanticPlanMeaning);
  if (!expected.some(p => JSON.stringify(p) === JSON.stringify(v.expectedPlan))) return false;
  if (v.modelPlan !== null && (!closed(v.modelPlan, ['operations']) || !Array.isArray(v.modelPlan.operations) || v.modelPlan.operations.length > 12)) return false;
  if (!closed(v.comparison, ['exact','speechAct','action','slots','target','dependency','slotCorrect','slotTotal','unexpectedSlots'])
    || !['exact','speechAct','action','slots','target','dependency'].every(k => typeof (v.comparison as Record<string, unknown>)[k] === 'boolean')
    || !integer(v.comparison.slotCorrect) || !integer(v.comparison.slotTotal) || v.comparison.slotCorrect > v.comparison.slotTotal || !strings(v.comparison.unexpectedSlots)) return false;
  if (!closed(v.validator, ['expected','actual','reasons','correct']) || !['allow','deny','clarify'].includes(String(v.validator.expected))
    || !['allow','deny','clarify','invalid'].includes(String(v.validator.actual)) || !strings(v.validator.reasons)
    || !(v.validator.correct === null || typeof v.validator.correct === 'boolean')) return false;
  if (!closed(v.stages, ['schemaAcceptance','localSchemaValid','normalization','normalizationReason','executionEligibility'])
    || !['http_200','http_400','not_observed'].includes(String(v.stages.schemaAcceptance))
    || !(v.stages.localSchemaValid === null || typeof v.stages.localSchemaValid === 'boolean')
    || !['ok','rejected','not_observed'].includes(String(v.stages.normalization))
    || !(v.stages.normalizationReason === null || typeof v.stages.normalizationReason === 'string' && v.stages.normalizationReason.length <= 120)
    || !['proposal_only','read_candidate_requires_runtime_checks','not_eligible'].includes(String(v.stages.executionEligibility))) return false;
  if (v.usage !== null && (!object(v.usage) || Object.entries(v.usage).some(([k, value]) => !['promptTokens','completionTokens','totalTokens','cachedTokens'].includes(k) || !integer(value)))) return false;
  return true;
}

export type CheckpointCheck = { ok: true; checkpoint: EvalCheckpoint; remainingCaseIds: string[] } | { ok: false; reason: string };
export function validateCheckpoint(raw: unknown, cases: readonly SemanticGoldCase[], now: number): CheckpointCheck {
  const no = (reason: string): CheckpointCheck => ({ ok: false, reason });
  if (!object(raw) || ![1,2].includes(Number(raw.checkpointVersion))) return no('legacy_report_missing_reliable_checkpoint');
  if (raw.checkpointVersion !== 2) return no('checkpoint_evidence_missing_no_automatic_upgrade');
  if (!closed(raw, ['checkpointVersion','identity','startedAt','deadlineAt','savedAt','completedCaseIds','inFlightCaseId','records','receipts','guard','integrity'])) return no('checkpoint_schema_invalid');
  const { integrity, ...unsigned } = raw;
  if (typeof integrity !== 'string' || hash(unsigned) !== integrity) return no('checkpoint_integrity_mismatch');
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > EVAL_OUTPUT_LIMITS.fileBytes || /(?:gsk_|Bearer\s+(?!\[REDACTED\])|"(?:credential|authorization|password|secret)"\s*:)/iu.test(JSON.stringify(raw))) return no('checkpoint_contains_forbidden_data');
  if (JSON.stringify(raw.identity) !== JSON.stringify(checkpointIdentity(cases))) return no('checkpoint_model_schema_prompt_or_gold_mismatch');
  if (!integer(raw.startedAt) || !integer(raw.deadlineAt) || !integer(raw.savedAt) || !integer(now)
    || raw.startedAt > raw.savedAt || raw.savedAt > now || raw.deadlineAt <= raw.startedAt
    || raw.deadlineAt - raw.startedAt > PACED_EVAL_LIMITS.durationMs) return no('checkpoint_clock_invalid');
  if (now >= raw.deadlineAt) return no('checkpoint_duration_expired');
  if (raw.inFlightCaseId !== null) return no('checkpoint_inflight_outcome_unknown_no_replay');
  if (!Array.isArray(raw.records) || !Array.isArray(raw.completedCaseIds) || raw.records.length > 6
    || raw.records.length !== raw.completedCaseIds.length || raw.records.some((r, i) => !cases[i] || !recordShape(r, cases[i]!))
    || JSON.stringify(raw.completedCaseIds) !== JSON.stringify(raw.records.map(r => (r as EvalRecord).caseId))) return no('checkpoint_records_invalid');
  const traceIdentity = evidenceIdentity(checkpointIdentity(cases));
  if (raw.records.some((r,i) => !validEvaluationEvidence((r as EvalRecord).evidence,cases[i]!,traceIdentity,r as EvalRecord)
    || (r as EvalRecord).evidence!.complete !== true || (r as EvalRecord).evidence!.timestamp > Number(raw.savedAt)
    || (r as EvalRecord).evidence!.timestamp < Number(raw.startedAt))) return no('checkpoint_evidence_invalid_or_incomplete');
  if (!closed(raw.guard, ['state','window','headersAt','accountLimits']) || !closed(raw.guard.state, ['requests','reportedTokens','reservedUnknownTokens','stop',
    'accountLimitsSource','providerError','headers','observedBudgetBreach','estimates'])) return no('checkpoint_guard_invalid');
  const s = raw.guard.state;
  if (isFinalContractSelection(cases) && (Number(s.requests)>FINAL_CONTRACT_LIMITS.requests || !Array.isArray(s.estimates)
    || s.estimates.reduce((sum,e)=>sum+(object(e)&&typeof e.totalReserved==='number'?e.totalReserved:Infinity),0)>FINAL_CONTRACT_LIMITS.totalReservedTokens))return no('checkpoint_contract_limits_invalid');
  if (isUnderstandingSelection(cases) && (Number(s.requests)>UNDERSTANDING_LIMITS.requests || !Array.isArray(s.estimates)
    || s.estimates.reduce((sum,e)=>sum+(object(e)&&typeof e.totalReserved==='number'?e.totalReserved:Infinity),0)>UNDERSTANDING_LIMITS.totalReservedTokens))return no('checkpoint_understanding_limits_invalid');
  if ((isContrastSelection(cases)||isQualitySelection(cases)) && (Number(s.requests) > CONTRAST_LIMITS.requests || !Array.isArray(s.estimates)
    || s.estimates.reduce((sum, e) => sum + (object(e) && typeof e.totalReserved === 'number' ? e.totalReserved : Infinity), 0) > CONTRAST_LIMITS.totalReservedTokens)) return no('checkpoint_contrast_limits_invalid');
  if (raw.guard.accountLimits !== null && (!object(raw.guard.accountLimits) || Object.entries(raw.guard.accountLimits)
    .some(([k, v]) => !['tokensPerMinute','requestsPerMinute','remainingTokens','remainingRequests'].includes(k) || !integer(v)))) return no('checkpoint_account_limits_invalid');
  if (!integer(s.requests) || s.requests !== raw.records.length || !integer(s.reportedTokens) || s.reportedTokens > LIVE_EVAL_LIMITS.totalTokens
    || s.reservedUnknownTokens !== 0 || s.observedBudgetBreach !== false || s.providerError !== null
    || !['operator_supplied','unavailable_conservative'].includes(String(s.accountLimitsSource))
    || !Array.isArray(s.estimates) || s.estimates.length !== s.requests) return no('checkpoint_accounting_uncertain');
  if (s.stop !== null && s.stop !== 'evaluation_cancelled') return no('checkpoint_terminal_stop_no_retry');
  if (!object(s.headers) || Object.entries(s.headers).some(([k, v]) => !['limitTokens','remainingTokens','remainingRequests','resetTokensMs','resetRequestsMs','retryAfterMs'].includes(k) || !integer(v))
    || !(raw.guard.headersAt === null || integer(raw.guard.headersAt) && raw.guard.headersAt <= raw.savedAt)
    || !Array.isArray(raw.guard.window) || raw.guard.window.length > s.requests) return no('checkpoint_window_invalid');
  if (s.requests > 0 && raw.guard.headersAt === null) return no('checkpoint_window_invalid');
  let previous = raw.startedAt;
  for (const entry of raw.guard.window) {
    if (!closed(entry, ['at','tokens']) || !integer(entry.at) || !integer(entry.tokens) || entry.tokens > 5000 || entry.at < previous || entry.at > raw.savedAt) return no('checkpoint_window_invalid');
    previous = entry.at;
  }
  if (raw.guard.window.filter(e => (e as { at: number }).at > now - 60000).reduce((n, e) => n + (e as { tokens: number }).tokens, 0) > 5000) return no('checkpoint_window_invalid');
  const records = raw.records as EvalRecord[];
  if (records.some(r => r.usage?.totalTokens === undefined || r.plannerError !== null || r.falseWriteProposal || r.falseWritePassingValidator || r.wrongTargetAccepted
    || r.unauthorizedProposal && r.validator.actual === 'allow') || records.reduce((n, r) => n + r.usage!.totalTokens!, 0) !== s.reportedTokens) return no('checkpoint_result_or_usage_uncertain');
  for (const [i, estimate] of s.estimates.entries()) if (!closed(estimate, ['inputEstimate','inputSafetyMargin','outputReserved','totalReserved'])
    || !Object.values(estimate).every(integer) || estimate.outputReserved !== EVAL_COMPLETION_TOKENS
    || JSON.stringify(estimate) !== JSON.stringify(estimateEvalReservation((isFinalContractSelection(cases)?new FinalContractContextBuilder():isUnderstandingSelection(cases)?new UnderstandingContextBuilder():isQualitySelection(cases)?new QualityContextBuilder():new ContextBuilder()).build(cases[i]!.input, cases[i]!.context).messages))) return no('checkpoint_estimate_invalid');
  if (!Array.isArray(raw.receipts) || raw.receipts.length !== records.length) return no('checkpoint_receipts_invalid');
  let settled = raw.startedAt;
  for (let i = 0; i < raw.receipts.length; i++) {
    const r = raw.receipts[i];
    if (!closed(r, ['caseId','admittedAt','settledAt','reservedTokens','reportedTokens','headers']) || r.caseId !== records[i]!.caseId
      || !integer(r.admittedAt) || !integer(r.settledAt) || r.admittedAt < settled || r.settledAt < r.admittedAt || r.settledAt > raw.savedAt
      || r.reservedTokens !== (s.estimates[i] as { totalReserved: number }).totalReserved || r.reportedTokens !== records[i]!.usage!.totalTokens
      || !object(r.headers) || Object.entries(r.headers).some(([k, v]) => !['limitTokens','remainingTokens','remainingRequests','resetTokensMs','resetRequestsMs','retryAfterMs'].includes(k) || !integer(v))) return no('checkpoint_receipts_invalid');
    settled = r.settledAt;
  }
  const receipts = raw.receipts as EvalCheckpoint['receipts'];
  const expectedWindow = receipts.filter(r => r.settledAt > (raw.savedAt as number) - 60000)
    .map(r => ({ at: r.settledAt, tokens: Math.max(r.reservedTokens, r.reportedTokens!) }));
  if (JSON.stringify(raw.guard.window) !== JSON.stringify(expectedWindow)) return no('checkpoint_window_receipt_mismatch');
  const checkpoint = structuredClone(raw) as unknown as EvalCheckpoint;
  checkpoint.guard.state.stop = null; // Explicit resume after safe, pre-request cancellation only.
  return { ok: true, checkpoint, remainingCaseIds: cases.slice(records.length).map(c => c.id) };
}
