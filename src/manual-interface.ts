import { requestedStudentTimetable } from './student-schedule';
import { isAdmin } from './admin';
import { EventStore } from './event-store';
import { TelegramClient, TelegramError } from './telegram';
import type { TelegramMessage, TelegramUpdate } from './types';
import type { ContributionEnv } from './event-workflow';
import { escapeHtml } from './format';
import { WEEKDAYS } from './schedule';
import { COURSE_LABELS } from './event-format';
import { getBaghdadNow } from './calendar';
import { splitAssistantHtml } from './assistant-store';
import { beginDestination } from './product-destination';
import { showAutomationPanel } from './automation-interface';
import { BRIEF_MENU } from './brief-schedule';
import { reconcileControlledAttempt } from './controlled-scheduler';
import { consumeManualPanel, saveManualPanel, invalidateManualPanels, clearManualForm, getManualForm, saveManualForm, manualScope, requireManualAdmin,
  cleanManualText, parseManualDate, parseManualTime, parseManualDue, type ManualAction, type ManualForm, type ManualScope } from './manual-store';
import { listManualAnnouncements, isManualAnnouncementVisible, getManualAnnouncement, formatManualAnnouncement, saveManualAnnouncement, deleteManualAnnouncement, MANUAL_KINDS, type ManualAnnouncementDraft, type ManualAnnouncementReference } from './manual-academic';
import { studentTimetable, loadEffectiveTimetable, officialTimetable, formatManualTimetable, manualDay, saveManualTimetable, validateManualTimetable, type ManualLecture } from './manual-timetable';
import { getManualPublicationConfig,getManualReminderConfig,setManualConfig,listManualReminders,getManualReminder,saveManualReminder,changeManualReminderState,queueManualPublication,cancelManualPublication,listManualPublications,queueManualReminders,type ManualReminder } from './manual-delivery';

export const MANUAL_ADMIN_BUTTONS=['📢 التبليغات','📅 الجدول الدراسي','🔔 التذكيرات','⏰ المنشورات المجدولة','📰 إعدادات الأخبار',BRIEF_MENU,'👥 إدارة الطلاب','🕌 التذكيرات الدينية','📊 حالة النظام','⚙️ الإعدادات'];
export const MANUAL_STUDENT_BUTTONS=['📅 الجدول الدراسي','📢 التبليغات','📰 آخر الأخبار','🔔 التذكيرات والمواعيد','ℹ️ معلومات القسم'];
const EXTERNAL=['📰 إعدادات الأخبار',BRIEF_MENU,'👥 إدارة الطلاب','🕌 التذكيرات الدينية','📰 آخر الأخبار','ℹ️ معلومات القسم'];
interface Context {db:D1Database;telegram:TelegramClient;message:TelegramMessage;scope:ManualScope;now:number;updateId:number;admin:boolean}
type Button=[string,ManualAction];
const nav:Button[]=[['‹ رجوع',{action:'home'}],['إلغاء',{action:'cancel'}]];
function ref(value:unknown):ManualAnnouncementReference {
  if(!value||typeof value!=='object')throw new RangeError('مرجع غير صالح.');const r=value as ManualAnnouncementReference;
  if(!['legacy','academic'].includes(r.kind)||!Number.isSafeInteger(r.revision)||r.revision<1||!/^[a-zA-Z0-9_-]{1,80}$/.test(r.id))throw new RangeError('مرجع غير صالح.');return r;
}
async function send(c:Context,text:string,buttons:Button[]=nav):Promise<number> {
  await invalidateManualPanels(c.db,c.scope);
  let result:{message_id:number}|null=null;
  for(const page of splitAssistantHtml(text))result=await c.telegram.call<{message_id:number}>('sendMessage',{chat_id:c.scope.chatId,text:page,parse_mode:'HTML'});
  if(!result||!Number.isSafeInteger(result.message_id))throw new TelegramError(502,true);
  if(buttons.length){
    const token=await saveManualPanel(c.db,c.scope,result.message_id,buttons.map(b=>b[1]),c.now);
    await c.telegram.call('editMessageReplyMarkup',{chat_id:c.scope.chatId,message_id:result.message_id,reply_markup:{inline_keyboard:buttons.map((b,index)=>[{text:b[0],callback_data:`man:${token}:${index}`}])}});
  }return result.message_id;
}
export async function showManualMenu(telegram:TelegramClient,message:TelegramMessage,admin:boolean):Promise<void> {
  const buttons=admin?MANUAL_ADMIN_BUTTONS:MANUAL_STUDENT_BUTTONS;
  await telegram.call('sendMessage',{chat_id:message.chat.id,text:admin?'لوحة إدارة دعبول. اختار قسماً من الأزرار.':'هلا بيك، اختار من الأزرار حتى أعرض المعلومات المسجلة.',
    reply_markup:{keyboard:buttons.map(text=>[{text}]),resize_keyboard:true,is_persistent:true}});
}
async function home(c:Context){await clearManualForm(c.db,c.scope);await invalidateManualPanels(c.db,c.scope);await showManualMenu(c.telegram,c.message,c.admin);}
async function ask(c:Context,form:ManualForm,text:string,choices:Button[]=[]):Promise<void> {
  const prompt=await send(c,text,[...choices,['إلغاء',{action:'cancel'}]]);
  await saveManualForm(c.db,c.scope,form,prompt,c.now);
}
const field=(text:string,value:unknown):Button=>[text,{action:'field',value}];
async function announcementList(c:Context,offset=0,search='',archive=false) {
  const rows=await listManualAnnouncements(c.db,{offset,search,publicOnly:!c.admin,scopeChatId:c.scope.chatId,now:c.now,archive});
  const buttons:Button[]=rows.slice(0,6).map(row=>[`${MANUAL_KINDS[row.draft.kind]} ${row.draft.course?COURSE_LABELS[row.draft.course]:''} ${row.draft.date??''}`,{action:'announcement-view',ref:{kind:row.kind,id:row.id,revision:row.revision}}]);
  if(c.admin)buttons.unshift(['إضافة تبليغ',{action:'announcement-new'}],['بحث',{action:'announcement-search'}],[archive?'القادمة':'السجل والأرشيف',{action:'announcement-list',archive:!archive}]);
  if(offset)buttons.push(['السابق',{action:'announcement-list',offset:Math.max(0,offset-6),search,archive}]);if(rows.length>6)buttons.push(['التالي',{action:'announcement-list',offset:offset+6,search,archive}]);
  await send(c,`<b>📢 التبليغات</b>\n${rows.length?'اختار تبليغاً لعرض تفاصيله.':'ماكو تبليغات مطابقة.'}`,[...buttons,...nav]);
}
async function announcementView(c:Context,r:ManualAnnouncementReference){
  const row=await getManualAnnouncement(c.db,r);if(!row||row.revision!==r.revision){await send(c,'النسخة تغيّرت؛ افتح القائمة من جديد.');return;}
  if(!c.admin&&!await isManualAnnouncementVisible(c.db,row,c.scope.chatId,c.now)){await send(c,'التبليغ غير متاح.');return;}
  const buttons:Button[]=c.admin&&['active','approved','pending','needs_changes'].includes(row.state)?[
    ['تعديل / تصحيح',{action:'announcement-edit',ref:r}],['نشر الآن',{action:'announcement-publish-confirm',ref:r}],['جدولة النشر',{action:'announcement-schedule',ref:r}],['حالة النشر',{action:'announcement-status',ref:r}],['حذف',{action:'announcement-delete-confirm',ref:r}],
  ]:[];
  await send(c,formatManualAnnouncement(row),[...buttons,['‹ التبليغات',{action:'announcement-list'}],...nav]);
}
async function announcementField(c:Context,form:ManualForm):Promise<void> {
  if(form.field==='kind')await ask(c,form,'اختار نوع التبليغ.',Object.entries(MANUAL_KINDS).map(([v,t])=>field(t,v)));
  else if(form.field==='course')await ask(c,form,'اختار المادة؛ غير محددة تبقى بلا تخمين.',[...Object.entries(COURSE_LABELS).map(([v,t])=>field(t,v)),field('غير محددة',null)]);
  else if(form.field==='date')await ask(c,form,'اكتب التاريخ YYYY-MM-DD بتوقيت بغداد.',[field('بدون موعد محدد',null)]);
  else if(form.field==='time')await ask(c,form,'اكتب الوقت HH:MM بنظام 24 ساعة.',[field('بدون وقت محدد',null)]);
  else if(form.field==='audience')await ask(c,form,'اختار المجموعة.',[field('A','A'),field('B','B'),field('للكل','all'),field('غير محددة',null)]);
  else if(form.field==='details')await ask(c,form,'اكتب الوصف كما تريد عرضه (حد 2600 حرف).',[field('بدون وصف','')]);
  else if(form.field==='coverage')await ask(c,form,'اكتب المطلوب / المشمول (حد 500 حرف).',[field('بدون مشمول','')]);
  else if(form.field==='preview')await send(c,`<b>معاينة قبل الحفظ</b>\n${formatManualAnnouncement({draft:form.draft as unknown as ManualAnnouncementDraft,state:'مسودة'})}`,[['تأكيد الحفظ',{action:'announcement-save',draft:form.draft,...(form.ref?{ref:form.ref}:{})}],['إلغاء',{action:'cancel'}]]);
}
async function timetableMenu(c:Context){
  const buttons:Button[]=[['اليوم',{action:'timetable-view',day:'today'}],['باچر',{action:'timetable-view',day:'tomorrow'}],['الأسبوع',{action:'timetable-view'}],...WEEKDAYS.map((label,day)=>[label,{action:'timetable-view',day}] as Button)];
  if(c.admin)buttons.unshift(['إضافة محاضرة',{action:'lecture-new'}],['تعديل / إزالة محاضرة',{action:'lecture-list'}],['استبدال الجدول',{action:'timetable-replace'}]);
  await send(c,'<b>📅 الجدول الدراسي</b>\nاختار اليوم أو إجراء الإدارة.',[...buttons,...nav]);
}
async function lectureList(c:Context,offset=0){
  const table=await loadEffectiveTimetable(c.db);const rows=table.lectures.slice(offset,offset+6);
  const buttons:Button[]=rows.map(row=>[`${WEEKDAYS[row.day]} · ${row.course} ${row.group??''}`,{action:'lecture-view',id:row.id,revision:table.revision}]);
  if(offset)buttons.push(['السابق',{action:'lecture-list',offset:Math.max(0,offset-6)}]);if(table.lectures.length>offset+6)buttons.push(['التالي',{action:'lecture-list',offset:offset+6}]);
  await send(c,`محاضرات الجدول — نسخة ${table.revision}`,[...buttons,...nav]);
}
async function lectureField(c:Context,form:ManualForm){
  if(form.field==='course')await ask(c,form,'اختار المادة.',Object.entries(COURSE_LABELS).map(([,t])=>field(t,t)));
  else if(form.field==='day')await ask(c,form,'اختار اليوم.',WEEKDAYS.map((label,day)=>field(label,day)));
  else if(form.field==='slot')await ask(c,form,'اختار ترتيب المحاضرة إن كان معروفاً.',[field('الأولى',1),field('الثانية',2),field('الثالثة',3),field('الرابعة',4),field('الخامسة',5),field('غير محدد',null)]);
  else if(form.field==='component')await ask(c,form,'اختار نوع المحاضرة.',[field('نظري','theory'),field('عملي / مختبر','practical'),field('تمارين','exercises'),field('غير محدد',null)]);
  else if(form.field==='group')await ask(c,form,'اختار المجموعة.',[field('A','A'),field('B','B'),field('للكل','all'),field('غير محددة',null)]);
  else if(['time','endTime'].includes(form.field))await ask(c,form,form.field==='time'?'اكتب وقت البداية HH:MM.':'اكتب وقت النهاية HH:MM؛ لازم يكون بعد البداية.',[field('غير محدد',null)]);
  else if(['teacher','room'].includes(form.field))await ask(c,form,form.field==='teacher'?'اكتب اسم التدريسي الموثق؛ ما أخمّن أسماء.':'اكتب القاعة / المختبر.',[field('غير محدد',null)]);
  else if(form.field==='preview')await send(c,formatManualTimetable({revision:form.expectedRevision??0,source:'manual',lectures:[form.draft as unknown as ManualLecture]}),[['تأكيد الحفظ',{action:'lecture-save',draft:form.draft,revision:form.expectedRevision}],['إلغاء',{action:'cancel'}]]);
}
async function reminderList(c:Context,offset=0){
  const rows=await listManualReminders(c.db,offset),buttons:Button[]=rows.slice(0,6).map(row=>[`${localDue(row.dueAt)} · ${row.enabled?'مفعّل':'معطّل'} · ${row.text.slice(0,25)}`,{action:'reminder-view',id:row.id,revision:row.revision}]);
  if(c.admin)buttons.unshift(['إضافة تذكير',{action:'reminder-new'}]);if(offset)buttons.push(['السابق',{action:'reminder-list',offset:Math.max(0,offset-6)}]);if(rows.length>6)buttons.push(['التالي',{action:'reminder-list',offset:offset+6}]);
  await send(c,'<b>🔔 التذكيرات الدراسية</b>\nالتذكيرات الدينية بقسم منفصل.',[...buttons,...nav]);
}
const localDue=(due:number)=>new Date(due+3*3600000).toISOString().slice(0,16).replace('T',' ')+' بغداد';
async function reminderField(c:Context,form:ManualForm){
  if(form.field==='text')await ask(c,form,'اكتب رسالة التذكير (حد 3000 حرف).');
  else if(form.field==='dueAt')await ask(c,form,'اكتب الموعد YYYY-MM-DD HH:MM بتوقيت بغداد.');
  else if(form.field==='destination'){
    const settings=await new EventStore(c.db).getSettings();if(settings.targetChatId===null){await send(c,'اربط وجهة النشر من الإعدادات أولاً.');return;}
    await ask(c,form,`الوجهة الموثقة: ${settings.targetChatId}${settings.targetThreadId===null?'':` · موضوع ${settings.targetThreadId}`}`,[field('استخدام الوجهة المرتبطة',{chatId:settings.targetChatId,threadId:settings.targetThreadId})]);
  }else if(form.field==='preview')await send(c,`<b>معاينة تذكير</b>\n${escapeHtml(String(form.draft.text))}\n${localDue(Number(form.draft.dueAt))}\nالوجهة: ${form.draft.chatId}\n${form.draft.enabled?'مفعّل':'معطّل افتراضياً؛ فعّله بعد الحفظ.'}`,[['تأكيد الحفظ',{action:'reminder-save',draft:form.draft,...(form.ref?{ref:form.ref}:{})}],['إلغاء',{action:'cancel'}]]);
}
async function fieldAnswer(c:Context,value:unknown,promptId:number){
  await requireManualAdmin(c.db,c.scope);
  const saved=await getManualForm(c.db,c.scope);if(!saved||saved.expiresAt<=c.now||saved.promptId!==promptId){await send(c,'انتهت الجلسة أو هذا رد على سؤال قديم. افتح القسم من جديد.');return;}
  const f=saved.form;
  if(f.kind==='delivery-reconcile'){
    const text=cleanManualText(String(value),1000),resolution=f.draft.resolution;
    const match=/^(\d+)\s*\|\s*(.{12,})$/u.exec(text);
    if(resolution==='confirmed'&&!match)throw new RangeError('اكتب رقم الرسالة الفعلي ثم | ثم وصف دليل المشاهدة (12 حرف على الأقل).');
    if(resolution==='not_sent'&&text.length<12)throw new RangeError('اكتب دليل تحقق واضح؛ عدم الرد وحده مو دليل عدم إرسال.');
    await clearManualForm(c.db,c.scope);
    await send(c,'تأكيد تسوية النتيجة حسب مراجعتك اليدوية؟ راح ينحفظ اسم حسابك ودليل المراجعة بالسجل. هذا مو تحقق آلي من Telegram.',[['تأكيد التسوية',{action:'delivery-reconcile-save',id:f.draft.id,resolution,evidence:match?.[2]??text,result:resolution==='confirmed'?{message_id:Number(match![1])}:null}],...nav]);return;
  }
  if(f.kind==='search'){await clearManualForm(c.db,c.scope);await announcementList(c,0,cleanManualText(String(value),100));return;}
  if(f.kind==='publication-time'){const due=parseManualDue(String(value),c.now);await clearManualForm(c.db,c.scope);await send(c,`أنشر التبليغ يوم ${localDue(due)}؟`,[['تأكيد الجدولة',{action:'announcement-publish',ref:f.ref,dueAt:due}],...nav]);return;}
  if(f.kind==='timetable-replace'){
    const rows=validateManualTimetable(JSON.parse(String(value)) as ManualLecture[]);await clearManualForm(c.db,c.scope);
    await send(c,`استبدال كامل الجدول بـ ${rows.length} محاضرة. النسخة الحالية تبقى بالتاريخ.\n${formatManualTimetable({revision:f.expectedRevision??0,source:'manual',lectures:rows})}`,[['تأكيد الاستبدال',{action:'timetable-save',lectures:rows,revision:f.expectedRevision}],...nav]);return;
  }
  const draft={...f.draft};
  if(f.kind==='announcement'){
    if(f.field==='date')value=value===null?null:parseManualDate(String(value));
    if(f.field==='time')value=value===null?null:parseManualTime(String(value));
    if(f.field==='details'||f.field==='coverage')value=cleanManualText(String(value),f.field==='details'?2600:500,false);
    draft[f.field]=value;
    const order=['kind','course','date','time','audience','details','coverage','preview'];const next=f.draft._editing?'preview':order[order.indexOf(f.field)+1]!;delete draft._editing;
    await announcementField(c,{...f,field:next,draft});return;
  }
  if(f.kind==='lecture'){
    if(['time','endTime'].includes(f.field))value=value===null?null:parseManualTime(String(value));
    if(['teacher','room'].includes(f.field))value=value===null?null:cleanManualText(String(value),120,false);
    draft[f.field]=value;const order=['course','day','slot','component','time','endTime','teacher','group','room','preview'];const next=f.draft._editing?'preview':order[order.indexOf(f.field)+1]!;delete draft._editing;
    await lectureField(c,{...f,field:next,draft});return;
  }
  if(f.kind==='reminder'){
    if(f.field==='dueAt')value=parseManualDue(String(value),c.now);if(f.field==='text')value=cleanManualText(String(value),3000);
    if(f.field==='destination')Object.assign(draft,value);else draft[f.field]=value;
    const order=['text','dueAt','destination','preview'];const next=f.draft._editing?'preview':order[order.indexOf(f.field)+1]!;delete draft._editing;
    await reminderField(c,{...f,field:next,draft});return;
  }
  await send(c,'الجلسة غير متاحة.');
}
async function act(c:Context,a:ManualAction):Promise<void>{
  const publicActions=['home','cancel','announcement-list','announcement-view','timetable','timetable-view','reminder-list'];
  if(!publicActions.includes(a.action))await requireManualAdmin(c.db,c.scope);
  if(a.action==='destination-menu'){await beginDestination(c.db,c.telegram,c.scope,c.now);return;}
  if(a.action==='automation-menu'){await showAutomationPanel(c.db,c.telegram,c.scope.userId,'product','',c.now);return;}
  if(a.action==='delivery-review'){
    const attempt=await c.db.prepare("SELECT job_id FROM controlled_attempts WHERE id=? AND state='unknown'").bind(a.id).first<{job_id:string}>();
    if(!attempt){await send(c,'الحالة تغيّرت؛ افتح آخر نسخة.');return;}
    await send(c,'نتيجة الإرسال مجهولة. راجع الرسالة الفعلية بالقناة أولاً. انقطاع الاتصال ما يثبت أنها ما وصلت. التسوية اليدوية إلها سجل، وما تعيد الإرسال وحدها بدون فحوص الموعد والمصدر.',[['شاهدت الرسالة الفعلية',{action:'delivery-reconcile-input',id:a.id,resolution:'confirmed'}],['عندي دليل أنها لم تُرسل',{action:'delivery-reconcile-input',id:a.id,resolution:'not_sent'}],...nav]);return;
  }
  if(a.action==='delivery-reconcile-input'){await ask(c,{kind:'delivery-reconcile',field:'evidence',draft:{id:a.id,resolution:a.resolution}},a.resolution==='confirmed'?'اكتب رقم الرسالة الفعلي | وصف دليل المشاهدة. مثل: 123 | راجعت رسالة دعبول بالقناة وموعدها.':'اكتب دليل عدم الإرسال. عدم وجود جواب من البوت وحده مو دليل.');return;}
  if(a.action==='delivery-reconcile-save'){
    const changed=await reconcileControlledAttempt(c.db,c.scope,String(a.id),a.resolution as 'confirmed'|'not_sent',String(a.evidence),a.result,c.now);
    await send(c,changed?'تم تسجيل المراجعة اليدوية. الطلب المنتهي أو الملغي ما يرجع يننشر؛ فحوص الصلاحية تبقى مطبّقة.':'ما تغيّرت الحالة؛ الدليل غير كافٍ أو نوع الرسالة يحتاج فحصاً خارجياً.');return;
  }
  if(a.action==='home'||a.action==='cancel'){await home(c);return;}
  if(a.action==='field'){await fieldAnswer(c,a.value,c.message.message_id);return;}
  if(a.action==='announcement-list'){await announcementList(c,Number(a.offset??0),String(a.search??''),c.admin&&a.archive===true);return;}
  if(a.action==='announcement-view'){await announcementView(c,ref(a.ref));return;}
  if(a.action==='announcement-new'){await announcementField(c,{kind:'announcement',field:'kind',draft:{kind:'note',course:null,date:null,time:null,audience:null,details:'',coverage:''}});return;}
  if(a.action==='announcement-search'){await ask(c,{kind:'search',field:'search',draft:{}},'اكتب كلمة للبحث في التبليغات.');return;}
  if(a.action==='announcement-edit'){
    const row=await getManualAnnouncement(c.db,ref(a.ref));if(!row||row.revision!==ref(a.ref).revision){await send(c,'النسخة قديمة.');return;}
    await send(c,'اختار الحقل الذي تريد تصحيحه. بقية الحقول والمرفق تبقى محفوظة.',Object.entries({details:'الوصف',course:'المادة',date:'التاريخ',time:'الوقت',audience:'المجموعة',coverage:'المطلوب'}).map(([key,label])=>[label,{action:'announcement-edit-field',ref:a.ref,field:key}] as Button).concat(nav));return;
  }
  if(a.action==='announcement-edit-field'){
    const row=await getManualAnnouncement(c.db,ref(a.ref));if(!row||row.revision!==ref(a.ref).revision){await send(c,'النسخة قديمة.');return;}
    await announcementField(c,{kind:'announcement',field:String(a.field),draft:{...row.draft,_editing:true},ref:a.ref});return;
  }
  if(a.action==='announcement-save'){
    const result=await saveManualAnnouncement(c.db,c.scope,c.updateId,c.now,a.draft as unknown as ManualAnnouncementDraft,a.ref?ref(a.ref):undefined);await clearManualForm(c.db,c.scope);await send(c,result.message,[['التبليغات',{action:'announcement-list'}],...nav]);return;
  }
  if(a.action==='announcement-delete-confirm'){await send(c,'تأكيد حذف التبليغ من القوائم والتذكيرات؟ سجل النشر محفوظ.',[['تأكيد الحذف',{action:'announcement-delete',ref:ref(a.ref)}],...nav]);return;}
  if(a.action==='announcement-delete'){const result=await deleteManualAnnouncement(c.db,c.scope,c.updateId,c.now,ref(a.ref));await send(c,result.message);return;}
  if(a.action==='announcement-publish-confirm'){await send(c,'تأكيد النشر الآن للوجهة المرتبطة؟',[['تأكيد النشر',{action:'announcement-publish',ref:ref(a.ref)}],...nav]);return;}
  if(a.action==='announcement-schedule'){await ask(c,{kind:'publication-time',field:'dueAt',draft:{},ref:ref(a.ref)},'اكتب موعد النشر YYYY-MM-DD HH:MM بتوقيت بغداد.');return;}
  if(a.action==='announcement-publish'){const result=await queueManualPublication(c.db,c.scope,c.updateId,c.now,ref(a.ref),Number(a.dueAt??c.now));await send(c,result.message,[['حالة النشر',{action:'publication-list'}],...nav]);return;}
  if(a.action==='announcement-status'||a.action==='publication-list'){
    const jobs=await listManualPublications(c.db,Number(a.offset??0));const filtered=a.ref?jobs.filter(j=>{const p=j.payload as {ref?:ManualAnnouncementReference};return p.ref?.id===ref(a.ref).id&&p.ref.kind===ref(a.ref).kind;}):jobs;
    const buttons:Button[]=filtered.slice(0,6).filter(j=>j.state==='pending').map(j=>['إلغاء '+localDue(j.dueAt),{action:'publication-cancel-confirm',id:j.id}]);
    if(jobs.length>6)buttons.push(['التالي',{action:'publication-list',offset:Number(a.offset??0)+6}]);
    await send(c,`<b>⏰ حالة المنشورات</b>\n${filtered.length?filtered.map(j=>`${escapeHtml(j.id.slice(0,70))}\n${localDue(j.dueAt)} · ${j.state}${j.lastError?` · ${escapeHtml(j.lastError)}`:''}`).join('\n\n'):'ماكو طلبات نشر.'}\n\nنجاح مؤكد يحتاج إيصال. النتيجة المجهولة تحتاج مراجعة؛ ما نعيد إرسالها عميانياً.`,[...buttons,...nav]);return;
  }
  if(a.action==='publication-cancel-confirm'){await send(c,'إلغاء النشر المجدول قبل الإرسال؟',[['تأكيد الإلغاء',{action:'publication-cancel',id:a.id}],...nav]);return;}
  if(a.action==='publication-cancel'){const r=await cancelManualPublication(c.db,c.scope,c.updateId,c.now,String(a.id));await send(c,r.message);return;}
  if(a.action==='timetable'){await timetableMenu(c);return;}
  if(a.action==='timetable-view'){
    const day=a.day===undefined?undefined:manualDay(a.day as 'today'|'tomorrow'|number,new Date(c.now)),group=a.group as 'A'|'B'|undefined;
    await send(c,await studentTimetable(c.db,a.day as 'today'|'tomorrow'|number|undefined,new Date(c.now),group),[['مجموعة A',{action:'timetable-view',...(a.day===undefined?{}:{day:a.day}),group:'A'}],['مجموعة B',{action:'timetable-view',...(a.day===undefined?{}:{day:a.day}),group:'B'}],['اختيار يوم',{action:'timetable'}],...nav]);return;
  }
  if(a.action==='lecture-list'){await lectureList(c,Number(a.offset??0));return;}
  if(a.action==='lecture-new'){const table=await loadEffectiveTimetable(c.db);await lectureField(c,{kind:'lecture',field:'course',expectedRevision:table.revision,draft:{id:`lecture-${c.updateId}`,day:0,slot:null,course:'',component:null,time:null,endTime:null,teacher:null,group:null,room:null}});return;}
  if(a.action==='lecture-view'){
    const table=await loadEffectiveTimetable(c.db),row=table.lectures.find(r=>r.id===a.id);if(!row||table.revision!==a.revision){await send(c,'الجدول تغيّر؛ افتح آخر نسخة.');return;}
    await send(c,formatManualTimetable({...table,lectures:[row]}),Object.entries({course:'المادة',day:'اليوم',slot:'ترتيب المحاضرة',component:'نظري / عملي',time:'البداية',endTime:'النهاية',teacher:'التدريسي',group:'المجموعة',room:'القاعة'}).map(([key,label])=>[label,{action:'lecture-edit-field',id:row.id,revision:table.revision,field:key}] as Button).concat([['إزالة المحاضرة',{action:'lecture-delete-confirm',id:row.id,revision:table.revision}],...nav]));return;
  }
  if(a.action==='lecture-edit-field'){
    const table=await loadEffectiveTimetable(c.db),row=table.lectures.find(r=>r.id===a.id);if(!row||table.revision!==a.revision){await send(c,'الجدول تغيّر.');return;}
    await lectureField(c,{kind:'lecture',field:String(a.field),expectedRevision:table.revision,draft:{...row,_editing:true}});return;
  }
  if(a.action==='lecture-delete-confirm'){await send(c,'تأكيد إزالة المحاضرة من الجدول القادم؟ النسخة السابقة تبقى محفوظة.',[['تأكيد الإزالة',{action:'lecture-delete',id:a.id,revision:a.revision}],...nav]);return;}
  if(a.action==='lecture-save'||a.action==='lecture-delete'){
    const table=await loadEffectiveTimetable(c.db);if(table.revision!==a.revision){await send(c,'الجدول تغيّر؛ افتح آخر نسخة.');return;}
    const draft=a.draft as unknown as ManualLecture;const rows=table.lectures.filter(row=>row.id!==(a.action==='lecture-delete'?a.id:draft.id));if(a.action==='lecture-save')rows.push(draft);
    const result=await saveManualTimetable(c.db,c.scope,c.updateId,c.now,table.revision,rows);await clearManualForm(c.db,c.scope);await send(c,result.message,[['الجدول',{action:'timetable'}],...nav]);return;
  }
  if(a.action==='timetable-replace'){const table=await loadEffectiveTimetable(c.db);await send(c,'اختار نقطة البداية للجدول البديل. بعد التأكيد تگدر تضيف وتعدل محاضراته من الأزرار؛ النسخ السابقة تبقى محفوظة.',[['نسخة من الجدول الرسمي',{action:'timetable-replace-preview',lectures:officialTimetable().lectures,revision:table.revision}],['جدول فارغ لإضافة المحاضرات',{action:'timetable-replace-preview',lectures:[],revision:table.revision}],...nav]);return;}
  if(a.action==='timetable-replace-preview'){const lectures=validateManualTimetable(a.lectures as unknown as ManualLecture[]);await send(c,`معاينة استبدال الجدول\n${formatManualTimetable({revision:Number(a.revision),source:'manual',lectures})}`,[['تأكيد الاستبدال',{action:'timetable-save',lectures,revision:a.revision}],...nav]);return;}
  if(a.action==='timetable-save'){const r=await saveManualTimetable(c.db,c.scope,c.updateId,c.now,Number(a.revision),a.lectures as unknown as ManualLecture[]);await send(c,r.message);return;}
  if(a.action==='reminder-list'){await reminderList(c,Number(a.offset??0));return;}
  if(a.action==='reminder-new'){await reminderField(c,{kind:'reminder',field:'text',draft:{enabled:false}});return;}
  if(a.action==='reminder-view'){
    const row=await getManualReminder(c.db,String(a.id));if(!row||row.revision!==a.revision){await send(c,'التذكير تغيّر.');return;}
    const buttons:Button[]=c.admin?[['الرسالة',{action:'reminder-edit-field',id:row.id,revision:row.revision,field:'text'}],['التاريخ والوقت',{action:'reminder-edit-field',id:row.id,revision:row.revision,field:'dueAt'}],['الوجهة',{action:'reminder-edit-field',id:row.id,revision:row.revision,field:'destination'}],[row.enabled?'تعطيل':'تفعيل',{action:'reminder-state-confirm',id:row.id,revision:row.revision,mode:row.enabled?'disable':'enable'}],['إلغاء التذكير',{action:'reminder-state-confirm',id:row.id,revision:row.revision,mode:'cancel'}]]:[];
    await send(c,`🔔 ${escapeHtml(row.text)}\n${localDue(row.dueAt)}\n${row.state} · ${row.enabled?'مفعّل':'معطّل'}\nالوجهة: ${row.chatId}`,[...buttons,...nav]);return;
  }
  if(a.action==='reminder-edit-field'){
    const row=await getManualReminder(c.db,String(a.id));if(!row||row.revision!==a.revision){await send(c,'التذكير تغيّر.');return;}
    await reminderField(c,{kind:'reminder',field:String(a.field),draft:{...row,_editing:true},ref:{id:row.id,revision:row.revision}});return;
  }
  if(a.action==='reminder-save'){
    const r=await saveManualReminder(c.db,c.scope,c.updateId,c.now,a.draft as unknown as Omit<ManualReminder,'id'|'revision'|'actorId'|'state'>,a.ref as {id:string;revision:number}|undefined);await clearManualForm(c.db,c.scope);await send(c,r.message,[['التذكيرات',{action:'reminder-list'}],...nav]);return;
  }
  if(a.action==='reminder-state-confirm'){await send(c,'تأكيد تغيير حالة التذكير؟',[['تأكيد',{action:'reminder-state',id:a.id,revision:a.revision,mode:a.mode}],...nav]);return;}
  if(a.action==='reminder-state'){
    const r=await changeManualReminderState(c.db,c.scope,c.updateId,c.now,{id:String(a.id),revision:Number(a.revision)},a.mode as 'enable'|'disable'|'cancel');await queueManualReminders(c.db,c.now);await send(c,r.message);return;
  }
  if(a.action==='settings'){
    const p=await getManualPublicationConfig(c.db),r=await getManualReminderConfig(c.db),s=await new EventStore(c.db).getSettings();
    await send(c,`<b>⚙️ الإعدادات</b>\nالوجهة المرتبطة: ${s.targetChatId??'غير مربوطة'}\nالمنشورات الدراسية: ${p.enabled?'مفعّلة':'متوقفة'}\nالتذكيرات الدراسية: ${r.enabled?'مفعّلة':'متوقفة'}\nالتشغيل افتراضيًا متوقف.`,[['ربط وجهة النشر',{action:'destination-menu'}],['تهيئة النشر الجديد',{action:'automation-menu'}],[p.enabled?'إيقاف المنشورات':'تشغيل المنشورات',{action:'settings-confirm',key:'academic_publications',revision:p.revision,enabled:!p.enabled}],[r.enabled?'إيقاف التذكيرات':'تشغيل التذكيرات',{action:'settings-confirm',key:'academic_reminders',revision:r.revision,enabled:!r.enabled}],...nav]);return;
  }
  if(a.action==='settings-confirm'){await send(c,`تأكيد ${a.enabled?'تشغيل':'إيقاف'} الخدمة؟`,[['تأكيد',{action:'settings-save',key:a.key,revision:a.revision,enabled:a.enabled}],...nav]);return;}
  if(a.action==='settings-save'){const r=await setManualConfig(c.db,c.scope,c.updateId,c.now,a.key as 'academic_publications'|'academic_reminders',Number(a.revision),a.enabled===true);await send(c,r.message);return;}
  if(a.action==='status'){
    const rows=await c.db.prepare('SELECT state,COUNT(*) AS n FROM outbox GROUP BY state').all<{state:string;n:number}>(),unknown=await c.db.prepare("SELECT id FROM controlled_attempts WHERE state='unknown' ORDER BY started_at DESC LIMIT 5").all<{id:string}>();await send(c,`<b>📊 حالة النظام</b>\nالوقت: ${getBaghdadNow(new Date(c.now)).date} بغداد\n${rows.results.map(row=>`${escapeHtml(row.state)}: ${row.n}`).join('\n')}\nالنشر الفعلي مثبت بإيصال، أو تسوية يدوية واضحة بالسجل. حالة failed/unknown تحتاج مراجعة.`,[...unknown.results.map((r,i)=>['مراجعة نتيجة مجهولة '+(i+1),{action:'delivery-review',id:r.id}] as Button),...nav]);return;
  }
  await send(c,'الزر غير متاح.');
}

/** Terminal deterministic private interface. Never calls an AI provider or a legacy mutation handler. */
export async function handleManualUpdate(update:TelegramUpdate,telegram:TelegramClient,env:ContributionEnv,now=new Date(),admitted=false):Promise<boolean>{
  const q=update.callback_query,message=q?.message?{...q.message,from:q.from}:update.message;
  if(!message?.from||message.from.is_bot||message.sender_chat||message.via_bot||message.chat.type!=='private'||message.chat.id!==message.from.id)return false;
  if(q&&!q.data?.startsWith('man:'))return false;
  const text=(message.text??'').trim();if(!q&&EXTERNAL.includes(text))return false;
  if(!env.DB){await telegram.call('sendMessage',{chat_id:message.chat.id,text:'قاعدة البيانات غير متاحة؛ الإدارة متوقفة.'});return true;}
  const db=env.DB,store=new EventStore(db),settings=await store.getSettings(),admin=isAdmin(message.from.id,settings.ownerUid),scope=manualScope(message);
  const c:Context={db,telegram,message,scope,now:now.getTime(),updateId:update.update_id,admin};
  const claim=admitted?'new':await store.claimUpdate(update.update_id,c.now);if(claim==='done')return true;if(claim==='busy')throw new TelegramError(429,true,1);
  const lock=admitted?'outer':await store.claimConversation(scope.userId,scope.chatId,scope.threadId,c.now);if(!lock){await store.releaseUpdate(update.update_id);throw new TelegramError(429,true,1);}
  try{
    if(q){
      const action=await consumeManualPanel(db,update,c.now);await telegram.call('answerCallbackQuery',{callback_query_id:q.id,text:action?'':'الزر قديم أو انتهت مدته؛ افتح القسم من جديد.'});if(action)await act(c,action);
    }else if(/^\/(?:start|help)(?:\s+\S+)?$/.test(text)||['رجوع','إلغاء','القائمة الرئيسية'].includes(text))await home(c);
    else if(text==='📢 التبليغات'){await clearManualForm(db,scope);await announcementList(c);}
    else if(text==='📅 الجدول الدراسي'){await clearManualForm(db,scope);await timetableMenu(c);}
    else if(text==='🔔 التذكيرات'&&admin){await clearManualForm(db,scope);await reminderList(c);}
    else if(text==='🔔 التذكيرات والمواعيد'&&!admin){const rows=await listManualAnnouncements(db,{publicOnly:true,scopeChatId:scope.chatId,now:c.now});await send(c,`<b>🔔 المواعيد المسجلة</b>\n${rows.filter(r=>r.draft.date).map(r=>`${r.draft.date}${r.draft.time?' '+r.draft.time:''} · ${MANUAL_KINDS[r.draft.kind]}${r.draft.course?' '+COURSE_LABELS[r.draft.course]:''}`).join('\n')||'ماكو مواعيد منشورة.'}`);}
    else if(text==='⏰ المنشورات المجدولة'&&admin){await clearManualForm(db,scope);await act(c,{action:'publication-list'});}
    else if(text==='⚙️ الإعدادات'&&admin){await clearManualForm(db,scope);await act(c,{action:'settings'});}
    else if(text==='📊 حالة النظام'&&admin){await clearManualForm(db,scope);await act(c,{action:'status'});}
    else{
      const form=await getManualForm(db,scope);
      const schedule=(!form||form.expiresAt<=c.now)?await requestedStudentTimetable(db,text,message.date?new Date(message.date*1000):now):null;
      if(admin&&form&&form.expiresAt>c.now&&message.reply_to_message?.message_id===form.promptId&&message.text!==undefined)await fieldAnswer(c,message.text,form.promptId);
      else if(schedule)await send(c,schedule);
      else await send(c,admin?'اختار زرّاً. النص يُقبل فقط بالرد على سؤال الحقل المفتوح.':'اختار من الأزرار الخمسة لعرض المعلومات. تعديل البيانات والنشر للإدارة فقط.');
    }
    await store.completeUpdate(update.update_id,c.now);return true;
  }catch(error){
    if(error instanceof RangeError||error instanceof Error&&error.message==='MANUAL_FORBIDDEN'){
      await telegram.call('sendMessage',{chat_id:scope.chatId,text:error instanceof RangeError?error.message:'هذا الإجراء متاح للأدمن بالخاص فقط.'});
      if(error instanceof RangeError&&admin){const active=await getManualForm(db,scope);if(active&&active.expiresAt>c.now){
        if(active.form.kind==='announcement')await announcementField(c,active.form);
        else if(active.form.kind==='lecture')await lectureField(c,active.form);
        else if(active.form.kind==='reminder')await reminderField(c,active.form);
      }}
      await store.completeUpdate(update.update_id,c.now);return true;
    }
    await store.releaseUpdate(update.update_id);throw error;
  }finally{if(!admitted)await store.releaseConversation(scope.userId,scope.chatId,scope.threadId,lock);}
}
