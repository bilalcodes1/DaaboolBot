import { addCalendarDays, getBaghdadNow, getCalendarWeek, getTomorrow } from "./calendar";
import { escapeHtml, formatSlotTime, formatTomorrow, TIMING_NOTICE } from "./format";
import { COURSE_ALIASES, TEACHER_ALIASES, type CourseId, type NluResult, type TeacherId } from "./nlu-schema";
import { SCHEDULE, WEEKDAYS, type LectureSlot, type Session } from "./schedule";
import { formatMinuteOfDay, getSlotPhase, getSlotTiming, PROVISIONAL_TIMES } from "./timing";

export interface RenderedQuery {
  readonly text: string;
  readonly title: string;
  readonly id: string;
}

const OUT_OF_SCOPE = "حبيبي آني دعبول، مختص بجدول محاضرات المرحلة الثالثة 😂❤️";
const NO_MATCHES = "ماكو محاضرات مطابقة ضمن الجدول الرسمي.";
const NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
const KIND_NAMES = { theory: "نظري", practical: "عملي", exercises: "تمارين" } as const;
const DATED_WEEKS = { current_week: { offset: 0, title: "هذا الأسبوع" }, next_week: { offset: 1, title: "الأسبوع الجاي" }, last_week: { offset: -1, title: "الأسبوع الماضي" } } as const;

function selectedWeek(query: NluResult, now: Date): { fromDate: string; toDate: string; title: string } | null {
  if (!(query.day in DATED_WEEKS)) return null;
  const week = DATED_WEEKS[query.day as keyof typeof DATED_WEEKS];
  return { ...getCalendarWeek(now, week.offset), title: week.title };
}

function hasFilters(query: NluResult): boolean {
  return query.labsOnly || [query.course, query.teacher, query.group, query.lab, query.slot, query.kind].some(value => value !== null);
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي")
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/\s+/g, " ").trim();
}

function matchesTeacher(official: string, teacher: TeacherId): boolean {
  const aliases = TEACHER_ALIASES[teacher] ?? [];
  return official.split("+").some(part => {
    const name = normalizeName(part.trim().replace(/^(?:م\.\s*م\.\s*|د\.\s*|مبرمج(?:ة)?\s+)/, ""));
    return aliases.some(alias => {
      const prefix = normalizeName(alias);
      return name === prefix || name.startsWith(`${prefix} `);
    });
  });
}

function matchesCourse(official: string, course: CourseId): boolean {
  const base = normalizeName(official.replace(/\s*\([^)]*\)\s*$/, ""));
  const aliases = COURSE_ALIASES[course];
  return Array.isArray(aliases) && aliases.some(alias => normalizeName(alias) === base);
}

function matches(session: Session, slot: number, query: NluResult): boolean {
  if (query.course !== null && !matchesCourse(session.course, query.course)) return false;
  if (query.teacher !== null && (!session.teacher || !matchesTeacher(session.teacher, query.teacher))) return false;
  // Lectures without a group are shared by all students.
  if (query.group !== null && session.group !== undefined && session.group !== query.group) return false;
  if (query.lab !== null && session.laboratory !== `م${query.lab}`) return false;
  if (query.labsOnly && session.laboratory === undefined && !/\(عملي\)\s*$/u.test(session.course)) return false;
  if (query.slot !== null && slot !== query.slot) return false;
  // A laboratory or group never supplies a missing theory/practical label.
  if (query.kind !== null && !session.course.endsWith(`(${KIND_NAMES[query.kind]})`)) return false;
  return true;
}

interface SelectedSlot {
  readonly number: number;
  readonly title: string;
  readonly sessions: readonly Session[];
}

function selectDay(weekday: number, query: NluResult): SelectedSlot[] {
  const slots: readonly LectureSlot[] = SCHEDULE[weekday] ?? [];
  return slots.map((slot, index) => ({
    number: index + 1,
    title: slot.title,
    sessions: slot.sessions.filter(session => matches(session, index + 1, query)),
  })).filter(slot => slot.sessions.length > 0);
}

function renderSlot(slot: SelectedSlot, now?: Date): string {
  const timing = slot.number <= PROVISIONAL_TIMES.slots.length ? getSlotTiming(slot.number) : undefined;
  const phase = now && timing ? getSlotPhase(slot.number, now) : undefined;
  const status = phase === "current" ? "🟢 هسه مستمرة" : phase === "ended" ? "✅ خلصت" : phase === "before" ? "⏳ بعد ما بدت" : undefined;
  const time = timing ? `🕒 ${formatSlotTime(slot.number)}${status ? ` | ${status}` : ""}` : undefined;
  return [
    `${NUMBERS[slot.number - 1] ?? `${slot.number}.`} <b>${escapeHtml(slot.title)}</b>`,
    ...(time ? [time] : []),
    ...slot.sessions.map(session => [
      `📖 ${escapeHtml(session.course)}${session.group ? ` | مجموعة ${escapeHtml(session.group)}` : ""}${session.laboratory ? ` | ${escapeHtml(session.laboratory)}` : ""}`,
      ...(session.teacher ? [`👨‍🏫 ${escapeHtml(session.teacher)}`] : []),
    ].join("\n")),
  ].join("\n");
}

function knownTiming(slot: number) {
  try { return getSlotTiming(slot); } catch { return undefined; }
}

function resultId(query: NluResult, scope: string): string {
  const { confidence: _confidence, ...selection } = query;
  let hash = 2166136261;
  for (const character of JSON.stringify(selection)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `query-${scope}-${hash.toString(16).padStart(8, "0")}`;
}

function bounded(text: string, title: string, id: string): RenderedQuery {
  // Never truncate a lecture. The complete supplied weekly timetable fits this compact layout.
  if (text.length > 4096) throw new RangeError("The official timetable exceeds Telegram's message limit.");
  return { text, title, id };
}

function clarificationOfKind(query: NluResult, days: readonly number[]): RenderedQuery | null {
  if (query.kind === null) return null;
  return kindClarificationFromSlots(days.flatMap(day => selectDay(day, { ...query, kind: null })));
}

function kindClarificationFromSlots(slots: readonly SelectedSlot[]): RenderedQuery | null {
  if (!slots.some(slot => slot.sessions.some(session => !/\((?:نظري|عملي|تمارين)\)\s*$/u.test(session.course)))) return null;
  return {
    id: "clarify-kind", title: "وضّح نوع المحاضرة",
    text: "نوع هذي المحاضرات مو مذكور بالجدول. اكتب اسم المادة أو المختبر بدون تحديد نظري/عملي.",
  };
}

function durationText(minutes: number): string {
  const total = Math.max(1, Math.ceil(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return [hours ? `${hours} ساعة` : "", rest ? `${rest} دقيقة` : ""].filter(Boolean).join(" و");
}

function renderTemporalQuery(query: NluResult, now: Date): RenderedQuery {
  const clock = getBaghdadNow(now);
  const currentMinute = clock.millisecondOfDay / 60_000;
  const nowLine = `🕰️ هسه ${formatMinuteOfDay(clock.minuteOfDay)} بتوقيت بغداد`;
  if ((query.intent === "current" || query.intent === "remaining") &&
      (query.day === "tomorrow" || query.day === "week" || selectedWeek(query, now) !== null || (query.day === "weekday" && query.weekday !== clock.weekday))) {
    return { id: "clarify-time-day", title: "حدّد اليوم", text: "المحاضرة الحالية والمتبقية تنحسب لليوم. تقصد جدول ذاك اليوم، لو المحاضرة الجاية؟" };
  }

  const restricted = query.day !== "unspecified";
  const week = selectedWeek(query, now);
  if (query.intent === "next" && query.day === "last_week") return { id: "clarify-time-week", title: "حدّد الأسبوع", text: "تقصد محاضرات الأسبوع الماضي، لو المحاضرة الجاية؟" };
  const dates = week ? Array.from({ length: 7 }, (_, offset) => addCalendarDays(week.fromDate, offset))
    : query.intent !== "next" || query.day === "today" ? [addCalendarDays(clock.date, 0)]
    : query.day === "tomorrow" ? [getTomorrow(now)]
    : query.day === "weekday" ? [addCalendarDays(clock.date, (query.weekday! - clock.weekday + 7) % 7)]
    : Array.from({ length: 8 }, (_, offset) => addCalendarDays(clock.date, offset));
  const selectForTime = (calendar: { date: string; weekday: number }, selection: NluResult): SelectedSlot[] => {
    const isToday = calendar.date === clock.date;
    return selectDay(calendar.weekday, selection).filter(slot => {
      const timing = knownTiming(slot.number);
      if (!timing) {
        if (!isToday) return query.intent === "next";
        const lastTimed = PROVISIONAL_TIMES.slots.at(-1)?.slot;
        if (lastTimed === undefined || slot.number <= lastTimed) return false;
        const lastPhase = getSlotPhase(lastTimed, now);
        if (query.intent === "next") return lastPhase !== "before";
        if (query.intent === "remaining") return lastPhase !== "ended";
        return false;
      }
      if (query.intent === "current") return isToday && getSlotPhase(slot.number, now) === "current";
      if (query.intent === "remaining") return isToday && getSlotPhase(slot.number, now) !== "ended";
      return calendar.date > clock.date || (isToday && timing.startMinute > currentMinute);
    });
  };
  const candidates = dates.map(calendar => ({ calendar, slots: selectForTime(calendar, query) }));
  const match = candidates.find(candidate => candidate.slots.length > 0);
  const title = query.intent === "current" ? "المحاضرة الحالية" : query.intent === "remaining" ? "المحاضرات المتبقية اليوم" : "المحاضرة الجاية";
  if (!match) {
    const untimed = dates.flatMap(calendar => selectDay(calendar.weekday, query)
      .filter(slot => !knownTiming(slot.number)));
    if (untimed.length) {
      const message = query.intent === "current"
        ? "ما أگدر أحدد المحاضرة الحالية؛ وقت المحاضرات الرابعة والخامسة مو مذكور بالجدول."
        : "باقي محاضرات بترتيب الجدول، بس أوقاتها مو مذكورة حتى أحدد الجاية أو الباقية بدقة.";
      return bounded(`📚 <b>${title}</b>\n${nowLine}\n${message}`, title, resultId(query, `${clock.date}-${clock.minuteOfDay}`));
    }
    // A missing type in the official table stays unknown even for time questions.
    const kind = query.kind === null ? null : kindClarificationFromSlots(dates.flatMap(date => selectForTime(date, { ...query, kind: null })));
    if (kind) return kind;
    const message = query.intent === "current" ? "هسه ماكو محاضرة مطابقة مستمرة حسب الجدول."
      : query.intent === "remaining" ? "ما بقت محاضرات مطابقة اليوم حسب الجدول."
      : week ? "ما بقت محاضرات جاية مطابقة بهذا الأسبوع حسب الجدول."
      : restricted ? "ما بقت محاضرات جاية مطابقة بهذا اليوم حسب الجدول."
      : "ماكو محاضرات جاية مطابقة ضمن الجدول الأسبوعي.";
    return bounded(`📚 <b>${title}</b>\n${nowLine}\n${TIMING_NOTICE}\n\n${message}`, title, resultId(query, `${clock.date}-${clock.minuteOfDay}`));
  }
  const slots = query.intent === "next" ? match.slots.slice(0, 1) : match.slots;
  const first = knownTiming(slots[0]!.number);
  const calendarDays = (Date.parse(`${match.calendar.date}T00:00:00Z`) - Date.parse(`${clock.date}T00:00:00Z`)) / 86_400_000;
  const countdown = query.intent === "next" && first ? `⏳ تبدي بعد ${durationText(calendarDays * 1440 + first.startMinute - currentMinute)}.`
    : query.intent === "current" && first ? `⏳ تنتهي بعد ${durationText(first.endMinute - currentMinute)}.` : "";
  const unknownTimes = slots.some(slot => !knownTiming(slot.number));
  return bounded([
    `📚 <b>دعبول | ${title}</b>\n📅 ${WEEKDAYS[match.calendar.weekday]} ${match.calendar.date}${week ? `\n🗓️ ${week.title}: ${week.fromDate} إلى ${week.toDate}` : ""}`,
    `${nowLine}\n${TIMING_NOTICE}`,
    ...(countdown ? [countdown] : []),
    ...slots.map(slot => renderSlot(slot, match.calendar.date === clock.date ? now : undefined)),
    ...(unknownTimes ? ["⏱️ الوقت الدقيق لهذي المحاضرة مو مذكور بالجدول."] : []),
  ].join("\n\n"), title, resultId(query, `${clock.date}-${clock.minuteOfDay}`));
}

export function renderQuery(query: NluResult, now: Date = new Date()): RenderedQuery {
  if (query.intent === "out_of_scope") return { text: OUT_OF_SCOPE, title: "دعبول | جدول المحاضرات", id: "out-of-scope" };
  if (query.intent === "clarify") return {
    text: "شنو تريد تعرف من الجدول؟ حدّد اليوم أو المادة، والمجموعة إذا تحتاجها.\nمثلاً: مختبرات الأحد مجموعة B، أو المحاضرة الجاية مجموعة A.",
    title: "وضّح سؤالك عن الجدول", id: "clarify",
  };
  if (query.day === "weekday" && (!Number.isInteger(query.weekday) || query.weekday === null || query.weekday < 0 || query.weekday > 6)) {
    return { text: "تريد جدول أي يوم؟ اليوم، باچر، أو اسم اليوم؟", title: "حدّد اليوم", id: "clarify-day" };
  }
  if (["next", "current", "remaining"].includes(query.intent)) return renderTemporalQuery(query, now);
  if (query.day === "unspecified" && query.intent !== "lookup") {
    return { text: "تريد جدول أي يوم؟ اليوم، باچر، أو اسم اليوم؟", title: "حدّد اليوم", id: "clarify-day" };
  }
  if (query.day === "tomorrow" && !hasFilters(query)) {
    const formatted = formatTomorrow(now);
    return {
      text: formatted.text,
      title: `📚 جدول محاضرات باچر – ${formatted.dayName}`,
      id: `tomorrow-${formatted.date}`,
    };
  }

  const datedWeek = selectedWeek(query, now);
  const weekly = datedWeek !== null || query.day === "week" || (query.day === "unspecified" && query.intent === "lookup");
  const calendar = query.day === "today" ? getBaghdadNow(now) : query.day === "tomorrow" ? getTomorrow(now) : null;
  const weekday = calendar?.weekday ?? query.weekday;
  const scope = datedWeek ? `${query.labsOnly ? "مختبرات" : "محاضرات"} ${datedWeek.title}${query.group ? ` | مجموعة ${query.group}` : ""}`
    : weekly ? `${query.labsOnly ? "مختبراتكم " : ""}ضمن الجدول الأسبوعي`
    : `${query.labsOnly ? "مختبرات" : "جدول"} ${WEEKDAYS[weekday ?? -1] ?? "اليوم المحدّد"}${query.labsOnly && query.group ? ` | مجموعة ${query.group}` : ""}`;
  const header = `📚 <b>دعبول | ${escapeHtml(scope)}</b>${datedWeek ? `\n🗓️ ${datedWeek.fromDate} إلى ${datedWeek.toDate}` : calendar ? `\n📅 ${escapeHtml(calendar.date)}` : ""}`;
  const selected = (weekly ? WEEKDAYS.map((_, index) => index) : weekday === null ? [] : [weekday])
    .map(day => ({ day, slots: selectDay(day, query) }));
  const sections = selected.filter(day => day.slots.length > 0).map(({ day, slots }) => [
    ...(weekly ? [`<b>${escapeHtml(WEEKDAYS[day]!)}${datedWeek ? ` ${addCalendarDays(datedWeek.fromDate, day).date}` : ""}</b>`] : []),
    ...slots.map(slot => renderSlot(slot, query.day === "today" ? now : undefined)),
  ].join("\n\n"));
  if (weekly && !hasFilters(query)) {
    for (const { day, slots } of selected) {
      if (slots.length === 0) sections.push(`<b>${escapeHtml(WEEKDAYS[day]!)}${datedWeek ? ` ${addCalendarDays(datedWeek.fromDate, day).date}` : ""}</b>\nماكو محاضرات مجدولة.`);
    }
  }
  if (sections.length === 0) {
    const kind = clarificationOfKind(query, selected.map(day => day.day));
    if (kind) return kind;
  }
  const hasSessions = selected.some(day => day.slots.length > 0);
  const text = `${header}${hasSessions ? `\n${TIMING_NOTICE}` : ""}\n\n${sections.length ? sections.join("\n\n") : query.labsOnly ? "ماكو مختبرات مطابقة ضمن الجدول الرسمي." : NO_MATCHES}`;
  return bounded(text, `📚 دعبول | ${scope}`, resultId(query, datedWeek?.fromDate ?? calendar?.date ?? (weekly ? "week" : `weekday-${weekday}`)));
}
