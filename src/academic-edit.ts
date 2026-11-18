import {getAcademicReportsByIds,getAcademicContext,parseAcademicAnalysis,type AcademicItem,type AcademicReport} from './academic-ai';
import type {AssistantReference} from './assistant-references';
import {normalizeArabic} from './input';
import {extractEventQuery} from './event-extract';
const norm=(s:string)=>normalizeArabic(s).replace(/ة/g,'ه').replace(/ى/g,'ي');
export function academicEditIntent(text:string):boolean {
 const n=norm(text.replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/gu,' '));
 return /(?:^|\s)(?:ت?عدل(?:ه|ها|لي)?|تعديل|اعدل|صحح|بدل|غير موعد)(?=$|\s)/u.test(n)
  &&!/(?:^|\s)(?:لا|مو|بدون|لو|اذا|مثال|مثلا|شلون|كيف|قال|كالت|كتب)(?:\s|$)|ما اريد/u.test(n)&&!/[؟?]/u.test(text);
}
export async function academicEditTarget(db:D1Database,userId:number,chatId:number,text:string,refs:AssistantReference[],hasReply:boolean,now:Date):Promise<{target:AcademicReport|null;clarification:string|null}> {
 const selection=extractEventQuery(text,now);
 if(refs.some(ref=>ref.kind==='legacy'))return {target:null,clarification:null}; // Existing legacy management keeps its own controls.
 const numeric=text.replace(/[٠-٩]/gu,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
 const dates=[...numeric.matchAll(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{4})?/gu)].map(match=>match[0]);
 const oldDate=dates.length>=2&&/(?:خليه|خليها|الى|الي|بدل|غير)/u.test(norm(text))?extractEventQuery(dates[0]!,now).date:null;
 let records:AcademicReport[];
 if(hasReply) {
  records=await getAcademicReportsByIds(db,refs.filter(ref=>ref.kind==='academic').map(ref=>ref.id));
  records=records.filter(row=>refs.some(ref=>ref.id===row.id&&ref.revision===row.revision)&&row.state==='active');
  if(!records.length)return {target:null,clarification:'هاي نسخة قديمة أو ما مرتبطة بتبليغ حالي. گلي شعدنا تبليغات ورد على القائمة الجديدة.'};
 } else {
  const context=JSON.parse(await getAcademicContext(db,{now,...(oldDate?{queryText:oldDate}:{}),userId,scopeChatId:chatId,limit:3,...(selection.course?{course:selection.course}:{}),...(selection.kind?{kind:selection.kind}:{})})) as {id:string}[];
  records=await getAcademicReportsByIds(db,context.map(row=>row.id));
  if(!selection.course)return {target:null,clarification:'حدد اسم المادة، أو رد على التبليغ اللي تريد تعدله.'};
 }
 const matching=records.filter(row=>(!selection.course||row.item.course===selection.course)&&(!selection.kind||row.item.kind===selection.kind)&&(!oldDate||row.item.date===oldDate));
 // A single explicitly referenced report may change its course as well.
 const candidates=matching.length?matching:!oldDate&&hasReply&&records.length===1?records:[];
 return candidates.length===1?{target:candidates[0]!,clarification:null}:{target:null,clarification:'أكو أكثر من تبليغ محتمل؛ حدّد أي واحد بالرد على بطاقته، أو اذكر موعده الحالي والجديد.'};
}
export function simpleAcademicDateEdit(text:string,now:Date,target:AcademicReport):AcademicItem|null {
 const q=extractEventQuery(text.replace(/(?:^|\s)و?(?:خليه|خليها|عدله|عدلها)(?=$|\s)/gu,' '),now);if(!q.date||q.clarification)return null;
 // Only a date edit, not a content/coverage/time replacement. More complex
 // instructions continue through AI with the verified record supplied.
 const n=norm(text);
 if(!/(?:موعد|تاريخ|خليه|خليها|صار)/u.test(n)||/(?:المشمول|مشمول|داخل|داخله|ساعه|محاضره|فصل|صفحه|تفاصيل|احذف|الغي)/u.test(n))return null;
 return {action:'update',targetId:target.id,kind:target.item.kind,course:null,courseEvidence:null,component:null,date:q.date,dateEvidence:text,
  time:null,timeEvidence:null,audience:null,audienceEvidence:null,certainty:target.item.certainty,coverage:'',occurrenceSlots:[],occurrenceEvidence:null,details:text,evidence:text};
}
