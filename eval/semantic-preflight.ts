import { createHash } from 'node:crypto';
import { MODEL_PLAN_DRAFT_JSON_SCHEMA } from '../src/semantic-draft';
import { EVAL_COMPLETION_TOKENS, estimateEvalReservation, LIVE_EVAL_LIMITS, type EvalAccountLimits } from '../src/semantic-eval-guard';
import { ContextBuilder } from '../src/semantic-compiler';
import type { SemanticGoldCase } from '../src/semantic-eval';

/** Human-curated priority: four core language/action samples, then two scoped-context samples. */
export const SMOKE_CANDIDATE_IDS = ['iraqi_anbari-01', 'english-02', 'negation_quote-01', 'save_update_cancel-01',
  'old_list_reply-02', 'fake_admin_claim-01'] as const;
export const SMOKE_RESERVE_TARGET = 35000;

export function selectAdaptiveSmoke(cases: readonly SemanticGoldCase[], account: EvalAccountLimits = {}, reserveLimit = SMOKE_RESERVE_TARGET) {
  const minuteCap = Math.min(LIVE_EVAL_LIMITS.minuteTokens, account.tokensPerMinute ?? Infinity);
  const totalCap = Math.min(SMOKE_RESERVE_TARGET, LIVE_EVAL_LIMITS.totalTokens, reserveLimit);
  if (!Number.isFinite(totalCap) || totalCap < 0 || Object.values(account).some(v => !Number.isSafeInteger(v) || v < 0)) throw Error('Invalid smoke limits');
  const selected: { id: string; tokens: number; reservation: ReturnType<typeof estimateEvalReservation> }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of SMOKE_CANDIDATE_IDS) {
    const gold = cases.find(g => g.id === id);
    if (!gold) { skipped.push({ id, reason: 'missing_case' }); continue; }
    const reservation = estimateEvalReservation(new ContextBuilder().build(gold.input, gold.context).messages);
    const tokens = reservation.totalReserved;
    const reason = !Number.isFinite(tokens) ? 'unbounded_request' : tokens > minuteCap ? 'single_request_minute_cap'
      : tokens > (account.remainingTokens ?? Infinity) ? 'account_remaining_tokens'
      : selected.length >= Math.min(6, LIVE_EVAL_LIMITS.requests, account.remainingRequests ?? Infinity) ? 'request_budget'
      : selected.reduce((sum, c) => sum + c.tokens, 0) + tokens > totalCap ? 'smoke_reserve_budget' : null;
    if (reason) skipped.push({ id, reason }); else selected.push({ id, tokens, reservation });
  }
  const coverage = { iraqi: selected.some(s => s.id === 'iraqi_anbari-01'), englishOrMixed: selected.some(s => s.id === 'english-02'),
    negation: selected.some(s => s.id === 'negation_quote-01'), read: selected.some(s => cases.find(g => g.id === s.id)!.expectedPlan.operations.some(o => o.action === 'read')),
    create: selected.some(s => cases.find(g => g.id === s.id)!.expectedPlan.operations.some(o => o.action === 'create')),
    context: selected.some(s => cases.find(g => g.id === s.id)!.contextResolution) };
  const missingCore = Object.entries(coverage).filter(([key, present]) => key !== 'context' && !present).map(([key]) => key);
  return { selected, skipped, count: selected.length, totalReserved: selected.reduce((sum, c) => sum + c.tokens, 0),
    reserveCeiling: totalCap, minuteCap, outputReservedPerRequest: EVAL_COMPLETION_TOKENS, coverage,
    blocker: missingCore.length ? `missing_core_coverage:${missingCore.join(',')}` : null,
    note: 'Per-request reservations are heuristic plus 15% input margin and full output allowance. The paced runner waits outside the planner deadline and holds each full reservation for 60 seconds after settlement; hard failures/duration/cancellation stop the run.' };
}

/** Local inspection against the stored official-doc review, never a provider/schema handshake. */
export function evalSchemaPreflight() {
  let closedObjects = 0, nullableFields = 0;
  const errors: string[] = [];
  function walk(value: unknown, path: string) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(path); return; }
    const s = value as Record<string, any>;
    if (s.type === 'object') {
      const properties = Object.keys(s.properties ?? {}), required = s.required ?? [];
      if (s.additionalProperties !== false || properties.length !== required.length || !properties.every(k => required.includes(k))) errors.push(path);
      closedObjects++; for (const key of properties) walk(s.properties[key], `${path}.${key}`);
    }
    if (s.anyOf) {
      if (s.anyOf.some((branch: any) => branch.type === 'null')) nullableFields++;
      s.anyOf.forEach((branch: unknown, i: number) => walk(branch, `${path}.anyOf.${i}`));
    }
    if (s.type === 'array') walk(s.items, `${path}.items`);
  }
  walk(MODEL_PLAN_DRAFT_JSON_SCHEMA, '$');
  return { model: 'openai/gpt-oss-120b', schemaVersion: 1, schemaName: 'semantic_plan_draft_v1',
    schemaHashAlgorithm: 'SHA-256(JSON.stringify wire schema)',
    schemaHash: createHash('sha256').update(JSON.stringify(MODEL_PLAN_DRAFT_JSON_SCHEMA)).digest('hex'),
    responseFormat: 'json_schema', strict: true, tools: false, streaming: false,
    closedObjects, nullableFields, localCompatible: errors.length === 0, errors,
    documentationReviewDate: '2026-10-29', currentDocumentationRechecked: false,
    documentation: ['https://console.groq.com/docs/structured-outputs', 'https://console.groq.com/docs/api-reference'],
    liveAcceptance: 'not_tested', note: 'No external calls permitted in 3B.1. Stored documentation review only; local compatibility does not prove current Groq acceptance.' };
}
