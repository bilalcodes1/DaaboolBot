import { addCalendarDays, getCalendarWeek, type CalendarWeek } from "./calendar";
import { normalizeArabic } from "./input";

export type WeekRangeLabel = "next_week" | "current_week" | "last_week";

export interface WeekRange extends CalendarWeek {
  readonly label: WeekRangeLabel;
}

export interface ParsedWeekRange {
  /** True for a relative week phrase, including an unsupported/ambiguous one. */
  readonly matched: boolean;
  readonly range: WeekRange | null;
  readonly conflicting: boolean;
}

function normalizeWeekText(text: string): string {
  return normalizeArabic(text).toLowerCase().replace(/ة/g, "ه").replace(/ى/g, "ي");
}

const NOUN = "(?:(?:و|ب|ل)?(?:ال)?|و?لل)اسبوع";
const NEXT = "(?:ال)?(?:جاي|جايه|قادم|قادمه|تالي|تاليه|مقبل|مقبله)";
const CURRENT = "(?:ال)?(?:حالي|حاليه)";
const LAST = "(?:ال)?(?:ماضي|ماضيه|سابق|سابقه|فات|فاته)";
const modifiers = [
  { label: "next_week" as const, expression: `${NOUN}\\s+(?:(?:(?:اللي|الي|يلي)\\s+)?${NEXT}|(?:اللي|الي|يلي)\\s+يجي)` },
  { label: "current_week" as const, expression: `(?:${NOUN}\\s+(?:${CURRENT}|هذا|هاذا)|(?:و|ب|ل)?(?:هذا|هاذا)\\s+${NOUN}|(?:و|ب|ل)?هالاسبوع)` },
  { label: "last_week" as const, expression: `${NOUN}\\s+(?:${LAST}|(?:اللي|الي|يلي)\\s+راح)` },
];

// These expressions cannot be reduced to the nearest ordinary calendar week.
// Keep them explicit so "الأسبوع بعد الجاي" never silently becomes next week.
const unsupportedExpressions = [
  `(?:بعد|قبل)\\s+(?:${NOUN}|(?:ال)?اسبوعين|(?:ال)?اسابيع)(?:\\s+${NEXT})?`,
  `${NOUN}\\s+(?:(?:اللي|الي|يلي|الذي|اللذي)\\s+)?(?:بعد|قبل)(?:\\s+${NEXT})?`,
  `${NOUN}\\s+(?:(?:اللي|الي|يلي|الذي|اللذي)\\s+)?(?:ال)?(?:بعده|قبله|بعدها|قبلها)`,
  `(?:ال)?اسبوعين(?:\\s+(?:${NEXT}|${CURRENT}|${LAST}))?`,
  `(?:ال)?اسابيع\\s+(?:${NEXT}|${CURRENT}|${LAST})`,
  `${NOUN}\\s+(?:الاول|الثاني|الثالث|الرابع|١|٢|٣|٤|1|2|3|4|القريب|البعيد)`,
  `${NOUN}\\s+(?:مو|مش|ليس)\\s+(?:${NEXT}|${CURRENT}|${LAST})`,
  `(?:مو|مش|ليس)\\s+(?:${NOUN}\\s+(?:${NEXT}|${CURRENT}|${LAST})|(?:و|ب|ل)?هالاسبوع)`,
  `${NOUN}\\s+${NEXT}\\s+(?:بعد|قبل)\\s+${NEXT}`,
];

function pattern(expression: string, global = false): RegExp {
  return new RegExp(`(?:^|\\s)(?:${expression})(?=$|\\s)`, global ? "gu" : "u");
}

/** Understand only literal relative calendar weeks; no AI or weekday inference. */
export function parseWeekRange(text: string, now: Date = new Date()): ParsedWeekRange {
  const normalized = normalizeWeekText(text);
  const labels = new Set<WeekRangeLabel>();
  for (const modifier of modifiers) {
    if (pattern(modifier.expression).test(normalized)) labels.add(modifier.label);
  }

  // A shared noun still allows a conflicting request: "الأسبوع الجاي أو الحالي".
  const hasWeekNoun = pattern(`${NOUN}|(?:و|ب|ل)?هالاسبوع`).test(normalized);
  if (hasWeekNoun) {
    const conjoined = `(?:^|\\s)(?:و|او)\\s*(?:${NEXT}|${CURRENT}|${LAST})(?=$|\\s)`;
    for (const match of normalized.matchAll(new RegExp(conjoined, "gu"))) {
      const value = match[0].trim().replace(/^(?:او|و)\s*/u, "");
      if (pattern(NEXT).test(value)) labels.add("next_week");
      else if (pattern(CURRENT).test(value)) labels.add("current_week");
      else if (pattern(LAST).test(value)) labels.add("last_week");
    }
  }

  const unsupported = unsupportedExpressions.some(expression => pattern(expression).test(normalized));
  const conflicting = labels.size > 1;
  if (conflicting || unsupported) return { matched: true, range: null, conflicting };
  const label = labels.values().next().value;
  if (label === undefined) return { matched: false, range: null, conflicting: false };
  const offset = label === "next_week" ? 1 : label === "last_week" ? -1 : 0;
  return { matched: true, range: { ...getCalendarWeek(now, offset), label }, conflicting: false };
}

/** Normalized remaining words for consumers' independent weekday parsing. */
export function removeWeekSelectors(text: string): string {
  let normalized = normalizeWeekText(text);
  // Remove longer unsupported phrases first, then valid selectors. Repetition
  // handles adjacent selections whose separating space was consumed by a match.
  for (let repeat = 0; repeat < 2; repeat += 1) {
    for (const expression of [...unsupportedExpressions, ...modifiers.map(value => value.expression)]) {
      normalized = normalized.replace(pattern(expression, true), " ");
    }
  }
  return normalized.replace(/\s+/g, " ").trim();
}

/** Select an explicit weekday inside an already resolved Sunday–Saturday week. */
export function resolveWeekdayInRange(range: CalendarWeek, weekday: number): string {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError("Expected a weekday from Sunday (0) through Saturday (6).");
  }
  const start = addCalendarDays(range.fromDate, 0);
  if (start.weekday !== 0 || addCalendarDays(range.fromDate, 6).date !== range.toDate) {
    throw new RangeError("Expected an inclusive Sunday–Saturday calendar week.");
  }
  return addCalendarDays(range.fromDate, weekday).date;
}
