import { addCalendarDays, getBaghdadNow } from './calendar';
import { EventStore } from './event-store';
import { getAcademicReportsByIds } from './academic-ai';
import { escapeHtml } from './format';
import { describeAnnouncementNotice } from './manual-academic';
import { notificationDate } from './notification-format';
import type { AssistantReference } from './assistant-references';

export interface PublicationPayload {
  version: 1; date: string; chatId: number; threadId: number | null;
  dueAt: number; expiresAt: number; manual: boolean; refs?: AssistantReference[];
}
export async function queueDailyAcademicDigest(db: D1Database, now: number): Promise<number> {
  // Retired automatic 18:00 digest. Manual publication remains available.
  return 0;
}

export async function publicationCandidates(db: D1Database, date: string, chatId: number, threadId: number | null,
  range?:{fromDate:string;toDate?:string}): Promise<AssistantReference[]> {
  const filter=range?(range.toDate?'event_date BETWEEN ? AND ?':'(event_date>=? OR event_date IS NULL)'):'event_date=?';
  const dates=range?(range.toDate?[range.fromDate,range.toDate]:[range.fromDate]):[date];
  const result = await db.prepare(`SELECT 'academic' AS kind,id,revision FROM academic_reports WHERE state='active' AND ${filter}
    AND destination_chat_id=? AND COALESCE(destination_thread_id,0)=?
    UNION ALL SELECT 'legacy' AS kind,id,revision FROM events WHERE status='approved' AND duplicate_of IS NULL AND ${filter}
    AND (published_chat_id IS NULL OR published_chat_id=?) LIMIT 100`).bind(...dates,chatId,threadId??0,...dates,chatId).all<AssistantReference>();
  return result.results;
}
export async function dailyPublicationOutgoing(db: D1Database, raw: unknown, now: number) {
  const value = raw as PublicationPayload | null;
  if (!value || value.manual !== true || value.version !== 1 || !Number.isSafeInteger(value.chatId) || typeof value.date !== 'string'
    || !Number.isFinite(value.dueAt) || !Number.isFinite(value.expiresAt) || now < value.dueAt || now >= value.expiresAt) return null;
  const store = new EventStore(db); const settings = await store.getSettings();
  if (settings.targetChatId !== value.chatId || settings.targetThreadId !== value.threadId) return null;
  if (!value.manual && (getBaghdadNow(new Date(now)).minuteOfDay < 1080 || getBaghdadNow(new Date(now)).minuteOfDay >= 1110
    || value.date !== addCalendarDays(getBaghdadNow(new Date(now)).date,1).date)) return null;
  const candidates = value.refs ?? await publicationCandidates(db,value.date,value.chatId,value.threadId);
  const receipts = await db.prepare('SELECT kind,record_id,revision FROM publication_receipts WHERE chat_id=? AND thread_id=?')
    .bind(value.chatId,value.threadId??0).all<{kind:string;record_id:string;revision:number}>();
  const academic = await getAcademicReportsByIds(db,candidates.filter(r=>r.kind==='academic').map(r=>r.id));
  const legacy = candidates.some(r=>r.kind==='legacy') ? await store.listApproved({}) : [];
  const entries: {ref:AssistantReference;heading:string;details:string}[]=[];
  for(const ref of candidates){
    if(receipts.results.some(r=>r.kind===ref.kind&&r.record_id===ref.id&&r.revision===ref.revision))continue;
    const record=ref.kind==='academic'?academic.find(r=>r.id===ref.id&&r.state==='active'&&r.destinationChatId===value.chatId&&r.destinationThreadId===value.threadId)
      :legacy.find(r=>r.id===ref.id&&r.status==='approved'&&r.duplicateOf===null&&(r.publishedChatId===null||r.publishedChatId===value.chatId));
    if(!record||record.revision!==ref.revision)continue;
    const item='item' in record?record.item:record.draft;
    entries.push({ref, ...describeAnnouncementNotice(item, value.manual)});
  }
  const refs:AssistantReference[]=[], remaining:AssistantReference[]=[];
  const title = value.manual ? 'تبليغات دراسية' : `تبليغات باچر · ${notificationDate(value.date)}`;
  let text = `📌 <b>${escapeHtml(title)}</b>`;
  const bounded=(plain:string,budget:number)=>{let result='';for(const char of plain){const escaped=escapeHtml(char);if(result.length+escaped.length>budget)return result+'…';result+=escaped;}return result;};
  for(const entry of entries){
    const detailBudget=Math.max(100,Math.min(1800,Math.floor(3400/Math.max(1,entries.length))-entry.heading.length));
    const details=bounded(entry.details,detailBudget);
    const section = `\n\n${entry.heading}` + (details ? `\n${details}` : '')
      + (details.endsWith('…') ? '\nباقي التفاصيل بقائمة التبليغات.' : '');
    if(text.length+section.length>3950){remaining.push(entry.ref);continue;}
    text+=section;refs.push(entry.ref);
  }
  if(!refs.length)return null;
  if (remaining.length) text += '\n\nباقي التبليغات برسالة ثانية.';
  return {chatId:value.chatId,method:'sendMessage' as const,publicationRefs:refs,publicationRemaining:remaining,
    payload:{chat_id:value.chatId,...(value.threadId!==null?{message_thread_id:value.threadId}:{}),text,parse_mode:'HTML',link_preview_options:{is_disabled:true}}};
}

export async function recordPublication(db:D1Database,refs:AssistantReference[],chatId:number,threadId:number|null,messageId:number,now:number,jobId:string):Promise<void> {
  if (!refs.length) return;
  await db.prepare(`INSERT OR IGNORE INTO publication_receipts(kind,record_id,revision,chat_id,thread_id,message_id,sent_at,job_id)
    SELECT json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.revision'),?,?,?,?,? FROM json_each(?)`)
    .bind(chatId,threadId??0,messageId,now,jobId,JSON.stringify(refs)).run();
}
