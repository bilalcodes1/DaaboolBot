import { afterEach, expect, it } from 'vitest';
import { briefSlots, BRIEF_MENU } from '../src/brief-schedule';
import { AI_PUBLISHERS, discoverDeviceReleases, checkDeviceRelease, checkDeviceGuide,
  discoverFreeAiRelease, confirmFreeAiTool } from '../src/brief-sources';
import { renderDeviceTip } from '../src/brief-content';
import { getBaghdadNow } from '../src/calendar';
import { configureAutomation, dispatchControlledJobs, getAutomationConfig, queueControlledJob } from '../src/controlled-scheduler';
import { PRODUCT_HANDLERS, runProductCron } from '../src/product-jobs';
import { BRIEF_JOB } from '../src/useful-briefs';
import { RAMADI_FORECAST, loadRamadiMorning, renderRamadiMorning } from '../src/weather-brief';
import { productHarness } from './helpers/product';

const opened: ReturnType<typeof productHarness>[] = [];
function setup(now: number, reply?: unknown) {
  const harness = productHarness(now, reply);
  opened.push(harness);
  return harness;
}
afterEach(() => { for (const h of opened.splice(0)) h.close(); });
const at = (date: string, time: string) => Date.parse(date + 'T' + time + ':00+03:00');
const DAY = 86_400_000;
const morning = at('2026-11-09', '06:27');
const evening = at('2026-11-08', '20:15');
const saturday = at('2026-11-14', '20:15');
const androidUrl = 'https://blog.google/products-and-platforms/platforms/android/new-reader/';
const guideUrl = 'https://support.google.com/android/answer/1234';
const androidTitle = 'New compact reader in Android';
const androidDescription = 'The new compact reader in Android is available now and requires Android 16 or later.';
const stepOne = 'Open Settings and go to Accessibility on your Android device.';
const stepTwo = 'Tap Compact reader to turn on the new reading view.';
const androidDraft = {
  index: 0,
  title: { text: 'عرض القراءة المدمج', quote: androidTitle },
  steps: [{ text: 'افتح الإعدادات وروح لإمكانية الوصول.', quote: stepOne },
    { text: 'اضغط عرض القراءة المدمج حتى تشغّله.', quote: stepTwo }],
  requirement: { text: 'أندرويد ١٦ أو أحدث', quote: androidDescription },
};
function weather(date = '2026-11-09', time = '06:15') {
  return {
    timezone: 'Asia/Baghdad', utc_offset_seconds: 10800, latitude: 33.4, longitude: 43.3,
    current_units: { temperature_2m: '°C', apparent_temperature: '°C' },
    current: { time: date + 'T' + time, temperature_2m: 9, apparent_temperature: 6, weather_code: 61 },
    hourly_units: { precipitation_probability: '%', wind_gusts_10m: 'km/h' },
    hourly: {
      time: [date + 'T07:00', date + 'T12:00', date + 'T16:00'],
      precipitation_probability: [72, 21, 100], wind_gusts_10m: [17, 42, 100],
    },
  };
}
function feed(items: { title: string; url: string; time: number; body: string }[]) {
  return '<rss><channel>' + items.map(item => '<item><title>' + item.title + '</title><link>' + item.url
    + '</link><pubDate>' + new Date(item.time).toUTCString() + '</pubDate><description><![CDATA['
    + item.body + ']]></description></item>').join('') + '</channel></rss>';
}
function sources(h: ReturnType<typeof setup>, documents: Record<string, string>, called: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url === 'https://api.groq.com/openai/v1/chat/completions') return h.fetcher(input, init);
    called.push(url);
    if (!Object.hasOwn(documents, url)) return new Response('', { status: 503 });
    return new Response(documents[url]);
  };
}

it('schedules only the weather at its weekday/weekend Baghdad time', () => {
  const dates = ['08', '09', '10', '11', '12', '13', '14'];
  const slots = dates.map(day => briefSlots(getBaghdadNow(new Date(at('2026-11-' + day, '20:30')))));
  for (const [i, day] of dates.entries()) {
    const time = i < 5 ? '06:30' : '09:00';
    expect(slots[i]?.[0]).toMatchObject({
      key: 'weather', prepareAt: at('2026-11-' + day, i < 5 ? '06:27' : '08:57'), dueAt: at('2026-11-' + day, time),
      expiresAt: at('2026-11-' + day, i < 5 ? '06:40' : '09:10'),
    });
  }
  expect(slots.every(x => x.length === 1)).toBe(true);
});

it('shows independent, default-off controls and rejects students opening or replaying admin controls', async () => {
  const h = setup(morning);
  await h.text(9001, BRIEF_MENU);
  expect(h.latest().text).toContain('المواعيد بتوقيت بغداد');
  expect(h.latest().reply_markup.inline_keyboard.flat().map((b: { text: string }) => b.text))
    .toEqual(['تشغيل طقس الرمادي']);
  const button = h.button(9001, 'تشغيل طقس الرمادي');
  await h.text(9002, BRIEF_MENU);
  expect(h.latest(9002).text).toContain('للأدمن فقط');
  await h.dispatch({
    update_id: 54321, callback_query: { id: 'forged', chat_instance: 'test', from: { id: 9002, is_bot: false },
      message: { message_id: button.message.message_id, chat: { id: 9002, type: 'private' } }, data: button.data },
  });
  expect((await getAutomationConfig(h.db, 'weather')).enabled).toBe(false);
  await h.click(9001, 'تشغيل طقس الرمادي');
  expect((await getAutomationConfig(h.db, 'weather')).enabled).toBe(true);
  expect((await getAutomationConfig(h.db, 'device_tips')).enabled).toBe(false);
  expect((await getAutomationConfig(h.db, 'ai_tools')).enabled).toBe(false);
  await h.click(9001, 'إيقاف طقس الرمادي');
  expect((await getAutomationConfig(h.db, 'weather')).enabled).toBe(false);
});

it('validates the day, time, region and units, and scopes rain and gusts to the morning', async () => {
  const h = setup(morning);
  const read = async (body: unknown) => loadRamadiMorning(morning, sources(h, { [RAMADI_FORECAST]: JSON.stringify(body) }));
  expect(await read(weather())).toMatchObject({ date: '2026-11-09', temperature: 9, rain: 72, gust: 42 });
  expect(await read(weather('2026-11-08'))).toBeNull();
  expect(await read(weather('2026-11-09', '04:30'))).toBeNull();
  expect(await read({ ...weather(), timezone: 'UTC' })).toBeNull();
  expect(await read({ ...weather(), latitude: 30 })).toBeNull();
  expect(await read({ ...weather(), current_units: { temperature_2m: '°F' } })).toBeNull();
});

it.each([[1, 'الجو أغلبه صافي'], [2, 'الجو بيه شوية غيم'], [3, 'الجو مغيّم']] as const)('renders cloud cover code %s in Iraqi Arabic', (code, label) => {
  const result = renderRamadiMorning({ date: '2026-11-10', time: '2026-11-10T06:30', temperature: 8,
    feelsLike: 8, code, rain: 0, gust: 0 }, null);
  expect(result).toContain('☀️ الحالة: الجو ' + label.replace(/^الجو /u, ''));
  expect(result).toContain('🌡️ الحرارة: 8°');
});

it('prepares weather once, keeps source numbers, falls back on Groq 429, and sends one message at 06:30', async () => {
  const h = setup(morning);
  await h.enable();
  const called: string[] = [];
  const external = sources(h, { [RAMADI_FORECAST]: JSON.stringify(weather()) }, called);
  const fetcher: typeof fetch = async (input, init) => String(input).startsWith('https://api.groq.com/')
    ? new Response('{}', { status: 429, headers: { 'Retry-After': '10' } }) : external(input, init);
  await runProductCron(h.env, h.telegram, morning, fetcher);
  expect(called).toEqual([]);
  await configureAutomation(h.db, 'weather', { enabled: true }, morning - 60_000);
  h.env.GROQ_API_KEY = 'synthetic-groq-credential';
  await Promise.all([runProductCron(h.env, h.telegram, morning, fetcher), runProductCron(h.env, h.telegram, morning, fetcher)]);
  expect(called).toEqual([RAMADI_FORECAST]);
  expect(h.calls).toHaveLength(0);
  const due = at('2026-11-09', '06:30');
  await runProductCron(h.env, h.telegram, due, fetcher);
  await runProductCron(h.env, h.telegram, due + 60_000, fetcher);
  const sent = h.calls.filter(call => call.method === 'sendMessage');
  expect(sent).toHaveLength(1);
  expect(sent[0]?.payload.text).toContain('<b>طقس الرمادي | الاثنين</b>');
  expect(sent[0]?.payload.text).toContain('الحرارة: 9°');
  expect(sent[0]?.payload.text).toContain('تحسّها: 6°');
  expect(sent[0]?.payload.text).toContain('72%');
  expect(sent[0]?.payload.text).toContain('42 كم/س');
  expect(sent[0]?.payload.text).toContain('مظلّة');
  expect(sent[0]?.payload.text).not.toMatch(/°\s*[CFمف]|[٠-٩]|المصدر|Open‑Meteo|https?:/u);
  const row = h.sqlite.prepare('SELECT payload_json FROM outbox WHERE type=?').get(BRIEF_JOB);
  expect(JSON.parse(String(row?.payload_json)).references[0]?.releaseUrl).toBe(RAMADI_FORECAST);
});

it('accepts only relevant Groq advice and skips delivery on source failure, disable, or expiry', async () => {
  for (const caseName of ['unavailable', 'enabled', 'disabled', 'late']) {
    const h = setup(morning, { actions: ['warm'] });
    await h.enable();
    h.env.GROQ_API_KEY = 'synthetic-groq-credential';
    await configureAutomation(h.db, 'weather', { enabled: true }, morning - 60_000);
    const fetcher = sources(h, caseName === 'unavailable' ? {} : { [RAMADI_FORECAST]: JSON.stringify(weather()) });
    await runProductCron(h.env, h.telegram, morning, fetcher);
    if (caseName === 'disabled') await configureAutomation(h.db, 'weather', { enabled: false }, morning + 60_000);
    await runProductCron(h.env, h.telegram, at('2026-11-09', caseName === 'late' ? '06:40' : '06:30'), fetcher);
    const messages = h.calls.filter(call => call.method === 'sendMessage');
    expect(messages).toHaveLength(caseName === 'enabled' ? 1 : 0);
    if (caseName === 'enabled') expect(messages[0]?.payload.text).toContain('إذا تطلع من وگت، البس شي يدفيك.');
  }
});

it('prioritizes an overlapping academic delivery ahead of a prepared brief', async () => {
  const h = setup(morning);
  await h.enable();
  await configureAutomation(h.db, 'weather', { enabled: true }, morning - 60_000);
  const fetcher = sources(h, { [RAMADI_FORECAST]: JSON.stringify(weather()) });
  await runProductCron(h.env, h.telegram, morning, fetcher);
  const due = at('2026-11-09', '06:30');
  await queueControlledJob(h.db, { id: 'controlled:academic:synthetic', type: 'controlled_academic_test', payload: {},
    chatId: -100777, threadId: null, dueAt: due, expiresAt: due + 60_000, family: 'academic' });
  const handlers = [...PRODUCT_HANDLERS, { types: ['controlled_academic_test'], async resolve() {
    return { chatId: -100777, method: 'sendMessage' as const, payload: { chat_id: -100777, text: 'تبليغ دراسي تجريبي' } };
  }}];
  await dispatchControlledJobs(h.db, h.telegram, due, handlers, { limit: 1, clock: () => due });
  expect(h.calls.map(call => call.payload.text)).toEqual(['تبليغ دراسي تجريبي']);
  await runProductCron(h.env, h.telegram, due + 2 * 60_000, fetcher);
  expect(h.calls).toHaveLength(1);
  expect(h.sqlite.prepare('SELECT state FROM outbox WHERE type=?').get(BRIEF_JOB)).toMatchObject({ state: 'cancelled' });
});

const androidFeed = 'https://blog.google/products-and-platforms/platforms/android/rss/';
const officialAndroid = (time: number) => ({
  [androidFeed]: feed([{ title: androidTitle, url: androidUrl, time, body: androidDescription },
    { title: 'Old Android reader', url: androidUrl + 'old/', time: time - 40 * DAY, body: androidDescription }]),
  [androidUrl]: '<main><article><p>' + androidDescription + '</p><a href="' + guideUrl + '">Use compact reader</a></article></main>',
  [guideUrl]: '<main><article><ol><li>' + stepOne + '</li><li>' + stepTwo + '</li></ol></article></main>',
});

it('links recent platform releases to official steps and rejects fabricated or omitted requirements', async () => {
  const h = setup(evening);
  const fetched: string[] = [];
  const fetcher = sources(h, officialAndroid(evening - DAY), fetched);
  const [release] = await discoverDeviceReleases('android', evening, fetcher);
  const check = await checkDeviceRelease('android', release!, evening, fetcher);
  expect(check?.type).toBe('guide');
  if (check?.type !== 'guide') throw new Error('Expected official guide');
  const verified = await checkDeviceGuide('android', check.release, check.url, fetcher);
  if (verified?.type !== 'verified') throw new Error('Expected verified steps');
  const candidates = [verified.tip];
  expect(fetched).toEqual([androidFeed, androidUrl, guideUrl]);
  expect(candidates).toHaveLength(1);
  const rendered = renderDeviceTip('android', candidates, androidDraft);
  expect(rendered?.references[0]).toMatchObject({ releaseUrl: androidUrl, guideUrl });
  expect(rendered?.text).toContain('1. افتح الإعدادات');
  expect(rendered?.text).toContain('أندرويد 16 أو أحدث');
  expect(rendered?.text).not.toMatch(/[٠-٩۰-۹]/u);
  expect(renderDeviceTip('android', candidates, { ...androidDraft, requirement: null })).toBeNull();
  expect(renderDeviceTip('android', candidates, { ...androidDraft, requirement: { text: 'أندرويد ٢٥', quote: androidDescription } })).toBeNull();
  expect(renderDeviceTip('android', candidates, { ...androidDraft, steps: [{ text: 'حمّل التطبيق.', quote: 'Download arbitrary tools' }, androidDraft.steps[1]] })).toBeNull();
  expect(renderDeviceTip('android', candidates, { ...androidDraft, steps: [androidDraft.steps[0], { ...androidDraft.steps[1], quote: stepOne }] })).toBeNull();
});

it('treats the Apple Atom modification date as discovery metadata only', async () => {
  const h = setup(evening);
  const url = 'https://www.apple.com/newsroom/2026/09/old-feature/';
  const appleFeed = 'https://www.apple.com/newsroom/rss-feed.rss';
  const fetcher = sources(h, {
    [appleFeed]: '<feed><entry><updated>' + new Date(evening - 1000).toISOString() + '</updated><id>' + url
      + '</id><title>New iPhone reader</title><content>iPhone has a new reader.</content></entry></feed>',
    [url]: '<main><article><span class="category-eyebrow__date">September 1, 2026</span><p>'
      + stepOne + '</p><p>' + stepTwo + '</p></article></main>',
  });
  const [release] = await discoverDeviceReleases('iphone', evening, fetcher);
  expect(await checkDeviceRelease('iphone', release!, evening, fetcher)).toBeNull();
});

it('does not schedule retired weekly device tips', async () => {
  const h = setup(evening, androidDraft);
  await h.enable();
  await expect(configureAutomation(h.db, 'device_tips' as never, { enabled: true }, evening - 60_000)).rejects.toThrow();
  h.env.GROQ_API_KEY = 'synthetic-groq-credential';
  const fetched: string[] = [], fetcher = sources(h, officialAndroid(evening - DAY), fetched);
  await runProductCron(h.env, h.telegram, at('2026-11-08', '20:30'), fetcher);
  expect(fetched).toEqual([]);
  expect(h.calls).toHaveLength(0);
});

const copilot = AI_PUBLISHERS[3]!;
const toolUrl = 'https://github.blog/changelog/new-copilot-completions/';
const toolTitle = 'New Copilot completions for students';
const access = 'Copilot Free users can now use inline completions to finish code in the editor.';
const freePlan = 'Copilot Free users are limited to 2,000 completions per month.';
function officialCopilot(body = access, time = saturday - DAY) {
  return {
    [copilot.feed]: feed([{ title: toolTitle, url: toolUrl, time, body }]),
    [toolUrl]: '<main><article><p>' + body + '</p></article></main>',
    [copilot.plan]: '<main><article><p>' + freePlan + '</p></article></main>',
  };
}

it('requires a current named release, present free access, and an official recurring tier', async () => {
  const h = setup(saturday);
  const verify = async (documents: Record<string, string>) => {
    const fetcher = sources(h, documents);
    const release = await discoverFreeAiRelease(copilot, saturday, fetcher);
    return release ? confirmFreeAiTool(copilot, release, fetcher) : null;
  };
  expect(await verify(officialCopilot())).toMatchObject({ url: toolUrl, freeUrl: copilot.plan, allowance: '2٬000 إكمال كود بالشهر' });
  const rejects = [
    officialCopilot(access, saturday - 8 * DAY),
    officialCopilot('Copilot Free users can now use completions on a free trial.'),
    officialCopilot('Completions are only for Pro users. Free users can still use chat to ask questions.'),
    officialCopilot('Completions will be available to Copilot Free users next week.'),
    officialCopilot('Completions are not available to Copilot Free users.'),
    { ...officialCopilot(), [toolUrl]: '<article>Completions are not available to Copilot Free users.</article>' },
    { ...officialCopilot(), [copilot.plan]: '<article>Start your free trial and subscribe after 7 days.</article>' },
  ];
  for (const documents of rejects) expect(await verify(documents)).toBeNull();
});

it('does not schedule retired weekly AI-tool digests', async () => {
  const h = setup(saturday, { items: [{ index: 0, use: { text: 'إكمال الكود داخل المحرر', quote: access },
    new: { text: 'الإكمال صار متاح للمستخدم المجاني', quote: access } }] });
  await h.enable();
  await expect(configureAutomation(h.db, 'ai_tools' as never, { enabled: true }, saturday - 60_000)).rejects.toThrow();
  const called: string[] = [], fetcher = sources(h, officialCopilot(), called);
  await runProductCron(h.env, h.telegram, saturday, fetcher);
  expect(called).toEqual([]);
  expect(h.calls).toHaveLength(0);
});

it('rejects device-tip and AI-tool delivery controls after retirement', async () => {
  const h = setup(saturday);
  await expect(configureAutomation(h.db, 'device_tips' as never, { enabled: true }, saturday)).rejects.toThrow();
  await expect(configureAutomation(h.db, 'ai_tools' as never, { enabled: true }, saturday)).rejects.toThrow();
});
