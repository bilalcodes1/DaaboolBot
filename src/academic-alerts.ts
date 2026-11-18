import { addCalendarDays, getBaghdadNow } from './calendar';
import { type AssistantAiEnv } from './assistant-ai';
import { escapeHtml } from './format';
import { formatTimetableNotification, officialTimetable } from './manual-timetable';
import { SCHEDULE, WEEKDAYS } from './schedule';

const MINUTE = 60_000;
const LATE_LIMIT = 30 * MINUTE;
export interface AcademicAlertTimes { morningMinute: number; eveningMinute: number }
export const DEFAULT_ACADEMIC_ALERT_TIMES: Readonly<AcademicAlertTimes> = { morningMinute: 960, eveningMinute: 1080 };
interface Destination { targetChatId: number | null; targetThreadId: number | null }
export interface LectureBriefPayload {
  version: 1; localDate: string; date: string; slot: 'morning' | 'evening'; dueAt: number;
  chatId: number; threadId: number | null;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function timestamp(date: string, minute: number): number { return Date.parse(`${date}T00:00:00+03:00`) + minute * MINUTE; }
export async function getAcademicAlertTimes(_db: D1Database, _env: AssistantAiEnv, _now: number, _fetcher: typeof fetch = fetch): Promise<AcademicAlertTimes> {
  return { ...DEFAULT_ACADEMIC_ALERT_TIMES };
}

/** At most a morning today brief and an evening tomorrow brief. Only a live
 * 30-minute slot is queued; there is no stale catch-up at activation/restart. */
export async function queueLectureBriefs(db: D1Database, now: number, times: AcademicAlertTimes = DEFAULT_ACADEMIC_ALERT_TIMES): Promise<number> {
  const clock = getBaghdadNow(new Date(now));
  const dueEvening = timestamp(clock.date, 960);
  const slot = 'evening' as const;
  if (now < dueEvening || now > dueEvening + LATE_LIMIT) return 0;
  const date = addCalendarDays(clock.date, 1).date;
  // Empty official days may still have an explicitly dated student schedule change.
  const id = `lecture-brief:${clock.date}:${slot}`;
  const row = await db.prepare(`SELECT s.target_chat_id,s.target_thread_id,o.state,o.payload_json,
    EXISTS(SELECT 1 FROM academic_reports r WHERE r.state='active' AND r.kind='lecture_change' AND r.event_date=?
      AND r.destination_chat_id=s.target_chat_id AND COALESCE(r.destination_thread_id,0)=COALESCE(s.target_thread_id,0)) AS changes
    FROM settings s LEFT JOIN outbox o ON o.id=? WHERE s.singleton=1`).bind(date, id)
    .first<{ target_chat_id: number | null; target_thread_id: number | null; state: string | null; payload_json: string | null; changes: number }>();
  if (!row || row.target_chat_id === null || !SCHEDULE[addCalendarDays(date, 0).weekday]!.length && !row.changes) return 0;
  if (row.state && row.state !== 'pending' && row.state !== 'cancelled') return 0;
  const payload: LectureBriefPayload = { version: 1, localDate: clock.date, date, slot, dueAt: dueEvening,
    chatId: row.target_chat_id, threadId: row.target_thread_id };
  const json = JSON.stringify(payload);
  if (row.payload_json === json && row.state === 'pending') return 0;
  const inserted = await db.prepare(`INSERT INTO outbox(id,type,payload_json,due_at) SELECT ?,'lecture_brief',?,?
    FROM settings WHERE singleton=1 AND target_chat_id=? AND COALESCE(target_thread_id,0)=?
    ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,due_at=excluded.due_at,state='pending',attempts=0,
      lease_until=NULL,lease_token=NULL,last_error=NULL WHERE outbox.state IN ('pending','cancelled')`)
    .bind(id, json, payload.dueAt, payload.chatId, payload.threadId ?? 0).run();
  return inserted.meta.changes ?? 0;
}

function boundedHtml(text: string, maximum: number): string {
  let result = '';
  for (const character of text) { const escaped = escapeHtml(character); if (result.length + escaped.length > maximum - 1) return result + '…'; result += escaped; }
  return result;
}
/** Render current source records immediately before send, so a revised/cancelled
 * student exception never survives in a queued timetable snapshot. */
export async function lectureBriefOutgoing(db: D1Database, payload: unknown, settings: Destination, now: number): Promise<{
  chatId: number; method: 'sendMessage'; payload: Record<string, unknown>;
} | null> {
  if (!object(payload) || payload.version !== 1 || !['morning', 'evening'].includes(String(payload.slot))
    || typeof payload.localDate !== 'string' || typeof payload.date !== 'string' || typeof payload.dueAt !== 'number'
    || !Number.isFinite(payload.dueAt) || !Number.isSafeInteger(payload.chatId)
    || payload.chatId !== settings.targetChatId || payload.threadId !== settings.targetThreadId
    || payload.slot !== 'evening' || getBaghdadNow(new Date(payload.dueAt)).minuteOfDay !== 960
    || now < payload.dueAt || now > payload.dueAt + LATE_LIMIT) return null;
  const value = payload as unknown as LectureBriefPayload;
  const clock = getBaghdadNow(new Date(now));
  if (clock.date !== value.localDate || value.date !== (value.slot === 'morning' ? clock.date : addCalendarDays(clock.date, 1).date)
    || getBaghdadNow(new Date(value.dueAt)).date !== clock.date) return null;
  const weekday = addCalendarDays(value.date, 0).weekday;
  const title = `دعبول | محاضرات ${value.slot === 'morning' ? 'اليوم' : 'باچر'} — ${WEEKDAYS[weekday]}`;
  const formatted = formatTimetableNotification(officialTimetable(), value.date, title);
  const lines = [formatted ?? `📅 <b>${escapeHtml(title)}</b>\n\n<b>${escapeHtml(value.date)}</b>`,
    '📋 حسب الجدول الأسبوعي المعتمد'];
  const changes = await db.prepare(`SELECT author_name,certainty,body_json FROM academic_reports WHERE state='active' AND kind='lecture_change'
    AND event_date=? AND destination_chat_id=? AND COALESCE(destination_thread_id,0)=? ORDER BY updated_at DESC,id LIMIT 6`)
    .bind(value.date, value.chatId, value.threadId ?? 0).all<{ author_name: string; certainty: string; body_json: string }>();
  const reports: string[] = [];
  for (const row of changes.results ?? []) {
    try {
      const item: unknown = JSON.parse(row.body_json);
      if (!object(item) || typeof item.details !== 'string' || !item.details.trim()) continue;
      const prefix = `• ${row.certainty === 'asserted' ? 'حسب تبليغ الطالب' : '⚠️ احتمال/غير مؤكد — تبليغ طالب'} ${boundedHtml(row.author_name, 100)}: `;
      reports.push(prefix + boundedHtml(item.details, 360));
    } catch { /* Corrupt optional records cannot break the official timetable. */ }
  }
  if (!SCHEDULE[weekday]!.length && !reports.length) return null;
  if (!SCHEDULE[weekday]!.length) lines.push('لا توجد محاضرات في الجدول الأسبوعي لهذا اليوم.');
  if (reports.length) {
    lines.push('\n📝 <b>تغييرات محاضرات بتاريخ اليوم المعروض — تبليغات طلاب</b>');
    for (const report of reports) {
      if (lines.join('\n').length + report.length + 1 > 3950) { lines.push('توجد تبليغات إضافية؛ اسأل دعبول عن تغييرات المحاضرات.'); break; }
      lines.push(report);
    }
  }
  lines.push('\nالجدول المنتظم لا يثبت انعقاد المحاضرة ولا يلغي تبليغاً خاصاً.');
  return { chatId: value.chatId, method: 'sendMessage', payload: { chat_id: value.chatId,
    ...(value.threadId !== null ? { message_thread_id: value.threadId } : {}), text: lines.join('\n'), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true } } };
}
