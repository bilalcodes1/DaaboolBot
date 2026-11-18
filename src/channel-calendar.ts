import { addCalendarDays } from './calendar';

export const CHANNEL_TIMES = { schedule: 960, news: [1020, 1260] as readonly number[], dhikr: 1080 } as const;
export const weekend = (weekday: number): boolean => weekday === 5 || weekday === 6;
export const weatherMinute = (weekday: number): number => weekend(weekday) ? 540 : 390;
export const verseMinute = (weekday: number): number => weekend(weekday) ? 630 : 750;
export const baghdadMidnight = (date: string): number => Date.parse(date + 'T00:00:00+03:00');

export interface SchoolClosure { date: string; reason: string; source: string }
export function validSchoolClosures(value: unknown): value is SchoolClosure[] {
  return Array.isArray(value) && value.length <= 366 && value.every(item => {
    if (!item || typeof item !== 'object') return false;
    const { date, reason, source } = item as SchoolClosure;
    let validDate = false;
    if (typeof date === 'string' && /^20\d{2}-\d{2}-\d{2}$/u.test(date)) {
      try { validDate = Number.isFinite(baghdadMidnight(date)) && addCalendarDays(date, 0).date === date; }
      catch { validDate = false; }
    }
    return validDate
      && typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 200
      && typeof source === 'string' && source.trim().length > 0 && source.length <= 500;
  });
}
/** Registered dates only; no inferred national holidays or AI calendar. */
export async function schoolClosure(db: D1Database, date: string): Promise<SchoolClosure | null> {
  const row = await db.prepare("SELECT body_json FROM controlled_config WHERE key='product'").first<{ body_json: string }>();
  if (!row) return null;
  try {
    const value = (JSON.parse(row.body_json) as { schoolClosures?: unknown }).schoolClosures;
    return validSchoolClosures(value) ? value.find(item => item.date === date) ?? null : null;
  } catch { return null; }
}
export async function isSchoolDate(db: D1Database, date: string): Promise<boolean> {
  return !weekend(addCalendarDays(date, 0).weekday) && !(await schoolClosure(db, date));
}
