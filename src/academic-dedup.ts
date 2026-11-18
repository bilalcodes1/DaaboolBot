import type {AcademicItem,AcademicReport} from './academic-ai';
import {extractEventQuery} from './event-extract';
import {addCalendarDays} from './calendar';
import {normalizeArabic} from './input';
import {COURSE_ALIASES} from './nlu-schema';
import {isAdmin,sharesDestination} from './admin';
const norm=(value:string)=>normalizeArabic(value).toLowerCase().replace(/ة/g,'ه').replace(/ى/g,'ي');
const digits=(value:string)=>value.replace(/[٠-٩۰-۹]/gu,c=>String('٠١٢٣٤٥٦٧٨٩'.includes(c)?'٠١٢٣٤٥٦٧٨٩'.indexOf(c):'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
export function effectiveAcademicDate(item:AcademicItem,createdAt:number):string|null {
 if(item.date)return item.date;
 const query=item.dateEvidence?extractEventQuery(item.dateEvidence,new Date(createdAt)):null;
 return query&&!query.clarification?query.date:null;
}
/** Keep meaningful requirements and every group/time/component/certainty distinct.
 * Only date/course/type boilerplate is ignored, never negation or reading scope. */
export function academicIdentity(item:AcademicItem,createdAt:number):string|null {
 const date=effectiveAcademicDate(item,createdAt);if(!date||!item.course)return null;
 let details=digits(item.details).replace(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?/gu,(token,offset:number,whole:string)=>{
  if(/(?:صفحه|فصل|محاضره|تمرين|سوال)\s*$/u.test(norm(whole.slice(0,offset))))return token;
  return extractEventQuery(token,new Date(createdAt)).date===date?' ':token;
 });
 details=norm(details);
 for(const alias of [...COURSE_ALIASES[item.course]].map(norm).sort((a,b)=>b.length-a.length)) {
  const base=alias.replace(/^ال/u,'');
  details=details.replace(new RegExp(`(?:^|\\s)(?:(?:و|ب|ل)?(?:ال)?|لل)${escape(base)}(?=$|\\s)`,'gu'),' ');
 }
 const dateWords=['الاحد','الاثنين','الثلاثاء','الاربعاء','الخميس','الجمعه','السبت'];
 const weekday=dateWords[addCalendarDays(date,0).weekday]!;
 details=details.replace(new RegExp(`(?:^|\\s)(?:بال|ب|ال)?${weekday.replace(/^ال/u,'')}(?=$|\\s)`,'gu'),' ');
 for(const relative of ['باجر','باچر','غدا','اليوم'])if(extractEventQuery(relative,new Date(createdAt)).date===date)
  details=details.replace(new RegExp(`(?:^|\\s)${relative}(?=$|\\s)`,'gu'),' ');
 details=details.replace(/(?:^|\s)(?:سجل(?:ه|ها)?|احفظ(?:ه|ها)?)\s+عندك(?=$|\s)/gu,' ')
  .replace(/(?:^|\s)(?:عدنا|عندنا|يوم|بتاريخ|تاريخ|المصادف|ماده|بماده|لماده|امتحان|اختبار|كوز|كويز)(?=$|\s)/gu,' ')
  .replace(/\s+/gu,' ').trim();
 return JSON.stringify([item.kind,item.course,date,item.audience,item.component,item.time,item.certainty,
  norm(digits(item.coverage)),[...item.occurrenceSlots].sort(),details]);
}
export async function academicDuplicateKey(item:AcademicItem,createdAt:number):Promise<string|null> {
 return academicIdentity(item,createdAt);
}
export function dateOnlyDuplicateKey(previous:AcademicReport,incoming:AcademicItem,now:number):string|null {
 if(!incoming.date||incoming.coverage||incoming.timeEvidence||incoming.audienceEvidence||incoming.occurrenceEvidence||incoming.component)return null;
 const identity=academicIdentity({...previous.item,date:incoming.date,details:incoming.details},now);
 if(!identity)return null;
 const residue=String((JSON.parse(identity) as unknown[])[9]);
 if(residue.split(' ').some(word=>word&&!['عدل','عدله','اعدل','صحح','بدل','غير','موعد','موعده','موعدها','التاريخ','خليه','خليها','صار','الى','الي','من','و','وخليه','وخليها'].includes(word)))return null;
 const key=previous.dedupeKey??academicIdentity(previous.item,previous.createdAt);if(!key)return null;
 const parts=JSON.parse(key) as unknown[];parts[2]=incoming.date;return JSON.stringify(parts);
}
export function duplicateCleanupIntent(text:string):boolean {
 const n=norm(text);
 return /مكرر|تكرار|نسخ متشابهه/u.test(n)&&/(?:احذف|امسح|شيل|نظف|ازل|ازاله|ادمج|دمج)/u.test(n)
  &&!/(?:^|\s)(?:لا|مو|بدون|لو|اذا|مثال|مثلا|شلون|كيف|قال|كالت|كتب)(?:\s|$)|ما اريد/u.test(n)&&!/[؟?]/u.test(text);
}
export interface DuplicatePlan {canonical:AcademicReport;duplicates:AcademicReport[];key:string}
export async function planAcademicDuplicates(reports:AcademicReport[]):Promise<DuplicatePlan[]> {
 const groups=new Map<string,{canonical:AcademicReport;duplicates:AcademicReport[];key:string}>();
 // Prefer a dated canonical row; otherwise keep the oldest stable identity.
 for(const report of [...reports].sort((a,b)=>Number(!a.dedupeKey)-Number(!b.dedupeKey)||Number(!a.item.date)-Number(!b.item.date)||a.createdAt-b.createdAt||a.id.localeCompare(b.id))) {
  const key=report.dedupeKey??await academicDuplicateKey(report.item,report.createdAt);if(!key)continue;
  const scope=JSON.stringify([report.destinationChatId??report.sourceChatId,report.destinationChatId===null?report.sourceThreadId:report.destinationThreadId,report.authorId,key]);
  const group=groups.get(scope);if(group)group.duplicates.push(report);else groups.set(scope,{canonical:report,duplicates:[],key});
 }
 return [...groups.values()];
}
/** CAS + archive + receipt transfer + physical removal commit together. The
 * archive is audit/recovery data, never a second active announcement. */
export async function mergeAcademicDuplicate(db:D1Database,canonical:AcademicReport,duplicate:AcademicReport,actorId:number,now:number,reason='duplicate_cleanup',projectedKey?:string):Promise<boolean> {
 const key=canonical.dedupeKey??await academicDuplicateKey(canonical.item,canonical.createdAt);
 if(!key||canonical.id===duplicate.id||canonical.authorId!==duplicate.authorId
   ||canonical.destinationChatId!==duplicate.destinationChatId||canonical.destinationThreadId!==duplicate.destinationThreadId
   ||(projectedKey??duplicate.dedupeKey??await academicDuplicateKey(duplicate.item,duplicate.createdAt))!==key)return false;
 const samePublishedContent=(duplicate.dedupeKey??await academicDuplicateKey(duplicate.item,duplicate.createdAt))===key;
 const valid=`EXISTS(SELECT 1 FROM academic_reports c,academic_reports d WHERE c.id=? AND c.revision=? AND c.state='active'
   AND d.id=? AND d.revision=? AND d.state='active')`;
 const args=[canonical.id,canonical.revision,duplicate.id,duplicate.revision];
 const results=await db.batch([
  db.prepare(`INSERT OR IGNORE INTO academic_report_merges(duplicate_id,canonical_id,duplicate_json,canonical_revision,actor_id,merged_at,reason)
    SELECT ?,?,?,?,?,?,? WHERE ${valid}`).bind(duplicate.id,canonical.id,JSON.stringify(duplicate),canonical.revision,actorId,now,reason,...args),
  db.prepare(`INSERT OR IGNORE INTO publication_receipts(kind,record_id,revision,chat_id,thread_id,message_id,sent_at,job_id)
    SELECT kind,?,?,chat_id,thread_id,message_id,sent_at,job_id FROM publication_receipts
    WHERE kind='academic' AND record_id=? AND revision=? AND ?=1 AND ${valid}
      AND EXISTS(SELECT 1 FROM academic_report_merges WHERE duplicate_id=? AND canonical_id=? AND merged_at=?)`)
    .bind(canonical.id,canonical.revision,duplicate.id,duplicate.revision,Number(samePublishedContent),...args,duplicate.id,canonical.id,now),
  db.prepare(`DELETE FROM academic_reports WHERE id=? AND revision=? AND ${valid}
    AND EXISTS(SELECT 1 FROM academic_report_merges WHERE duplicate_id=? AND canonical_id=? AND merged_at=?)`)
    .bind(duplicate.id,duplicate.revision,...args,duplicate.id,canonical.id,now),
  db.prepare(`UPDATE academic_reports SET dedupe_key=? WHERE id=? AND revision=? AND state='active'
    AND NOT EXISTS(SELECT 1 FROM academic_reports WHERE id=? AND revision=?)`)
    .bind(key,canonical.id,canonical.revision,duplicate.id,duplicate.revision),
 ]);
 return (results[2]?.meta.changes??0)>0;
}
export async function cleanAcademicDuplicates(db:D1Database,userId:number,chatId:number,now:number,text='احذف التبليغات المكررة'):Promise<{removed:number;remaining:number;text:string}> {
 const config=await db.prepare('SELECT owner_uid,target_chat_id,target_thread_id FROM settings WHERE singleton=1').first<{owner_uid:number|null;target_chat_id:number|null;target_thread_id:number|null}>();
 const empty={removed:0,remaining:0};
 if(!config||config.target_chat_id===null||!sharesDestination(chatId,config.target_chat_id))return {...empty,text:'نظّف التبليغات من الخاص أو من الكروب المرتبط بالقناة.'};
 const query=extractEventQuery(text,new Date(now));
 if(query.clarification)return {...empty,text:'حدد مادة واحدة أو گلي «احذف التبليغات المكررة» حتى أنظف المتطابق فقط.'};
 const where=["state='active'",'destination_chat_id=?','destination_thread_id IS ?'];const values:(string|number|null)[]=[config.target_chat_id,config.target_thread_id];
 if(!isAdmin(userId,config.owner_uid)){where.push('author_id=?');values.push(userId);}
 if(query.course){where.push('course=?');values.push(query.course);}
 const rows=await db.prepare(`SELECT * FROM academic_reports WHERE ${where.join(' AND ')} LIMIT 121`).bind(...values).all<Record<string,unknown>>();
 if(rows.results.length>120)return {...empty,text:'عدد السجلات كبير؛ حدّد المادة حتى أنظف المكرر بدون ما أفوت نسخ.'};
 const reports=rows.results.map(row=>({dedupeKey:row.dedupe_key as string|null,id:row.id,revision:row.revision,state:row.state,authorId:row.author_id,authorName:row.author_name,
  sourceChatId:row.source_chat_id,sourceThreadId:row.source_thread_id,sourceMessageId:row.source_message_id,item:JSON.parse(String(row.body_json)),conflicts:JSON.parse(String(row.conflict_with_json)),
  destinationChatId:row.destination_chat_id,destinationThreadId:row.destination_thread_id,lastUpdateId:row.last_update_id,createdAt:row.created_at,updatedAt:row.updated_at} as AcademicReport));
 const plans=await planAcademicDuplicates(reports);let removed=0;let processed=0;
 for(const plan of plans)for(const duplicate of plan.duplicates) {
  if(processed++>=6)break;
  if(await mergeAcademicDuplicate(db,plan.canonical,duplicate,userId,now))removed++;
 }
 return {removed,remaining:reports.length-removed,text:removed?`✅ شلت ${removed} نسخة مكررة من السجل نفسه، وبقيت النسخ الأصلية. الاختلاف بالموعد أو المجموعة أو التفاصيل يبقى محفوظ.\nگلي «شعدنا امتحانات وكوزات» حتى تشوف القائمة الجديدة.${processed>6?' أكو نسخ إضافية؛ گلي نظّف المكرر مرة ثانية.':''}`:'ما لقيت نسخ متطابقة أگدر أدمجها بأمان؛ ما حذفت تبليغ مختلف أو موعد غير محسوم.'};
}
