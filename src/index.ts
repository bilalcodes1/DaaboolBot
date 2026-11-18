import { queueDailyNews } from './daily-news';
import { handleUpdate } from './bot';
import { UpdateDeduplicator } from './dedup';
import { parseUpdate } from './input';
import { TelegramClient, TelegramError } from './telegram';
import { NluClassifier } from './nlu';
import type { Env } from './types';
import { AiBudget } from './ai-budget';
import { EventStore } from './event-store';
import { queueScheduledEventJobs, dispatchEventJobs } from './event-jobs';
import { AssistantAiRetryError, isAssistantAiEnabled } from './assistant-ai';
import { queueAcademicReportReminders } from './academic-ai';
import { queueSmartReminders } from './smart-reminders';
import { cleanupAssistantHistory, assistantStorageReady } from './assistant-store';
import { getBaghdadNow } from './calendar';
import { getAcademicAlertTimes, queueLectureBriefs } from './academic-alerts';
import { runProductCron } from './product-jobs';
import { productStorageReady } from './product-router';

const MAX_BODY_BYTES = 64 * 1024;

function configured(env: Env): boolean {
  return typeof env.TELEGRAM_BOT_TOKEN === 'string' && /^\d+:[a-z0-9_-]{20,}$/i.test(env.TELEGRAM_BOT_TOKEN)
    && typeof env.WEBHOOK_SECRET_TOKEN === 'string' && /^[a-z0-9_-]{32,256}$/i.test(env.WEBHOOK_SECRET_TOKEN);
}

function response(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
}

async function authorized(actual: string | null, expected: string): Promise<boolean> {
  if (!actual || actual.length > 256) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!;
  return mismatch === 0;
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Empty body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError('Body too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
}

export function createWorker(fetcher: typeof fetch = fetch) {
  let activeToken: string | undefined;
  let telegram: TelegramClient;
  let updates = new UpdateDeduplicator();
  const classifier = new NluClassifier();
  const aiBudget = new AiBudget();
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
        const ready = configured(env);
        if (ready && env.PRODUCT_MODE_ENABLED === 'true') {
          let storageReady = false;
          try { storageReady = !!env.DB && await productStorageReady(env.DB); }
          catch { /* Health must fail closed without exposing database errors. */ }
          return response({ service: 'daabool-telegram-bot', status: storageReady ? 'ready' : 'storage_unavailable', timezone: 'Asia/Baghdad', mode: 'product' }, storageReady ? 200 : 503);
        }
        return response({ service: 'daabool-telegram-bot', status: ready ? 'ready' : 'not_configured', timezone: 'Asia/Baghdad' }, ready ? 200 : 503);
      }
      if (path !== '/webhook') return response({ error: 'Not found' }, 404);
      if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      if (!configured(env)) return response({ error: 'Service not configured' }, 503);
      if (!await authorized(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET_TOKEN)) {
        return response({ error: 'Forbidden' }, 403);
      }
      if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        return response({ error: 'Expected JSON' }, 415);
      }
      const length = request.headers.get('Content-Length');
      if (length && Number(length) > MAX_BODY_BYTES) return response({ error: 'Body too large' }, 413);
      let value: unknown;
      try { value = await readBody(request); }
      catch (error) { return response({ error: error instanceof RangeError ? 'Body too large' : 'Invalid JSON' }, error instanceof RangeError ? 413 : 400); }
      const update = parseUpdate(value);
      if (!update) return response({ error: 'Invalid update' }, 400);
      if (activeToken !== env.TELEGRAM_BOT_TOKEN) {
        activeToken = env.TELEGRAM_BOT_TOKEN;
        telegram = new TelegramClient(activeToken, fetcher);
        updates = new UpdateDeduplicator();
      }
      try {
        // Await delivery before acknowledging: Telegram can retry transient failures.
        await updates.run(update.update_id, async () => {
          try { await handleUpdate(update, telegram, new Date(), env.AI ? { ...env, AI: aiBudget.wrap(env.AI) } : env, classifier, fetcher); }
          catch (error) {
            if (!(error instanceof TelegramError) || error.retryable) throw error;
            // Deleted chats, blocked bot, expired inline queries: retries cannot repair these.
            console.warn('telegram_delivery_rejected', { code: error.code, update_id: update.update_id });
          }
        });
        return response({ ok: true });
      } catch (error) {
        console.warn('telegram_delivery_retry', { code: error instanceof TelegramError ? error.code : 0, update_id: update.update_id });
        return response({ error: 'Delivery temporarily unavailable' }, 503,
          (error instanceof TelegramError || error instanceof AssistantAiRetryError) && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      }
    },
    async scheduled(_event: ScheduledController, env: Env): Promise<void> {
      if(env.PRODUCT_MODE_ENABLED==='true'){
        if(configured(env)&&env.DB&&await productStorageReady(env.DB))await runProductCron(env,new TelegramClient(env.TELEGRAM_BOT_TOKEN,fetcher),Date.now(),fetcher);
        return;
      }
      if (!configured(env) || !env.DB || env.CONTRIBUTIONS_ENABLED !== 'true' && !isAssistantAiEnabled(env)) return;
      const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher);
      const store = new EventStore(env.DB);
      const now = Date.now();
      const clock = getBaghdadNow(new Date(now));
      const assistantEnabled = isAssistantAiEnabled(env);
      // Keep cold AI plans and legacy repair in separate invocations. Delivery
      // still runs every minute; all fixed religious slots fall in phase zero.
      const preparationPhase = clock.minuteOfDay % 3;
      if (env.CONTRIBUTIONS_ENABLED === 'true' && (!assistantEnabled || preparationPhase === 2)) await queueScheduledEventJobs(store, now);
      if (assistantEnabled && await assistantStorageReady(env.DB)) {
        const alertTimes = await getAcademicAlertTimes(env.DB, env, now, fetcher);
        if (alertTimes) {
          await queueAcademicReportReminders(env.DB, now, alertTimes);
          await queueLectureBriefs(env.DB, now, alertTimes);
        }
        if (preparationPhase === 0) await queueSmartReminders(env.DB, env, now, { fetcher });
        if (preparationPhase === 1) await queueDailyNews(env.DB, env, now, fetcher);
        if (clock.minuteOfDay === 180) await cleanupAssistantHistory(env.DB, now);
      }
      await dispatchEventJobs(store, client, now, { limit: assistantEnabled ? 1 : 4 });
      await store.cleanup(now);
    },
  };
}

export default createWorker() satisfies ExportedHandler<Env>;
