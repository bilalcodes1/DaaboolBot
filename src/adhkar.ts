import { getBaghdadNow } from './calendar';
import { getAutomationConfig, queueControlledJob, type ControlledHandler } from './controlled-scheduler';
import { EventStore } from './event-store';
import { escapeHtml } from './format';
import { readPublicSource } from './source-http';

const MINUTE = 60_000;
const DAY = 86_400_000;
const PREPARE_MINUTES = 6;
const DHIKR_JOB = 'controlled_dhikr';
const DHIKR_PRIORITY = 70;

// Reviewed evening remembrances, general dhikr and prophetic supplications. Fetch the Arabic edition as published.
export const ADHKAR_IDS: readonly number[] = [
  5503, 5507, 3057, 3008, 65928, 5502, 5915, 6082, 5475, 5482, 65906, 5488, 4808, 5483,
  6093, 6112, 3142, 5485, 65910, 5487, 3518, 5878, 5489, 6040, 6072, 65461, 3598, 65915,
];

interface DhikrHadith {
  id: string;
  hadeeth: string;
  grade: string;
  attribution: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function arabicText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && /\p{Script=Arabic}/u.test(value) && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]|https?:/iu.test(value);
}

export function verifiedDhikr(value: unknown, expectedId?: string): DhikrHadith | null {
  if (!object(value)) return null;
  const { id, hadeeth, grade, attribution } = value;
  if (typeof id !== 'string' || !/^\d{4,6}$/u.test(id) || !ADHKAR_IDS.includes(Number(id))
    || (expectedId !== undefined && id !== expectedId) || !arabicText(hadeeth, 30, 950)
    || !arabicText(grade, 4, 24) || !/^صحيح\.?$/u.test(grade.trim().replace(/\p{M}/gu, ''))
    || !arabicText(attribution, 6, 220) || !/^(?:رواه|متفق عليه|أخرجه)/u.test(attribution.trim())) return null;
  return { id, hadeeth, grade, attribution };
}

export async function loadDailyDhikr(date: string, fetcher: typeof fetch): Promise<DhikrHadith | null> {
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(date)) return null;
  const day = Date.parse(date + 'T00:00:00Z') / DAY;
  if (!Number.isInteger(day) || new Date(day * DAY).toISOString().slice(0, 10) !== date) return null;
  const id = String(ADHKAR_IDS[day % ADHKAR_IDS.length]);
  const url = 'https://hadeethenc.com/api/v1/hadeeths/one/?language=ar&id=' + id;
  const body = await readPublicSource(url, fetcher, { allowed: value => value === url, maxBytes: 64_000 });
  if (!body) return null;
  try { return verifiedDhikr(JSON.parse(body), id); } catch { return null; }
}

export function renderDhikr(item: DhikrHadith): string {
  const source = 'https://hadeethenc.com/ar/browse/hadith/' + item.id;
  return ['🌿 <b>ذكر اليوم</b>', '', '━━━━━━━━━━━━━', '', escapeHtml(item.hadeeth), '',
    '📚 ' + escapeHtml(item.attribution),
    '<a href="' + source + '">📖 المصدر</a>',
  ].join('\n');
}

function quiet(minute: number): boolean { return minute >= 60 && minute < 840; }

function dhikrMinutes(body: Record<string, unknown>): number[] {
  return [1080];
}

function dhikrWindow(date: string, minute: number) {
  const midnight = Date.parse(date + 'T00:00:00+03:00');
  const dueAt = midnight + minute * MINUTE;
  const expiresAt = minute < 60 ? Math.min(dueAt + 30 * MINUTE, midnight + 60 * MINUTE) : dueAt + 30 * MINUTE;
  return { dueAt, expiresAt };
}

/** Prepare once in a spare scheduler tick, with no network at delivery. */
export async function queueDailyDhikr(db: D1Database, now: number, fetcher: typeof fetch): Promise<boolean> {
  const clock = getBaghdadNow(new Date(now));
  if (clock.minuteOfDay >= 60 && clock.minuteOfDay < 840 - PREPARE_MINUTES) return false;
  const config = await getAutomationConfig(db, 'religion');
  if (!config.enabled || config.body.dhikrEnabled !== true) return false;
  const slot = dhikrMinutes(config.body).map(minute => ({ minute, ...dhikrWindow(clock.date, minute) }))
    .find(item => item.dueAt >= config.updatedAt && now >= item.dueAt - PREPARE_MINUTES * MINUTE && now < item.expiresAt);
  if (!slot || !(await getAutomationConfig(db, 'product')).enabled) return false;
  const settings = await new EventStore(db).getSettings();
  if (settings.targetChatId === null) return false;
  const prefix = `controlled:dhikr:${settings.targetChatId}:${clock.date}:`;
  const id = prefix + slot.minute + ':g' + config.generation;
  const [last, existing] = await Promise.all([
    db.prepare("SELECT MAX(sent_at) AS at FROM controlled_deliveries WHERE job_id LIKE 'controlled:dhikr:%'").first<{ at: number | null }>(),
    db.prepare(`SELECT 1 FROM outbox o WHERE type=? AND substr(id,1,?)=? AND (
      id=? OR state IN ('pending','sending','sent') OR EXISTS (
        SELECT 1 FROM controlled_attempts a WHERE a.job_id=o.id AND a.state IN ('requesting','unknown','confirmed')
      )) LIMIT 1`).bind(DHIKR_JOB, prefix.length, prefix, id).first(),
  ]);
  const frequency = 1;
  if (existing || (typeof last?.at === 'number' && now - last.at < frequency * DAY - 15 * MINUTE)) return false;
  const history = await db.prepare("SELECT content_id FROM controlled_deliveries WHERE family='prayer' AND job_id LIKE 'controlled:dhikr:%' ORDER BY sent_at DESC LIMIT 30").all<{content_id:string|null}>();
  const previousIds = history.results.map(row => row.content_id?.startsWith('hadeethenc:') ? row.content_id.slice('hadeethenc:'.length) : null).filter((id):id is string => !!id);
  const cache=await db.prepare("SELECT result_json FROM controlled_preparations WHERE kind='dhikr-cache' AND state='complete' ORDER BY finished_at DESC LIMIT 30").all<{result_json:string}>();
  const cached=cache.results.map(row=>verifiedDhikr(JSON.parse(row.result_json))).filter((x):x is DhikrHadith=>!!x);
  let entry = await loadDailyDhikr(clock.date, fetcher);
  if (!entry || entry.id === previousIds[0]) entry = cached.find(item => item.id !== previousIds[0]) ?? null;
  if (!entry) return false;
  await db.prepare("INSERT INTO controlled_preparations(id,kind,state,started_at,finished_at,result_json) VALUES(?,'dhikr-cache','complete',?,?,?) ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,result_json=excluded.result_json").bind('dhikr-cache:'+entry.id,now,now,JSON.stringify(entry)).run();
  return queueControlledJob(db, {
    id, type: DHIKR_JOB, family: 'prayer', priority: DHIKR_PRIORITY, contentId: 'hadeethenc:' + entry.id,
    payload: { version: 1, entry, date: clock.date, minute: slot.minute, generation: config.generation },
    dueAt: slot.dueAt, expiresAt: slot.expiresAt, chatId: settings.targetChatId, threadId: settings.targetThreadId,
    config: { key: 'religion', generation: config.generation },
  }, now);
}

export const controlledDhikrHandler: ControlledHandler = {
  types: [DHIKR_JOB],
  async resolve(db, job, now) {
    const body = job.payload;
    if (!object(body) || body.version !== 1 || typeof body.date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/u.test(body.date)
      || typeof body.minute !== 'number' || quiet(getBaghdadNow(new Date(now)).minuteOfDay)) return null;
    const { dueAt, expiresAt } = dhikrWindow(body.date, body.minute);
    if (!Number.isFinite(dueAt) || now < dueAt || now >= expiresAt) return null;
    const entry = verifiedDhikr(body.entry);
    if (!entry) return null;
    const config = await getAutomationConfig(db, 'religion');
    if (!config.enabled || config.generation !== body.generation || config.body.dhikrEnabled !== true
      || !dhikrMinutes(config.body).includes(body.minute)) return null;
    const settings = await new EventStore(db).getSettings();
    if (settings.targetChatId === null) return null;
    return { chatId: settings.targetChatId, family: 'prayer', priority: DHIKR_PRIORITY, method: 'sendMessage', expiresAt,
      config: { key: 'religion', generation: config.generation }, payload: {
        chat_id: settings.targetChatId, ...(settings.targetThreadId === null ? {} : { message_thread_id: settings.targetThreadId }),
        text: renderDhikr(entry), parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      },
    };
  },
};
