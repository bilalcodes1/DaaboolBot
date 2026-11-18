import { getBaghdadNow } from './calendar';
import { extractEventQuery, type EventQueryExtraction } from './event-extract';
import { classifyLocal, getLiteralNluHints, normalizeAcademicText } from './nlu-local';
import type { NluResult } from './nlu-schema';
import { stripWakeWord } from './personality';
import { renderQuery, type RenderedQuery } from './query';

export interface AgendaQuestion {
  scope: 'upcoming' | 'dated';
  query: EventQueryExtraction;
  schedule: NluResult | null;
}

function normalize(text: string): string {
  return normalizeAcademicText(stripWakeWord(text) ?? text);
}

const AVAILABILITY = /(?:^|\s)(?:شعدنا|شعدنه|شعندنا|اشعدنا|اشعندنا|شنعدنا|شعدهم|شعندهم|اشعدهم|شنعدهم|شنو\s+(?:عدنا|عدنه|عندنا|عندي|علينا|لدينا|عدهم|عندهم|لديهم)|ماذا\s+(?:لدينا|عندنا|عندي|لدي|علينا|عندهم|لديهم)|ما\s+(?:لدينا|عندنا|عندي|لدي|علينا|عندهم|لديهم))(?=$|\s)/u;
const EXPLICIT_SUBJECT = /(?:^|\s)(?:و|ب|ل)?(?:ال)?(?:جدول(?:نا)?|محاضره|محاضرات(?:نا)?|حصه|حصص|مختبر(?:ات)?|لاب(?:ات)?|دوام(?:نا)?|مواد(?:نا)?|ماده|دكتور|دكتوره|استاذ|استاذه|تدريسي|تدريسيين|امتحان(?:ات)?|اختبار(?:ات)?|كوز(?:ات)?|كويز(?:ات)?|واجب(?:ات)?|تكليف|تكاليف|تبليغ(?:ات)?|ملاحظات|تذكيرات|ملف(?:ات)?|صور(?:ه)?|مرفق(?:ات)?)(?=$|\s)/u;

/** An unqualified availability question is an agenda, never a contribution. */
export function classifyAgendaQuestion(text: string, now = new Date()): AgendaQuestion | null {
  if (text.length > 320) return null;
  const normalized = normalize(text);
  if (!AVAILABILITY.test(normalized) || EXPLICIT_SUBJECT.test(normalized)) return null;
  const hints = getLiteralNluHints(text);
  if (hints.conflictingDays || hints.conflictingTemporalIntents || hints.temporalIntent !== null) return null;
  const local = classifyLocal(text);
  if (local && ['out_of_scope', 'next', 'current', 'remaining'].includes(local.intent)) return null;
  // A named course, lab, teacher, slot or type is a specific timetable lookup.
  if (local && [local.course, local.teacher, local.lab, local.slot, local.kind].some(value => value !== null) || local?.labsOnly) return null;

  if (hints.day === 'unspecified') {
    // Do not let an unknown tail (e.g. an unfamiliar subject or group) become
    // an unrestricted list of other students' notices.
    let remainder = normalized.replace(AVAILABILITY, ' ')
      .replace(/(?:^|\s)(?:حبيبي|هلا|رجاء|رجاءا|ممكن|لو\s+سمحت|لوسمحت|هسه|هسا)(?=$|\s)/gu, ' ')
      .replace(/(?:^|\s)(?:ل|لل|ب)?(?:ال)?(?:مجموعه|مجوعه|كروب|قروب|جروب|group)\s*(?:a|b|ا|ب|اي|بي|ايه|بيه)(?=$|\s)/gu, ' ')
      .trim();
    if (local?.group) remainder = remainder.replace(/(?:^|\s)[ab](?=$|\s)/gu, ' ').trim();
    if (remainder || (local?.intent === 'clarify' && /(?:مجموعه|مجوعه|كروب|قروب|جروب|group)/u.test(normalized))) return null;
    const query = extractEventQuery(normalized, now);
    if (query.clarification) return null;
    if (query.audience === null && local?.group) query.audience = local.group;
    return { scope: 'upcoming', query, schedule: null };
  }

  if (!local || !['schedule', 'lookup'].includes(local.intent)) return null;
  // In an availability question "the week" refers to this calendar week;
  // the separate explicit "weekly timetable" request keeps its old meaning.
  const queryText = local.day === 'week'
    ? normalized.replace(/(?:الاسبوع|اسبوع)/u, 'هذا الاسبوع') : normalized;
  const query = extractEventQuery(queryText, now);
  if (query.clarification) return null;
  if (query.audience === null && local.group) query.audience = local.group;
  return { scope: 'dated', query, schedule: local.day === 'week' ? { ...local, day: 'current_week' } : local };
}

export function renderAgendaSchedule(agenda: AgendaQuestion, now: Date): RenderedQuery | null {
  if (!agenda.schedule) return null;
  const rendered = renderQuery(agenda.schedule, now);
  if (agenda.schedule.day !== 'weekday' || !agenda.query.date) return rendered;
  // A weekday availability question uses the same actual date as its notices.
  const lines = rendered.text.split('\n');
  lines.splice(1, 0, `📅 ${agenda.query.date}`);
  return { ...rendered, text: lines.join('\n') };
}

/** Shared fixed bounds for approved-notice lookups, including Inline results. */
export function eventLookupDateBounds(query: EventQueryExtraction, now: Date): { date?: string; dateFrom?: string; dateTo?: string } {
  if (query.date) return { date: query.date };
  if (query.dateRange) return { dateFrom: query.dateRange.fromDate, dateTo: query.dateRange.toDate };
  return { dateFrom: getBaghdadNow(now).date };
}
