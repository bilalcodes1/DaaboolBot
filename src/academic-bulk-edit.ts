import {academicEditIntent} from './academic-edit';
import {extractEventQuery} from './event-extract';
import {normalizeArabic} from './input';
import {COURSE_ALIASES,type CourseId} from './nlu-schema';
import {getAcademicReportsByIds,formatAcademicReport,type AcademicReport,type AcademicSource,type AcademicKind} from './academic-ai';
import {academicDuplicateKey} from './academic-dedup';
import {getBaghdadNow} from './calendar';
import {isAdmin,sharesDestination,PRIMARY_ADMIN,SECONDARY_ADMIN} from './admin';
import type {AssistantReference} from './assistant-references';
const norm=(s:string)=>normalizeArabic(s).toLowerCase().replace(/ة/g,'ه').replace(/ى/g,'ي');
export interface BulkAudiencePatch {audience:'A'|'B'|'all';course:CourseId|null;kinds:AcademicKind[]|null}
export function bulkAcademicEditIntent(text:string):boolean {
 return academicEditIntent(text)&&/(?:ل?كل|جميع)\s+(?:ال)?(?:مواد|تبليغات|امتحانات|كوزات|واجبات)|(?:التبليغات|المواد)\s+كلها/u.test(norm(text));
}
export function bulkAudiencePatch(text:string,now:Date):BulkAudiencePatch|null {
 if(!bulkAcademicEditIntent(text)||text.length>600||!/(?:مجموع|مجوع|شعب)/u.test(norm(text)))return null;
 const q=extractEventQuery(text,now);
 const audience=extractEventQuery(text.replace(/(?:ل?كل|جميع)\s+(?:ال)?(?:مواد|تبليغات|امتحانات|كوزات|واجبات)/gu,' '),now).audience;
 if(!audience||q.date||q.dateRange)return null;
 let words=norm(text);
 if(q.course)for(const alias of [...COURSE_ALIASES[q.course]].map(norm).sort((a,b)=>b.length-a.length))words=words.replaceAll(alias,' ');
 const allowed=new Set(['اريد','نريد','ممكن','تكدر','تگدر','عفيه','هسه','عدل','تعدل','تعديل','اعدل','عدله','عدلها','التبليغ','التبليغات','تبليغ','تبليغات','لكل','كل','جميع','المواد','مواد','كلها','وتكتب','اكتب','تكتب','خلي','خليها','وخلي','وخليها','للمجموعتين','المجموعتين','للمجوعتين','المجوعتين','للمجموعه','المجموعه','مجموعه','للمجموعات','المجموعات','لشعبه','الشعبتين','للشعبتين','a','b','و','واكتب','امتحانات','الامتحانات','كوزات','الكوزات','واجبات','الواجبات']);
 if(words.split(/\s+/u).some(w=>w&&!allowed.has(w)))return null;
 return {audience,course:q.course,kinds:q.kinds??(q.kind?[q.kind]:null)};
}
interface BulkResult{text:string;reportIds:string[];references:AssistantReference[]}
const empty=(text:string):BulkResult=>({text,reportIds:[],references:[]});
/** All target revisions are checked when the intake is admitted. Every write
 * is gated by that transaction's nonce. D1 batch commits audit+edits+response
 * together, so a stale target cannot produce a partial successful edit. */
export async function applyBulkAudienceEdit(db:D1Database,source:AcademicSource,patch:BulkAudiencePatch):Promise<BulkResult> {
 if(!Number.isSafeInteger(source.updateId)||source.updateId<0||!Number.isSafeInteger(source.userId)||source.userId<=0||source.text.length>8192)throw new RangeError('Invalid bulk edit source');
 const config=await db.prepare('SELECT owner_uid,target_chat_id,target_thread_id FROM settings WHERE singleton=1').first<{owner_uid:number|null;target_chat_id:number|null;target_thread_id:number|null}>();
 if(!config||!isAdmin(source.userId,config.owner_uid))return empty('تعديل كل التبليغات من صلاحيات حسابَي الأدمن.');
 if(config.target_chat_id===null||!sharesDestination(source.chatId,config.target_chat_id))return empty('أرسل التعديل بالخاص أو بالكروب المرتبط بالقناة.');
 const id=`bulk-audience:${source.updateId}`;
 const cached=await db.prepare('SELECT author_id,source_chat_id,source_thread_id,source_text,response_json FROM academic_intakes WHERE id=?').bind(id)
  .first<{author_id:number;source_chat_id:number;source_thread_id:number|null;source_text:string;response_json:string|null}>();
 if(cached){
  if(cached.author_id!==source.userId||cached.source_chat_id!==source.chatId||cached.source_thread_id!==source.threadId||cached.source_text!==source.text)throw Error('Bulk edit source mismatch');
  if(cached.response_json)return JSON.parse(cached.response_json) as BulkResult;
 }
 const where=["state='active'",'destination_chat_id=?','destination_thread_id IS ?','(event_date>=? OR event_date IS NULL)'];
 const values:(string|number|null)[]=[config.target_chat_id,config.target_thread_id,getBaghdadNow(new Date(source.now)).date];
 if(patch.course){where.push('course=?');values.push(patch.course);}
 if(patch.kinds?.length){where.push(`kind IN (${patch.kinds.map(()=>'?').join(',')})`);values.push(...patch.kinds);}
 const ids=await db.prepare(`SELECT id FROM academic_reports WHERE ${where.join(' AND ')} ORDER BY created_at,id LIMIT 13`).bind(...values).all<{id:string}>();
 if(ids.results.length>12)return empty('أكو أكثر من 12 تبليغاً مطابقاً؛ حدّد مادة أو نوعاً حتى أعدلها بدفعة واضحة.');
 if(!ids.results.length)return empty('ماكو تبليغات فعالة مطابقة حتى أعدل مجموعتها.');
 const before=await getAcademicReportsByIds(db,ids.results.map(r=>r.id));
 if(before.length!==ids.results.length)return empty('القائمة تغيّرت أثناء الطلب؛ اعرضها من جديد حتى أعدلها كاملة.');
 const planned:AcademicReport[]=[];
 for(const old of before){
  const changed=old.item.audience!==patch.audience;
  const next:AcademicReport={...old,revision:old.revision+Number(changed),item:{...old.item,audience:patch.audience,audienceEvidence:changed?source.text:old.item.audienceEvidence},
    updatedAt:changed?source.now:old.updatedAt,lastUpdateId:changed?source.updateId:old.lastUpdateId};
  if(old.dedupeKey){const key=JSON.parse(old.dedupeKey) as unknown[];key[3]=patch.audience;next.dedupeKey=JSON.stringify(key);}
  else next.dedupeKey=await academicDuplicateKey(next.item,old.createdAt);
  planned.push(next);
 }
 // The same author's A/B variants may become the same event after this edit.
 // Keep one resulting record and archive the original duplicate, without
 // treating an older, differently addressed publication as the new version.
 const groups=new Map<string,AcademicReport[]>();
 for(const next of planned){const key=next.dedupeKey?`${next.authorId}:${next.dedupeKey}`:next.id;const group=groups.get(key)??[];group.push(next);groups.set(key,group);}
 const canonical:AcademicReport[]=[],merges:{before:AcademicReport;canonical:AcademicReport}[]=[];
 for(const group of groups.values()){
  group.sort((a,b)=>Number(a.item.audience!==before.find(r=>r.id===a.id)!.item.audience)-Number(b.item.audience!==before.find(r=>r.id===b.id)!.item.audience)||a.createdAt-b.createdAt);
  const keep=group[0]!;canonical.push(keep);for(const duplicate of group.slice(1))merges.push({before:before.find(r=>r.id===duplicate.id)!,canonical:keep});
 }
 const changed=before.filter(r=>r.item.audience!==patch.audience).length;
 const audience=patch.audience==='all'?'للمجموعتين A وB':`لمجموعة ${patch.audience}`;
 const result:BulkResult={text:changed?`✅ عدّلت ${changed} تبليغاً ${audience}.${merges.length?` دمجت ${merges.length} نسخة صارت مطابقة بعد التعديل.`:''}\n\n${canonical.map(r=>`${formatAcademicReport(r).split('\n')[0]} — ${r.item.date??'الموعد غير محدد'}`).join('\n')}`:`كل التبليغات المطابقة مسجّلة ${audience} من قبل؛ ما غيرت إصداراتها.${merges.length?` دمجت ${merges.length} نسخة مطابقة.`:''}`,reportIds:canonical.map(r=>r.id),references:canonical.map(r=>({kind:'academic',id:r.id,revision:r.revision}))};
 const nonce=crypto.randomUUID();const op=JSON.stringify({type:'bulk-audience',audience:patch.audience,nonce});
 const expected=JSON.stringify(before.map(r=>({id:r.id,revision:r.revision})));
 const gate=`EXISTS(SELECT 1 FROM academic_intakes WHERE id=? AND json_extract(analysis_json,'$.nonce')=? AND response_json IS NULL)`;
 const bind=[id,nonce];
 const statements:D1PreparedStatement[]=[db.prepare(`INSERT OR IGNORE INTO academic_intakes(id,author_id,source_chat_id,source_thread_id,source_message_id,source_text,analysis_json,created_at)
  SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN academic_reports r ON r.id=json_extract(expected.value,'$.id')
    WHERE r.id IS NULL OR r.revision<>json_extract(expected.value,'$.revision') OR r.state<>'active')
   AND EXISTS(SELECT 1 FROM settings WHERE singleton=1 AND target_chat_id IS ? AND target_thread_id IS ?
    AND (owner_uid=? OR (owner_uid=${PRIMARY_ADMIN} AND ?=${SECONDARY_ADMIN})))`)
  .bind(id,source.userId,source.chatId,source.threadId,source.messageId,source.text,op,source.now,expected,config.target_chat_id,config.target_thread_id,source.userId,source.userId)];
 for(const next of canonical){
  const old=before.find(r=>r.id===next.id)!;if(next.revision===old.revision)continue;
  statements.push(db.prepare(`UPDATE academic_reports SET audience=?,body_json=?,dedupe_key=?,revision=?,last_update_id=?,updated_at=?
    WHERE id=? AND revision=? AND ${gate}`).bind(patch.audience,JSON.stringify(next.item),next.dedupeKey??null,next.revision,source.updateId,source.now,old.id,old.revision,...bind),
   db.prepare(`INSERT INTO academic_report_changes(report_id,revision,actor_id,intake_id,before_json,after_json,created_at)
    SELECT ?,?,?,?,?,?,? WHERE ${gate}`).bind(next.id,next.revision,source.userId,id,JSON.stringify(old),JSON.stringify(next),source.now,...bind));
 }
 for(const merge of merges){
  const oldKey=merge.before.dedupeKey??await academicDuplicateKey(merge.before.item,merge.before.createdAt);
  if(oldKey&&oldKey===merge.canonical.dedupeKey)statements.push(
   db.prepare(`INSERT OR IGNORE INTO publication_receipts(kind,record_id,revision,chat_id,thread_id,message_id,sent_at,job_id)
    SELECT kind,?,?,chat_id,thread_id,message_id,sent_at,job_id FROM publication_receipts
    WHERE kind='academic' AND record_id=? AND revision=? AND ${gate}`)
    .bind(merge.canonical.id,merge.canonical.revision,merge.before.id,merge.before.revision,...bind));
  statements.push(
  db.prepare(`INSERT INTO academic_report_merges(duplicate_id,canonical_id,duplicate_json,canonical_revision,actor_id,merged_at,reason)
   SELECT ?,?,?,?,?,?,? WHERE ${gate}`).bind(merge.before.id,merge.canonical.id,JSON.stringify(merge.before),merge.canonical.revision,source.userId,source.now,id,...bind),
  db.prepare(`DELETE FROM academic_reports WHERE id=? AND revision=? AND ${gate}`).bind(merge.before.id,merge.before.revision,...bind));
 }
 // Leave room for the handler, verified reply metadata and Telegram outbox.
 if(statements.length>25)return empty('دفعة الدمج كبيرة؛ حدّد مادة أو نوعاً حتى أعدلها كاملة ضمن حد الخدمة.');
 statements.push(db.prepare(`UPDATE academic_intakes SET response_json=? WHERE id=? AND ${gate}`).bind(JSON.stringify(result),id,...bind));
 const saved=await db.batch(statements);
 if(saved.at(-1)?.meta.changes)return result;
 const winner=await db.prepare('SELECT response_json FROM academic_intakes WHERE id=? AND author_id=? AND source_text=?').bind(id,source.userId,source.text).first<{response_json:string|null}>();
 return winner?.response_json?JSON.parse(winner.response_json) as BulkResult:empty('أحد التبليغات تغيّر أثناء الطلب؛ اعرض القائمة الحالية قبل التعديل الجماعي. ما طبقت جزءاً من التعديل.');
}
