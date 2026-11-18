import { dailyNewsOutgoing } from './daily-news';
import { dailyPublicationOutgoing, recordPublication } from './daily-publications';
import type { AssistantReference } from './assistant-references';
import { addCalendarDays, getBaghdadNow } from "./calendar";
import { formatEvent } from "./event-format";
import { EventStore, type EventRecord, type JobRecord, type SettingsRecord } from "./event-store";
import { escapeHtml } from "./format";
import { TelegramError } from "./telegram";
import { academicReportOutgoing } from './academic-ai';
import { assistantReplyOutgoing, assistantWaitOutgoing } from './assistant-store';
import { getSmartReminderOutgoing } from './smart-reminders';
import { lectureBriefOutgoing } from './academic-alerts';

export interface EventJobTelegram {
  call<T>(method: "sendMessage" | "sendPhoto" | "sendDocument" | "editMessageText" | "editMessageCaption" | "deleteMessage", payload: unknown): Promise<T>;
}
export interface EventQueryRequest {
  updateId: number; chatId: number; threadId: number | null; replyTo: number; eventIds: string[];
}
interface EventJobRef { eventId: string; revision: number; part?: "text" | "attachment" }
interface DigestPayload { date: string; heading: string; refs?: { id: string; revision: number }[] }
interface AwardPayload { from: number; to: number; period: string; targetChatId?: number }
interface Outgoing { publicationRemaining?: AssistantReference[]; publicationRefs?: AssistantReference[]; chatId: number; payload: Record<string, unknown>; method: "sendMessage" | "sendPhoto" | "sendDocument" | "editMessageText" | "deleteMessage"; event?: EventRecord; deletionPart?: "text" | "attachment" }

/** Only deliberately disposable bot feedback is passed here, never student messages or answers. */
export async function queueMessageCleanup(store: EventStore, message: { chatId: number; messageId: number }, now = Date.now(), delayMs = 20_000): Promise<void> {
  if (!Number.isSafeInteger(message.chatId) || message.chatId === 0 || !Number.isSafeInteger(message.messageId) || message.messageId <= 0) throw new RangeError("Invalid cleanup message.");
  await store.enqueueJob({ id: `cleanup:${message.chatId}:${message.messageId}`, type: "cleanup", payload: message,
    dueAt: now + Math.max(0, Math.min(86_400_000, Number.isFinite(delayMs) ? delayMs : 20_000)) });
}

export async function queueReviewCleanup(store: EventStore, eventId: string, reviewRevision: number, now = Date.now(), delayMs = 20_000): Promise<void> {
  for (const message of await store.listReviewMessages(eventId, reviewRevision)) await queueMessageCleanup(store, message, now, delayMs);
}

/** The persisted deletion marker is written only by the explicit owner deletion workflow. */
export async function queuePublicationDeletion(store: EventStore, eventId: string, revision: number, now = Date.now()): Promise<void> {
  const event = await store.getEvent(eventId);
  if (!event || event.revision !== revision || event.status !== "cancelled" || event.publicationDeletionRevision !== revision) return;
  // Each sweep enqueues at most three messages, including historical attachment revisions.
  // Missing targets remain discoverable by listDeliveryCandidates after a partial enqueue/crash.
  for (const target of await store.listPublicationDeletionTargets(eventId, revision)) await store.enqueueJob({
    id: `delete:${eventId}:${revision}:${target.chatId}:${target.messageId}`, type: "publication_delete",
    payload: { eventId, revision, ...target }, dueAt: now,
  });
}

function reference(payload: unknown): EventJobRef | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  return typeof value.eventId === "string" && Number.isInteger(value.revision)
    ? { eventId: value.eventId, revision: value.revision as number, ...(value.part === "attachment" ? { part: "attachment" } : {}) } : null;
}

export async function queueReview(store: EventStore, eventId: string, revision: number, now = Date.now()): Promise<void> {
  const event = await store.getEvent(eventId);
  if (!event || event.revision !== revision || event.status !== "pending") return;
  await store.enqueueJob({ id: `review:${eventId}:${revision}:1-text`, type: "review", payload: { eventId, revision }, dueAt: now });
  if (event.draft.attachment) await store.enqueueJob({
    id: `review:${eventId}:${revision}:0-attachment`, type: "review", payload: { eventId, revision, part: "attachment" }, dueAt: now,
  });
}

export async function queuePublish(store: EventStore, eventId: string, revision: number, now = Date.now()): Promise<void> {
  const event = await store.getEvent(eventId);
  if (!event || event.revision !== revision || event.status !== "approved" || event.duplicateOf !== null) return;
  await store.enqueueJob({ id: `publish:${eventId}:${revision}:0-text`, type: "publish", payload: { eventId, revision }, dueAt: now });
  if (event.draft.attachment) await store.enqueueJob({
    id: `publish:${eventId}:${revision}:1-attachment`, type: "publish", payload: { eventId, revision, part: "attachment" }, dueAt: now,
  });
}

export async function queueStatusUpdate(store: EventStore, eventId: string, revision: number, now = Date.now()): Promise<void> {
  const event = await store.getEvent(eventId);
  if (!event || event.revision !== revision || event.publishedMessageId === null || event.publicationDeletionRevision === revision) return;
  await store.enqueueJob({ id: `status:${eventId}:${revision}`, type: "status", payload: { eventId, revision }, dueAt: now });
}

export async function queueEventQuery(store: EventStore, request: EventQueryRequest, now = Date.now()): Promise<void> {
  for (const [index, eventId] of request.eventIds.slice(0, 3).entries()) {
    const event = await store.getEvent(eventId);
    if (!event || event.status !== "approved" || event.duplicateOf !== null) continue;
    const payload = { eventId, revision: event.revision, chatId: request.chatId, threadId: request.threadId, replyTo: request.replyTo };
    await store.enqueueJob({ id: `query:${request.updateId}:${index}:0-text`, type: "query", payload, dueAt: now });
    if (event.draft.attachment) await store.enqueueJob({
      id: `query:${request.updateId}:${index}:1-attachment`, type: "query", payload: { ...payload, part: "attachment" }, dueAt: now,
    });
  }
}

function utcFromBaghdad(date: string, hour: number, minute = 0): number {
  // Reminders use explicit Baghdad calendar dates, not provisional lecture hours.
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+03:00`);
}

/** One minutely Cron sweep catches delayed ticks; deterministic keys prevent repeated enqueue. */
export async function queueScheduledEventJobs(store: EventStore, now = Date.now()): Promise<void> {
  const settings = await store.getSettings();
  // A retried webhook can carry an older revision after D1 saved the event but not its jobs.
  // Leave room for dispatch/cleanup within the Free plan's per-invocation D1 query budget.
  for (const event of await store.listDeliveryCandidates(2)) {
    if (event.status === "cancelled" && event.publicationDeletionRevision === event.revision) {
      await queuePublicationDeletion(store, event.id, event.revision, now); continue;
    }
    if (event.status === "pending" && settings.ownerUid !== null) await queueReview(store, event.id, event.revision, now);
    if (event.status === "approved") await queuePublish(store,event.id,event.revision,now);
    else if (event.publishedMessageId !== null && (event.publishedChatId !== null || settings.targetChatId !== null)) await queueStatusUpdate(store, event.id, event.revision, now);
  }
  if (settings.targetChatId === null) return;
}

function destination(settings: SettingsRecord): Record<string, unknown> {
  return { chat_id: settings.targetChatId, ...(settings.targetThreadId !== null ? { message_thread_id: settings.targetThreadId } : {}) };
}

function publicationDestination(event: EventRecord, settings: SettingsRecord): SettingsRecord {
  return event.publishedMessageId !== null && event.publishedChatId !== null
    ? { ownerUid: settings.ownerUid, targetChatId: event.publishedChatId, targetThreadId: event.publishedThreadId }
    : settings;
}

function attachment(event: EventRecord, chatId: number, target: Record<string, unknown>): Outgoing | null {
  const media = event.draft.attachment;
  if (!media) return null;
  // Reuse Telegram-hosted file IDs; no downloads, OCR, public token URLs or third-party storage.
  const method = media.kind === "photo" ? "sendPhoto" : "sendDocument";
  return { chatId, method, event, payload: {
    ...target, [media.kind === "photo" ? "photo" : "document"]: media.fileId,
    caption: `📎 مرفق المشاركة\nمساهمة: ${event.authorName}`.slice(0, 1000),
    ...(event.publishedMessageId !== null && event.status === "approved"
      ? { reply_parameters: { message_id: event.publishedMessageId, allow_sending_without_reply: true } } : {}),
  } };
}

function originalLink(event: EventRecord, settings: SettingsRecord): string {
  const chatId = publicationDestination(event, settings).targetChatId;
  if (event.publishedMessageId === null || chatId === null || !String(chatId).startsWith("-100")) return "";
  return `\n<a href="https://t.me/c/${String(chatId).slice(4)}/${event.publishedMessageId}">المشاركة الأصلية</a>`;
}

function digestPages(events: readonly EventRecord[], heading: string, settings: SettingsRecord): { text: string; refs: { id: string; revision: number }[] }[] {
  const pages: { text: string; refs: { id: string; revision: number }[] }[] = [];
  let text = `<b>${escapeHtml(heading)}</b>`;
  let refs: { id: string; revision: number }[] = [];
  for (const event of events) {
    const formatted = formatEvent(event.draft, event.authorName, "approved");
    const linked = formatted + originalLink(event, settings);
    const entry = linked.length <= 4096 ? linked : formatted;
    if (text.length + entry.length + 2 > 4096) {
      if (refs.length > 0) pages.push({ text, refs });
      text = ""; refs = [];
    }
    text += `${text ? "\n\n" : ""}${entry}`;
    refs.push({ id: event.id, revision: event.revision });
  }
  if (refs.length > 0) pages.push({ text, refs });
  return pages;
}

async function outgoingForJob(store: EventStore, job: JobRecord, settings: SettingsRecord, now: number): Promise<Outgoing | null> {
  if(job.type==='assistant_wait')return assistantWaitOutgoing(store.db,job.payload,now);
  if (job.type === 'keyboard_refresh') {
    const p=job.payload as {chatId?:number}|null;
    if(!p||!Number.isSafeInteger(p.chatId)||p.chatId!<=0)return null;
    return {chatId:p.chatId!,method:'sendMessage',payload:{chat_id:p.chatId,text:'إذا بعدك تشوف الأزرار القديمة اضغط هنا حتى نحدّث المحادثة.',disable_notification:true,reply_markup:{inline_keyboard:[[{text:'تحديث دعبول',callback_data:'ui:refresh'}]]}}};
  }
  if (job.type === 'keyboard_cleanup') {
    const p=job.payload as {chatId?:number}|null;
    if(!p||!Number.isSafeInteger(p.chatId)||p.chatId!<=0)return null;
    return {chatId:p.chatId!,method:'sendMessage',payload:{chat_id:p.chatId,text:'حدّثنا دعبول وصار التعامل وياه بالحچي 😄 شلنا الأزرار القديمة؛ اكتب سؤالك مباشرة، ما تحتاج /start. إذا بعدها ظاهرة اكتب «حدّث دعبول».',disable_notification:true,reply_markup:{remove_keyboard:true}}};
  }
  if (job.type === 'daily_news') return dailyNewsOutgoing(store.db,job.payload,now);
  if (job.type === 'daily_academic' || job.type === 'manual_academic') return dailyPublicationOutgoing(store.db, job.payload, now);
  if (job.type === 'academic_report') {
    const outgoing = await academicReportOutgoing(store.db, job, now);
    return outgoing ? { ...outgoing, method: 'sendMessage' } : null;
  }
  if (job.type === 'assistant_reply') {
    const outgoing = await assistantReplyOutgoing(store.db, job, now);
    return outgoing ? { ...outgoing, method: 'sendMessage' } : null;
  }
  if (job.type === 'smart_reminder') return getSmartReminderOutgoing(store.db, job.payload, settings, now);
  if (job.type === 'lecture_brief') return lectureBriefOutgoing(store.db, job.payload, settings, now);
  if (job.type === "operator_notice") {
    const notice = job.payload as { chatId?: unknown; text?: unknown } | null;
    if (!notice || !Number.isSafeInteger(notice.chatId) || notice.chatId !== settings.ownerUid || typeof notice.text !== "string" || notice.text.length > 4096) return null;
    return { chatId: notice.chatId as number, method: "sendMessage", payload: { chat_id: notice.chatId, text: notice.text } };
  }
  if (job.type === "cleanup" || job.type === "publication_delete") {
    const payload = job.payload as { chatId?: unknown; messageId?: unknown; part?: unknown } | null;
    if (!payload || !Number.isSafeInteger(payload.chatId) || payload.chatId === 0 || !Number.isSafeInteger(payload.messageId) || Number(payload.messageId) <= 0) return null;
    let event: EventRecord | undefined;
    if (job.type === "publication_delete") {
      const ref = reference(job.payload);
      if (!ref) return null;
      const current = await store.getEvent(ref.eventId);
      if (!current || current.revision !== ref.revision || current.status !== "cancelled" || current.publicationDeletionRevision !== ref.revision) return null;
      event = current;
    }
    return { chatId: payload.chatId as number, method: "deleteMessage", payload: { chat_id: payload.chatId, message_id: payload.messageId },
      ...(event ? { event, deletionPart: payload.part === "attachment" ? "attachment" : "text" } : {}) };
  }
  if (job.type === "query") {
    const ref = reference(job.payload);
    const query = job.payload as { chatId?: unknown; threadId?: unknown; replyTo?: unknown } | null;
    if (!ref || !query || !Number.isSafeInteger(query.chatId) || query.chatId === 0 ||
      !(query.threadId === null || Number.isSafeInteger(query.threadId) && Number(query.threadId) > 0) ||
      !Number.isSafeInteger(query.replyTo) || Number(query.replyTo) <= 0) return null;
    const event = await store.getEvent(ref.eventId);
    if (!event || event.revision !== ref.revision || event.status !== "approved" || event.duplicateOf !== null) return null;
    const chatId = query.chatId as number;
    const reply = { message_id: query.replyTo as number, allow_sending_without_reply: true };
    const target = { chat_id: chatId, ...(query.threadId !== null ? { message_thread_id: query.threadId as number } : {}), reply_parameters: reply };
    if (ref.part === "attachment") {
      const outgoing = attachment(event, chatId, target);
      if (outgoing) outgoing.payload.reply_parameters = reply;
      return outgoing;
    }
    return { chatId, method: "sendMessage", event, payload: { ...target, text: formatEvent(event.draft, event.authorName, "approved"), parse_mode: "HTML" } };
  }
  if (job.type === "review" || job.type === "publish" || job.type === "status") {
    const ref = reference(job.payload);
    if (!ref) return null;
    const event = await store.getEvent(ref.eventId);
    if (!event || event.revision !== ref.revision || event.publicationDeletionRevision === event.revision || (job.type !== "status" && event.status !== (job.type === "review" ? "pending" : "approved"))) return null;
    if (job.type === "publish" && event.duplicateOf !== null) return null;
    const publishedTarget = publicationDestination(event, settings);
    const chatId = job.type === "review" ? settings.ownerUid : publishedTarget.targetChatId;
    if (chatId === null) throw new TelegramError(503, true);
    const target = job.type === "review" ? { chat_id: chatId } : destination(publishedTarget);
    if(job.type==='publish' && ref.part!=='attachment') {
      const receipt=await store.db.prepare("SELECT 1 FROM publication_receipts WHERE kind='legacy' AND record_id=? AND revision=? AND chat_id=? AND thread_id=?")
        .bind(event.id,event.revision,chatId,publishedTarget.targetThreadId??0).first();
      if(receipt)return null;
    }
    if (job.type === "status") {
      if (event.publishedMessageId === null || event.status === "approved") return null;
      const status = event.status === "pending" ? "بانتظار موافقة الأدمن على التعديل"
        : event.status === "needs_changes" ? "تحتاج تعديل قبل الاعتماد"
        : event.status === "cancelled" ? "ملغاة" : "مرفوضة";
      return { chatId, method: "editMessageText", event, payload: {
        ...target, message_id: event.publishedMessageId, parse_mode: "HTML",
        text: `📌 <b>دعبول | تحديث مشاركة</b>\n📋 ${status}\n👤 مساهمة: ${escapeHtml(event.authorName)}\n\nالمشاركة غير متاحة حالياً.`,
      } };
    }
    if (ref.part === "attachment") return attachment(event, chatId, target);
    const edit = job.type !== "review" && event.publishedMessageId !== null;
    return { chatId, method: edit ? "editMessageText" : "sendMessage", event, payload: {
      ...target, ...(edit ? { message_id: event.publishedMessageId } : {}),
      text: formatEvent(event.draft, event.authorName, event.status), parse_mode: "HTML",
      ...(job.type === "review" ? { reply_markup: { inline_keyboard: [[
        { text: "✅ موافقة", callback_data: `evt:approve:${event.id}:${event.revision}` },
        { text: "💬 طلب تصحيح", callback_data: `evt:correct:${event.id}:${event.revision}` },
        { text: "❌ رفض", callback_data: `evt:reject:${event.id}:${event.revision}` },
      ], [{ text: "✏️ تعديل بنفسي", callback_data: `evt:adminedit:${event.id}:${event.revision}` }]] } } : {}),
    } };
  }
  if (settings.targetChatId === null) throw new TelegramError(503, true);
  if (job.type === "digest" || job.type === "digest_page") {
    const payload = job.payload as DigestPayload;
    if (!payload || typeof payload.date !== "string" || typeof payload.heading !== "string") return null;
    // Do not deliver a stale reminder after the date has passed.
    if (payload.date < getBaghdadNow(new Date(now)).date) return null;
    let events = (await store.listApproved({ date: payload.date })).filter(event => event.publishedChatId === null || event.publishedChatId === settings.targetChatId);
    if (payload.refs) events = events.filter(event => payload.refs!.some(ref => ref.id === event.id && ref.revision === event.revision));
    const pages = digestPages(events, payload.heading, settings);
    if (pages.length === 0) return null;
    for (let index = 1; index < pages.length; index++) {
      await store.enqueueJob({ id: `${job.id}:page:${index + 1}`, type: "digest_page",
        payload: { date: payload.date, heading: payload.heading, refs: pages[index]!.refs }, dueAt: now + index * 3100 });
    }
    return { chatId: settings.targetChatId, method: "sendMessage", payload: {
      ...destination(settings), text: pages[0]!.text, parse_mode: "HTML", link_preview_options: { is_disabled: true },
    } };
  }
  if (job.type === "award_page") {
    const payload = job.payload as { text?: unknown; targetChatId?: unknown };
    if (typeof payload?.text !== "string" || payload.text.length > 4096 ||
      payload.targetChatId !== undefined && payload.targetChatId !== settings.targetChatId) return null;
    return { chatId: settings.targetChatId, method: "sendMessage", payload: { ...destination(settings), text: payload.text, parse_mode: "HTML" } };
  }
  if (job.type === "award") {
    const payload = job.payload as AwardPayload;
    if (!payload || !Number.isFinite(payload.from) || !Number.isFinite(payload.to) || typeof payload.period !== "string") return null;
    if (payload.targetChatId !== undefined && payload.targetChatId !== settings.targetChatId) return null;
    const leaders = await store.weeklyContributors(payload.from, payload.to, settings.targetChatId);
    if (leaders.length === 0) return null;
    const winners = leaders.filter(author => author.count === leaders[0]!.count);
    const header = `🏆 <b>مساهم الأسبوع — ${escapeHtml(payload.period)}</b>\n\n`;
    const pages: string[] = [];
    let text = header;
    for (const author of winners) {
      const line = `👏 ${escapeHtml(author.authorName)} — ${author.count} مشاركات معتمدة وفريدة\n`;
      if (text.length + line.length + 70 > 4096) { pages.push(text); text = header; }
      text += line;
    }
    text += "\nشكراً لكل الطلاب اللي شاركوا بالمعلومة ❤️";
    pages.push(text);
    for (let index = 1; index < pages.length; index++) await store.enqueueJob({
      id: `${job.id}:page:${index + 1}`, type: "award_page", payload: { text: pages[index]!, targetChatId: settings.targetChatId }, dueAt: now + index * 3100,
    });
    return { chatId: settings.targetChatId, method: "sendMessage", payload: { ...destination(settings), text: pages[0]!, parse_mode: "HTML" } };
  }
  return null;
}

/** Leases/CAS suppress duplicate workers; Telegram cannot atomically commit a send with D1. */
export async function dispatchEventJobs(store: EventStore, telegram: EventJobTelegram, now = Date.now(),
  options: { limit?: number; sleep?: (milliseconds: number) => Promise<void>; types?: readonly string[];jobIds?:readonly string[] } = {}): Promise<{ sent: number; retried: number; cancelled: number; failed: number }> {
  const stats = { sent: 0, retried: 0, cancelled: 0, failed: 0 };
  const jobs = await store.claimJobs(now, options.limit ?? 4, 300_000, options.types,options.jobIds);
  const settings = await store.getSettings();
  const started = Date.now();
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); }));
  for (const job of jobs) {
    if (!job.leaseToken) continue;
    let publicationLock: {chatId:number;threadId:number;token:string}|null=null;
    try {
      const currentNow = now + Math.max(0, Date.now() - started);
      let outgoing = await outgoingForJob(store, job, settings, currentNow);
      if (!outgoing) { await store.cancelJob(job.id, job.leaseToken); stats.cancelled++; continue; }
      if (outgoing.publicationRefs || job.type==='publish') {
        const token=crypto.randomUUID();
        const threadId=Number(outgoing.payload.message_thread_id??0);
        const claim=await store.db.prepare(`INSERT INTO publication_locks(chat_id,thread_id,lease_token,lease_until) VALUES(?,?,?,?)
          ON CONFLICT(chat_id,thread_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
          WHERE publication_locks.lease_until<=? RETURNING lease_token`).bind(outgoing.chatId,threadId,token,currentNow+120000,currentNow).first<{lease_token:string}>();
        if(claim?.lease_token!==token){await store.retryJob(job.id,job.leaseToken,currentNow+5000,'publication_in_progress');stats.retried++;continue;}
        publicationLock={chatId:outgoing.chatId,threadId,token};
      }
      const sendAt = outgoing.method === "deleteMessage" ? currentNow : await store.reserveDelivery(outgoing.chatId, currentNow, outgoing.chatId < 0 ? 3100 : 1100);
      if (sendAt - currentNow > 10_000) {
        await store.retryJob(job.id, job.leaseToken, sendAt, "delivery_pacing"); stats.retried++; continue;
      }
      if (sendAt > currentNow) await sleep(sendAt - currentNow);
      if (outgoing.publicationRefs || job.type==='publish' || job.type==='academic_report') {
        outgoing=await outgoingForJob(store,job,settings,now+Math.max(0,Date.now()-started));
        if(!outgoing){await store.cancelJob(job.id,job.leaseToken);stats.cancelled++;continue;}
      }
      // Re-read after pacing so an owner correction/rejection can invalidate a queued publication.
      if (outgoing.event) {
        const latest = await store.getEvent(outgoing.event.id);
        if (!latest || latest.revision !== outgoing.event.revision || latest.status !== outgoing.event.status) {
          await store.cancelJob(job.id, job.leaseToken); stats.cancelled++; continue;
        }
      }
      let result: { message_id?: number } | boolean;
      let finalNote: string | null = null;
      try { result = await telegram.call<{ message_id?: number } | boolean>(outgoing.method, outgoing.payload); }
      catch (error) {
        if (outgoing.deletionPart && error instanceof TelegramError && (error.code === 400 || error.code === 403) && !error.retryable) {
          // Telegram cannot physically delete messages older than 48 hours. Withdraw the
          // original text/caption where permissions allow; never copy draft details here.
          const withdrawn = "🗑 هذا التبليغ انحذف من دعبول بواسطة الأدمن، وما عاد ضمن التذكيرات.";
          const notice = async (didWithdraw: boolean): Promise<void> => {
            if (settings.ownerUid === null) return;
            const link = String(outgoing.chatId).startsWith("-100") ? `\nhttps://t.me/c/${String(outgoing.chatId).slice(4)}/${outgoing.payload.message_id}` : "";
            await store.enqueueJob({ id: `notice:${job.id}`, type: "operator_notice", dueAt: currentNow,
              payload: { chatId: settings.ownerUid, text: didWithdraw
                ? `التبليغ انحذف من البوت. Telegram ما سمح بإزالة هذا المنشور؛ وسّمته ملغي. تگدر تحذفه يدوياً.${link}`
                : `التبليغ انحذف من البوت والتذكيرات، بس تعذّر حذف أو تعديل هذا المنشور على Telegram. احذفه يدوياً.${link}` },
            });
          };
          try {
            result = await telegram.call<{ message_id?: number }>(outgoing.deletionPart === "attachment" ? "editMessageCaption" : "editMessageText", {
              ...outgoing.payload, ...(outgoing.deletionPart === "attachment" ? { caption: withdrawn } : { text: withdrawn }),
              reply_markup: { inline_keyboard: [] },
            });
          } catch (fallbackError) {
            if (fallbackError instanceof TelegramError && !fallbackError.retryable) await notice(false);
            throw fallbackError;
          }
          await notice(true);
          finalNote = "withdrawal_fallback";
        } else throw error;
      }
      const messageId = typeof result === "object" && Number.isSafeInteger(result?.message_id) ? result.message_id! : null;
      if(outgoing.publicationRefs&&messageId===null)throw new TelegramError(0,true);
      if (outgoing.publicationRefs && messageId !== null) await recordPublication(store.db,outgoing.publicationRefs,outgoing.chatId,
        Number.isSafeInteger(outgoing.payload.message_thread_id) ? Number(outgoing.payload.message_thread_id) : null,messageId,currentNow,job.id);
      if (job.type === "publish" && outgoing.event && outgoing.method === "sendMessage" && messageId !== null) {
        await store.markPublished(outgoing.event.id, outgoing.event.revision, messageId, outgoing.chatId,
          Number.isSafeInteger(outgoing.payload.message_thread_id) ? outgoing.payload.message_thread_id as number : null);
      }
      if (job.type==='publish' && outgoing.event && messageId!==null && ['sendMessage','editMessageText'].includes(outgoing.method)) {
        await recordPublication(store.db,[{kind:'legacy',id:outgoing.event.id,revision:outgoing.event.revision}],outgoing.chatId,
          Number.isSafeInteger(outgoing.payload.message_thread_id)?Number(outgoing.payload.message_thread_id):null,messageId,currentNow,job.id);
      }
      if(outgoing.publicationRemaining?.length && messageId!==null){
        await store.enqueueJob({id:`${job.id}:next`,type:job.type,payload:{...(job.payload as Record<string,unknown>),refs:outgoing.publicationRemaining},dueAt:currentNow+3100});
      }
      if (!await store.completeJob(job.id, job.leaseToken, messageId, outgoing.chatId, finalNote)) throw new Error("Outbox delivery lease was lost.");
      if(job.type==='assistant_reply') {
        const turnId=(job.payload as {turnId?:unknown})?.turnId;
        if(typeof turnId==='string')await store.db.prepare(`UPDATE assistant_turns SET delivered_at=COALESCE(delivered_at,?),
          diagnostic_json=CASE WHEN completed_at IS NOT NULL AND diagnostic_json IS NOT NULL
            THEN json_set(diagnostic_json,'$.deliveryMs',MAX(0,?-COALESCE(completed_at,?))) ELSE diagnostic_json END WHERE id=?`)
          .bind(Date.now(),Date.now(),Date.now(),turnId).run();
      }
      stats.sent++;
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : 0;
      // D1 outages must propagate: do not falsely mark a delivery as successful.
      if (!(error instanceof TelegramError)) throw error;
      if (error.retryable && job.attempts < 8) {
        const delay = Math.max(error.retryAfter * 1000, Math.min(3_600_000, 15_000 * 2 ** (job.attempts - 1)));
        await store.retryJob(job.id, job.leaseToken, now + delay, `telegram_${code}`); stats.retried++;
      } else {
        await store.failJob(job.id, job.leaseToken, `telegram_${code}`); stats.failed++;
      }
    } finally {
      if(publicationLock) await store.db.prepare('DELETE FROM publication_locks WHERE chat_id=? AND thread_id=? AND lease_token=?')
        .bind(publicationLock.chatId,publicationLock.threadId,publicationLock.token).run();
    }
  }
  return stats;
}
