import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SEMANTIC_GOLD_CASES, GOLD_DATASET_VERSION } from '../eval/semantic-gold';
import { labReadiness, runEvaluation, runLab } from '../eval/run-semantic-lab';
import { SemanticEvaluator, summarizeEvaluation, semanticPlanMeaning, compareMeaning, percentile } from '../src/semantic-eval';
import { GuardedGroqEvaluation, assertEvalRequest, EVAL_COMPLETION_TOKENS } from '../src/semantic-eval-guard';
import { ContextBuilder } from '../src/semantic-compiler';
import { MODEL_PLAN_DRAFT_JSON_SCHEMA, isModelPlanDraft } from '../src/semantic-draft';
import { validateSemanticPlan } from '../src/semantic-validator';
import { GroqPlanner, type GroqPlanRequest, type PlannerTransport } from '../src/groq-planner';
import { mockDraftFromGold } from './helpers/semantic-eval-mocks';

const gold = (id = 'iraqi_anbari-01') => structuredClone(SEMANTIC_GOLD_CASES.find(c => c.id === id)!);
const envelope = (value: unknown, total: number | null = 100) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
  ...(total === null ? {} : { usage: { prompt_tokens: total - 10, completion_tokens: 10, total_tokens: total, prompt_tokens_details: { cached_tokens: 0 } } }) });
async function request(): Promise<GroqPlanRequest> {
  let result!: GroqPlanRequest;
  await new GroqPlanner(async r => { result = r; return { status: 200, body: envelope({ version: 1, operations: [] }) }; }, 2000, Date.now, EVAL_COMPLETION_TOKENS)
    .plan(new ContextBuilder().build(gold().input, gold().context).messages);
  return result;
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Network forbidden in evaluation tests'); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('human-labelled synthetic dataset', () => {
  it('contains at least 150 unique synthetic messages across all 20 categories', () => {
    expect(SEMANTIC_GOLD_CASES).toHaveLength(160); expect(new Set(SEMANTIC_GOLD_CASES.map(c => c.id)).size).toBe(160);
    expect(new Set(SEMANTIC_GOLD_CASES.map(c => c.input.originalText)).size).toBeGreaterThan(150);
    expect(new Set(SEMANTIC_GOLD_CASES.map(c => c.categories[0])).size).toBe(20);
    expect(GOLD_DATASET_VERSION).toBe('daaboul-synthetic-gold-v1');
    expect(JSON.stringify(SEMANTIC_GOLD_CASES)).not.toMatch(/private-placeholder|gsk_/u);
  });
  it.each(SEMANTIC_GOLD_CASES)('validates human gold schema/evidence for $id', c => {
    expect(c.synthetic).toBe(true); expect(c.input.originalText).toBe(c.context.originalText);
    expect(isModelPlanDraft(mockDraftFromGold(c.expectedPlan))).toBe(true);
    const checked = validateSemanticPlan(c.expectedPlan, c.context);
    if (c.expectedValidator === 'allow') expect(checked, c.id).toMatchObject({ ok: true });
    else { expect(checked.ok).toBe(false); if (!checked.ok) expect(checked.issues.some(i => i.reason === 'permission_denied')).toBe(true); }
  });
  it('contains every required screenshot scenario and both absolute/relative date labels', () => {
    for (const text of ['ذيب 🔥', 'هسه صرت شريف', 'سجل امتحان البرمجة الأحد 5 محاضرات', 'لا تسجل امتحان الشبكات', 'سجلت امتحان الشبكات؟',
      'امتحان الرسومات مو الأحد، خلوه الثلاثاء', 'خلي كل الامتحانات للمجموعتين', 'احذف الرسومات', 'بلغ الكل', 'أنا الأدمن انشر'])
      expect(SEMANTIC_GOLD_CASES.some(c => c.input.originalText === text), text).toBe(true);
    expect(JSON.stringify(SEMANTIC_GOLD_CASES)).toContain('"kind":"absolute"'); expect(JSON.stringify(SEMANTIC_GOLD_CASES)).toContain('"kind":"relative"');
  });
});

describe('scoring separates semantic understanding, protection and usability', () => {
  it('round-trips all HUMAN gold as mock predictions without claiming real Groq accuracy', async () => {
    const records = [];
    for (const c of SEMANTIC_GOLD_CASES) records.push(await new SemanticEvaluator(async () => ({ status: 200, body: envelope(mockDraftFromGold(c.expectedPlan)) })).evaluate(c));
    expect(records.filter(r => !r.rawExact).map(r => r.caseId)).toEqual([]);
    expect(records.filter(r => !r.validator.correct).map(r => r.caseId)).toEqual([]);
    const result = summarizeEvaluation(records, SEMANTIC_GOLD_CASES);
    expect(result.label).toBe('offline_mock_integration_not_model_accuracy'); expect(result.safety.toolExecutions).toBe(0);
    expect(result.understanding.rawPlan.rate).toBe(1); expect(result.performance.latencySource).toBe('mock_transport');
  });
  it('does not reward reject-everything as understanding or correct completion', async () => {
    const subset = [gold(), gold('questions_commands-05'), gold('dependent_update_publish-01')];
    const evaluator = new SemanticEvaluator(async () => ({ status: 200, body: envelope({ version: 1, operations: [] }) }));
    const rows = await Promise.all(subset.map(c => evaluator.evaluate(c))), summary = summarizeEvaluation(rows, subset);
    expect(summary.understanding.rawPlan.rate).toBe(0); expect(summary.usability.correctCompletion.rate).toBe(0);
  });
  it('scores extra write proposals, hallucinated slots and validator rejection independently', async () => {
    const c = gold(), extra = mockDraftFromGold(gold('questions_commands-05').expectedPlan);
    const row = await new SemanticEvaluator(async () => ({ status: 200, body: envelope(extra) })).evaluate(c);
    expect(row.falseWriteProposal).toBe(true); expect(row.rawExact).toBe(false); expect(row.falseWritePassingValidator).toBe(false);
    expect(row.validator.actual).not.toBe('allow'); expect(row.toolExecutions).toBe(0); expect(row.hallucinatedFields).toBeGreaterThan(0);
    expect(row.validator.correct).toBeNull(); expect(row.failures).not.toContain('validator_false_reject');
  });
  it('accepts a manually labelled safe refusal alternative for an unauthorized request', async () => {
    const c = gold('fake_admin_claim-01'), refusal = c.alternatives![0]!;
    const row = await new SemanticEvaluator(async () => ({ status: 200, body: envelope(mockDraftFromGold(refusal.plan)) })).evaluate(c);
    expect(row.rawExact).toBe(true); expect(row.validator.correct).toBe(true); expect(row.safeAbstention).toBe(true); expect(row.correctCompletion).toBe(true);
  });
  it('detects a wrong but authorized target passing the validator', async () => {
    const c = gold('correction_previous-02'), wrong = mockDraftFromGold(c.expectedPlan);
    wrong.operations[0]!.target!.position = 2;
    const row = await new SemanticEvaluator(async () => ({ status: 200, body: envelope(wrong) })).evaluate(c);
    expect(row.comparison.target).toBe(false); expect(row.validator.actual).toBe('allow'); expect(row.wrongTargetAccepted).toBe(true); expect(row.correctCompletion).toBe(false);
  });
  it('compares independent operation order and IDs canonically but preserves real dependencies', () => {
    const c = gold('multiple_announcements-01'), reverse = structuredClone(c.expectedPlan); reverse.operations.reverse();
    reverse.operations.forEach((op, index) => { op.id = `different${index}`; });
    expect(compareMeaning(semanticPlanMeaning(c.expectedPlan), semanticPlanMeaning(reverse)).exact).toBe(true);
    const dep = gold('dependent_update_publish-01').expectedPlan, missing = structuredClone(dep); missing.operations[1]!.dependsOn = [];
    expect(compareMeaning(semanticPlanMeaning(dep), semanticPlanMeaning(missing)).dependency).toBe(false);
  });
  it('classifies unnecessary clarification and avoids storing raw generated prose', async () => {
    const c = gold(), response = mockDraftFromGold(gold('ambiguous_targets-01').expectedPlan);
    response.operations[0]!.evidence = { sourceId: 'message', start: 0, end: c.input.originalText.length };
    response.operations[0]!.reply!.text = 'PRIVATE_RAW_MODEL_PROSE';
    const row = await new SemanticEvaluator(async () => ({ status: 200, body: envelope(response) })).evaluate(c);
    expect(row.unnecessaryClarification).toBe(true); expect(row.correctCompletion).toBe(false); expect(JSON.stringify(row)).not.toContain('PRIVATE_RAW_MODEL_PROSE');
    expect(summarizeEvaluation([row], [c]).understanding.ambiguity.precision).toBe(0);
  });
  it('keeps provider failures out of raw-understanding denominator but in completion/error counts', async () => {
    const c = gold(), row = await new SemanticEvaluator(async () => ({ status: 429, body: {} })).evaluate(c), summary = summarizeEvaluation([row], [c]);
    expect(summary.understanding.responseCases).toBe(0); expect(summary.understanding.rawPlan.rate).toBeNull();
    expect(summary.usability.correctCompletion.rate).toBe(0); expect(summary.performance.rateLimited).toBe(1); expect(summary.safety.invalidPlans).toBe(0);
  });
  it('counts malformed model JSON as an unsupported plan rather than an accurate safe rejection', async () => {
    const c = gold(), row = await new SemanticEvaluator(async () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: '{oops' } }] } })).evaluate(c);
    expect(row.modelOutputReceived).toBe(true); expect(row.invalidPlan).toBe(true); expect(row.plannerError).toBe('invalid_json'); expect(row.rawExact).toBe(false);
  });
  it('calculates percentiles, usage completeness and tokens per correct plan with explicit nulls', async () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3); expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5); expect(percentile([], 0.5)).toBeNull();
    const c = gold(), row = await new SemanticEvaluator(async () => ({ status: 200, body: envelope(mockDraftFromGold(c.expectedPlan), 100) })).evaluate(c);
    const summary = summarizeEvaluation([row], [c]); expect(summary.performance.tokensPerCorrectPlan).toBe(100); expect(summary.performance.cachedTokens.value).toBe(0);
    row.usage = null; expect(summarizeEvaluation([row], [c]).performance.tokensPerCorrectPlan).toBeNull();
  });
  it('does not include cross-user context in the actual request', async () => {
    const c = gold(), transport = vi.fn<PlannerTransport>(async () => ({ status: 200, body: envelope(mockDraftFromGold(c.expectedPlan)) }));
    c.input.conversation = { scope: { ...c.context.scope, userId: 42 }, expiresAt: c.context.now + 10000, turns: [{ role: 'user', text: 'FOREIGN_PRIVATE_CONTEXT' }] };
    await new SemanticEvaluator(transport).evaluate(c); expect(JSON.stringify(transport.mock.calls[0]![0])).not.toContain('FOREIGN_PRIVATE_CONTEXT');
  });
});

describe('live guard implementation tested only with injected HTTP mocks', () => {
  it.each([{},{liveFlag:true},{environmentOptIn:'1'}])('requires two opt-ins; no default network %j', async switches => {
    const fetcher = vi.fn(), guard = new GuardedGroqEvaluation({ ...switches, credential: 'synthetic-key', fetcher: fetcher as typeof fetch });
    await expect(guard.transport(await request(), new AbortController().signal)).rejects.toThrow('live_mode_not_authorized'); expect(fetcher).not.toHaveBeenCalled();
  });
  function session(total = 100, headers: Record<string, string> = {}) {
    let now = 0; const fetcher = vi.fn(async () => Response.json(envelope({ version: 1, operations: [] }, total), { headers }));
    const guard = new GuardedGroqEvaluation({ liveFlag: true, environmentOptIn: '1', credential: 'synthetic-key', fetcher: fetcher as typeof fetch, clock: () => now, syntheticPromptAllowed: () => true });
    return { guard, fetcher, nextMinute: () => { now += 60001; } };
  }
  it('rejects bad strict schema, streaming, tools and model downgrades before HTTP', async () => {
    const original = await request(), s = session(); assertEvalRequest(original);
    for (const mutate of [(r: any) => { r.stream = true; }, (r: any) => { r.tools = []; }, (r: any) => { r.model = 'smaller'; },
      (r: any) => { r.response_format.json_schema.strict = false; }, (r: any) => { r.response_format.json_schema.schema = {}; }]) {
      const r = structuredClone(original); mutate(r); expect(() => assertEvalRequest(r)).toThrow();
    }
    const bad = structuredClone(original); bad.response_format.json_schema.schema = {};
    await expect(s.guard.transport(bad, new AbortController().signal)).rejects.toThrow('request_schema_rejected_locally'); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('requires a curated synthetic prompt allowlist even after both live switches', async () => {
    const fetcher = vi.fn(), r = await request();
    const g = new GuardedGroqEvaluation({ liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch });
    await expect(g.transport(r, new AbortController().signal)).rejects.toThrow('non_synthetic_request'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('stops at 12 requests even across separate rate windows', async () => {
    const s = session(), r = await request(), signal = new AbortController().signal;
    for (let i = 0; i < 12; i++) { await s.guard.transport(r, signal); s.nextMinute(); }
    await expect(s.guard.transport(r, signal)).rejects.toThrow('request_cap'); expect(s.fetcher).toHaveBeenCalledTimes(12);
  });
  it('stops before exceeding the 50,000 total reservation budget', async () => {
    const s = session(4900), r = await request(), signal = new AbortController().signal;
    for (let i = 0; i < 10; i++) { await s.guard.transport(r, signal); s.nextMinute(); }
    await expect(s.guard.transport(r, signal)).rejects.toThrow('total_token_budget'); expect(s.guard.state.reportedTokens).toBe(49000); expect(s.fetcher).toHaveBeenCalledTimes(10);
  });
  it('enforces reported minute usage plus the next request reservation', async () => {
    const s = session(1000), r = await request(), signal = new AbortController().signal;
    await s.guard.transport(r, signal); await expect(s.guard.transport(r, signal)).rejects.toThrow('minute_token_budget'); expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops and records an unexpectedly excessive usage report without clamping or fabricating it', async () => {
    const s = session(6000); await s.guard.transport(await request(), new AbortController().signal);
    expect(s.guard.state.observedBudgetBreach).toBe(true); expect(s.guard.state.reportedTokens).toBe(6000); expect(s.guard.state.stop).toBe('reported_budget_exceeded');
  });
  it.each([400,401,403,429,500])('records sanitized exact provider error and stops on %s', async status => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: 'schema_invalid', type: 'invalid_request', message: 'Schema rejected synthetic-key Bearer synthetic-groq-key' } }, { status }));
    const g = new GuardedGroqEvaluation({ liveFlag: true, environmentOptIn: '1', credential: 'synthetic-key', fetcher: fetcher as typeof fetch, syntheticPromptAllowed: () => true });
    const r = await request(), signal = new AbortController().signal;
    await g.transport(r, signal); await expect(g.transport(r, signal)).rejects.toThrow();
    expect(g.state.providerError).toMatchObject({ status, code: 'schema_invalid', type: 'invalid_request' });
    expect(JSON.stringify(g.state)).not.toMatch(/synthetic-key|synthetic-groq-key/u); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('respects lower account/header limits and never interprets RPD headers as RPM', async () => {
    const s = session(100, { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-remaining-requests': '999', 'x-ratelimit-reset-tokens': '1m2.5s' });
    const r = await request(), signal = new AbortController().signal; await s.guard.transport(r, signal);
    expect(s.guard.state.headers.resetTokensMs).toBe(62500); await expect(s.guard.transport(r, signal)).rejects.toThrow('provider_token_budget');
    const fetcher = vi.fn(), low = new GuardedGroqEvaluation({ liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch,accountLimits:{tokensPerMinute:100},syntheticPromptAllowed:()=>true});
    await expect(low.transport(r,signal)).rejects.toThrow('minute_token_budget'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry 429 and retains retry-after pacing metadata', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { message: 'Rate limit reached' } }, { status: 429, headers: { 'retry-after': '60' } }));
    const g = new GuardedGroqEvaluation({ liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch,syntheticPromptAllowed:()=>true });
    await g.transport(await request(), new AbortController().signal);
    expect(g.state.stop).toBe('rate_limited'); expect(g.state.headers.retryAfterMs).toBe(60000); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('stops on missing usage, malformed HTTP JSON and an aborted request', async () => {
    for (const fetcher of [vi.fn(async () => Response.json(envelope({}, null))), vi.fn(async () => new Response('bad-json'))]) {
      const g = new GuardedGroqEvaluation({ liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch,syntheticPromptAllowed:()=>true });
      await g.transport(await request(), new AbortController().signal); expect(g.state.stop).not.toBeNull();
    }
    const s = session(), controller = new AbortController(); controller.abort();
    await expect(s.guard.transport(await request(), controller.signal)).rejects.toThrow('request_aborted'); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('forbids parallel requests and never leaks the authorization header into reports', async () => {
    let finish!: (r: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const g = new GuardedGroqEvaluation({ liveFlag:true,environmentOptIn:'1',credential:'synthetic-key',fetcher:fetcher as typeof fetch,syntheticPromptAllowed:()=>true });
    const r = await request(), signal = new AbortController().signal, first = g.transport(r, signal);
    await expect(g.transport(r, signal)).rejects.toThrow('parallel_request_forbidden'); finish(Response.json(envelope({}, 100))); await first;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.stringify(g.state)).not.toContain('synthetic-key');
  });
});

describe('partial runs and offline CLI defaults', () => {
  it('returns completed cases and a precise stop reason on mock 429', async () => {
    let i = 0; const subset = [gold(), gold('msa-01'), gold('english-01')];
    const evaluator = new SemanticEvaluator(async () => ++i === 1 ? { status: 200, body: envelope(mockDraftFromGold(subset[0]!.expectedPlan)) } : { status: 429, body: {} });
    const result = await runEvaluation(subset, evaluator); expect(result.records).toHaveLength(2); expect(result.stop).toBe('rate_limited'); expect(i).toBe(2);
    expect(summarizeEvaluation(result.records, subset).remainingCases).toBe(1);
  });
  it('returns a typed partial evaluation on timeout without retry', async () => {
    vi.useFakeTimers(); const transport = vi.fn<PlannerTransport>(() => new Promise(() => {}));
    const pending = runEvaluation([gold()], new SemanticEvaluator(transport, 'offline_mock', 100)); await vi.advanceTimersByTimeAsync(101);
    const result = await pending; expect(result.stop).toBe('planner_timeout'); expect(result.records[0]!.rawExact).toBe(false); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('validates default offline readiness without credentials or any transport', async () => {
    const fetcher = vi.fn(), result = await runLab([], {}, fetcher as typeof fetch);
    expect(result).toMatchObject({ mode: 'offline', datasetCases: 160, liveRequests: 0, realModelAccuracy: null }); expect(fetcher).not.toHaveBeenCalled();
    expect(labReadiness().estimates.minimumRequestTokens).toBeGreaterThan(0);
  });
  it('refuses every incomplete CLI/environment opt-in combination', async () => {
    const fetcher = vi.fn();
    for (const [argv, env] of [[['--live'], {}], [[], { DAABOUL_EVAL_LIVE: '1' }], [['--live','--smoke'], {}], [['--live','--smoke'], { DAABOUL_EVAL_LIVE: '1' }]] as const)
      await expect(runLab([...argv], env, fetcher as typeof fetch)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('runs the exact default CLI offline and stores only readiness metadata', () => {
    const value = JSON.parse(execFileSync(process.execPath, ['scripts/eval-semantic.mjs'], { cwd: process.cwd(), env: { PATH: process.env.PATH! }, encoding: 'utf8' }));
    expect(value).toMatchObject({ mode: 'offline', datasetCases: 160, liveRequests: 0 }); expect(value.output).toContain('offline-readiness.json');
  });
});
