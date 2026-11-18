import { validSchoolClosures } from './channel-calendar';
import { EventStore } from './event-store';
import { isAdmin } from './admin';
import { configureAutomation, getAutomationConfig, type ControlledTelegram } from './controlled-scheduler';
import { clearManualForm, consumeManualPanel, getManualForm, saveManualForm, saveManualPanel, invalidateManualPanels, parseManualTime, type ManualAction, type ManualScope } from './manual-store';
import { PRAYER_NAMES, validPrayerConfiguration, type PrayerConfiguration } from './prayer-times';
import { getBaghdadNow } from './calendar';
import { BRIEF_CONTROLS, BRIEF_MENU, isBriefKey } from './brief-schedule';
import type { TelegramUpdate } from './types';
type Key='product'|'news'|'religion';
type B=[string,ManualAction];
const titles:Record<Key,string>={product:'تهيئة النشر الجديد',news:'📰 إعدادات الأخبار',religion:'🕌 التذكيرات الدينية'};
const names=['الفجر','الظهر','العصر','المغرب','العشاء'];
const locations={Ramadi:{city:'الرمادي',latitude:33.4258,longitude:43.2992},Hit:{city:'هيت',latitude:33.6416,longitude:42.8251},Fallujah:{city:'الفلوجة',latitude:33.3491,longitude:43.7854}};
function prayerDefault():PrayerConfiguration{return {city:'الرمادي',region:'Al-Anbar',country:'Iraq',latitude:33.4258,longitude:43.2992,timezone:'Asia/Baghdad',method:3,school:0,adjustments:{},enabledPrayers:[...PRAYER_NAMES],allowOutsideQuietWindow:true,localVerified:false};}
async function sendPanel(db:D1Database,tg:ControlledTelegram,scope:ManualScope,text:string,buttons:B[],now:number){
 const sent=await tg.call<{message_id:number}>('sendMessage',{chat_id:scope.chatId,text});
 if(!Number.isSafeInteger(sent?.message_id))return;
 await invalidateManualPanels(db,scope);
 const nonce=await saveManualPanel(db,scope,sent.message_id,buttons.map(button=>button[1]),now);
 await tg.call('editMessageReplyMarkup',{chat_id:scope.chatId,message_id:sent.message_id,reply_markup:{inline_keyboard:buttons.map(([text],i)=>[{text,callback_data:`ctl:${nonce}:${i}`}])}});
}
async function briefPanel(db:D1Database,tg:ControlledTelegram,scope:ManualScope,now:number,notice=''){
 const sections=await Promise.all(BRIEF_CONTROLS.map(async control=>({...control,config:await getAutomationConfig(db,control.key)})));
 const text=[BRIEF_MENU,'المواعيد بتوقيت بغداد',...sections.map(({label,schedule})=>label+' · '+schedule),...(notice?[notice]:[])].join('\n');
 await sendPanel(db,tg,scope,text,sections.map(({label,key,config})=>[
  (config.enabled?'إيقاف ':'تشغيل ')+label,{action:'brief-toggle',key,generation:config.generation},
 ]),now);
}
async function panel(db:D1Database,tg:ControlledTelegram,uid:number,key:Key,notice='',now=Date.now()){
 const scope:ManualScope={userId:uid,chatId:uid,threadId:null},cfg=await getAutomationConfig(db,key),settings=await new EventStore(db).getSettings();
 if(!isAdmin(uid,settings.ownerUid))return;
 const buttons:B[]=[[cfg.enabled?'إيقاف':'تفعيل',{action:'auto',key,op:'toggle',generation:cfg.generation}]];
 let details=`الحالة: ${cfg.enabled?'مفعلة':'متوقفة'}\nالوجهة المرتبطة: ${settings.targetChatId??'غير محددة'}`;
 if(key==='news'){
  details+='\nخبران كحد أقصى: 17:00 و21:00. الخبر يتأجل أو يتخطّى إذا تزاحم ويا الصلاة أو الذكر.';
 }else if(key==='product'){
  const pending=await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state IN ('pending','sending') AND type NOT LIKE 'controlled_%'").first<{n:number}>();
  details+=`\nطلبات النظام القديم المعلّقة: ${pending?.n??0}. ستبقى محفوظة وخارج مسار النشر الجديد.\nراجعها وسجّل قرارك قبل تشغيل النشر الجديد.`;
  buttons.push(['إضافة يوم عطلة',{action:'auto',key,op:'input',field:'schoolClosure',generation:cfg.generation}],['حذف يوم عطلة',{action:'auto',key,op:'input',field:'removeClosure',generation:cfg.generation}]);
  buttons.push(['راجعت الطلبات القديمة وأؤكد العزل',{action:'auto',key,op:'review',generation:cfg.generation}]);
 }else if(key==='religion'){
  const p=cfg.body.prayer as PrayerConfiguration|undefined;
  details+=`\nالصلاة: ${p?.city??'لم تضبط مدينة'} · طريقة ${p?.method??'—'} · ${p?.verificationMode==='provider_calculation'?'حساب AlAdhan API':p?.localVerified?'مراجعة محلية مسجلة':'اختر مصدر المواقيت'}\nتنبيهات الصلوات المفعّلة تصل بموعدها الفعلي على مدار اليوم.\nالذكر: ${cfg.body.dhikrEnabled===true?'مفعل · موسوعة الأحاديث النبوية':'متوقف'}`;
  details+='\nالذكر يومياً 18:00. الآية أيام الدوام 12:30؛ الجمعة والسبت 10:30.';
  buttons.push(['سجل التذكيرات الدينية',{action:'auto',key,op:'history',generation:cfg.generation}],['تبديل الذكر',{action:'auto',key,op:'dhikr',generation:cfg.generation}],[(cfg.body.verseEnabled===true?'إيقاف':'تشغيل')+' آية اليوم',{action:'auto',key,op:'verse',generation:cfg.generation}],['تسجيل مناسبة مؤكدة',{action:'auto',key,op:'input',field:'observance',generation:cfg.generation}]);
  for(const [id,l] of Object.entries(locations))buttons.push([l.city,{action:'auto',key,op:'city',value:id,generation:cfg.generation}]);
  buttons.push(['طريقة حساب الصلاة (رقم المصدر)',{action:'auto',key,op:'input',field:'method',generation:cfg.generation}],['ضبط الإحداثيات المحلية',{action:'auto',key,op:'input',field:'coordinates',generation:cfg.generation}]);
  for(const school of [0,1])buttons.push([school===0?'العصر: الجمهور':'العصر: الحنفي',{action:'auto',key,op:'school',value:school,generation:cfg.generation}]);
  for(let i=0;i<PRAYER_NAMES.length;i++)buttons.push([`${p?.enabledPrayers.includes(PRAYER_NAMES[i]!)?'✅':'⬜'} ${names[i]}`,{action:'auto',key,op:'prayer',value:PRAYER_NAMES[i],generation:cfg.generation}]);
  buttons.push(['دقائق التصحيح للصلاة',{action:'auto',key,op:'input',field:'adjustment',generation:cfg.generation}],['مطابقة الصلاة بجدول محلي',{action:'auto',key,op:'input',field:'verification',generation:cfg.generation}]);
  buttons.push(['اعتماد حساب AlAdhan API',{action:'auto',key,op:'provider',generation:cfg.generation}]);
 }
 await sendPanel(db,tg,scope,`${titles[key]}\n${details}${notice?'\n'+notice:''}`,buttons,now);
}
export const showAutomationPanel=panel;
export async function handleAutomationUpdate(update:TelegramUpdate,tg:ControlledTelegram,env:{DB?:D1Database},now=new Date()):Promise<boolean>{
 const cb=update.callback_query,msg=cb?.message??update.message,uid=cb?.from.id??msg?.from?.id,db=env.DB,text=update.message?.text,at=now.getTime();
 const label=(Object.entries(titles).find(([,t])=>t===text)?.[0]??(text==='تهيئة النشر الجديد'?'product':undefined)) as Key|undefined;
 const briefs=text?.trim()===BRIEF_MENU;
 if(!db||!msg||!uid||msg.chat.type!=='private'||msg.chat.id!==uid)return cb?.data?.startsWith('ctl:')??false;
 const scope:ManualScope={userId:uid,chatId:uid,threadId:null},form=await getManualForm(db,scope);
 if(!label&&!briefs&&!cb&&form?.form.kind!=='automation')return false;
 if(cb&&!cb.data?.startsWith('ctl:'))return false;
 if(!isAdmin(uid,(await new EventStore(db).getSettings()).ownerUid)){if(cb)await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:'للأدمن فقط'});else await tg.call('sendMessage',{chat_id:uid,text:'هذا القسم للأدمن فقط؛ تگدر تعرض المعلومات من أزرار الطالب.'});return true;}
 if(briefs){await clearManualForm(db,scope);await briefPanel(db,tg,scope,at);return true;}
 if(label){await clearManualForm(db,scope);await panel(db,tg,uid,label,'',at);return true;}
 let action:ManualAction|null=null;
 if(cb){const match=/^ctl:([a-f0-9]{24}):(\d{1,2})$/u.exec(cb.data!);action=match?await consumeManualPanel(db,{...update,callback_query:{...cb,data:`man:${match[1]}:${match[2]}`}},at):null;
  await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:action?'':'الزر قديم أو غير صالح'});
  if(action?.action==='brief-toggle'&&isBriefKey(action.key)&&typeof action.generation==='number'){
   const cfg=await getAutomationConfig(db,action.key);
   if(cfg.generation!==action.generation){await briefPanel(db,tg,scope,at,'الإعداد تغيّر. هاي حالته الحالية.');return true;}
   await configureAutomation(db,action.key,{enabled:!cfg.enabled,expectedGeneration:cfg.generation},at);
   await briefPanel(db,tg,scope,at,'تم حفظ الإعداد.');
   return true;
  }
  if(!action||action.action!=='auto')return true;
 }else if(form&&form.expiresAt>at&&form.form.kind==='automation'){
  if(text==='إلغاء'||text==='القائمة الرئيسية'||text?.startsWith('📅')||text?.startsWith('/start')){await clearManualForm(db,scope);return false;}
  if(update.message?.reply_to_message?.message_id!==form.promptId)return true;
  action={action:'auto',key:form.form.draft.key,op:'value',field:form.form.field,value:text,generation:form.form.expectedRevision};
 }else return false;
 const key=action.key as Key;if(!Object.hasOwn(titles,key))return true;const cfg=await getAutomationConfig(db,key);
 if(cfg.generation!==action.generation){await panel(db,tg,uid,key,'الإعداد تغيّر؛ افتح آخر نسخة.',at);return true;}
 try{
  const body={...cfg.body},p={...prayerDefault(),...(body.prayer as Partial<PrayerConfiguration>??{})};let enabled=cfg.enabled;
  if(action.op==='history'){const rows=await db.prepare("SELECT sent_at FROM controlled_deliveries WHERE family='prayer' ORDER BY sent_at DESC LIMIT 10").all<{sent_at:number}>();await tg.call('sendMessage',{chat_id:uid,text:rows.results.map(r=>new Date(r.sent_at+3*3600000).toISOString().slice(0,16).replace('T',' ')+' بغداد').join('\n')||'بعده ماكو إرسال ديني مثبت.'});return true;}
  if(action.op==='input'){
   const field=String(action.field),prompts:Record<string,string>={schoolClosure:'اكتب تاريخ العطلة ثم السبب ثم المصدر، وبينها | مثل: 2026-11-16 | عطلة رسمية | إعلان الجامعة. فقط تواريخ مؤكدة.',removeClosure:'اكتب تاريخ العطلة المراد حذفها بصيغة YYYY-MM-DD.',observance:'بعد التحقق من التاريخ، اكتب التاريخ | اسم المناسبة | رابط إثباتها. الأسماء: رمضان، عيد الفطر، عيد الأضحى، عرفة، العشر، الأيام البيض. الرابط من الدرر السنية أو موسوعة الأحاديث أو sunnah.com. لا تعتمد تاريخاً تخمينياً.',minutes:'اكتب الأوقات HH:MM مفصولة بفاصلة (حتى 4 أوقات).',method:'اكتب رقم طريقة الحساب من إعدادات مصدر الصلاة (0–23)، ثم طابقها بجدول محلي.',coordinates:'اكتب خط العرض ثم خط الطول للمدينة، مثل 33.4258 43.2992.',adjustment:'اكتب خمس دقائق تصحيح، للفجر والظهر والعصر والمغرب والعشاء على الترتيب، من -15 إلى 15.',verification:'بعد مقارنة مواقيت اليوم بالمصدر المحلي، اكتب اسم المصدر المحلي الذي قارنت به. لا تعتمد المصدر الآلي وحده.'};
   const sent=await tg.call<{message_id:number}>('sendMessage',{chat_id:uid,text:prompts[field]??'قيمة غير صالحة.',reply_markup:{force_reply:true}});
   await saveManualForm(db,scope,{kind:'automation',field,draft:{key},expectedRevision:cfg.generation},sent.message_id,at);return true;
  }
  if(action.op==='review')body.legacyReviewed=true;
  else if(action.op==='toggle'){enabled=!cfg.enabled;if(enabled&&key==='product'&&body.legacyReviewed!==true)throw Error('راجع طلبات النظام القديم أولاً.');if(enabled&&key==='religion'&&p.enabledPrayers.length&&!validPrayerConfiguration(p))throw Error('اختر مصدر مواقيت الصلاة واضبط المدينة والطريقة أولاً.');}
  else if(action.op==='frequency')throw Error('مواعيد الفقرات ثابتة بالنظام الجديد.');
  else if(action.op==='verse')body.verseEnabled=body.verseEnabled!==true;
  else if(action.op==='dhikr')body.dhikrEnabled=body.dhikrEnabled!==true;
  else if(action.op==='provider'&&key==='religion'){p.localVerified=false;p.verificationMode='provider_calculation';p.verificationSource='https://aladhan.com/prayer-times-api';p.verificationDate=getBaghdadNow(now).date;}
  else if(action.op==='city'){const city=locations[action.value as keyof typeof locations];if(!city)throw Error('مدينة غير صالحة');Object.assign(p,city,{localVerified:false});enabled=false;}
  else if(action.op==='school'){p.school=Number(action.value) as 0|1;p.localVerified=false;enabled=false;}
  else if(action.op==='prayer'){const name=action.value as typeof PRAYER_NAMES[number];if(!PRAYER_NAMES.includes(name))throw Error('صلاة غير صالحة');p.enabledPrayers=p.enabledPrayers.includes(name)?p.enabledPrayers.filter(n=>n!==name):[...p.enabledPrayers,name];}
  else if(action.op==='quiet-confirm'||action.op==='quiet')p.allowOutsideQuietWindow=true;
  else if(action.op==='value'){
   const value=String(action.value??'').trim(),field=String(action.field);
   if(field==='minutes'||field==='dhikrMinutes')throw Error('مواعيد الفقرات ثابتة بالنظام الجديد.');
   else if(field==='schoolClosure'){const [date,reason,source]=value.split('|').map(x=>x.trim());body.schoolClosures=[...(Array.isArray(body.schoolClosures)?body.schoolClosures:[]).filter(x=>x.date!==date),{date,reason,source}];}
   else if(field==='removeClosure'){if(!/^20\d{2}-\d{2}-\d{2}$/u.test(value))throw Error('تاريخ غير صالح');body.schoolClosures=(Array.isArray(body.schoolClosures)?body.schoolClosures:[]).filter(x=>x.date!==value);}
   else if(field==='observance'){
    const [date,label,source]=value.split('|').map(x=>x.trim()),kinds:Record<string,string>={'رمضان':'ramadan','عيد الفطر':'eid_fitr','عيد الأضحى':'eid_adha','عرفة':'arafah','العشر':'dhul_hijjah','الأيام البيض':'white_days'};
    if(!date||!validSchoolClosures([{date,reason:'مناسبة',source:source??''}])||!label||!kinds[label]||!source||!/^https:\/\/(?:dorar.net|hadeethenc.com|sunnah.com)\/[\w/?=:%.-]+$/u.test(source))throw Error('أحتاج تاريخاً صحيحاً ومناسبة معروفة ورابط مصدر موثوق.');
    body.verifiedObservances=[...(Array.isArray(body.verifiedObservances)?body.verifiedObservances:[]).filter(x=>x.date!==date).slice(-59),{date,kind:kinds[label],source,verified:true}];
   }
   else if(field==='method'){const n=Number(value);if(!Number.isInteger(n)||n<0||n>23)throw Error('رقم غير صالح');p.method=n;p.localVerified=false;enabled=false;}
   else if(field==='coordinates'){const coords=value.split(/\s+/u).map(Number);if(coords.length!==2||coords[0]!<31||coords[0]!>36||coords[1]!<38||coords[1]!>45||coords.some(n=>!Number.isFinite(n)))throw Error('إحداثيات غير صالحة');p.latitude=coords[0]!;p.longitude=coords[1]!;p.localVerified=false;enabled=false;}
   else if(field==='adjustment'){const values=value.split(/[,،\s]+/u).map(Number);if(values.length!==5||values.some(n=>!Number.isInteger(n)||Math.abs(n)>15))throw Error('أحتاج خمس قيم بين -15 و15.');p.adjustments=Object.fromEntries(PRAYER_NAMES.map((name,i)=>[name,values[i]]));p.localVerified=false;enabled=false;}
   else if(field==='verification'){if(value.length<5||value.length>180)throw Error('اسم مصدر التحقق غير صالح.');p.localVerified=true;p.verificationMode='local_timetable';p.verificationDate=getBaghdadNow(now).date;p.verificationSource=value;}
   await clearManualForm(db,scope);
  }
  if(key==='religion'){if(!validPrayerConfiguration(p,false))throw Error('إعدادات الصلاة غير صالحة.');body.prayer=p;body.localVerified=p.localVerified;}
  await configureAutomation(db,key,{enabled,body,expectedGeneration:cfg.generation},at);await panel(db,tg,uid,key,'تم حفظ الإعداد والتحقق من النسخة.',at);
 }catch(error){await panel(db,tg,uid,key,error instanceof Error?error.message:'لم أحفظ الإعداد.',at);}return true;
}
