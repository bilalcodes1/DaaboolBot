import { isSchoolDate } from './channel-calendar';
import { EventStore, type JobRecord } from './event-store';
import { addCalendarDays, getBaghdadNow } from './calendar';
import { getManualReminderConfig, manualOutgoing, queueManualReminders, recordManualDelivery } from './manual-delivery';
import { dailyPublicationOutgoing, recordPublication, type PublicationPayload } from './daily-publications';
import { formatTimetableNotification, loadEffectiveTimetable } from './manual-timetable';
import { queueControlledJob, getAutomationConfig, dispatchControlledJobs, type ControlledHandler, type ControlledOutgoing, type ControlledTelegram } from './controlled-scheduler';
import { controlledNewsHandler, queueControlledNews } from './content-sources';
import { controlledPrayerHandler, queueControlledPrayers } from './prayer-times';
import { controlledDhikrHandler, queueDailyDhikr } from './adhkar';
import { dailyVerseHandler, queueDailyVerse } from './daily-verse';
import { prepareProductSources } from './product-sources';
import { prepareUsefulBrief, usefulBriefHandler } from './useful-briefs';
import { cleanupGroupMemory } from './group-chat';
import { escapeHtml } from './format';
import type { AssistantReference } from './assistant-references';
import type { Env } from './types';

interface AcademicPayload extends PublicationPayload {configRevision:number;mode:'schedule'|'announcements'}
interface AcademicOutgoing extends ControlledOutgoing {publicationRefs?:AssistantReference[];publicationRemaining?:AssistantReference[]}
export async function queueProductAcademic(db:D1Database,now:number):Promise<number>{
 const cfg=await getManualReminderConfig(db),settings=await new EventStore(db).getSettings(),clock=getBaghdadNow(new Date(now));
 if(!cfg.enabled||settings.targetChatId===null)return 0;let count=0;
 for(const [mode,minute] of [['schedule',960]] as const){
  const dueAt=Date.parse(`${clock.date}T00:00:00+03:00`)+minute*60000;
  if(now<dueAt||now>=dueAt+30*60000)continue;
  const payload:AcademicPayload={version:1,mode,configRevision:cfg.revision,date:addCalendarDays(clock.date,1).date,chatId:settings.targetChatId,threadId:settings.targetThreadId,dueAt,expiresAt:dueAt+30*60000,manual:false};
  if(await queueControlledJob(db,{id:`controlled:academic:${mode}:${clock.date}`,type:'controlled_academic',payload,dueAt,expiresAt:payload.expiresAt,chatId:payload.chatId,threadId:payload.threadId,family:'academic'},now))count++;
 }return count;
}
const academicHandler:ControlledHandler={types:['controlled_academic'],async resolve(db,job,now):Promise<AcademicOutgoing|null>{
 const p=job.payload as AcademicPayload|null,cfg=await getManualReminderConfig(db),settings=await new EventStore(db).getSettings(),clock=getBaghdadNow(new Date(now));
 if(!p||p.version!==1||!cfg.enabled||cfg.revision!==p.configRevision||p.chatId!==settings.targetChatId||p.threadId!==settings.targetThreadId||p.date!==addCalendarDays(clock.date,1).date||now<p.dueAt||now>=p.expiresAt)return null;
 if(p.mode==='announcements')return null;
 if(p.mode!=='schedule'||getBaghdadNow(new Date(p.dueAt)).minuteOfDay!==960)return null;
 if (!await isSchoolDate(db, p.date)) return null;
 let text = formatTimetableNotification(await loadEffectiveTimetable(db), p.date);
 if (text === null) return null;
 const changes=await db.prepare("SELECT body_json,certainty FROM academic_reports WHERE state='active' AND kind='lecture_change' AND event_date=? AND destination_chat_id=? AND COALESCE(destination_thread_id,0)=? ORDER BY updated_at DESC LIMIT 5").bind(p.date,p.chatId,p.threadId??0).all<{body_json:string;certainty:string}>();
 for (const row of changes.results) {
   const item = JSON.parse(row.body_json) as { details?: string };
   const details = item.details?.trim();
   if (!details) continue;
   const title = row.certainty === 'asserted' ? 'تغيير بالجدول' : '⚠️ تغيير محتمل بالجدول';
   const section = `\n\n<b>${title}</b>\n${escapeHtml(details.slice(0, 500))}`;
   if (text.length + section.length < 4000) text += section;
 }
 return {chatId:p.chatId,method:'sendMessage',family:'academic',payload:{chat_id:p.chatId,...(p.threadId===null?{}:{message_thread_id:p.threadId}),text,parse_mode:'HTML'}};
},async delivered(db,job,out,result,now){
 const refs=(out as AcademicOutgoing).publicationRefs,r=result as {message_id?:number};
 if(refs?.length&&r.message_id)await recordPublication(db,refs,out.chatId,(job.payload as AcademicPayload).threadId,r.message_id,now,job.id);
 const remaining=(out as AcademicOutgoing).publicationRemaining;
 if(remaining?.length){const p={...(job.payload as AcademicPayload),refs:remaining};await queueControlledJob(db,{id:job.id+':next',type:'controlled_academic',payload:p,dueAt:now+60000,expiresAt:p.expiresAt,chatId:p.chatId,threadId:p.threadId,family:'academic'},now);}
}};
export const PRODUCT_HANDLERS:readonly ControlledHandler[]=[
 {types:['controlled_manual'],resolve:manualOutgoing,delivered:(db,job,_out,result,now)=>recordManualDelivery(db,job,result,now)},
 academicHandler,controlledNewsHandler,controlledPrayerHandler,controlledDhikrHandler,dailyVerseHandler,usefulBriefHandler,
];
const productJobTypes=PRODUCT_HANDLERS.flatMap(handler=>handler.types);
function hasDueProductJob(db:D1Database,now:number){
 return db.prepare(`SELECT 1 FROM outbox WHERE type IN (${productJobTypes.map(()=>'?').join(',')})
  AND ((state='pending' AND due_at<=?) OR (state='sending' AND lease_until<=?)) LIMIT 1`).bind(...productJobTypes,now,now).first();
}
/** One coordinator; the old cron branch never runs in product mode. All external transports are injectable. */
export async function runProductCron(env:Env,telegram:ControlledTelegram,now:number,fetcher:typeof fetch=fetch){
 if(!env.DB)return null;
 const db=env.DB,clock=getBaghdadNow(new Date(now));
 // A missed one-minute prayer window must not remain at the head of the due
 // queue and block today's current prayer or source refresh work.
 await db.prepare("UPDATE outbox SET state='cancelled',last_error='expired_prayer_window',lease_token=NULL,lease_until=NULL WHERE type='controlled_prayer' AND state='pending' AND EXISTS(SELECT 1 FROM controlled_jobs j WHERE j.job_id=outbox.id AND j.expires_at<=?)").bind(now).run();
 // Privacy retention is independent of AI/provider/automation feature flags.
 if(clock.minuteOfDay%60===5){
  // A one-minute prayer window must not be consumed by hourly maintenance.
  // Defer maintenance to the next hourly pass rather than sending the prayer late.
  if(env.PRODUCT_AUTOMATION_ENABLED==='true'&&(await getAutomationConfig(db,'product')).enabled){
   const due=await hasDueProductJob(db,now);
   if(due)return dispatchControlledJobs(db,telegram,now,PRODUCT_HANDLERS,{limit:1});
  }
  await cleanupGroupMemory(db,now);await db.batch([
  db.prepare('DELETE FROM manual_panels WHERE expires_at<?').bind(now),db.prepare('DELETE FROM manual_forms WHERE expires_at<?').bind(now),
  db.prepare('DELETE FROM controlled_prayer_cache WHERE local_date<?').bind(clock.date),
 ]);await new EventStore(db).cleanup(now);return null;}
 if(env.PRODUCT_AUTOMATION_ENABLED!=='true'||!(await getAutomationConfig(db,'product')).enabled)return null;
 await queueProductAcademic(db,now);
 // Prefer a separate invocation for delivery. One send keeps free-plan query/subrequest headroom.
 const due=await hasDueProductJob(db,now);
 if(due)return dispatchControlledJobs(db,telegram,now,PRODUCT_HANDLERS,{limit:1});
 const phase=clock.minuteOfDay%6;
 if(phase===0)await queueManualReminders(db,now);
 if(phase===1){await prepareProductSources(db,env,now,fetcher);await queueControlledNews(db,now);}
 if(phase===2){
  const started=performance.now();
  if(await queueControlledPrayers(db,now,fetcher)){
   const current=now+Math.floor(performance.now()-started);
   if(await hasDueProductJob(db,current))return dispatchControlledJobs(db,telegram,current,PRODUCT_HANDLERS,{limit:1});
  }
 }
 if(phase===3&&await queueDailyVerse(db,now,fetcher))return null;
 if(phase===3&&await queueDailyDhikr(db,now,fetcher))return null;
 if(phase>=3&&await prepareUsefulBrief(db,env,now,fetcher))return null;
 // Receipt callbacks and quarantine are still repaired when no due delivery is visible.
 if(phase===5)return dispatchControlledJobs(db,telegram,now,PRODUCT_HANDLERS,{limit:1});
 return null;
}
