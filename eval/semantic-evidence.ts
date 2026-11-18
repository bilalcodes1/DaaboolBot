import type { CompilationResult } from '../src/semantic-compiler';
import type { EvalRecord, SemanticGoldCase } from '../src/semantic-eval';
import type { PlannerUsage } from '../src/groq-planner';
import { plainReadObject as object } from '../src/read-tool-contracts';
import { normalizeModelPlan } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';
import { FINAL_CONTRACT_NORMALIZATION_VERSION, normalizeFinalContractModelPlan } from '../src/semantic-contract-alignment';

const contractTrace=(raw:unknown,gold:SemanticGoldCase)=>({adapterVersion:FINAL_CONTRACT_NORMALIZATION_VERSION,
  adjustments:normalizeFinalContractModelPlan(raw,gold.context).adjustments});

export const EVAL_OUTPUT_LIMITS = { rawBytes: 32768, evidenceBytes: 262144, fileBytes: 4194304 } as const;
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;
const prefix = (s: string, cap: number) => new TextDecoder().decode(encoder.encode(s).slice(0, cap), { stream:true });
export interface EvidenceIdentity { model: string; modelHash:string; modelHashKind:'identifier_sha256'; promptVersion: string; promptHash: string; schemaVersion: number; schemaHash: string }
export const evidenceIdentity = (v: EvidenceIdentity): EvidenceIdentity => ({ model:v.model,modelHash:v.modelHash,modelHashKind:v.modelHashKind,
  promptVersion:v.promptVersion,promptHash:v.promptHash,schemaVersion:v.schemaVersion,schemaHash:v.schemaHash });
export interface EvidenceOptions {
  identity: EvidenceIdentity; redactValues: readonly string[]; clock?: () => number;
  metadata?: () => { status: number | null; rateLimits: Record<string, number>; providerError: unknown };
}
export interface ModelCapture {
  content: string | null; contentBytes: number | null; truncated: boolean;
  parsed: unknown; json: 'valid' | 'invalid' | 'not_received' | 'size_limit';
  contentSource: 'model_message' | 'provider_body' | null;
  status: number | null; usage: PlannerUsage | null;
}
export function captureContent(content: string): Pick<ModelCapture, 'content' | 'contentBytes' | 'truncated' | 'parsed' | 'json'> {
  const contentBytes = bytes(content), truncated = contentBytes > EVAL_OUTPUT_LIMITS.rawBytes;
  if (truncated) return { content: prefix(content, EVAL_OUTPUT_LIMITS.rawBytes), contentBytes, truncated, parsed: null, json: 'size_limit' };
  try { return { content, contentBytes, truncated, parsed: JSON.parse(content), json: 'valid' }; }
  catch { return { content, contentBytes, truncated, parsed: null, json: 'invalid' }; }
}

/** Persistence only. Never feed a redacted value back to scoring, normalization or validation. */
export function evidenceRedactor(values: readonly string[]) {
  let changed = false, depthLimited = false, rawWithheld = false;
  const known = values.filter(v => v.length > 0);
  const escape = (s:string) => s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  // Also match mixed/unicode JSON escapes in incomplete string tokens.
  const encodedKnown = known.map(value=>new RegExp(value.split('').map(c=>`(?:${escape(c)}|\\\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}|${escape(JSON.stringify(c).slice(1,-1))})`).join(''),'giu'));
  const secretKeys = String.raw`(?:(?:proxy[_-]?)?authorization|(?:groq[_-]?)?api[_-]?key|credential|password|secret|(?:access|refresh)[_-]?token)`;
  const sensitiveKey = new RegExp(`^${secretKeys}$`,'iu');
  const malformedSensitiveField = new RegExp(String.raw`"${secretKeys}"\s*:`,'iu');
  const sensitiveFieldValue = new RegExp(String.raw`("${secretKeys}"\s*:\s*)("(?:\\.|[^"\\])*"|[^\s,}\n]*)`,'giu');
  const redactString = (input: string) => {
    let s = input;
    for (const value of known) s = s.split(value).join('[REDACTED]');
    for (const pattern of encodedKnown) s = s.replace(pattern,'[REDACTED]');
    s = s.replace(/(?:gsk_|sk-)[A-Za-z0-9_-]+/gu, '[REDACTED]')
      .replace(/Bearer\s+[^\s"'<>\\]+/giu, 'Bearer [REDACTED]')
      .replace(/((?:api[_ -]?key|authorization|credential|password|secret|(?:access|refresh)[_ -]?token)["']?\s*[:=]\s*)[^\r\n]*/giu, '$1[REDACTED]');
    if (s !== input) changed = true; return s;
  };
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 40) { changed = true; depthLimited = true; return '[DEPTH_LIMIT]'; }
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(x => clean(x, depth + 1));
    if (object(v)) return Object.fromEntries(Object.entries(v).map(([key, value]) => {
      if (sensitiveKey.test(key)) { changed = true; return [redactString(key), '[REDACTED]']; }
      return [redactString(key), clean(value, depth + 1)];
    }));
    return v;
  };
  const raw = (input: string | null, parsed: unknown, parsedOk: boolean) => {
    if (input === null) return null;
    // Decode individual JSON string tokens to catch escaped credentials without
    // changing whitespace/escaping when no redaction is necessary.
    let s = input.replace(/"(?:\\.|[^"\\])*"/gu, token => {
      try { const decoded = JSON.parse(token) as string, redacted = redactString(decoded);
        return redacted !== decoded || sensitiveKey.test(decoded) ? JSON.stringify(redacted) : token;
      } catch { return token; }
    });
    if (!parsedOk && malformedSensitiveField.test(s)) {
      changed = true; rawWithheld = true; return '[REDACTED_UNPARSEABLE_SENSITIVE_RESPONSE]';
    }
    s = redactString(s).replace(sensitiveFieldValue,'$1"[REDACTED]"');
    if (parsedOk) {
      const safeParsed = clean(parsed);
      try { if (JSON.stringify(JSON.parse(s)) !== JSON.stringify(safeParsed)) s = JSON.stringify(safeParsed); }
      catch { s = JSON.stringify(safeParsed); }
    }
    if (s !== input) changed = true; return s;
  };
  return { clean, raw, get changed() { return changed; }, get depthLimited() { return depthLimited; }, get rawWithheld() { return rawWithheld; } };
}

function evidenceSpans(raw: unknown, gold: SemanticGoldCase) {
  const found: { path: string; submitted: unknown; sourceRegion: string | null; checks: { shape: boolean; sourceExists: boolean; withinBounds: boolean | null; overlapsQuote: boolean | null } }[] = [];
  if (!object(raw) || !Array.isArray(raw.operations)) return found;
  const add = (path: string, span: unknown) => {
    const shape = object(span) && Object.keys(span).length === 3 && typeof span.sourceId === 'string' && Number.isSafeInteger(span.start) && Number(span.start) >= 0 && Number.isSafeInteger(span.end) && Number(span.end) > Number(span.start);
    const source = object(span) ? gold.context.sources.find(s => s.id === span.sourceId) : undefined;
    const withinBounds = shape && source ? Number(span.end) <= source.text.length : null;
    const overlap = shape && source?.kind === 'current' ? gold.context.sources.some(q => q.kind === 'quote' && q.messageStart !== null
      && source.messageStart! + Number(span.start) < q.messageStart + q.text.length && source.messageStart! + Number(span.end) > q.messageStart) : null;
    found.push({ path, submitted: span ?? null, sourceRegion: source?.id ?? null, checks: { shape, sourceExists: !!source, withinBounds, overlapsQuote: overlap } });
  };
  raw.operations.slice(0, 12).forEach((op, i) => {
    if (!object(op)) return; add(`operations[${i}].evidence`, op.evidence);
    if (object(op.target) && Object.hasOwn(op.target, 'evidence')) add(`operations[${i}].target.evidence`, op.target.evidence);
    if (Array.isArray(op.targets)) op.targets.slice(0,12).forEach((t,j) => { if (object(t) && Object.hasOwn(t,'evidence')) add(`operations[${i}].targets[${j}].evidence`,t.evidence); });
    if (Array.isArray(op.fields)) op.fields.slice(0,9).forEach((f,j) => { if (object(f)) add(`operations[${i}].fields[${j}].evidence`,f.evidence); });
  });
  return found;
}

export function buildEvaluationEvidence(gold: SemanticGoldCase, capture: ModelCapture, result: CompilationResult, row: EvalRecord, options: EvidenceOptions, normalizationFaithful: boolean | null) {
  const metadata = options.metadata?.(), redact = evidenceRedactor(options.redactValues);
  const raw = redact.raw(capture.content, capture.parsed, capture.json === 'valid');
  const original = {
    version: 1 as const, case_id: gold.id, timestamp: (options.clock ?? Date.now)(), original_message: gold.input.originalText,
    expected_gold_plan: gold.expectedPlan, raw_model_content: raw, raw_content_bytes: capture.contentBytes,
    raw_content_source: capture.contentSource, raw_truncated: capture.truncated, parsed_model_plan: capture.json === 'valid' ? capture.parsed : null,
    normalized_plan: result.plan, json_status: capture.json,
    normalization: { status: result.metrics.normalizationError ? 'rejected' : result.plan ? 'ok' : 'not_observed', reason: result.metrics.normalizationError },
    validator: result.validation, evidence_spans: evidenceSpans(capture.parsed, gold),
    source_regions: gold.context.sources.map(s => ({ id: s.id, kind: s.kind, text: s.text, messageStart: s.messageStart, lengthUtf16: s.text.length })),
    comparison: row.comparison, scoring: { raw_semantic_match: row.rawExact, raw_model_correct: row.rawExact && !row.invalidPlan && row.stages.localSchemaValid === true,
      json_correct: capture.contentSource === 'model_message' && capture.json === 'valid',
      schema_correct: row.stages.localSchemaValid, normalization_preserves_raw_meaning: normalizationFaithful,
      validator_policy_comparison: row.validator.correct, read_execution_eligibility: row.stages.executionEligibility,
      tools_executed: 0, final_response_possible: null, final_response_note: 'Not measured: no tools/rendering/delivery ran; reply prose and factual accuracy require review.' },
    usage: capture.usage ?? row.usage, latency_ms: row.latencyMs, http_status: capture.status ?? metadata?.status ?? null,
    rate_limit_headers: metadata?.rateLimits ?? {}, provider_error: metadata?.providerError ?? null,
    planner_error: row.plannerError, identity: evidenceIdentity(options.identity),
    redacted: false, complete: capture.contentSource === 'model_message' && capture.json === 'valid' && !capture.truncated,
    unavailable: capture.contentSource !== 'model_message' ? ['model_content_not_received','parsed_model_plan','normalized_plan','validator']
      : capture.truncated ? ['raw_content_truncated', 'parsed_model_plan', 'normalized_plan','validator']
      : capture.json !== 'valid' ? ['parsed_model_plan','normalized_plan','validator'] : [] as string[],
    ...(gold.evaluationProfile==='contract-v5'?{contract:contractTrace(capture.parsed,gold)}:{}),
  };
  // raw() already sanitized JSON tokens. A second plain-text pass could consume
  // closing JSON syntax after an assignment inside a quoted reply string.
  const cleaned = redact.clean({...original,raw_model_content:null}) as typeof original;
  cleaned.raw_model_content = raw;
  cleaned.redacted = redact.changed;
  if (redact.rawWithheld) { cleaned.complete = false; cleaned.unavailable.push('unparseable_sensitive_raw_withheld'); }
  if (redact.depthLimited) { cleaned.complete = false; cleaned.unavailable.push('redaction_depth_limit'); }
  if (bytes(JSON.stringify(cleaned)) > EVAL_OUTPUT_LIMITS.evidenceBytes) {
    // Preserve a bounded failure record; never label a dropped/truncated payload complete.
    cleaned.raw_model_content = raw === null ? null : prefix(raw, 4096); cleaned.raw_truncated = true;
    cleaned.parsed_model_plan = null; cleaned.normalized_plan = null; cleaned.expected_gold_plan = null as unknown as typeof gold.expectedPlan;
    cleaned.original_message = prefix(cleaned.original_message,512); cleaned.evidence_spans = []; cleaned.source_regions = [];
    cleaned.provider_error = null; cleaned.complete = false; cleaned.unavailable = ['evidence_size_limit'];
  }
  return cleaned;
}
export type EvaluationEvidence = ReturnType<typeof buildEvaluationEvidence>;

/** Validate checkpoint evidence against frozen app-owned inputs; never authorize an action. */
export function validEvaluationEvidence(value: unknown, gold: SemanticGoldCase, identity: EvidenceIdentity, row: EvalRecord): value is EvaluationEvidence {
  const keys = ['version','case_id','timestamp','original_message','expected_gold_plan','raw_model_content','raw_content_bytes','raw_content_source','raw_truncated',
    'parsed_model_plan','normalized_plan','json_status','normalization','validator','evidence_spans','source_regions','comparison','scoring','usage','latency_ms',
    'http_status','rate_limit_headers','provider_error','planner_error','identity','redacted','complete','unavailable'];
  const contract=gold.evaluationProfile==='contract-v5';
  if(contract)keys.push('contract');
  const same = (a:unknown,b:unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(k=>Object.hasOwn(value,k))
    || value.version !== 1 || value.case_id !== gold.id || value.original_message !== gold.input.originalText
    || !Number.isSafeInteger(value.timestamp) || Number(value.timestamp) < 0 || typeof value.complete !== 'boolean' || typeof value.redacted !== 'boolean'
    || !Array.isArray(value.unavailable) || value.unavailable.some(s=>typeof s!=='string') || typeof value.raw_truncated !== 'boolean'
    || !(value.raw_model_content === null || typeof value.raw_model_content === 'string' && bytes(value.raw_model_content) <= EVAL_OUTPUT_LIMITS.evidenceBytes)
    || !same(value.expected_gold_plan,gold.expectedPlan) || !same(value.identity,identity) || bytes(JSON.stringify(value)) > EVAL_OUTPUT_LIMITS.evidenceBytes
    || !(value.raw_content_bytes === null || Number.isSafeInteger(value.raw_content_bytes) && Number(value.raw_content_bytes) >= 0)
    || !['model_message','provider_body',null].includes(value.raw_content_source as string|null)
    || !['valid','invalid','not_received','size_limit'].includes(String(value.json_status))
    || !(value.http_status === null || Number.isSafeInteger(value.http_status) && Number(value.http_status)>=100 && Number(value.http_status)<=599)
    || !same(value.usage,row.usage) || value.latency_ms !== row.latencyMs || value.planner_error !== row.plannerError || !same(value.comparison,row.comparison)
    || !object(value.normalization) || !same(Object.keys(value.normalization),['status','reason'])
    || !['ok','rejected','not_observed'].includes(String(value.normalization.status))
    || value.normalization.reason !== row.stages.normalizationReason || value.normalization.status !== row.stages.normalization
    || !object(value.rate_limit_headers) || Object.entries(value.rate_limit_headers).some(([k,v])=>!['limitTokens','remainingTokens','remainingRequests','resetTokensMs','resetRequestsMs','retryAfterMs'].includes(k)||!Number.isSafeInteger(v)||Number(v)<0)
    || !(value.provider_error === null || object(value.provider_error) && same(Object.keys(value.provider_error),['status','code','type','message'])
      && value.provider_error.status === value.http_status && [value.provider_error.code,value.provider_error.type].every(v=>v===null||typeof v==='string') && typeof value.provider_error.message==='string')) return false;
  const regions = gold.context.sources.map(s=>({id:s.id,kind:s.kind,text:s.text,messageStart:s.messageStart,lengthUtf16:s.text.length}));
  if (!same(value.source_regions,regions) || !Array.isArray(value.evidence_spans) || value.evidence_spans.length > 276
    || !object(value.scoring) || !same(Object.keys(value.scoring),['raw_semantic_match','raw_model_correct','json_correct','schema_correct','normalization_preserves_raw_meaning',
      'validator_policy_comparison','read_execution_eligibility','tools_executed','final_response_possible','final_response_note'])
    || value.scoring.tools_executed !== 0 || value.scoring.final_response_possible !== null || typeof value.scoring.final_response_note !== 'string'
    || value.scoring.raw_semantic_match !== row.rawExact || value.scoring.schema_correct !== row.stages.localSchemaValid
    || value.scoring.raw_model_correct !== (row.rawExact && !row.invalidPlan && row.stages.localSchemaValid === true)
    || value.scoring.json_correct !== (value.raw_content_source === 'model_message' && value.json_status === 'valid')
    || !(value.scoring.normalization_preserves_raw_meaning===null||typeof value.scoring.normalization_preserves_raw_meaning==='boolean')
    || value.scoring.validator_policy_comparison !== row.validator.correct || value.scoring.read_execution_eligibility !== row.stages.executionEligibility) return false;
  if(contract&&!same(value.contract,contractTrace(value.parsed_model_plan,gold)))return false;
  if (value.complete === true && (value.raw_model_content===null || value.raw_content_source!=='model_message' || value.raw_truncated || value.unavailable.length)) return false;
  if (value.validator !== null && (!object(value.validator) || !same(Object.keys(value.validator),['ok','issues']) || typeof value.validator.ok!=='boolean'
    || !Array.isArray(value.validator.issues) || !same(value.validator.issues.map(i=>object(i)?i.reason:null),row.validator.reasons))) return false;
  if (!value.redacted && value.raw_model_content!==null) {
    if (!value.raw_truncated && bytes(value.raw_model_content as string) !== value.raw_content_bytes) return false;
    if (value.json_status === 'valid') {
      try { if(!same(JSON.parse(value.raw_model_content as string),value.parsed_model_plan))return false; } catch { return false; }
    }
    if (!same(value.evidence_spans,evidenceSpans(value.parsed_model_plan,gold))) return false;
  }
  if (value.json_status === 'valid' && row.plannerError === null) {
    const normalized = contract?normalizeFinalContractModelPlan(value.parsed_model_plan,gold.context):normalizeModelPlan(value.parsed_model_plan,gold.context.sources);
    if (normalized.ok) {
      if (!same(normalized.plan,value.normalized_plan)) return false;
      const validation = validateSemanticPlan(normalized.plan,gold.context);
      if (!same(value.validator,{ok:validation.ok,issues:validation.ok?[]:validation.issues})) return false;
    } else if(value.normalized_plan!==null||value.validator!==null||value.normalization.reason!==normalized.reason)return false;
  }
  return true;
}
