import { afterEach, expect, it } from 'vitest';
import { ADHKAR_IDS, loadDailyDhikr, queueDailyDhikr } from '../src/adhkar';
import { configureAutomation } from '../src/controlled-scheduler';
import { runProductCron } from '../src/product-jobs';
import { configurePrayer, queueControlledPrayers, type PrayerConfiguration } from '../src/prayer-times';
import { productHarness } from './helpers/product';

const date = '2026-11-10';
const at = (time: string) => Date.parse(date + 'T' + time + ':00+03:00');
const opened: ReturnType<typeof productHarness>[] = [];
const text = 'نَصٌّ عَرَبِيٌّ اصْطِنَاعِيٌّ لِفَحْصِ العَرْضِ.\nسَطْرٌ ثَانٍ يَبْقَى بِحَرْفِيَّتِهِ.';
afterEach(() => { for (const h of opened.splice(0)) h.close(); });

async function setup(minutes = [1080]) {
  const h = productHarness(at('00:02'));
  opened.push(h);
  await h.enable();
  await configureAutomation(h.db, 'religion', { enabled: true, body: { dhikrEnabled: true, dhikrMinutes: minutes, frequencyDays: 1 } }, at('00:00'));
  return h;
}

function publisher(calls: string[] = [], patch: Record<string, unknown> = {}): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    calls.push(url.href);
    expect(url.origin).toBe('https://hadeethenc.com');
    expect(url.pathname).toBe('/api/v1/hadeeths/one/');
    expect(url.searchParams.get('language')).toBe('ar');
    return Response.json({ id: url.searchParams.get('id'), hadeeth: text, grade: 'صحيح', attribution: 'رواه مسلم', ...patch });
  };
}

it('uses distinct reviewed IDs across the rotation and retains the publisher text verbatim', async () => {
  const ids = [];
  for (let i = 0; i < ADHKAR_IDS.length; i++) {
    const date = new Date(Date.UTC(2026, 10, 10 + i)).toISOString().slice(0, 10);
    const item = await loadDailyDhikr(date, publisher());
    expect(item?.hadeeth).toBe(text);
    ids.push(Number(item?.id));
  }
  expect(new Set(ids)).toEqual(new Set(ADHKAR_IDS));
  expect(ids).toHaveLength(28);
});

it('rejects wrong IDs, weak or missing grades, and text without usable provenance', async () => {
  for (const patch of [{ id: '99663' }, { grade: 'ضعيف' }, { grade: 'حسن' }, { grade: null }, { attribution: '' }, { hadeeth: '<b>' + text + '</b>' }]) {
    expect(await loadDailyDhikr(date, publisher([], patch))).toBeNull();
  }
  expect(await loadDailyDhikr(date, async () => new Response('', { status: 503 }))).toBeNull();
});

it('prepares the daily dhikr before 6 pm and publishes once without exposing source grading', async () => {
  const h = await setup(), calls: string[] = [];
  const fetcher = publisher(calls);
  await runProductCron(h.env, h.telegram, at('17:57'), fetcher);
  expect(calls).toHaveLength(1);
  expect(h.calls).toHaveLength(0);
  await runProductCron(h.env, h.telegram, at('18:00'), fetcher);
  await runProductCron(h.env, h.telegram, at('18:03'), fetcher);
  const sent = h.calls.filter(call => call.method === 'sendMessage');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.payload.text).toContain(text);
  expect(sent[0]?.payload.text).toContain('📚 رواه مسلم');
  expect(sent[0]?.payload.text).not.toContain('صحيح');
  expect(sent[0]?.payload.text).toContain('https://hadeethenc.com/ar/browse/hadith/');
  expect(calls).toHaveLength(1);
  expect(h.providerRequests()).toBe(0);
});

it('ignores retired custom dhikr times and keeps the fixed 6 pm schedule', async () => {
  const h = await setup([55, 300]), calls: string[] = [];
  const fetcher = publisher(calls);
  await runProductCron(h.env, h.telegram, at('00:51'), fetcher);
  expect(calls).toHaveLength(0);
  expect(await queueDailyDhikr(h.db, at('05:00'), fetcher)).toBe(false);
  await runProductCron(h.env, h.telegram, at('17:57'), fetcher);
  expect(calls).toHaveLength(1);
  await runProductCron(h.env, h.telegram, at('18:00'), fetcher);
  expect(h.calls.filter(call => call.method === 'sendMessage')).toHaveLength(1);
  expect(calls).toHaveLength(1);
  expect(h.calls.filter(call => call.method === 'sendMessage')[0]?.payload.text).toContain('ذكر اليوم');
});

it('lets prayer go first at the same minute and sends dhikr after it', async () => {
  const h = await setup();
  const config: PrayerConfiguration = {
    city: 'الرمادي', region: 'Al-Anbar', country: 'Iraq', latitude: 33.4258, longitude: 43.2992,
    timezone: 'Asia/Baghdad', method: 3, school: 0, adjustments: {}, enabledPrayers: ['Isha'], allowOutsideQuietWindow: true,
    localVerified: false, verificationMode: 'provider_calculation', verificationDate: date, verificationSource: 'https://aladhan.com/prayer-times-api',
  };
  await configurePrayer(h.db, config, true, at('00:01'));
  await queueControlledPrayers(h.db, at('17:50'), async () => Response.json({ code: 200, data: {
    meta: { timezone: 'Asia/Baghdad', latitude: 33.4258, longitude: 43.2992, method: { id: 3 }, school: 0 },
    date: { gregorian: { date: '10-11-2026' } }, timings: { Fajr: '05:08', Dhuhr: '11:51', Asr: '14:48', Maghrib: '17:08', Isha: '18:00' },
  } }));
  await runProductCron(h.env, h.telegram, at('17:57'), publisher());
  for (const time of ['18:00', '18:10', '18:19', '18:20', '18:21']) await runProductCron(h.env, h.telegram, at(time), publisher());
  const sent = h.calls.filter(call => call.method === 'sendMessage').map(call => String(call.payload.text));
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain('صلاة العشاء');
  expect(sent[1]).toContain('ذكر اليوم');
});
