import {extractEventQuery} from './event-extract';
import {getBaghdadNow} from './calendar';
import {normalizeArabic} from './input';
/** Only an explicit request for archived announcements broadens the default
 * upcoming view. Quoted words and negated requests cannot enable the archive. */
export function academicHistorySelection(raw:string):{text:string;archiveOnly:boolean} {
 const text=raw.replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/gu,' ');
 const n=normalizeArabic(text).replace(/ة/g,'ه').replace(/ى/g,'ي');
 const archive=/(?:^|\s)(?:ال)?(?:ارشيف|قديمه|قديم|المنتهي|منتهيه|منتهي)(?=$|\s)/u.test(n);
 const request=/(?:^|\s)(?:اعرض|عرض|شوفني|شوفي|شوف|وريني|طلعلي|جيبلي|دزلي|اريد|شنو|شعدنا|شعدنه)(?=$|\s)/u.test(n);
 const negated=/(?:^|\s)(?:لا|مو|بدون|لو|اذا|ما اريد|ما تعرض)(?=$|\s)/u.test(n);
 const archiveOnly=archive&&request&&!negated;
 return {archiveOnly,text:archiveOnly?text.replace(/(?:^|\s)(?:ال)?(?:أرشيف|ارشيف|قديمة|قديمه|قديم|المنتهي|منتهية|منتهيه|منتهي)(?=$|\s)/gu,' ').replace(/\s+/gu,' ').trim():raw};
}

/** Past text may be discussed explicitly, but is never current grounding. */
export function academicHistoricalRequest(text:string,now:Date):boolean {
 const selected=academicHistorySelection(text);if(selected.archiveOnly)return true;
 const q=extractEventQuery(text,now),today=getBaghdadNow(now).date;
 return !q.clarification&&!!(q.date&&q.date<today||q.dateRange&&q.dateRange.fromDate<today);
}
export function staleAcademicConversation(text:string,createdAt:number,now:Date):boolean {
 if(!/(?:تبليغ|امتحان|اختبار|كوز|كويز|واجب|تكليف|مناقشه|مناقشة)/u.test(normalizeArabic(text)))return false;
 const today=getBaghdadNow(now).date;
 if(getBaghdadNow(new Date(createdAt)).date<today)return true;
 if(academicHistorySelection(text).archiveOnly||/عرض تاريخي|أرشيف التبليغات/u.test(text))return true;
 return [...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].some(m=>m[0]<today);
}
