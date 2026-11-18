import { GROQ_ASSISTANT_MODEL, estimateAssistantRequestTokens, type AssistantAiMessage } from './assistant-ai';
import { MODEL_PLAN_DRAFT_JSON_SCHEMA } from './semantic-draft';
import { plainReadObject } from './read-tool-contracts';

export interface GroqPlanRequest {
  model: typeof GROQ_ASSISTANT_MODEL; messages: AssistantAiMessage[]; stream: false; temperature: 0;
  max_completion_tokens: number; reasoning_effort: 'low'; include_reasoning: false;
  response_format: { type: 'json_schema'; json_schema: { name: 'semantic_plan_draft_v1'; strict: true; schema: Record<string, unknown> } };
}
/** No default fetch transport, API key, DB, quota ledger or fallback provider. */
export type PlannerTransport = (request: GroqPlanRequest, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
export interface PlannerUsage { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
export interface PlannerMetrics {
  promptBytes: number; promptCharacters: number; promptTokenEstimate: number | null;
  requestTokenEstimate: number | null; latencyMs: number; usage: PlannerUsage | null; error: string | null;
}
export type PlannerResult = { ok: true; draft: unknown; metrics: PlannerMetrics } | { ok: false; metrics: PlannerMetrics };
const encoder = new TextEncoder();
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function readPlannerUsage(body: Record<string, unknown>): PlannerUsage | null {
  if (!plainReadObject(body.usage)) return null;
  const value = body.usage, result: PlannerUsage = {};
  if (count(value.prompt_tokens)) result.promptTokens = value.prompt_tokens;
  if (count(value.completion_tokens)) result.completionTokens = value.completion_tokens;
  if (count(value.total_tokens)) result.totalTokens = value.total_tokens;
  if (plainReadObject(value.prompt_tokens_details) && count(value.prompt_tokens_details.cached_tokens)
    && (result.promptTokens === undefined || value.prompt_tokens_details.cached_tokens <= result.promptTokens)) result.cachedTokens = value.prompt_tokens_details.cached_tokens;
  return Object.keys(result).length ? result : null;
}
class PlannerFault extends Error {}
export class GroqPlanner {
  constructor(private readonly transport: PlannerTransport, private readonly timeoutMs = 2000, private readonly clock = Date.now,
    private readonly maxCompletionTokens = 2048) {
    if (typeof transport !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 128 || maxCompletionTokens > 2048) throw Error('Invalid offline planner configuration');
  }
  async plan(messages: AssistantAiMessage[]): Promise<PlannerResult> {
    const metrics: PlannerMetrics = { promptBytes: 0, promptCharacters: 0, promptTokenEstimate: null,
      requestTokenEstimate: null, latencyMs: 0, usage: null, error: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(), start = this.clock();
    try {
      messages = structuredClone(messages);
      const estimate = estimateAssistantRequestTokens(messages, { schema: MODEL_PLAN_DRAFT_JSON_SCHEMA, maxTokens: this.maxCompletionTokens });
      if (!Number.isFinite(estimate)) throw new PlannerFault('prompt_limit');
      metrics.requestTokenEstimate = estimate; metrics.promptTokenEstimate = estimate - this.maxCompletionTokens;
      metrics.promptCharacters = messages.reduce((n, message) => n + message.content.length, 0);
      metrics.promptBytes = encoder.encode(JSON.stringify(messages)).byteLength;
      const request: GroqPlanRequest = { model: GROQ_ASSISTANT_MODEL, messages, stream: false, temperature: 0,
        max_completion_tokens: this.maxCompletionTokens, reasoning_effort: 'low', include_reasoning: false,
        response_format: { type: 'json_schema', json_schema: { name: 'semantic_plan_draft_v1', strict: true, schema: structuredClone(MODEL_PLAN_DRAFT_JSON_SCHEMA) } } };
      if (encoder.encode(JSON.stringify(request)).byteLength > 32768) throw new PlannerFault('prompt_limit');
      const result = await Promise.race([Promise.resolve().then(() => this.transport(request, controller.signal)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PlannerFault('planner_timeout')); }, this.timeoutMs); })]);
      if (result.status !== 200) throw new PlannerFault(result.status === 429 ? 'rate_limited' : 'provider_error');
      if (!plainReadObject(result.body)) throw new PlannerFault('invalid_provider_response');
      const body = result.body; metrics.usage = readPlannerUsage(body);
      if (!Array.isArray(body.choices) || body.choices.length !== 1 || !plainReadObject(body.choices[0])) throw new PlannerFault('invalid_provider_response');
      const choice = body.choices[0];
      if (choice.finish_reason !== 'stop' || !plainReadObject(choice.message) || choice.message.refusal || choice.message.tool_calls) throw new PlannerFault('incomplete_or_refused');
      const content = choice.message.content;
      if (typeof content !== 'string' || encoder.encode(content).byteLength > 32768) throw new PlannerFault('invalid_provider_response');
      let draft: unknown;
      try { draft = JSON.parse(content); } catch { throw new PlannerFault('invalid_json'); }
      return { ok: true, draft, metrics };
    } catch (e) {
      metrics.error = e instanceof PlannerFault ? e.message : 'planner_transport_error';
      return { ok: false, metrics };
    } finally { if (timer !== undefined) clearTimeout(timer); metrics.latencyMs = Math.max(0, this.clock() - start); }
  }
}
