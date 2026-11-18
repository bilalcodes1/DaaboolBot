export const COURSE_ALIASES = {
  architecture: ["معمارية الحاسبة", "معمارية الحاسوب", "معمارية", "معماريه", "architecture"],
  mobile: ["برمجة تطبيقات الموبايل", "تطبيقات الموبايل", "برمجة الموبايل", "تطبيقات الجوال", "تطبيق الجوال", "برمجة الجوال", "الجوال", "موبايل", "الموبايل", "mobile"],
  networks: ["شبكات الحاسبة", "شبكات الحاسوب", "شبكات", "الشبكات", "networks"],
  visual: ["البرمجة المرئية", "برمجة مرئية", "المرئية", "مرئية", "مرئيه", "visual"],
  compilers: ["المترجمات", "مترجمات", "compilers"],
  graphics: ["رسومات الحاسبة", "رسومات الحاسوب", "الرسم بالحاسوب", "الرسم بالحاسبة", "رسم الحاسوب", "رسم الحاسبة", "الرسومات", "رسومات", "الرسوميات", "رسوميات", "graphics"],
} as const;

export const TEACHER_ALIASES = {
  mustafa: ["مصطفى معد", "مصطفى"],
  ahmed: ["أحمد صبحي", "احمد صبحي", "أحمد", "احمد"],
  khubaib: ["خبيب باسم", "خبيب"],
  fouad: ["فؤاد سليم", "فؤاد", "فواد"],
  saad: ["سعد عدنان", "سعد"],
  hiba: ["هبة", "هبه"],
  shumous: ["شموس"],
  sura: ["سرى", "سري"],
  issam: ["عصام طه", "عصام"],
  bilal: ["بلال فواز", "بلال"],
  ruqayya: ["رقية إياد", "رقية اياد", "رقية", "رقيه"],
} as const;

export type CourseId = keyof typeof COURSE_ALIASES;
export type TeacherId = keyof typeof TEACHER_ALIASES;
export type NluIntent = "schedule" | "lookup" | "next" | "current" | "remaining" | "out_of_scope" | "clarify";
export type NluDay = "today" | "tomorrow" | "weekday" | "week" | "current_week" | "next_week" | "last_week" | "unspecified";

export interface NluResult {
  intent: NluIntent;
  day: NluDay;
  weekday: number | null;
  course: CourseId | null;
  teacher: TeacherId | null;
  group: "A" | "B" | null;
  lab: 1 | 2 | 3 | null;
  labsOnly: boolean;
  slot: 1 | 2 | 3 | 4 | 5 | null;
  kind: "theory" | "practical" | "exercises" | null;
  confidence: number;
}

export function emptyResult(intent: NluIntent = "clarify"): NluResult {
  return {
    intent,
    day: "unspecified",
    weekday: null,
    course: null,
    teacher: null,
    group: null,
    lab: null,
    labsOnly: false,
    slot: null,
    kind: null,
    confidence: 1,
  };
}

const KEYS = ["intent", "day", "weekday", "course", "teacher", "group", "lab", "labsOnly", "slot", "kind", "confidence"] as const;
const INTENTS = ["schedule", "lookup", "next", "current", "remaining", "out_of_scope", "clarify"];
const DAYS = ["today", "tomorrow", "weekday", "week", "current_week", "next_week", "last_week", "unspecified"];

/** AI output may select known filters, but can never introduce timetable facts. */
export function validateNlu(value: unknown): NluResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Reflect.ownKeys(candidate).length !== KEYS.length
    || !KEYS.every((key) => Object.prototype.hasOwnProperty.call(candidate, key))) return null;
  if (Object.values(Object.getOwnPropertyDescriptors(candidate)).some((property) => !Object.hasOwn(property, "value"))) return null;
  if (typeof candidate.intent !== "string" || !INTENTS.includes(candidate.intent)
    || typeof candidate.day !== "string" || !DAYS.includes(candidate.day)) return null;
  if (candidate.weekday !== null && (!Number.isInteger(candidate.weekday)
    || (candidate.weekday as number) < 0 || (candidate.weekday as number) > 6)) return null;
  if ((candidate.day === "weekday") !== (candidate.weekday !== null)) return null;
  if (candidate.course !== null && (typeof candidate.course !== "string"
    || !Object.prototype.hasOwnProperty.call(COURSE_ALIASES, candidate.course))) return null;
  if (candidate.teacher !== null && (typeof candidate.teacher !== "string"
    || !Object.prototype.hasOwnProperty.call(TEACHER_ALIASES, candidate.teacher))) return null;
  if (candidate.group !== null && candidate.group !== "A" && candidate.group !== "B") return null;
  if (candidate.lab !== null && ![1, 2, 3].includes(candidate.lab as number)) return null;
  if (typeof candidate.labsOnly !== "boolean") return null;
  if (candidate.slot !== null && ![1, 2, 3, 4, 5].includes(candidate.slot as number)) return null;
  if (candidate.kind !== null && !["theory", "practical", "exercises"].includes(candidate.kind as string)) return null;
  if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence)
    || candidate.confidence < 0 || candidate.confidence > 1) return null;
  const hasFilter = [candidate.course, candidate.teacher, candidate.group,
    candidate.lab, candidate.slot, candidate.kind].some((filter) => filter !== null) || candidate.labsOnly;
  if ((candidate.intent === "clarify" || candidate.intent === "out_of_scope")
    && (candidate.day !== "unspecified" || hasFilter)) return null;
  if (candidate.intent === "schedule" && candidate.day === "unspecified") return null;
  if (candidate.intent === "lookup" && !hasFilter) return null;
  if (["next", "current", "remaining"].includes(candidate.intent) && candidate.day === "week") return null;
  if (["current", "remaining"].includes(candidate.intent) && ["current_week", "next_week", "last_week"].includes(candidate.day as string)) return null;
  if (candidate.intent === "next" && candidate.day === "last_week") return null;

  // Copy only validated fields, rather than forwarding the untrusted object.
  return Object.fromEntries(KEYS.map((key) => [key, candidate[key]])) as unknown as NluResult;
}
