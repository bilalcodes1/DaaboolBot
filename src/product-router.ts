import { isAdmin } from './admin';
import { EventStore } from './event-store';
import { TelegramClient, TelegramError } from './telegram';
import type { Env, TelegramMessage, TelegramUpdate } from './types';
import { handleManualUpdate, showManualMenu, MANUAL_ADMIN_BUTTONS, MANUAL_STUDENT_BUTTONS } from './manual-interface';
import { handleIdentityUpdate } from './student-identity';
import { handleAutomationUpdate } from './automation-interface';
import { handleGroupChat } from './group-chat';
import { clearManualForm, invalidateManualPanels } from './manual-store';
import { escapeHtml } from './format';
import { handleDestinationUpdate } from './product-destination';
import { renderGroundedSource, validateGroundedArabicSummary, type SourceDocument } from './content-sources';

// A Telegram client can keep an older reply keyboard until it receives a replacement.
const retiredMenuButtons = new Set(['🎉 الفعاليات', '🎬 مكتبة الفيديوهات', '😂 مكتبة الميمز والرياكشنات', '📖 مراجعة القصص والحقائق']);

/** No lazy migration, owner bootstrap, provider call or fallback to a legacy route. */
export async function productStorageReady(db:D1Database):Promise<boolean>{
 const tables=['manual_panels','manual_forms','manual_operations','manual_timetable','manual_reminders','student_roster','student_identities','group_ai_turns','controlled_config','controlled_attempts'];
 const r=await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tables.map(()=>'?').join(',')})`).bind(...tables).all<{name:string}>();
 return r.results.length===tables.length;
}
async function information(update:TelegramUpdate,tg:TelegramClient,db:D1Database,message:TelegramMessage,now:number):Promise<boolean>{
 const text=message.text?.trim(),uid=message.from!.id;
 if(text!=='ℹ️ معلومات القسم'&&text!=='📰 آخر الأخبار')return false;
 await clearManualForm(db,{userId:uid,chatId:uid,threadId:null});await invalidateManualPanels(db,{userId:uid,chatId:uid,threadId:null});
 if(text==='ℹ️ معلومات القسم'){
  await tg.call('sendMessage',{chat_id:uid,text:'دعبول — المرحلة الثالثة، علوم الحاسوب، جامعة الأنبار. المطوّر بلال زامل أحمد. المواد والمحاضرات والتدريسيون حسب الجدول المخزّن.\nإدارة التبليغات من أزرار الأدمن بالخاص؛ المحادثة العامة بالمنشن داخل الكروبات المصرّح بها.',reply_markup:{keyboard:[[{text:'هويتي'}],[{text:'انسَ محادثاتي'},{text:'إيقاف استخدام اسمي'}],[{text:'القائمة الرئيسية'}]],resize_keyboard:true}});
 }else{
  const rows=await db.prepare("SELECT body_json,approved_json FROM controlled_source_documents WHERE kind='news' AND state='approved' AND used_at IS NOT NULL AND published_at BETWEEN ? AND ? ORDER BY used_at DESC LIMIT 1").bind(now-3*86400000,now).all<{body_json:string;approved_json:string}>();
  const row=rows.results[0],doc=row?JSON.parse(row.body_json) as SourceDocument:null,summary=doc?validateGroundedArabicSummary(JSON.parse(row!.approved_json),doc,now):null;
  await tg.call('sendMessage',{chat_id:uid,text:doc&&summary?renderGroundedSource(doc,summary):'ماكو خبر حديث منشور ومتحقق منه حالياً.',parse_mode:'HTML',link_preview_options:{is_disabled:true}});
 }return true;
}
/** Terminal boundary: in product mode every update ends here, including legacy callbacks and inline mode. */
export async function handleProductUpdate(update:TelegramUpdate,tg:TelegramClient,env:Env,now=new Date(),fetcher:typeof fetch=fetch):Promise<void>{
 tg.setPreservePrivateKeyboard?.(true);
 if(update.inline_query){await tg.call('answerInlineQuery',{inline_query_id:update.inline_query.id,results:[],cache_time:0,is_personal:true});return;}
 const q=update.callback_query,message=q?.message??update.message,actor=q?.from??message?.from;
 if(!env.DB||!await productStorageReady(env.DB)){
  if(q)await tg.call('answerCallbackQuery',{callback_query_id:q.id,text:'الواجهة الجديدة غير مهيّأة؛ الإدارة متوقفة.'});
  else if(message?.chat.type==='private')await tg.call('sendMessage',{chat_id:message.chat.id,text:'الواجهة الجديدة غير مهيّأة؛ يلزم استكمال إعداد قاعدة البيانات.'});
  return;
 }
 const db=env.DB;
 if(!message||!actor||actor.is_bot||message.sender_chat||message.via_bot)return;
 if(message.chat.type!=='private'){
  if(q){await tg.call('answerCallbackQuery',{callback_query_id:q.id,text:'إدارة دعبول من الأزرار بالخاص فقط.'});return;}
  await handleGroupChat(update,tg,env,now,fetcher);return;
 }
 if(message.chat.id!==actor.id)return;
 const store=new EventStore(db),at=now.getTime(),scope={userId:actor.id,chatId:actor.id,threadId:null};
 const admission=await store.claimUpdate(update.update_id,at);if(admission==='done')return;if(admission==='busy')throw new TelegramError(429,true,1);
 const lease=await store.claimConversation(actor.id,actor.id,null,at);if(!lease){await store.releaseUpdate(update.update_id);throw new TelegramError(429,true,1);}
 try{
  const admin=isAdmin(actor.id,(await store.getSettings()).ownerUid);
  const text=message.text?.trim()??'';
  const replaceOldMenu=q?/^(?:lib|ent):/u.test(q.data??''):retiredMenuButtons.has(text);
  if(replaceOldMenu||!q&&[...MANUAL_ADMIN_BUTTONS,...MANUAL_STUDENT_BUTTONS,'القائمة الرئيسية','إلغاء','رجوع','/start','/help'].includes(text)){
   await clearManualForm(db,scope);await invalidateManualPanels(db,scope);
   await db.prepare('DELETE FROM student_identity_sessions WHERE user_id=?').bind(actor.id).run();
  }
  if(replaceOldMenu){
   if(q)await tg.call('answerCallbackQuery',{callback_query_id:q.id,text:'تم تحديث القائمة.'});
   await showManualMenu(tg,{...message,from:actor},admin);
  }
  else if(q&&!/^(?:man|idn|ctl|dst):/u.test(q.data??''))await tg.call('answerCallbackQuery',{callback_query_id:q.id,text:'هذا زر من الواجهة القديمة؛ افتح القائمة الجديدة.'});
  else if(await handleIdentityUpdate(update,tg,env,now)){}
  else if(await handleAutomationUpdate(update,tg,env,now)){}
  else if(await handleDestinationUpdate(update,tg,db,at)){}
  else if(await information(update,tg,db,{...message,from:actor},at)){}
  else if(!await handleManualUpdate(update,tg,env,now,true)){
   if(q)await tg.call('answerCallbackQuery',{callback_query_id:q.id,text:'الزر غير متاح.'});
   else await showManualMenu(tg,{...message,from:actor},admin);
  }
  await store.completeUpdate(update.update_id,at);
 }catch(error){
  if(error instanceof RangeError||error instanceof Error&&error.message==='MANUAL_FORBIDDEN'){
   await tg.call('sendMessage',{chat_id:actor.id,text:escapeHtml(error instanceof RangeError?error.message:'هذا الإجراء للأدمن فقط.'),parse_mode:'HTML'});await store.completeUpdate(update.update_id,at);
  }else{await store.releaseUpdate(update.update_id);throw error;}
 }finally{await store.releaseConversation(actor.id,actor.id,null,lease);}
}
