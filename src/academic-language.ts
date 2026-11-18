import {normalizeArabic} from './input';
const norm=(s:string)=>normalizeArabic(s).replace(/ة/g,'ه').replace(/ى/g,'ي');
/** Retrieval syntax only; the user's original announcement stays untouched. */
export function academicLookupText(raw:string):string {
 let text=raw.trim();
 for(let i=0;i<8;i++){
  const word=/^(\S+)\s+/u.exec(text);
  if(!word||!/^(?:همم+|زين|عفيه|حبيبي|يابه|باوع|شوف|طيب|تمام|هلا|دعبول|هسه|المهم)$/u.test(norm(word[1]!)))break;
  text=text.slice(word[0].length);
 }
 text=text.replace(/(?:^|\s)لامتحانات(?=$|\s)/gu,' الامتحانات').trim();
 const display=/^(?:شوفني|شوفي|شوفلي|وريني|ورينا|عرضلي|اعرضلي|طلعلي)(?=$|\s)/u;
 if(display.test(norm(text)))text=text.replace(/^\S+/u,'اعرض');
 if(/^(?:ال)?(?:امتحانات|اختبارات|كوزات|كويزات|واجبات|تبليغات)(?=$|\s)/u.test(norm(text)))text='اعرض '+text;
 if(/^اعرض\s/u.test(norm(text))&&/(?:تبليغ|امتحان|كوز|كويز|واجب|اختبار)/u.test(norm(text))&&/(?:^|\s)(?:كامله|كامل|كلها|بالكامل)(?=$|\s)/u.test(norm(text))) {
  text=text.replace(/(?:^|\s)(?:كاملة|كامله|كامل|كلها|بالكامل)(?=$|\s)/gu,' ').replace(/^اعرض\s+/u,'اعرض كل ');
 }
 return text.trim();
}
/** Separate recipients and publication timing from academic selection filters. */
export function publicationSelectionText(text:string):string {
 return text.replace(/(^|\s)(?:بلغ|بلّغ|انشر)(?:هم)?\s+(?:الكل|الجميع)(?=$|\s)/gu,'$1بلغ الطلاب').replace(/(?:ل?كل|جميع)\s+(?:الطلاب|الطلبة|الطلبه|طلابنا|طلبتنا)/gu,' ')
  .replace(/(?:^|\s)(?:في|على)\s+(?:القناة|القناه)(?=$|\s)/gu,' ')
  .replace(/(?:^|\s)(?:بلغ(?:هم|ه|ها|هن)?|بلّغ(?:هم|ه|ها|هن)?|انشر(?:ه|ها|هن)?|تنشر|عفيه|هسه|الان|الآن|بالقناة|بالقناه|للقناة|للقناه|القناة|القناه|الطلاب|الطلبة|الطلبه|طلابنا|طلبتنا)(?=$|\s)/gu,' ')
  .replace(/(^|\s)بكل(?=\s+(?:ال)?(?:امتحانات|اختبارات|كوزات|كويزات|واجبات|تبليغات))/gu,'$1كل')
  .replace(/\s+/gu,' ').trim();
}
