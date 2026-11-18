import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/bot';
import { TelegramClient } from '../src/telegram';
import { NluClassifier } from '../src/nlu';
import type { Env } from '../src/types';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const databases: DatabaseSync[] = [];
function database() {
  const sql = new DatabaseSync(':memory:'); databases.push(sql);
  for (const name of readdirSync(new NodeURL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new NodeURL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  sql.prepare('UPDATE settings SET owner_uid=1,target_chat_id=-100123 WHERE singleton=1').run();
  const prepare = (query: string, values: (string | number | null)[] = []) => ({
    bind(...next: (string | number | null)[]) { return prepare(query, next); },
    async first() { return sql.prepare(query).get(...values) ?? null; },
    async all() { return { success: true, results: sql.prepare(query).all(...values), meta: { changes: 0 } }; },
    async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; },
  });
  const db = { prepare } as unknown as D1Database;
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: '123:test-token', WEBHOOK_SECRET_TOKEN: 'test-secret',
    GROQ_API_KEY: 'synthetic-groq-key', CONTRIBUTIONS_ENABLED: 'true' };
  return { sql, env };
}
function transport(reply: string, providerStatus = 200) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const address = String(url); const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ url: address, body });
    if (address === 'https://api.groq.com/openai/v1/chat/completions') {
      if (providerStatus !== 200) return Response.json({ error: { type: 'synthetic_provider_error' } }, { status: providerStatus });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply, needsAcademicAnalysis: false }) } }], usage: { total_tokens: 120 } });
    }
    if (address.endsWith('/answerInlineQuery')) return Response.json({ ok: true, result: true });
    throw new Error('Unexpected network request');
  });
  return { requests, fetcher, telegram: new TelegramClient('123:test-token', fetcher) };
}
function answerBody(requests: { url: string; body: Record<string, unknown> }[]) {
  return requests.find(request => request.url.endsWith('/answerInlineQuery'))!.body as {
    cache_time: number; is_personal: boolean; results: { title: string; description: string; input_message_content: { message_text: string; parse_mode: string } }[];
  };
}

afterEach(() => { vi.restoreAllMocks(); for (const sql of databases.splice(0)) sql.close(); });

describe('AI Inline answer previews', () => {
  it('shows the actual AI greeting for the screenshot query and sends the same complete answer when selected', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { sql, env } = database(); const greeting = 'هلا بيك، آني بخير! شلونك إنت؟'; const net = transport(greeting);
    await handleUpdate({ update_id: 201, inline_query: { id: 'greeting-inline', from: { id: 2, is_bot: false }, query: 'ها دعبول شلونك ؟', offset: '' } },
      net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    const provider = net.requests.filter(request => request.url.includes('api.groq.com'));
    expect(provider).toHaveLength(1);
    expect(provider[0]!.body).toMatchObject({ model: 'openai/gpt-oss-120b', max_completion_tokens: 650,
      response_format: { type: 'json_schema', json_schema: { strict: true, schema: { required: ['reply', 'needsAcademicAnalysis'] } } } });
    expect(JSON.stringify(provider[0]!.body.messages)).toContain('ها دعبول شلونك ؟');
    const answer = answerBody(net.requests);
    expect(answer.is_personal).toBe(true);
    expect(answer.results).toHaveLength(1);
    expect(answer.results[0]!.description).toBe(greeting);
    expect(answer.results[0]!.input_message_content).toEqual({ message_text: greeting, parse_mode: 'HTML' });
    expect(answer.results[0]!.description).not.toContain('اختار الجواب');
    expect(net.requests.every(request => !request.url.endsWith('/sendMessage'))).toBe(true);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM assistant_turns').get()?.n).toBe(0);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  });

  it('renders a readable plain-text preview while preserving escaped HTML and the full outgoing answer', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env } = database(); const reply = `هلا <صديقي> & أهلاً بيك\n${'تفاصيل '.repeat(50)}`; const net = transport(reply);
    await handleUpdate({ update_id: 202, inline_query: { id: 'escaped-inline', from: { id: 2, is_bot: false }, query: 'هلا شلونك دعبول؟', offset: '' } },
      net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    const article = answerBody(net.requests).results[0]!;
    expect(article.description).toContain('هلا <صديقي> & أهلاً بيك تفاصيل');
    expect(article.description).not.toContain('&lt;');
    expect(Array.from(article.description)).toHaveLength(241);
    expect(article.description.endsWith('…')).toBe(true);
    expect(article.input_message_content.message_text).toContain('&lt;صديقي&gt; &amp;');
    expect(article.input_message_content.message_text).toContain('تفاصيل '.repeat(50));
  });

  it('makes provider failure guidance visible in the Inline card instead of masking it with generic instructions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const { env } = database(); const net = transport('', 503);
    await handleUpdate({ update_id: 203, inline_query: { id: 'retry-inline', from: { id: 2, is_bot: false }, query: 'ها دعبول شلونك ؟', offset: '' } },
      net.telegram, new Date(NOW), env, new NluClassifier(), net.fetcher);
    const article = answerBody(net.requests).results[0]!;
    expect(article.description).toContain('ما قدرت أجيب جواب الذكاء هسه');
    expect(article.description).toBe(article.input_message_content.message_text);
    expect(article.description).not.toContain('اختار الجواب');
  });
});
