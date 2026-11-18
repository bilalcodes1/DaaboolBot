import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_AI_LIMITS, GEMINI_ASSISTANT_MODEL, GROQ_ASSISTANT_MODEL, generateAssistantJson, isAssistantAiEnabled,
  estimateAssistantRequestTokens, assistantRequestFits, type AssistantAiEnv, type AssistantAiMessage } from '../src/assistant-ai';
import { ACADEMIC_ANALYSIS_SCHEMA, academicAnalysisPrompt } from '../src/academic-ai';

const databases: DatabaseSync[] = [];
const NOW = Date.parse('2026-10-23T10:00:00Z');
const MESSAGES: AssistantAiMessage[] = [{ role: 'system', content: 'Extract a class announcement as JSON.' },
  { role: 'user', content: 'الخميس كوز رسومات بالمحاضرة ٢ و٣' }];
const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, additionalProperties: false, required: ['answer'] };

/** Execute the actual migration and allowance SQL against SQLite, rather than
 * mocking the logic which is responsible for cross-worker quota enforcement. */
function database(migrate = true) {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  if (migrate) sql.exec(readFileSync(new NodeURL('../migrations/0004_assistant_ai.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query: string) {
      const statement = sql.prepare(query);
      const prepared = (parameters: (string | number | null)[] = []) => ({
        bind(...values: (string | number | null)[]) { return prepared(values); },
        async first() { return statement.get(...parameters) ?? null; },
        async run() { return { success: true, meta: { changes: Number(statement.run(...parameters).changes) } }; },
      });
      return prepared();
    },
  } as unknown as D1Database;
  return { db, sql, env: { DB: db, GROQ_API_KEY: 'groq-test-key' } satisfies AssistantAiEnv };
}

function groqResponse(content = '{"answer":"تم"}', extra: Record<string, unknown> = {}) {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { total_tokens: 100 }, ...extra });
}
function geminiResponse() {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"answer":"احتياط"}' }] } }], usageMetadata: { totalTokenCount: 90 } });
}
function clock(now = NOW) { return vi.spyOn(Date, 'now').mockReturnValue(now); }
function body(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): Record<string, unknown> {
  return JSON.parse(String(fetcher.mock.calls[index]![1]?.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const sql of databases.splice(0)) sql.close();
});

describe('durable JSON assistant gateway', () => {
  it('defers a busy minute durably, then returns the cached success regardless of retry policy', async () => {
    const now = clock(NOW + 10_000); const { env, sql } = database();
    sql.prepare('INSERT INTO assistant_ai_usage(provider,day_start,minute_start,minute_tokens) VALUES(?,?,?,?)')
      .run('groq', Math.floor(NOW / 86_400_000), Math.floor(NOW / 60_000), ASSISTANT_AI_LIMITS.groq.minuteTokens);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => groqResponse());
    const call = (retryTransient = true) => generateAssistantJson(env, MESSAGES, 'pending-message', { retryTransient }, fetcher);
    await expect(call()).rejects.toMatchObject({ name: 'AssistantAiRetryError', retryAfter: 50 });
    now.mockReturnValue(NOW + 20_000);
    await expect(call()).rejects.toMatchObject({ name: 'AssistantAiRetryError', retryAfter: 40 });
    expect(fetcher).not.toHaveBeenCalled();
    now.mockReturnValue(NOW + 60_001);
    expect(await call()).toEqual({ answer: 'تم' });
    expect(await call(false)).toEqual({ answer: 'تم' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([429, 503, 'network'] as const)('keeps temporary %s failures retryable in the cache', async failure => {
    const now = clock(); const { env } = database();
    const fetcher = failure === 'network'
      ? vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-network-error'))
      : vi.fn<typeof fetch>().mockImplementation(async () => new Response('synthetic-error', { status: failure, headers: { 'Retry-After': '90' } }));
    const call = () => generateAssistantJson(env, MESSAGES, 'temporary-message', { retryTransient: true }, fetcher);
    await expect(call()).rejects.toMatchObject({ name: 'AssistantAiRetryError' });
    now.mockReturnValue(NOW + 1_000);
    await expect(call()).rejects.toMatchObject({ name: 'AssistantAiRetryError' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps invalid credentials, malformed output, daily exhaustion and oversized requests terminal', async () => {
    clock(); const { env, sql } = database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('synthetic-invalid-key', { status: 401 }));
    const options = { retryTransient: true };
    expect(await generateAssistantJson(env, MESSAGES, 'invalid-key', options, fetcher)).toBeNull();
    expect(await generateAssistantJson(env, MESSAGES, 'invalid-key', options, fetcher)).toBeNull();
    sql.prepare('UPDATE assistant_ai_usage SET cooldown_until=0').run();
    fetcher.mockResolvedValueOnce(groqResponse('not JSON'));
    expect(await generateAssistantJson(env, MESSAGES, 'bad-output', options, fetcher)).toBeNull();
    expect(await generateAssistantJson(env, MESSAGES, 'bad-output', options, fetcher)).toBeNull();
    sql.prepare('UPDATE assistant_ai_usage SET day_requests=?').run(ASSISTANT_AI_LIMITS.groq.dayRequests);
    expect(await generateAssistantJson(env, MESSAGES, 'daily-cap', options, fetcher)).toBeNull();
    expect(await generateAssistantJson(env, [{ role: 'user', content: 'ع'.repeat(8_000) }], 'oversized', options, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns a saved fallback before the primary retry cooldown', async () => {
    clock(); const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('synthetic-quota', { status: 429 }))
      .mockResolvedValueOnce(geminiResponse());
    const configured = { ...env, GEMINI_API_KEY: 'gemini-test-key' };
    const call = () => generateAssistantJson(configured, MESSAGES, 'fallback-retry', { retryTransient: true }, fetcher);
    expect(await call()).toEqual({ answer: 'احتياط' });
    expect(await call()).toEqual({ answer: 'احتياط' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses documented Groq strict JSON requests, bounded output, abort signal and a secret header', async () => {
    clock();
    const { env, sql } = database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(groqResponse());
    expect(await generateAssistantJson(env, MESSAGES, 'private:123:99', { schema: SCHEMA, maxTokens: 4_000 }, fetcher)).toEqual({ answer: 'تم' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer groq-test-key' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(body(fetcher)).toMatchObject({ model: GROQ_ASSISTANT_MODEL, stream: false, temperature: 0, reasoning_effort: 'low',
      include_reasoning: false, max_completion_tokens: 2_048,
      response_format: { type: 'json_schema', json_schema: { strict: true, name: 'assistant_response', schema: SCHEMA } } });
    const saved = sql.prepare('SELECT * FROM assistant_ai_requests').get();
    expect(saved?.state).toBe('ready');
    expect(saved?.cache_key).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(saved)).not.toContain('groq-test-key');
    expect(JSON.stringify(saved)).not.toContain('private:123');
    expect(JSON.stringify(saved)).not.toContain('الخميس كوز');
    expect(sql.prepare('SELECT day_requests,day_tokens,minute_tokens FROM assistant_ai_usage').get()).toEqual({ day_requests: 1, day_tokens: 100, minute_tokens: 100 });
  });

  it('admits the production mixed Arabic/English prompt, schema and example with modest conversation context', async () => {
    clock();
    const { env } = database();
    const handler = readFileSync(new NodeURL('../src/assistant-handler.ts', import.meta.url), 'utf8');
    const system = /const ASSISTANT_SYSTEM\s*=\s*`([\s\S]*?)`/.exec(handler)?.[1];
    expect(system).toBeTruthy();
    const messages: AssistantAiMessage[] = [{ role: 'system', content: `${system}\n${academicAnalysisPrompt(new Date(NOW))}\nSTUDENT_REPORTS=[]\nAPPROVED_NOTICES=[]` },
      { role: 'user', content: 'تفاصيل المحاضرة '.repeat(25) }, { role: 'assistant', content: 'نراجع تفاصيل المحاضرة '.repeat(20) },
      { role: 'user', content: 'رسومات عملي تريد مناقشة كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج و بالخميس كوز بالمحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها كالت يمكن تجيبه mcq،و المعمارية نفسه ما تكوزنه يجوز يكوزنه الأحد' }];
    const options = { maxTokens: 1600, schema: ACADEMIC_ANALYSIS_SCHEMA };
    expect(assistantRequestFits(messages, options)).toBe(true);
    expect(estimateAssistantRequestTokens(messages, options)).toBeLessThanOrEqual(ASSISTANT_AI_LIMITS.groq.minuteTokens);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(groqResponse());
    expect(await generateAssistantJson(env, messages, 'real-prompt', options, fetcher)).toEqual({ answer: 'تم' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports oversized prompts as unfit and estimates Arabic more cautiously than English', async () => {
    const english: AssistantAiMessage[] = [{ role: 'user', content: 'a'.repeat(3000) }];
    const arabic: AssistantAiMessage[] = [{ role: 'user', content: 'ع'.repeat(3000) }];
    expect(estimateAssistantRequestTokens(arabic)).toBeGreaterThan(estimateAssistantRequestTokens(english) + 1900);
    expect(assistantRequestFits([{ role: 'user', content: 'ع'.repeat(9000) }])).toBe(false);
    expect(assistantRequestFits([{ role: 'user', content: 'a'.repeat(18001) }])).toBe(false);
    expect(estimateAssistantRequestTokens([])).toBe(Infinity);
  });

  it('keeps conversational decoding separate from the structured cache while retaining validated JSON', async () => {
    clock(); const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(groqResponse('{"answer":"structured"}'))
      .mockResolvedValueOnce(groqResponse('{"answer":"friendly conversation"}'));
    expect(await generateAssistantJson(env,MESSAGES,'same-question',{schema:SCHEMA},fetcher)).toEqual({answer:'structured'});
    expect(await generateAssistantJson(env,MESSAGES,'same-question',{schema:SCHEMA,conversational:true},fetcher)).toEqual({answer:'friendly conversation'});
    expect(await generateAssistantJson(env,MESSAGES,'same-question',{schema:SCHEMA,conversational:true},fetcher)).toEqual({answer:'friendly conversation'});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body(fetcher,0).temperature).toBe(0);
    expect(body(fetcher,1)).toMatchObject({temperature:0.6,response_format:{type:'json_schema',json_schema:{strict:true}}});
  });

  it('returns cached JSON across callers without another request, while isolating input, model, schema and request identity', async () => {
    clock();
    const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => groqResponse());
    const call = (key = 'request-1', messages = MESSAGES, model = GROQ_ASSISTANT_MODEL, schema: Record<string, unknown> = SCHEMA) =>
      generateAssistantJson({ ...env, GROQ_MODEL: model }, messages, key, { schema }, fetcher);
    expect(await call()).toEqual({ answer: 'تم' });
    expect(await call()).toEqual({ answer: 'تم' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await call('request-2');
    await call('request-1', [...MESSAGES.slice(0, 1), { role: 'user', content: 'كوز الأحد' }]);
    await call('request-1', MESSAGES, 'openai/gpt-oss-20b');
    await call('request-1', MESSAGES, GROQ_ASSISTANT_MODEL, { ...SCHEMA, description: 'new contract' });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('serializes concurrent copies of a request using a durable lease', async () => {
    clock();
    const { env } = database();
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const requests = Array.from({ length: 12 }, () => generateAssistantJson(env, MESSAGES, 'same-update', {}, fetcher));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    release(groqResponse());
    const results = await Promise.all(requests);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(results.filter(value => value !== null)).toEqual([{ answer: 'تم' }]);
    expect(await generateAssistantJson(env, MESSAGES, 'same-update', {}, fetcher)).toEqual({ answer: 'تم' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['disabled', (env: AssistantAiEnv) => ({ ...env, GROQ_ENABLED: 'false' })],
    ['missing DB', (env: AssistantAiEnv) => ({ GROQ_API_KEY: env.GROQ_API_KEY! })],
    ['missing keys', (env: AssistantAiEnv) => ({ DB: env.DB! })],
  ])('keeps local behavior available with %s', async (_description, transform) => {
    const { env } = database();
    const fetcher = vi.fn<typeof fetch>();
    expect(isAssistantAiEnabled(transform(env))).toBe(false);
    expect(await generateAssistantJson(transform(env), MESSAGES, 'disabled', {}, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when the migration or D1 is unavailable and does not log provider errors or keys', async () => {
    const { env } = database(false);
    const fetcher = vi.fn<typeof fetch>();
    const error = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    expect(await generateAssistantJson(env, MESSAGES, 'no-migration', {}, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('enforces durable daily admission across keys and model overrides', async () => {
    clock();
    const { env, sql } = database();
    sql.prepare('INSERT INTO assistant_ai_usage(provider,day_start,day_requests) VALUES(?,?,?)')
      .run('groq', Math.floor(NOW / 86_400_000), ASSISTANT_AI_LIMITS.groq.dayRequests);
    const fetcher = vi.fn<typeof fetch>();
    expect(await generateAssistantJson({ ...env, GROQ_API_KEYS: '["second-secret-key","third-secret-key"]' }, MESSAGES, 'over-budget', {}, fetcher)).toBeNull();
    expect(await generateAssistantJson({ ...env, GROQ_MODEL: 'openai/gpt-oss-20b' }, MESSAGES, 'other-model', {}, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(sql.prepare('SELECT COUNT(*) AS total FROM assistant_ai_usage').get()?.total).toBe(1);
  });

  it('enforces minute token/request caps and resets the minute and day independently', async () => {
    const now = clock();
    const { env, sql } = database();
    sql.prepare('INSERT INTO assistant_ai_usage(provider,day_start,minute_start,day_requests,minute_requests,minute_tokens) VALUES(?,?,?,?,?,?)')
      .run('groq', Math.floor(NOW / 86_400_000), Math.floor(NOW / 60_000), 4, 1, ASSISTANT_AI_LIMITS.groq.minuteTokens);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => groqResponse());
    expect(await generateAssistantJson(env, MESSAGES, 'tokens-exhausted', {}, fetcher)).toBeNull();
    now.mockReturnValue(NOW + 60_001);
    expect(await generateAssistantJson(env, MESSAGES, 'fresh-minute', {}, fetcher)).toEqual({ answer: 'تم' });
    expect(sql.prepare('SELECT day_requests,minute_requests,minute_tokens FROM assistant_ai_usage').get()).toEqual({ day_requests: 5, minute_requests: 1, minute_tokens: 100 });
    sql.prepare('UPDATE assistant_ai_usage SET minute_requests=?').run(ASSISTANT_AI_LIMITS.groq.minuteRequests);
    expect(await generateAssistantJson(env, MESSAGES, 'requests-exhausted', {}, fetcher)).toBeNull();
    now.mockReturnValue(NOW + 86_400_001);
    expect(await generateAssistantJson(env, MESSAGES, 'fresh-day', {}, fetcher)).toEqual({ answer: 'تم' });
    expect(sql.prepare('SELECT day_requests,minute_requests FROM assistant_ai_usage').get()).toEqual({ day_requests: 1, minute_requests: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honors 429 cooldown for every key and uses configured Gemini fallback with a durable cache', async () => {
    const now = clock();
    const { env, sql } = database();
    const configured = { ...env, GROQ_API_KEYS: '["second-secret-key"]', GEMINI_API_KEY: 'gemini-test-key' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('private-provider-error', { status: 429, headers: { 'retry-after': '120' } }))
      .mockImplementation(async () => geminiResponse());
    expect(await generateAssistantJson(configured, MESSAGES, 'quota-fallback', { schema: SCHEMA }, fetcher)).toEqual({ answer: 'احتياط' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_ASSISTANT_MODEL}:generateContent`);
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ 'x-goog-api-key': 'gemini-test-key' });
    expect(String(fetcher.mock.calls[1]![0])).not.toContain('gemini-test-key');
    expect(body(fetcher, 1)).toMatchObject({ generationConfig: { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: SCHEMA } } },
      contents: [{ role: 'user', parts: [{ text: MESSAGES[1]!.content }] }] });
    expect(sql.prepare("SELECT cooldown_until FROM assistant_ai_usage WHERE provider='groq'").get()?.cooldown_until).toBe(NOW + 120_000);
    now.mockReturnValue(NOW + 31_000);
    expect(await generateAssistantJson(configured, MESSAGES, 'quota-fallback', { schema: SCHEMA }, fetcher)).toEqual({ answer: 'احتياط' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await generateAssistantJson(configured, MESSAGES, 'different-update', {}, fetcher)).toEqual({ answer: 'احتياط' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toContain('generativelanguage.googleapis.com');
    now.mockReturnValue(NOW + 120_001);
    fetcher.mockImplementation(async () => groqResponse());
    expect(await generateAssistantJson(configured, MESSAGES, 'after-cooldown', {}, fetcher)).toEqual({ answer: 'تم' });
    expect(String(fetcher.mock.calls[3]![0])).toContain('api.groq.com');
  });

  it.each([
    { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'cannot comply' } }] },
    { choices: [{ finish_reason: 'content_filter', message: { content: null } }] },
  ])('never sends semantic refusals to another provider', async response => {
    clock();
    const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const configured = { ...env, GEMINI_API_KEY: 'gemini-test-key' };
    expect(await generateAssistantJson(configured, MESSAGES, 'refused', {}, fetcher)).toBeNull();
    expect(await generateAssistantJson(configured, MESSAGES, 'refused', {}, fetcher)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('falls back on transport errors and rejects truncated or invalid output', async () => {
    clock();
    const { env } = database();
    const configured = { ...env, GEMINI_API_KEY: 'gemini-test-key' };
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('private-network-error')).mockResolvedValueOnce(geminiResponse());
    expect(await generateAssistantJson(configured, MESSAGES, 'network-error', {}, fetcher)).toEqual({ answer: 'احتياط' });
    for (const [index, response] of [
      groqResponse('```json\n{"answer":"bad"}\n```'), groqResponse('{"answer":"truncated"}', { choices: [{ finish_reason: 'length', message: { content: '{"answer":"truncated"}' } }] }),
      groqResponse('[1,2,3]'), groqResponse('{"answer":"' + 'x'.repeat(70_000) + '"}'),
    ].entries()) {
      fetcher.mockResolvedValueOnce(response);
      expect(await generateAssistantJson(env, MESSAGES, `invalid-${index}`, {}, fetcher)).toBeNull();
    }
  });

  it('enforces inline deadlines even if a fetch implementation ignores cancellation', async () => {
    vi.useFakeTimers();
    const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = generateAssistantJson(env, MESSAGES, 'inline-timeout', { inline: true, maxTokens: 2_000 }, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(body(fetcher).max_completion_tokens).toBe(768);
    await vi.advanceTimersByTimeAsync(1_701);
    expect(await pending).toBeNull();
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it('rejects oversized/invalid inputs before touching the network and tolerates malformed optional key lists', async () => {
    clock();
    const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => groqResponse());
    expect(await generateAssistantJson(env, [{ role: 'user', content: 'ع'.repeat(18_001) }], 'large', {}, fetcher)).toBeNull();
    expect(await generateAssistantJson(env, Array.from({ length: 17 }, () => MESSAGES[1]!), 'too-many', {}, fetcher)).toBeNull();
    expect(await generateAssistantJson(env, [], 'empty', {}, fetcher)).toBeNull();
    expect(await generateAssistantJson(env, MESSAGES, '', {}, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await generateAssistantJson({ ...env, GROQ_API_KEYS: 'bad-secret-list' }, MESSAGES, 'good-key', {}, fetcher)).toEqual({ answer: 'تم' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('supports JSON-object mode for alternate models and best-effort schemas when fields are optional', async () => {
    clock();
    const { env } = database();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => groqResponse());
    await generateAssistantJson({ ...env, GROQ_MODEL: 'other/model' }, MESSAGES, 'json-mode', { schema: SCHEMA }, fetcher);
    expect(body(fetcher).response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(body(fetcher).messages)).toContain('Follow this JSON schema:');
    await generateAssistantJson(env, MESSAGES, 'best-effort', { schema: { ...SCHEMA, required: [] } }, fetcher);
    expect(body(fetcher, 1).response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: false } });
  });
});
