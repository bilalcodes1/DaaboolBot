import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { handleUpdate } from '../src/bot';
import { TelegramClient } from '../src/telegram';
import { NluClassifier } from '../src/nlu';
import { EventStore } from '../src/event-store';
import { dispatchEventJobs } from '../src/event-jobs';
import { needsAcademicAnalysis, fitAssistantMessages, getAssistantInlineAnswer } from '../src/assistant-handler';
import { academicReportOutgoing,getAcademicContext,readAcademicReports,parseAcademicAnalysis } from '../src/academic-ai';
import { estimateAssistantRequestTokens } from '../src/assistant-ai';
import { verifiedActorContext } from '../src/assistant-knowledge';
import type { TelegramUpdate } from '../src/types';

const NOW=Date.parse('2026-10-27T22:41:00+03:00');
const PRIMARY=111111111, SECONDARY=222222222, GROUP=-1001111111111;
const TEXT='عدنا بالخميس يوم 5/11 امتحان شبكات';
const analysis={intent:'academic',reply:'',clarification:null,items:[{action:'create',targetId:null,kind:'exam',course:'networks',
  courseEvidence:'شبكات',component:null,date:'2026-11-05',dateEvidence:'يوم 5/11',time:null,timeEvidence:null,audience:null,audienceEvidence:null,
  certainty:'asserted',coverage:'',occurrenceSlots:[],occurrenceEvidence:null,details:'',evidence:TEXT}]};
const databases:DatabaseSync[]=[];
function fixture(){
 const sql=new DatabaseSync(':memory:');databases.push(sql);
 const dir=resolve(import.meta.dirname,'../migrations');for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(resolve(dir,name),'utf8'));
 sql.exec(`UPDATE settings SET owner_uid=${PRIMARY},target_chat_id=-1002222222222,target_thread_id=NULL`);
 let queries=0;
 class P {
  constructor(readonly q:string,readonly v:SQLInputValue[]=[]){ }
  bind(...v:SQLInputValue[]){return new P(this.q,v);}
  admit(){if(++queries>50)throw Error('D1 query budget exceeded');}
  async first<T>(){this.admit();return (sql.prepare(this.q).get(...this.v)??null) as T|null;}
  async all<T>(){this.admit();return {success:true,results:sql.prepare(this.q).all(...this.v) as T[]};}
  async run(){this.admit();return {success:true,meta:{changes:Number(sql.prepare(this.q).run(...this.v).changes)}};}
 }
 const db={prepare:(q:string)=>new P(q),batch:async(ps:P[])=>{sql.exec('BEGIN');try{const out=[];for(const p of ps)out.push(await p.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
 const calls:{method:string;body:Record<string,unknown>}[]=[];
 let model:unknown={reply:'أسمعك 😄',needsAcademicAnalysis:false},providerStatus=200;
 const fetcher:typeof fetch=async(url,init)=>{
  const method=String(url).split('/').at(-1)!;
  if(init?.body instanceof FormData){calls.push({method,body:{chat_id:Number(init.body.get('chat_id'))}});return Response.json({ok:true,result:{message_id:200+calls.length}});}
  const body=JSON.parse(String(init?.body??'{}'));calls.push({method,body});
  if(String(url).includes('api.groq.com'))return providerStatus===200?Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(model)}}],usage:{total_tokens:600}}):Response.json({error:'not persisted synthetic secret'}, {status:providerStatus,headers:{'retry-after':'30'}});
  return Response.json({ok:true,result:method==='getMe'?{id:999,is_bot:true,username:'daaboolbot'}:{message_id:200+calls.length}});
 };
 const telegram=new TelegramClient('123:synthetic-token',fetcher);
 const env={DB:db,GROQ_API_KEY:'synthetic-groq-key'};
 const run=async(id:number,text:string,uid=PRIMARY,reference?:string,referenceId?:number,chatId=GROUP,sourceTime=Date.now(),routing:{threadId?:number;topic?:boolean;replyTopic?:boolean;raw?:boolean}={})=>{
  queries=0;
  const update:TelegramUpdate={update_id:id,message:{message_id:id,from:{id:uid,is_bot:false,first_name:'بلال زامل أحمد'},chat:{id:chatId,type:chatId>0?'private':'supergroup'},date:Math.floor(sourceTime/1000),text:routing.raw?text:'دعبول '+text,
    ...(routing.threadId!==undefined?{message_thread_id:routing.threadId}:{}),...(routing.topic!==undefined?{is_topic_message:routing.topic}:{}),
    ...(reference?{reply_to_message:{message_id:referenceId??id-1,chat:{id:chatId,type:chatId>0?'private' as const:'supergroup' as const},from:{id:999,is_bot:true},text:reference,...(routing.replyTopic!==undefined?{is_topic_message:routing.replyTopic}:{})}}:{})}};
  await handleUpdate(update,telegram,new Date(Date.now()),env,new NluClassifier(),fetcher);
 };
 return {sql,db,calls,run,telegram,setModel:(value:unknown)=>{model=value;},setStatus:(status:number)=>{providerStatus=status;},queries:()=>queries};
}
afterEach(()=>{vi.restoreAllMocks();for(const db of databases.splice(0))db.close();});
describe('the actual screenshot conversation',()=>{
 it.each(['','   '])('accepts the source-backed exam when model details are blank (%j), without inventing facts',details=>{
  const parsed=parseAcademicAnalysis({...analysis,items:analysis.items.map(i=>({...i,details}))},TEXT,new Date(NOW));
  expect(parsed?.items[0]).toMatchObject({date:'2026-11-05',course:'networks',details:TEXT,audience:null,time:null});
  expect(parseAcademicAnalysis({...analysis,items:analysis.items.map(i=>({...i,date:'2026-11-06'}))},TEXT,new Date(NOW))).toBeNull();
  expect(parseAcademicAnalysis({...analysis,items:analysis.items.map(i=>({...i,evidence:'invented'}))},TEXT,new Date(NOW))).toBeNull();
 });
 it('saves the exam once, confirms the real source and records generation and delivery separately',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();f.setModel(analysis);
  await f.run(1,TEXT);await f.run(1,TEXT);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(1);
  expect(f.calls.some(c=>c.body.chat_id===-1002222222222)).toBe(false);
  const row=f.sql.prepare('SELECT diagnostic_json,completed_at,delivered_at FROM assistant_turns').get()!;
  expect(JSON.parse(String(row.diagnostic_json))).toMatchObject({reason:'ready',modelMs:0,waitMs:0});
  expect(row.completed_at).toBe(NOW);expect(row.delivered_at).toBe(NOW);
 });
 it('answers counts, subjects, teachers, roster names and both admin identities without a model call',async()=>{
  let time=NOW;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();const start=performance.now();
  // Independent human turns with an available Telegram delivery slot; pacing
  // itself is exercised separately by the event-store delivery tests.
  const run:typeof f.run=async(...args)=>{await f.run(...args);time+=10000;};
  await run(11,'كم طالب احنا');
  await run(12,'عفيه كم ماده عدنا وشنو اسم المواد وشنو اسماء الدكاتره');
  await run(13,'تعرف طالب تجريبي');
  await run(14,'هممم زين شنو اسماء طلابنا ؟');
  await run(15,'معليك يمي خل نكمل، المفروض هسه تعرفني اني ادمن لو طالب ز');
  await run(16,'اني مو ادمن ؟',SECONDARY);
  await run(17,'اني ادمن ؟',123);
  expect(performance.now()-start).toBeLessThan(2000);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
  const replies=f.calls.filter(c=>c.method==='sendMessage').map(c=>String(c.body.text));
  expect(replies[0]).toContain('41');expect(replies[1]).toContain('6 مواد');expect(replies[1]).toContain('د. فؤاد سليم');
  expect(replies[2]).toContain('طالب تجريبي');expect(f.calls.some(c=>c.method==='sendDocument')).toBe(true);
  expect(replies[3]).toContain('حسابك مسجّل عندي أدمن');expect(replies[4]).toContain('حسابك مسجّل عندي أدمن');
  expect(replies[5]).toContain('مو من حسابَي الأدمن');expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
 });
 it('uses the referenced criticism/sarcasm context, bounds social tokens and removes generic follow-up offers',async()=>{
  let time=NOW;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();
  const previous='معذرة، ما أگدر أشارك معلومات شخصية عن الطالب، حتى لو كان الاسم معروف.';
  f.setModel({reply:'عاشت إيدك، شرف كبير!',needsAcademicAnalysis:false});await f.run(21,'هسه صرت شريف',PRIMARY,previous);
  const request=f.calls.find(c=>c.method==='completions')!.body;
  const messages=request.messages as {role:'system'|'user'|'assistant';content:string}[];
  expect(messages.some(m=>m.content.includes(previous))).toBe(true);expect(messages.some(m=>m.content.includes('SPEECH_ACT=sarcasm'))).toBe(true);
  expect(messages.some(m=>m.content.includes('VERIFIED_ACTOR_ROLE=admin'))).toBe(true);
  expect(JSON.stringify(messages)).not.toContain(String(PRIMARY));
  expect(estimateAssistantRequestTokens(messages,{maxTokens:256,schema:(request.response_format as any).json_schema.schema,conversational:true})).toBeLessThan(2600);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).not.toContain('عاشت');
  time+=10000;f.setModel({reply:'عاشت إيدك، إذا تحتاج شي ثاني أنا حاضر.',needsAcademicAnalysis:false});await f.run(22,'والله يراد لك شغل بعدك تجفص');
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('أصحح');
  time+=10000;f.setModel({reply:'فديتك، شنو تحب نسولف؟',needsAcademicAnalysis:false});await f.run(23,'فديتك');
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toBe('فديتك');
 });
 it('keeps a busy request pending, sends exactly one waiting notice and finishes once after recovery',async()=>{
  let time=NOW;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();f.setModel(analysis);f.setStatus(429);
  await expect(f.run(31,TEXT)).rejects.toMatchObject({name:'AssistantAiRetryError'});
  time+=1000;await expect(f.run(31,TEXT)).rejects.toMatchObject({name:'AssistantAiRetryError'});
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='sendMessage')[0]!.body.text).toContain('ما أعتبره محفوظ');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  expect(JSON.parse(String(f.sql.prepare('SELECT diagnostic_json FROM assistant_turns').get()?.diagnostic_json)).reason).toBe('provider_capacity');
  time+=61000;f.setStatus(200);await f.run(31,TEXT);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(2);
  expect(f.sql.prepare('SELECT requests FROM assistant_user_limits').get()?.requests).toBe(1);
  expect(JSON.parse(String(f.sql.prepare('SELECT diagnostic_json FROM assistant_turns').get()?.diagnostic_json)).waitMs).toBeGreaterThanOrEqual(61000);
  expect(JSON.parse(String(f.sql.prepare('SELECT diagnostic_json FROM assistant_turns').get()?.diagnostic_json)).waitReason).toBe('provider_capacity');
 });
 it('reports invalid evidence as a validation failure rather than a successful save',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();f.setModel({...analysis,items:analysis.items.map(i=>({...i,date:'2026-11-06'}))});
  await f.run(41,TEXT);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  expect(JSON.parse(String(f.sql.prepare('SELECT diagnostic_json FROM assistant_turns').get()?.diagnostic_json)).reason).toBe('invalid_evidence');
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('تدقيق النص أو الموعد');
 });
 it('delivers the current answer immediately instead of consuming an older unrelated reply',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();
  f.sql.prepare("INSERT INTO assistant_turns(id,scope,user_id,chat_id,message_id,question,reply_html,state,created_at) VALUES('message:old','123:0:123',123,123,1,'قديم','جواب شخص آخر','ready',?)").run(NOW-10000);
  f.sql.prepare("INSERT INTO outbox(id,type,payload_json,due_at) VALUES('assistant-reply:message:old:0','assistant_reply',?,?)").run(JSON.stringify({turnId:'message:old',page:0}),NOW-10000);
  await f.run(44,'كم طالب احنا');
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='sendMessage')[0]!.body.text).toContain('41');
  expect(f.sql.prepare("SELECT state FROM outbox WHERE id='assistant-reply:message:old:0'").get()?.state).toBe('pending');
  await dispatchEventJobs(new EventStore(f.db),f.telegram,NOW,{limit:1,types:['assistant_reply']});
  expect(f.sql.prepare("SELECT diagnostic_json,completed_at,delivered_at FROM assistant_turns WHERE id='message:old'").get())
    .toEqual({diagnostic_json:null,completed_at:null,delivered_at:NOW});
 });
 it('keeps an interrupted provider pending and records only sanitized status and timing',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();f.setStatus(503);
  await expect(f.run(45,TEXT)).rejects.toMatchObject({name:'AssistantAiRetryError'});
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('الاتصال بخدمة الذكاء متعثر');
  const stored=String(f.sql.prepare('SELECT diagnostic_json FROM assistant_turns').get()?.diagnostic_json);
  expect(JSON.parse(stored)).toMatchObject({reason:'provider_error',status:503});
  expect(stored).not.toMatch(/synthetic|not persisted|secret|شبكات/);
  expect(f.sql.prepare('SELECT state FROM assistant_turns').get()?.state).toBe('processing');
 });
 it('explains provider authentication failure without retries or leaking the provider response',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();f.setStatus(401);
  await f.run(46,TEXT);
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='sendMessage')[0]!.body.text).toContain('ربط خدمة الذكاء');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  expect(JSON.parse(String(f.sql.prepare('SELECT diagnostic_json FROM assistant_turns').get()?.diagnostic_json))).toMatchObject({reason:'provider_auth',status:401});
 });
 it('does not use a course mention or عدنا alone as a creation request, and retains verified authority under trimming',()=>{
  for(const text of ['كم مادة عدنا','شنو شبكات','اشرحلي معمارية','عدنا','رسومات'])expect(needsAcademicAnalysis(text)).toBe(false);
  expect(needsAcademicAnalysis(TEXT)).toBe(true);
  const messages=fitAssistantMessages('system',verifiedActorContext(PRIMARY,PRIMARY)+'\n'+'م'.repeat(15000),[{role:'user',content:'آخر سؤال'},{role:'assistant',content:'آخر جواب'}],'سؤال حالي',{maxTokens:700});
  expect(messages[0]!.content).toContain('VERIFIED_ACTOR_ROLE=admin');expect(messages.some(m=>m.content==='آخر جواب')).toBe(true);
 });
 it('handles an inline roster request as an available file without calling the model or pretending to send it',async()=>{
  const f=fixture();
  const answer=await getAssistantInlineAnswer('هممم زين شنو اسماء طلابنا ؟',PRIMARY,{DB:f.db,GROQ_API_KEY:'synthetic-key'},new Date(NOW));
  expect(answer).toContain('ملف أسماء الدفعة موجود');expect(answer).toContain('بالخاص');expect(f.calls).toHaveLength(0);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
 });
});

describe('28 October follow-up screenshots: linked group and mixed date order',()=>{
 const today=new Date('2026-10-28T17:22:00+03:00');
 function model(text:string,overrides:Record<string,unknown>={}) {
  return {...analysis,items:[{...analysis.items[0],date:null,dateEvidence:null,details:'',evidence:text,...overrides}]};
 }
 it.each([
  ['عدنا يوم 11/5 امتحان شبكات','2026-11-05','11/5','2026-11-05'],
  ['عدنا يوم الثلاثاء المصادف يوم 11/3 امتحان مادة تطبيقات الموبايل','2026-03-11','يوم 11/3','2026-11-03'],
  ['عدنا يوم الثلاثاء المصادف 3/11 امتحان مادة تطبيقات الموبايل',null,'يوم الثلاثاء المصادف 3/11','2026-11-03'],
  ['يوم الثلاثاء 11/3 امتحان مادة تطبيقات الموبايل',null,null,'2026-11-03'],
  ['الثلاثاء 11/3 امتحان مادة تطبيقات الموبايل للكل','2026-03-11','11/3','2026-11-03'],
 ])('grounds %s even when model dates are reversed or omitted',(text,date,dateEvidence,expected)=>{
  const mobile=text.includes('الموبايل');
  const raw=model(text,{course:mobile?'mobile':'networks',courseEvidence:mobile?'تطبيقات الموبايل':'شبكات',date,dateEvidence,
    audience:text.includes('للكل')?'all':null,audienceEvidence:text.includes('للكل')?'للـكل':null});
  const before=JSON.stringify(raw);
  const parsed=parseAcademicAnalysis(raw,text,today);
  expect(parsed?.items[0]).toMatchObject({date:expected,details:text});
  if(text.includes('للكل'))expect(parsed?.items[0]).toMatchObject({audience:'all',audienceEvidence:'للكل'});
  expect(JSON.stringify(raw)).toBe(before);
 });
 it('still refuses invented dates, literal content and conflicting explicit years',()=>{
  const text='عدنا يوم الخميس 5/11 امتحان شبكات';
  expect(parseAcademicAnalysis(model(text,{date:'2026-11-06',dateEvidence:'5/11'}),text,today)).toBeNull();
  expect(parseAcademicAnalysis(model(text,{details:'كل الفصول داخلة'}),text,today)).toBeNull();
  const conflict='الثلاثاء 11/3/2026 امتحان شبكات';
  expect(parseAcademicAnalysis(model(conflict,{date:null,dateEvidence:'الثلاثاء 11/3/2026'}),conflict,today)).toBeNull();
 });
 it('does not transfer a whole-message date to an unrelated item',()=>{
  const first='الخميس 5/11 امتحان شبكات',second='وكوز رسومات موعده غير محدد';
  const parsed=parseAcademicAnalysis({...analysis,items:[{...analysis.items[0],date:null,dateEvidence:null,details:first,evidence:first},
   {...analysis.items[0],kind:'quiz',course:'graphics',courseEvidence:'رسومات',date:null,dateEvidence:null,details:second,evidence:second}]},first+' '+second,today);
  expect(parsed?.items[0]?.date).toBe('2026-11-05');expect(parsed?.items[1]?.date).toBeNull();
 });
 it('saves from the linked discussion, lists it locally, and reports actual state instead of narrative guesses',async()=>{
  let time=today.getTime();vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();
  const text='عدنا يوم الخميس بتاريخ 5/11 امتحان بمادة الشبكات';
  f.setModel(model(text,{courseEvidence:'الشبكات',date:'2026-11-05',dateEvidence:'5/11'}));
  await f.run(501,text);time+=10000;
  await f.run(502,'شنو عدنا امتحانات ؟');time+=10000;
  await f.run(503,'سويلي تقرير كامل شنو صار وياك');time+=10000;
  const replies=f.calls.filter(c=>c.method==='sendMessage').map(c=>String(c.body.text));
  expect(replies).toHaveLength(3);
  expect(replies[0]).toContain('حفظت');
  for(const answer of replies.slice(1)) {expect(answer).toContain('2026-11-05');expect(answer).toContain('شبكات');expect(answer).not.toContain('ما عندي');expect(answer).not.toContain('ما أگدر أكمل');}
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(1);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
  await f.run(504,'من اريد ابلغك بامتحان شنو انطيك ؟ انطيني مثال');
  expect(String(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text)).toContain('المثال للتوضيح فقط');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
 });
 it('does not expose destination reports to an unrelated group or after a channel change',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(today.getTime());const f=fixture();f.setModel(analysis);await f.run(511,TEXT);
  const {readAcademicReports}=await import('../src/academic-ai');
  expect(await readAcademicReports(f.db,'امتحانات',today,{chatId:GROUP})).toHaveLength(1);
  expect(await readAcademicReports(f.db,'امتحانات',today,{chatId:-100987654321})).toHaveLength(0);
  f.sql.exec('UPDATE settings SET target_chat_id=-100987654321');
  expect(await readAcademicReports(f.db,'امتحانات',today,{chatId:GROUP})).toHaveLength(0);
 });
});

describe('empty-item provider recovery stays within literal announcements',()=>{
 const now=new Date('2026-10-28T17:22:00+03:00');
 const empty={intent:'academic',reply:'ممكن توضح إذا تقصد مارس أو نوفمبر؟',clarification:null,items:[]};
 it.each(['عدنا يوم الثلاثاء المصادف يوم 11/3 امتحان مادة تطبيقات الموبايل','عدنا يوم 11/5 امتحان شبكات','الثلاثاء 11/3 امتحان مادة تطبيقات الموبايل للكل'])('recovers a bare dated declaration: %s',text=>{
  const parsed=parseAcademicAnalysis(empty,text,now);
  expect(parsed?.items).toHaveLength(1);expect(parsed?.reply).toBe('');
  expect(parsed?.items[0]?.date).toBe(text.includes('شبكات')?'2026-11-05':'2026-11-03');
 });
 it.each([
  'عدنا يوم الثلاثاء 11/3 امتحان موبايل؟','مثلا عدنا يوم الثلاثاء 11/3 امتحان موبايل',
  'لو عدنا يوم الثلاثاء 11/3 امتحان موبايل','ما عدنا يوم الثلاثاء 11/3 امتحان موبايل',
  'عدنا يوم الثلاثاء 11/3 امتحان موبايل ملغي','عدنا يوم الثلاثاء 11/3 امتحان موبايل محتمل',
  'عدنا يوم الثلاثاء 11/3 امتحان موبايل وواجب شبكات','عدنا يوم الثلاثاء 11/3 امتحان موبايل الساعة 8 صباحا',
  'عدنا يوم الثلاثاء 11/3 امتحان موبايل بس تأجل','عدنا يوم الثلاثاء 11/3 امتحان موبايل الفصل الثاني داخل',
  'عدنا يوم الأربعاء 11/3 امتحان موبايل','عدنا امتحان موبايل',
 ])('leaves questions, negation, extra details and uncertainty for the model: %s',text=>{
  expect(parseAcademicAnalysis(empty,text,now)?.items).toHaveLength(0);
 });
 it('does not recover chat/lookup or an invalid provider response',()=>{
  const text='عدنا يوم الثلاثاء 11/3 امتحان موبايل';
  for(const intent of ['chat','lookup'])expect(parseAcademicAnalysis({...empty,intent},text,now)?.items).toHaveLength(0);
  expect(parseAcademicAnalysis(null,text,now)).toBeNull();
 });
 it('checks the weekday in the actual source even if model dateEvidence omits it',()=>{
  const text='عدنا يوم الأربعاء 5/11 امتحان شبكات';
  expect(parseAcademicAnalysis({...analysis,items:[{...analysis.items[0],evidence:text,details:text,dateEvidence:'5/11'}]},text,now)).toBeNull();
 });
 it('persists a recovered provider-empty item once and looks it up in the linked group',async()=>{
  let time=now.getTime();vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();f.setModel(empty);
  const text='عدنا يوم الثلاثاء المصادف يوم 11/3 امتحان مادة تطبيقات الموبايل';
  await f.run(601,text);time+=10000;await f.run(602,'شنو عدنا امتحانات ؟');
  expect(f.sql.prepare('SELECT event_date,course FROM academic_reports').get()).toEqual({event_date:'2026-11-03',course:'mobile'});
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('2026-11-03');
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(1);
 });
});

describe('19:14–19:20 screenshot sequence: publish is an authenticated application action',()=>{
 it('lists all four saved assessments locally with spelling/lead-ins, publishes the replied list and proves delivery',async()=>{
  let time=Date.parse('2026-10-28T19:15:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();
  const cases=[['عدنا يوم الثلاثاء ١١/٣ امتحان مادة تطبيقات الموبايل سجله عندك','mobile','تطبيقات الموبايل','2026-11-03','١١/٣','exam'],
    ['عدنا يوم الخميس 11/5 امتحان مادة الشبكات','networks','الشبكات','2026-11-05','11/5','exam'],
    ['عدنا باجر الخميس 29/10 كوز مادة الرسومات','graphics','الرسومات','2026-10-29','29/10','quiz'],
    ['عدنا باجر الخميس 29/10 كوز بمادة المعمارية','architecture','المعمارية','2026-10-29','29/10','quiz']] as const;
  for(const [i,[text,course,courseEvidence,date,dateEvidence,kind]] of cases.entries()){
   f.setModel({...analysis,items:[{...analysis.items[0],course,courseEvidence,date,dateEvidence,kind,evidence:text,details:text}]});
   await f.run(700+i,text);time+=61000;
  }
  const originalCalls=f.calls.filter(c=>c.method==='completions').length;
  await f.run(710,'هسه اعرض لي كل لامتحانات و الكوزات');time+=10000;
  const card=f.calls.filter(c=>c.method==='sendMessage').at(-1)!;
  for(const date of ['2026-10-29','2026-11-03','2026-11-05'])expect(card.body.text).toContain(date);
  expect(card.body.text).not.toMatch(/\((?:graphics|architecture|mobile|networks)\)/);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(originalCalls);
  const messageId=Number(f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:710:0'").get()?.message_id);
  await f.run(711,'عفيه بلغ هسه لكل الطلاب بالقناه',PRIMARY,String(card.body.text),messageId);time+=10000;
  expect(f.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(originalCalls);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(4);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('نشرته بالقناة');
  await f.run(712,'بلغ هسه لكل الطلاب بالقناه الامتحانات و الكوزات');
  expect(f.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(4);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('منشورات بالقناة من قبل');
 });
 it('blocks fake model acknowledgments of publication and service repairs',async()=>{
  let time=NOW;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();
  f.setModel({reply:'تم إعلام جميع الطلاب بالرسالة المطلوبة عبر القناة.',needsAcademicAnalysis:false});
  await f.run(720,'يعني وصلهم كلامك ؟');time+=10000;
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('ما عندي تأكيد');
  f.setModel({reply:'تم تحديث الحالة، الخدمة صارت شغالة الآن، جرب مرة ثانية.',needsAcademicAnalysis:false});
  await f.run(721,'يراد لك تحديث هنا');
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('ما أگدر أحدّث برمجتي');
  expect(f.calls.some(c=>c.body.chat_id===-1002222222222)).toBe(false);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
 });
 it('rejects a student publication command without calling the model or creating a report',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();
  await f.run(730,'بلغ هسه لكل الطلاب بالقناه الامتحانات و الكوزات',123);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('صلاحيات الأدمن');
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='manual_academic'").get()?.n).toBe(0);
 });
});

describe('record cleanup and cross-surface editing from ordinary speech',()=>{
 it('lets the second admin edit an existing group record from private, then the first admin edit it in the group',async()=>{
  let time=Date.parse('2026-10-28T19:24:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();
  const source='عدنا يوم الخميس 5/11 امتحان مادة الشبكات';
  f.setModel({...analysis,items:[{...analysis.items[0],evidence:source,details:'امتحان مادة الشبكات',courseEvidence:'الشبكات',dateEvidence:'5/11'}]});
  await f.run(800,source);time+=61000;
  await f.run(801,'عدل موعد امتحان الشبكات وخليه السبت 7/11',SECONDARY,undefined,undefined,SECONDARY);time+=61000;
  expect(f.sql.prepare("SELECT revision,event_date,author_id FROM academic_reports WHERE id='ar-800-0'").get()).toEqual({revision:2,event_date:'2026-11-07',author_id:PRIMARY});
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(1);
  await f.run(802,'عدل موعد امتحان الشبكات وخليه الأحد 8/11');time+=61000;
  expect(f.sql.prepare("SELECT revision,event_date FROM academic_reports WHERE id='ar-800-0'").get()).toEqual({revision:3,event_date:'2026-11-08'});
  const repeat='عدنا الأحد 8/11 امتحان مادة الشبكات';
  f.setModel({...analysis,items:[{...analysis.items[0],evidence:repeat,details:'امتحان مادة الشبكات',courseEvidence:'الشبكات',date:'2026-11-08',dateEvidence:'8/11'}]});
  await f.run(803,repeat);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
 });
 it('refuses a student editing another student’s record before asking the model to perform an action',async()=>{
  let time=Date.parse('2026-10-28T19:24:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();f.setModel(analysis);
  await f.run(810,TEXT);time+=61000;
  await f.run(811,'عدل موعد امتحان الشبكات وخليه السبت 7/11',123,undefined,undefined,123);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('صاحبه أو لحسابَي الأدمن');
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(1);
  expect(f.sql.prepare('SELECT revision FROM academic_reports').get()?.revision).toBe(1);
 });
 it('does not cancel every referenced record when asked to clean duplicates from a multi-record list',async()=>{
  let time=Date.parse('2026-10-28T19:24:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();f.setModel(analysis);
  await f.run(820,TEXT);time+=61000;
  // Historical duplicate from the pre-deduplication schema, with harmless wording variation.
  f.sql.exec(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at)
   SELECT 'ar-821-0',author_id,author_name,source_chat_id,source_message_id,json_set(body_json,'$.details','امتحان مادة الشبكات'),course,kind,event_date,certainty,destination_chat_id,821,created_at+1,updated_at+1 FROM academic_reports WHERE id='ar-820-0'`);
  await f.run(822,'احذف التبليغات المكررة',PRIMARY,undefined,undefined,PRIMARY);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('شلت 1 نسخة مكررة');
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='active'").get()?.n).toBe(1);
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='cancelled'").get()?.n).toBe(0);
 });
});

describe('bounded duplicate cleanup on a free Worker invocation',()=>{
 it('cleans six duplicate pairs from private within the real 50-query budget',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(NOW);const f=fixture();
  for(let index=0;index<12;index++){
   const date=`2026-11-${String(1+Math.floor(index/2)).padStart(2,'0')}`;
   const body={...analysis.items[0],details:'امتحان مادة الشبكات',date,dateEvidence:date};
   f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at)
    VALUES(?,?,'طالب',?,1,?,'networks','exam',?,'asserted',?,?,?,?)`).run(`ar-${900+index}-0`,PRIMARY,GROUP,JSON.stringify(body),date,-1002222222222,900+index,NOW+index,NOW+index);
  }
  await f.run(920,'احذف التبليغات المكررة',PRIMARY,undefined,undefined,PRIMARY);
  expect(f.queries()).toBeLessThanOrEqual(50);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(6);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_merges').get()?.n).toBe(6);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
 });
});

describe('AI-assisted content edits retain the verified existing target',()=>{
 it('changes required reading in place from private without inventing another event or changing its date',async()=>{
  let time=NOW;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=fixture();f.setModel(analysis);
  await f.run(930,TEXT);time+=61000;
  const text='عدل المشمول بامتحان الشبكات وخليه المحاضرة الأولى والثانية';
  f.setModel({...analysis,items:[{...analysis.items[0],action:'update',targetId:null,courseEvidence:'الشبكات',date:null,dateEvidence:null,
   coverage:'المحاضرة الأولى والثانية',details:text,evidence:text}]});
  await f.run(931,text,PRIMARY,undefined,undefined,PRIMARY);
  const row=f.sql.prepare("SELECT revision,event_date,body_json FROM academic_reports WHERE id='ar-930-0'").get()!;
  expect(row.revision).toBe(2);expect(row.event_date).toBe('2026-11-05');
  expect(JSON.parse(String(row.body_json)).coverage).toBe('المحاضرة الأولى والثانية');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
  const request=f.calls.filter(c=>c.method==='completions').at(-1)!;
  expect(JSON.stringify(request.body.messages)).toContain('VERIFIED_EDIT_TARGET');
 });
});

describe('29 October 03:38 screenshot language and publication context',()=>{
 function seeded(){const f=fixture();
  for(const [index,[course,kind,date,details]] of [
   ['architecture','quiz','2026-10-29','كوز بمادة المعمارية'],['graphics','quiz','2026-10-29','كوز مادة الرسومات'],
   ['mobile','exam','2026-11-03','امتحان مادة تطبيقات الموبايل'],['networks','exam','2026-11-05','امتحان بمادة الشبكات'],
  ].entries()){
   const item={...analysis.items[0],course,kind,date,details};
   f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at)
    VALUES(?,?,'طالب',?,1,?,?,?,?,'asserted',?,?,?,?)`).run(`ar-${1000+index}-0`,PRIMARY,GROUP,JSON.stringify(item),course!,kind!,date!,-1002222222222,1000+index,Date.now(),Date.now());
  }return f;}
 it.each(['شوفني التبليغات كامله','شوفي التبليغات كاملة','الامتحانات والكوزات','التبليغات كاملة','شوف التبليغات كامله'])('reads %s locally even with no provider capacity',async text=>{
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-29T03:38:00+03:00'));const f=seeded();f.setStatus(429);
  await f.run(1010,text,PRIMARY,undefined,undefined,PRIMARY);
  const answer=f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text;
  for(const date of ['2026-10-29','2026-11-03','2026-11-05'])expect(answer).toContain(date);
  expect(answer).not.toMatch(/quiz|exam|ما عندي تقارير/);expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
 });
 it('publishes the last delivered private list when the admin then says بلغ الطلاب without a reply',async()=>{
  let time=Date.parse('2026-10-29T03:38:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();f.setStatus(429);
  await f.run(1020,'شوفني التبليغات كامله',PRIMARY,undefined,undefined,PRIMARY);time+=10000;
  await f.run(1021,'بلغ الطلاب',PRIMARY,undefined,undefined,PRIMARY);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(4);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
  expect(f.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
 });
 it.each([true,false])('understands بكل الامتحانات والكوزات with reply=%s and publishes all matching current records',async hasReply=>{
  let time=Date.parse('2026-10-29T03:38:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();f.setStatus(429);
  await f.run(1030,'الامتحانات والكوزات',PRIMARY,undefined,undefined,PRIMARY);time+=10000;
  const row=f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:1030:0'").get()!;
  await f.run(1031,'بلغ الطلاب بكل الامتحانات والكوزات هسه بالقناه',PRIMARY,hasReply?'قائمة الامتحانات والكوزات':undefined,hasReply?Number(row.message_id):undefined,PRIMARY);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(4);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
 });
 it('remembers an ambiguous publication, does not guess on اي, and finishes on معمارية without AI or duplication',async()=>{
  let time=Date.parse('2026-10-29T03:38:00+03:00');vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();f.setStatus(429);
  await f.run(1040,'الامتحانات والكوزات',PRIMARY,undefined,undefined,PRIMARY);time+=10000;
  const row=f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:1040:0'").get()!;
  await f.run(1041,'انشر هذا',PRIMARY,'قائمة',Number(row.message_id),PRIMARY);time+=10000;
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM admin_publication_context').get()?.n).toBe(1);
  await f.run(1042,'اي',PRIMARY,undefined,undefined,PRIMARY);time+=10000;
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
  await f.run(1043,'معماريه',PRIMARY,undefined,undefined,PRIMARY);time+=10000;
  await f.run(1043,'معماريه',PRIMARY,undefined,undefined,PRIMARY);
  expect(f.sql.prepare('SELECT record_id FROM publication_receipts').get()?.record_id).toBe('ar-1000-0');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(1);
  expect(f.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='completions')).toHaveLength(0);
 });
});

describe('29 October 04:48 bulk audience edit screenshot',()=>{
 const bulkText='اريد تعدل التبليغ لكل المواد وتكتب للمجوعتين A و B';
 const bulkNow=Date.parse('2026-10-29T04:48:00+03:00');
 function seeded(count=4){const f=fixture();
  for(let i=0;i<count;i++){
   const [course,kind,date]=count===4?([
    ['architecture','quiz','2026-10-29'],['graphics','quiz','2026-10-29'],['mobile','exam','2026-11-03'],['networks','exam','2026-11-05'],
   ][i]!):['networks','exam',`2026-11-${String(i+1).padStart(2,'0')}`];
   const item={...analysis.items[0],course,kind,date,time:'09:00',coverage:'المحاضرة الأولى والثانية',details:'تبليغ المصدر الأصلي'};
   f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at)
    VALUES(?,?,'طالب',?,1,?,?,?,?,'asserted',?,?,?,?)`).run(`ar-${2000+i}-0`,PRIMARY,GROUP,JSON.stringify(item),course!,kind!,date!,-1002222222222,2000+i,bulkNow,bulkNow);
  }f.setStatus(429);return f;
 }
 it.each([[PRIMARY,PRIMARY],[PRIMARY,GROUP],[SECONDARY,SECONDARY],[SECONDARY,GROUP]])('edits all four existing records for admin %s in chat %s without Groq or broadcasting',async(uid,chat)=>{
  let time=bulkNow;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();const started=performance.now();
  await f.run(2100,bulkText,uid,undefined,undefined,chat);
  expect(performance.now()-started).toBeLessThan(2000);expect(f.queries()).toBeLessThanOrEqual(50);
  const rows=f.sql.prepare('SELECT * FROM academic_reports ORDER BY id').all();expect(rows).toHaveLength(4);
  expect(rows.map(r=>r.event_date)).toEqual(['2026-10-29','2026-10-29','2026-11-03','2026-11-05']);
  for(const row of rows){expect(row.audience).toBe('all');expect(row.revision).toBe(2);const body=JSON.parse(String(row.body_json));expect(body.coverage).toBe('المحاضرة الأولى والثانية');expect(body.time).toBe('09:00');expect(row.author_id).toBe(PRIMARY);}
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(f.calls.find(c=>c.method==='sendMessage')!.body.text).toContain('عدّلت 4');
  const links=JSON.parse(String(f.sql.prepare("SELECT report_ids_json FROM assistant_turns WHERE id='message:2100'").get()?.report_ids_json));
  expect(links.references).toHaveLength(4);expect(links.references.every((r:{revision:number})=>r.revision===2)).toBe(true);
  expect(f.calls.some(c=>c.method==='completions'||c.body.chat_id===-1002222222222)).toBe(false);
  time+=10000;await f.run(2100,bulkText,uid,undefined,undefined,chat);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n).toBe(4);
  time+=10000;await f.run(2101,bulkText,uid,undefined,undefined,chat);
  expect(f.sql.prepare('SELECT MAX(revision) AS n FROM academic_reports').get()?.n).toBe(2);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('من قبل');
 });
 it('keeps twelve local edits and their delivered answer within the free D1 query budget',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(bulkNow);const f=seeded(12);await f.run(2200,bulkText,PRIMARY,undefined,undefined,PRIMARY);
  expect(f.queries()).toBeLessThanOrEqual(50);expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE audience='all' AND revision=2").get()?.n).toBe(12);
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(f.calls.find(c=>c.method==='sendMessage')!.body.text).toContain('عدّلت 12');
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
 it('refuses an oversized batch and student permissions without partial updates or AI fallback',async()=>{
  let time=bulkNow;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded(13);
  await f.run(2300,bulkText,PRIMARY,undefined,undefined,PRIMARY);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('12');
  time+=10000;await f.run(2301,bulkText,123,undefined,undefined,123);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('صلاحيات');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n).toBe(0);
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
 it('asks about unsupported mixed changes without creating an announcement',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(bulkNow);const f=seeded();
  await f.run(2400,'عدل كل التبليغات للمجموعتين وخلي الامتحان السبت 7/11');
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('تقصد');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n).toBe(0);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(4);
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
});

describe('expired announcements stay out of ordinary lists and model grounding',()=>{
 const before=Date.parse('2026-10-29T23:59:59+03:00'),after=before+1000;
 function seeded(){const f=fixture();
  for(const [i,date,details] of [[0,'2026-10-28','expired-oct28'],[1,'2026-10-29','thursday-oct29'],[2,'2026-11-03','future-nov03'],[3,null,'undated-needs-clarification']] as const){
   const item={...analysis.items[0],date,details};
   f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at)
    VALUES(?,?,'طالب',?,1,?,'networks','exam',?,'asserted',?,?,?,?)`).run(`ar-${3000+i}-0`,PRIMARY,GROUP,JSON.stringify(item),date,-1002222222222,3000+i,before-10000,before+10000-i);
  }return f;
 }
 it('expires Thursday at Baghdad midnight in both lists and model input without deleting saved records',async()=>{
  const f=seeded();
  const upcoming=async(now:number)=>(await readAcademicReports(f.db,'الامتحانات',new Date(now),{viewerId:PRIMARY,chatId:PRIMARY})).map(r=>r.id);
  expect(await upcoming(before)).toEqual(['ar-3001-0','ar-3002-0','ar-3003-0']);
  expect(await upcoming(after)).toEqual(['ar-3002-0','ar-3003-0']);
  const context=await getAcademicContext(f.db,{now:new Date(after),userId:PRIMARY,scopeChatId:PRIMARY});
  expect(context).toContain('future-nov03');expect(context).toContain('undated-needs-clarification');
  expect(context).not.toContain('expired-oct28');expect(context).not.toContain('thursday-oct29');
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(4);
 });
 it.each(['اعرض التبليغات القديمة','شوفني أرشيف التبليغات','اعرض التبليغات المنتهية','اعرض امتحانات بتاريخ 2026-10-28'])('retrieves old records only when explicitly requested: %s',async text=>{
  const f=seeded();const context=JSON.parse(await getAcademicContext(f.db,{now:new Date(after),queryText:text,userId:PRIMARY,scopeChatId:PRIMARY}));
  expect(context.some((r:{date:string})=>r.date==='2026-10-28')).toBe(true);
  expect(context.some((r:{date:string})=>r.date==='2026-11-03'||r.date===null)).toBe(false);
 });
 it('labels archived results and keeps a following ordinary question limited to upcoming records',async()=>{
  let time=after;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();f.setStatus(429);
  await f.run(3100,'اعرض التبليغات القديمة',PRIMARY,undefined,undefined,PRIMARY);
  const archived=String(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text);
  expect(archived).toContain('عرض تاريخي');expect(archived).toContain('2026-10-29');expect(archived).not.toContain('2026-11-03');
  time+=10000;await f.run(3101,'شعدنا امتحانات',PRIMARY,undefined,undefined,PRIMARY);
  const current=String(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text);
  expect(current).toContain('2026-11-03');expect(current).not.toContain('2026-10-29');
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
 it('grounds a retried pre-midnight question against the actual current day',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(after);const f=seeded();
  f.setModel({intent:'chat',reply:'نراجع المواعيد القادمة.',clarification:null,items:[]});
  await f.run(3190,'رتبلي تبليغات الامتحانات',PRIMARY,undefined,undefined,PRIMARY,before);
  const messages=JSON.stringify(f.calls.find(c=>c.method==='completions')!.body.messages);
  expect(messages).toContain('BAGHDAD_NOW=2026-10-30');expect(messages).toContain('future-nov03');expect(messages).not.toContain('thursday-oct29');
 });
 it('does not let an old saved conversation or quoted list reintroduce expired facts into model input',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(after);const f=seeded();
  f.sql.prepare("INSERT INTO assistant_turns(id,scope,user_id,chat_id,message_id,question,reply_plain,reply_html,state,created_at) VALUES('message:prior',?,?,?,?,? ,?,?,'ready',?)")
   .run(`${PRIMARY}:0:${PRIMARY}`,PRIMARY,PRIMARY,1,'شعدنا امتحانات','امتحان منتهي 2026-10-29 history-expired','امتحان منتهي 2026-10-29 history-expired',before);
  f.setModel({intent:'chat',reply:'نرتب القراءة على المواعيد القادمة.',clarification:null,items:[]});
  await f.run(3200,'رتبلي تبليغات الامتحانات',PRIMARY,'امتحان 2026-10-29 quoted-expired',1,PRIMARY);
  const request=f.calls.find(c=>c.method==='completions');expect(request).toBeDefined();const messages=JSON.stringify(request!.body.messages);
  expect(messages).toContain('future-nov03');expect(messages).not.toContain('expired-oct28');expect(messages).not.toContain('thursday-oct29');
  expect(messages).not.toContain('history-expired');expect(messages).not.toContain('quoted-expired');
 });
});

describe('29 October 15:42–15:47 cancellation in private and group',()=>{
 const clock=Date.parse('2026-10-29T15:43:00+03:00');
 function seeded(){const f=fixture();for(const [i,course,kind,date] of [[0,'graphics','quiz','2026-10-29'],[1,'architecture','quiz','2026-10-29'],[2,'mobile','exam','2026-11-03'],[3,'networks','exam','2026-11-05']]as const){
  const body={...analysis.items[0],course,kind,date,audience:'all',details:`تبليغ ${course}`};
  f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,audience,certainty,destination_chat_id,last_update_id,created_at,updated_at) VALUES(?,?,'طالب',?,1,?,?,?,?,'all','asserted',?,?,?,?)`)
   .run(`ar-${4000+i}-0`,PRIMARY,GROUP,JSON.stringify(body),course,kind,date,-1002222222222,4000+i,clock,clock);
 }f.setStatus(429);return f;}
 it.each(['احذف مادة الرسومات','كوز مادة الرسوميات احذفه','اي احذفه كوز مادة الرسومات','احذف تحديث: كوز — رسومات الحاسبة'])('cancels the uniquely named event locally from private: %s',async text=>{
  vi.spyOn(Date,'now').mockReturnValue(clock);const f=seeded();await f.run(4100,text,PRIMARY,undefined,undefined,PRIMARY);
  expect(f.sql.prepare("SELECT state FROM academic_reports WHERE course='graphics'").get()?.state).toBe('cancelled');
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='active'").get()?.n).toBe(3);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('ألغيت التبليغ');
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);expect(f.queries()).toBeLessThanOrEqual(50);
 });
 it.each([[PRIMARY,PRIMARY],[SECONDARY,SECONDARY],[PRIMARY,GROUP],[SECONDARY,GROUP]])('narrows a durable list to graphics for actor %s in chat %s',async(uid,chat)=>{
  let time=clock;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();
  await f.run(4200,'شعدنا امتحانات وكوزات',uid,undefined,undefined,chat);
  const delivered=f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:4200:0'").get()!;
  time+=10000;await f.run(4201,'اي احذفه كوز مادة الرسومات',uid,'قائمة فيها أربعة تبليغات',Number(delivered.message_id),chat);
  expect(f.sql.prepare("SELECT state,revision FROM academic_reports WHERE course='graphics'").get()).toMatchObject({state:'cancelled',revision:2});
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='active'").get()?.n).toBe(3);
  const mutations=f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n;
  time+=10000;await f.run(4201,'اي احذفه كوز مادة الرسومات',uid,'قائمة فيها أربعة تبليغات',Number(delivered.message_id),chat);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n).toBe(mutations);
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
 it('silently deletes architecture and invalidates both an earlier publication and a legacy cancellation card before Cron can send them',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(clock);const f=seeded();
  const payload={reportId:'ar-4001-0',revision:1,chatId:-1002222222222,threadId:null,expiresAt:clock+86400000,reminder:null};
  f.sql.prepare("INSERT INTO outbox(id,type,payload_json,due_at) VALUES('old-publish','academic_report',?,?)").run(JSON.stringify(payload),clock);
  await f.run(4240,'احذف المعماريه',PRIMARY,undefined,undefined,GROUP);
  expect(f.sql.prepare("SELECT state FROM academic_reports WHERE id='ar-4001-0'").get()?.state).toBe('cancelled');
  expect(f.sql.prepare("SELECT state FROM outbox WHERE id='old-publish'").get()?.state).toBe('cancelled');
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='academic_report' AND state IN ('pending','sending')").get()?.n).toBe(0);
  const obsolete={...payload,revision:2};
  expect(await academicReportOutgoing(f.db,{payload:obsolete},clock+10000)).toBeNull();
  f.sql.prepare("INSERT INTO outbox(id,type,payload_json,due_at) VALUES('old-cancel-card','academic_report',?,?)").run(JSON.stringify(obsolete),clock);
  await dispatchEventJobs(new EventStore(f.db),f.telegram,clock+10000,{limit:2,types:['academic_report']});
  expect(f.sql.prepare("SELECT state FROM outbox WHERE id='old-cancel-card'").get()?.state).toBe('cancelled');
  expect(f.calls.some(c=>c.body.chat_id===-1002222222222)).toBe(false);
  expect(f.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
 it('does not narrow a stale list into permission to cancel a newer version',async()=>{
  let time=clock;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();
  await f.run(4250,'شعدنا امتحانات وكوزات',PRIMARY,undefined,undefined,PRIMARY);
  const messageId=f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:4250:0'").get()?.message_id;
  f.sql.exec("UPDATE academic_reports SET revision=2 WHERE course='graphics'");time+=10000;
  await f.run(4251,'احذف كوز الرسومات',PRIMARY,'قائمة قديمة',Number(messageId),PRIMARY);
  expect(f.sql.prepare("SELECT state,revision FROM academic_reports WHERE course='graphics'").get()).toMatchObject({state:'active',revision:2});
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('آخر نسخة');
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);
 });
 it('does not wake for a reply to another bot’s inline result',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(clock);const f=seeded();
  await handleUpdate({update_id:4260,message:{message_id:4260,from:{id:PRIMARY,is_bot:false},chat:{id:GROUP,type:'supergroup'},text:'رسومات احذفه',reply_to_message:{message_id:4259,chat:{id:GROUP,type:'supergroup'},from:{id:PRIMARY,is_bot:false},via_bot:{id:888,is_bot:true},text:'قائمة'}}},f.telegram,new Date(clock),{DB:f.db,GROQ_API_KEY:'synthetic-groq-key'},new NluClassifier());
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='active'").get()?.n).toBe(4);
  expect(f.calls.some(c=>c.method==='sendMessage')).toBe(false);
 });
 it('accepts a human reply to this bot’s inline result without another wake word',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(clock);const f=seeded();
  const update:TelegramUpdate={update_id:4300,message:{message_id:4300,date:clock/1000,from:{id:PRIMARY,is_bot:false},chat:{id:GROUP,type:'supergroup'},text:'رسومات احذفه',
   reply_to_message:{message_id:4299,chat:{id:GROUP,type:'supergroup'},from:{id:PRIMARY,is_bot:false},via_bot:{id:999,is_bot:true,username:'daaboolbot'},text:'قائمة الإنلاين'}}};
  await handleUpdate(update,f.telegram,new Date(clock),{DB:f.db,GROQ_API_KEY:'synthetic-groq-key'},new NluClassifier());
  expect(f.sql.prepare("SELECT state FROM academic_reports WHERE course='graphics'").get()?.state).toBe('cancelled');
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='active'").get()?.n).toBe(3);
 });
 it('keeps ambiguous, conflicting, foreign and student deletion requests from selecting another event',async()=>{
  let time=clock;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();
  const row=f.sql.prepare("SELECT * FROM academic_reports WHERE course='graphics'").get()!;const body={...JSON.parse(String(row.body_json)),date:'2026-11-02'};
  f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,certainty,destination_chat_id,last_update_id,created_at,updated_at) VALUES('ar-4050-0',?,'طالب',?,1,?,'graphics','quiz','2026-11-02','asserted',?,4050,?,?)`).run(PRIMARY,GROUP,JSON.stringify(body),-1002222222222,clock,clock);
  await f.run(4400,'احذف كوز الرسومات',PRIMARY,undefined,undefined,PRIMARY);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('أكثر');
  time+=10000;await f.run(4401,'احذف كوز الرسومات 2026-10-29',123,undefined,undefined,123);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('لصاحبه أو للمالك');
  time+=10000;await f.run(4402,'احذف كوز الرسومات 2026-10-29',PRIMARY,undefined,undefined,-100999);
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE state='cancelled'").get()?.n).toBe(0);
 });
});

describe('29 October 16:27 publication replies in ordinary group discussion threads',()=>{
 const clock=Date.parse('2026-10-29T16:27:00+03:00');
 function seeded(){const f=fixture();for(const [i,course,date,audience] of [[0,'mobile','2026-11-03','A'],[1,'networks','2026-11-05','B']]as const){
  const item={...analysis.items[0],course,date,audience,details:`امتحان ${course}`};
  f.sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,audience,certainty,destination_chat_id,last_update_id,created_at,updated_at) VALUES(?,?,'طالب',?,1,?,?,'exam',?,?,'asserted',?,?,?,?)`)
   .run(`ar-${5000+i}-0`,PRIMARY,GROUP,JSON.stringify(item),course,date,audience,-1002222222222,5000+i,clock,clock);
 }f.setStatus(429);return f;}
 it.each(['بلغ الكل','بلغ الجميع','انشر','انشر الكل'])('publishes the exact replied two-item list with %s despite the ordinary reply thread changing',async text=>{
  let time=clock;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();
  await f.run(5100,'شعدنا امتحانات ؟');const replyId=Number(f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:5100:0'").get()?.message_id);
  time+=10000;await f.run(5101,text,PRIMARY,'قائمة الموبايل والشبكات',replyId,GROUP,time,{threadId:replyId,raw:true});
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(2);
  expect(f.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
  expect(f.calls.filter(c=>c.method==='sendMessage').at(-1)!.body.text).toContain('نشرته بالقناة');
  expect(f.calls.some(c=>c.method==='completions')).toBe(false);expect(f.queries()).toBeLessThanOrEqual(50);
  time+=10000;await f.run(5102,'انشر',PRIMARY,'قائمة الموبايل والشبكات',replyId,GROUP,time,{threadId:replyId,raw:true});
  expect(f.calls.filter(c=>c.body.chat_id===-1002222222222)).toHaveLength(1);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(2);
 });
 it.each([PRIMARY,SECONDARY])('lets admin %s publish a proven reply across ordinary discussion roots',async uid=>{
  let time=clock;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();
  await f.run(5200,'شعدنا امتحانات',PRIMARY,undefined,undefined,GROUP,time,{threadId:100});
  const replyId=Number(f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:5200:0'").get()?.message_id);
  time+=10000;await f.run(5201,'بلغ الكل',uid,'قائمة',replyId,GROUP,time,{threadId:101,raw:true});
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(2);
 });
 it.each(['forum','unknown','student'])('does not broaden an unmatched or unauthorized %s reply into another publication',async mode=>{
  let time=clock;vi.spyOn(Date,'now').mockImplementation(()=>time);const f=seeded();
  await f.run(5300,'شعدنا امتحانات',PRIMARY,undefined,undefined,GROUP,time,{threadId:100,...(mode==='forum'?{topic:true}:{})});
  const replyId=Number(f.sql.prepare("SELECT message_id FROM outbox WHERE id='assistant-reply:message:5300:0'").get()?.message_id);
  time+=10000;await f.run(5301,'بلغ الكل',mode==='student'?123:PRIMARY,'قائمة',mode==='unknown'?999999:replyId,GROUP,time,{threadId:101,raw:true,...(mode==='forum'?{topic:true,replyTopic:true}:{})});
  expect(f.calls.some(c=>c.body.chat_id===-1002222222222||c.method==='completions')).toBe(false);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM publication_receipts').get()?.n).toBe(0);
 });
});
