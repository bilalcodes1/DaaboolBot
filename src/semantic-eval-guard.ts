import type { GroqPlanRequest, PlannerTransport } from './groq-planner';
import { estimateAssistantRequestTokens } from './assistant-ai';
import { MODEL_PLAN_DRAFT_JSON_SCHEMA } from './semantic-draft';
import { SEMANTIC_BRAIN_INSTRUCTIONS } from './semantic-compiler';
import { plainReadObject } from './read-tool-contracts';
import type { AssistantAiMessage } from './assistant-ai';
import { evidenceRedactor } from '../eval/semantic-evidence';
import { QUALITY_INSTRUCTIONS } from '../eval/semantic-quality-prompt';
import { UNDERSTANDING_INSTRUCTIONS } from '../eval/semantic-understanding-prompt';
import { FINAL_CONTRACT_INSTRUCTIONS } from '../eval/semantic-final-contract-prompt';

export const LIVE_EVAL_LIMITS = { requests: 12, totalTokens: 50000, minuteTokens: 5000 } as const;
export const EVAL_COMPLETION_TOKENS = 1024;
export const EVAL_INPUT_MARGIN = 0.15;
export const PACED_EVAL_LIMITS = { requests: 6, durationMs: 600000, waitSliceMs: 1000 } as const;
export interface EvalReservation { inputEstimate: number; inputSafetyMargin: number; outputReserved: number; totalReserved: number }
/** Script-aware heuristic + explicit margin, NOT an exact tokenizer or reported API consumption. */
export function estimateEvalReservation(messages: AssistantAiMessage[], outputReserved = EVAL_COMPLETION_TOKENS): EvalReservation {
  const base = estimateAssistantRequestTokens(messages, { schema: MODEL_PLAN_DRAFT_JSON_SCHEMA, maxTokens: outputReserved });
  const inputEstimate = base - outputReserved, inputSafetyMargin = Math.ceil(inputEstimate * EVAL_INPUT_MARGIN);
  return { inputEstimate, inputSafetyMargin, outputReserved, totalReserved: inputEstimate + inputSafetyMargin + outputReserved };
}
export interface EvalAccountLimits { tokensPerMinute?: number; requestsPerMinute?: number; remainingTokens?: number; remainingRequests?: number }
export interface GuardOptions {
  promptProfile?:'quality-v3'|'understanding-v4'|'contract-v5';
  liveFlag?: boolean; environmentOptIn?: string; credential?: string;
  /** Explicit injection only; no global fetch lookup in this module. */
  fetcher?: typeof fetch; accountLimits?: EvalAccountLimits; clock?: () => number;
  /** Application allowlist built only from curated synthetic cases, not model/user arguments. */
  syntheticPromptAllowed?: (dynamicContext: string) => boolean;
  /** Evaluation evidence only: numeric allowlisted response metadata, never request headers. */
  onResponseMetadata?: (metadata: { status: number; rateLimits: GuardState['headers'] }) => void;
  /** Waits happen BEFORE the planner's HTTP deadline, never inside a model attempt. */
  pacing?: { deadlineAt: number; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; snapshot?: GuardSnapshot;
    limits?: { requests: number; totalReservedTokens: number } };
}
export interface SanitizedProviderError { status: number; code: string | null; type: string | null; message: string }
export interface GuardState {
  requests: number; reportedTokens: number; reservedUnknownTokens: number; stop: string | null;
  accountLimitsSource: 'operator_supplied' | 'unavailable_conservative'; providerError: SanitizedProviderError | null;
  headers: Partial<Record<'limitTokens' | 'remainingTokens' | 'remainingRequests' | 'resetTokensMs' | 'resetRequestsMs' | 'retryAfterMs', number>>;
  observedBudgetBreach: boolean;
  estimates: EvalReservation[];
}
export interface GuardSnapshot { state: GuardState; window: { at: number; tokens: number }[]; headersAt: number | null; accountLimits: EvalAccountLimits | null }
export class EvaluationStop extends Error { constructor(readonly code: string) { super(code); } }
export function abortableEvalSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new EvaluationStop('evaluation_cancelled')); return; }
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new EvaluationStop('evaluation_cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
function abortRace<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new EvaluationStop('evaluation_cancelled'));
    if (signal.aborted) { void promise.catch(() => {}); reject(new EvaluationStop('evaluation_cancelled')); return; }
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const durationMs = (v: string | null): number | undefined => {
  if (!v || v.length > 80 || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/u.test(v)) return undefined;
  let n = 0; for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gu)) n += Number(m[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2]!]!);
  return Math.min(86400000, Math.ceil(n));
};
/** Closed request preflight verified against the official documentation linked in the Phase 3B report. */
export function assertEvalRequest(request: GroqPlanRequest, profile?:'quality-v3'|'understanding-v4'|'contract-v5'): void {
  const r = request as unknown as Record<string, unknown>;
  if ((profile!==undefined&&!['quality-v3','understanding-v4','contract-v5'].includes(profile))||r.model !== 'openai/gpt-oss-120b' || r.stream !== false || r.max_completion_tokens !== EVAL_COMPLETION_TOKENS || r.temperature !== 0
    || r.reasoning_effort !== 'low' || r.include_reasoning !== false || Object.keys(r).some(k => !['model', 'messages', 'stream', 'temperature', 'max_completion_tokens', 'reasoning_effort', 'include_reasoning', 'response_format'].includes(k))
    || !Array.isArray(request.messages) || request.messages.length !== 2 || request.messages[0]?.role !== 'system'
    || request.messages[0]?.content !== (profile==='contract-v5'?FINAL_CONTRACT_INSTRUCTIONS:profile==='understanding-v4'?UNDERSTANDING_INSTRUCTIONS:profile==='quality-v3'?QUALITY_INSTRUCTIONS:SEMANTIC_BRAIN_INSTRUCTIONS) || request.messages[1]?.role !== 'user'
    || request.response_format?.type !== 'json_schema' || request.response_format.json_schema?.strict !== true
    || request.response_format.json_schema.name !== 'semantic_plan_draft_v1'
    || JSON.stringify(request.response_format.json_schema.schema) !== JSON.stringify(MODEL_PLAN_DRAFT_JSON_SCHEMA)) throw new EvaluationStop('request_schema_rejected_locally');
}
async function boundedBody(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > 65536) { await response.body?.cancel(); throw new EvaluationStop('provider_body_limit'); }
  const reader = response.body?.getReader(); if (!reader) throw new EvaluationStop('empty_provider_body');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; bytes += r.value.byteLength;
      if (bytes > 65536) { await reader.cancel(); throw new EvaluationStop('provider_body_limit'); } chunks.push(r.value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  const decoded = new TextDecoder().decode(result);
  try { return JSON.parse(decoded); } catch { return decoded; }
}
function sanitizedError(status: number, body: unknown, credential: string): SanitizedProviderError {
  const error = plainReadObject(body) && plainReadObject(body.error) ? body.error : {};
  const redactor = evidenceRedactor([credential]);
  const clean = (v: unknown, max: number) => typeof v === 'string' ? redactor.raw(v,null,false)!.slice(0,max) : null;
  return { status, code: clean(error.code, 120), type: clean(error.type, 120), message: clean(error.message ?? body, 2000) ?? 'No structured provider error message' };
}
/** Live guards are implemented but OFF unless BOTH independent switches are supplied. */
export class GuardedGroqEvaluation {
  readonly state: GuardState;
  private inFlight = false;
  private readonly window: { at: number; tokens: number }[] = [];
  private readonly now: () => number;
  private headersAt: number | null = null;
  private waiting = false;
  waitedMs = 0;
  constructor(private readonly options: GuardOptions = {}) {
    this.now = options.clock ?? Date.now;
    if (options.accountLimits && Object.values(options.accountLimits).some(v => !count(v))) throw new EvaluationStop('invalid_account_limits');
    this.state = { requests: 0, reportedTokens: 0, reservedUnknownTokens: 0, stop: null,
      accountLimitsSource: options.accountLimits ? 'operator_supplied' : 'unavailable_conservative', providerError: null, headers: {}, observedBudgetBreach: false, estimates: [] };
    if (options.pacing) {
      const limits = options.pacing.limits;
      if (limits && (!count(limits.requests) || limits.requests < 1 || limits.requests > PACED_EVAL_LIMITS.requests
        || !count(limits.totalReservedTokens) || limits.totalReservedTokens < 1 || limits.totalReservedTokens > LIVE_EVAL_LIMITS.totalTokens)) throw new EvaluationStop('invalid_paced_limits');
      if (!Number.isFinite(options.pacing.deadlineAt) || options.pacing.deadlineAt > this.now() + PACED_EVAL_LIMITS.durationMs) throw new EvaluationStop('invalid_evaluation_deadline');
      if (options.pacing.snapshot) {
        // Only the separately validated checkpoint reader supplies this application-owned snapshot.
        const snapshot = structuredClone(options.pacing.snapshot);
        Object.assign(this.state, snapshot.state); this.window.push(...snapshot.window); this.headersAt = snapshot.headersAt;
        const merged: EvalAccountLimits = {};
        for (const key of ['tokensPerMinute','requestsPerMinute','remainingTokens','remainingRequests'] as const) {
          const limit = Math.min(options.accountLimits?.[key] ?? Infinity, snapshot.accountLimits?.[key] ?? Infinity);
          if (Number.isFinite(limit)) merged[key] = limit;
        }
        if (Object.keys(merged).length) options.accountLimits = merged;
      }
    }
  }
  private stop(code: string): never { this.state.stop ??= code; throw new EvaluationStop(this.state.stop); }
  halt(code: 'evaluation_cancelled' | 'safety_failure' | 'semantic_failure' | 'checkpoint_failure') { this.state.stop ??= code; }
  snapshot(): GuardSnapshot { return structuredClone({ state: this.state, window: this.window, headersAt: this.headersAt, accountLimits: this.options.accountLimits ?? null }); }
  private capacity(estimate: number): { reason: string; waitMs: number | null } | null {
    const now = this.now(), paced = this.options.pacing;
    if (this.state.stop) return { reason: this.state.stop, waitMs: null };
    if (paced?.signal?.aborted) return { reason: 'evaluation_cancelled', waitMs: null };
    if (paced && now >= paced.deadlineAt) return { reason: 'evaluation_duration_limit', waitMs: null };
    if (this.state.requests >= (paced?.limits?.requests ?? (paced ? PACED_EVAL_LIMITS.requests : LIVE_EVAL_LIMITS.requests))) return { reason: 'request_cap', waitMs: null };
    if (!Number.isFinite(estimate)) return { reason: 'unbounded_request', waitMs: null };
    if (paced?.limits && this.state.estimates.reduce((sum, e) => sum + e.totalReserved, 0) + estimate > paced.limits.totalReservedTokens) return { reason: 'total_reserved_budget', waitMs: null };
    if (this.state.reportedTokens + this.state.reservedUnknownTokens + estimate > LIVE_EVAL_LIMITS.totalTokens) return { reason: 'total_token_budget', waitMs: null };
    while (this.window[0] && this.window[0].at <= now - 60000) this.window.shift();
    const cap = Math.min(LIVE_EVAL_LIMITS.minuteTokens, this.options.accountLimits?.tokensPerMinute ?? Infinity, this.state.headers.limitTokens ?? Infinity);
    if (estimate > cap) return { reason: 'single_request_minute_cap', waitMs: null };
    const expired = (reset: number | undefined) => paced && this.headersAt !== null && reset !== undefined && now >= this.headersAt + reset;
    if (expired(this.state.headers.resetTokensMs)) delete this.state.headers.remainingTokens;
    if (expired(this.state.headers.resetRequestsMs)) delete this.state.headers.remainingRequests;
    if (expired(this.state.headers.retryAfterMs)) delete this.state.headers.retryAfterMs;
    const rpm = this.options.accountLimits?.requestsPerMinute ?? Infinity;
    if (rpm === 0) return { reason: 'provider_minute_request_budget', waitMs: null };
    if (this.window.length >= rpm) return { reason: 'provider_minute_request_budget', waitMs: this.window[0]!.at + 60000 - now };
    let total = this.window.reduce((n, r) => n + r.tokens, 0);
    if (total + estimate > cap) {
      for (const entry of this.window) { total -= entry.tokens; if (total + estimate <= cap) return { reason: 'minute_token_budget', waitMs: entry.at + 60000 - now }; }
    }
    if (this.state.requests === 0 && this.options.accountLimits?.remainingTokens !== undefined && this.options.accountLimits.remainingTokens < estimate) return { reason: 'provider_token_budget', waitMs: null };
    const until = (reset: number | undefined) => reset === undefined || this.headersAt === null ? null : Math.max(1, this.headersAt + reset - now);
    if (this.state.headers.remainingTokens !== undefined && this.state.headers.remainingTokens < estimate) return { reason: 'provider_token_budget', waitMs: until(this.state.headers.resetTokensMs) };
    if (this.options.accountLimits?.remainingRequests !== undefined && this.state.requests >= this.options.accountLimits.remainingRequests) return { reason: 'provider_request_budget', waitMs: null };
    if (this.state.headers.remainingRequests === 0) return { reason: 'provider_request_budget', waitMs: until(this.state.headers.resetRequestsMs) };
    if ((this.state.headers.retryAfterMs ?? 0) > 0) return { reason: 'provider_retry_after', waitMs: until(this.state.headers.retryAfterMs) };
    return null;
  }
  /** Application pacing, NOT an API retry. No model transport has been invoked yet. */
  async waitForCapacity(messages: AssistantAiMessage[]): Promise<void> {
    if (!this.options.pacing) return this.stop('pacing_not_configured');
    if (this.waiting || this.inFlight) return this.stop('parallel_request_forbidden');
    this.waiting = true;
    try {
      const estimate = estimateEvalReservation(messages).totalReserved;
      for (let ticks = 0; ticks < 601; ticks++) {
        const decision = this.capacity(estimate); if (!decision) return;
        if (decision.waitMs === null) return this.stop(decision.reason);
        const now = this.now();
        if (now + decision.waitMs >= this.options.pacing.deadlineAt) return this.stop('evaluation_duration_limit');
        const slice = Math.min(PACED_EVAL_LIMITS.waitSliceMs, Math.max(1, decision.waitMs));
        await (this.options.pacing.sleep ?? abortableEvalSleep)(slice, this.options.pacing.signal);
        const elapsed = this.now() - now; this.waitedMs += Math.max(0, elapsed);
        if (elapsed <= 0) return this.stop('pacing_clock_not_advancing');
      }
      return this.stop('evaluation_duration_limit');
    } catch (e) { return this.stop(this.options.pacing.signal?.aborted ? 'evaluation_cancelled' : e instanceof EvaluationStop ? e.code : 'pacing_failure'); }
    finally { this.waiting = false; }
  }
  readonly transport: PlannerTransport = async (request, signal) => {
    if (!this.options.liveFlag || this.options.environmentOptIn !== '1') return this.stop('live_mode_not_authorized');
    if (this.state.stop) return this.stop(this.state.stop);
    if (this.inFlight) return this.stop('parallel_request_forbidden');
    if (!this.options.credential || /\s/u.test(this.options.credential) || !this.options.fetcher) return this.stop('missing_environment_credential_or_transport');
    try { assertEvalRequest(request,this.options.promptProfile); } catch { return this.stop('request_schema_rejected_locally'); }
    if (!this.options.syntheticPromptAllowed?.(request.messages[1]!.content)) return this.stop('non_synthetic_request');
    if (signal.aborted) return this.stop('request_aborted');
    const reservationEstimate = estimateEvalReservation(request.messages, request.max_completion_tokens), estimate = reservationEstimate.totalReserved;
    const denied = this.capacity(estimate);
    if (denied) return this.stop(denied.reason === 'single_request_minute_cap' && !this.options.pacing ? 'minute_token_budget' : denied.reason);
    const now = this.now();
    const minuteCap = Math.min(LIVE_EVAL_LIMITS.minuteTokens, this.options.accountLimits?.tokensPerMinute ?? Infinity, this.state.headers.limitTokens ?? Infinity);
    this.inFlight = true; this.state.requests++; this.state.reservedUnknownTokens += estimate; this.state.estimates.push(reservationEstimate);
    this.window.push({ at: now, tokens: estimate }); const reservation = this.window[this.window.length - 1]!;
    const combined = new AbortController(), cancel = () => combined.abort();
    signal.addEventListener('abort', cancel, { once: true }); this.options.pacing?.signal?.addEventListener('abort', cancel, { once: true });
    const durationTimer = this.options.pacing ? setTimeout(cancel, Math.max(1, this.options.pacing.deadlineAt - now)) : undefined;
    try {
      const response = await abortRace(this.options.fetcher('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', redirect: 'manual', signal: combined.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.credential}` }, body: JSON.stringify(request),
      }), combined.signal);
      this.headersAt = this.now();
      const observedHeaders: GuardState['headers'] = {};
      for (const [header, key] of [['x-ratelimit-limit-tokens', 'limitTokens'], ['x-ratelimit-remaining-tokens', 'remainingTokens'], ['x-ratelimit-remaining-requests', 'remainingRequests']] as const) {
        const value = response.headers.get(header); if (value !== null && /^\d{1,12}$/u.test(value)) this.state.headers[key] = observedHeaders[key] = Number(value);
      }
      const reset = durationMs(response.headers.get('x-ratelimit-reset-tokens'));
      if (reset !== undefined) this.state.headers.resetTokensMs = observedHeaders.resetTokensMs = reset;
      const requestReset = durationMs(response.headers.get('x-ratelimit-reset-requests'));
      if (requestReset !== undefined) this.state.headers.resetRequestsMs = observedHeaders.resetRequestsMs = requestReset;
      const retry = response.headers.get('retry-after');
      if (retry !== null) {
        const ms = /^\d+(?:\.\d+)?$/u.test(retry) ? Math.ceil(Number(retry) * 1000) : Date.parse(retry) - now;
        if (Number.isFinite(ms)) this.state.headers.retryAfterMs = observedHeaders.retryAfterMs = Math.min(86400000, Math.max(0, ms));
      }
      this.options.onResponseMetadata?.({ status: response.status, rateLimits: observedHeaders });
      const body = await abortRace(boundedBody(response), combined.signal);
      const usage = plainReadObject(body) && plainReadObject(body.usage) ? body.usage : null;
      const total = usage && count(usage.total_tokens) ? usage.total_tokens
        : usage && count(usage.prompt_tokens) && count(usage.completion_tokens) ? usage.prompt_tokens + usage.completion_tokens : null;
      if (total !== null) {
        this.state.reservedUnknownTokens -= estimate; this.state.reportedTokens += total;
        reservation.tokens = this.options.pacing ? Math.max(estimate, total) : total;
        // Keep completed consumption in the rolling window for a full minute after settlement.
        reservation.at = this.now();
      }
      if (response.status !== 200) {
        this.state.providerError = sanitizedError(response.status, body, this.options.credential);
        this.state.stop = response.status === 429 ? 'rate_limited' : [401, 403].includes(response.status) ? 'authentication_error'
          : response.status === 400 ? 'schema_or_request_400' : 'provider_error';
      } else if (total === null) this.state.stop = 'missing_reported_usage';
      if (response.status === 200 && typeof body === 'string') this.state.stop = 'malformed_provider_body';
      if (this.state.reportedTokens > LIVE_EVAL_LIMITS.totalTokens || this.window.reduce((n, r) => n + r.tokens, 0) > minuteCap) {
        this.state.observedBudgetBreach = true; this.state.stop = 'reported_budget_exceeded';
      } else if (this.state.reportedTokens === LIVE_EVAL_LIMITS.totalTokens) this.state.stop = 'total_token_budget';
      return { status: response.status, body };
    } catch (e) {
      this.state.stop ??= this.options.pacing?.signal?.aborted ? 'evaluation_cancelled'
        : this.options.pacing && this.now() >= this.options.pacing.deadlineAt ? 'evaluation_duration_limit'
        : signal.aborted ? 'request_timeout_or_abort' : e instanceof EvaluationStop ? e.code : 'transport_error';
      throw new EvaluationStop(this.state.stop);
    } finally {
      this.inFlight = false; if (durationTimer !== undefined) clearTimeout(durationTimer);
      signal.removeEventListener('abort', cancel); this.options.pacing?.signal?.removeEventListener('abort', cancel);
    }
  };
}
