import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'runtime-test-webhook-secret-0123456789';
const TOKEN = `123456789:${'synthetic'.repeat(5)}`;
const USERNAME = 'RuntimeDaaboolBot';
const PERSON = { id: 101, is_bot: false };

test('the actual workerd runtime handles Telegram delivery without contacting Telegram', { timeout: 30_000 }, async (suite) => {
  const bundled = await build({
    absWorkingDir: ROOT, entryPoints: ['src/index.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', write: false,
  });
  const calls = [];
  let apiMode = 'success';
  const outboundService = async (request) => {
    const url = new URL(request.url);
    // Every outbound request is intercepted. There is no fallback to the public network.
    assert.equal(url.hostname, 'api.telegram.org');
    assert.equal(request.method, 'POST');
    const method = url.pathname.split('/').at(-1);
    let payload;
    if (request.headers.get('Content-Type')?.startsWith('multipart/form-data')) {
      assert.equal(method, 'sendDocument');
      assert.match(request.headers.get('Content-Type'), /^multipart\/form-data;\s*boundary=/i);
      payload = {};
      for (const [key, value] of await request.formData()) {
        if (typeof value === 'string') payload[key] = value;
        else {
          assert.equal(key, 'document');
          payload[key] = { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
        }
      }
    } else payload = await request.json();
    calls.push({ method, payload });
    if (apiMode === 'redirect') {
      return new RuntimeResponse(JSON.stringify({ ok: true, result: true }), {
        status: 302, headers: { 'Content-Type': 'application/json', Location: 'https://must-never-be-followed.invalid/' },
      });
    }
    if (apiMode === 'expired') return RuntimeResponse.json({ ok: false, error_code: 400, description: 'query is too old' }, { status: 400 });
    return RuntimeResponse.json({ ok: true, result: method === 'getMe'
      ? { id: 202, is_bot: true, username: USERNAME }
      : method === 'sendMessage' || method === 'sendDocument' ? { message_id: 303 } : true });
  };
  // Only the test module's Date binding is fixed. workerd still executes the
  // production handler and all Telegram calls remain intercepted below.
  const fixedClockScript = instant => `
    const Date = class extends globalThis.Date {
      constructor(...args) { super(...(args.length ? args : [${JSON.stringify(instant)}])); }
      static now() { return globalThis.Date.parse(${JSON.stringify(instant)}); }
    };
    ${bundled.outputFiles[0].text}
  `;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: '2026-10-13',
    script: fixedClockScript('2026-10-16T09:00:00.000Z'),
    bindings: { TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET_TOKEN: SECRET },
    outboundService,
  }));
  suite.after(async () => { await mf.dispose(); });
  const post = (update, authenticated = true) => mf.dispatchFetch('https://runtime.test/webhook', {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { 'X-Telegram-Bot-Api-Secret-Token': SECRET } : {}),
    }, body: JSON.stringify(update),
  });
  const message = (update_id, chatType, text, message_id = update_id) => ({
    update_id, message: { message_id, chat: { id: chatType === 'private' ? 101 : -101, type: chatType }, from: PERSON,
      text },
  });
  const inline = (update_id) => ({
    update_id, inline_query: { id: `runtime-inline-${update_id}`, from: PERSON, query: 'شنو عدنا باچر؟', offset: '' },
  });

  await suite.test('health is ready and a missing secret is rejected before outbound work', async () => {
    const health = await mf.dispatchFetch('https://runtime.test/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ready');
    assert.equal((await post(message(1, 'private', 'شنو عدنا باچر؟'), false)).status, 403);
    assert.equal(calls.length, 0);
  });

  await suite.test('unaddressed group text, ordinary private media and sender bots stay silent in workerd', async () => {
    const inputs = [
      { update_id: 80, message: { message_id: 80, from: PERSON, chat: { id: -101, type: 'supergroup' }, text: 'شعدنا باجر؟' } },
      { update_id: 81, message: { message_id: 81, from: PERSON, chat: { id: 101, type: 'private' }, photo: [{ file_id: 'photo_1', width: 100, height: 100 }], caption: 'صورة عادية' } },
      { update_id: 82, message: { message_id: 82, from: PERSON, chat: { id: 101, type: 'private' }, document: { file_id: 'document_1' } } },
      { update_id: 83, message: { ...message(83, 'private', 'دعبول جدول اليوم').message, from: { id: 202, is_bot: true } } },
    ];
    for (const input of inputs) assert.equal((await post(input)).status, 200);
    assert.equal(calls.length, 0);
  });

  await suite.test('unprefixed private requests use real runtime fetch and reply to the source message', async () => {
    assert.equal((await post(message(10, 'private', 'شعدنا باجر', 42))).status, 200);
    assert.deepEqual(calls.map(call => call.method), ['getMe', 'sendMessage']);
    const reply = calls.at(-1).payload;
    assert.equal(reply.chat_id, 101);
    assert.equal(reply.reply_parameters.message_id, 42);
    assert.equal(reply.parse_mode, 'HTML');
    assert.match(reply.text, /دعبول/);
  });

  await suite.test('bare wake-word replies use the exact three approved strings without a database', async () => {
    const before = calls.length;
    for (const update_id of [0, 1, 2]) assert.equal((await post(message(update_id, 'private', 'دعبول', update_id + 100))).status, 200);
    assert.deepEqual(calls.slice(before).map(call => call.payload.text), [
      'خير شكو 😒 ماتخلون احد ينام ؟',
      'اهوووو مو نايم شتريد/ين هسه ؟',
      'خير يم خضير شتريد/ين ؟',
    ]);
  });

  await suite.test('group mentions work with different case; ordinary group messages stay silent', async () => {
    const before = calls.length;
    assert.equal((await post(message(11, 'supergroup', `@${USERNAME.toUpperCase()} شنو عدنا باجر؟`, 43))).status, 200);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).method, 'sendMessage');
    assert.equal(calls.at(-1).payload.reply_parameters.message_id, 43);
    assert.equal((await post(message(12, 'group', 'شنو عدنا باجر؟'))).status, 200);
    assert.equal(calls.length, before + 1);
  });

  await suite.test('inline queries reach answerInlineQuery with the formatted schedule', async () => {
    assert.equal((await post(inline(13))).status, 200);
    const answer = calls.at(-1);
    assert.equal(answer.method, 'answerInlineQuery');
    assert.equal(answer.payload.inline_query_id, 'runtime-inline-13');
    assert.equal(answer.payload.results.length, 1);
    assert.match(answer.payload.results[0].title, /جدول محاضرات باچر/);
    assert.equal(answer.payload.results[0].input_message_content.parse_mode, 'HTML');
  });

  await suite.test('today, teacher and compound filters render only the official timetable in workerd', async () => {
    assert.equal((await post(message(20, 'private', 'جدول اليوم'))).status, 200);
    assert.match(calls.at(-1).payload.text, /📅 \d{4}-\d{2}-\d{2}/);
    assert.equal((await post(message(21, 'private', 'وين الموبايل لمجموعة A مختبر 1؟'))).status, 200);
    const laboratory = calls.at(-1).payload.text;
    assert.match(laboratory, /ضمن الجدول الأسبوعي/);
    assert.match(laboratory, /برمجة تطبيقات الموبايل \| مجموعة A \| م1/);
    assert.match(laboratory, /مبرمج خبيب باسم/);
    assert.doesNotMatch(laboratory, /مجموعة B|\(نظري\)|\(عملي\)/);
    assert.equal((await post(message(22, 'private', 'شوكت محاضرة خبيب باسم؟'))).status, 200);
    assert.equal((calls.at(-1).payload.text.match(/مبرمج خبيب باسم/g) ?? []).length, 2);
  });

  await suite.test('approved short graphics names, academic titles and unqualified courses survive workerd rendering', async () => {
    assert.equal((await post(message(25, 'private', 'شوكت محاضرة سرى؟'))).status, 200);
    assert.equal((calls.at(-1).payload.text.match(/م\.م\. سرى/g) ?? []).length, 2);
    assert.equal((await post(message(26, 'private', 'شوكت محاضرة بلال فواز؟'))).status, 200);
    assert.match(calls.at(-1).payload.text, /د\. عصام \+ م\.م\. بلال فواز/);
    assert.equal((await post(message(27, 'private', 'وين رسومات عملي مجموعة A؟'))).status, 200);
    assert.match(calls.at(-1).payload.text, /رسومات \(عملي\) \| مجموعة A \| م2/);
    assert.equal((await post(message(28, 'private', 'وين عملي الموبايل لمجموعة A؟'))).status, 200);
    assert.match(calls.at(-1).payload.text, /نوع هذي المحاضرات مو مذكور بالجدول/);
    assert.doesNotMatch(calls.at(-1).payload.text, /📖/);
  });

  await suite.test('out-of-scope replies, spelling variants and unknown AI-free fallback remain deterministic in workerd', async () => {
    assert.equal((await post(message(23, 'private', 'اشرح شبكات'))).status, 200);
    assert.equal(calls.at(-1).payload.text, 'حبيبي آني دعبول، مختص بجدول محاضرات المرحلة الثالثة 😂❤️');
    assert.equal((await post(message(24, 'private', 'شنو عدنة بكرى؟'))).status, 200);
    assert.match(calls.at(-1).payload.text, /السبت/);
    assert.match(calls.at(-1).payload.text, /2026-10-17/);
    assert.equal((await post(message(2024, 'private', 'جدول مادة الكيمياء باجر'))).status, 200);
    assert.match(calls.at(-1).payload.text, /حدّد اليوم أو المادة/);
    assert.doesNotMatch(calls.at(-1).payload.text, /📖/);
  });

  await suite.test('plural laboratory queries and temporary time questions work without AI in workerd', async () => {
    assert.equal((await post(message(30, 'private', 'شنو عدنا مختبرات يوم الاحد مجوعة b'))).status, 200);
    const labs = calls.at(-1).payload.text;
    assert.equal((labs.match(/📖/g) ?? []).length, 2);
    assert.match(labs, /شبكات الحاسبة \| مجموعة B \| م2/);
    assert.match(labs, /برمجة تطبيقات الموبايل \| مجموعة B \| م1/);
    assert.doesNotMatch(labs, /مجموعة A|معمارية/);
    assert.equal((await post(message(31, 'private', 'ايمتى المحاضرة الجاية مجموعة B'))).status, 200);
    const next = calls.at(-1).payload.text;
    assert.match(next, /المحاضرة الجاية/);
    assert.match(next, /الأوقات مؤقتة وتقديرية بتوقيت بغداد/);
    assert.match(next, /تبدي بعد/);
    assert.doesNotMatch(next, /مجموعة A/);
    assert.equal((await post(message(32, 'private', '/start'))).status, 200);
    assert.deepEqual(calls.at(-1).payload.reply_markup,{remove_keyboard:true});
  });

  await suite.test('next-week group B laboratories are dated and filtered in private and Inline Mode', async () => {
    const text = 'شنو المختبرات اللي عدنا مجموعة B الأسبوع الجاي';
    assert.equal((await post(message(40, 'private', text))).status, 200);
    const laboratories = calls.at(-1).payload.text;
    assert.match(laboratories, /مختبرات الأسبوع الجاي \| مجموعة B/);
    assert.match(laboratories, /2026-10-18 إلى 2026-10-24/);
    assert.equal((laboratories.match(/📖/g) ?? []).length, 5);
    for (const expected of [
      'الأحد 2026-10-18', 'الاثنين 2026-10-19', 'الثلاثاء 2026-10-20', 'الأربعاء 2026-10-21',
      'شبكات الحاسبة | مجموعة B | م2',
      'برمجة تطبيقات الموبايل | مجموعة B | م1',
      'رسومات (عملي) | مجموعة B | م2',
      'البرمجة المرئية | مجموعة B | م1',
      'المترجمات (عملي) | مجموعة B | م2',
      'د. عصام + د. رقية اياد',
    ]) assert.ok(laboratories.includes(expected), expected);
    assert.doesNotMatch(laboratories, /مجموعة A|معمارية|\(نظري\)|ضمن الجدول الأسبوعي|الخميس 2026-10-22|ماكو محاضرات مجدولة/);

    assert.equal((await post({
      update_id: 41, inline_query: { id: 'runtime-inline-week-41', from: PERSON, query: text, offset: '' },
    })).status, 200);
    const answer = calls.at(-1);
    assert.equal(answer.method, 'answerInlineQuery');
    assert.equal(answer.payload.results.length, 1);
    assert.equal(answer.payload.results[0].input_message_content.message_text, laboratories);
  });

  await suite.test('a natural next-lecture and lecturer question selects only the next actual slot', async () => {
    const monday = new Miniflare(convertV4MiniflareOptions({
      modules: true, compatibilityDate: '2026-10-13',
      script: fixedClockScript('2026-10-19T06:00:00.000Z'),
      bindings: { TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET_TOKEN: SECRET },
      outboundService,
    }));
    try {
      const result = await monday.dispatchFetch('https://runtime.test/webhook', {
        method: 'POST', headers: {
          'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET,
        },
        body: JSON.stringify(message(50, 'private', 'شنو عندي المحاضرة اللي تجي واسم الدكتور مالتها؟')),
      });
      assert.equal(result.status, 200);
      const next = calls.at(-1);
      assert.equal(next.method, 'sendMessage');
      assert.match(next.payload.text, /المحاضرة الجاية/);
      assert.match(next.payload.text, /الاثنين 2026-10-19/);
      assert.match(next.payload.text, /هسه 09:00 بتوقيت بغداد/);
      assert.match(next.payload.text, /تبدي بعد 30 دقيقة/);
      assert.match(next.payload.text, /09:30–10:30/);
      assert.match(next.payload.text, /البرمجة المرئية \(نظري\)/);
      assert.match(next.payload.text, /د\. سعد عدنان/);
      assert.equal((next.payload.text.match(/📖/g) ?? []).length, 1);
      assert.doesNotMatch(next.payload.text, /رسومات|المترجمات|د\. شموس|المحاضرة الأولى|المحاضرة الثالثة/);
    } finally { await monday.dispose(); }
  });

  await suite.test('student-name requests deliver a real PDF multipart file privately and to the same group topic', async () => {
    const before = calls.length;
    assert.equal((await post(message(60, 'private', 'دزلي أسماء الطلاب', 160))).status, 200);
    const privateCalls = calls.slice(before);
    // getMe is already cached in this isolate; no AI or database binding exists.
    assert.deepEqual(privateCalls.map(call => call.method), ['sendDocument']);
    const privateFile = privateCalls[0].payload;
    assert.equal(privateFile.chat_id, '101');
    assert.equal(JSON.parse(privateFile.reply_parameters).message_id, 160);
    assert.equal(privateFile.document.type, 'application/pdf');
    assert.match(privateFile.document.name, /[\u0600-\u06ff].*\.pdf$/u);
    assert.equal(privateFile.document.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.match(privateFile.document.bytes.subarray(-100).toString('ascii'), /%%EOF/);
    assert.ok(privateFile.document.bytes.length > 1000);

    const group = message(61, 'supergroup', 'دعبول دزلي أسماء الطلاب', 161);
    group.message.message_thread_id = 77;
    const groupBefore = calls.length;
    assert.equal((await post(group)).status, 200);
    assert.deepEqual(calls.slice(groupBefore).map(call => call.method), ['sendDocument']);
    const groupFile = calls.at(-1).payload;
    assert.equal(groupFile.chat_id, '-101');
    assert.equal(groupFile.message_thread_id, '77');
    assert.equal(JSON.parse(groupFile.reply_parameters).message_id, 161);
    assert.equal(groupFile.document.name, privateFile.document.name);
    assert.equal(groupFile.document.type, 'application/pdf');
    assert.deepEqual(groupFile.document.bytes, privateFile.document.bytes);

    const silentBefore = calls.length;
    assert.equal((await post(message(62, 'supergroup', 'دزلي أسماء الطلاب'))).status, 200);
    assert.equal(calls.length, silentBefore);
  });

  await suite.test('outbound redirects are rejected and their Location is never followed', async () => {
    apiMode = 'redirect';
    const before = calls.length;
    assert.equal((await post(inline(14))).status, 503);
    assert.equal(calls.length, before + 1);
    apiMode = 'success';
  });

  await suite.test('expired inline queries are acknowledged to avoid futile retries', async () => {
    apiMode = 'expired';
    assert.equal((await post(inline(15))).status, 200);
    apiMode = 'success';
  });

  await suite.test('a repeated update does not send the schedule twice in one isolate', async () => {
    const before = calls.length;
    assert.equal((await post(message(10, 'private', 'شعدنا باجر', 42))).status, 200);
    assert.equal(calls.length, before);
  });
});
