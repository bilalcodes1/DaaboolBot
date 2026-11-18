import { EventStore } from './event-store';
import { requireManualAdmin, getManualForm, saveManualForm, clearManualForm, saveManualPanel, consumeManualPanel, manualCommand, type ManualScope } from './manual-store';
import { configureAutomation, getAutomationConfig } from './controlled-scheduler';
import type { TelegramClient } from './telegram';
import type { TelegramUpdate } from './types';

export async function beginDestination(db:D1Database,tg:TelegramClient,scope:ManualScope,now:number){
 await requireManualAdmin(db,scope);
 const sent=await tg.call<{message_id:number}>('sendMessage',{chat_id:scope.userId,text:'اكتب رقم القناة أو الكروب السالب. للمنتدى تگدر تضيف رقم الموضوع بعد مسافة. لازم أنت ودعبول عدكم صلاحية الإدارة هناك. الربط ما يرسل منشوراً.',reply_markup:{force_reply:true,selective:true}});
 await saveManualForm(db,scope,{kind:'destination',field:'chat',draft:{}},sent.message_id,now);
}
async function verify(tg:TelegramClient,uid:number,chatId:number,threadId:number|null){
 if(!Number.isSafeInteger(chatId)||chatId>=0||threadId!==null&&(!Number.isSafeInteger(threadId)||threadId<=0))throw new RangeError('رقم الوجهة أو الموضوع غير صالح.');
 const me=await tg.getMe();
 const chat=await tg.call<{id:number;type:string;is_forum?:boolean}>('getChat',{chat_id:chatId});
 if(chat.id!==chatId||!['group','supergroup','channel'].includes(chat.type)||threadId!==null&&!chat.is_forum)throw new RangeError('الوجهة مو كروب أو قناة صالحة.');
 const bot=await tg.call<{status:string;can_post_messages?:boolean}>('getChatMember',{chat_id:chatId,user_id:me.id});
 const user=await tg.call<{status:string}>('getChatMember',{chat_id:chatId,user_id:uid});
 if(!['creator','administrator'].includes(bot.status)||chat.type==='channel'&&bot.status!=='creator'&&bot.can_post_messages!==true||!['creator','administrator'].includes(user.status))throw new RangeError('يلزم أنت ودعبول تكونون أدمن بالوجهة، ودعبول يگدر ينشر بالقناة.');
}
export async function handleDestinationUpdate(update:TelegramUpdate,tg:TelegramClient,db:D1Database,now:number):Promise<boolean>{
 const cb=update.callback_query,msg=cb?.message??update.message,uid=cb?.from.id??msg?.from?.id;
 if(!msg||!uid||msg.chat.type!=='private'||msg.chat.id!==uid)return false;
 const scope={userId:uid,chatId:uid,threadId:null},form=await getManualForm(db,scope);
 if(!cb&&form?.form.kind!=='destination'||cb&&!cb.data?.startsWith('dst:'))return false;
 await requireManualAdmin(db,scope);
 if(cb){
  const match=/^dst:([a-f0-9]{24}):(\d{1,2})$/u.exec(cb.data!),a=match?await consumeManualPanel(db,{...update,callback_query:{...cb,data:`man:${match[1]}:${match[2]}`}},now):null;
  await tg.call('answerCallbackQuery',{callback_query_id:cb.id,text:a?'':'الزر قديم.'});if(!a||a.action!=='destination-save')return true;
  await verify(tg,uid,Number(a.chatId),a.threadId as number|null);
  const result=await manualCommand(db,scope,update.update_id,a,now,(gate,args)=>[
   db.prepare(`UPDATE settings SET target_chat_id=?,target_thread_id=? WHERE singleton=1 AND target_chat_id IS ? AND target_thread_id IS ? AND ${gate}`).bind(a.chatId,a.threadId,a.beforeChatId,a.beforeThreadId,...args),
  ],{ok:true,message:'تم ربط وجهة النشر والتحقق من صلاحياتكم. الموضوع يتحقق عند الإرسال؛ إذا مو موجود يفشل الطلب بدون ادعاء نجاح.'});
  if(result.ok){const config=await getAutomationConfig(db,'product');await configureAutomation(db,'product',{enabled:false,expectedGeneration:config.generation,body:{legacyReviewed:false}},now);}
  await tg.call('sendMessage',{chat_id:uid,text:result.message});return true;
 }
 const text=update.message?.text?.trim()??'';
 if(['إلغاء','رجوع','القائمة الرئيسية'].includes(text)||/^\p{Extended_Pictographic}/u.test(text)){await clearManualForm(db,scope);return false;}
 if(form!.expiresAt<=now||msg.reply_to_message?.message_id!==form!.promptId)return false;
 const [chat,topic,...extra]=text.split(/\s+/u),chatId=Number(chat),threadId=topic===undefined?null:Number(topic);
 if(extra.length)throw new RangeError('اكتب رقم الوجهة، وبعده رقم الموضوع إن وجد.');await verify(tg,uid,chatId,threadId);
 const settings=await new EventStore(db).getSettings(),sent=await tg.call<{message_id:number}>('sendMessage',{chat_id:uid,text:`تأكيد تغيير وجهة النشر إلى ${chatId}${threadId===null?'':`، الموضوع ${threadId}`}؟ التشغيل يتوقف بعد التغيير حتى تراجعه.`});
 const token=await saveManualPanel(db,scope,sent.message_id,[{action:'destination-save',chatId,threadId,beforeChatId:settings.targetChatId,beforeThreadId:settings.targetThreadId}],now);
 await tg.call('editMessageReplyMarkup',{chat_id:uid,message_id:sent.message_id,reply_markup:{inline_keyboard:[[{text:'تأكيد الربط',callback_data:`dst:${token}:0`}]]}});await clearManualForm(db,scope);return true;
}
