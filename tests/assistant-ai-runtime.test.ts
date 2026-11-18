import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from 'miniflare';

/** Exercise the real production gateway under workerd's fetch semantics. Every
 * outbound request is intercepted; no real API key, Telegram or internet call. */
describe('assistant AI gateway in the actual workerd runtime', () => {
  let mf: Miniflare; let db: D1Database;
  let mode: 'success' | 'redirect' | 'fallback' = 'success';
  const calls: { hostname: string; hasGroqKey: boolean; hasGeminiKey: boolean }[] = [];
  beforeAll(async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const bundle = await build({ absWorkingDir: root,
      stdin: { resolveDir: root, contents: `
        import { generateAssistantJson } from './src/assistant-ai';
        export default { async fetch(request, env) {
          const name = new URL(request.url).pathname;
          const configuration = name === '/fallback' ? env : { ...env, GEMINI_API_KEY: undefined };
          const result = await generateAssistantJson(configuration, [
            { role: 'system', content: 'Return a JSON object with a boolean ok property.' },
            { role: 'user', content: 'Synthetic runtime probe.' }
          ], 'runtime:' + name, { maxTokens: 256, schema: {
            type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false
          } });
          return Response.json({ result });
        } };
      ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-13',
      script: bundle.outputFiles[0]!.text, d1Databases: { DB: 'assistant-runtime-test' },
      bindings: { GROQ_API_KEY: 'groq-runtime-synthetic-key', GEMINI_API_KEY: 'gemini-runtime-synthetic-key' },
      outboundService: async request => {
        const url = new URL(request.url);
        // The service bridge rebuilds Request objects; assert actual forwarding
        // behavior below, rather than that reconstructed Request.redirect.
        calls.push({ hostname: url.hostname,
          hasGroqKey: request.headers.has('authorization'), hasGeminiKey: request.headers.has('x-goog-api-key') });
        if (!['api.groq.com', 'generativelanguage.googleapis.com'].includes(url.hostname)) throw new Error('Unexpected outbound target.');
        if (mode === 'redirect' || mode === 'fallback' && url.hostname === 'api.groq.com') {
          return new RuntimeResponse(null, { status: 302, headers: { Location: 'https://must-never-receive-credentials.invalid/' } });
        }
        return url.hostname === 'api.groq.com'
          ? RuntimeResponse.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { total_tokens: 100 } })
          : RuntimeResponse.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { totalTokenCount: 100 } });
      },
    }));
    db = await mf.getD1Database('DB') as unknown as D1Database;
    const migration = await readFile(resolve(root, 'migrations/0004_assistant_ai.sql'), 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => {
    mode = 'success'; calls.length = 0;
    await db.batch([db.prepare('DELETE FROM assistant_ai_requests'), db.prepare('DELETE FROM assistant_ai_usage')]);
  });
  it('reaches Groq, validates JSON, and persists ready under workerd rather than a Node fetch mock', async () => {
    const response = await mf.dispatchFetch('https://runtime.test/success');
    expect(await response.json()).toEqual({ result: { ok: true } });
    expect(calls).toEqual([{ hostname: 'api.groq.com', hasGroqKey: true, hasGeminiKey: false }]);
    expect((await db.prepare('SELECT state FROM assistant_ai_requests').first<{ state: string }>())!.state).toBe('ready');
  });
  it('rejects provider redirects and never forwards an API key to their Location', async () => {
    mode = 'redirect';
    const response = await mf.dispatchFetch('https://runtime.test/redirect');
    expect(await response.json()).toEqual({ result: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ hostname: 'api.groq.com' });
    expect((await db.prepare('SELECT state FROM assistant_ai_requests').first<{ state: string }>())!.state).toBe('error');
  });
  it('uses Gemini fallback with compatible manual redirects after a rejected Groq redirect', async () => {
    mode = 'fallback';
    const response = await mf.dispatchFetch('https://runtime.test/fallback');
    expect(await response.json()).toEqual({ result: { ok: true } });
    expect(calls).toEqual([
      { hostname: 'api.groq.com', hasGroqKey: true, hasGeminiKey: false },
      { hostname: 'generativelanguage.googleapis.com', hasGroqKey: false, hasGeminiKey: true },
    ]);
  });
});
