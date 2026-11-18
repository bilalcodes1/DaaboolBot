import { EventStore, type JobRecord } from './event-store';
import { queueControlledJob } from './controlled-scheduler';
import { isAdmin } from './admin';
import { escapeHtml } from './format';
import { splitAssistantHtml } from './assistant-store';
import { recordPublication } from './daily-publications';
import { describeAnnouncementNotice, getManualAnnouncement, type ManualAnnouncementReference } from './manual-academic';
import { cleanManualText, manualCommand, requireManualAdmin, type ManualScope, type ManualCommandResult } from './manual-store';

export interface ManualEnabledConfig {enabled:boolean;revision:number}
export async function getManualConfig(db:D1Database,key:'academic_publications'|'academic_reminders'):Promise<ManualEnabledConfig> {
  const row=await db.prepare('SELECT revision,value_json FROM manual_settings WHERE key=?').bind(key).first<{revision:number;value_json:string}>();
  return {revision:row?.revision??0,enabled:row?JSON.parse(row.value_json).enabled===true:false};
}
export const getManualPublicationConfig=(db:D1Database)=>getManualConfig(db,'academic_publications');
export const getManualReminderConfig=(db:D1Database)=>getManualConfig(db,'academic_reminders');
export async function setManualConfig(db:D1Database,scope:ManualScope,updateId:number,now:number,key:'academic_publications'|'academic_reminders',expectedRevision:number,enabled:boolean):Promise<ManualCommandResult> {
  return manualCommand(db,scope,updateId,{action:'settings',key,expectedRevision,enabled},now,(gate,args)=>[
    db.prepare(`UPDATE manual_settings SET revision=revision+1,value_json=?,updated_by=?,updated_at=? WHERE key=? AND revision=? AND ${gate}`)
      .bind(JSON.stringify({enabled}),scope.userId,now,key,expectedRevision,...args),
  ],{ok:true,revision:expectedRevision+1,message:enabled?'تم التشغيل.':'تم الإيقاف؛ المواعيد القديمة ما تُرسل.'});
}
export interface ManualReminder {id:string;revision:number;enabled:boolean;state:'active'|'cancelled';text:string;dueAt:number;chatId:number;threadId:number|null;actorId:number}
interface ReminderRow {id:string;revision:number;enabled:number;state:'active'|'cancelled';body_json:string;due_at:number;chat_id:number;thread_id:number|null;actor_id:number}
function reminder(row:ReminderRow):ManualReminder {return {id:row.id,revision:row.revision,enabled:row.enabled===1,state:row.state,text:(JSON.parse(row.body_json) as {text:string}).text,dueAt:row.due_at,chatId:row.chat_id,threadId:row.thread_id,actorId:row.actor_id};}
export async function getManualReminder(db:D1Database,id:string):Promise<ManualReminder|null> {
  const row=await db.prepare('SELECT * FROM manual_reminders WHERE id=?').bind(id).first<ReminderRow>();return row?reminder(row):null;
}
export async function listManualReminders(db:D1Database,offset=0):Promise<ManualReminder[]> {
  const rows=await db.prepare('SELECT * FROM manual_reminders ORDER BY due_at DESC,id LIMIT 7 OFFSET ?').bind(Math.max(0,offset)).all<ReminderRow>();return rows.results.map(reminder);
}
export async function saveManualReminder(db:D1Database,scope:ManualScope,updateId:number,now:number,input:Omit<ManualReminder,'id'|'revision'|'actorId'|'state'>,ref?:{id:string;revision:number}):Promise<ManualCommandResult> {
  const text=cleanManualText(input.text,3000);
  const config=await new EventStore(db).getSettings();
  if(!Number.isFinite(input.dueAt)||input.dueAt<=now||input.dueAt>now+366*86400000||!Number.isSafeInteger(input.chatId)||input.chatId!==config.targetChatId||input.threadId!==config.targetThreadId)throw new RangeError('الوجهة لازم تكون وجهة النشر المرتبطة والموعد قادم خلال سنة.');
  const id=ref?.id??`reminder-${updateId}`,revision=(ref?.revision??0)+1;
  return manualCommand(db,scope,updateId,{action:'reminder-save',ref:ref??null,input:{...input,text}},now,(gate,args)=>[
    ref?db.prepare(`UPDATE manual_reminders SET revision=revision+1,body_json=?,due_at=?,chat_id=?,thread_id=?,enabled=?,actor_id=?,updated_at=? WHERE id=? AND revision=? AND state='active' AND ${gate}`)
      .bind(JSON.stringify({text}),input.dueAt,input.chatId,input.threadId,Number(input.enabled),scope.userId,now,id,ref.revision,...args)
      :db.prepare(`INSERT INTO manual_reminders(id,revision,enabled,body_json,due_at,chat_id,thread_id,actor_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${gate}`)
        .bind(id,revision,Number(input.enabled),JSON.stringify({text}),input.dueAt,input.chatId,input.threadId,scope.userId,now,now,...args),
  ],{ok:true,id,revision,message:'تم حفظ التذكير. التشغيل يحتاج تفعيل التذكير وخدمة التذكيرات.'});
}
export async function changeManualReminderState(db:D1Database,scope:ManualScope,updateId:number,now:number,ref:{id:string;revision:number},mode:'enable'|'disable'|'cancel'):Promise<ManualCommandResult> {
  return manualCommand(db,scope,updateId,{action:'reminder-state',ref,mode},now,(gate,args)=>[
    db.prepare(`UPDATE manual_reminders SET revision=revision+1,enabled=?,state=?,actor_id=?,updated_at=? WHERE id=? AND revision=? AND state='active' AND ${gate}`)
      .bind(Number(mode==='enable'),mode==='cancel'?'cancelled':'active',scope.userId,now,ref.id,ref.revision,...args),
  ],{ok:true,id:ref.id,revision:ref.revision+1,message:mode==='enable'?'تم تفعيل التذكير.':mode==='disable'?'تم تعطيل التذكير.':'تم إلغاء التذكير.'});
}
export interface ManualPublicationPayload {version:1;family:'announcement'|'reminder';actorId:number;chatId:number;threadId:number|null;dueAt:number;expiresAt:number;configRevision:number;ref?:ManualAnnouncementReference;reminderId?:string;revision?:number}
export async function queueManualPublication(db:D1Database,scope:ManualScope,updateId:number,now:number,ref:ManualAnnouncementReference,dueAt:number):Promise<ManualCommandResult> {
  await requireManualAdmin(db,scope);
  const store=new EventStore(db),settings=await store.getSettings(),config=await getManualPublicationConfig(db),row=await getManualAnnouncement(db,ref);
  if(!row||row.revision!==ref.revision||!['active','approved'].includes(row.state))return {ok:false,message:'التبليغ تغيّر أو غير فعال.'};
  if(settings.targetChatId===null||!config.enabled)return {ok:false,message:'اربط وجهة النشر وفعّل المنشورات من الإعدادات أولاً.'};
  if(!Number.isFinite(dueAt)||dueAt<now||dueAt>now+366*86400000)throw new RangeError('موعد النشر غير صالح.');
  const base=`controlled:manual:${ref.kind}:${ref.id}:${ref.revision}:${settings.targetChatId}:${settings.targetThreadId??0}`;
  const previous=await db.prepare('SELECT id,state,last_error FROM outbox WHERE id=? OR substr(id,1,?)=? ORDER BY id').bind(base,base.length+2,base+':q').all<{id:string;state:string;last_error:string|null}>();
  if(previous.results.some(j=>j.state==='sent'))return {ok:false,message:'هذه النسخة منشورة؛ ما كررتها.'};
  if(previous.results.some(j=>j.last_error?.includes('unknown')||j.last_error==='delivery_response_missing_id'))return {ok:false,message:'نتيجة إرسال سابق مجهولة؛ راجع دليل التسليم أولاً، ما أكررها.'};
  const active=previous.results.find(j=>j.state==='pending'||j.state==='sending');
  const id=active?.id??`${base}:q${previous.results.length}`;
  const payload:ManualPublicationPayload={version:1,family:'announcement',actorId:scope.userId,chatId:settings.targetChatId,threadId:settings.targetThreadId,dueAt,expiresAt:dueAt+30*60000,configRevision:config.revision,ref};
  const existing=await store.getJob(id);
  if(existing){
    if(existing.state==='sent')return {ok:false,id,message:'هذه النسخة منشورة؛ ما كررتها.'};
    if(existing.state==='cancelled'||existing.state==='failed')return {ok:false,id,message:'طلب النسخة مسجل بحالة مغلقة؛ راجع حالة التسليم قبل إعادة الإرسال.'};
    if((existing.payload as ManualPublicationPayload).dueAt!==dueAt)return {ok:false,id,message:'هذه النسخة مجدولة من قبل؛ ألغِ الموعد السابق أولاً.'};
  }
  // Durable operation intent precedes idempotent queue insertion; a retry repairs a missing job.
  const result=await manualCommand(db,scope,updateId,{action:'publication-queue',ref,dueAt},now,(gate,args)=>[
    db.prepare(`UPDATE manual_settings SET updated_at=updated_at WHERE key='academic_publications' AND revision=? AND json_extract(value_json,'$.enabled')=1 AND ${gate}`).bind(config.revision,...args),
  ],{ok:true,id,message:dueAt===now?'طلب النشر محفوظ؛ نجاح الإرسال يظهر بالحالة.':'تمت جدولة النشر بتوقيت بغداد.'});
  if(result.ok)await queueControlledJob(db,{id,type:'controlled_manual',payload,dueAt,chatId:payload.chatId,threadId:payload.threadId,family:'official',expiresAt:payload.expiresAt},now);
  return result;
}
export async function cancelManualPublication(db:D1Database,scope:ManualScope,updateId:number,now:number,id:string):Promise<ManualCommandResult> {
  return manualCommand(db,scope,updateId,{action:'publication-cancel',id},now,(gate,args)=>[
    db.prepare(`UPDATE outbox SET state='cancelled',lease_until=NULL,lease_token=NULL WHERE id=? AND type='controlled_manual' AND state='pending' AND ${gate}`).bind(id,...args),
  ],{ok:true,id,message:'تم إلغاء الموعد قبل الإرسال.'});
}
/** Called by the one controlled coordinator; no independent Cron or sender. */
export async function queueManualReminders(db:D1Database,now:number):Promise<number> {
  const config=await getManualReminderConfig(db);if(!config.enabled)return 0;
  const rows=await db.prepare(`SELECT * FROM manual_reminders WHERE state='active' AND enabled=1 AND due_at>=? AND due_at<=? ORDER BY due_at LIMIT 12`).bind(now-30*60000,now+86400000).all<ReminderRow>();
  let count=0;const store=new EventStore(db);
  for(const row of rows.results){
    const payload:ManualPublicationPayload={version:1,family:'reminder',actorId:row.actor_id,chatId:row.chat_id,threadId:row.thread_id,dueAt:row.due_at,expiresAt:row.due_at+30*60000,configRevision:config.revision,reminderId:row.id,revision:row.revision};
    if(await queueControlledJob(db,{id:`controlled:reminder:${row.id}:${row.revision}:${config.revision}`,type:'controlled_manual',payload,dueAt:row.due_at,chatId:row.chat_id,threadId:row.thread_id,family:'academic',expiresAt:payload.expiresAt},now))count++;
  }return count;
}
export async function manualOutgoing(db:D1Database,job:JobRecord,now:number):Promise<{chatId:number;method:'sendMessage';payload:Record<string,unknown>;family:'official'|'academic';priority:number;expiresAt:number}|null> {
  const p=job.payload as ManualPublicationPayload|null;
  if(!p||p.version!==1||!['announcement','reminder'].includes(p.family)||!Number.isFinite(p.dueAt)||!Number.isFinite(p.expiresAt)||now<p.dueAt||now>=p.expiresAt)return null;
  const settings=await new EventStore(db).getSettings();
  if(!isAdmin(p.actorId,settings.ownerUid)||settings.targetChatId!==p.chatId||settings.targetThreadId!==p.threadId)return null;
  const config=await getManualConfig(db,p.family==='announcement'?'academic_publications':'academic_reminders');
  if(!config.enabled||config.revision!==p.configRevision)return null;
  let text:string;
  if(p.family==='announcement'){
    if(!p.ref)return null;const row=await getManualAnnouncement(db,p.ref);
    if(!row||row.revision!==p.ref.revision||!['active','approved'].includes(row.state))return null;
    const receipt=await db.prepare('SELECT 1 FROM publication_receipts WHERE kind=? AND record_id=? AND revision=? AND chat_id=? AND thread_id=?').bind(p.ref.kind,p.ref.id,p.ref.revision,p.chatId,p.threadId??0).first();if(receipt)return null;
    if(row.kind==='academic'&&'destinationChatId' in row.raw&&(row.raw.destinationChatId!==p.chatId||row.raw.destinationThreadId!==p.threadId))return null;
    const item = 'item' in row.raw ? row.raw.item : row.draft;
    const notice = describeAnnouncementNotice(item, true);
    text = `📣 ${notice.heading}${notice.details ? `\n${escapeHtml(notice.details)}` : ''}`;
  }else{
    if(!p.reminderId)return null;const row=await getManualReminder(db,p.reminderId);
    if(!row||row.revision!==p.revision||!row.enabled||row.state!=='active'||row.dueAt!==p.dueAt||row.chatId!==p.chatId||row.threadId!==p.threadId)return null;
    text = `🔔 <b>تذكير</b>\n${escapeHtml(row.text)}`;
  }
  if(text.length>4096){let summary='';for(const page of splitAssistantHtml(text)){if(summary.length+page.length+2>3900)break;summary+=(summary?'\n\n':'')+page;}text=summary+'\n\nالتفاصيل الكاملة من قائمة التبليغات بالخاص.';}
  return {chatId:p.chatId,method:'sendMessage',payload:{chat_id:p.chatId,...(p.threadId===null?{}:{message_thread_id:p.threadId}),text,parse_mode:'HTML'},family:p.family==='announcement'?'official':'academic',priority:p.family==='announcement'?100:80,expiresAt:p.expiresAt};
}
export async function recordManualDelivery(db:D1Database,job:JobRecord,result:unknown,now:number):Promise<void> {
  const p=job.payload as ManualPublicationPayload,r=result as {message_id?:unknown}|null;
  if(p.family==='announcement'&&p.ref&&Number.isSafeInteger(r?.message_id))await recordPublication(db,[p.ref],p.chatId,p.threadId,Number(r!.message_id),now,job.id);
}
export async function listManualPublications(db:D1Database,offset=0):Promise<JobRecord[]> {
  const rows=await db.prepare("SELECT id FROM outbox WHERE type='controlled_manual' ORDER BY due_at DESC,id LIMIT 7 OFFSET ?").bind(offset).all<{id:string}>();
  const store=new EventStore(db);return (await Promise.all(rows.results.map(row=>store.getJob(row.id)))).filter((row):row is JobRecord=>row!==null);
}
