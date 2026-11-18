import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateDeduplicator } from '../src/dedup';
import { createWorker } from '../src/index';
import type { Env } from '../src/types';

const env: Env = { TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyz_fake_token', WEBHOOK_SECRET_TOKEN: 'a_secure_test_secret_1234567890123456789' };
const BOT = { id: 123456, is_bot: true, username: 'ActualDaaboolBot' };
const update = { update_id: 100, message: { message_id: 1, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text: 'شعدنا باجر' } };

function webhook(body: unknown = update, secret: string | null = env.WEBHOOK_SECRET_TOKEN, contentType = 'application/json') {
  return new Request('https://daabool.example/webhook', { method: 'POST', headers: { 'Content-Type': contentType, ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body: JSON.stringify(body) });
}

function api() {
  const fetcher = vi.fn<typeof fetch>(async url => Response.json({ ok: true, result: String(url).endsWith('/getMe') ? BOT : true }));
  return { fetcher, worker: createWorker(fetcher) };
}

describe('Worker HTTP boundary', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  it('exposes credential readiness at /health without secret data', async () => {
    const { worker, fetcher } = api();
    const result = await worker.fetch(new Request('https://daabool.example/health'), env);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ service: 'daabool-telegram-bot', status: 'ready', timezone: 'Asia/Baghdad' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect((await worker.fetch(new Request('https://daabool.example/health'), { ...env, TELEGRAM_BOT_TOKEN: '' })).status).toBe(503);
  });

  it.each([null, '', 'wrong', env.WEBHOOK_SECRET_TOKEN + 'a'])('rejects unauthorized secret %# before Telegram calls', async secret => {
    const { worker, fetcher } = api();
    expect((await worker.fetch(webhook(update, secret), env)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires complete product storage for product health, without writes or external calls', async () => {
    const { worker, fetcher } = api();
    const tables = ['manual_panels', 'manual_forms', 'manual_operations', 'manual_timetable', 'manual_reminders', 'student_roster', 'student_identities', 'group_ai_turns', 'controlled_config', 'controlled_attempts'];
    const all = vi.fn(async () => ({ results: tables.map(name => ({ name })) }));
    const bind = vi.fn((..._tables: string[]) => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const productEnv = { ...env, PRODUCT_MODE_ENABLED: 'true', DB: { prepare } as unknown as D1Database };
    expect((await worker.fetch(new Request('https://local/health'), productEnv)).status).toBe(200);
    expect(prepare.mock.calls[0]?.[0]).toMatch(/^SELECT name FROM sqlite_master/u);
    expect(bind).toHaveBeenCalledWith(...tables);
    expect(fetcher).not.toHaveBeenCalled();
    all.mockResolvedValueOnce({ results: [] });
    expect((await worker.fetch(new Request('https://local/health'), productEnv)).status).toBe(503);
    expect((await worker.fetch(new Request('https://local/health'), { ...env, PRODUCT_MODE_ENABLED: 'true' })).status).toBe(503);
    all.mockRejectedValueOnce(new Error('sensitive backend detail'));
    const failure = await worker.fetch(new Request('https://local/health'), productEnv);
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('sensitive');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects wrong routes/methods and missing configuration', async () => {
    const { worker } = api();
    expect((await worker.fetch(new Request('https://daabool.example/'), env)).status).toBe(404);
    const wrongMethod = await worker.fetch(new Request('https://daabool.example/webhook'), env);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST');
    expect((await worker.fetch(webhook(), { ...env, WEBHOOK_SECRET_TOKEN: '' })).status).toBe(503);
    expect((await worker.fetch(new Request('https://daabool.example/health', { method: 'POST' }), env)).status).toBe(405);
  });

  it('validates JSON content type, decoding, input shape, and body byte limit', async () => {
    const { worker } = api();
    expect((await worker.fetch(webhook(update, env.WEBHOOK_SECRET_TOKEN, 'text/plain'), env)).status).toBe(415);
    const malformed = new Request('https://daabool.example/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET_TOKEN }, body: '{' });
    expect((await worker.fetch(malformed, env)).status).toBe(400);
    expect((await worker.fetch(webhook({ update_id: 'bad' }), env)).status).toBe(400);
    expect((await worker.fetch(webhook({ padding: 'ع'.repeat(40_000) }), env)).status).toBe(413);
  });

  it('successfully handles a real-shaped update and prevents concurrent/serial repeats', async () => {
    const { worker, fetcher } = api();
    const replies = await Promise.all([worker.fetch(webhook(), env), worker.fetch(webhook(), env)]);
    expect(replies.map(x => x.status)).toEqual([200, 200]);
    expect((await worker.fetch(webhook(), env)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2); // one getMe + one sendMessage
  });

  it('returns 503 on transient delivery failures and allows redelivery', async () => {
    const { worker, fetcher } = api();
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: BOT }));
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 10 }, description: env.TELEGRAM_BOT_TOKEN }, { status: 429 }));
    const failed = await worker.fetch(webhook(), env);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Retry-After')).toBe('10');
    expect(await failed.text()).not.toContain(env.TELEGRAM_BOT_TOKEN);
    expect((await worker.fetch(webhook(), env)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it('acknowledges permanent blocked/deleted chat errors and does not resend', async () => {
    const { worker, fetcher } = api();
    fetcher.mockResolvedValueOnce(Response.json({ ok: true, result: BOT }));
    fetcher.mockResolvedValueOnce(Response.json({ ok: false, error_code: 403, description: env.TELEGRAM_BOT_TOKEN }, { status: 403 }));
    expect((await worker.fetch(webhook(), env)).status).toBe(200);
    expect((await worker.fetch(webhook(), env)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not make Telegram calls for unrelated queued update types', async () => {
    const { worker, fetcher } = api();
    expect((await worker.fetch(webhook({ update_id: 200, edited_message: {} }), env)).status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('acknowledges unaddressed group text and bot/media updates without contacting Telegram', async () => {
    const { worker, fetcher } = api();
    const base = update.message;
    const messages = [
      { ...base, chat: { id: -42, type: 'supergroup' }, text: 'شعدنا باجر' },
      { ...base, text: 'دعبول جدول اليوم', from: BOT },
      { ...base, text: 'دعبول جدول اليوم', via_bot: BOT },
      { message_id: 1, from: base.from, chat: base.chat, photo: [{ file_id: 'photo_1', width: 100, height: 100 }], caption: 'صورة عادية' },
      { message_id: 1, from: base.from, chat: base.chat, document: { file_id: 'document_1' } },
    ];
    for (const [index, message] of messages.entries()) {
      expect((await worker.fetch(webhook({ update_id: 1000 + index, message }), env)).status).toBe(200);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('bounded per-isolate deduplication', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expires successful updates and retries failed work', async () => {
    const dedup = new UpdateDeduplicator(2, 1000);
    const task = vi.fn(async () => {});
    await dedup.run(1, task);
    await dedup.run(1, task);
    expect(task).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    await dedup.run(1, task);
    expect(task).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => { throw new Error('temporary'); });
    await expect(dedup.run(2, failing)).rejects.toThrow('temporary');
    await dedup.run(2, task);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('evicts completed entries to enforce capacity while protecting in-flight work', async () => {
    const dedup = new UpdateDeduplicator(1);
    let release!: () => void;
    const pending = dedup.run(1, () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    await expect(dedup.run(2, async () => {})).rejects.toThrow('capacity');
    release();
    await pending;
    await expect(dedup.run(2, async () => {})).resolves.toBeUndefined();
  });
});
