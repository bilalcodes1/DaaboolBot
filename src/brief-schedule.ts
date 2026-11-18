import { weatherMinute } from './channel-calendar';
import type { BaghdadNow } from './calendar';

export const BRIEF_MENU = '🧭 الفقرات المفيدة';
export const BRIEF_CONTROLS = [
  { key: 'weather', label: 'طقس الرمادي', schedule: 'الدوام 6:30 ص · الجمعة والسبت 9:00 ص' },
] as const;
export type BriefKey = 'weather'|'device_tips'|'ai_tools';
export type DevicePlatform = 'android' | 'iphone' | 'windows';
export type BriefSlot = {
  key: BriefKey;
  date: string;
  platform?: DevicePlatform;
  prepareAt: number;
  dueAt: number;
  expiresAt: number;
};
export const DEVICE_NAMES: Record<DevicePlatform, string> = { android: 'أندرويد', iphone: 'آيفون', windows: 'ويندوز' };
const deviceDays: Partial<Record<number, DevicePlatform>> = { 0: 'android', 2: 'iphone', 4: 'windows' };

export function isBriefKey(value: unknown): value is BriefKey {
  return BRIEF_CONTROLS.some(control => control.key === value);
}

export function briefSlots(clock: BaghdadNow): BriefSlot[] {
  const midnight = Date.parse(clock.date + 'T00:00:00+03:00');
  const morning = weatherMinute(clock.weekday);
  const slot = (key: BriefKey, due: number, lead: number, platform?: DevicePlatform): BriefSlot => ({
    key, date: clock.date, ...(platform ? { platform } : {}),
    prepareAt: midnight + (due - lead) * 60_000,
    dueAt: midnight + due * 60_000,
    expiresAt: midnight + (due + 10) * 60_000,
  });
  return [slot('weather', morning, 3)];
}
