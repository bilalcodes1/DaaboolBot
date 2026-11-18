import {getBaghdadNow} from './calendar';
import { isAdmin,sharesDestination } from './admin';
import { getAcademicReport,getAcademicReportsByIds,readAcademicReports,formatAcademicReport, type AcademicReport, type AcademicSource } from './academic-ai';
import { EventStore, type EventRecord } from './event-store';
import { queuePublicationDeletion, queueStatusUpdate } from './event-jobs';
import { normalizeArabic } from './input';
import { extractEventQuery } from './event-extract';

export interface AnnouncementReference { kind: 'legacy' | 'academic'; id: string; revision: number }
export interface ReferenceCancellationResult { text: string; reportIds: string[]; eventIds: string[] }

/** This only recognizes an explicit current command. The reference must still
 * come from the caller's durable message mapping, never a model ID or text match. */
export function referencedCancellationIntent(text: string): 'delete' | 'cancel' | null {
  const value = normalizeArabic(text.replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/gu,' ')).replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  if (/(?:^|\s)(?:لا|مو|مش|بدون|لات|مت)\s*(?:تحذف|تمسح|تشيل|تلغي|احذف|امسح|شيل|الغي)/u.test(value)
    || /(?:ما\s*(?:اريد|تريد|يحتاج)|لازم ما)\s*(?:ان\s*)?(?:تحذف|تمسح|تشيل|تلغي|احذف|امسح|شيل|الغي)/u.test(value)
    || /(?:^|\s)(?:اذا|لو|مثال|مثلا|افترض|فرضاً|فرضنا|شنو معني|شنو يعني|ما معني|شلون|كيف)(?:\s|$)/u.test(value)
    || /(?:^|\s)(?:قال|قالت|گال|گالت|كال|كالت|يقول|يكول|يگول|كتب)\s+(?:(?:لي|لنا|له|لهم|ان|انه)\s+)?(?:احذف|امسح|شيل|الغي)/u.test(value)
    || /[؟?]/u.test(text)) return null;
  const boundary = '(?:^|[^\\p{L}])';
  const end = '(?=$|[^\\p{L}])';
  if (new RegExp(`${boundary}(?:احذف(?:ه|ها|لي|ليه|ليها)?|امسح(?:ه|ها|لي|ليه|ليها)?|شيل(?:ه|ها|لي|ليه|ليها)?)${end}`, 'u').test(value)
    || /^(?:اريد|يرجي|رجاء)(?:\s|$).*(?:حذف|مسح)/u.test(value)) return 'delete';
  if (new RegExp(`${boundary}(?:الغ|الغي(?:ه|ها|لي)?|الغوا)${end}`, 'u').test(value)
    || /^(?:(?:اريد|يرجي|رجاء)\s+)?الغاء(?:\s|$)/u.test(value)) return 'cancel';
  return null;
}

function result(text: string, reportIds: string[] = [], eventIds: string[] = []): ReferenceCancellationResult { return { text, reportIds, eventIds }; }
function validReference(value: AnnouncementReference): boolean {
  return ['legacy', 'academic'].includes(value.kind) && typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.id)
    && Number.isSafeInteger(value.revision) && value.revision > 0;
}
/** A reply proves identity, but explicit current selectors must agree with it.
 * Never let a unique previous result override a newly named course/date/group. */
function cancellationDetailsConflict(source: AcademicSource, item: { course: string | null; kind: string | null; date: string | null; audience: string | null }): string | null {
  const query = extractEventQuery(source.text, new Date(source.now));
  if (query.clarification) return `${query.clarification}\nما ألغيت أي تبليغ من هالطلب.`;
  if (query.kinds && query.kinds.length > 1) return 'حدد نوع تبليغ واحد، ورد على نسخته حتى ألغيه. ما ألغيت أي تبليغ من هالطلب.';
  if (query.course !== null && query.course !== item.course || query.kind !== null && query.kind !== item.kind
    || query.date !== null && query.date !== item.date || query.audience !== null && query.audience !== item.audience
    || query.dateRange && (!item.date || item.date < query.dateRange.fromDate || item.date > query.dateRange.toDate)) {
    return 'تفاصيل طلبك تختلف عن التبليغ المشار إليه. رد على التبليغ المطابق للمادة والموعد والمجموعة اللي تقصدها؛ ما ألغيت أي تبليغ.';
  }
  return null;
}
/** Resolve named selectors from visible records, or narrow a durable multi-record
 * reply. Reply text/partial quotes are never parsed as record identity. */
export async function cancellationTarget(db:D1Database,source:AcademicSource,refs:AnnouncementReference[]):Promise<{target:AnnouncementReference|null;text:string|null}> {
 const none=(text:string)=>({target:null,text});
 const replay=await db.prepare('SELECT author_id,source_chat_id,source_thread_id,source_message_id,source_text,analysis_json FROM academic_intakes WHERE id=?')
  .bind(`referenced-cancel:${source.updateId}`).first<{author_id:number;source_chat_id:number;source_thread_id:number|null;source_message_id:number;source_text:string;analysis_json:string}>();
 if(replay){
  if(replay.author_id!==source.userId||replay.source_chat_id!==source.chatId||replay.source_thread_id!==source.threadId||replay.source_message_id!==source.messageId||replay.source_text!==source.text)throw Error('Cancellation source mismatch');
  const saved=JSON.parse(replay.analysis_json) as {reference:AnnouncementReference};
  if(validReference(saved.reference))return {target:saved.reference,text:null};
 }
 const q=extractEventQuery(source.text,new Date(source.now));
 if(q.clarification)return none(q.clarification+' ما ألغيت أي تبليغ.');
 if(q.kinds&&q.kinds.length>1)return none('حدد نوع تبليغ واحد حتى ألغيه؛ ما ألغيت أي تبليغ.');
 const fits=(item:{course:string|null;kind:string|null;date:string|null;audience:string|null})=>
  (!q.course||q.course===item.course)&&(!q.kind||q.kind===item.kind)&&(!q.date||q.date===item.date)
  &&(!q.audience||q.audience===item.audience)&&(!q.dateRange||!!item.date&&item.date>=q.dateRange.fromDate&&item.date<=q.dateRange.toDate);
 if(refs.length){
  if(refs.length===1)return {target:refs[0]!,text:null}; // Existing conflict + revision checks remain authoritative.
  if(!q.course)return none('القائمة بيها أكثر من تبليغ؛ اذكر المادة والنوع، مثل «احذف كوز الرسومات».');
  if(refs.length>12)return none('القائمة طويلة؛ اطلب تبليغات المادة المقصودة أولاً.');
  const academic=await getAcademicReportsByIds(db,refs.filter(r=>r.kind==='academic').map(r=>r.id));
  const store=new EventStore(db),selected:AnnouncementReference[]=[];
  for(const ref of refs){
   const record=ref.kind==='academic'?academic.find(r=>r.id===ref.id):await store.getEvent(ref.id);
   if(record&&fits('item' in record?record.item:record.draft))selected.push(ref);
  }
  return selected.length===1?{target:selected[0]!,text:null}:none(selected.length?'أكو أكثر من تبليغ لنفس المادة؛ حدّد النوع والموعد حتى ألغي واحداً فقط.':'تفاصيل طلبك تختلف عن القائمة المشار إليها؛ ما ألغيت أي تبليغ.');
 }
 if(!q.course)return none('اذكر المادة والنوع، مثل «احذف كوز الرسومات»، أو رد على رسالة التبليغ المقصود.');
 const store=new EventStore(db),settings=await store.getSettings();
 if(settings.targetChatId===null||!sharesDestination(source.chatId,settings.targetChatId))return none('اطلب الحذف بالخاص أو بالكروب المرتبط بالقناة.');
 const academic=await readAcademicReports(db,source.text,new Date(source.now),{viewerId:source.userId,chatId:source.chatId,limit:3});
 const legacy=(await store.listApproved({course:q.course,...(q.kind?{kind:q.kind as 'exam'|'quiz'|'homework'}:{}),
  ...(q.date?{date:q.date}:{dateFrom:q.dateRange?.fromDate??getBaghdadNow(new Date(source.now)).date}),...(q.dateRange?{dateTo:q.dateRange.toDate}:{})}))
  .filter(r=>(r.publishedChatId===null||r.publishedChatId===settings.targetChatId&&r.publishedThreadId===settings.targetThreadId)&&fits(r.draft));
 const candidates:AnnouncementReference[]=[...academic.map(r=>({kind:'academic' as const,id:r.id,revision:r.revision})),...legacy.map(r=>({kind:'legacy' as const,id:r.id,revision:r.revision}))];
 return candidates.length===1?{target:candidates[0]!,text:null}:none(candidates.length?'أكو أكثر من تبليغ مطابق؛ حدّد موعده أو المجموعة حتى ألغي واحداً فقط.':'ما لقيت تبليغاً فعالاً مطابقاً للمادة والنوع ضمن هالمحادثة؛ ما حذفت شي.');
}

async function repairLegacyJobs(store: EventStore, event: EventRecord, now: number): Promise<void> {
  if (event.publicationDeletionRevision === event.revision) await queuePublicationDeletion(store, event.id, event.revision, now);
  else await queueStatusUpdate(store, event.id, event.revision, now);
}
async function cancelLegacy(store: EventStore, source: AcademicSource, reference: AnnouncementReference,
  ownerUid: number | null, mode: 'delete' | 'cancel'): Promise<ReferenceCancellationResult> {
  const previous = await store.getEvent(reference.id);
  if (!previous) return result('التبليغ المشار إليه مو موجود عندي.');
  if (previous.authorId !== source.userId && !isAdmin(source.userId, ownerUid)) return result('حذف أو إلغاء التبليغ متاح لصاحبه أو للمالك فقط.');
  const conflict = cancellationDetailsConflict(source, previous.draft);
  if (conflict) return result(conflict);
  if (previous.status === 'cancelled') {
    await repairLegacyJobs(store, previous, source.now);
    return result('هذا التبليغ ملغي أصلاً، وما راح يدخل بالجدول أو التذكيرات.', [], [previous.id]);
  }
  if (previous.revision !== reference.revision) return result('التبليغ تغيّر بعد هاي الرسالة؛ رد على آخر نسخة حتى ألغيه بدون ما ألمس تحديثاً جديداً.');
  const removePublication = mode === 'delete' && isAdmin(source.userId, ownerUid);
  const changed = removePublication ? await store.requestPublicationDeletion(previous.id, reference.revision)
    : await store.updateEvent(previous.id, reference.revision, { status: 'cancelled' });
  if (!changed) return result('التبليغ تغيّر بنفس الوقت؛ رد على آخر نسخة حتى ألغيه.');
  await repairLegacyJobs(store, changed, source.now);
  return result(removePublication
    ? `🗑 انحذف التبليغ من نتائج البوت وتذكيراته.${changed.publishedMessageId !== null ? ' إزالة منشوره ومرفقه بالطريق.' : ''}`
    : '✅ ألغيت التبليغ وشلته من نتائج الجدول والتذكيرات.', [], [changed.id]);
}

async function cancelAcademic(db: D1Database, source: AcademicSource, reference: AnnouncementReference,
  ownerUid: number | null, intakeId: string): Promise<ReferenceCancellationResult> {
  const previous = await getAcademicReport(db, reference.id);
  if (!previous) return result('التبليغ المشار إليه مو موجود عندي.');
  if (previous.authorId !== source.userId && !isAdmin(source.userId, ownerUid)) return result('حذف أو إلغاء التبليغ متاح لصاحبه أو للمالك فقط.');
  const conflict = cancellationDetailsConflict(source, previous.item);
  if (conflict) return result(conflict);
  if (previous.state === 'cancelled') return result('هذا التبليغ ملغي أصلاً، وما راح يدخل بالجدول أو التذكيرات.', [previous.id]);
  if (previous.revision !== reference.revision) return result('التبليغ تغيّر بعد هاي الرسالة؛ رد على آخر نسخة حتى ألغيه بدون ما ألمس تحديثاً جديداً.');
  const changed: AcademicReport = { ...previous, revision: previous.revision + 1, state: 'cancelled',
    lastUpdateId: source.updateId, updatedAt: source.now };
  // Cancellation is silent in the channel: commit CAS and undo audit, then
  // invalidate any queued publication of this report in the same transaction.
  const written = await db.batch([
    db.prepare(`UPDATE academic_reports SET revision=revision+1,state='cancelled',last_update_id=?,updated_at=?
      WHERE id=? AND revision=? AND state='active' AND (author_id=? OR EXISTS(SELECT 1 FROM settings WHERE singleton=1 AND (owner_uid=? OR (owner_uid=0 AND ?=0))))`)
      .bind(source.updateId, source.now, previous.id, reference.revision, source.userId, source.userId, source.userId),
    db.prepare(`INSERT OR IGNORE INTO academic_report_changes(report_id,revision,actor_id,intake_id,before_json,after_json,created_at)
      SELECT ?,?,?,?,?,?,? FROM academic_reports WHERE id=? AND revision=? AND state='cancelled' AND last_update_id=?`)
      .bind(changed.id, changed.revision, source.userId, intakeId, JSON.stringify(previous), JSON.stringify(changed), source.now,
        changed.id, changed.revision, source.updateId),
    db.prepare(`UPDATE outbox SET state='cancelled',lease_until=NULL,lease_token=NULL,last_error='silent_cancellation'
      WHERE type='academic_report' AND state IN ('pending','sending') AND json_valid(payload_json)
        AND json_extract(payload_json,'$.reportId')=? AND EXISTS(SELECT 1 FROM academic_reports
          WHERE id=? AND revision=? AND state='cancelled' AND last_update_id=?)`)
      .bind(changed.id,changed.id,changed.revision,source.updateId),
  ]);
  return written[0]?.meta.changes ? result(`✅ ألغيت التبليغ وشلته من نتائج الجدول والتذكيرات.\n${formatAcademicReport(changed).split('\n')[0]} — ${changed.item.date??'الموعد غير محدد'}`, [changed.id])
    : result('التبليغ تغيّر بنفس الوقت؛ رد على آخر نسخة حتى ألغيه.');
}

/** The caller resolves exactly one current-chat/topic reference from a bot
 * message saved in D1. Public channel posts may be referenced from their linked
 * discussion group, so author/owner authorization is independent of destination.
 * No user text, reply quote or AI output is used to select a record here. */
export async function cancelReferencedAnnouncement(db: D1Database, source: AcademicSource,
  reference: AnnouncementReference): Promise<ReferenceCancellationResult | null> {
  const mode = referencedCancellationIntent(source.text);
  if (!mode) return null;
  if (!validReference(reference)) return result('رد على تبليغ محدد حتى أعرف أي واحد تريد تلغيه.');
  if (!Number.isSafeInteger(source.updateId) || source.updateId < 0 || !Number.isSafeInteger(source.userId) || source.userId <= 0
    || !Number.isSafeInteger(source.chatId) || source.chatId === 0 || !Number.isSafeInteger(source.messageId) || source.messageId <= 0
    || !Number.isFinite(source.now) || source.text.length > 8192) throw new RangeError('Invalid referenced cancellation source.');
  const intakeId = `referenced-cancel:${source.updateId}`;
  const operation = JSON.stringify({ reference: { kind: reference.kind, id: reference.id, revision: reference.revision }, mode });
  await db.prepare(`INSERT OR IGNORE INTO academic_intakes(id,author_id,source_chat_id,source_thread_id,source_message_id,source_text,analysis_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(intakeId, source.userId, source.chatId, source.threadId, source.messageId, source.text, operation, source.now).run();
  const intake = await db.prepare(`SELECT author_id,source_chat_id,source_thread_id,source_message_id,source_text,analysis_json,response_json
    FROM academic_intakes WHERE id=?`).bind(intakeId).first<{ author_id: number; source_chat_id: number; source_thread_id: number | null;
      source_message_id: number; source_text: string; analysis_json: string; response_json: string | null }>();
  if (!intake || intake.author_id !== source.userId || intake.source_chat_id !== source.chatId || intake.source_thread_id !== source.threadId
    || intake.source_message_id !== source.messageId || intake.source_text !== source.text || intake.analysis_json !== operation) {
    throw new Error('Referenced cancellation identity mismatch.');
  }
  if (intake.response_json) return JSON.parse(intake.response_json) as ReferenceCancellationResult;
  const store = new EventStore(db);
  const settings = await store.getSettings();
  const outcome = reference.kind === 'legacy'
    ? await cancelLegacy(store, source, reference, settings.ownerUid, mode)
    : await cancelAcademic(db, source, reference, settings.ownerUid, intakeId);
  const recorded = await db.prepare('UPDATE academic_intakes SET response_json=? WHERE id=? AND response_json IS NULL').bind(JSON.stringify(outcome), intakeId).run();
  if (recorded.meta.changes) return outcome;
  const cached = await db.prepare('SELECT response_json FROM academic_intakes WHERE id=?').bind(intakeId).first<{ response_json: string | null }>();
  return cached?.response_json ? JSON.parse(cached.response_json) as ReferenceCancellationResult : outcome;
}
