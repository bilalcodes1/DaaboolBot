import {rememberPublication,pendingPublication,consumePublication,publicationScope} from '../src/admin-publication-context';
import { emptyEventDraft } from '../src/event-types';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {isAdmin,PRIMARY_ADMIN,SECONDARY_ADMIN} from '../src/admin';
import {dailyPublicationOutgoing,queueDailyAcademicDigest,recordPublication} from '../src/daily-publications';
import {handleNaturalAdmin,adminIntent} from '../src/natural-admin';
import {TelegramClient,TelegramError} from '../src/telegram';
import {handleUpdate} from '../src/bot';
import {parseUpdate} from '../src/input';
import {parseNewsFeed,NEWS_FEEDS,safeNewsUrl,dailyNewsOutgoing,queueDailyNews} from '../src/daily-news';
import {EventStore} from '../src/event-store';
import {dispatchEventJobs,queuePublish} from '../src/event-jobs';
import type {AssistantReference} from '../src/assistant-references';
import type {TelegramUpdate} from '../src/types';
const now=Date.parse('2026-10-26T18:00:00+03:00');
const dbs:DatabaseSync[]=[];
function database(){
 const sql=new DatabaseSync(':memory:');dbs.push(sql);
 const dir=resolve(import.meta.dirname,'../migrations');
 for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort()) sql.exec(readFileSync(resolve(dir,name),'utf8'));
 sql.exec(`UPDATE settings SET owner_uid=${PRIMARY_ADMIN},target_chat_id=-1002222222222,target_thread_id=NULL`);
 class P {
  constructor(readonly query:string,readonly values:SQLInputValue[]=[]){ }
  bind(...v:SQLInputValue[]){return new P(this.query,v);}
  async first<T>(){return (sql.prepare(this.query).get(...this.values)??null) as T|null;}
  async all<T>(){return {results:sql.prepare(this.query).all(...this.values) as T[],success:true};}
  async run(){return {success:true,meta:{changes:Number(sql.prepare(this.query).run(...this.values).changes)}};}
 }
 const db={prepare:(q:string)=>new P(q),batch:async (ps:P[])=>{sql.exec('BEGIN');try{const r=[];for(const p of ps)r.push(await p.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
 return {db,sql};
}
function seed(sql:DatabaseSync,id='r1',date='2026-10-27',certainty='tentative'){
 const item={action:'create',targetId:null,kind:'quiz',course:'graphics',date,time:null,audience:'all',certainty,component:'practical',coverage:'DDA',occurrenceSlots:[],details:'خوارزمية DDA والكود بورقة',evidence:'كوز رسومات',courseEvidence:'رسومات',dateEvidence:'باچر',timeEvidence:null,audienceEvidence:'للكل',occurrenceEvidence:null};
 sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at) VALUES(?,5,'طالب',-1001111111111,1,?,'graphics','quiz',?,?,-1002222222222,1,?,?)`).run(id,JSON.stringify(item),date,certainty,now,now);
}
const update=(uid:number,text:string,id=1):TelegramUpdate=>({update_id:id,message:{message_id:id,from:{id:uid,is_bot:false},chat:{id:uid,type:'private'},text}});
function telegram(fail=false){
 const calls:{method:string;body:Record<string,unknown>}[]=[];
 const client=new TelegramClient('123456:synthetic-token',async (url,init)=>{
  const method=String(url).split('/').at(-1)!;const body=JSON.parse(String(init?.body));calls.push({method,body});
  if(fail && body.chat_id===-1002222222222)return Response.json({ok:false,error_code:429,parameters:{retry_after:2}},{status:429});
  return Response.json({ok:true,result:method==='getMe'?{id:123456,is_bot:true,username:'daaboolbot'}:{message_id:100+calls.length}});
 });return {client,calls};
}
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
describe('daily channel publications and admin authorization',()=>{
 it('does not execute a negated, quoted or explanatory publication request',()=>{
  for(const text of ['لا تنشر كل تبليغات باچر','لا انشر هذا','شلون انشر كل تبليغات باچر','قال انشر هذا','ما اريد تنشر هذا','لا توقف التذكيرات','لا تشغل التذكيرات','لا اعتمد هذا','لا ارفض هذا','اعتمد عليك حبيبي']) expect(adminIntent(text)).toBe(false);
  expect(adminIntent('تكدر تنشر كل تبليغات باچر؟')).toBe(true);
 });
 it('recognizes only configured immutable admin IDs',()=>{
  expect(isAdmin(PRIMARY_ADMIN,PRIMARY_ADMIN)).toBe(true);expect(isAdmin(SECONDARY_ADMIN,PRIMARY_ADMIN)).toBe(true);
  expect(isAdmin(SECONDARY_ADMIN,999)).toBe(false);expect(isAdmin(5,PRIMARY_ADMIN)).toBe(false);expect(isAdmin(undefined,null)).toBe(false);
 });
 it('keeps the retired 18:00 academic digest disabled while manual reports remain available',async()=>{
  const {db,sql}=database();seed(sql);seed(sql,'old','2026-10-26');seed(sql,'other');sql.exec("UPDATE academic_reports SET destination_chat_id=-999 WHERE id='other'");
  expect(await queueDailyAcademicDigest(db,now-1)).toBe(0);expect(await queueDailyAcademicDigest(db,now)).toBe(0);expect(await queueDailyAcademicDigest(db,now+60000)).toBe(0);
  expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='daily_academic'").get()?.n).toBe(0);
  const p={version:1 as const,date:'2026-10-27',chatId:-1002222222222,threadId:null,dueAt:now-60000,expiresAt:now+30*60000,manual:true,
    refs:[{kind:'academic' as const,id:'r1',revision:1}]};
  const out=await dailyPublicationOutgoing(db,p,now);expect(out?.publicationRefs).toEqual([{kind:'academic',id:'r1',revision:1}]);expect(out?.payload.text).toContain('DDA');
  expect(await dailyPublicationOutgoing(db,p,now+30*60000)).toBeNull();
 });
 it('suppresses only successfully delivered identical versions; changed versions remain eligible',async()=>{
  const {db,sql}=database();seed(sql);
  const p={version:1 as const,date:'2026-10-27',chatId:-1002222222222,threadId:null,dueAt:now-60000,expiresAt:now+30*60000,manual:true,
    refs:[{kind:'academic' as const,id:'r1',revision:1}]};
  await recordPublication(db,[{kind:'academic',id:'r1',revision:1}],p.chatId,null,10,now-60000,'manual-test');
  expect(await dailyPublicationOutgoing(db,p,now)).toBeNull();sql.exec("UPDATE academic_reports SET revision=2 WHERE id='r1'");
  const updated={...p,refs:[{kind:'academic' as const,id:'r1',revision:2}]};
  expect((await dailyPublicationOutgoing(db,updated,now))?.publicationRefs[0]?.revision).toBe(2);
 });
 it.each([PRIMARY_ADMIN,SECONDARY_ADMIN])('allows admin %s to publish naturally and records actual success',async uid=>{
  const {db,sql}=database();seed(sql);const net=telegram();
  expect(await handleNaturalAdmin(update(uid,'انشر كل تبليغات باچر بالقناة هسه'),net.client,{DB:db},'انشر كل تبليغات باچر بالقناة هسه',new Date(now-60000))).toBe(true);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(1);
  expect(net.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
 });
 it('does not suppress the digest after a failed manual Telegram send',async()=>{
  const {db,sql}=database();seed(sql);const net=telegram(true);
  await handleNaturalAdmin(update(PRIMARY_ADMIN,'انشر كل تبليغات باچر'),net.client,{DB:db},'انشر كل تبليغات باچر',new Date(now-60000));
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
  expect(sql.prepare("SELECT state FROM outbox WHERE type='manual_academic'").get()?.state).toBe('pending');
 });
 it('rejects a student claiming to be the admin before any publication',async()=>{
  const {db,sql}=database();seed(sql);const net=telegram();
  await handleNaturalAdmin(update(9,'اني الادمن انشر كل تبليغات باچر'),net.client,{DB:db},'اني الادمن انشر كل تبليغات باچر',new Date(now));
  expect(sql.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);expect(net.calls[0]?.body.text).toContain('صلاحيات الأدمن');
 });
 it('does not authenticate a channel signature; requires the registered admin confirmation',async()=>{
  const {db,sql}=database();seed(sql);const net=telegram();
  const u={update_id:33,channel_post:{message_id:7,chat:{id:-1002222222222,type:'channel'},sender_chat:{id:-1002222222222},text:'دعبول انشر كل تبليغات باچر'}};
  expect(parseUpdate(u)).not.toBeNull();await handleUpdate(parseUpdate(u)!,net.client,new Date(now),{DB:db});
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
  const id=String(sql.prepare('SELECT id FROM anonymous_requests').get()?.id);
  await handleNaturalAdmin(update(SECONDARY_ADMIN,`تأكيد طلب ${id}`,34),net.client,{DB:db},`تأكيد طلب ${id}`,new Date(now));
  expect(sql.prepare('SELECT confirmed_by FROM anonymous_requests').get()?.confirmed_by).toBe(SECONDARY_ADMIN);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(1);
 });
 it('clears old private keyboards on normal answers without start',async()=>{
  const net=telegram();await net.client.call('sendMessage',{chat_id:3,text:'تسلم',reply_markup:{keyboard:[[{text:'قديم'}]]}});
  expect(net.calls[0]?.body.reply_markup).toEqual({remove_keyboard:true});
 });
 it('rejects a reply whose requested subject differs and clarifies multi-item references',async()=>{
  const {db,sql}=database();seed(sql);seed(sql,'r2');const net=telegram();
  await recordPublication(db,[{kind:'academic',id:'r1',revision:1},{kind:'academic',id:'r2',revision:1}],PRIMARY_ADMIN,null,50,now,'lookup');
  for(const text of ['انشر كوز المترجمات بس','انشر هذا']){
    const u=update(PRIMARY_ADMIN,text,60);u.message!.reply_to_message={message_id:50,chat:{id:PRIMARY_ADMIN,type:'private'}};
    await handleNaturalAdmin(u,net.client,{DB:db},text,new Date(now));
  }
  expect(net.calls.some(c=>c.body.chat_id===-1002222222222)).toBe(false);
  expect(net.calls.some(c=>String(c.body.text).includes('أكثر من تبليغ'))).toBe(true);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
 });
 it('cannot revive the automatic digest while admin-triggered manual publication remains supported',async()=>{
  const {db,sql}=database();seed(sql);const net=telegram();
  expect(await queueDailyAcademicDigest(db,now)).toBe(0);
  await handleNaturalAdmin(update(PRIMARY_ADMIN,'انشر تبليغات باچر بالقناة هسه'),net.client,{DB:db},'انشر تبليغات باچر بالقناة هسه',new Date(now-60000));
  expect(net.calls.some(c=>c.body.chat_id===-1002222222222)).toBe(true);
  expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='daily_academic'").get()?.n).toBe(0);
 });
 it('records legacy manual sends and suppresses later legacy sends after an aggregate receipt',async()=>{
  const {db,sql}=database();const store=new EventStore(db);const net=telegram();
  const event=await store.createEvent({id:'legacy-test',authorId:5,authorName:'طالب',sourceChatId:-1001111111111,status:'approved',approvedAt:now,
    draft:{...emptyEventDraft(),kind:'quiz',course:'graphics',date:'2026-10-27',audience:'all',details:'DDA'}});
  await recordPublication(db,[{kind:'legacy',id:event.id,revision:event.revision}],-1002222222222,null,90,now,'aggregate');
  await queuePublish(store,event.id,event.revision,now);await dispatchEventJobs(store,net.client,now,{limit:1,types:['publish'],sleep:async()=>{}});
  expect(net.calls).toHaveLength(0);
  sql.exec('DELETE FROM publication_receipts');sql.exec("DELETE FROM outbox WHERE type='publish'");
  await queuePublish(store,event.id,event.revision,now);await dispatchEventJobs(store,net.client,now,{limit:1,types:['publish'],sleep:async()=>{}});
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(1);
 });
 it('continues an unusually large digest without dropping entries or exceeding Telegram limits',async()=>{
  const {db,sql}=database();for(let i=0;i<45;i++)seed(sql,`r${i}`);
  const all:AssistantReference[]=Array.from({length:45},(_,i)=>({kind:'academic',id:`r${i}`,revision:1}));let refs:AssistantReference[]=all,seen:string[]=[];
  for(let page=0;page<10&&refs.length;page++){
    const payload={version:1 as const,date:'2026-10-27',chatId:-1002222222222,threadId:null,dueAt:now-60000,expiresAt:now+60*60000,manual:true,refs};
    const out=await dailyPublicationOutgoing(db,payload,now+page*60000);expect(out).toBeTruthy();expect(out!.payload.text.length).toBeLessThanOrEqual(4096);
    seen.push(...out!.publicationRefs.map(r=>r.id));refs=out!.publicationRemaining;
  }
  expect(seen).toHaveLength(45);expect(new Set(seen).size).toBe(45);expect(refs).toHaveLength(0);
 });
 it('renders all twelve reports using bounded DB reads',async()=>{
  const {db,sql}=database();for(let i=0;i<12;i++)seed(sql,`r${i}`);
  let queries=0;const counted={...db,prepare:(q:string)=>{queries++;return db.prepare(q);}} as D1Database;
  const p={version:1 as const,date:'2026-10-27',chatId:-1002222222222,threadId:null,dueAt:now-60000,expiresAt:now+30*60000,manual:true,
    refs:Array.from({length:12},(_,i)=>({kind:'academic' as const,id:`r${i}`,revision:1}))};
  const out=await dailyPublicationOutgoing(counted,p,now);expect(out?.publicationRefs).toHaveLength(12);expect(queries).toBeLessThan(8);expect(out?.payload.text.length).toBeLessThan(4096);
 });
});
describe('daily source-backed news',()=>{
 it('rejects off-domain links, redirects destinations and stale/future publication dates',()=>{
  expect(safeNewsUrl('https://news.mit.edu.evil.test/x')).toBe(false);expect(safeNewsUrl('http://news.mit.edu/x')).toBe(false);
  const feed=(url:string,date:number)=>`<rss><item><title>Robotics research</title><link>${url}</link><description>${'A research team studied a robot in laboratory conditions. '.repeat(3)}</description><pubDate>${new Date(date).toUTCString()}</pubDate></item></rss>`;
  expect(parseNewsFeed(feed('https://news.mit.edu/2026/test',now),NEWS_FEEDS[0],now)).toHaveLength(1);
  expect(parseNewsFeed(feed('https://evil.test/',now),NEWS_FEEDS[0],now)).toHaveLength(0);
  expect(parseNewsFeed(feed('https://news.mit.edu/2026/test',now-4*86400000),NEWS_FEEDS[0],now)).toHaveLength(0);
  expect(parseNewsFeed(feed('https://news.mit.edu/2026/test',now+86400000),NEWS_FEEDS[0],now)).toHaveLength(0);
 });
 it('keeps the retired legacy news pipeline inert; controlled sources own scheduled news',async()=>{
  const {db,sql}=database();let requests=0;
  const fetcher:typeof fetch=async()=>{requests++;throw Error('Legacy pipeline must not fetch.');};
  const at=now+45*60000;
  await queueDailyNews(db,{DB:db,GROQ_API_KEY:'synthetic-test-only'},at,fetcher);
  await queueDailyNews(db,{DB:db,GROQ_API_KEY:'synthetic-test-only'},at+60000,fetcher);
  expect(requests).toBe(0);
  expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='daily_news'").get()?.n).toBe(0);
  expect(await dailyNewsOutgoing(db,{},at)).toBeNull();
 });
 it('never lets legacy queued news bypass the verified controlled-source scheduler',async()=>{
  const {db}=database();
  const p={text:'خبر علمي',url:'https://news.mit.edu/2026/test',chatId:-1002222222222,threadId:null,generation:1,dueAt:now};
  expect(await dailyNewsOutgoing(db,p,now)).toBeNull();
 });
});

describe('Iraqi notification verbs and verified publication results',()=>{
 it.each(['عفيه بلغ هسه لكل الطلاب بالقناه','بلغ هسه لكل الطلاب بالقناه الامتحانات و الكوزات','بلّغهم بالكوزات','بلغ هذا بالقناة'])('routes %s as an admin operation',text=>expect(adminIntent(text)).toBe(true));
 it.each(['لا تبلغ الطلاب','مو بلغ الطلاب','ما اريد تبلغ الطلاب','شلون بلغ الطلاب','قال بلغ الطلاب','بلغني شنو عدنا'])('does not execute %s',text=>expect(adminIntent(text)).toBe(false));
 it.each([PRIMARY_ADMIN,SECONDARY_ADMIN])('publishes all upcoming requested types for admin %s without Groq',async uid=>{
  const {db,sql}=database();seed(sql,'r1','2026-10-27');seed(sql,'r2','2026-11-03');seed(sql,'old','2026-10-25');seed(sql,'home','2026-10-27');
  const body=JSON.parse(String(sql.prepare("SELECT body_json FROM academic_reports WHERE id='home'").get()?.body_json));body.kind='homework';
  sql.prepare("UPDATE academic_reports SET kind='homework',body_json=? WHERE id='home'").run(JSON.stringify(body));
  const net=telegram();const text='بلغ هسه لكل الطلاب بالقناه الامتحانات و الكوزات';
  await handleNaturalAdmin(update(uid,text,51),net.client,{DB:db,GROQ_API_KEY:'synthetic'},text,new Date(now));
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(2);
  const sent=net.calls.find(c=>c.body.chat_id===-1002222222222)!;
  expect(sent.body.text).toContain('الثلاثاء 3 تشرين الثاني');expect(sent.body.text).not.toContain('الأحد 25 تشرين الأول');expect(sent.body.text).not.toContain('واجب');
  expect(net.calls.at(-1)?.body.text).toContain('نشرته بالقناة');
 });
 it.each([403,429,'missing-message-id'] as const)('never claims a completed send after Telegram returns %s',async failure=>{
  const {db,sql}=database();seed(sql);
  const replies:string[]=[];
  const client=new TelegramClient('123:synthetic',async(url,init)=>{
   const body=JSON.parse(String(init?.body));
   if(body.chat_id===-1002222222222)return failure==='missing-message-id'?Response.json({ok:true,result:true})
    :Response.json({ok:false,error_code:failure,parameters:{retry_after:2}},{status:failure});
   replies.push(body.text);return Response.json({ok:true,result:{message_id:999}});
  });
  await handleNaturalAdmin(update(PRIMARY_ADMIN,'بلغ كل تبليغات باچر',52),client,{DB:db},'بلغ كل تبليغات باچر',new Date(now));
  expect(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
  expect(replies.join(' ')).not.toContain('نشرته بالقناة');
  expect(replies.at(-1)).toContain(failure===403?'تعذر النشر':'بانتظار الإرسال');
 });
 it('dispatches only this publication rather than consuming an older unrelated one',async()=>{
  const {db,sql}=database();seed(sql);const store=new EventStore(db);const net=telegram();
  await store.enqueueJob({id:'older-unrelated',type:'manual_academic',dueAt:now-1000,payload:{version:1,date:'2026-10-27',chatId:-1002222222222,threadId:null,dueAt:now-1000,expiresAt:now+60000,manual:true,refs:[{kind:'academic',id:'r1',revision:1}]}});
  await handleNaturalAdmin(update(PRIMARY_ADMIN,'بلغ كل تبليغات باچر',53),net.client,{DB:db},'بلغ كل تبليغات باچر',new Date(now));
  expect(sql.prepare("SELECT state FROM outbox WHERE id='older-unrelated'").get()?.state).toBe('pending');
  expect(sql.prepare("SELECT state FROM outbox WHERE id='manual-academic:53'").get()?.state).toBe('sent');
 });
 it('reports partial publication honestly when Telegram length requires a continuation',async()=>{
  const {db,sql}=database();for(let i=0;i<45;i++)seed(sql,`many${i}`);const net=telegram();
  await handleNaturalAdmin(update(PRIMARY_ADMIN,'بلغ كل تبليغات باچر',54),net.client,{DB:db},'بلغ كل تبليغات باچر',new Date(now));
  const n=Number(sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n);
  expect(n).toBeGreaterThan(0);expect(n).toBeLessThan(45);
  expect(net.calls.at(-1)?.body.text).toContain('نُشر جزء');
  expect(sql.prepare("SELECT state FROM outbox WHERE id='manual-academic:54:next'").get()?.state).toBe('pending');
 });
});

describe('publication criticism checks delivery records',()=>{
 it('explains that a prose-only acknowledgment is not a sent publication, without invoking AI',async()=>{
  const {db}=database();const net=telegram();const text='ليش تجذب ولك ما رسلت شي لا بالكروب ولا القناة ولا البوت';
  expect(await handleNaturalAdmin(update(PRIMARY_ADMIN,text,61),net.client,{DB:db,GROQ_API_KEY:'synthetic'},text,new Date(now))).toBe(true);
  expect(net.calls).toHaveLength(1);expect(net.calls[0]!.body.text).toContain('ادعاء غير مثبت');
 });
 it('reports pending after a real Telegram failure, and does not repair the service by saying so',async()=>{
  const {db,sql}=database();seed(sql);const net=telegram(true);
  await handleNaturalAdmin(update(PRIMARY_ADMIN,'بلغ كل تبليغات باچر',62),net.client,{DB:db},'بلغ كل تبليغات باچر',new Date(now));
  const text='ليش ما رسلت بالقناة';
  await handleNaturalAdmin(update(PRIMARY_ADMIN,text,63),net.client,{DB:db},text,new Date(now+10000));
  expect(net.calls.at(-1)?.body.text).toContain('بانتظار الإرسال');
  expect(net.calls.at(-1)?.body.text).not.toContain('صارت شغالة');
 });
});

describe('publication explanations are not execution requests',()=>{
 it.each(['ليش تنشر كل الامتحانات','لماذا انشر كل الامتحانات','شوكت تنشر تبليغات باچر','شنو صار ليش انشر هذا','الجملة «بلغ كل الطلاب» مثال','عبارة "انشر كل الامتحانات" للتوضيح'])('does not execute %s',text=>expect(adminIntent(text)).toBe(false));
});

describe('pending publication is authenticated, scoped and short lived',()=>{
 const refs=[{kind:'academic' as const,id:'r1',revision:1},{kind:'academic' as const,id:'r2',revision:1}];
 it('requires the same user, chat and topic; replies must point to the clarification or its source card',async()=>{
  const {db}=database();const scope=publicationScope(PRIMARY_ADMIN,PRIMARY_ADMIN,null);
  await rememberPublication(db,scope,201,refs,now,900,800);
  expect((await pendingPublication(db,scope,202,now+1,900))?.refs).toHaveLength(2);
  expect((await pendingPublication(db,scope,202,now+1,800))?.refs).toHaveLength(2);
  expect(await pendingPublication(db,scope,202,now+1,777)).toBeNull();
  expect(await pendingPublication(db,publicationScope(SECONDARY_ADMIN,PRIMARY_ADMIN,null),202,now+1)).toBeNull();
  expect(await pendingPublication(db,publicationScope(PRIMARY_ADMIN,-1001111111111,null),202,now+1)).toBeNull();
  expect(await pendingPublication(db,publicationScope(PRIMARY_ADMIN,PRIMARY_ADMIN,7),202,now+1)).toBeNull();
  expect(await pendingPublication(db,scope,202,now+5*60000)).toBeNull();
 });
 it('is consumed once, allows replay of the consuming update only, and cannot be renewed by replaying the original question',async()=>{
  const {db}=database();const scope=publicationScope(PRIMARY_ADMIN,PRIMARY_ADMIN,null);
  await rememberPublication(db,scope,211,refs,now);
  expect(await consumePublication(db,scope,211,212,now+1)).toBe(true);
  expect(await consumePublication(db,scope,211,212,now+2)).toBe(true);
  expect(await consumePublication(db,scope,211,213,now+3)).toBe(false);
  await rememberPublication(db,scope,211,refs,now+10000);
  expect(await pendingPublication(db,scope,213,now+10001)).toBeNull();
 });
 it('does not treat an unrelated newer conversation answer as a continuation of a publication request',async()=>{
  const {db,sql}=database();const scope=publicationScope(PRIMARY_ADMIN,PRIMARY_ADMIN,null);
  await rememberPublication(db,scope,221,refs,now);
  sql.prepare("INSERT INTO assistant_turns(id,scope,user_id,chat_id,message_id,question,state,created_at) VALUES('message:222',?,?,?,222,'سؤال جديد','ready',?)").run(scope,PRIMARY_ADMIN,PRIMARY_ADMIN,now+1);
  expect(await pendingPublication(db,scope,223,now+2)).toBeNull();
 });
 it('cancels the pending operation on لا without contacting the channel',async()=>{
  const {db,sql}=database();const net=telegram();const scope=publicationScope(PRIMARY_ADMIN,PRIMARY_ADMIN,null);
  await rememberPublication(db,scope,231,refs,now);
  expect(await handleNaturalAdmin(update(PRIMARY_ADMIN,'لا',232),net.client,{DB:db},'لا',new Date(now+1))).toBe(true);
  expect(net.calls.at(-1)?.body.text).toContain('ألغيت طلب النشر');
  expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='manual_academic'").get()?.n).toBe(0);
 });
});
