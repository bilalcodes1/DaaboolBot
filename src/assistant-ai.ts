import type { AiDiagnostic, AssistantFailure } from './assistant-diagnostics';
import { isAssistantFailure } from './assistant-diagnostics';
/** JSON-only external AI gateway. Domain validation belongs to the caller. */
export interface AssistantAiEnv {
  DB?: D1Database;
  GROQ_API_KEY?: string;
  /** Secret JSON array; keys share one allowance and never multiply quota. */
  GROQ_API_KEYS?: string;
  GROQ_MODEL?: string;
  GROQ_ENABLED?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export interface AssistantAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AssistantAiOptions {
  inline?: boolean;
  maxTokens?: number;
  schema?: Record<string, unknown>;
  conversational?: boolean;
  /** Webhook messages can be retried durably; Inline and Cron keep null fallback. */
  retryTransient?: boolean;
  onDiagnostic?: (value:AiDiagnostic)=>void;
}

export class AssistantAiRetryError extends Error {
  readonly retryAfter: number;
  constructor(retryAt: number) {
    super('Assistant AI is temporarily busy');
    this.name = 'AssistantAiRetryError';
    this.retryAfter = Math.max(1, Math.min(86_400, Math.ceil((retryAt - Date.now()) / 1_000)));
  }
}

export const GROQ_ASSISTANT_MODEL = 'openai/gpt-oss-120b';
export const GEMINI_ASSISTANT_MODEL = 'gemini-3.6-flash';

/** Local safety ceilings, below Groq's published free-plan base limits.
 * Tokens are estimated before admission and settled from provider usage.
 * The provider's account limits remain authoritative; no paid tools are used.
 */
export const ASSISTANT_AI_LIMITS = {
  groq: { minuteRequests: 25, dayRequests: 900, minuteTokens: 7_000, dayTokens: 180_000 },
  gemini: { minuteRequests: 5, dayRequests: 150, minuteTokens: 7_000, dayTokens: 150_000 },
} as const;

type Provider = 'groq' | 'gemini';
interface Configuration { provider: Provider; model: string; keys: string[] }
interface CacheRow { state: 'pending' | 'ready' | 'refused' | 'error'; result_json: string | null; expires_at: number }
type Outcome = { kind: 'ready'; value: unknown; tokens?: number }
  | { kind: 'refused'; tokens?: number } | { kind: 'error'; cooldownMs?: number; tokens?: number; retryable?: boolean; reason?:AssistantFailure; status?:number };
const encoder = new TextEncoder();
const CACHE_TTL = 86_400_000;
const MAX_RESPONSE_BYTES = 65_536;
const JSON_INSTRUCTION = 'Return one JSON object only, without markdown or surrounding commentary.';

function boundedInput(messages: AssistantAiMessage[], options: AssistantAiOptions): { input: string; maxTokens: number } | null {
  if (!Array.isArray(messages) || !messages.length || messages.length > 16
    || messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
    || !messages.some(message => message.role === 'user')
    || messages.reduce((size, message) => size + message.content.length, 0) > 18_000) return null;
  const maxTokens = Math.min(options.inline ? 768 : 2_048, Math.max(128,
    Number.isFinite(options.maxTokens) ? Math.trunc(options.maxTokens!) : options.inline ? 512 : 1_024));
  try {
    const input = JSON.stringify({ messages, schema: options.schema ?? null, maxTokens, ...(options.conversational ? { conversational: true } : {}) });
    return encoder.encode(input).byteLength <= 32_768 ? { input, maxTokens } : null;
  } catch { return null; }
}

function estimateTokens(input: string, maxTokens: number): number {
  let ascii = 0, arabic = 0, other = 0;
  for (const character of input) {
    if (character.codePointAt(0)! <= 127) ascii++;
    else if (/\p{Script=Arabic}/u.test(character)) arabic++;
    else other++;
  }
  // Script-aware admission estimate, not an exact tokenizer. Count the schema
  // and message framing too; reserve all allowed completion/reasoning tokens.
  // Provider-reported usage replaces this estimate after a completed response.
  return Math.ceil(ascii / 3 + arabic + other / 2) + maxTokens + 128;
}

/** Includes output allowance. Invalid/oversized input yields Infinity. */
export function estimateAssistantRequestTokens(messages: AssistantAiMessage[], options: AssistantAiOptions = {}): number {
  const prepared = boundedInput(messages, options);
  return prepared ? estimateTokens(prepared.input, prepared.maxTokens) : Infinity;
}

/** Check a single request before trimming context/history. Current shared
 * provider usage can still deny a request which individually fits this cap. */
export function assistantRequestFits(messages: AssistantAiMessage[], options: AssistantAiOptions = {}): boolean {
  return estimateAssistantRequestTokens(messages, options) <= ASSISTANT_AI_LIMITS.groq.minuteTokens;
}

function secretKeys(env: AssistantAiEnv): string[] {
  const keys: unknown[] = [env.GROQ_API_KEY];
  if (env.GROQ_API_KEYS && env.GROQ_API_KEYS.length <= 8_192) {
    try { const extra: unknown = JSON.parse(env.GROQ_API_KEYS); if (Array.isArray(extra)) keys.push(...extra.slice(0, 8)); }
    catch { /* Invalid optional secret must not reveal its content. */ }
  }
  return [...new Set(keys.filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter(value => value.length >= 8 && value.length <= 1_024 && !/\s/.test(value)))].slice(0, 8);
}

function configurations(env: AssistantAiEnv): Configuration[] {
  if (env.GROQ_ENABLED === 'false' || !env.DB) return [];
  const result: Configuration[] = [];
  const keys = secretKeys(env);
  if (keys.length) result.push({ provider: 'groq', model: env.GROQ_MODEL?.trim() || GROQ_ASSISTANT_MODEL, keys });
  const gemini = env.GEMINI_API_KEY?.trim();
  if (gemini && gemini.length >= 8 && gemini.length <= 1_024 && !/\s/.test(gemini)) {
    result.push({ provider: 'gemini', model: env.GEMINI_MODEL?.trim() || GEMINI_ASSISTANT_MODEL, keys: [gemini] });
  }
  return result.filter(config => /^[\w./-]{1,120}$/.test(config.model));
}

/** Configuration check only. A missing migration also fails closed at runtime. */
export function isAssistantAiEnabled(env: AssistantAiEnv): boolean { return configurations(env).length > 0; }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(text: unknown): unknown | null {
  if (typeof text !== 'string' || text.length > 32_768) return null;
  try { const parsed: unknown = JSON.parse(text); return object(parsed) ? parsed : null; }
  catch { return null; }
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Groq strict mode requires all object fields to be required and closed. */
function closedSchema(schema: unknown, depth = 0): boolean {
  const value = object(schema);
  if (!value || depth > 16) return false;
  if (value.type === 'object' || value.properties) {
    const properties = object(value.properties) ?? {};
    if (value.additionalProperties !== false || !Array.isArray(value.required)
      || Object.keys(properties).some(key => !(value.required as unknown[]).includes(key))) return false;
    if (!Object.values(properties).every(child => closedSchema(child, depth + 1))) return false;
  }
  if (value.items && !closedSchema(value.items, depth + 1)) return false;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(value[key]) && !(value[key] as unknown[]).every(child => closedSchema(child, depth + 1))) return false;
  }
  return true;
}

function supportsGroqSchema(model: string): boolean {
  return ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b', 'qwen/qwen3.8-27b'].includes(model);
}

function request(config: Configuration, key: string, messages: AssistantAiMessage[], maxTokens: number, schema?: Record<string, unknown>, conversational = false): { url: string; init: RequestInit } {
  if (config.provider === 'groq') {
    const schemaMode = schema && supportsGroqSchema(config.model);
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      // workerd supports manual/follow only; reject every non-2xx below so an
      // API credential is never forwarded to a redirect destination.
      init: { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({
        model: config.model, messages: schema && !schemaMode ? [
          { role: 'system', content: `Follow this JSON schema: ${JSON.stringify(schema)}` }, ...messages,
        ] : messages, stream: false, temperature: conversational ? 0.6 : 0, max_completion_tokens: maxTokens,
        ...(config.model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low', include_reasoning: false } : {}),
        response_format: schemaMode ? { type: 'json_schema', json_schema: { name: 'assistant_response',
          strict: config.model !== 'openai/gpt-oss-safeguard-20b' && closedSchema(schema), schema } } : { type: 'json_object' },
      }) },
    };
  }
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
    init: { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({
      systemInstruction: { parts: messages.filter(message => message.role === 'system').map(message => ({ text: message.content })) },
      contents: messages.filter(message => message.role !== 'system').map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
      generationConfig: { temperature: conversational ? 0.6 : 0, maxOutputTokens: maxTokens,
        responseFormat: { text: { mimeType: 'APPLICATION_JSON', ...(schema ? { schema } : {}) } } },
    }) },
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error('Response too large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function usage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : undefined;
}

function parseOutcome(provider: Provider, envelope: unknown): Outcome {
  const body = object(envelope);
  if (!body) return { kind: 'error' };
  if (provider === 'groq') {
    const tokens = usage(object(body.usage)?.total_tokens);
    const choice = Array.isArray(body.choices) ? object(body.choices[0]) : null;
    const message = object(choice?.message);
    if (message?.refusal || choice?.finish_reason === 'content_filter') return { kind: 'refused', ...(tokens === undefined ? {} : { tokens }) };
    const parsed = choice?.finish_reason === 'stop' ? parseJson(message?.content) : null;
    return parsed ? { kind: 'ready', value: parsed, ...(tokens === undefined ? {} : { tokens }) } : { kind: 'error', ...(tokens === undefined ? {} : { tokens }) };
  }
  const tokens = usage(object(body.usageMetadata)?.totalTokenCount);
  const candidate = Array.isArray(body.candidates) ? object(body.candidates[0]) : null;
  const finish = candidate?.finishReason;
  if (object(body.promptFeedback)?.blockReason || ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(String(finish))) {
    return { kind: 'refused', ...(tokens === undefined ? {} : { tokens }) };
  }
  const parts = object(candidate?.content)?.parts;
  const text = Array.isArray(parts) ? parts.filter(part => object(part)?.thought !== true).map(part => object(part)?.text).filter(value => typeof value === 'string').join('') : null;
  const parsed = finish === 'STOP' ? parseJson(text) : null;
  return parsed ? { kind: 'ready', value: parsed, ...(tokens === undefined ? {} : { tokens }) } : { kind: 'error', ...(tokens === undefined ? {} : { tokens }) };
}

function cooldown(response: Response): number {
  const retry = response.headers.get('retry-after');
  const seconds = retry === null ? NaN : Number(retry);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : retry ? Date.parse(retry) - Date.now() : 60_000;
  // A provider can require a long cooldown. Never rotate keys around a 429.
  return Number.isFinite(ms) ? Math.max(1_000, Math.min(ms, 86_400_000)) : 60_000;
}

async function invoke(config: Configuration, key: string, messages: AssistantAiMessage[], maxTokens: number,
  schema: Record<string, unknown> | undefined, timeout: number, fetcher: typeof fetch, conversational = false): Promise<Outcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = async (): Promise<Outcome> => {
    const prepared = request(config, key, messages, maxTokens, schema, conversational);
    const response = await fetcher(prepared.url, { ...prepared.init, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: 'error', reason:response.status===429?'provider_capacity':[401,403].includes(response.status)?'provider_auth':'provider_error',status:response.status,retryable: [408, 425, 429].includes(response.status) || response.status >= 500,
        ...(response.status === 429 ? { cooldownMs: cooldown(response) }
        : response.status === 401 || response.status === 403 ? { cooldownMs: 300_000 } : {}) };
    }
    // Malformed/oversized model output is terminal, unlike a failed transport.
    try { return parseOutcome(config.provider, await boundedJson(response)); }
    catch { return { kind: 'error',reason:'invalid_output' }; }
  };
  try {
    return await Promise.race([pending(), new Promise<Outcome>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ kind: 'error',reason:'timeout', retryable: true }); }, Math.max(1, timeout));
    })]);
  } catch { return { kind: 'error',reason:controller.signal.aborted?'timeout':'transport', retryable: true }; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

async function reserve(db: D1Database, provider: Provider, tokens: number, now: number): Promise<boolean> {
  const day = Math.floor(now / 86_400_000), minute = Math.floor(now / 60_000), limits = ASSISTANT_AI_LIMITS[provider];
  await db.prepare('INSERT OR IGNORE INTO assistant_ai_usage(provider) VALUES(?)').bind(provider).run();
  const result = await db.prepare(`UPDATE assistant_ai_usage SET
    day_start=?, minute_start=?,
    day_requests=(CASE WHEN day_start=? THEN day_requests ELSE 0 END)+1,
    minute_requests=(CASE WHEN minute_start=? THEN minute_requests ELSE 0 END)+1,
    day_tokens=(CASE WHEN day_start=? THEN day_tokens ELSE 0 END)+?,
    minute_tokens=(CASE WHEN minute_start=? THEN minute_tokens ELSE 0 END)+?
    WHERE provider=? AND cooldown_until<=?
      AND (CASE WHEN day_start=? THEN day_requests ELSE 0 END)<?
      AND (CASE WHEN minute_start=? THEN minute_requests ELSE 0 END)<?
      AND (CASE WHEN day_start=? THEN day_tokens ELSE 0 END)+?<=?
      AND (CASE WHEN minute_start=? THEN minute_tokens ELSE 0 END)+?<=?`)
    .bind(day, minute, day, minute, day, tokens, minute, tokens, provider, now,
      day, limits.dayRequests, minute, limits.minuteRequests, day, tokens, limits.dayTokens, minute, tokens, limits.minuteTokens).run();
  return result.meta.changes > 0;
}

/** Only consult usage on a denied admission. Daily exhaustion and an oversized
 * single request cannot be fixed by a short webhook retry. */
async function admissionRetryAt(db: D1Database, provider: Provider, tokens: number, now: number): Promise<number | null> {
  const limits = ASSISTANT_AI_LIMITS[provider];
  if (tokens > limits.minuteTokens) return null;
  const row = await db.prepare('SELECT day_start,day_requests,day_tokens,cooldown_until FROM assistant_ai_usage WHERE provider=?')
    .bind(provider).first<{ day_start: number; day_requests: number; day_tokens: number; cooldown_until: number }>();
  if (!row || row.day_start === Math.floor(now / 86_400_000)
    && (row.day_requests >= limits.dayRequests || row.day_tokens + tokens > limits.dayTokens)) return null;
  return row.cooldown_until > now ? row.cooldown_until : (Math.floor(now / 60_000) + 1) * 60_000;
}

function cachedRetryAt(cached: CacheRow): number | null {
  if (cached.state === 'pending') return cached.expires_at;
  if (cached.state !== 'error') return null;
  const marker = object(parseJson(cached.result_json));
  return marker?.retryable === true ? cached.expires_at : null;
}

async function settle(db: D1Database, provider: Provider, reserved: number, outcome: Outcome, now: number): Promise<void> {
  const adjustment = outcome.tokens === undefined ? 0 : outcome.tokens - reserved;
  await db.prepare(`UPDATE assistant_ai_usage SET
    day_tokens=MAX(0,day_tokens+CASE WHEN day_start=? THEN ? ELSE 0 END),
    minute_tokens=MAX(0,minute_tokens+CASE WHEN minute_start=? THEN ? ELSE 0 END),
    cooldown_until=MAX(cooldown_until,?) WHERE provider=?`)
    .bind(Math.floor(now / 86_400_000), adjustment, Math.floor(now / 60_000), adjustment,
      outcome.kind === 'error' && outcome.cooldownMs ? Date.now() + outcome.cooldownMs : 0, provider).run();
}

/** Default callers retain null fallback. Durable message callers opt into
 * retrying temporary capacity/transport failures without finalizing their turn.
 * No secrets or provider bodies log. Cache leases serialize duplicate requests.
 */
export async function generateAssistantJson(env: AssistantAiEnv, messages: AssistantAiMessage[], requestKey: string,
  options: AssistantAiOptions = {}, fetcher: typeof fetch = fetch): Promise<unknown | null> {
  const diagnostic=(value:AiDiagnostic)=>{try{options.onDiagnostic?.(value);}catch{/* Monitoring cannot alter request outcome. */}};
  const configs = configurations(env), db = env.DB;
  if (!configs.length || !db || !requestKey || requestKey.length > 512) {diagnostic({reason:'not_configured'});return null;}
  const prepared = boundedInput(messages, options);
  if (!prepared) {diagnostic({reason:'input_too_large'});return null;}
  const { input, maxTokens } = prepared;
  const deadline = Date.now() + (options.inline ? 2_500 : 12_000);
  const preparedMessages: AssistantAiMessage[] = [{ role: 'system', content: JSON_INSTRUCTION }, ...messages];
  const tokenReservation = estimateTokens(input, maxTokens);
  if(tokenReservation>Math.max(...configs.map(config=>ASSISTANT_AI_LIMITS[config.provider].minuteTokens))) {
    diagnostic({reason:'input_too_large',estimatedTokens:tokenReservation});return null;
  }
  let retryAt: number | null = null;
  const defer = (at: number) => { retryAt = retryAt === null ? at : Math.min(retryAt, at); };
  try {
    const inputHash = await digest(input);
    // Bounded expiry cleanup; old cached text is never retained indefinitely.
    await db.prepare('DELETE FROM assistant_ai_requests WHERE cache_key IN (SELECT cache_key FROM assistant_ai_requests WHERE expires_at<=? LIMIT 100)')
      .bind(Date.now() - 60_000).run();
    const candidates = await Promise.all(configs.map(async config => {
      const cacheKey = await digest(JSON.stringify([requestKey, inputHash, config.provider, config.model]));
      const cached = await db.prepare('SELECT state,result_json,expires_at FROM assistant_ai_requests WHERE cache_key=?').bind(cacheKey).first<CacheRow>();
      return { config, cacheKey, cached: cached && cached.expires_at > Date.now() ? cached : null };
    }));
    // A successful fallback is still the answer on subsequent webhook retries.
    // Checking every cache before admission prevents a second primary request.
    if (candidates.some(candidate => candidate.cached?.state === 'refused')) {diagnostic({reason:'refused'});return null;}
    const ready = candidates.find(candidate => candidate.cached?.state === 'ready');
    if (ready) {diagnostic({reason:'cache_ready',provider:ready.config.provider,modelMs:0,estimatedTokens:tokenReservation});return parseJson(ready.cached!.result_json);}
    const pending = candidates.find(candidate => candidate.cached?.state === 'pending');
    if (pending) {
      diagnostic({reason:'local_capacity',estimatedTokens:tokenReservation});
      if (options.retryTransient) throw new AssistantAiRetryError(pending.cached!.expires_at);
      return null;
    }
    for (const { config, cacheKey, cached } of candidates) {
      const now = Date.now();
      if (now >= deadline) { defer(now + 5_000); break; }
      if (cached) {
        const at = cachedRetryAt(cached);
        const marker=object(parseJson(cached.result_json));
        diagnostic({reason:isAssistantFailure(marker?.reason)?marker.reason:at===null?'invalid_output':'local_capacity',provider:config.provider,estimatedTokens:tokenReservation,...(typeof marker?.status==='number'?{status:marker.status}:{})});
        if (at !== null) defer(at);
        continue;
      }
      const lease = crypto.randomUUID();
      const claim = await db.prepare(`INSERT INTO assistant_ai_requests(cache_key,provider,state,result_json,lease_token,expires_at)
        VALUES(?,?,'pending',NULL,?,?) ON CONFLICT(cache_key) DO UPDATE SET state='pending',result_json=NULL,lease_token=excluded.lease_token,expires_at=excluded.expires_at
        WHERE assistant_ai_requests.expires_at<=?`).bind(cacheKey, config.provider, lease, now + 30_000, now).run();
      if (!claim.meta.changes) {
        diagnostic({reason:'local_capacity',provider:config.provider,estimatedTokens:tokenReservation});
        if (options.retryTransient) throw new AssistantAiRetryError(now + 5_000);
        return null;
      }
      if (!await reserve(db, config.provider, tokenReservation, now)) {
        diagnostic({reason:'local_capacity',provider:config.provider,estimatedTokens:tokenReservation});
        const at = options.retryTransient ? await admissionRetryAt(db, config.provider, tokenReservation, now) : null;
        await db.prepare("UPDATE assistant_ai_requests SET state='error',result_json=?,expires_at=? WHERE cache_key=? AND lease_token=?")
          .bind(JSON.stringify({reason:'local_capacity',retryable:at!==null}), at ?? now + 5_000, cacheKey, lease).run();
        if (at !== null) defer(at);
        continue;
      }
      // Deterministic distribution, with no retries across keys on a quota error.
      const key = config.keys[parseInt(cacheKey.slice(0, 8), 16) % config.keys.length]!;
      const modelStarted=Date.now();
      const outcome = await invoke(config, key, preparedMessages, maxTokens, options.schema,
        Math.min(options.inline ? 1_700 : 7_000, deadline - Date.now()), fetcher, options.conversational === true);
      diagnostic({reason:outcome.kind==='error'?outcome.reason??'invalid_output':outcome.kind,provider:config.provider,modelMs:Math.max(0,Date.now()-modelStarted),estimatedTokens:tokenReservation,...(outcome.kind==='error'&&outcome.status?{status:outcome.status}:{})});
      await settle(db, config.provider, tokenReservation, outcome, now);
      const temporary = outcome.kind === 'error' && outcome.retryable === true;
      const expires = Date.now() + (outcome.kind === 'error' ? Math.max(30_000, temporary ? outcome.cooldownMs ?? 0 : 0) : CACHE_TTL);
      await db.prepare('UPDATE assistant_ai_requests SET state=?,result_json=?,expires_at=? WHERE cache_key=? AND lease_token=?')
        .bind(outcome.kind, outcome.kind === 'ready' ? JSON.stringify(outcome.value) : outcome.kind==='error'?JSON.stringify({retryable:temporary,reason:outcome.reason??'invalid_output',...(outcome.status?{status:outcome.status}:{})}):null,
          expires, cacheKey, lease).run();
      if (outcome.kind === 'ready') return outcome.value;
      if (outcome.kind === 'refused') return null;
      if (temporary) defer(expires);
    }
  } catch (error) {
    if (error instanceof AssistantAiRetryError) throw error;
    diagnostic({reason:'storage_error'});
    /* Missing migrations and storage failures must preserve local bot functionality. */
    return null;
  }
  if (options.retryTransient && retryAt !== null) throw new AssistantAiRetryError(retryAt);
  return null;
}
