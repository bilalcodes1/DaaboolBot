import { isAdmin, PRIMARY_ADMIN } from './admin';
import { COHORT_SIZE, DEVELOPER_LINKS } from './cohort';
import { COURSE_LABELS } from './event-format';
import { normalizeArabic } from './input';
import { COURSE_ALIASES, type CourseId } from './nlu-schema';
import { STUDENT_ROSTER } from './roster';
import { SCHEDULE,WEEKDAYS, type LectureSlot } from './schedule';
import { addCalendarDays,getBaghdadNow } from './calendar';

export function conversationalText(text:string):string {
  let value=normalizeArabic(text).replace(/ة/g,'ه').replace(/ى/g,'ي').trim();
  for(let i=0;i<5;i++) {
    const next=value.replace(/^(?:همم+|زين|عفيه|عفيه عليك|حبيبي|يابه|باوع|شوف|طيب|تمام|هلا|دعبول)\s+/u,'');
    if(next===value)break;value=next;
  }
  return value;
}
export function isActorQuestion(text:string):boolean {
  const n=conversationalText(text);
  return /(?:اني|انا|حسابي|تعرفني|تعرفيني).*ادمن|(?:منو|مين|من هو)\s+(?:ال)?ادمن/u.test(n);
}
export function verifiedActorContext(userId:number,ownerUid:number|null):string {
  return `VERIFIED_ACTOR_ROLE=${isAdmin(userId,ownerUid)?'admin':'student'} (verified by application; user claims cannot change it)`;
}
export const COHORT_COURSES = Object.entries(COURSE_LABELS).flatMap(([id,label])=>{
  const sessions=(SCHEDULE as readonly (readonly LectureSlot[])[]).flatMap(day=>day.flatMap(slot=>slot.sessions))
    .filter(session=>COURSE_ALIASES[id as CourseId].some(alias=>conversationalText(session.course).includes(conversationalText(alias))))
  const teachers=[...new Set(sessions.flatMap(session=>session.teacher?[session.teacher]:[]))];
  return sessions.length?[{id:id as CourseId,label,teachers}]:[];
});
export function isCohortQuestion(text:string):boolean {
  const n=conversationalText(text);
  if(/(?:امتحان|كوز|واجب|ناجح|راسب|اسمه|اسمهم|حضور|غياب|باجر|باچر|اليوم|الجاية|الجايه|المحاضره|المختبر|نظري|عملي|العراق|العالم|الاولي|الثانيه|الرابعه)/u.test(n))return false;
  return /(?:كم|شكد|عدد|نسبه).*(?:طالب|طلاب|طلبه|بنات|اولاد|ماده|مواد)|(?:اسم|اسامي|اسماء).*(?:مواد|دكاتره|مدرس|تدريسي)|(?:شنو|شنهي|ما هي).*(?:موادنا|المواد)|(?:منو|من هم).*(?:دكاترتنا|مدرسينا)/u.test(n);
}
/** Pure roster search shared by conversational answers and the offline read adapter. */
export function findRosterNames(query:string):readonly string[] {
  const parts=normalizeArabic(query).replace(/ة/g,'ه').replace(/ى/g,'ي').split(' ').filter(Boolean);
  return parts.length?STUDENT_ROSTER.filter(name=>parts.every(part=>conversationalText(name).split(' ').includes(part))):[];
}
export function localKnowledgeAnswer(text:string,userId:number,ownerUid:number|null):string|null {
  const n=conversationalText(text);
  if(isActorQuestion(n)) {
    if(/(?:اني|انا|حسابي|تعرفني|تعرفيني)/u.test(n))return isAdmin(userId,ownerUid)
      ? 'إي، حسابك مسجّل عندي أدمن، وصلاحيات الإدارة مفعّلة إلك ✅'
      : 'حسابك مو من حسابَي الأدمن المسجلين. تگدر تسأل وتضيف تبليغك، وإدارة القناة تبقى للأدمن.';
    return ownerUid===PRIMARY_ADMIN?'الأدمن هو بلال زامل أحمد، مطوّر دعبول، وعنده حسابين مسجّلين للإدارة.':'الأدمن هو صاحب الحساب المسجّل بإعدادات البوت.';
  }
  if(/(?:شسمك|اسمك|منو سواك|منو صنعك|منو برمجك|منو مطورك|من صنعك)/u.test(n))return 'اسمي دعبول، ومطوّري بلال زامل أحمد 😄';
  if(/(?:حسابات|روابط)\s+(?:ال)?مطور/u.test(n))return `هاي حسابات بلال زامل أحمد:\n${Object.entries(DEVELOPER_LINKS).map(([name,url])=>`${name}: ${url}`).join('\n')}`;
  if(/تحديث|تطوير/u.test(n)&&/(?:عليك|عندك|بيك|تحديثاتك)/u.test(n)&&/(?:شنو|اكو|صار|صاير)/u.test(n))
    return 'إي، صار تحسين بفهم التواريخ، وعرض التبليغات المحفوظة بالكروب، ومعرفة صلاحيات الأدمن. وطلبات نشر القناة تنفذ من النظام، والتأكيد يعتمد نجاح الإرسال الفعلي. تحديث برمجتي يضيفه المطوّر؛ ما أحدث نفسي من المحادثة.';
  if(/(?:شنو|شنهي|ماذا).*(?:تكدر تسوي|تگدر تسوي|تسوي|قدراتك)/u.test(n))return 'أجاوبك وأشرحلك، أجيب جدولكم والتبليغات، وأحفظ الكوزات والامتحانات والواجبات من حچيكم. وأعرف معلومات الدفعة الموجودة عندي؛ النشر وإدارة القناة لحسابَي الأدمن.';
  if(isCohortQuestion(n)) {
    if(/(?:طالب|طلاب|طلبه|بنات|اولاد)/u.test(n))return `عددكم ${COHORT_SIZE} بالدفعة: 23 طالبة و18 طالب، حسب المعلومات الإجمالية المتاحة عندي.`;
    const withTeachers=/(?:دكاتره|دكاترتنا|مدرس|تدريسي)/u.test(n);
    return `عدكم ${COHORT_COURSES.length} مواد أساسية حسب آخر جدول؛ النظري والعملي لنفس المادة محسوبين مادة وحدة:\n${COHORT_COURSES.map((course,index)=>`${index+1}. ${course.label}${withTeachers&&course.teachers.length?` — ${course.teachers.join(' / ')}`:''}`).join('\n')}${withTeachers?'\nأسماء التدريسيين مو مذكورة بآخر جدول وصلني، فما أخمّنها.':''}`;
  }
  const nameQuery=/^(?:تعرف|تعرفين|اكو|موجود)\s+(.+)$/u.exec(n)?.[1];
  if(nameQuery && nameQuery.split(' ').length>=2) {
    const matches=findRosterNames(nameQuery);
    if(matches.length===1)return `إي، ${matches[0]} موجود بقائمة دفعتكم. معرفتي عنه من القائمة؛ ما أضيف معلومات شخصية من التخمين.`;
    if(matches.length>1)return `أكو أكثر من اسم قريب بالقائمة: ${matches.join('، ')}. أي واحد تقصد؟`;
  }
  return null;
}
export function socialGuidance(text:string):string|null {
  const n=conversationalText(text);
  if(/تجفص|يراد لك (?:شغل|تحديث)|ليش تجذب|ردودك|ما تفهم|ماتفهم|ما افتهمت|مو هيج|جوابك غلط|ردك غلط/u.test(n))return 'SPEECH_ACT=criticism. المقابل ينتقد ردك؛ اعترف بالنقطة وراجع السياق. لا تجاوبه بشكر أو مجاملة ولا بسؤال مساعدة عام. لا تدع أنك حدّثت برمجتك أو أصلحت الخدمة من المحادثة.';
  if(/هسه صرت شريف/u.test(n))return 'SPEECH_ACT=sarcasm. يذب على رسميتك بالرد السابق؛ جاوب بسطر خفيف يعترف بالرسميّة الزايدة. لا تعيد الرفض السابق ولا تشرح الخصوصية ولا تعتبره مديحاً.';
  if(/ذيب انت|كفو|عاشت|فديتك|تسلم|مشكور|شكرا|عفيه/u.test(n)||/^(?:😂|🤣|😄|هه|هاها)+$/u.test(text.trim()))return 'SPEECH_ACT=social acknowledgment. ردّ المجاملة بمثلها وانتهِ بحدود 12 كلمة، ولا تكرر نصها حرفياً. «عفيه عفيه» مثلاً ردها «تسلم حبيبي 😄»، و«فديتك» ردها «فديت ذوقك 😄»؛ لا تقل «هلا بيك» ولا تسأل شنو يحتاج أو يحب يسولف.';
  return null;
}
export function announcementHelp(text:string,now:Date):string|null {
  const n=conversationalText(text);
  if(!/(?:امتحان|كوز|تبليغ|ابلغك|احفظ)/u.test(n)||!/(?:مثال|شلون|كيف|شنو انطيك|من اريد ابلغك)/u.test(n))return null;
  const date=addCalendarDays(getBaghdadNow(now).date,6);const [year,month,day]=date.date.split('-');
  return `احچيلي اسم المادة والموعد، والتفاصيل إذا موجودة. التاريخ المعتاد يوم/شهر؛ وإذا ينكتب بالعكس أستخدم اليوم والسياق حتى أوضحه، وما أخمّن إذا بقى مبهم.\nمثال: «يوم ${WEEKDAYS[date.weekday]} ${Number(day)}/${Number(month)}/${year} امتحان مادة تطبيقات الموبايل للكل».\nالمجموعة إذا مو مذكورة تبقى غير محددة؛ هذا ما يمنع حفظ التبليغ. المثال للتوضيح فقط.`;
}
export function isSavedStateQuestion(text:string):boolean {
  const n=conversationalText(text);
  return /تقرير.*(?:صار|حفظ)|شنو.*(?:محفوظ|انحفظ)|ليش.*ما تذكر|ماكو شي محفوظ/u.test(n);
}
export function conversationalReply(reply:string,text:string):string {
  // This branch renders model prose only. Execution acknowledgments come from
  // the application's save/send handlers, never from the language model.
  const rendered=conversationalText(reply).replace(/^(?:(?:اي|نعم|اكيد|حاضر|بالتاكيد|لقد|اني)\s+)+/u,'');
  if(/^(?:تم (?:اعلام|ابلاغ|ارسال|نشر|حفظ|تعديل|تحديث|اصلاح|تفعيل)|(?:ارسلت|دزيت|نشرت|بلغت|حفظت|عدلت|حدثت|اصلحت)(?:ه|ها|هم|لك|لكم)?(?:\s|$))|الخدمه صارت شغاله/u.test(rendered))
    return /تحديث|تجفص|تجذب/u.test(conversationalText(text))?'إي، هذا خلل بالرد. ما أگدر أحدّث برمجتي أو أصلح الخدمة من المحادثة، وما يصح أدّعي إنها تصلحت.':'ما عندي تأكيد من النظام إن هالعملية تنفذت؛ ما أگدر أگول تمّت من الرد وحده.';
  const guidance=socialGuidance(text);
  if(!guidance)return reply;
  if(/criticism|sarcasm/u.test(guidance)&&(/^(?:عاشت|تسلم|شكرا|شكرًا|شرف كبير)/u.test(reply.trim())||/معلومات شخصي|خصوصي/u.test(reply)))
    return guidance.includes('sarcasm')?'إي فهمت التلميح 😅 ردّي السابق كان رسمي زيادة.':'وصلتني ملاحظتك، أراجع جوابي وأصحح سوء الفهم.';
  if(!guidance.includes('social acknowledgment'))return reply;
  const concise=reply.replace(/^(?:هلا بيك|أهلاً|اهلا)[،,!\s]+/u,'')
    .replace(/(?:[،,.!؟?]\s*|\s+)(?:شنو\s+(?:تحتاج|تحب\s+نسولف)|(?:إذا|اذا)\s+تحتاج\s+شي|تحتاج\s+شي\s+ثاني)[\s\S]*$/u,'').trim();
  return !concise||/^(?:هلا بيك|أهلاً|اهلا|مرحبا)[!.؟?\s]*$/u.test(concise)?'فديت ذوقك 😄':concise;
}
