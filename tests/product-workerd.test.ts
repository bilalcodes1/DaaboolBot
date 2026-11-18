import {beforeAll,afterAll,it,expect} from 'vitest';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions,Response as RuntimeResponse} from 'miniflare';
import {configureAutomation} from '../src/controlled-scheduler';
import {setManualConfig} from '../src/manual-delivery';
let mf:Miniflare,db:D1Database;
const calls:{host:string;method:string;body:Record<string,unknown>}[]=[];
const TOKEN='777:synthetic-runtime-token-0000000000',SECRET='synthetic-product-webhook-secret-00000000';
beforeAll(async()=>{
 const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
  import {createWorker} from './src/index';
  import {runProductCron} from './src/product-jobs';
  import {TelegramClient} from './src/telegram';
  const worker=createWorker();
  export default {async fetch(request,env){
   let queries=0;
   const admit=n=>{queries+=n;if(queries>50)throw Error('LOCAL_D1_QUERY_CAP');};
   const wrap=s=>({raw:s,bind(...v){return wrap(s.bind(...v));},first(...v){admit(1);return s.first(...v);},all(...v){admit(1);return s.all(...v);},run(...v){admit(1);return s.run(...v);}});
   const DB={prepare:q=>wrap(env.DB.prepare(q)),batch:s=>{admit(s.length);return env.DB.batch(s.map(p=>p.raw));}};
   if(new URL(request.url).pathname==='/synthetic-product-cron'){
    const now=Date.parse('2026-11-08T16:00:00+03:00');
    const result=await runProductCron({...env,DB,PRODUCT_AUTOMATION_ENABLED:'true'},new TelegramClient(env.TELEGRAM_BOT_TOKEN),now);
    return Response.json(result,{headers:{'x-local-queries':String(queries)}});
   }
   const response=await worker.fetch(request,{...env,DB});const headers=new Headers(response.headers);headers.set('x-local-queries',String(queries));return new Response(response.body,{status:response.status,headers});
  }};
 `},bundle:true,platform:'browser',format:'esm',target:'es2022',write:false});
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-13',script:bundle.outputFiles[0]!.text,d1Databases:{DB:'synthetic-product'},bindings:{TELEGRAM_BOT_TOKEN:TOKEN,WEBHOOK_SECRET_TOKEN:SECRET,PRODUCT_MODE_ENABLED:'true',GROUP_AI_ENABLED:'true',PRODUCT_ALLOWED_GROUP_IDS:'-100777',GROQ_API_KEY:'synthetic-provider-credential'},outboundService:async request=>{
  const url=new URL(request.url),body=await request.json() as Record<string,unknown>,method=url.pathname.split('/').at(-1)!;calls.push({host:url.host,method,body});
  if(url.host==='api.groq.com')return RuntimeResponse.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({reply:'هلا حبيبي، أكدر أوضحلك الموجود بالجدول 😄'})}}],usage:{total_tokens:250,prompt_tokens:200,completion_tokens:50}});
  if(url.host!=='api.telegram.org')throw Error('UNAUTHORIZED_EXTERNAL_TARGET');return RuntimeResponse.json({ok:true,result:method==='getMe'?{id:777,is_bot:true,username:'DaaboolLocalBot'}:method==='sendMessage'?{message_id:1000+calls.length}:true});
 }}));
 db=await mf.getD1Database('DB') as unknown as D1Database;
 for(const file of (await readdir(resolve('migrations'))).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile(resolve('migrations',file),'utf8')).split(';').map(s=>s.trim()).filter(s=>s&&!/^(?:--[^\n]*(?:\n|$)|\s)*$/u.test(s)))await db.prepare(sql).run();
 await db.prepare('UPDATE settings SET owner_uid=9001,target_chat_id=-100777').run();
},30000);
afterAll(async()=>{await mf?.dispose();});
async function webhook(id:number,text:string,uid:number,privateChat=true){return mf.dispatchFetch('https://local.test/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':SECRET},body:JSON.stringify({update_id:id,message:{message_id:id,from:{id:uid,is_bot:false},chat:{id:privateChat?uid:-100777,type:privateChat?'private':'supergroup'},text}})});}
it('uses actual workerd/D1 for product menus and local group schedule replies within the free-query ceiling',async()=>{
 const admin=await webhook(1,'/start',9001);expect(admin.status).toBe(200);expect(Number(admin.headers.get('x-local-queries'))).toBeLessThanOrEqual(50);
 const student=await webhook(2,'📢 التبليغات',9002);expect(student.status).toBe(200);expect(Number(student.headers.get('x-local-queries'))).toBeLessThanOrEqual(50);
 const group=await webhook(3,'@DaaboolLocalBot شعدنا باچر؟',9002,false);expect(group.status).toBe(200);expect(Number(group.headers.get('x-local-queries'))).toBeLessThanOrEqual(50);
 expect(calls.filter(c=>c.host==='api.groq.com')).toHaveLength(0);
 expect(calls.findLast(c=>c.method==='sendMessage'&&c.body.chat_id===-100777)?.body.text).toContain('جدول باچر');
 const before=calls.length;expect((await webhook(3,'@DaaboolLocalBot شعدنا باچر؟',9002,false)).status).toBe(200);expect(calls).toHaveLength(before);
 expect(await db.prepare('SELECT COUNT(*) n FROM academic_reports').first('n')).toBe(0);expect(await db.prepare('SELECT COUNT(*) n FROM outbox').first('n')).toBe(0);
});
it('commits a previewed announcement through real D1 batches, scoped callbacks and the integrated webhook',async()=>{
 let id=100;const initial=calls.filter(c=>c.host==='api.groq.com').length;
 const send=async(update:unknown)=>{const response=await mf.dispatchFetch('https://local.test/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':SECRET},body:JSON.stringify(update)});expect(response.status).toBe(200);expect(Number(response.headers.get('x-local-queries'))).toBeLessThanOrEqual(50);};
 const click=async(label:string)=>{
  const panel=[...calls].reverse().find(c=>c.method==='editMessageReplyMarkup'&&(c.body.reply_markup as any)?.inline_keyboard?.flat().some((b:any)=>b.text===label));expect(panel).toBeTruthy();const button=(panel!.body.reply_markup as any).inline_keyboard.flat().find((b:any)=>b.text===label);
  await send({update_id:++id,callback_query:{id:'cb-'+id,chat_instance:'local',from:{id:9001,is_bot:false},data:button.callback_data,message:{message_id:panel!.body.message_id,chat:{id:9001,type:'private'}}}});
 };
 await webhook(++id,'📢 التبليغات',9001);await click('إضافة تبليغ');await click('امتحان');await click('شبكات الحاسبة');
 const promptIndex=calls.findLastIndex(c=>c.method==='sendMessage');await send({update_id:++id,message:{message_id:id,from:{id:9001,is_bot:false},chat:{id:9001,type:'private'},text:'2026-11-09',reply_to_message:{message_id:1001+promptIndex,chat:{id:9001,type:'private'}}}});
 await click('بدون وقت محدد');await click('للكل');await click('بدون وصف');await click('بدون مشمول');expect(await db.prepare('SELECT COUNT(*) n FROM academic_reports').first('n')).toBe(0);await click('تأكيد الحفظ');
 expect(await db.prepare("SELECT COUNT(*) n FROM academic_reports WHERE state='active' AND course='networks' AND event_date='2026-11-09'").first('n')).toBe(1);expect(calls.filter(c=>c.host==='api.groq.com')).toHaveLength(initial);
});
it('publishes the timetable through workerd and D1 with stale entertainment in the outbox',async()=>{
 const now=Date.parse('2026-11-08T16:00:00+03:00');
 await configureAutomation(db,'product',{enabled:true,body:{legacyReviewed:true}},now-1);
 await setManualConfig(db,{userId:9001,chatId:9001,threadId:null},200,now-1,'academic_reminders',1,true);
 await db.prepare("INSERT INTO outbox(id,type,payload_json,due_at) VALUES('controlled:old-video','controlled_media','{}',?)").bind(now-1).run();
 const initial=calls.length;
 const response=await mf.dispatchFetch('https://local.test/synthetic-product-cron');
 expect(response.status).toBe(200);
 expect(Number(response.headers.get('x-local-queries'))).toBeLessThanOrEqual(50);
 expect((await response.json() as {sent:number}).sent).toBe(1);
 expect((await mf.dispatchFetch('https://local.test/synthetic-product-cron')).status).toBe(200);
 expect(calls.slice(initial).map(c=>c.method)).toEqual(['sendMessage']);
 expect(calls.at(-1)?.body.text).toContain('جدول باچر');
 expect(await db.prepare("SELECT state FROM outbox WHERE id='controlled:old-video'").first('state')).toBe('pending');
});
