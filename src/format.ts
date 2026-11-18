import { getTomorrow } from "./calendar";
import { SCHEDULE, WEEKDAYS, type Session } from "./schedule";
import { formatMinuteOfDay, getSlotTiming, PROVISIONAL_TIMES } from "./timing";

export const TIMING_NOTICE = `⏱️ ${PROVISIONAL_TIMES.label} للمحاضرات 1–3؛ وقت المحاضرتين 4 و5 غير مذكور.`;

export function formatSlotTime(slot: number): string {
  const timing = getSlotTiming(slot);
  if (!timing) throw new RangeError("Missing lecture timing.");
  return `${formatMinuteOfDay(timing.startMinute)}–${formatMinuteOfDay(timing.endMinute)}`;
}

export interface FormattedTomorrow {
  readonly text: string;
  readonly dayName: string;
  readonly date: string;
}

/** Telegram HTML text escaping; user/data text must never become markup. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatSession(session: Session, groupFirst: boolean): string {
  const lines: string[] = [];
  const group = session.group
    ? `👥 مجموعة ${escapeHtml(session.group)}`
    : undefined;

  if (groupFirst && group) lines.push(group);
  lines.push(`📖 ${escapeHtml(session.course)}`);
  if (!groupFirst && group) lines.push(group);
  if (session.laboratory) {
    lines.push(`📍 ${escapeHtml(session.laboratory)}`);
  }
  if (session.teacher) lines.push(`👨‍🏫 ${escapeHtml(session.teacher)}`);
  return lines.join("\n");
}

export function formatTomorrow(now: Date = new Date()): FormattedTomorrow {
  const { weekday, date } = getTomorrow(now);
  const dayName = WEEKDAYS[weekday]!;
  const slots = SCHEDULE[weekday]!;
  const header = `📚 <b>دعبول | جدول ${escapeHtml(dayName)}</b>\n📅 ${escapeHtml(date)}`;
  const numbers = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

  const text = slots.length === 0
    ? `${header}\n\nباچر ما عدكم محاضرات مجدولة.`
    : [
        header,
        TIMING_NOTICE,
        ...slots.map((slot, index) => {
          const simultaneous = slot.sessions.length > 1;
          const title = `${numbers[index]} <b>${escapeHtml(slot.title)}${simultaneous ? " – محاضرتان متزامنتان" : ""}</b>`;
          const time = index < PROVISIONAL_TIMES.slots.length ? `🕒 ${formatSlotTime(index + 1)}` : undefined;
          return [
            title,
            ...(time ? [time] : []),
            slot.sessions.map((session) => formatSession(session, simultaneous)).join("\n\n"),
          ].join("\n");
        }),
        "✅ وبس، هذا جدولكم باچر.",
      ].join("\n\n");

  // This is conservative: Telegram's 4096-character limit is after parsing
  // entities, while this also counts the small amount of HTML markup.
  if (text.length > 4096) {
    throw new RangeError("The timetable exceeds Telegram's message limit.");
  }

  return { text, dayName, date };
}
