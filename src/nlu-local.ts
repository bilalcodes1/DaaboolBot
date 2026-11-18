import { normalizeArabic, stripMentions } from "./input";
import { parseWeekRange, removeWeekSelectors } from "./date-range";
import {
  COURSE_ALIASES,
  TEACHER_ALIASES,
  emptyResult,
  type CourseId,
  type NluDay,
  type NluResult,
  type TeacherId,
} from "./nlu-schema";

function normalize(text: string): string {
  return normalizeArabic(stripMentions(text)).toLowerCase()
    .replace(/[ؤئ]/g, (letter) => letter === "ؤ" ? "و" : "ي")
    .replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[٠-٩۰-۹]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".includes(digit)
      ? "٠١٢٣٤٥٦٧٨٩".indexOf(digit) : "۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/([0-9])و(?=[0-9])/g, "$1 و")
    // Accept omitted spaces only at explicit Arabic/Latin group boundaries
    // or inside this complete, known availability-question grammar.
    .replace(/([\p{Script=Arabic}])([a-z])(?=$|\s)/gu, "$1 $2")
    .replace(/(?:^|\s)([a-z])(?=[\p{Script=Arabic}])/gu, " $1 ")
    .replace(/(?:^|\s)(شنو|شو|ماذا|ما)(عدهم|عندهم|لديهم|عدنا|عندنا|لدينا)(اليوم|هاليوم|باجر+|بكرا|بكره|غدا|غد)(?=$|\s|[a-z])/gu, " $1 $2 $3")
    .replace(/\s+/g, " ").trim();
}

/** Shared academic normalization for local schedule and agenda routing. */
export function normalizeAcademicText(input: string): string {
  return normalize(input);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phrasePattern(phrase: string): RegExp {
  const normalized = normalize(phrase);
  const base = normalized.startsWith("ال") ? normalized.slice(2) : normalized;
  return new RegExp(`(?:^|\\s)(?:(?:و|ب|ل)?(?:ال)?|و?لل)${escapeRegex(base)}(?=$|\\s)`, "u");
}

function has(text: string, phrase: string): boolean {
  return phrasePattern(phrase).test(text);
}

function hasExact(text: string, phrase: string): boolean {
  const normalized = normalize(phrase);
  const exact = normalized.startsWith("ال")
    ? `(?:(?:و|ب|ل)?${escapeRegex(normalized)}|و?لل${escapeRegex(normalized.slice(2))})`
    : `(?:و|ب|ل)?${escapeRegex(normalized)}`;
  return new RegExp(`(?:^|\\s)${exact}(?=$|\\s)`, "u").test(text);
}

function matchedIds<T extends string>(text: string, aliases: Record<T, readonly string[]>): T[] {
  return (Object.keys(aliases) as T[]).filter((id) => aliases[id].some((alias) => has(text, alias)));
}

const WEEKDAY_ALIASES = [
  ["الأحد", "احد"],
  ["الاثنين", "الإثنين", "اثنين"],
  ["الثلاثاء", "الثلاثا", "ثلاثاء", "ثلاثا"],
  ["الأربعاء", "الاربعا", "اربعاء", "اربعا"],
  ["الخميس", "خميس"],
  ["الجمعة", "جمعه"],
  ["السبت", "سبت"],
] as const;

const TOMORROW = ["باجر", "باجرر", "باچر", "بكرا", "بكرة", "بكرى", "باكر", "غدا", "غد", "الغد"];
const TODAY = ["اليوم", "هاليوم"];
const WEEK = ["الأسبوع", "الاسبوعي", "كل الاسبوع", "الاسبوع كله", "كل الايام", "جدول كامل", "جدولنا كامل"];
const LABS_ONLY = ["مختبرات", "لابات"];
const LAB_LABELS = "مختبرات|المختبرات|لابات|اللابات|مختبر|المختبر|لاب|lab";
const NEXT = ["الجاية", "الجاي", "القادمة", "القادم", "التالية", "التالي", "المقبلة", "المقبل", "اللي تجي", "الي تجي", "اللي جايه", "الي جايه", "التي تليها", "اللي بعدها", "الي بعدها"];
const CURRENT = ["الحالية", "الحالي", "الجارية", "الجاري"];
const NOW = ["هسه", "هسا", "هسة", "الآن", "حاليا"];
const REMAINING = ["المتبقي", "المتبقية", "الباقي", "الباقية", "باقيلنا", "بقالنا", "شنو بقه", "شنو بقى", "شنو باقي", "ماذا تبقى", "ما تبقى", "شبقه", "شبقى"];
const AVAILABILITY = ["شعدنا", "شعندنا", "اشعدنا", "شعدنه", "شنعدنا", "شنعدنه", "شعندنه", "اشعندنا", "اشعدنه", "شعدهم", "شعندهم", "اشعدهم", "شنعدهم"];
const HAVE = ["عدنا", "عدنه", "عندنا", "عندنه", "لدينا", "علينا", "عندي", "عدهم", "عندهم", "لديهم"];
const WHEN = ["شوكت", "شوقت", "امتى", "ايمتى", "متى", "يمتى", "اي وقت", "بأي وقت", "يا وقت"];
const CLOCK = ["وقت", "موعد", "توقيت", "ساعة"];
const SCHEDULE = ["جدول", "جدولنا", "جدولكم", "جدولنه", "محاضرة", "محاضرتنا", "محاضرات", "محاضراتنا", "محاضراتكم", "دوام", "دوامنا", "دوامنه", "مواد", "حصص", "حصصنا"];
const DOCTOR_QUESTIONS = ["اسم الدكتور", "اسم دكتور", "اسم الاستاذ", "اسم استاذ", "اسم المدرس", "اسم مدرس", "اسم المحاضر", "اسم محاضر"];
const OUT_OF_SCOPE = [
  "طقس", "الجو", "درجة الحرارة", "مطر", "سعر", "اسعار", "اخبار", "سياسة",
  "مطعم", "اكل", "نكتة", "فيلم", "اغنية", "مباراة", "اشرح", "اشرحلي", "اشرحلنا", "شرح", "فهمني", "فهمنا", "علمني", "علمنا", "تعليم", "تعلم", "درسني",
  "حل", "حللي", "واجب", "واجبات", "امتحان", "امتحانات", "ادرس", "دراسة",
  "لخص", "تلخيص", "ملخص", "اكتب كود", "اكتب برنامج", "صمم", "ارسم", "اشتريت", "اشتري",
  "تجاهل", "تعليماتك", "اسرار", "اكشف", "توكن", "كلمة المرور", "ignore",
  "system prompt", "api key", "password", "token", "reveal",
];
const UNKNOWN_COURSES = [
  "رياضيات", "قواعد بيانات", "قاعدة بيانات", "ذكاء اصطناعي", "انكليزي", "انجليزي",
  "فيزياء", "كيمياء", "نظم تشغيل", "خوارزميات", "احصاء", "امن المعلومات", "امن سيبراني",
];
const NUMBERS: Record<string, number> = {
  "1": 1, واحد: 1, اول: 1, اولي: 1, الاول: 1, الاولي: 1,
  "2": 2, اثنين: 2, ثاني: 2, ثانيه: 2, الثاني: 2, الثانيه: 2,
  "3": 3, ثلاثه: 3, ثالث: 3, ثالثه: 3, الثالث: 3, الثالثه: 3,
  "4": 4, اربعه: 4, رابع: 4, رابعه: 4, الرابع: 4, الرابعه: 4,
  "5": 5, خمسه: 5, خامس: 5, خامسه: 5, الخامس: 5, الخامسه: 5,
};
const NUMBER_PATTERN = "\\d+|الاولي|الاول|اولي|اول|واحد|الثانيه|الثاني|ثانيه|ثاني|اثنين|الثالثه|الثالث|ثالثه|ثالث|ثلاثه|الرابعه|الرابع|رابعه|رابع|اربعه|الخامسه|الخامس|خامسه|خامس|خمسه";
const GROUP_ALIASES: Record<string, "A" | "B"> = { a: "A", ا: "A", اي: "A", ايه: "A", b: "B", ب: "B", بي: "B", بيه: "B" };
const GROUP_PATTERN = "ايه|اي|بيه|بي|[abاب]";

export interface NluLiteralHints {
  day: NluDay;
  weekday: number | null;
  temporalIntent: "next" | "current" | "remaining" | null;
  conflictingDays: boolean;
  conflictingTemporalIntents: boolean;
}

function availabilityCue(text: string): boolean {
  return AVAILABILITY.some(phrase => hasExact(text, phrase))
    || (["شنو", "شو", "ماذا", "ما", "هل"].some(phrase => hasExact(text, phrase))
      && HAVE.some(phrase => hasExact(text, phrase)))
    || ["ماذا سندرس", "ماذا ندرس", "ما سندرس", "شنو راح ناخذ", "شنو راح ندرس"].some(phrase => hasExact(text, phrase));
}

function courseTimeCue(text: string): boolean {
  return WHEN.some(phrase => hasExact(text, phrase)) || CLOCK.some(phrase => has(text, phrase));
}

function availabilityHasUnknownTail(residue: string): boolean {
  const allowed = [
    ...AVAILABILITY, ...HAVE, ...WHEN, ...CLOCK, ...SCHEDULE, ...TODAY, ...NEXT, ...CURRENT, ...NOW, ...REMAINING,
    "شنو", "شو", "ماذا", "ما", "هل", "منو", "من", "اي", "كم", "وين", "مادة", "المادة", "يوم", "في", "عند", "عن", "من", "على", "لنا", "لهم", "و", "او", "اللي", "الي", "التي", "الذي",
    "الدكتور", "دكتور", "الدكتورة", "دكتورة", "الاستاذ", "استاذ", "الاستاذة", "استاذة", "مبرمج", "مبرمجة", "م م", "د", "اسم", "مالته", "مالتها", "مالتهم",
    "سندرس", "ندرس", "ناخذ", "نأخذ", "راح", "رح", "تبدأ", "يبدأ", "تبدي", "يبدي", "تبتدي", "تكون", "يكون",
    "اعرض", "اريد", "اطيني", "عطني", "هات", "طلعلي", "جيبلي", "اخبرني", "قل لي",
    "دعبول", "يا", "حبيبي", "هلا", "رجاء", "رجاءا", "ممكن", "لو سمحت", "لو سمحتي", "لوسمحت", "please", "شكرا", "شباب", "بالله", "عفية", "حباب", "يابه", "زين", "صديقي",
    "للكل", "الكل", "الجميع", "لكل المجموعات", "للمجموعتين", "كل المجموعات", "المجموعتين", "للجميع", "كلنا", "للمرحلة كلها", "المرحلة الثالثة", "مرحلتنا",
  ].sort((left, right) => right.length - left.length);
  for (const phrase of allowed) residue = residue.replace(new RegExp(phrasePattern(phrase).source, "gu"), " ");
  residue = residue.replace(new RegExp(`(?:^|\\s)(?:${NUMBER_PATTERN})\\s+(?:المحاضره|محاضره|الحصه|حصه)(?=$|\\s)`, "gu"), " ")
    .replace(/(?:^|\s)(?:و)?باجر+(?=$|\s)/gu, " ");
  return residue.trim().length > 0;
}

function literalHints(text: string): NluLiteralHints {
  const days: { day: NluDay; weekday: number | null }[] = [];
  const week = parseWeekRange(text);
  const withoutWeek = removeWeekSelectors(text);
  if (week.range) days.push({ day: week.range.label, weekday: null });
  // Numeric lab/lecture selections must not turn the word اثنين into Monday.
  // Bare يوم in "أي يوم" / "يوم الثلاثاء" must not turn into اليوم either.
  const dayText = withoutWeek.replace(new RegExp(`(?:^|\\s)(?:و|ب|ل)?(?:${LAB_LABELS}|محاضره|المحاضره|حصه|الحصه)\\s*(?:رقم\\s*)?(?:${NUMBER_PATTERN})(?=$|\\s)`, "gu"), " ");
  if (TODAY.some((alias) => hasExact(dayText, alias))) days.push({ day: "today", weekday: null });
  if (TOMORROW.some((alias) => has(dayText, alias)) || /(?:^|\s)(?:و)?باجر+(?=$|\s)/u.test(dayText)) {
    days.push({ day: "tomorrow", weekday: null });
  }
  WEEKDAY_ALIASES.forEach((aliases, weekday) => {
    if (aliases.some((alias) => has(dayText, alias))) days.push({ day: "weekday", weekday });
  });
  if (WEEK.some((alias) => has(dayText, alias))) days.push({ day: "week", weekday: null });
  // A modifier of an explicit weekday selects that calendar day. It is not
  // a request for only the next lecture on that day.
  const weekdayBases = [...new Set(WEEKDAY_ALIASES.flat().map(alias => normalize(alias).replace(/^ال/u, "")))].map(escapeRegex).join("|");
  const temporalText = withoutWeek.replace(new RegExp(`((?:^|\\s)(?:(?:و|ب|ل)?(?:ال)?|و?لل)(?:${weekdayBases}))\\s+(?:(?:اللي|الي)\\s+)?(?:ال)?(?:جاي|جايه|قادم|قادمه|تالي|تاليه|مقبل|مقبله)(?=$|\\s)`, "gu"), "$1");
  const wantsNext = NEXT.some((phrase) => has(temporalText, phrase));
  const wantsRemaining = REMAINING.some((phrase) => has(temporalText, phrase));
  const wantsCurrent = CURRENT.some((phrase) => has(temporalText, phrase));
  const saysNow = NOW.some((phrase) => hasExact(temporalText, phrase));
  const unsupportedDay = /(?:^|\s)(?:و)?بعد\s+(?:باجر+|بكرا|بكره|غد|غدا|يومين|ثلاثه\s+ايام)(?=$|\s)|(?:^|\s)وبعده(?=$|\s)/u.test(text)
    || ["امس", "البارحة", "اول امس", "قبل امس"].some(phrase => hasExact(text, phrase))
    || /(?:^|\s)(?:\d{4}\s+\d{1,2}\s+\d{1,2}|\d{1,2}\s+\d{1,2}\s+\d{4})(?=$|\s)/u.test(text);
  return {
    day: days[0]?.day ?? "unspecified",
    weekday: days[0]?.weekday ?? null,
    temporalIntent: wantsNext ? "next" : wantsRemaining ? "remaining" : wantsCurrent || saysNow ? "current"
      : days.length === 0 && matchedIds<CourseId>(text, COURSE_ALIASES).length === 1 && courseTimeCue(text) ? "next" : null,
    conflictingDays: days.length > 1 || unsupportedDay || week.conflicting || (week.matched && !week.range),
    conflictingTemporalIntents: Number(wantsNext) + Number(wantsRemaining) + Number(wantsCurrent) > 1,
  };
}

/** Literal constraints shared by local routing and grounded AI classification. */
export function getLiteralNluHints(input: string): NluLiteralHints {
  return literalHints(normalize(input));
}

/** Entity IDs are grounded only in explicit aliases, including article prefixes. */
export function getLiteralNluEntities(input: string): { courses: CourseId[]; teachers: TeacherId[] } {
  const text = normalize(input);
  return { courses: matchedIds<CourseId>(text, COURSE_ALIASES), teachers: matchedIds<TeacherId>(text, TEACHER_ALIASES) };
}

function clearlyMissingScheduleDay(text: string): boolean {
  const request = text
    .replace(/(?:^|\s)(?:دعبول|حبيبي|رجاء|ممكن|please)(?=$|\s)/gu, " ")
    .replace(/(?:^|\s)لو سمحت(?=$|\s)/gu, " ").replace(/\s+/g, " ").trim();
  return availabilityCue(request) || /^(?:(?:(?:اعرض|اريد|عطني|هات|اطيني|طلعلي|جيبلي|شنو|ما هو) )?(?:ال)?(?:جدول(?:نا|كم|نه)?|محاضرات(?:نا|كم)?|دوام(?:نا|نه)?|مواد(?:نا)?))$/u.test(request);
}

function numericFilters(text: string, labels: string, reversed = false): number[] {
  const expression = reversed
    ? `(?:^|\\s)(?:و)?(${NUMBER_PATTERN})\\s+(?:${labels})(?=$|\\s)`
    : `(?:^|\\s)(?:و|ب|ل)?(?:${labels})\\s*(?:رقم\\s*)?(${NUMBER_PATTERN})(?=$|\\s)`;
  return [...text.matchAll(new RegExp(expression, "gu"))]
    .filter((match) => !reversed || !new RegExp(`(?:${LAB_LABELS})(?:\\s+رقم)?$`, "u").test(text.slice(0, match.index).trim()))
    .map((match) => NUMBERS[match[1]!] ?? Number(match[1]));
}

function aliasAtStart(text: string, aliases: readonly string[]): boolean {
  return aliases.some(alias => phrasePattern(alias).exec(text)?.index === 0);
}

function unknownNamedSelection(text: string, labels: string, aliases: readonly string[], safe: readonly string[]): boolean {
  const selections = new RegExp(`(?:^|\\s)(?:و|ب|ل)?(?:${labels})\\s+(\\S+)`, "gu");
  let match: RegExpExecArray | null;
  while ((match = selections.exec(text)) !== null) {
    const word = match[1]!;
    const tailStart = match.index + match[0].length - word.length;
    const tail = text.slice(tailStart);
    if (!aliasAtStart(tail, aliases) && !safe.some(alias => has(word, alias))) return true;
    // Revisit a nested label such as محاضرة مادة الكيمياء or دكتور الدكتور.
    selections.lastIndex = tailStart - 1;
  }
  return false;
}

function knownTeacherWithUnknownSurname(text: string, id: TeacherId): boolean {
  const aliases = TEACHER_ALIASES[id].map(normalize);
  const firstNames = [...new Set(aliases.map((alias) => alias.split(" ")[0]!))];
  const safeNext = new Set([
    "شنو", "ماذا", "شوكت", "شوقت", "متي", "امتي", "ايمتي", "وين", "منو", "من", "اي", "يوم", "عدنا", "عندنا", "عنده", "عندها", "لدينا", "موعد", "وقت", "ساعه", "مادته", "مادتها",
    "يدرس", "يدرسنا", "يدرسون", "تدرس", "تدرسنا", "محاضره", "محاضرته", "محاضرات", "محاضراته",
    "محاضراتها", "جدول", "جدوله", "جدولها", "دوام", "دوامه", "الماده", "ماده", "و", "او", "في",
    "ويانه", "ويانا", "باي", "لعد", "حبيبي", "لو", "موجود", "موجوده", "رجاء", "رجاءا", "شكرا", "دعبول",
  ]);
  for (const firstName of firstNames) {
    for (const match of text.matchAll(new RegExp(`(?:^|\\s)(?:و)?${escapeRegex(firstName)}(?=$|\\s)`, "gu"))) {
      let tail = text.slice(match.index! + match[0].length).trimStart();
      const suffix = aliases.filter(alias => alias.startsWith(`${firstName} `))
        .map(alias => alias.slice(firstName.length).trim()).sort((left, right) => right.length - left.length)
        .find(value => tail === value || tail.startsWith(`${value} `));
      if (suffix) tail = tail.slice(suffix.length).trimStart();
      const next = tail.split(" ")[0];
      if (!next || [...safeNext, ...TODAY, ...TOMORROW, ...WEEK, ...WEEKDAY_ALIASES.flat(), ...NEXT, ...CURRENT, ...NOW, ...REMAINING, ...LABS_ONLY,
        "نظري", "عملي", "تمارين", "مختبر", "المختبر", "مجموعه", "مجوعه", "كروب",
        ...Object.values(COURSE_ALIASES).flat(), ...Object.values(TEACHER_ALIASES).flat(),
      ].some((alias) => has(next, alias))) continue;
      // A different full name must not become an official lecturer merely
      // because its first name or two-name prefix matches.
      return true;
    }
  }
  return false;
}

/** Returns null only when a bounded AI classifier may help resolve ambiguity. */
export function classifyLocal(input: string): NluResult | null {
  const text = normalize(input);
  if (!text) return emptyResult();
  if (OUT_OF_SCOPE.some((phrase) => has(text, phrase))) return emptyResult("out_of_scope");
  if (UNKNOWN_COURSES.some((phrase) => has(text, phrase))) return emptyResult();
  if (AVAILABILITY.some(phrase => new RegExp(`(?:^|\\s)${escapeRegex(normalize(phrase))}[a-z]+(?=$|\\s)`, "u").test(text))) return emptyResult();
  if (/(?:^|\s)(?:احد|واحد)\s+(?:الاساتذه|التدريسيين)(?=$|\s)/u.test(text)) return emptyResult();
  // Incidental academic words in a personal statement do not make it a query.
  if (/^(?:انا|اني|نحن|احنا|عندي|شفت|شفنا|حضرت|لدينا)(?=$|\s)/u.test(text)
    && !availabilityCue(text)
    && !/(?:^|\s)(?:شنو|شو|ماذا|ما|شوكت|شوقت|متي|امتي|ايمتي|منو|من|اي|كم|هل|اعرض|اريد|اطيني|عطني|هات|اخبرني|ممكن)(?=$|\s)/u.test(text)) return null;

  const hints = literalHints(text);
  if (hints.conflictingDays) return emptyResult();
  const days = hints.day === "unspecified" ? [] : [{ day: hints.day, weekday: hints.weekday }];

  const courses = matchedIds<CourseId>(text, COURSE_ALIASES);
  const teachers = matchedIds<TeacherId>(text, TEACHER_ALIASES);
  if (courses.length > 1 || teachers.length > 1) return emptyResult();
  if (teachers[0] && knownTeacherWithUnknownSurname(text, teachers[0])) return emptyResult();

  const groupLabel = "(?:مجموعتنا|المجموعه|مجموعه|مجوعتنا|المجوعه|مجوعه|كروبنا|الكروب|كروب|قروبنا|القروب|قروب|جروب|group)";
  const groups = new Set<"A" | "B">();
  const explicitGroups = [...text.matchAll(new RegExp(`(?:^|\\s)(?:و|ب|لل|ل)?${groupLabel}\\s*(?:رقم\\s*)?(\\S+)(?=$|\\s)`, "gu"))];
  for (const match of explicitGroups) {
    const group = match[1]!;
    if (Object.hasOwn(GROUP_ALIASES, group)) groups.add(GROUP_ALIASES[group]!);
    else if (/^[a-z\p{Script=Arabic}\d]$/u.test(group) || ["سي", "جيم", "دي", "دال"].includes(group)) return emptyResult();
    else return null;
  }
  if (explicitGroups.length > 0) {
    for (const match of text.matchAll(/(?:^|\s)(?:و)?([ab])(?=$|\s)/gu)) groups.add(match[1]!.toUpperCase() as "A" | "B");
    if (/(?:^|\s)(?:او|و)\s*ب(?=$|\s)/u.test(text)) groups.add("B");
    if (/(?:^|\s)(?:او|و)\s*ا(?=$|\s)/u.test(text)) groups.add("A");
    for (const match of text.matchAll(new RegExp(`(?:^|\\s)(?:و\\s*|او\\s+)(${GROUP_PATTERN})(?=$|\\s)`, "gu"))) {
      groups.add(GROUP_ALIASES[match[1]!]!);
    }
  }
  // A/B can stand alone beside an academic selection, but Arabic ب/ا need
  // a group label because they also serve as ordinary particles.
  const academicContext = courses.length > 0 || teachers.length > 0
    || SCHEDULE.some(phrase => has(text, phrase)) || availabilityCue(text)
    || LABS_ONLY.some(phrase => has(text, phrase));
  if (academicContext) {
    for (const match of text.matchAll(/(?:^|\s)(?:و)?([a-z])(?=$|\s)/gu)) {
      const group = match[1]!;
      if (group === "a" || group === "b") groups.add(group.toUpperCase() as "A" | "B");
      else return emptyResult();
    }
    // Exclusions cannot be represented by one positive AND filter.
    if (/(?:^|\s)(?:مو|مش|ليس|غير|عدا|باستثناء|بدون)(?=$|\s)/u.test(text)) return emptyResult();
  }

  const labsOnly = LABS_ONLY.some((alias) => has(text, alias));
  const labs = new Set(numericFilters(text, LAB_LABELS));
  const slots = new Set([
    ...numericFilters(text, "محاضره|المحاضره|حصه|الحصه"),
    ...numericFilters(text, "محاضره|المحاضره|حصه|الحصه", true),
  ]);
  const coordinatedNumbers = [...text.matchAll(new RegExp(`(?:^|\\s)(?:و\\s*|او\\s+)(${NUMBER_PATTERN})(?=$|\\s)`, "gu"))]
    .map((match) => NUMBERS[match[1]!] ?? Number(match[1]));
  if (coordinatedNumbers.length && labs.size && slots.size) return emptyResult();
  for (const number of coordinatedNumbers) {
    if (slots.size) slots.add(number);
    else if (labs.size) labs.add(number);
  }
  if (new RegExp(`(?:^|\\s)(?:و|ب|ل)?(?:${LAB_LABELS}|محاضره|المحاضره|حصه|الحصه)\\s+(?:سته|ست|سادس|السادس|سابعه|السابع|سبعه|ثمانيه|تسعه|عشره)(?=$|\\s)`, "u").test(text)) return emptyResult();
  const kinds = new Set<NluResult["kind"]>();
  if (["نظري", "نظريه"].some((alias) => has(text, alias))) kinds.add("theory");
  if (["عملي", "عمليه"].some((alias) => has(text, alias))) kinds.add("practical");
  if (has(text, "تمارين")) kinds.add("exercises");
  if (groups.size > 1 || labs.size > 1 || slots.size > 1 || kinds.size > 1
    || [...labs].some((number) => ![1, 2, 3].includes(number))
    || [...slots].some((number) => ![1, 2, 3, 4, 5].includes(number))) return emptyResult();

  // Check every explicit subject/person label, even when another known alias
  // is elsewhere in the sentence. A known name cannot hide an unknown one.
  const safeSelectors = [...TODAY, ...TOMORROW, ...WEEK, ...WEEKDAY_ALIASES.flat(), ...NEXT, ...CURRENT, ...NOW, ...REMAINING,
    ...Object.keys(NUMBERS), ...WHEN, ...CLOCK, ...HAVE,
    "شنو", "ماذا", "ما", "منو", "من", "اي", "كم", "وين", "هاي", "هذي", "هذا", "اللي", "الي", "التي", "الذي", "مال", "مالت", "تبع", "بتاع", "يوم", "رقم", "كل", "و", "واسم",
  ];
  if (unknownNamedSelection(text, "الماده|ماده|المحاضره|محاضره|محاضرات|المحاضرات", Object.values(COURSE_ALIASES).flat(), [
    ...safeSelectors, ...LABS_ONLY, "مادة", "المادة", "نظري", "عملي", "تمارين", "دكتور", "الدكتور", "دكتوره", "الدكتوره", "استاذ", "الاستاذ", "استاذه", "الاستاذه", "مبرمج", "مبرمجه", "د", "م", "مجموعه", "المجموعه", "مجوعه", "كروب", "جروب", "group", ...Object.values(TEACHER_ALIASES).flat(),
  ])) return emptyResult();
  if (unknownNamedSelection(text, "م\\s+م|دكتور|الدكتور|دكتوره|الدكتوره|استاذ|الاستاذ|استاذه|الاستاذه|مبرمج|مبرمجه|د", [...Object.values(TEACHER_ALIASES).flat(), ...Object.values(COURSE_ALIASES).flat()], [
    ...safeSelectors, "مالت", "مالته", "مالتها", "الماده", "ماده", "المحاضره", "محاضره", "المحاضرات", "محاضرات", "يدرس", "يدرسنا", "تدرس", "تدرسنا", "المسؤول", ...Object.values(COURSE_ALIASES).flat(),
  ])) return emptyResult();

  const result = emptyResult();
  result.day = days[0]?.day ?? "unspecified";
  result.weekday = days[0]?.weekday ?? null;
  result.course = courses[0] ?? null;
  result.teacher = teachers[0] ?? null;
  result.group = [...groups][0] ?? null;
  result.lab = ([...labs][0] as 1 | 2 | 3 | undefined) ?? null;
  result.labsOnly = labsOnly;
  result.slot = ([...slots][0] as 1 | 2 | 3 | 4 | 5 | undefined) ?? null;
  result.kind = [...kinds][0] ?? null;

  const hasFilter = [result.course, result.teacher, result.group, result.lab, result.slot, result.kind].some((value) => value !== null) || result.labsOnly;
  const queryCue = /(?:^|\s)(?:و)?(?:شنو|ماذا|شوكت|شوقت|امتي|ايمتي|متي|يمتي|وين|منو|من|اي|كم|هل|عدنا|عندنا|لدينا)(?=$|\s)/u.test(text)
    || availabilityCue(text) || courseTimeCue(text) || DOCTOR_QUESTIONS.some(phrase => has(text, phrase))
    || hasExact(text, "اعرض")
    || ((result.labsOnly || result.lab !== null || result.slot !== null || result.kind !== null)
      && ["اريد", "اطيني", "عطني", "هات", "طلعلي", "جيبلي"].some(phrase => hasExact(text, phrase)));
  const scheduleCue = SCHEDULE.some((phrase) => has(text, phrase)) || availabilityCue(text);
  const pureAlias = [...Object.values(COURSE_ALIASES).flat(), ...Object.values(TEACHER_ALIASES).flat(),
    ...TODAY, ...TOMORROW, ...WEEKDAY_ALIASES.flat(), ...WEEK, ...LABS_ONLY,
  ].some((alias) => normalize(alias) === text);
  const pureFilter = /^(?:(?:م\s+م|دكتور|دكتوره|استاذ|استاذه|مبرمج|مبرمجه|د)\s+\S+(?:\s+\S+)?|(?:مجموعه|كروب|جروب|group)\s*[abاب]|(?:مختبر|لاب|lab)\s*[123]|(?:المحاضره|محاضره)\s+\S+|(?:ال)?(?:نظري|عملي|تمارين))$/u.test(text);
  let residue = removeWeekSelectors(text)
    .replace(new RegExp(`(?:^|\\s)(?:و|ب|لل|ل)?${groupLabel}\\s*(?:${GROUP_PATTERN})(?=$|\\s)`, "gu"), " ")
    .replace(new RegExp(`(?:^|\\s)(?:و|ب|ل)?(?:${LAB_LABELS}|محاضره|المحاضره|حصه|الحصه)\\s*(?:رقم\\s*)?(?:${NUMBER_PATTERN})(?=$|\\s)`, "gu"), " ");
  const knownPhrases = [...Object.values(COURSE_ALIASES).flat(), ...Object.values(TEACHER_ALIASES).flat(),
    ...TOMORROW, ...WEEKDAY_ALIASES.flat(), ...WEEK, ...LABS_ONLY, "نظري", "نظريه", "عملي", "عمليه", "تمارين",
  ].sort((left, right) => right.length - left.length);
  for (const phrase of knownPhrases) residue = residue.replace(new RegExp(phrasePattern(phrase).source, "gu"), " ");
  for (const phrase of TODAY) residue = residue.replace(new RegExp(`(?:^|\\s)${escapeRegex(normalize(phrase))}(?=$|\\s)`, "gu"), " ");
  residue = residue
    .replace(new RegExp(`(?:^|\\s)(?:و|ب|لل|ل)?${groupLabel}\\s*(?:${GROUP_PATTERN})(?=$|\\s)`, "gu"), " ")
    .replace(new RegExp(`(?:^|\\s)(?:و|ب|ل)?(?:${LAB_LABELS}|محاضره|المحاضره|حصه|الحصه)\\s*(?:رقم\\s*)?(?:${NUMBER_PATTERN})(?=$|\\s)`, "gu"), " ")
    .replace(/(?:^|\s)(?:م\s+م|الدكتور|دكتور|دكتوره|استاذ|استاذه|مبرمج|مبرمجه|د|الماده|ماده|يوم|و|الجدول|جدول)(?=$|\s)/gu, " ")
    .trim();
  if (academicContext) residue = residue.replace(/(?:^|\s)(?:و)?[ab](?=$|\s)/gu, " ").trim();
  if (availabilityCue(text) && availabilityHasUnknownTail(residue)) return emptyResult();
  const pureCompound = residue === "" && (hasFilter || days.length > 0);

  const pureTemporal = [...NEXT, ...CURRENT, ...NOW, ...REMAINING].some((phrase) => normalize(phrase) === text);
  const strongRemaining = ["شنو بقه", "شنو بقى", "شنو باقي", "شبقه", "شبقى"].some((phrase) => has(text, phrase));
  const temporalContext = scheduleCue || hasFilter || pureTemporal || strongRemaining
    || ["المادة", "مواد", "الحصة", "حصص"].some((phrase) => has(text, phrase));
  if (!scheduleCue && !hasFilter && /(?:^|\s)(?:دكتورها|دكتورهم|مدرسها|استاذها|اللي بعدها|الي بعدها)(?=$|\s)/u.test(text)) return emptyResult();
  if (temporalContext && hints.temporalIntent) {
    // هسه can qualify a next/remaining request. An explicit الحالية combined
    // with الجاية / المتبقي is a conflicting selection, so ask for clarity.
    if (hints.conflictingTemporalIntents) return emptyResult();
    const intent = hints.temporalIntent;
    if (result.day === "week" || (intent === "next" && result.day === "last_week") || (intent !== "next" && !["unspecified", "today", "weekday"].includes(result.day))) return emptyResult();
    result.intent = intent;
    result.confidence = 0.99;
    return result;
  }


  if (hasFilter && (queryCue || scheduleCue || pureAlias || pureFilter || pureCompound)) {
    result.intent = "lookup";
    result.confidence = 0.99;
    return result;
  }
  if (!hasFilter && (scheduleCue || pureAlias || pureCompound)) {
    if (result.day === "unspecified") return clearlyMissingScheduleDay(text) ? emptyResult() : null;
    result.intent = "schedule";
    result.confidence = 0.99;
    return result;
  }
  return null;
}
