import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  stdin: {
    contents: "export { handleUpdate } from './src/bot'; export { EventStore } from './src/event-store'; export { TelegramClient } from './src/telegram'; export { dispatchEventJobs } from './src/event-jobs';",
    resolveDir: ROOT,
  },
  bundle: true, format: 'esm', platform: 'node', write: false,
});
const { handleUpdate, EventStore, TelegramClient, dispatchEventJobs } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const NOW = Date.parse('2026-10-16T09:00:00Z'); // Friday at noon in Baghdad.
const STUDENT = 101;
const OTHER = 102;
const OWNER = 900;
const BOT = 901;
const TARGET = -100123456;
const GROUP = -100654321;
const TOKEN = `123456789:${'synthetic'.repeat(5)}`;
const SETUP_TOKEN = 'synthetic_owner_bootstrap_token_0123456789_abcd';
const SETUP_HASH = createHash('sha256').update(SETUP_TOKEN).digest('hex');
const DETAILS = 'الاثنين الجاي عدنا امتحان مترجمات بالمحاضرتين الأولى والثانية لا يشمل الفصل الخامس';
const COMPLETE = `${DETAILS} للكل`;
const user = id => ({ id, is_bot: false, first_name: 'Synthetic' });
const chat = id => ({ id, type: id > 0 ? 'private' : 'supergroup' });

function telegramMock() {
  const calls = [];
  const failedDestinations = [];
  let nextMessageId = 1000;
  const permissions = { type: 'supergroup', ownerStatus: 'administrator', botStatus: 'administrator', canPost: true };
  const telegram = new TelegramClient(TOKEN, async (url, init) => {
    // This injected fetcher handles every Telegram request. It never uses fetch or a network fallback.
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.telegram.org');
    assert.equal(parsed.pathname.split('/')[1], `bot${TOKEN}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    const method = parsed.pathname.split('/').at(-1);
    const payload = JSON.parse(init.body);
    if (method === 'sendMessage' && failedDestinations[0] === payload.chat_id) {
      failedDestinations.shift();
      calls.push({ method, payload, errorCode: 503 });
      return Response.json({ ok: false, error_code: 503 }, { status: 503 });
    }
    let result;
    if (method === 'getMe') result = { id: BOT, is_bot: true, username: 'SyntheticDaaboolBot' };
    else if (method === 'getChat') result = { id: payload.chat_id, type: permissions.type, title: 'Synthetic <class>' };
    else if (method === 'getChatMember') result = payload.user_id === BOT
      ? { status: permissions.botStatus, can_post_messages: permissions.canPost }
      : { status: permissions.ownerStatus };
    else if (['sendMessage', 'sendPhoto', 'sendDocument'].includes(method)) result = { message_id: nextMessageId++ };
    else if (['answerCallbackQuery', 'editMessageText', 'editMessageCaption', 'editMessageReplyMarkup', 'deleteMessage'].includes(method)) result = true;
    else assert.fail(`Unmocked Telegram method: ${method}`);
    calls.push({ method, payload, result });
    return Response.json({ ok: true, result });
  });
  return { telegram, calls, permissions, failNextSend(chatId) { failedDestinations.push(chatId); } };
}

test('student contribution workflows use actual local D1 and synthetic Telegram requests', { timeout: 120_000 }, async suite => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-13',
    script: 'export default { fetch(){ return new Response("local contributions test"); } }',
    d1Databases: { DB: 'contributions-workflow-test' },
  }));
  suite.after(async () => { await mf.dispose(); });
  const db = await mf.getD1Database('DB');
  const migrations = (await readdir(resolve(ROOT, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const migration = await readFile(resolve(ROOT, 'migrations', name), 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }

  async function fixture({ configured = true, profile = false } = {}) {
    await db.prepare('DROP TRIGGER IF EXISTS synthetic_save_failure').run();
    await db.batch(['profiles', 'sessions', 'events', 'outbox', 'delivery_slots', 'processed_updates', 'publication_receipts', 'publication_locks'].map(table => db.prepare(`DELETE FROM ${table}`)));
    await db.prepare('UPDATE settings SET owner_uid=NULL,target_chat_id=NULL,target_thread_id=NULL WHERE singleton=1').run();
    const store = new EventStore(db);
    if (configured) await store.saveSettings({ ownerUid: OWNER, targetChatId: TARGET, targetThreadId: 9 });
    if (profile) await store.saveProfile(STUDENT, 'أحمد علي', NOW);
    const mock = telegramMock();
    const env = { DB: db, CONTRIBUTIONS_ENABLED: 'true', OWNER_SETUP_TOKEN_HASH: SETUP_HASH };
    let nextUpdateId = 1;
    let nextInputId = 10;
    let currentTime = NOW;
    const f = {
      ...mock, env, store, lastUpdate: null,
      setTime(value) { currentTime = value; },
      async retry(update = f.lastUpdate) { await handleUpdate(update, mock.telegram, new Date(currentTime), env); },
      async message(text, options = {}) {
        const id = nextInputId++;
        const author = options.userId ?? STUDENT;
        const chatId = options.chatId ?? author;
        const message = {
          message_id: id, from: user(author), chat: chat(chatId),
          ...(text === null ? {} : { text }),
          ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }),
          ...(options.replyTo === undefined ? {} : { reply_to_message: { message_id: options.replyTo, from: { id: BOT, is_bot: true }, chat: chat(chatId) } }),
          ...(options.media ?? {}),
        };
        const update = { update_id: nextUpdateId++, message };
        f.lastUpdate = update;
        await handleUpdate(update, mock.telegram, new Date(currentTime), env);
        return update;
      },
      async callback(data, options = {}) {
        const author = options.userId ?? OWNER;
        const chatId = options.chatId ?? author;
        const update = { update_id: nextUpdateId++, callback_query: {
          id: `synthetic-callback-${nextUpdateId}`, from: user(author), chat_instance: 'synthetic-instance', data,
          message: { message_id: options.messageId ?? 700, from: { id: BOT, is_bot: true }, chat: chat(chatId),
            ...(options.threadId === undefined ? {} : { message_thread_id: options.threadId }) },
        } };
        f.lastUpdate = update;
        await handleUpdate(update, mock.telegram, new Date(currentTime), env);
      },
      prompt(chatId = STUDENT) {
        const sent = mock.calls.findLast(call => call.method === 'sendMessage' && call.result?.message_id && call.payload.chat_id === chatId && call.payload.reply_markup?.force_reply);
        assert.ok(sent, `Expected a force-reply prompt for ${chatId}`);
        return sent.result.message_id;
      },
      async reply(text, options = {}) { return f.message(text, { replyTo: f.prompt(options.chatId ?? options.userId ?? STUDENT), ...options }); },
      messages(chatId) { return mock.calls.filter(call => call.method === 'sendMessage' && (chatId === undefined || call.payload.chat_id === chatId)); },
      async events() {
        const rows = await db.prepare('SELECT id FROM events ORDER BY submitted_at,id').all();
        return Promise.all(rows.results.map(row => store.getEvent(row.id)));
      },
      async submit(text = COMPLETE, options = {}) {
        await f.message(`دعبول ${text}`, options);
        let session = await store.getSession(options.userId ?? STUDENT, options.chatId ?? options.userId ?? STUDENT, options.threadId ?? null);
        if (session?.state === 'name') await f.reply('أحمد علي', options);
        const events = await f.events();
        assert.ok(events.length, 'Expected a persisted pending contribution');
        return events.at(-1);
      },
      async approve(event) {
        f.setTime(currentTime + 60_000);
        await f.callback(`evt:approve:${event.id}:${event.revision}`);
        return store.getEvent(event.id);
      },
      async drain() { return dispatchEventJobs(store, mock.telegram, currentTime, { sleep: async () => {} }); },
    };
    return f;
  }

  async function seedNotes(f, notes) {
    for (const [index, note] of notes.entries()) {
      await f.store.createEvent({
        id: note.id, authorId: OTHER, authorName: 'سارة أحمد', sourceChatId: OTHER,
        status: note.status ?? 'approved', submittedAt: NOW + index,
        ...(note.status === 'pending' ? {} : { approvedAt: NOW }),
        draft: {
          kind: note.kind ?? 'exam', course: note.course ?? 'compilers', teacher: null,
          date: note.date === undefined ? '2026-10-19' : note.date,
          dateUnspecified: note.date === null, time: null, slots: [],
          audience: note.audience ?? 'all', details: note.details,
          attachment: note.attachment ?? null,
        },
      });
    }
    return f.events();
  }

  function assertQueryReplies(response, input, chatId, threadId) {
    const useful = response.filter(call => ['sendMessage', 'sendDocument', 'sendPhoto'].includes(call.method));
    assert.ok(useful.length, 'A study query must produce a useful reply');
    for (const call of useful) {
      assert.equal(call.payload.chat_id, chatId);
      assert.equal(call.payload.message_thread_id, threadId);
      assert.equal(call.payload.reply_parameters.message_id, input.message.message_id);
      assert.ok(!call.payload.reply_markup?.force_reply, 'Queries must not open a contribution form');
    }
    return useful.filter(call => call.method === 'sendMessage').map(call => call.payload.text).join('\n');
  }

  await suite.test('bare wake word, linked details, audience and first name lead to one pending review', async () => {
    const f = await fixture();
    await f.message('دعبول');
    assert.match(f.messages(STUDENT).at(-1).payload.text, /خير شكو/);
    assert.deepEqual(f.messages(STUDENT).at(-1).payload.reply_markup, { force_reply: true, selective: false });
    await f.reply(DETAILS);
    let session = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(session.state, 'audience');
    assert.equal(session.draft.details, DETAILS);
    assert.equal(session.draft.date, '2026-10-19');
    assert.deepEqual(session.draft.slots, [1, 2]);
    await f.reply('الكل');
    assert.equal((await f.store.getSession(STUDENT, STUDENT)).state, 'name');
    await f.reply('أحمد علي');
    const [event] = await f.events();
    assert.equal(event.status, 'pending');
    assert.equal(event.authorName, 'أحمد علي');
    assert.equal(event.draft.audience, 'all');
    assert.ok(event.draft.details.includes(DETAILS));
    assert.equal((await f.store.getProfile(STUDENT)).name, 'أحمد علي');
    assert.equal(f.messages(TARGET).length, 0);
    assert.match(f.messages(STUDENT).at(-1).payload.text, /بانتظار اعتماد الأدمن/);
    const review = f.messages(OWNER).at(-1).payload;
    assert.match(review.text, /لا يشمل الفصل الخامس/);
    assert.equal(review.reply_markup.inline_keyboard[0][0].callback_data, `evt:approve:${event.id}:1`);
  });

  await suite.test('owner and ordinary students receive an unprefixed private tomorrow question without opening a contribution', async () => {
    const f = await fixture();
    for (const userId of [OWNER, STUDENT]) {
      const before = f.calls.length;
      const question = await f.message('شعدنا باجر', { userId });
      const replies = f.calls.slice(before).filter(call => call.method === 'sendMessage');
      assert.equal(replies.length, 2, 'A dated availability question returns its official timetable and approved-note result');
      for (const reply of replies) {
        assert.equal(reply.payload.chat_id, userId);
        assert.equal(reply.payload.reply_parameters.message_id, question.message.message_id);
        assert.equal(reply.payload.reply_markup?.force_reply, undefined);
      }
      assert.match(replies[0].payload.text, /السبت/);
      assert.match(replies[0].payload.text, /2026-10-17/);
      assert.match(replies[1].payload.text, /ما عندي تبليغات معتمدة مطابقة لهاليوم/);
      assert.equal(await f.store.getSession(userId, userId), null);
      assert.equal(await f.store.getProfile(userId), null);
    }
    assert.deepEqual(await f.events(), []);
  });

  await suite.test('bare availability followed by bare exam lists approved upcoming notes and original files without opening a form', async () => {
    const f = await fixture();
    const original = await seedNotes(f, [
      { id: 'screenshot-exam', details: 'اقروا المحاضرة الأولى لحد الليكسل مو داخله', attachment: { kind: 'document', fileId: 'synthetic-screenshot-exam-original', fileName: 'exam-original.pdf' } },
      { id: 'screenshot-quiz', kind: 'quiz', date: '2026-10-20', details: 'الكوز يشمل الفصل الثاني فقط', attachment: { kind: 'document', fileId: 'synthetic-screenshot-quiz-original', fileName: 'quiz-original.pdf' } },
      { id: 'screenshot-homework', kind: 'homework', date: '2026-10-21', details: 'واجب حل التمرين الرابع' },
      { id: 'screenshot-past', date: '2026-10-15', details: 'تبليغ انتهى أمس' },
      { id: 'screenshot-pending', status: 'pending', details: 'تبليغ ينتظر الموافقة', attachment: { kind: 'photo', fileId: 'synthetic-screenshot-pending-photo' } },
    ]);
    for (const [index, question] of ['شعدنا؟', 'امتحان'].entries()) {
      f.setTime(NOW + index * 120_000);
      const before = f.calls.length;
      const input = await f.message(question);
      f.setTime(NOW + index * 120_000 + 60_000);
      await f.drain();
      const response = f.calls.slice(before);
      const text = assertQueryReplies(response, input, STUDENT);
      assert.match(text, /لحد الليكسل مو داخله/);
      assert.ok(response.some(call => call.method === 'sendDocument' && call.payload.document === 'synthetic-screenshot-exam-original'));
      if (index === 0) {
        assert.match(text, /الكوز يشمل الفصل الثاني فقط/);
        assert.match(text, /واجب حل التمرين الرابع/);
        assert.ok(response.some(call => call.method === 'sendDocument' && call.payload.document === 'synthetic-screenshot-quiz-original'));
      } else {
        assert.doesNotMatch(text, /الكوز يشمل الفصل الثاني فقط|واجب حل التمرين الرابع/);
        assert.ok(!response.some(call => call.method === 'sendDocument' && call.payload.document === 'synthetic-screenshot-quiz-original'));
      }
      assert.doesNotMatch(text, /تبليغ انتهى أمس|تبليغ ينتظر الموافقة|بأي اسم ننسب|هاي لأي مادة|حدد نوع/);
      assert.ok(!response.some(call => call.method === 'sendPhoto'));
      assert.deepEqual(await f.events(), original);
      assert.equal(await f.store.getSession(STUDENT, STUDENT), null);
      assert.equal(await f.store.getProfile(STUDENT), null);
    }
  });

  await suite.test('dated Iraqi and Fusha availability combines the official day with approved notes from that date only', async () => {
    const f = await fixture();
    const original = await seedNotes(f, [
      { id: 'dated-tomorrow', date: '2026-10-17', details: 'مطلوب باچر فقط', attachment: { kind: 'document', fileId: 'synthetic-dated-tomorrow-original', fileName: 'tomorrow.pdf' } },
      { id: 'dated-today', date: '2026-10-16', details: 'مطلوب اليوم فقط' },
      { id: 'dated-later', date: '2026-10-18', details: 'مطلوب بعد باچر' },
      { id: 'dated-past', date: '2026-10-15', details: 'مطلوب منتهي' },
      { id: 'dated-undated', date: null, details: 'مطلوب موعده غير محدد' },
      { id: 'dated-pending', date: '2026-10-17', status: 'pending', details: 'مطلوب غير معتمد' },
    ]);
    for (const [index, question] of ['ماذا لدينا غداً؟', 'باجر شعدنا؟'].entries()) {
      f.setTime(NOW + index * 120_000);
      const before = f.calls.length;
      const input = await f.message(question);
      f.setTime(NOW + index * 120_000 + 60_000); await f.drain();
      const response = f.calls.slice(before);
      const text = assertQueryReplies(response, input, STUDENT);
      assert.match(text, /السبت/);
      assert.match(text, /2026-10-17/);
      assert.match(text, /ما عدكم محاضرات مجدولة/);
      assert.match(text, /مطلوب باچر فقط/);
      assert.doesNotMatch(text, /مطلوب اليوم فقط|مطلوب بعد باچر|مطلوب منتهي|مطلوب موعده غير محدد|مطلوب غير معتمد/);
      assert.ok(response.some(call => call.method === 'sendDocument' && call.payload.document === 'synthetic-dated-tomorrow-original'));
      assert.deepEqual(await f.events(), original);
      assert.equal(await f.store.getSession(STUDENT, STUDENT), null);
      assert.equal(await f.store.getProfile(STUDENT), null);
    }
  });

  await suite.test('a dated group B agenda includes shared and B notes and the exact B timetable without A alternatives', async () => {
    const f = await fixture();
    const original = await seedNotes(f, [
      { id: 'group-agenda-B', date: '2026-10-18', audience: 'B', details: 'تبليغ خاص بمجموعة بي' },
      { id: 'group-agenda-shared', date: '2026-10-18', details: 'تبليغ مشترك للمجموعتين' },
      { id: 'group-agenda-A', date: '2026-10-18', audience: 'A', details: 'تبليغ حصري لمجموعة اي' },
      { id: 'group-agenda-other-date', date: '2026-10-19', audience: 'B', details: 'تبليغ بي ليوم آخر' },
    ]);
    f.setTime(Date.parse('2026-10-17T09:00:00Z'));
    const before = f.calls.length;
    const input = await f.message('شنو عندنا باجر مجموعة B؟');
    f.setTime(Date.parse('2026-10-17T09:01:00Z')); await f.drain();
    const text = assertQueryReplies(f.calls.slice(before), input, STUDENT);
    assert.match(text, /الأحد/);
    assert.match(text, /2026-10-18/);
    assert.match(text, /معمارية الحاسبة \(نظري\)/);
    assert.match(text, /شبكات الحاسبة \| مجموعة B \| م2/);
    assert.match(text, /برمجة تطبيقات الموبايل \| مجموعة B \| م1/);
    assert.match(text, /تبليغ خاص بمجموعة بي/);
    assert.match(text, /تبليغ مشترك للمجموعتين/);
    assert.doesNotMatch(text, /مجموعة A|تبليغ حصري لمجموعة اي|تبليغ بي ليوم آخر/);
    assert.deepEqual(await f.events(), original);
    assert.equal(await f.store.getSession(STUDENT, STUDENT), null);
    assert.equal(await f.store.getProfile(STUDENT), null);
  });

  await suite.test('unwaked and actual-mention declarations cannot create profiles, sessions or notes; the literal wake word can', async () => {
    const f = await fixture();
    const declaration = 'عدنا امتحان مترجمات الاثنين الجاي للكل الفصل الثالث';
    for (const context of [{}, { prefix: '@SyntheticDaaboolBot ' }, { prefix: '@SyntheticDaaboolBot ', chatId: GROUP, threadId: 11 }]) {
      const text = `${context.prefix ?? ''}${declaration}`;
      const options = { ...(context.chatId === undefined ? {} : { chatId: context.chatId, threadId: context.threadId }) };
      await f.message(text, options);
      await f.message(null, { ...options, media: { photo: [{ file_id: 'synthetic-unwaked-photo', width: 200, height: 200 }], caption: text } });
      assert.equal(await f.store.getSession(STUDENT, context.chatId ?? STUDENT, context.threadId ?? null), null);
      assert.equal(await f.store.getProfile(STUDENT), null);
      assert.deepEqual(await f.events(), []);
      assert.equal(f.messages(OWNER).length, 0);
      assert.equal(f.messages(TARGET).length, 0);
      assert.ok(!f.messages().some(call => call.payload.reply_markup?.force_reply));
    }
    await f.message(null, { media: { photo: [{ file_id: 'synthetic-waked-photo', width: 200, height: 200 }], caption: `دعبول ${declaration}` } });
    assert.equal((await f.store.getSession(STUDENT, STUDENT)).state, 'name');
    await f.reply('علي حسن');
    const [event] = await f.events();
    assert.equal(event.status, 'pending');
    assert.equal(event.authorName, 'علي حسن');
    assert.equal(event.draft.attachment.fileId, 'synthetic-waked-photo');
    assert.equal((await f.store.getProfile(STUDENT)).name, 'علي حسن');
    assert.equal(f.messages(OWNER).length, 1);
    assert.equal(f.messages(TARGET).length, 0);
  });

  await suite.test('a bare wake starts a form whose linked kind, course, date, group and name answers need no repeated wake word', async () => {
    const f = await fixture();
    await f.message('دعبول');
    assert.equal((await f.store.getSession(STUDENT, STUDENT)).state, 'collect');
    for (const [answer, expectedState] of [
      ['امتحان', 'course'], ['مترجمات', 'date'], ['الاثنين الجاي', 'audience'], ['مجموعة B', 'name'],
    ]) {
      await f.reply(answer);
      assert.equal((await f.store.getSession(STUDENT, STUDENT)).state, expectedState, answer);
      assert.deepEqual(await f.events(), []);
    }
    await f.reply('علي حسن');
    const [event] = await f.events();
    assert.equal(event.status, 'pending');
    assert.equal(event.authorName, 'علي حسن');
    assert.equal(event.draft.kind, 'exam');
    assert.equal(event.draft.course, 'compilers');
    assert.equal(event.draft.date, '2026-10-19');
    assert.equal(event.draft.audience, 'B');
    const savedSession = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(savedSession.state, 'collect');
    assert.equal(savedSession.eventId, event.id);
    assert.equal(savedSession.eventRevision, event.revision);
  });

  await suite.test('generic and typed questions preserve private and group-topic drafts; only a plain linked kind fills the kind', async () => {
    for (const options of [{}, { chatId: GROUP, threadId: 11 }]) {
      const f = await fixture();
      const destination = options.chatId ?? STUDENT;
      const originalEvents = await seedNotes(f, [{ id: 'draft-query-exam', details: 'نص امتحان معتمد للاستعلام' }]);
      await f.message('دعبول', options);
      const collecting = await f.store.getSession(STUDENT, destination, options.threadId ?? null);
      assert.equal(collecting.state, 'collect');
      for (const [index, question] of ['شعدنا؟', 'شعدنا باجر؟', 'شنو امتحانات المترجمات؟', 'امتحان؟'].entries()) {
        f.setTime(NOW + index * 120_000);
        const before = f.calls.length;
        const input = await f.message(question, { ...options, replyTo: collecting.promptIds.at(-1) });
        f.setTime(NOW + index * 120_000 + 60_000); await f.drain();
        const text = assertQueryReplies(f.calls.slice(before), input, destination, options.threadId);
        assert.doesNotMatch(text, /هاي لأي مادة|بأي اسم ننسب|بانتظار اعتماد الأدمن/);
        if (question !== 'شعدنا باجر؟') assert.match(text, /نص امتحان معتمد للاستعلام/);
        assert.deepEqual(await f.store.getSession(STUDENT, destination, options.threadId ?? null), collecting, question);
        assert.deepEqual(await f.events(), originalEvents);
        assert.equal(await f.store.getProfile(STUDENT), null);
      }
      await f.message('امتحان', { ...options, replyTo: collecting.promptIds.at(-1) });
      const choosingCourse = await f.store.getSession(STUDENT, destination, options.threadId ?? null);
      assert.equal(choosingCourse.state, 'course');
      assert.equal(choosingCourse.draft.kind, 'exam');
      f.setTime(NOW + 600_000);
      const before = f.calls.length;
      const input = await f.message('شنو لازم اقرا؟', { ...options, replyTo: choosingCourse.promptIds.at(-1) });
      f.setTime(NOW + 660_000); await f.drain();
      assert.match(assertQueryReplies(f.calls.slice(before), input, destination, options.threadId), /نص امتحان معتمد للاستعلام/);
      assert.deepEqual(await f.store.getSession(STUDENT, destination, options.threadId ?? null), choosingCourse);
      assert.deepEqual(await f.events(), originalEvents);
      assert.equal(await f.store.getProfile(STUDENT), null);
    }
  });

  await suite.test('an unprefixed question linked to the name prompt preserves the draft and never becomes the student name', async () => {
    const f = await fixture();
    await f.message(`دعبول ${COMPLETE}`);
    const original = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(original.state, 'name');
    for (const [question, expected] of [
      ['شعدنا باجر', /السبت/],
      ['شعدنا امتحانات؟', /ما عندي/],
      ['مختبرات الأسبوع الجاي مجموعة B', /مختبرات الأسبوع الجاي.*مجموعة B/s],
      ['المحاضرة اللي تجي', /المحاضرة الجاية/],
      ['المحاضرة التي تليها', /المحاضرة الجاية/],
    ]) {
      const before = f.calls.length;
      const input = await f.message(question, { replyTo: original.promptIds.at(-1) });
      const answer = f.calls.slice(before).find(call => call.method === 'sendMessage' && call.payload.chat_id === STUDENT);
      assert.ok(answer);
      assert.match(answer.payload.text, expected);
      assert.equal(answer.payload.reply_parameters.message_id, input.message.message_id);
      assert.deepEqual(await f.store.getSession(STUDENT, STUDENT), original);
      assert.equal(await f.store.getProfile(STUDENT), null);
      assert.deepEqual(await f.events(), []);
    }
    await f.message('أحمد علي', { replyTo: original.promptIds.at(-1) });
    const [event] = await f.events();
    assert.equal(event.status, 'pending');
    assert.equal(event.authorName, 'أحمد علي');
    assert.equal(event.draft.details, COMPLETE);
  });

  await suite.test('linked course and date answers still fill the same draft after an independent private timetable question', async () => {
    const f = await fixture({ profile: true });
    await f.message('دعبول عدنا امتحان للكل');
    let session = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(session.state, 'course');
    await f.reply('شعدنا باجر');
    assert.deepEqual(await f.store.getSession(STUDENT, STUDENT), session);
    await f.reply('مترجمات');
    session = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(session.state, 'date');
    assert.equal(session.draft.course, 'compilers');
    await f.reply('الاثنين الجاي بالمحاضرتين الأولى والثانية لحد الليكسل مو داخله');
    const [event] = await f.events();
    assert.equal(event.status, 'pending');
    assert.equal(event.draft.course, 'compilers');
    assert.equal(event.draft.date, '2026-10-19');
    assert.deepEqual(event.draft.slots, [1, 2]);
    assert.match(event.draft.details, /لحد الليكسل مو داخله/);
  });

  for (const kind of ['photo', 'document']) await suite.test(`${kind} accompanies review and only admin approval publishes it with attribution`, async () => {
    const f = await fixture({ profile: true });
    const media = kind === 'photo'
      ? { photo: [{ file_id: 'synthetic-small-photo', width: 20, height: 20 }, { file_id: 'synthetic-large-photo', file_unique_id: 'synthetic-photo-unique', width: 200, height: 200 }] }
      : { document: { file_id: 'synthetic-document', file_unique_id: 'synthetic-document-unique', file_name: 'synthetic-note.pdf' } };
    const event = await f.submit(COMPLETE, { media });
    const fileId = kind === 'photo' ? 'synthetic-large-photo' : 'synthetic-document';
    const method = kind === 'photo' ? 'sendPhoto' : 'sendDocument';
    assert.equal(event.draft.attachment.fileId, fileId);
    assert.equal(event.draft.attachment.kind, kind);
    const review = f.calls.filter(call => call.payload.chat_id === OWNER);
    assert.deepEqual(review.map(call => call.method), [method, 'sendMessage']);
    assert.equal(review[0].payload[kind], fileId);
    assert.equal(f.calls.filter(call => call.payload.chat_id === TARGET).length, 0);
    const approved = await f.approve(event);
    assert.equal(approved.status, 'approved');
    const publication = f.calls.filter(call => call.payload.chat_id === TARGET);
    assert.deepEqual(publication.map(call => call.method), ['sendMessage', method]);
    assert.match(publication[0].payload.text, /أحمد علي/);
    assert.equal(publication[0].payload.message_thread_id, 9);
    assert.equal(publication[1].payload[kind], fileId);
    assert.equal(publication[1].payload.reply_parameters.message_id, publication[0].result.message_id);
    assert.equal(approved.publishedMessageId, publication[0].result.message_id);
    assert.deepEqual(await f.store.weeklyContributors(NOW, NOW + 7 * 86_400_000), [{ authorId: STUDENT, authorName: 'أحمد علي', count: 1 }]);
  });

  await suite.test('another user, chat, topic and unlinked replies remain silent and cannot consume a draft', async () => {
    const f = await fixture();
    await f.message('دعبول', { chatId: GROUP, threadId: 11 });
    const prompt = f.prompt(GROUP);
    const original = await f.store.getSession(STUDENT, GROUP, 11);
    const before = f.calls.length;
    await f.message(COMPLETE, { userId: OTHER, chatId: GROUP, threadId: 11, replyTo: prompt });
    await f.message(COMPLETE, { chatId: GROUP, threadId: 12, replyTo: prompt });
    await f.message(COMPLETE, { chatId: GROUP - 1, threadId: 11, replyTo: prompt });
    await f.message(COMPLETE, { chatId: GROUP, threadId: 11, replyTo: prompt + 999 });
    await f.message(COMPLETE, { chatId: GROUP, threadId: 11 });
    assert.equal(f.calls.length, before);
    assert.deepEqual(await f.store.getSession(STUDENT, GROUP, 11), original);
    assert.deepEqual(await f.events(), []);
  });

  await suite.test('a saved profile is reused for a later contribution without another name question', async () => {
    const f = await fixture();
    await f.submit();
    f.setTime(NOW + 60_000);
    await f.submit('الثلاثاء الجاي واجب رسومات للكل حل التمرين الثاني');
    const events = await f.events();
    assert.equal(events.length, 2);
    assert.ok(events.every(event => event.authorName === 'أحمد علي'));
    assert.equal(f.messages(STUDENT).filter(call => /بأي اسم ننسب/u.test(call.payload.text)).length, 1);
  });

  await suite.test('a missing-date answer also preserves its details, explicit time and lecture slot', async () => {
    const f = await fixture({ profile: true });
    await f.message('دعبول امتحان مترجمات للكل');
    assert.equal((await f.store.getSession(STUDENT, STUDENT)).state, 'date');
    const answer = 'الاثنين الجاي بالمحاضرة الثانية الساعة 9 صباحاً يشمل الفصل الثالث عدا التمرين الخامس';
    await f.reply(answer);
    const [event] = await f.events();
    assert.equal(event.draft.date, '2026-10-19');
    assert.equal(event.draft.time, '09:00');
    assert.deepEqual(event.draft.slots, [2]);
    assert.match(event.draft.details, /امتحان مترجمات للكل/);
    assert.ok(event.draft.details.includes(answer));
  });

  await suite.test('foreign student/admin controls and stale revisions cannot alter or publish a contribution', async () => {
    const f = await fixture({ profile: true });
    const event = await f.submit();
    await f.callback(`evt:approve:${event.id}:${event.revision}`, { userId: OTHER });
    await f.callback(`evt:edit:${event.id}:${event.revision}`, { userId: OTHER });
    await f.callback(`evt:cancel:${event.id}:${event.revision}`, { userId: OWNER });
    await f.callback(`evt:approve:${event.id}:${event.revision + 1}`);
    assert.deepEqual(await f.store.getEvent(event.id), event);
    assert.equal(f.messages(TARGET).length, 0);
    assert.equal(f.calls.filter(call => call.method === 'answerCallbackQuery').length, 4);
    assert.match(f.calls.at(-1).payload.text, /نسخة قديمة/);
  });

  await suite.test('repeated approvals publish once and never credit the author twice', async () => {
    const f = await fixture({ profile: true });
    const pending = await f.submit();
    const approved = await f.approve(pending);
    await f.callback(`evt:approve:${pending.id}:${pending.revision}`);
    await f.callback(`evt:approve:${approved.id}:${approved.revision}`);
    assert.equal(f.messages(TARGET).length, 1);
    assert.equal((await f.store.getEvent(pending.id)).revision, approved.revision);
    assert.equal((await f.store.weeklyContributors(NOW, NOW + 86_400_000))[0].count, 1);
  });

  await suite.test('a reworded duplicate dated note is rejected and earns no extra credit', async () => {
    const f = await fixture({ profile: true });
    const first = await f.submit();
    await f.approve(first);
    await f.store.saveProfile(OTHER, 'سارة أحمد', NOW);
    const duplicate = await f.submit('امتحان مترجمات الاثنين الجاي للكل المحاضرتين 1 و 2 استثناء الفصل الخامس', { userId: OTHER });
    await f.approve(duplicate);
    const rejected = await f.store.getEvent(duplicate.id);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.duplicateOf, first.id);
    assert.equal(f.messages(TARGET).length, 1);
    const credits = await f.store.weeklyContributors(NOW, NOW + 86_400_000);
    assert.deepEqual(credits.map(value => [value.authorId, value.count]), [[STUDENT, 1]]);
  });

  await suite.test('invalid or conflicting event filters request clarification without listing unrelated approved notes or media', async () => {
    const f = await fixture({ profile: true });
    const pending = await f.submit(COMPLETE, { media: { document: { file_id: 'synthetic-unrelated-approved-file', file_name: 'unrelated.pdf' } } });
    await f.approve(pending);
    const queries = [
      'دعبول شنو امتحانات 31/02/2026؟',
      'دعبول شنو امتحانات مجموعة C؟',
      'دعبول شنو امتحانات مترجمات ورسومات؟',
    ];
    for (const query of queries) {
      const before = f.calls.length;
      await f.message(query);
      const response = f.calls.slice(before);
      assert.deepEqual(response.map(call => call.method), ['sendMessage'], query);
      const clarification = response[0].payload;
      assert.equal(clarification.chat_id, STUDENT);
      assert.ok(clarification.text.length <= 300, 'Clarification should be short');
      assert.doesNotMatch(clarification.text, /أحمد علي|لا يشمل الفصل الخامس|ما عندي ملاحظات معتمدة/);
      assert.match(clarification.text, /(?:حدد|تاريخ|موعد|مجموع|ماد|واحد|واضح|صحيح)/u);
    }

    await f.message('دعبول');
    const originalSession = await f.store.getSession(STUDENT, STUDENT);
    let before = f.calls.length;
    await f.reply('شنو امتحانات مجموعة C؟');
    assert.deepEqual(f.calls.slice(before).map(call => call.method), ['sendMessage']);
    assert.doesNotMatch(f.calls.at(-1).payload.text, /أحمد علي|بانتظار اعتماد الأدمن/);
    assert.deepEqual(await f.store.getSession(STUDENT, STUDENT), originalSession);

    await f.message('دعبول');
    const resumedSession = await f.store.getSession(STUDENT, STUDENT);
    before = f.calls.length;
    await f.reply('شنو امتحانات الاثنين الجاي؟');
    const linkedQuery = f.calls.slice(before);
    assert.deepEqual(linkedQuery.map(call => call.method).sort(), ['sendDocument', 'sendMessage']);
    assert.match(linkedQuery.find(call => call.method === 'sendMessage').payload.text, /لا يشمل الفصل الخامس/);
    assert.equal(linkedQuery.find(call => call.method === 'sendDocument').payload.document, 'synthetic-unrelated-approved-file');
    assert.deepEqual(await f.store.getSession(STUDENT, STUDENT), resumedSession);
    assert.equal((await f.events()).length, 1, 'A linked event question must not create a pending contribution');
    assert.equal((await f.store.listApproved()).length, 1, 'Clarification must leave the approved contribution intact');
  });

  await suite.test('media-only replies retain the Telegram file while a later description completes the draft', async () => {
    for (const mode of ['linked-reply', 'wake-caption']) {
      const f = await fixture({ profile: true });
      const media = { document: { file_id: 'synthetic-first-file', file_name: 'first.pdf' } };
      if (mode === 'linked-reply') {
        await f.message('دعبول');
        await f.reply(null, { media });
      } else await f.message(null, { media: { ...media, caption: 'دعبول' } });
      const session = await f.store.getSession(STUDENT, STUDENT);
      assert.equal(session.state, 'collect');
      assert.equal(session.draft.attachment.fileId, 'synthetic-first-file');
      assert.deepEqual(await f.events(), []);
      await f.reply(COMPLETE);
      const [event] = await f.events();
      assert.equal(event.draft.attachment.fileId, 'synthetic-first-file');
      assert.equal(event.draft.details, COMPLETE);
      assert.equal(event.status, 'pending');
    }
  });

  await suite.test('editing an approved note preserves its academic metadata and requests approval again', async () => {
    const f = await fixture({ profile: true });
    const pending = await f.submit(`${COMPLETE} الساعة 08:30`);
    const approved = await f.approve(pending);
    const latestAuthorButtons = f.messages(STUDENT).findLast(call => call.payload.reply_markup?.inline_keyboard)?.payload.reply_markup.inline_keyboard.flat();
    const editButton = latestAuthorButtons?.find(button => button.callback_data === `evt:edit:${pending.id}:${pending.revision}`);
    assert.ok(editButton, 'The original author card must remain usable after approval');
    await f.callback(editButton.callback_data, { userId: OTHER, chatId: STUDENT });
    assert.deepEqual(await f.store.getEvent(approved.id), approved);
    assert.equal(await f.store.getSession(OTHER, STUDENT), null);
    await f.callback(editButton.callback_data, { userId: STUDENT });
    assert.equal((await f.store.getSession(STUDENT, STUDENT)).eventRevision, approved.revision);
    const editPrompt = f.messages(STUDENT).findLast(call => call.payload.reply_markup?.force_reply).payload;
    assert.ok(editPrompt.reply_parameters.message_id === approved.sourceMessageId || editPrompt.reply_markup.selective === false,
      'A private callback prompt must target the student message or use a non-selective force reply');
    await f.reply('التصحيح: لا يشمل الفصل السادس بدل الفصل الخامس');
    const edited = await f.store.getEvent(approved.id);
    assert.equal(edited.status, 'pending');
    assert.equal(edited.approvedAt, approved.approvedAt);
    for (const field of ['kind', 'course', 'teacher', 'date', 'dateUnspecified', 'time', 'slots', 'audience', 'attachment']) {
      assert.deepEqual(edited.draft[field], approved.draft[field], `Editing must retain ${field}`);
    }
    assert.match(edited.draft.details, /الفصل السادس/);
    assert.equal(edited.sourceChatId, approved.sourceChatId);
    assert.equal(edited.sourceMessageId, approved.sourceMessageId);
    await f.drain();
    assert.deepEqual(await f.store.listApproved(), []);
    assert.ok(f.calls.some(call => call.method === 'editMessageText' && call.payload.message_id === approved.publishedMessageId));
    f.setTime(NOW + 8 * 86_400_000);
    const reapproved = await f.approve(edited);
    assert.equal(reapproved.status, 'approved');
    assert.equal(reapproved.approvedAt, approved.approvedAt, 'Reapproval must preserve the first approval credit timestamp');
    assert.deepEqual(await f.store.weeklyContributors(NOW + 7 * 86_400_000, NOW + 14 * 86_400_000), [],
      'Editing an earlier contribution must not grant credit again in a later week');
    assert.equal(f.messages(TARGET).length, 1, 'Reapproval edits the original public message');
  });

  await suite.test('adding an attachment preserves metadata and invalidates approval until reviewed again', async () => {
    const f = await fixture({ profile: true });
    const pending = await f.submit(COMPLETE, { chatId: GROUP, threadId: 11 });
    const approved = await f.approve(pending);
    await f.callback(`evt:attach:${pending.id}:${pending.revision}`, { userId: STUDENT, chatId: GROUP, threadId: 11 });
    assert.equal((await f.store.getSession(STUDENT, GROUP, 11)).eventRevision, approved.revision);
    const attachmentPrompt = f.messages(GROUP).findLast(call => call.payload.reply_markup?.force_reply).payload;
    assert.equal(attachmentPrompt.reply_parameters.message_id, approved.sourceMessageId,
      'A selective group callback prompt must reply to the original student message');
    const caption = 'صورة الاستثناء: لا يشمل الفصل السادس';
    await f.reply(null, { chatId: GROUP, threadId: 11, media: { caption, photo: [{ file_id: 'synthetic-added-photo', width: 80, height: 80 }] } });
    const attached = await f.store.getEvent(approved.id);
    assert.equal(attached.status, 'pending');
    assert.equal(attached.approvedAt, approved.approvedAt);
    assert.deepEqual({ ...attached.draft, attachment: null, details: approved.draft.details }, approved.draft);
    assert.ok(attached.draft.details.includes(approved.draft.details));
    assert.ok(attached.draft.details.includes(caption));
    assert.equal(attached.draft.attachment.fileId, 'synthetic-added-photo');
    assert.deepEqual(await f.store.listApproved(), []);
    await f.approve(attached);
    assert.equal((await f.store.getEvent(attached.id)).status, 'approved');
    assert.ok(f.calls.some(call => call.method === 'sendPhoto' && call.payload.chat_id === TARGET && call.payload.photo === 'synthetic-added-photo'));
    assert.equal(f.messages(TARGET).length, 1);
  });

  await suite.test('author cancellation removes an approved note from queries and updates its public message', async () => {
    const f = await fixture({ profile: true });
    const pending = await f.submit();
    const approved = await f.approve(pending);
    await f.callback(`evt:cancel:${pending.id}:${pending.revision}`, { userId: STUDENT });
    assert.equal((await f.store.getEvent(approved.id)).status, 'cancelled');
    assert.deepEqual(await f.store.listApproved(), []);
    await f.drain();
    const publicEdit = f.calls.findLast(call => call.method === 'editMessageText' && call.payload.chat_id === TARGET);
    assert.ok(publicEdit);
    assert.equal(publicEdit.payload.message_id, approved.publishedMessageId);
    assert.match(publicEdit.payload.text, /ملغاة/);
    assert.deepEqual(await f.store.weeklyContributors(NOW, NOW + 86_400_000), []);
  });

  await suite.test('admin correction reaches the original author and a linked correction preserves metadata', async () => {
    const f = await fixture({ profile: true });
    const event = await f.submit(COMPLETE, { chatId: GROUP, threadId: 11 });
    await f.callback(`evt:correct:${event.id}:${event.revision}`);
    await f.reply('الفصل السادس مستثنى أيضاً', { userId: OWNER });
    const correction = f.messages(GROUP).at(-1);
    assert.match(correction.payload.text, /الأدمن طلب تصحيح/);
    assert.equal(correction.payload.message_thread_id, 11);
    assert.equal(correction.payload.reply_parameters.message_id, event.sourceMessageId);
    await f.reply('لا يشمل الفصلين الخامس والسادس', { chatId: GROUP, threadId: 11 });
    const corrected = await f.store.getEvent(event.id);
    assert.equal(corrected.status, 'pending');
    assert.equal(corrected.draft.date, event.draft.date);
    assert.equal(corrected.draft.course, event.draft.course);
    assert.deepEqual(corrected.draft.slots, [1, 2]);
    assert.match(corrected.draft.details, /الفصلين الخامس والسادس/);

    const own = await fixture();
    await own.store.saveProfile(OWNER, 'سارة أحمد', NOW);
    const ownEvent = await own.submit(COMPLETE, { userId: OWNER });
    await own.callback(`evt:correct:${ownEvent.id}:${ownEvent.revision}`);
    await own.reply('صحح الاستثناء', { userId: OWNER });
    assert.ok(await own.store.getSession(OWNER, OWNER), 'An owner correcting their own note must retain the author reply session');
    await own.reply('لا يشمل الفصل السادس', { userId: OWNER });
    assert.equal((await own.store.getEvent(ownEvent.id)).status, 'pending');
  });

  await suite.test('correction retries recover failed admin prompts and retain instructions until author delivery succeeds', async () => {
    const f = await fixture({ profile: true });
    const event = await f.submit();
    const transient = error => error.name === 'TelegramError' && error.code === 503 && error.retryable === true;

    f.failNextSend(OWNER);
    await assert.rejects(f.callback(`evt:correct:${event.id}:${event.revision}`), transient);
    const failedCallback = f.lastUpdate;
    const needsChanges = await f.store.getEvent(event.id);
    assert.equal(needsChanges.status, 'needs_changes');
    assert.equal(needsChanges.revision, event.revision + 1);
    await f.retry(failedCallback);
    const adminSession = await f.store.getSession(OWNER, OWNER);
    assert.equal(adminSession.state, 'admin_correction');
    assert.equal(adminSession.eventId, event.id);
    assert.equal(adminSession.eventRevision, needsChanges.revision);
    assert.equal((await f.store.getEvent(event.id)).revision, needsChanges.revision, 'Retry must reopen the correction without applying the transition twice');

    const instructions = 'تأكد من الاستثناء: الفصل الخامس غير مشمول';
    f.failNextSend(STUDENT);
    await assert.rejects(f.reply(instructions, { userId: OWNER }), transient);
    const failedInstructions = f.lastUpdate;
    const retained = await f.store.getSession(OWNER, OWNER);
    assert.equal(retained.state, 'admin_correction');
    assert.equal(retained.eventId, event.id);
    assert.equal(f.messages(STUDENT).filter(call => call.result?.message_id && call.payload.text.includes(instructions)).length, 0);

    await f.retry(failedInstructions);
    assert.equal(await f.store.getSession(OWNER, OWNER), null);
    const authorSession = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(authorSession.eventId, event.id);
    assert.equal(authorSession.eventRevision, needsChanges.revision);
    assert.equal(authorSession.draft.details, COMPLETE);
    const authorPrompt = f.messages(STUDENT).findLast(call => call.result?.message_id && call.payload.reply_markup?.force_reply);
    assert.ok(authorPrompt.payload.text.includes(instructions));
    assert.equal(authorPrompt.payload.reply_parameters.message_id, event.sourceMessageId);
    const sentCount = f.calls.length;
    await f.retry(failedInstructions);
    assert.equal(f.calls.length, sentCount, 'A completed instruction retry must not send a second correction prompt');

    await f.reply('لا يشمل الفصل الخامس ولا الفصل السادس');
    const corrected = await f.store.getEvent(event.id);
    assert.equal(corrected.status, 'pending');
    assert.equal(corrected.sourceMessageId, event.sourceMessageId);
    assert.equal(corrected.draft.date, event.draft.date);
    assert.match(corrected.draft.details, /الفصل السادس/);
    assert.equal(f.calls.filter(call => call.errorCode === 503).length, 2);
  });

  await suite.test('ten idle minutes silence replies, but a wake word resumes the draft within 24 hours', async () => {
    const f = await fixture({ profile: true });
    await f.message(`دعبول ${DETAILS}`);
    const original = await f.store.getSession(STUDENT, STUDENT);
    f.setTime(NOW + 10 * 60_000 + 1);
    const count = f.calls.length;
    await f.reply('الكل');
    assert.equal(f.calls.length, count);
    assert.deepEqual(await f.events(), []);
    assert.deepEqual(await f.store.getSession(STUDENT, STUDENT), original);
    await f.message('دعبول');
    assert.equal((await f.store.getSession(STUDENT, STUDENT)).state, 'audience');
    await f.reply('الكل');
    const [event] = await f.events();
    assert.ok(event.draft.details.includes(DETAILS));
    assert.equal(event.draft.date, '2026-10-19');
    assert.deepEqual(event.draft.slots, [1, 2]);
  });

  await suite.test('a draft past 24 hours starts fresh and cannot accept its old prompt', async () => {
    const f = await fixture({ profile: true });
    await f.message(`دعبول ${DETAILS}`);
    const oldPrompt = f.prompt();
    f.setTime(NOW + 86_400_000 + 1);
    await f.message('دعبول');
    const fresh = await f.store.getSession(STUDENT, STUDENT);
    assert.equal(fresh.state, 'collect');
    assert.equal(fresh.draft.details, '');
    const count = f.calls.length;
    await f.message('الكل', { replyTo: oldPrompt });
    assert.equal(f.calls.length, count);
    assert.deepEqual(await f.events(), []);
  });

  await suite.test('owner bootstrap requires the matching hash, private chat, and an unused claim', async () => {
    const f = await fixture({ configured: false });
    await f.message(`دعبول إعداد ${'x'.repeat(45)}`, { userId: OWNER });
    assert.equal((await f.store.getSettings()).ownerUid, null);
    await f.message(`دعبول إعداد ${SETUP_TOKEN}`, { userId: OWNER, chatId: GROUP });
    assert.equal((await f.store.getSettings()).ownerUid, null);
    await f.message(`دعبول إعداد ${SETUP_TOKEN}`, { userId: OWNER });
    assert.equal((await f.store.getSettings()).ownerUid, OWNER);
    const picker = f.messages(OWNER).at(-1).payload.reply_markup;
    assert.deepEqual(picker, {remove_keyboard:true});
    await f.message(`دعبول إعداد ${SETUP_TOKEN}`, { userId: OTHER });
    assert.equal((await f.store.getSettings()).ownerUid, OWNER);
    assert.match(f.messages(OTHER).at(-1).payload.text, /غير صالح أو مستخدم/);
  });

  await suite.test('owner chat picker rejects foreign requests and missing admin/channel rights before saving a destination', async () => {
    const f = await fixture({ configured: false });
    await f.store.saveSettings({ ownerUid: OWNER });
    await f.message('دعبول الوجهة', { userId: OWNER });
    const shared = (request_id = 741) => ({ chat_shared: { request_id, chat_id: TARGET, title: 'Synthetic destination' } });
    const count = f.calls.length;
    await f.message(null, { userId: OTHER, media: shared() });
    await f.message(null, { userId: OWNER, media: shared(999) });
    assert.equal(f.calls.length, count);
    f.permissions.ownerStatus = 'member';
    await f.message(null, { userId: OWNER, media: shared() });
    assert.equal((await f.store.getSettings()).targetChatId, null);
    f.permissions.ownerStatus = 'administrator';
    f.permissions.type = 'channel';
    f.permissions.canPost = false;
    await f.message(null, { userId: OWNER, media: shared(742) });
    assert.equal((await f.store.getSettings()).targetChatId, null);
    f.permissions.canPost = true;
    await f.message(null, { userId: OWNER, media: shared(742) });
    assert.deepEqual(await f.store.getSettings(), { ownerUid: OWNER, targetChatId: TARGET, targetThreadId: null });
    assert.match(f.messages(OWNER).at(-1).payload.text, /Synthetic &lt;class&gt;/);
    assert.deepEqual(f.messages(OWNER).at(-1).payload.reply_markup, { remove_keyboard: true });
  });

  await suite.test('destination cutover keeps old public cards in their original chat while new notes publish to the chosen chat', async () => {
    const f = await fixture({ profile: true });
    const original = await f.submit();
    const published = await f.approve(original);
    const nextTarget = -100777888;
    await f.message('دعبول الوجهة', { userId: OWNER });
    await f.message(null, { userId: OWNER, media: { chat_shared: { request_id: 741, chat_id: nextTarget } } });
    assert.deepEqual(await f.store.getSettings(), { ownerUid: OWNER, targetChatId: nextTarget, targetThreadId: null });

    f.setTime(NOW + 120_000);
    const beforeOldEdit = f.calls.length;
    await f.callback(`evt:edit:${original.id}:${original.revision}`, { userId: STUDENT });
    await f.reply('استثناء إضافي: لا يشمل الفصل السادس');
    const edited = await f.store.getEvent(original.id);
    assert.equal(edited.status, 'pending');
    assert.equal(edited.publishedMessageId, published.publishedMessageId);
    await f.approve(edited);
    f.setTime(NOW + 240_000);
    await f.callback(`evt:cancel:${original.id}:${original.revision}`, { userId: STUDENT });
    assert.equal((await f.store.getEvent(original.id)).status, 'cancelled');
    const oldCardEdits = f.calls.slice(beforeOldEdit).filter(call => call.method === 'editMessageText');
    assert.ok(oldCardEdits.length >= 3, 'Edit, reapproval and cancellation must update the original public card');
    for (const call of oldCardEdits) {
      assert.equal(call.payload.chat_id, TARGET);
      assert.equal(call.payload.message_thread_id, 9);
      assert.equal(call.payload.message_id, published.publishedMessageId);
    }
    assert.equal(f.messages(nextTarget).length, 0, 'An existing public card must not be recreated in the new destination');

    const next = await f.submit('الثلاثاء الجاي واجب رسومات للكل حل التمرين الثاني');
    const nextPublished = await f.approve(next);
    assert.equal(nextPublished.status, 'approved');
    const newCard = f.messages(nextTarget);
    assert.equal(newCard.length, 1);
    assert.equal(newCard[0].result.message_id, nextPublished.publishedMessageId);
    assert.equal(newCard[0].payload.message_thread_id, undefined);
    assert.match(newCard[0].payload.text, /حل التمرين الثاني/);
    assert.equal(f.messages(TARGET).length, 1, 'The old destination receives no new contribution after cutover');
  });

  await suite.test('natural questions return only upcoming approved requirements and the original attachment without creating contributions', async () => {
    const f = await fixture({ profile: true });
    const draft = { kind: 'exam', course: 'compilers', teacher: null, date: '2026-10-19', dateUnspecified: false,
      time: null, slots: [1, 2], audience: 'all', details: 'اقروا المحاضرة الأولى والثانية لحد الليكسل مو داخله',
      attachment: { kind: 'document', fileId: 'synthetic-study-original', fileName: 'lecture.pdf' } };
    await f.store.createEvent({ id: 'upcoming-exam', authorId: STUDENT, authorName: 'أحمد علي', sourceChatId: STUDENT,
      draft, status: 'approved', submittedAt: NOW, approvedAt: NOW });
    await f.store.createEvent({ id: 'upcoming-quiz', authorId: STUDENT, authorName: 'أحمد علي', sourceChatId: STUDENT,
      draft: { ...draft, kind: 'quiz', date: '2026-10-20', details: 'الكوز من الفصل الثالث فقط', attachment: null }, status: 'approved', submittedAt: NOW, approvedAt: NOW });
    await f.store.createEvent({ id: 'upcoming-homework', authorId: OTHER, authorName: 'سارة أحمد', sourceChatId: OTHER,
      draft: { ...draft, kind: 'homework', date: '2026-10-21', details: 'حل التمرين الرابع', attachment: null }, status: 'approved', submittedAt: NOW, approvedAt: NOW });
    await f.store.createEvent({ id: 'past-exam', authorId: STUDENT, authorName: 'أحمد علي', sourceChatId: STUDENT,
      draft: { ...draft, date: '2026-10-15', details: 'انتهى موعد هذا الامتحان', attachment: null }, status: 'approved', submittedAt: NOW - 86_400_000, approvedAt: NOW - 86_400_000 });
    await f.store.createEvent({ id: 'unapproved-note', authorId: OTHER, authorName: 'سارة أحمد', sourceChatId: OTHER,
      draft: { ...draft, details: 'معلومة بعد ما اعتمدها الأدمن', attachment: { kind: 'photo', fileId: 'synthetic-unapproved-photo' } }, submittedAt: NOW });
    const queries = [
      ['دعبول شعدنا امتحانات او كوزات؟', [draft.details, 'الكوز من الفصل الثالث فقط'], ['حل التمرين الرابع']],
      ['دعبول شنو لازم اقره للمترجمات؟', [draft.details, 'الكوز من الفصل الثالث فقط', 'حل التمرين الرابع'], []],
      ['دعبول شعدنا واجبات؟', ['حل التمرين الرابع'], [draft.details, 'الكوز من الفصل الثالث فقط']],
    ];
    for (const [index, [question, included, excluded]] of queries.entries()) {
      f.setTime(NOW + index * 120_000);
      const before = f.calls.length;
      await f.message(question);
      f.setTime(NOW + index * 120_000 + 60_000);
      await f.drain();
      const response = f.calls.slice(before).filter(call => call.payload.chat_id === STUDENT);
      const text = response.filter(call => call.method === 'sendMessage').map(call => call.payload.text).join('\n');
      for (const value of included) assert.ok(text.includes(value), `${question}: missing ${value}`);
      for (const value of [...excluded, 'انتهى موعد هذا الامتحان', 'معلومة بعد ما اعتمدها الأدمن']) assert.ok(!text.includes(value), `${question}: leaked ${value}`);
      assert.doesNotMatch(text, /بانتظار اعتماد الأدمن|بأي اسم ننسب|هاي لأي مادة/);
      if (included.includes(draft.details)) assert.ok(response.some(call => call.method === 'sendDocument' && call.payload.document === draft.attachment.fileId));
      assert.ok(!response.some(call => call.method === 'sendPhoto' && call.payload.photo === 'synthetic-unapproved-photo'));
      assert.equal((await f.events()).length, 5, 'Questions must not add or alter student notes');
      assert.equal(await f.store.getSession(STUDENT, STUDENT), null, 'A normal reminder query must not open a contribution draft');
    }
  });

  await suite.test('reminder pagination keeps course, type and group filters and makes later approved notes accessible', async () => {
    const f = await fixture({ profile: true });
    const draft = { kind: 'exam', course: 'compilers', teacher: null, date: '2026-10-19', dateUnspecified: false,
      time: null, slots: [], audience: 'B', details: '', attachment: null };
    for (let index = 0; index < 4; index++) await f.store.createEvent({ id: `filtered-exam-${index}`, authorId: STUDENT,
      authorName: 'أحمد علي', sourceChatId: STUDENT, status: 'approved', submittedAt: NOW + index, approvedAt: NOW,
      draft: { ...draft, date: `2026-10-${19 + index}`, details: `مطلوب مترجمات مجموعة B رقم ${index + 1}` } });
    await f.store.createEvent({ id: 'unrelated-pagination', authorId: OTHER, authorName: 'سارة أحمد', sourceChatId: OTHER,
      status: 'approved', submittedAt: NOW, approvedAt: NOW,
      draft: { ...draft, course: 'graphics', audience: 'A', details: 'هذا واجب رسومات مجموعة A', kind: 'homework' } });
    await f.message('دعبول شعدنا امتحانات مترجمات مجموعة B؟');
    f.setTime(NOW + 60_000); await f.drain();
    const navigation = f.messages(STUDENT).findLast(call => call.payload.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('evq:')));
    assert.ok(navigation, 'Four matching reminders need a more button');
    const next = navigation.payload.reply_markup.inline_keyboard.flat().find(button => /المزيد/u.test(button.text));
    assert.equal(next.callback_data, 'evq:e:compilers:-:B:3');
    const before = f.calls.length;
    await f.callback(next.callback_data, { userId: STUDENT, messageId: navigation.result.message_id });
    f.setTime(NOW + 120_000); await f.drain();
    const nextPage = f.calls.slice(before);
    assert.ok(nextPage.some(call => call.method === 'sendMessage' && call.payload.text.includes('مطلوب مترجمات مجموعة B رقم 4')));
    assert.ok(nextPage.some(call => call.method === 'editMessageText' && call.payload.message_id === navigation.result.message_id && call.payload.text.includes('4–4 من 4')));
    assert.ok(!nextPage.some(call => String(call.payload.text).includes('هذا واجب رسومات مجموعة A')));
    assert.equal((await f.events()).length, 5);
  });

  await suite.test('next-week exam questions use inclusive Baghdad bounds and return only approved requirements with original files', async () => {
    const f = await fixture({ profile: true });
    const draft = { kind: 'exam', course: 'compilers', teacher: null, date: '2026-10-18', dateUnspecified: false,
      time: null, slots: [1, 2], audience: 'all', details: 'الأولى والثانية لحد الليكسل مو داخله',
      attachment: { kind: 'document', fileId: 'synthetic-next-week-file', fileName: 'required.pdf' } };
    const notes = [
      ['week-first', draft, 'approved'],
      ['week-last', { ...draft, date: '2026-10-24', details: 'مطلوب امتحان السبت', attachment: { kind: 'photo', fileId: 'synthetic-next-week-photo' } }, 'approved'],
      ['week-before', { ...draft, date: '2026-10-17', details: 'خارج الفترة قبلها', attachment: null }, 'approved'],
      ['week-after', { ...draft, date: '2026-10-25', details: 'خارج الفترة بعدها', attachment: null }, 'approved'],
      ['week-undated', { ...draft, date: null, dateUnspecified: true, details: 'موعد غير محدد', attachment: null }, 'approved'],
      ['week-pending', { ...draft, details: 'لم يعتمد بعد', attachment: { kind: 'document', fileId: 'synthetic-pending-week-file' } }, 'pending'],
      ['week-quiz', { ...draft, kind: 'quiz', details: 'كوز مختلف عن الامتحان', attachment: null }, 'approved'],
    ];
    for (const [id, value, status] of notes) await f.store.createEvent({ id, authorId: STUDENT,
      authorName: 'أحمد علي', sourceChatId: STUDENT, submittedAt: NOW, approvedAt: status === 'approved' ? NOW : null, status, draft: value });
    for (const [index, question] of ['شنو عدنا امتحانات الأسبوع الجاي؟', 'دزلي ملف امتحان المترجمات الأسبوع الجاي'].entries()) {
      f.setTime(NOW + index * 120_000);
      const before = f.calls.length;
      await f.message(question);
      f.setTime(NOW + index * 120_000 + 60_000); await f.drain();
      const response = f.calls.slice(before).filter(call => call.payload.chat_id === STUDENT);
      const text = response.filter(call => call.method === 'sendMessage').map(call => call.payload.text).join('\n');
      assert.match(text, /2026-10-18.*2026-10-24/);
      assert.ok(text.includes(draft.details));
      assert.ok(text.includes('مطلوب امتحان السبت'));
      assert.doesNotMatch(text, /خارج الفترة|موعد غير محدد|لم يعتمد بعد|كوز مختلف/);
      assert.ok(response.some(call => call.method === 'sendDocument' && call.payload.document === draft.attachment.fileId));
      assert.ok(response.some(call => call.method === 'sendPhoto' && call.payload.photo === 'synthetic-next-week-photo'));
      assert.ok(!response.some(call => call.payload.document === 'synthetic-pending-week-file'));
      assert.equal(await f.store.getSession(STUDENT, STUDENT), null);
      assert.equal((await f.events()).length, notes.length);
    }
  });

  await suite.test('week pagination preserves absolute date bounds after the calendar changes and rejects malformed ranges', async () => {
    const f = await fixture({ profile: true });
    const draft = { kind: 'exam', course: 'compilers', teacher: null, date: '2026-10-18', dateUnspecified: false,
      time: null, slots: [], audience: 'B', details: '', attachment: null };
    for (let index = 0; index < 4; index++) await f.store.createEvent({ id: `week-page-${index}`, authorId: STUDENT,
      authorName: 'أحمد علي', sourceChatId: STUDENT, submittedAt: NOW + index, approvedAt: NOW, status: 'approved',
      draft: { ...draft, date: `2026-10-${18 + index}`, details: `مطلوب الأسبوع المختار ${index + 1}` } });
    await f.store.createEvent({ id: 'following-week', authorId: STUDENT, authorName: 'أحمد علي', sourceChatId: STUDENT,
      submittedAt: NOW, approvedAt: NOW, status: 'approved', draft: { ...draft, date: '2026-10-25', details: 'أسبوع آخر لا يدخل' } });
    await f.message('شنو امتحانات المترجمات مجموعة B الأسبوع الجاي؟');
    f.setTime(NOW + 60_000); await f.drain();
    const navigation = f.messages(STUDENT).findLast(call => call.payload.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('evq:')));
    assert.ok(navigation);
    const next = navigation.payload.reply_markup.inline_keyboard.flat().find(button => /المزيد/u.test(button.text));
    assert.equal(next.callback_data, 'evq:e:compilers:2026-10-18~2026-10-24:B:3');
    assert.ok(Buffer.byteLength(next.callback_data) <= 64);
    f.setTime(NOW + 7 * 86_400_000);
    const before = f.calls.length;
    await f.callback(next.callback_data, { userId: STUDENT, messageId: navigation.result.message_id });
    f.setTime(NOW + 7 * 86_400_000 + 60_000); await f.drain();
    const response = f.calls.slice(before).filter(call => call.payload.chat_id === STUDENT);
    assert.ok(response.some(call => call.method === 'sendMessage' && call.payload.text.includes('مطلوب الأسبوع المختار 4')));
    assert.ok(response.some(call => call.method === 'editMessageText' && /2026-10-18.*2026-10-24/s.test(call.payload.text)));
    assert.ok(!response.some(call => String(call.payload.text).includes('أسبوع آخر لا يدخل')));
    const malformed = f.calls.length;
    await f.callback('evq:e:compilers:2026-10-18~2026-10-25:B:3', { userId: STUDENT });
    assert.deepEqual(f.calls.slice(malformed).map(call => call.method), ['answerCallbackQuery']);
    assert.match(f.calls.at(-1).payload.text, /الفترة غير صالحة/);
  });

  await suite.test('current-week pagination accepts a Saturday-only suffix and preserves it after the week changes', async () => {
    const f = await fixture({ profile: true });
    const saturday = Date.parse('2026-10-24T09:00:00Z');
    f.setTime(saturday);
    const courses = ['architecture', 'mobile', 'networks', 'compilers'];
    await seedNotes(f, [
      { id: 'past-monday', date: '2026-10-19', course: 'graphics', audience: 'B', details: 'تبليغ الاثنين القديم' },
      ...courses.map((course, index) => ({ id: `saturday-${index}`, date: '2026-10-24', course, audience: 'B', details: `مطلوب السبت ${index}` })),
      { id: 'next-sunday', date: '2026-10-25', course: 'visual', audience: 'B', details: 'تبليغ الأحد التالي لا يدخل' },
    ]);
    await f.message('شعدنا هذا الأسبوع امتحانات مجموعة B؟');
    f.setTime(saturday + 60_000); await f.drain();
    const navigation = f.messages(STUDENT).findLast(call => call.payload.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('evq:')));
    assert.ok(navigation);
    const next = navigation.payload.reply_markup.inline_keyboard.flat().find(button => /المزيد/u.test(button.text));
    assert.equal(next.callback_data, 'evq:e:-:2026-10-24~2026-10-24:B:3');
    assert.ok(!f.calls.some(call => /تبليغ الاثنين القديم|تبليغ الأحد التالي/u.test(String(call.payload.text))));
    const before = f.calls.length;
    f.setTime(Date.parse('2026-10-25T09:00:00Z'));
    await f.callback(next.callback_data, { userId: STUDENT, messageId: navigation.result.message_id });
    f.setTime(Date.parse('2026-10-25T09:01:00Z')); await f.drain();
    const response = f.calls.slice(before);
    assert.ok(response.some(call => call.method === 'sendMessage' && String(call.payload.text).includes('مطلوب السبت 3')));
    assert.ok(response.some(call => call.method === 'editMessageText' && /2026-10-24.*2026-10-24/s.test(call.payload.text)));
    assert.ok(!response.some(call => /تبليغ الاثنين القديم|تبليغ الأحد التالي/u.test(String(call.payload.text))));
    for (const range of ['2026-10-24~2026-10-25', '2026-10-24~2026-10-31']) {
      const invalid = f.calls.length;
      await f.callback(`evq:e:-:${range}:B:3`, { userId: STUDENT });
      assert.deepEqual(f.calls.slice(invalid).map(call => call.method), ['answerCallbackQuery']);
      assert.match(f.calls.at(-1).payload.text, /الفترة غير صالحة/u);
    }
  });

  await suite.test('an empty requested week shows its actual bounds without substituting upcoming notes', async () => {
    const f = await fixture({ profile: true });
    await f.message('شنو عدنا كويزات الأسبوع القادم؟');
    const answer = f.messages(STUDENT).at(-1).payload.text;
    assert.match(answer, /2026-10-18.*2026-10-24/);
    assert.match(answer, /ما عندي تبليغات معتمدة مطابقة/);
    assert.equal(await f.store.getSession(STUDENT, STUDENT), null);
  });

  await suite.test('owner management is an explicit private mode and cannot be opened or mutated by another student', async () => {
    const f = await fixture({ profile: true });
    const approved = await f.approve(await f.submit());
    await f.message('دعبول إدارة التبليغات', { userId: OWNER });
    const panel = f.messages(OWNER).at(-1);
    assert.match(panel.payload.text, /إدارة التبليغات/);
    const manage = panel.payload.reply_markup.inline_keyboard.flat().find(button => button.callback_data === `evt:manage:${approved.id}:${approved.revision}`);
    assert.ok(manage);
    await f.callback(manage.callback_data, { messageId: panel.result.message_id });
    const card = f.calls.findLast(call => call.method === 'editMessageText' && call.payload.chat_id === OWNER);
    assert.ok(card.payload.text.includes(COMPLETE));
    assert.ok(card.payload.reply_markup.inline_keyboard.flat().some(button => button.callback_data === `evt:adminedit:${approved.id}:${approved.revision}`));
    for (const action of ['manage', 'adminedit', 'delete', 'confirmdelete']) {
      const before = f.calls.length;
      await f.callback(`evt:${action}:${approved.id}:${approved.revision}`, { userId: OTHER });
      assert.deepEqual(f.calls.slice(before).map(call => call.method), ['answerCallbackQuery']);
      assert.match(f.calls.at(-1).payload.text, /مو إلك/);
      assert.deepEqual(await f.store.getEvent(approved.id), approved);
    }
    await f.callback(`evt:manage:${approved.id}:${approved.revision}`, { userId: OWNER, chatId: GROUP });
    assert.ok(f.calls.some(call=>call.method==='editMessageText' && call.payload.chat_id===GROUP));
    await f.message('دعبول إدارة التبليغات', { userId: OTHER });
    assert.match(f.messages(OTHER).at(-1).payload.text, /للأدمن|الأدمن بالخاص/);
    assert.equal(await f.store.getSession(OTHER, OTHER), null);
  });

  await suite.test('owner keeps normal student queries during an edit and their ordinary contribution still needs explicit approval', async () => {
    const f = await fixture({ profile: true });
    const approved = await f.approve(await f.submit());
    await f.store.saveProfile(OWNER, 'بلال', NOW);
    const ownerQuestions = [
      ['/start', /آني دعبول/],
      ['شعدنا باجر', /السبت/],
      ['جدول اليوم', /جدول الجمعة|الجمعة/],
      ['المحاضرة الجاية مجموعة A', /المحاضرة|القادمة|الجايه|الجاية|محاضره/],
      ['شعدنا امتحانات؟', /لا يشمل الفصل الخامس/],
    ];
    for (const editing of [false, true]) {
      if (editing) await f.callback(`evt:adminedit:${approved.id}:${approved.revision}`);
      const session = await f.store.getSession(OWNER, OWNER);
      if (editing) assert.equal(session.adminEdit, true);
      for (const [index, [question, expected]] of ownerQuestions.entries()) {
        f.setTime(NOW + (editing ? 300_000 : 0) + index * 60_000);
        const before = f.calls.length;
        await f.message(question, { userId: OWNER, ...(editing && question !== '/start' ? { replyTo: session.promptIds.at(-1) } : {}) });
        f.setTime(NOW + (editing ? 300_000 : 0) + index * 60_000 + 30_000); await f.drain();
        const replies = f.calls.slice(before).filter(call => call.method === 'sendMessage' && call.payload.chat_id === OWNER);
        assert.ok(replies.some(call => expected.test(call.payload.text)), `${editing ? 'Editing: ' : ''}${question}`);
        assert.deepEqual(await f.store.getEvent(approved.id), approved, 'Student questions may never save an administrative edit');
        if (editing) assert.deepEqual(await f.store.getSession(OWNER, OWNER), session, 'Explicit timetable/reminder questions must preserve the open edit');
        if (question === '/start') assert.deepEqual(replies.at(-1).payload.reply_markup, {remove_keyboard:true});
      }
    }
    const before = f.calls.length;
    const own = await f.submit('الثلاثاء الجاي واجب رسومات للكل حل التمرين الثاني', { userId: OWNER });
    assert.equal(own.status, 'pending', 'Owner identity alone must not grant automatic approval');
    assert.equal(own.authorId, OWNER);
    assert.equal(own.authorName, 'بلال');
    const ownerReview = f.calls.slice(before).filter(call => call.method === 'sendMessage' && call.payload.chat_id === OWNER && call.payload.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data === `evt:approve:${own.id}:${own.revision}`));
    assert.equal(ownerReview.length, 1, 'The owner receives the same single moderation card instead of duplicate full receipts');
    assert.equal(f.messages(TARGET).length, 1, 'An ordinary owner submission stays unpublished until they approve it');
    assert.ok(!(await f.store.getSession(OWNER, OWNER)).adminEdit);
    await f.approve(own);
    assert.equal((await f.store.getEvent(own.id)).status, 'approved');
  });

  await suite.test('owner edits another author after publication with exact replacement text and preserves original credit and publication location', async () => {
    const f = await fixture({ profile: true });
    const pending = await f.submit(COMPLETE, { chatId: GROUP, threadId: 11,
      media: { document: { file_id: 'synthetic-admin-original-file', file_name: 'original.pdf' } } });
    const approved = await f.approve(pending);
    await f.store.saveProfile(OWNER, 'بلال', NOW);
    await f.store.saveSettings({ targetChatId: -100888999, targetThreadId: null });
    const panelId = 1600;
    await f.callback(`evt:adminedit:${approved.id}:${approved.revision}`, { messageId: panelId });
    const session = await f.store.getSession(OWNER, OWNER);
    assert.equal(session.adminEdit, true);
    assert.equal(session.eventId, approved.id);
    assert.equal(session.eventRevision, approved.revision);
    const replacement = 'التصحيح: يشمل الفصل الأول فقط، لحد الليكسل مو داخله';
    const before = f.calls.length;
    await f.reply(replacement, { userId: OWNER });
    f.setTime(NOW + 120_000); await f.drain();
    const edited = await f.store.getEvent(approved.id);
    assert.equal(edited.status, 'approved');
    assert.equal(edited.revision, approved.revision + 1);
    assert.equal(edited.draft.details, replacement);
    for (const field of ['kind', 'course', 'teacher', 'date', 'dateUnspecified', 'time', 'slots', 'audience', 'attachment']) assert.deepEqual(edited.draft[field], approved.draft[field], field);
    for (const field of ['authorId', 'authorName', 'sourceChatId', 'sourceThreadId', 'sourceMessageId', 'approvedAt', 'publishedMessageId', 'publishedChatId', 'publishedThreadId']) assert.deepEqual(edited[field], approved[field], field);
    assert.equal(await f.store.getSession(OWNER, OWNER), null);
    const edits = f.calls.slice(before).filter(call => call.method === 'editMessageText');
    assert.ok(edits.some(call => call.payload.chat_id === OWNER && call.payload.message_id === panelId && call.payload.text.includes(replacement)));
    assert.ok(edits.some(call => call.payload.chat_id === TARGET && call.payload.message_id === approved.publishedMessageId && call.payload.text.includes(replacement)));
    assert.equal(f.messages(-100888999).length, 0);
    assert.ok(!f.calls.slice(before).some(call => call.method === 'sendMessage' && call.payload.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data?.startsWith('evt:approve:'))));
    assert.deepEqual(await f.store.weeklyContributors(NOW, NOW + 86_400_000), [{ authorId: STUDENT, authorName: 'أحمد علي', count: 1 }]);
    const staleBefore = f.calls.length;
    for (const action of ['adminedit', 'delete', 'confirmdelete']) await f.callback(`evt:${action}:${approved.id}:${approved.revision}`);
    assert.deepEqual(await f.store.getEvent(approved.id), edited);
    assert.deepEqual(f.calls.slice(staleBefore).map(call => call.method), ['answerCallbackQuery', 'answerCallbackQuery', 'answerCallbackQuery']);
    assert.match(f.calls.at(-1).payload.text, /نسخة قديمة/);

    const retrying = await fixture({ profile: true });
    const retryEvent = await retrying.store.createEvent({ id: 'retry-admin-edit', authorId: STUDENT,
      authorName: approved.authorName, sourceChatId: GROUP, sourceThreadId: 11, sourceMessageId: 123,
      draft: approved.draft, status: 'approved', submittedAt: NOW, approvedAt: NOW });
    await retrying.store.markPublished(retryEvent.id, retryEvent.revision, 2000, TARGET, 9);
    await retrying.callback(`evt:adminedit:${retryEvent.id}:${retryEvent.revision}`, { messageId: 1600 });
    retrying.failNextSend(OWNER);
    const transient = error => error.name === 'TelegramError' && error.code === 503 && error.retryable === true;
    await assert.rejects(retrying.reply(replacement, { userId: OWNER }), transient);
    const failedSave = retrying.lastUpdate;
    const saved = await retrying.store.getEvent(retryEvent.id);
    assert.equal(saved.status, 'approved');
    assert.equal(saved.revision, retryEvent.revision + 1);
    assert.equal(saved.draft.details, replacement);
    assert.equal((await retrying.store.getSession(OWNER, OWNER)).context, `admin-saved:${failedSave.update_id}`);
    await retrying.retry(failedSave);
    assert.equal((await retrying.store.getEvent(retryEvent.id)).revision, saved.revision, 'Retrying a saved administrative edit must not add another revision');
    assert.equal(await retrying.store.getSession(OWNER, OWNER), null);
    const deliveredReceipts = retrying.messages(OWNER).filter(call => call.result?.message_id && /انحفظ تعديلك/u.test(call.payload.text));
    assert.equal(deliveredReceipts.length, 1);
    const completedCalls = retrying.calls.length;
    await retrying.retry(failedSave);
    assert.equal(retrying.calls.length, completedCalls, 'A completed edit retry must remain silent');
  });

  await suite.test('admin deletion asks once, removes approved data immediately, and deletes the original post and Telegram attachment', async () => {
    const f = await fixture({ profile: true });
    const approved = await f.approve(await f.submit(COMPLETE, { media: { document: { file_id: 'synthetic-delete-file', file_name: 'delete.pdf' } } }));
    const originalPublic = f.calls.filter(call => call.payload.chat_id === TARGET && ['sendMessage', 'sendDocument'].includes(call.method));
    assert.equal(originalPublic.length, 2);
    await f.store.saveSettings({ targetChatId: -100888999, targetThreadId: null });
    const before = f.calls.length;
    const managementCard = 1600;
    await f.callback(`evt:delete:${approved.id}:${approved.revision}`, { messageId: managementCard });
    assert.deepEqual(await f.store.getEvent(approved.id), approved, 'Opening delete confirmation must not alter the contribution');
    assert.equal(f.calls.slice(before).filter(call => call.method === 'deleteMessage').length, 0);
    const confirmation = f.calls.findLast(call => call.method === 'editMessageText' && call.payload.message_id === managementCard);
    assert.equal(confirmation.payload.reply_markup.inline_keyboard[0][0].callback_data, `evt:confirmdelete:${approved.id}:${approved.revision}`);
    assert.equal(confirmation.payload.reply_markup.inline_keyboard[0][1].callback_data, `evt:manage:${approved.id}:${approved.revision}`);
    await f.callback(`evt:confirmdelete:${approved.id}:${approved.revision}`, { messageId: managementCard });
    const removed = await f.store.getEvent(approved.id);
    assert.equal(removed.status, 'cancelled');
    assert.ok(removed.publicationDeletionRevision !== null);
    assert.deepEqual(await f.store.listApproved(), []);
    assert.deepEqual(await f.store.weeklyContributors(NOW, NOW + 86_400_000), []);
    f.setTime(NOW + 120_000); await f.drain();
    f.setTime(NOW + 180_000); await f.drain();
    const deleted = f.calls.slice(before).filter(call => call.method === 'deleteMessage' && call.payload.chat_id === TARGET);
    assert.deepEqual(new Set(deleted.map(call => call.payload.message_id)), new Set(originalPublic.map(call => call.result.message_id)));
    assert.ok(!f.calls.slice(before).some(call => call.method === 'deleteMessage' && call.payload.chat_id === -100888999));
    const originalSession = await f.store.getSession(STUDENT, STUDENT);
    await f.callback(`evt:edit:${approved.id}:${approved.revision}`, { userId: STUDENT });
    assert.match(f.calls.at(-1).payload.text, /انحذفت/);
    assert.deepEqual(await f.store.getSession(STUDENT, STUDENT), originalSession, 'Deleted controls must not open an edit or resurrect their historical draft');
    const queryStart = f.calls.length;
    await f.message('دعبول شعدنا امتحانات؟');
    const answer = f.calls.slice(queryStart);
    assert.equal(answer.filter(call => call.method === 'sendDocument').length, 0);
    assert.match(answer.find(call => call.method === 'sendMessage').payload.text, /ما عندي/);
  });

  await suite.test('temporary confirmations expire through tracked bot cleanup while student inputs and useful query results remain', async () => {
    const f = await fixture({ profile: true });
    await f.message('دعبول غير اسمي');
    const namePrompt = f.prompt();
    const nameInput = await f.reply('بلال');
    const receipt = f.messages(STUDENT).at(-1);
    assert.match(receipt.payload.text, /من هسه أنسب/);
    const question = await f.message('دعبول جدول اليوم');
    const timetable = f.messages(STUDENT).at(-1);
    assert.match(timetable.payload.text, /الجمعة/);
    assert.equal(f.calls.filter(call => call.method === 'deleteMessage').length, 0, 'Confirmation must remain visible briefly');
    f.setTime(NOW + 120_000); await f.drain();
    const deleted = f.calls.filter(call => call.method === 'deleteMessage');
    assert.ok(deleted.some(call => call.payload.chat_id === STUDENT && call.payload.message_id === receipt.result.message_id));
    for (const id of [namePrompt, nameInput.message.message_id, question.message.message_id, timetable.result.message_id]) {
      assert.ok(!deleted.some(call => call.payload.chat_id === STUDENT && call.payload.message_id === id), `Useful or student message ${id} must remain`);
    }
    assert.equal((await f.store.getProfile(STUDENT)).name, 'بلال');
  });

  await suite.test('unavailable D1 propagates without pretending a message was saved', async () => {
    const f = await fixture();
    const unavailable = { prepare() { throw new Error('synthetic D1 unavailable'); } };
    await assert.rejects(handleUpdate({ update_id: 500, message: {
      message_id: 500, chat: chat(STUDENT), from: user(STUDENT), text: `دعبول ${COMPLETE}`,
    } }, f.telegram, new Date(NOW), { ...f.env, DB: unavailable }), /synthetic D1 unavailable/);
    assert.equal(f.messages().length, 0);
    assert.deepEqual(await f.events(), []);
  });

  await suite.test('a dated agenda still returns the official timetable during D1 outage and explicitly reports unknown notices', async () => {
    const f = await fixture();
    const unavailable = { prepare() { throw new Error('synthetic D1 unavailable for agenda'); } };
    const input = { update_id: 501, message: {
      message_id: 501, chat: chat(STUDENT), from: user(STUDENT), text: 'ماذا لدينا غداً؟',
    } };
    await handleUpdate(input, f.telegram, new Date(NOW), { ...f.env, DB: unavailable });
    const replies = f.messages(STUDENT);
    assert.equal(replies.length, 2);
    assertQueryReplies(replies, input, STUDENT);
    assert.match(replies[0].payload.text, /السبت/);
    assert.match(replies[0].payload.text, /2026-10-17/);
    assert.match(replies[1].payload.text, /ما قدرت أجيب التبليغات المعتمدة/);
    assert.match(replies[1].payload.text, /ما أگدر أجزم/);
    assert.doesNotMatch(replies[1].payload.text, /ما عندي|ماكو امتحان|ماكو كوز|ماكو واجب|بانتظار اعتماد|انحفظ/);
    assert.deepEqual(await f.events(), []);
    assert.equal(await f.store.getSession(STUDENT, STUDENT), null);
    assert.equal(await f.store.getProfile(STUDENT), null);
  });

  await suite.test('a real D1 insert failure never sends a pending or saved acknowledgement', async () => {
    const f = await fixture({ profile: true });
    await db.prepare("CREATE TRIGGER synthetic_save_failure BEFORE INSERT ON events BEGIN SELECT RAISE(FAIL, 'synthetic D1 quota exceeded'); END").run();
    try {
      await assert.rejects(f.message(`دعبول ${COMPLETE}`), /synthetic D1 quota exceeded/);
      assert.deepEqual(await f.events(), []);
      assert.equal(f.messages().length, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM processed_updates').first()).n, 0);
    } finally {
      await db.prepare('DROP TRIGGER IF EXISTS synthetic_save_failure').run();
    }
  });
});
