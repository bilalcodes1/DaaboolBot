import { isAdmin } from './admin';
import { EventStore, type EventRecord, type SessionRecord, type SessionState } from './event-store';
import { emptyEventDraft, type AttachmentRef, type EventDraft } from './event-types';
import { classifyEventAction, extractEvent, extractEventQuery, isBareEventType, missingEventField, suggestCourseForTeacher } from './event-extract';
import { COURSE_LABELS, EVENT_KIND_LABELS, formatEvent } from './event-format';
import { queueReview, queuePublish, queueStatusUpdate, queueEventQuery, queueMessageCleanup, queueReviewCleanup, queuePublicationDeletion, dispatchEventJobs } from './event-jobs';
import { addCalendarDays, getBaghdadNow } from './calendar';
import { classifyAgendaQuestion, renderAgendaSchedule } from './agenda';
import { escapeHtml } from './format';
import { normalizeArabic } from './input';
import { stripWakeWord, wakeReply } from './personality';
import { classifyLocal } from './nlu-local';
import { renderQuery } from './query';
import { TelegramClient, TelegramError } from './telegram';
import type { Env, TelegramMessage, TelegramUpdate } from './types';
import type { AssistantAiEnv } from './assistant-ai';

export type ContributionEnv = Pick<Env, 'AI' | 'AI_FREE_TIER_CONFIRMED' | 'DB' | 'OWNER_SETUP_TOKEN_HASH' | 'CONTRIBUTIONS_ENABLED'
  | 'PRODUCT_MODE_ENABLED' | 'PRODUCT_AUTOMATION_ENABLED' | 'GROUP_AI_ENABLED' | 'PRODUCT_ALLOWED_GROUP_IDS'> & AssistantAiEnv;
const IDLE = 10 * 60_000;
const DAY = 86_400_000;
const norm = (text: string) => normalizeArabic(text).replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();
const OWNER_REQUEST_GROUP = 741;
const OWNER_REQUEST_CHANNEL = 742;

function attachment(message: TelegramMessage): AttachmentRef | null {
  if (message.document) return {
    kind: 'document', fileId: message.document.file_id,
    ...(message.document.file_unique_id ? { fileUniqueId: message.document.file_unique_id } : {}),
    ...(message.document.file_name ? { fileName: message.document.file_name } : {}),
  };
  const photo = message.photo?.reduce((largest, value) => value.width * value.height > largest.width * largest.height ? value : largest);
  return photo ? { kind: 'photo', fileId: photo.file_id, ...(photo.file_unique_id ? { fileUniqueId: photo.file_unique_id } : {}) } : null;
}

function payload(message: TelegramMessage, text: string) {
  return { chat_id: message.chat.id, text, parse_mode: 'HTML',
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
  };
}

function freshSession(message: TelegramMessage, now: number): SessionRecord {
  return { userId: message.from!.id, chatId: message.chat.id, threadId: message.message_thread_id ?? null,
    state: 'collect', draft: emptyEventDraft(), promptIds: [], expiresAt: now + IDLE,
    draftExpiresAt: now + DAY, eventId: null, eventRevision: null };
}

async function prompt(store: EventStore, telegram: TelegramClient, message: TelegramMessage, session: SessionRecord,
  text: string, now: number): Promise<void> {
  const sent = await telegram.call<{ message_id: number }>('sendMessage', {
    ...payload(message, text), reply_markup: { force_reply: true, selective: message.chat.type !== 'private' },
  });
  if (!Number.isSafeInteger(sent?.message_id)) throw new TelegramError(502, true);
  session.promptIds = [...session.promptIds, sent.message_id].slice(-12);
  session.expiresAt = now + IDLE;
  await store.saveSession(session);
}

function ownerPicker() {
  return { keyboard: [[
    { text: 'اختار كروب النشر', request_chat: { request_id: OWNER_REQUEST_GROUP, chat_is_channel: false, bot_is_member: true } },
    { text: 'اختار قناة النشر', request_chat: { request_id: OWNER_REQUEST_CHANNEL, chat_is_channel: true, bot_is_member: true } },
  ]], resize_keyboard: true, one_time_keyboard: true };
}

function validName(text: string): string | null {
  const name = text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 60 && /^[\p{L}\p{M} .'-]+$/u.test(name) ? name : null;
}

async function beginPicker(store: EventStore, telegram: TelegramClient, message: TelegramMessage, now: number) {
  const session = freshSession(message, now);
  session.context = 'setup:chat';
  await store.saveSession(session);
  await telegram.call('sendMessage', { ...payload(message, 'تمام، اختار مكان النشر من الزر. لازم البوت موجود بيه وعنده صلاحية الإرسال، وأنت أدمن بيه.'), reply_markup: ownerPicker() });
}

async function configure(store: EventStore, telegram: TelegramClient, message: TelegramMessage, body: string, env: ContributionEnv, now: number): Promise<boolean> {
  const match = /^(?:إعداد|اعداد)\s+([A-Za-z0-9_-]{40,100})$/.exec(body.trim());
  const settings = await store.getSettings();
  if (match) {
    if (message.chat.type !== 'private') return true;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]!));
    const hash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (!env.OWNER_SETUP_TOKEN_HASH || hash !== env.OWNER_SETUP_TOKEN_HASH || settings.ownerUid !== null) {
      await telegram.call('sendMessage', payload(message, 'رمز الإعداد غير صالح أو مستخدم من قبل.')); return true;
    }
    if (!await store.bootstrapOwner(message.from!.id)) return true;
    await beginPicker(store, telegram, message, now); return true;
  }
  if (['الوجهه', 'اعداد', 'ربط'].includes(norm(body)) && isAdmin(message.from!.id, settings.ownerUid) && message.chat.type === 'private') {
    await beginPicker(store, telegram, message, now); return true;
  }
  return false;
}

async function sharedChat(store: EventStore, telegram: TelegramClient, message: TelegramMessage, session: SessionRecord | null, now: number): Promise<boolean> {
  if (!message.chat_shared) return false;
  const settings = await store.getSettings();
  if (message.chat.type !== 'private' || !isAdmin(message.from!.id, settings.ownerUid) || session?.context !== 'setup:chat' || session.expiresAt < now
    || ![OWNER_REQUEST_GROUP, OWNER_REQUEST_CHANNEL].includes(message.chat_shared.request_id)) return true;
  try {
    const target = message.chat_shared.chat_id;
    const chat = await telegram.call<{ type: string; title?: string }>('getChat', { chat_id: target });
    const member = await telegram.call<{ status: string }>('getChatMember', { chat_id: target, user_id: settings.ownerUid });
    const bot = await telegram.getMe();
    const self = await telegram.call<{ status: string; can_post_messages?: boolean; can_send_messages?: boolean }>('getChatMember', { chat_id: target, user_id: bot.id });
    if (!['group', 'supergroup', 'channel'].includes(chat.type) || !['creator', 'administrator'].includes(member.status)
      || ['left', 'kicked'].includes(self.status) || (chat.type === 'channel' && (self.status !== 'administrator' || self.can_post_messages !== true))) {
      throw new Error('Invalid destination');
    }
    if (self.status === 'restricted' && self.can_send_messages !== true) throw new Error('Cannot send');
    await store.saveSettings({ targetChatId: target, targetThreadId: null });
    await store.clearSession(session.userId, session.chatId, session.threadId);
    await telegram.call('sendMessage', { ...payload(message, `تم ربط النشر بـ«${escapeHtml(chat.title ?? 'المكان المختار')}» ✅\nالمساهمات تحتاج اعتمادك، والتذكير 8 مساءً و7:30 صباحاً بتوقيت بغداد.`), reply_markup: { remove_keyboard: true } });
  } catch {
    await telegram.call('sendMessage', payload(message, 'ما قدرت أتحقق من الصلاحيات. تأكد أنت أدمن والبوت يقدر يرسل بالمكان، وبعدين اختاره مرة ثانية.'));
  }
  return true;
}

function controls(event: EventRecord) {
  const data = (action: string) => `evt:${action}:${event.id}:${event.revision}`;
  return { inline_keyboard: [[{ text: 'تعديل', callback_data: data('edit') }, { text: 'إضافة مرفق', callback_data: data('attach') }, { text: 'إلغاء', callback_data: data('cancel') }]] };
}

async function temporaryReply(store: EventStore, telegram: TelegramClient, message: TelegramMessage, text: string, now: number) {
  const sent = await telegram.call<{ message_id: number }>('sendMessage', payload(message, text));
  if (Number.isSafeInteger(sent?.message_id)) await queueMessageCleanup(store, { chatId: message.chat.id, messageId: sent.message_id }, now);
}

function managementControls(event: EventRecord) {
  const data = (action: string) => `evt:${action}:${event.id}:${event.revision}`;
  return { inline_keyboard: [
    ...(event.status === 'pending' ? [[{ text: '✅ اعتماد', callback_data: data('approve') }, { text: 'رفض', callback_data: data('reject') }]] : []),
    [{ text: '✏️ تعديل التبليغ', callback_data: data('adminedit') }, { text: '🗑 حذف التبليغ', callback_data: data('delete') }],
    [{ text: '‹ إدارة التبليغات', callback_data: 'mgr:list:0' }],
  ] };
}

async function managementPanel(store: EventStore, telegram: TelegramClient, message: TelegramMessage, offset = 0, edit = false) {
  const settings = await store.getSettings();
  if (message.chat.type !== 'private' || !isAdmin(message.from?.id, settings.ownerUid)) {
    await temporaryReply(store, telegram, message, 'إدارة التبليغات متاحة لحساب الأدمن بالخاص فقط.', Date.now()); return;
  }
  const events = await store.listManageable(6, offset);
  const page = events.slice(0, 5);
  const text = page.length ? '<b>🗂 إدارة التبليغات</b>\nاختار تبليغ حتى تشوفه، تعدله أو تحذفه.\n\n' + page.map((event, index) =>
    `${offset + index + 1}. ${escapeHtml(COURSE_LABELS[event.draft.course! ] ?? 'ملاحظة')} — ${event.draft.kind ? EVENT_KIND_LABELS[event.draft.kind] : 'تبليغ'}\n${event.draft.date ?? 'موعده غير محدد'} · ${event.status === 'approved' ? 'معتمد' : event.status === 'pending' ? 'بانتظار الاعتماد' : 'يحتاج تصحيح'}`).join('\n\n')
    : '<b>🗂 إدارة التبليغات</b>\nماكو تبليغات تحتاج إدارة هسه.\nتگدر تسألني عن الجدول والمحاضرات بشكل طبيعي.';
  const buttons = page.map((event, index) => [{ text: `${offset + index + 1}. ${COURSE_LABELS[event.draft.course!] ?? 'التبليغ'}`, callback_data: `evt:manage:${event.id}:${event.revision}` }]);
  const navigation = [
    ...(offset > 0 ? [{ text: '‹ السابق', callback_data: `mgr:list:${Math.max(0, offset - 5)}` }] : []),
    ...(events.length > 5 ? [{ text: 'التالي ›', callback_data: `mgr:list:${offset + 5}` }] : []),
  ];
  if (navigation.length) buttons.push(navigation);
  await telegram.call(edit ? 'editMessageText' : 'sendMessage', {
    ...(edit ? { chat_id: message.chat.id, message_id: message.message_id } : payload(message, text)),
    text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons },
  });
}

async function advance(store: EventStore, telegram: TelegramClient, message: TelegramMessage, session: SessionRecord, now: Date): Promise<void> {
  const timestamp = now.getTime();
  const missing = missingEventField(session.draft);
  if (missing) {
    session.state = missing;
    const suggestion = missing === 'course' && session.draft.teacher ? suggestCourseForTeacher(session.draft.teacher) : null;
    if (suggestion) session.context = `course:${suggestion}`;
    else if (session.context?.startsWith('course:')) delete session.context;
    const text = missing === 'kind' ? 'هاي امتحان لو كوز لو واجب؟'
      : missing === 'course' ? suggestion ? `تقصد مادة ${COURSE_LABELS[suggestion]}؟ اكتب إي، أو اسم المادة الصحيحة.` : 'هاي لأي مادة؟'
      : missing === 'date' ? 'بأي تاريخ؟ اكتب مثلاً «الاثنين الجاي» أو «19/10/2026». وإذا بعده مو محدد اكتب «الموعد غير محدد».'
      : 'هاي للكل لو مجموعة A لو مجموعة B؟';
    await prompt(store, telegram, message, session, text, timestamp); return;
  }
  let event = session.eventId ? await store.getEvent(session.eventId) : null;
  const ownerEdit = session.adminEdit === true
    && isAdmin(session.userId, (await store.getSettings()).ownerUid) && event !== null;
  if (session.adminEdit && !ownerEdit) throw new Error('Administrative edit is not authorized.');
  const profile = ownerEdit ? { name: event!.authorName } : await store.getProfile(session.userId);
  if (!profile) { session.state = 'name'; await prompt(store, telegram, message, session, 'بأي اسم ننسب مشاركاتك؟ ❤️', timestamp); return; }
  if (ownerEdit) {
    const saved = session.context === `admin-saved:${session.lastUpdateId}` && event!.revision === session.eventRevision;
    if (!saved) {
      const duplicate = await store.findDuplicate({ id: event!.id, draft: session.draft });
      if (duplicate) { await prompt(store, telegram, message, session, 'هذا التعديل يطابق تبليغ موجود. عدّل التفاصيل أو اكتب «إلغاء» حتى تتركه مثل ما هو.', timestamp); return; }
    }
    const edited = saved ? event : await store.updateEvent(event!.id, session.eventRevision!, {
      draft: session.draft, status: 'approved', approvedAt: event!.approvedAt ?? timestamp, duplicateOf: null,
    });
    if (!edited) { await temporaryReply(store, telegram, message, 'التبليغ تغير؛ افتحه من إدارة التبليغات حتى تعدل آخر نسخة.', timestamp); return; }
    session.eventRevision = edited.revision; session.context = `admin-saved:${session.lastUpdateId}`;
    await store.saveSession(session);
    await queuePublish(store, edited.id, edited.revision, timestamp);
    if (session.adminPanelId) await telegram.call('editMessageText', { chat_id: message.chat.id, message_id: session.adminPanelId,
      text: formatEvent(edited.draft, edited.authorName, 'approved'), parse_mode: 'HTML', reply_markup: managementControls(edited) });
    await temporaryReply(store, telegram, message, '✅ انحفظ تعديلك. نسخة البوت اتحدثت، وتحديث المنشور بالطريق.', timestamp);
    for (const id of session.promptIds.slice(-1)) await queueMessageCleanup(store, { chatId: session.chatId, messageId: id }, timestamp);
    await store.clearSession(session.userId, session.chatId, session.threadId);
    await dispatchEventJobs(store, telegram, timestamp); return;
  }
  if (event && session.eventRevision !== null) {
    event = await store.updateEvent(event.id, session.eventRevision ?? event.revision, {
      draft: session.draft, authorName: profile.name, status: 'pending', duplicateOf: null,
    });
    if (!event) { await telegram.call('sendMessage', payload(message, 'الملاحظة تغيرت من قبل. ناديني من جديد حتى نفتح آخر نسخة.')); return; }
    await queueStatusUpdate(store, event.id, event.revision, timestamp);
  } else if (!event) {
    const settings = await store.getSettings();
    if (settings.ownerUid === null) {
      await prompt(store, telegram, message, session, 'حفظت المسودة، بس الإضافات تنتظر تفعيل الأدمن. تگدر تسألني عن جدول المحاضرات.', timestamp); return;
    }
    session.eventId ??= `c-${session.chatId}-${message.message_id}`;
    await store.saveSession(session);
    event = await store.createEvent({ id: session.eventId, authorId: session.userId, authorName: profile.name,
      sourceChatId: session.chatId, sourceThreadId: session.threadId, sourceMessageId: message.message_id,
      draft: session.draft, submittedAt: timestamp });
  }
  session.eventId = event.id; session.eventRevision = event.revision; session.state = 'collect';
  await queueReview(store, event.id, event.revision, timestamp);
  await store.saveSession(session);
  if (message.chat.type === 'private' && isAdmin(session.userId, (await store.getSettings()).ownerUid)) {
    await temporaryReply(store, telegram, message, 'وصل تبليغك ❤️ راجع بطاقة الاعتماد حتى توافق عليه أو تعدله.', timestamp);
  } else await telegram.call('sendMessage', { ...payload(message, `تمام ${escapeHtml(profile.name)} ❤️\n${formatEvent(event.draft, profile.name)}\n\nبانتظار اعتماد الأدمن.`), reply_markup: controls(event) });
  await dispatchEventJobs(store, telegram, timestamp);
}

export async function listEvents(store: EventStore, telegram: TelegramClient, message: TelegramMessage, text: string, now: Date, updateId: number, offset = 0, navigationId?: number, selection?: ReturnType<typeof extractEventQuery>) {
  const query = selection ?? extractEventQuery(text, now);
  if (query.clarification) {
    await telegram.call('sendMessage', payload(message, query.clarification)); return;
  }
  const events = await store.listApproved({ ...(query.kind ? { kind: query.kind } : {}), ...(query.kinds ? { kinds: query.kinds } : {}),
    ...(query.course ? { course: query.course } : {}), ...(query.date ? { date: query.date } : query.dateRange
      ? { dateFrom: query.dateRange.fromDate, dateTo: query.dateRange.toDate } : { dateFrom: getBaghdadNow(now).date }),
    ...(query.audience ? { audience: query.audience } : {}) });
  const period = query.dateRange && !query.date ? `📅 من ${query.dateRange.fromDate} إلى ${query.dateRange.toDate}` : '';
  if (!events.length) { await telegram.call('sendMessage', payload(message, period
    ? `${period}\nما عندي تبليغات معتمدة مطابقة لسؤالك بهالفترة.`
    : query.date ? 'ما عندي تبليغات معتمدة مطابقة لهاليوم.' : 'ما عندي امتحانات أو كوزات أو واجبات قادمة مطابقة لسؤالك.')); return; }
  offset = Math.min(offset, Math.floor((events.length - 1) / 3) * 3);
  await queueEventQuery(store, { updateId, chatId: message.chat.id,
    threadId: message.message_thread_id ?? null, replyTo: message.message_id,
    eventIds: events.slice(offset, offset + 3).map(event => event.id) }, now.getTime());
  if (period || events.length > 3 || navigationId !== undefined) {
    const kindCodes = { exam: 'e', quiz: 'q', homework: 'h' };
    const kinds = (query.kinds ?? (query.kind ? [query.kind] : [])).map(kind => kindCodes[kind]).join('') || '-';
    const dates = query.date ?? (query.dateRange ? `${query.dateRange.fromDate}~${query.dateRange.toDate}` : '-');
    const data = (page: number) => `evq:${kinds}:${query.course ?? '-'}:${dates}:${query.audience ?? '-'}:${page}`;
    const buttons = [
      ...(offset > 0 ? [{ text: '‹ السابق', callback_data: data(Math.max(0, offset - 3)) }] : []),
      ...(events.length > offset + 3 ? [{ text: 'المزيد ›', callback_data: data(offset + 3) }] : []),
    ];
    const text = `${period ? `${period}\n` : ''}📚 التبليغات ${Math.min(offset + 1, events.length)}–${Math.min(offset + 3, events.length)} من ${events.length}`;
    await telegram.call(navigationId === undefined ? 'sendMessage' : 'editMessageText', {
      ...(navigationId === undefined ? payload(message, text) : { chat_id: message.chat.id, message_id: navigationId }),
      text, reply_markup: { inline_keyboard: buttons.length ? [buttons] : [] },
    });
  }
  await dispatchEventJobs(store, telegram, now.getTime());
}

async function callback(store: EventStore, telegram: TelegramClient, update: TelegramUpdate, now: Date): Promise<void> {
  const query = update.callback_query!;
  if (query.from.is_bot) return;
  const ack = (text: string) => telegram.call('answerCallbackQuery', { callback_query_id: query.id, text, show_alert: false });
  const resultsPage = /^evq:([eqh]{1,3}|-):(architecture|mobile|networks|visual|compilers|graphics|-):(\d{4}-\d{2}-\d{2}(?:~\d{4}-\d{2}-\d{2})?|-):(A|B|all|-):(\d{1,3})$/.exec(query.data ?? '');
  if (resultsPage && query.message) {
    const labels: Record<string, string> = { e: 'امتحانات', q: 'كوزات', h: 'واجبات' };
    const kinds = resultsPage[1] === '-' ? 'التبليغات' : [...new Set(resultsPage[1]!)].map(code => labels[code]).join(' و ');
    const course = resultsPage[2] === '-' ? '' : COURSE_LABELS[resultsPage[2] as keyof typeof COURSE_LABELS];
    const dates = resultsPage[3]!;
    const date = dates === '-' || dates.includes('~') ? '' : dates;
    const audience = resultsPage[4] === '-' ? '' : resultsPage[4] === 'all' ? 'للكل' : `مجموعة ${resultsPage[4]}`;
    const text = `اعرض ${kinds} ${course} ${date} ${audience}`;
    const selection = extractEventQuery(text, now);
    if (dates.includes('~')) {
      const [fromDate, toDate] = dates.split('~') as [string, string];
      try {
        const start = addCalendarDays(fromDate, 0);
        // A current-week lookup can start today; every valid suffix still ends
        // on that same week's Saturday. Keep the encoded dates on later clicks.
        if (addCalendarDays(fromDate, 6 - start.weekday).date !== toDate) throw new RangeError('Invalid week');
      } catch { await ack('الفترة غير صالحة. اسألني من جديد.'); return; }
      selection.dateRange = { fromDate, toDate };
    }
    await ack('التبليغات');
    await listEvents(store, telegram, { ...query.message, from: query.from }, text, now, update.update_id, Number(resultsPage[5]), query.message.message_id, selection); return;
  }
  const page = /^mgr:list:(\d{1,4})$/.exec(query.data ?? '');
  if (page && query.message) {
    const settings = await store.getSettings();
    if (!isAdmin(query.from.id, settings.ownerUid) || query.message.chat.type !== 'private') { await ack('إدارة التبليغات للأدمن بالخاص فقط.'); return; }
    await ack('إدارة التبليغات');
    await managementPanel(store, telegram, { ...query.message, from: query.from }, Number(page[1]), true); return;
  }
  const match = /^evt:(approve|reject|correct|edit|attach|cancel|manage|adminedit|delete|confirmdelete):([a-zA-Z0-9-]{1,40}):(\d{1,8})$/.exec(query.data ?? '');
  if (!match || !query.message) { await ack('هذا الزر غير متاح.'); return; }
  const event = await store.getEvent(match[2]!);
  const action = match[1]!;
  const settings = await store.getSettings();
  const admin = ['approve', 'reject', 'correct', 'manage', 'adminedit', 'delete', 'confirmdelete'].includes(action);
  if (!event) { await ack('الملاحظة غير متاحة.'); return; }
  if (admin ? !isAdmin(query.from.id, settings.ownerUid) : event.authorId !== query.from.id) { await ack('هذا الزر مو إلك.'); return; }

  // Author buttons open their latest note; moderation always approves the exact reviewed revision.
  if (admin && event.revision !== Number(match[3])) {
    if (action === 'confirmdelete' && event.status === 'cancelled' && event.revision === Number(match[3]) + 1 && event.publicationDeletionRevision === event.revision) {
      await queuePublicationDeletion(store, event.id, event.revision, now.getTime());
      await queueMessageCleanup(store, { chatId: query.message.chat.id, messageId: query.message.message_id }, now.getTime());
      await ack('التبليغ محذوف من البوت ✅');
      await dispatchEventJobs(store, telegram, now.getTime()); return;
    }
    if (action === 'approve' && event.status === 'approved' && event.revision === Number(match[3]) + 1) {
      await queuePublish(store, event.id, event.revision, now.getTime());
      await queueReviewCleanup(store, event.id, Number(match[3]), now.getTime());
      await dispatchEventJobs(store, telegram, now.getTime());
    }
    if (action === 'correct' && event.status === 'needs_changes' && event.revision === Number(match[3]) + 1) {
      const retryMessage: TelegramMessage = { message_id: query.message.message_id, chat: query.message.chat, from: query.from,
        ...(query.message.message_thread_id === undefined ? {} : { message_thread_id: query.message.message_thread_id }) };
      const retrySession = freshSession(retryMessage, now.getTime());
      retrySession.state = 'admin_correction'; retrySession.eventId = event.id; retrySession.eventRevision = event.revision;
      await prompt(store, telegram, retryMessage, retrySession, 'شنو يحتاج يصحح الطالب بهاي الملاحظة؟', now.getTime());
      await ack('اكتب شنو يحتاج تصحيح.'); return;
    }
    await ack('هاي نسخة قديمة؛ استخدم آخر رسالة للملاحظة.'); return;
  }
  if (['manage', 'adminedit', 'delete', 'confirmdelete'].includes(action)) {
    if (event.status === 'cancelled' || event.status === 'rejected') { await ack('هذا التبليغ ملغي أو محذوف.'); return; }
    if (action === 'manage') {
      await ack('التبليغ');
      await telegram.call('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id,
        text: formatEvent(event.draft, event.authorName, event.status), parse_mode: 'HTML', reply_markup: managementControls(event) }); return;
    }
    if (action === 'adminedit') {
      const message = { ...query.message, from: query.from };
      const session = freshSession(message, now.getTime());
      session.draft = event.draft; session.eventId = event.id; session.eventRevision = event.revision;
      session.adminEdit = true; session.adminPanelId = query.message.message_id;
      await ack('رد بالنص الجديد.');
      await prompt(store, telegram, message, session, 'اكتب النص الجديد للتبليغ هنا. المادة والموعد والمجموعة والمرفق تبقى نفسها إذا ما غيّرتها. ردّك يحفظ التعديل ويعتمده باسم صاحب المساهمة.', now.getTime()); return;
    }
    if (action === 'delete') {
      await ack('تأكيد الحذف');
      await telegram.call('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id,
        text: `تحذف ${event.draft.kind ? EVENT_KIND_LABELS[event.draft.kind] : 'تبليغ'} ${escapeHtml(COURSE_LABELS[event.draft.course!] ?? '')}؟\nراح ينشال من أسئلة البوت والتذكيرات، وتبدأ إزالة المنشور ومرفقه.`, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🗑 إي، احذفه', callback_data: `evt:confirmdelete:${event.id}:${event.revision}` }, { text: 'رجوع', callback_data: `evt:manage:${event.id}:${event.revision}` }]] } }); return;
    }
    const removed = await store.requestPublicationDeletion(event.id, event.revision);
    if (!removed) { await ack('التبليغ تغير؛ افتح آخر نسخة.'); return; }
    await queuePublicationDeletion(store, removed.id, removed.revision, now.getTime());
    await ack('انحذف من التبليغات ✅');
    await telegram.call('editMessageText', { chat_id: query.message.chat.id, message_id: query.message.message_id,
      text: '🗑 انحذف التبليغ من البوت والتذكيرات. إزالة المنشور ومرفقه بالطريق.', reply_markup: { inline_keyboard: [] } });
    await queueMessageCleanup(store, { chatId: query.message.chat.id, messageId: query.message.message_id }, now.getTime());
    await dispatchEventJobs(store, telegram, now.getTime()); return;
  }
  if (admin && event.status !== 'pending') { await ack('الملاحظة انراجعت من قبل.'); return; }
  if (!admin && event.publicationDeletionRevision !== null) { await ack('هاي المساهمة انحذفت. ناديني من جديد حتى تضيف مساهمة جديدة.'); return; }
  const message: TelegramMessage = { message_id: !admin && query.message.chat.id === event.sourceChatId && event.sourceMessageId !== null ? event.sourceMessageId : query.message.message_id, chat: query.message.chat, from: query.from,
    ...(query.message.message_thread_id !== undefined ? { message_thread_id: query.message.message_thread_id } : {}) };
  if (action === 'approve') {
    if (settings.targetChatId === null) { await ack('حدد وجهة النشر أولاً: دعبول الوجهة بالخاص.'); return; }
    const duplicate = await store.findDuplicate(event);
    if (duplicate) {
      await store.updateEvent(event.id, event.revision, { status: 'rejected', duplicateOf: duplicate.id });
      await ack('مكررة؛ ما راح تننشر أو تزيد النقاط.'); return;
    }
    // Editing a previously approved note must not earn another week's contribution point.
    const approved = await store.updateEvent(event.id, event.revision, { status: 'approved', approvedAt: event.approvedAt ?? now.getTime() });
    if (!approved) { await ack('انراجعت من قبل.'); return; }
    await queuePublish(store, approved.id, approved.revision, now.getTime());
    await queueReviewCleanup(store, event.id, event.revision, now.getTime());
    await ack('اعتمدتها ✅');
    await dispatchEventJobs(store, telegram, now.getTime());
    return;
  }
  if (action === 'reject' || action === 'cancel') {
    if (event.status === 'cancelled' || event.status === 'rejected') { await ack('الملاحظة ملغية أو مرفوضة من قبل.'); return; }
    const changed = await store.updateEvent(event.id, event.revision, { status: action === 'reject' ? 'rejected' : 'cancelled' });
    if (!changed) { await ack('تغيرت الملاحظة؛ افتح آخر نسخة.'); return; }
    await queueStatusUpdate(store, changed.id, changed.revision, now.getTime());
    if (action === 'reject') await queueReviewCleanup(store, event.id, event.revision, now.getTime());
    await ack(action === 'reject' ? 'تم الرفض.' : 'تم الإلغاء.');
    await dispatchEventJobs(store, telegram, now.getTime()); return;
  }
  if (action === 'correct') {
    const changed = await store.updateEvent(event.id, event.revision, { status: 'needs_changes' });
    if (!changed) { await ack('تغيرت الملاحظة.'); return; }
    await queueStatusUpdate(store, changed.id, changed.revision, now.getTime());
    const session = freshSession(message, now.getTime());
    session.state = 'admin_correction'; session.eventId = changed.id; session.eventRevision = changed.revision;
    await ack('اكتب شنو يحتاج تصحيح.');
    await prompt(store, telegram, message, session, 'شنو يحتاج يصحح الطالب بهاي الملاحظة؟', now.getTime()); return;
  }
  const session = freshSession(message, now.getTime());
  session.draft = event.draft; session.eventId = event.id; session.eventRevision = event.revision;
  session.state = action === 'attach' ? 'attach' : 'collect';
  await ack('تمام، رد على رسالتي.');
  await prompt(store, telegram, message, session, action === 'attach' ? 'دز الصورة أو الملف هنا، وإذا أكو وصف اكتبه وياه.' : 'دز النص الصحيح كاملاً، والتعديل راح يحتاج اعتماد من جديد.', now.getTime());
}

/** True means this update belongs to the bounded contribution workflow. */
export async function handleContributions(update: TelegramUpdate, telegram: TelegramClient, now: Date,
  env: ContributionEnv, invocation: string | null, options?: { query?: ReturnType<typeof extractEventQuery> }): Promise<boolean> {
  const message = update.message;
  const called = invocation !== null;
  const body = invocation ?? message?.text ?? message?.caption ?? '';
  const action = options?.query ? 'list' : called ? classifyEventAction(body) : null;
  // Private-chat routing and Telegram mentions target the bot, but only its
  // Arabic wake word authorizes starting a new student contribution.
  const explicitWake = message !== undefined && stripWakeWord(message.text ?? message.caption ?? '') !== null;
  const rename = called && /^(?:غير|غيّر)\s*اسمي(?:\s|$)/u.test(norm(body));
  const setup = called && /^(?:إعداد|اعداد|الوجهة|الوجهه|ربط)(?:\s|$)/u.test(body.trim());
  const manage = called && /^(?:اداره(?:\s+(?:التبليغات|المساهمات))?|تبليغات الادمن)$/u.test(norm(body));
  const relevant = update.callback_query !== undefined || options?.query !== undefined || called && (body === '' || action !== null || rename || setup || manage)
    || !!message?.reply_to_message || !!message?.chat_shared;
  if (!relevant) return false;
  if (!env.DB || env.CONTRIBUTIONS_ENABLED !== 'true') {
    if (called && message) await telegram.call('sendMessage', payload(message, body === '' ? wakeReply(update.update_id) : 'الإضافات بعدهامو مفعّلة من الأدمن. جدول المحاضرات شغّال.'));
    if (update.callback_query) await telegram.call('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'الإضافات بعدهامو مفعّلة من الأدمن.' });
    return called || !!update.callback_query;
  }
  const store = new EventStore(env.DB);
  // Durable deduplication supplements the old per-isolate timetable cache.
  const claim = await store.claimUpdate(update.update_id, now.getTime());
  if (claim === 'done') return true;
  if (claim === 'busy') throw new TelegramError(429, true, 1);
  const actor = update.callback_query?.from ?? message?.from;
  const chat = update.callback_query?.message?.chat ?? message?.chat;
  const thread = update.callback_query?.message?.message_thread_id ?? message?.message_thread_id ?? null;
  const needsConversationLock = action !== 'list' || (options?.query === undefined && !!message?.reply_to_message && isBareEventType(body));
  const lock = actor && chat && needsConversationLock ? await store.claimConversation(actor.id, chat.id, thread, now.getTime()) : null;
  if (actor && chat && needsConversationLock && !lock) { await store.releaseUpdate(update.update_id); throw new TelegramError(429, true, 1); }
  try {
    if (update.callback_query) { await callback(store, telegram, update, now); await store.completeUpdate(update.update_id, now.getTime()); return true; }
    if (!message?.from || message.from.is_bot) { await store.completeUpdate(update.update_id); return true; }
    let session = await store.getSession(message.from.id, message.chat.id, message.message_thread_id ?? null);
    if (await sharedChat(store, telegram, message, session, now.getTime())) { await store.completeUpdate(update.update_id); return true; }
    if (called && await configure(store, telegram, message, body, env, now.getTime())) { await store.completeUpdate(update.update_id); return true; }
    if (manage) { await managementPanel(store, telegram, message); await store.completeUpdate(update.update_id); return true; }
    const linkedReply = session && session.expiresAt >= now.getTime() && session.draftExpiresAt >= now.getTime()
      && session.promptIds.includes(message.reply_to_message?.message_id ?? -1);
    const linkedKindAnswer = linkedReply && (session?.state === 'collect' || session?.state === 'kind')
      && isBareEventType(body) && !/[?؟]/u.test(body);
    const routedAction = action ?? (linkedReply ? classifyEventAction(body) : null);
    if ((routedAction === 'list' && (!linkedKindAnswer || options?.query !== undefined)) || (routedAction === 'submit' && !explicitWake && !linkedReply)) {
      await listEvents(store, telegram, message, body, now, update.update_id, 0, undefined, options?.query);
      await store.completeUpdate(update.update_id); return true;
    }
    const agenda = linkedReply ? classifyAgendaQuestion(body, now) : null;
    if (agenda) {
      const schedule = renderAgendaSchedule(agenda, now);
      if (schedule) await telegram.call('sendMessage', payload(message, schedule.text));
      await listEvents(store, telegram, message, body, now, update.update_id, 0, undefined, agenda.query);
      await store.completeUpdate(update.update_id); return true;
    }
    if (!called && !linkedReply) { await store.completeUpdate(update.update_id); return false; }
    if (!explicitWake && !linkedReply && !rename) {
      // A mention with no content can be acknowledged without opening a form.
      if (called && body === '') await telegram.call('sendMessage', payload(message, wakeReply(update.update_id)));
      await store.completeUpdate(update.update_id); return called && body === '';
    }
    if (called && body === '') {
      const previous = session;
      session = previous && previous.draftExpiresAt >= now.getTime() ? previous : freshSession(message, now.getTime());
      session.greetingIndex = previous?.greetingIndex === undefined ? 0 : previous.greetingIndex + 1;
      if (session.eventId && await store.getEvent(session.eventId)) session = { ...freshSession(message, now.getTime()), greetingIndex: session.greetingIndex };
      const media = attachment(message);
      if (media) session.draft.attachment = media;
      await prompt(store, telegram, message, session, wakeReply(session.greetingIndex ?? 0), now.getTime());
    } else if (rename) {
      session = freshSession(message, now.getTime()); session.state = 'rename';
      await prompt(store, telegram, message, session, 'بأي اسم تريد أنسب مشاركاتك من هسه؟', now.getTime());
    } else {
      if (called && !linkedReply) session = freshSession(message, now.getTime());
      session ??= freshSession(message, now.getTime());
      session.lastUpdateId = update.update_id;
      const value = body.trim();
      if (norm(value) === 'الغاء' || norm(value) === 'الغي') {
        await store.clearSession(session.userId, session.chatId, session.threadId);
        await temporaryReply(store, telegram, message, 'تمام، لغيت المسودة.', now.getTime()); await store.completeUpdate(update.update_id); return true;
      }
      if (session.state === 'name' || session.state === 'rename') {
        const name = validName(value);
        if (!name) await prompt(store, telegram, message, session, 'اكتب اسمك بس، من حرفين إلى 60 حرف ❤️', now.getTime());
        else {
          await store.saveProfile(session.userId, name, now.getTime());
          if (session.state === 'rename') { await store.clearSession(session.userId, session.chatId, session.threadId); await temporaryReply(store, telegram, message, `تمام، من هسه أنسب مشاركاتك باسم ${escapeHtml(name)} ❤️`, now.getTime()); }
          else await advance(store, telegram, message, session, now);
        }
      } else if (session.state === 'admin_correction' && session.eventId) {
        const event = await store.getEvent(session.eventId);
        let replacedOwnSession = false;
        if (event?.status === 'needs_changes') {
          const target: TelegramMessage = { message_id: event.sourceMessageId ?? 1, chat: { id: event.sourceChatId, type: event.sourceChatId > 0 ? 'private' : 'supergroup' }, from: { id: event.authorId, is_bot: false },
            ...(event.sourceThreadId === null ? {} : { message_thread_id: event.sourceThreadId }) };
          const authorSession = freshSession(target, now.getTime());
          authorSession.eventId = event.id; authorSession.eventRevision = event.revision; authorSession.draft = event.draft;
          await prompt(store, telegram, target, authorSession, `الأدمن طلب تصحيح ملاحظتك:\n${escapeHtml(value.slice(0, 1500))}\nدز النص المصحح هنا.`, now.getTime());
          replacedOwnSession = authorSession.userId === session.userId && authorSession.chatId === session.chatId && authorSession.threadId === session.threadId;
        }
        if (!replacedOwnSession) await store.clearSession(session.userId, session.chatId, session.threadId);
      } else {
        if (value.length > 2048 || escapeHtml(value).length > 2800) { await prompt(store, telegram, message, session, 'اختصر الوصف حتى أگدر أعرضه كامل؛ وتگدر ترفق التفاصيل بملف.', now.getTime()); await store.completeUpdate(update.update_id); return true; }
        if (session.state === 'collect') {
          const local = classifyLocal(value);
          if (classifyEventAction(value) === 'list' && !linkedKindAnswer) {
            await listEvents(store, telegram, message, value, now, update.update_id);
            await store.completeUpdate(update.update_id); return true;
          }
          if (classifyEventAction(value) === null && local && ['schedule', 'lookup', 'next', 'current', 'remaining'].includes(local.intent)) {
            await telegram.call('sendMessage', payload(message, renderQuery(local, now).text));
            await store.completeUpdate(update.update_id); return true;
          }
          const previousAttachment = session.draft.attachment;
          const editing = session.eventRevision !== null;
          const previousDetails = session.draft.details;
          session.draft = await extractEvent(value, now, env, editing ? session.draft : undefined);
          if (editing && value) session.draft.details = session.adminEdit ? value : `${previousDetails}\n\nتعديل الطالب:\n${value}`;
          session.draft.attachment ??= previousAttachment;
          if (!session.eventId) session.eventId = `c-${update.update_id}`;
        } else if (session.state !== 'attach') {
          const field = session.state;
          const answer = await extractEvent(value, now, env, session.draft);
          if (field === 'course' && session.context?.startsWith('course:') && ['اي', 'نعم', 'ايي'].includes(norm(value))) {
            session.draft.course = session.context.slice(7) as EventDraft['course'];
          } else session.draft = answer;
          if (value) session.draft.details = `${session.draft.details}\n\nتوضيح الطالب:\n${value}`;
        } else if (value) {
          const previousDetails = session.draft.details;
          session.draft = await extractEvent(value, now, env, session.draft);
          session.draft.details = `${previousDetails}\n\nوصف المرفق:\n${value}`;
        }
        if (escapeHtml(session.draft.details).length > 2800 || session.draft.details.length > 2048) {
          await prompt(store, telegram, message, session, 'الوصف صار طويل. اكتب دعبول ويا النص المختصر الكامل، وارفق التفاصيل بملف.', now.getTime());
          await store.completeUpdate(update.update_id); return true;
        }
        const media = attachment(message);
        if (media) session.draft.attachment = media;
        if (session.state === 'attach' && !media) await prompt(store, telegram, message, session, 'دز صورة أو ملف بالرد على هاي الرسالة.', now.getTime());
        else if (!session.draft.details && media) { session.state = 'collect'; await prompt(store, telegram, message, session, 'وصل المرفق، اكتب المادة والموعد وشنو المطلوب حتى أحفظه وياه.', now.getTime()); }
        else await advance(store, telegram, message, session, now);
      }
    }
    await store.completeUpdate(update.update_id, now.getTime());
    return true;
  } catch (error) { await store.releaseUpdate(update.update_id); throw error; }
  finally { if (lock && actor && chat) await store.releaseConversation(actor.id, chat.id, thread, lock); }
}
