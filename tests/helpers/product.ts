import { localD1 } from './local-d1';
import { TelegramClient, type TelegramMethod } from '../../src/telegram';
import { handleUpdate } from '../../src/bot';
import { configureAutomation } from '../../src/controlled-scheduler';
import type { Env, TelegramUpdate } from '../../src/types';

export const PRODUCT_NOW=Date.parse('2026-11-08T14:00:00+03:00');
export function productHarness(now=PRODUCT_NOW,providerReply?:unknown){
 const local=localD1();local.sqlite.exec('UPDATE settings SET owner_uid=9001,target_chat_id=-100777,target_thread_id=NULL');
 let id=100,serial=1000;
 const calls:{method:TelegramMethod;payload:Record<string,any>}[]=[],messages=new Map<number,Record<string,any>>();
 const faults=new Map<string,number[]>();
 let providerRequests=0;
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://api.groq.com/openai/v1/chat/completions'&&providerReply!==undefined){providerRequests++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(providerReply)}}],usage:{total_tokens:250,prompt_tokens:200,completion_tokens:50}});}
  if(!url.startsWith('https://api.telegram.org/bot'))throw Error('TEST_NETWORK_FORBIDDEN');
  const method=url.split('/').at(-1)! as TelegramMethod,payload=JSON.parse(String(init?.body??'{}'));calls.push({method,payload});
  const code=faults.get(method)?.shift();if(code===0)throw Error('simulated_network_uncertainty');if(code)return Response.json({ok:false,error_code:code,parameters:code===429?{retry_after:2}:{}},{status:code});
  let result:unknown=true;
  if(method==='getMe')result={id:777,is_bot:true,username:'DaaboolLocalBot'};
  else if(method==='getChat')result={id:payload.chat_id,type:'supergroup',is_forum:true};
  else if(method==='getChatMember')result={status:'administrator',can_post_messages:true};
  else if(method==='editMessageReplyMarkup'){const old=messages.get(payload.message_id);if(old)old.reply_markup=payload.reply_markup;result={message_id:payload.message_id};}
  else if(method.startsWith('send')&&method!=='sendChatAction'){
   const mid=++serial;messages.set(mid,{...payload,message_id:mid});
   result={message_id:mid};
  }
  return Response.json({ok:true,result});
 };
 const telegram=new TelegramClient('777:synthetic-test-token-only-000000',fetcher);
 const env:Env={DB:local.db,TELEGRAM_BOT_TOKEN:'777:synthetic-test-token-only-000000',WEBHOOK_SECRET_TOKEN:'local_synthetic_secret_000000000000',PRODUCT_MODE_ENABLED:'true',PRODUCT_AUTOMATION_ENABLED:'false',GROUP_AI_ENABLED:'false',PRODUCT_ALLOWED_GROUP_IDS:'-100777'};
 const dispatch=(update:TelegramUpdate)=>handleUpdate(update,telegram,new Date(now),env,undefined,fetcher);
 const text=async(uid:number,value:string,replyTo?:number)=>{
  const update:TelegramUpdate={update_id:++id,message:{message_id:id,date:Math.floor(now/1000),chat:{id:uid,type:'private'},from:{id:uid,is_bot:false},text:value,...(replyTo?{reply_to_message:{message_id:replyTo,chat:{id:uid,type:'private'}}}:{})}};
  await dispatch(update);return update;
 };
 const button=(uid:number,label:string)=>{
  for(const m of [...messages.values()].reverse())if(m.chat_id===uid){const b=m.reply_markup?.inline_keyboard?.flat().find((b:any)=>b.text===label);if(b)return {message:m,data:b.callback_data as string};}
  throw Error(`Button unavailable: ${label}`);
 };
 const click=async(uid:number,label:string)=>{const b=button(uid,label);const update:TelegramUpdate={update_id:++id,callback_query:{chat_instance:'local',id:'cb-'+id,from:{id:uid,is_bot:false},data:b.data,message:{message_id:b.message.message_id,chat:{id:uid,type:'private'},from:{id:777,is_bot:true},text:b.message.text}}};await dispatch(update);return update;};
 const latest=(uid=9001)=>[...messages.values()].reverse().find(m=>m.chat_id===uid)!;
 const answer=(uid:number,value:string)=>text(uid,value,latest(uid).message_id);
 const enable=async()=>{await configureAutomation(local.db,'product',{enabled:true,body:{legacyReviewed:true}},now);env.PRODUCT_AUTOMATION_ENABLED='true';};
 return {...local,telegram,fetcher,env,calls,messages,faults,dispatch,text,click,button,latest,answer,enable,setNow:(value:number)=>{now=value;},getNow:()=>now,providerRequests:()=>providerRequests};
}
