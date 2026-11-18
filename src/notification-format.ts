import { addCalendarDays } from './calendar';
import { WEEKDAYS } from './schedule';

const MONTHS = [
  'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
  'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
] as const;

export function arabicDigits(value: string | number): string {
  return englishDigits(value);
}

/** One-code-unit replacements preserve Telegram entity offsets. Circled list markers stay intact. */
export function englishDigits(value: string | number): string {
  return String(value).replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit <= '٩' ? 0x660 : 0x6f0)));
}

/** Display text only: never rewrite URLs, HTML attributes, IDs, callback data or source evidence. */
export function englishDisplay(value: string): string {
  return value.split(/(<[^>]*>|https?:\/\/[^\s<>]+)/gu).map((part, i) => i % 2 ? part : englishDigits(part)).join('');
}

export function telegramDisplayPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(telegramDisplayPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['text', 'caption', 'title', 'description', 'message_text'].includes(key) && typeof item === 'string'
      ? englishDisplay(item) : item && typeof item === 'object' ? telegramDisplayPayload(item) : item,
  ]));
}

export function notificationDate(date: string): string {
  try {
    const { weekday } = addCalendarDays(date, 0);
    const month = MONTHS[Number(date.slice(5, 7)) - 1];
    return `${WEEKDAYS[weekday]} ${arabicDigits(Number(date.slice(8)))} ${month}`;
  } catch {
    return date;
  }
}

export function notificationTime(time: string): string {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(time);
  if (!match) return time;
  const hour = Number(match[1]);
  if (hour > 23) return time;
  return `${arabicDigits(`${hour % 12 || 12}:${match[2]}`)} ${hour < 12 ? 'ص' : 'م'}`;
}
