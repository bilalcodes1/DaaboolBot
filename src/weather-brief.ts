import { escapeHtml } from './format';
import { WEEKDAYS } from './schedule';
import { addCalendarDays, getBaghdadNow } from './calendar';
import { readPublicSource } from './source-http';

export const RAMADI_FORECAST = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: '33.4258', longitude: '43.2992', timezone: 'Asia/Baghdad', forecast_days: '1',
  current: 'temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m',
  hourly: 'precipitation_probability,wind_gusts_10m,temperature_2m,visibility',
}).toString();

export interface RamadiMorning {
  date: string;
  time: string;
  temperature: number;
  feelsLike: number;
  code: number;
  rain: number | null;
  gust: number | null;
  humidity?: number | null;
  wind?: number | null;
  visibility?: number | null;
  dust?: number | null;
  laterTemperature?: number | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function morningMax(dates: unknown, values: unknown, date: string, max: number): number | null {
  if (!Array.isArray(dates) || !Array.isArray(values) || dates.length !== values.length || dates.length > 48) return null;
  const morning = values.filter((value, i): value is number =>
    typeof dates[i] === 'string' && dates[i].slice(0, 11) === date + 'T'
    && /^(?:0[6-9]|1[0-2]):00$/u.test(dates[i].slice(11)) && inRange(value, 0, max));
  return morning.length ? Math.max(...morning) : null;
}

export async function loadRamadiMorning(now: number, fetcher: typeof fetch): Promise<RamadiMorning | null> {
  const text = await readPublicSource(RAMADI_FORECAST, fetcher, { allowed: url => url === RAMADI_FORECAST, maxBytes: 32_000 });
  if (!text) return null;
  let data: Record<string, unknown> | undefined;
  try { data = record(JSON.parse(text)); } catch { return null; }
  const date = getBaghdadNow(new Date(now)).date;
  const current = record(data?.current), units = record(data?.current_units);
  const { temperature_2m: temperature, apparent_temperature: feelsLike, time, weather_code: code } = current ?? {};
  if (data?.timezone !== 'Asia/Baghdad' || data.utc_offset_seconds !== 10800
    || !inRange(data.latitude, 33.17, 33.68) || !inRange(data.longitude, 43.04, 43.55)
    || units?.temperature_2m !== '°C' || units.apparent_temperature !== '°C'
    || typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time) || !time.startsWith(date + 'T')
    || !inRange(temperature, -35, 60) || !inRange(feelsLike, -50, 75) || !inRange(code, 0, 99) || !Number.isInteger(code)) return null;
  const age = now - Date.parse(time + ':00+03:00');
  if (!Number.isFinite(age) || age < -15 * 60_000 || age > 45 * 60_000) return null;
  const hourly = record(data.hourly), hourlyUnits = record(data.hourly_units);
  const times: unknown[] = Array.isArray(hourly?.time) ? hourly.time : [];
  const later = Array.isArray(hourly?.temperature_2m) && Array.isArray(hourly?.time) && hourlyUnits?.temperature_2m === '°C'
    ? hourly.temperature_2m.filter((v, i): v is number => typeof times[i] === 'string' && String(times[i]).startsWith(date + 'T') && String(times[i]) > time && inRange(v,-35,60)) : [];
  const visible = Array.isArray(hourly?.visibility) && Array.isArray(hourly?.time) && hourlyUnits?.visibility === 'm'
    ? hourly.visibility.filter((v, i): v is number => typeof times[i] === 'string' && String(times[i]).slice(0,13) === time.slice(0,13) && inRange(v,0,100000)) : [];
  return {
    humidity: units?.relative_humidity_2m === '%' && inRange(current?.relative_humidity_2m,0,100) ? current.relative_humidity_2m : null,
    wind: units?.wind_speed_10m === 'km/h' && inRange(current?.wind_speed_10m,0,250) ? current.wind_speed_10m : null,
    visibility: visible[0] ?? null, laterTemperature: later.length ? Math.max(...later) : null,
    date, time, temperature, feelsLike, code,
    rain: hourlyUnits?.precipitation_probability === '%' ? morningMax(hourly?.time, hourly?.precipitation_probability, date, 100) : null,
    gust: hourlyUnits?.wind_gusts_10m === 'km/h' ? morningMax(hourly?.time, hourly?.wind_gusts_10m, date, 250) : null,
  };
}

const advice = {
  umbrella: 'إذا راح تطلع، خذ وياك مظلّة أو جاكيت للمطر.',
  warm: 'إذا تطلع من وگت، البس شي يدفيك.',
  water: 'إذا تطلع، خذ وياك قنينة مي.',
  wind: 'إذا تطلع، دير بالك على أغراضك الخفيفة من الهوا.',
  mild: 'إذا تطلع من وگت، البس شي مريح.',
} as const;
export type WeatherAction = keyof typeof advice;

function condition(code: number): string | null {
  if (code === 0) return 'الجو صافي';
  if (code === 1) return 'الجو أغلبه صافي';
  if (code === 2) return 'الجو بيه شوية غيم';
  if (code === 3) return 'الجو مغيّم';
  if (code === 45 || code === 48) return 'أكو ضباب';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'أكو ثلج';
  if ([95, 96, 99].includes(code)) return 'أكو عواصف ويّا رعد';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'أكو مطر';
  return null;
}
export function weatherActions(weather: RamadiMorning): WeatherAction[] {
  const actions: WeatherAction[] = [];
  if ((weather.rain ?? 0) >= 50 || (weather.code >= 51 && weather.code <= 99)) actions.push('umbrella');
  if (weather.feelsLike <= 12) actions.push('warm');
  if (weather.feelsLike >= 32) actions.push('water');
  if ((weather.gust ?? 0) >= 40) actions.push('wind');
  return actions.length ? actions : ['mild'];
}

export function temperatureLabel(value: number): string {
  const n = Math.round(value);
  return n === -1 ? 'تحت الصفر بدرجة' : n === -2 ? 'تحت الصفر بدرجتين' : n < 0 ? `تحت الصفر بـ ${Math.abs(n)} درجات` : `${n}°`;
}
export function hazardousWeather(w: RamadiMorning): boolean {
  return w.feelsLike <= 0 || w.feelsLike >= 45 || (w.gust ?? 0) >= 60 || (w.wind ?? 0) >= 50
    || (w.visibility != null && w.visibility <= 1000) || (w.dust ?? 0) >= 150 || [65,67,75,82,95,96,99].includes(w.code);
}
function safeWeatherAdvice(w: RamadiMorning, raw: unknown): string {
  if (hazardousWeather(w)) {
    if ((w.visibility != null && w.visibility <= 1000) || (w.dust ?? 0) >= 150) return 'الرؤية ضعيفة، دير بالك بالطريق وخفف طلعاتك إذا ما ضرورية.';
    if (w.feelsLike <= 0) return 'البرد قوي، البس ملابس تدفيك زين وانتبه بالطريق.';
    if (w.feelsLike >= 45) return 'الحر قوي كلش، خلّيك بالظل قدر الإمكان وخذ مي وياك.';
    return 'الجو مو مناسب للطلعات الطويلة، انتبه بالطريق وابتعد عن الأشياء اللي ممكن يطيحها الهوا.';
  }
  const proposed = record(raw)?.advice;
  const actions = record(raw)?.actions;
  const allowed = weatherActions(w);
  if (typeof proposed === 'string' && proposed.length >= 12 && proposed.length <= 220 && /\p{Script=Arabic}/u.test(proposed)
    && !/[<>0-9٠-٩۰-۹]|https?:|\n/iu.test(proposed) && !/مرض|زكام|علاج|حتم|أكيد|بالتأكيد|تجمّد|تجمد|إعصار|اعصار/u.test(proposed)
    && !(/مطر|مظل|مقاوم/u.test(proposed) && !allowed.includes('umbrella'))
    && !(/غبار/u.test(proposed) && w.dust == null)
    && Array.isArray(actions) && actions.length > 0 && actions.length <= 2 && actions.every(a => allowed.includes(a))) return proposed.trim();
  return allowed.slice(0, 2).map(a => advice[a]).join(' ');
}
export function renderRamadiMorning(weather: RamadiMorning, proposed: unknown): string {
  const day = WEEKDAYS[addCalendarDays(weather.date, 0).weekday];
  const sky = condition(weather.code) ?? 'الحالة غير متوفرة';
  const details = [`🌡️ الحرارة: ${temperatureLabel(weather.temperature)}`, `🥶 تحسّها: ${temperatureLabel(weather.feelsLike)}`, `☀️ الحالة: ${sky}`];
  if (weather.rain !== null && weather.rain >= 50) details.push(`🌧️ احتمال المطر الصبح: ${Math.round(weather.rain)}%`);
  if (weather.gust !== null && weather.gust >= 40) details.push(`💨 هبّات الهوا: ${Math.round(weather.gust)} كم/س`);
  if (weather.visibility != null && weather.visibility <= 1000) details.push(`الرؤية: ${Math.round(weather.visibility)} متر`);
  return [`🌤️ <b>طقس الرمادي | ${day}</b>`, '', '━━━━━━━━━━━━━', '', ...details, '', '💡 <b>نصيحة دعبول:</b>', escapeHtml(safeWeatherAdvice(weather, proposed))].join('\n');
}
