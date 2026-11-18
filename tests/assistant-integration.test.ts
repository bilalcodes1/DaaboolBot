import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/bot';
import { TelegramClient } from '../src/telegram';
import { NluClassifier } from '../src/nlu';
import { fitAssistantMessages, getAssistantInlineAnswer } from '../src/assistant-handler';
import { assistantRequestFits } from '../src/assistant-ai';
import { assistantHistory, assistantScope, claimAssistantTurn, finishAssistantTurn, reserveAssistantUser, splitAssistantHtml } from '../src/assistant-store';
import { dispatchEventJobs } from '../src/event-jobs';
import { EventStore } from '../src/event-store';
import { emptyEventDraft } from '../src/event-types';
import type { AcademicItem } from '../src/academic-ai';
import type { Env, TelegramUpdate } from '../src/types';

const NOW=Date.parse('2026-10-23T09:00:00Z');
const databases:DatabaseSync[]=[];
function database(migrate=true) {
  const sql=new DatabaseSync(':memory:');databases.push(sql);let statements=0;
  if(migrate) for(const name of readdirSync(new NodeURL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) sql.exec(readFileSync(new NodeURL(`../migrations/${name}`,import.meta.url),'utf8'));
  const prepare=(query:string,values:(string|number|null)[]=[])=>{
    const execute=(mode:'run'|'all'|'first')=>{statements++;const stmt=sql.prepare(query);
      if(mode==='first') return stmt.get(...values)??null;
      if(mode==='all') return {success:true,results:stmt.all(...values),meta:{changes:0}};
      return {success:true,meta:{changes:Number(stmt.run(...values).changes)}};
    };
    return {bind(...next:(string|number|null)[]){return prepare(query,next);},async first(){return execute('first');},async all(){return execute('all');},async run(){return execute('run');},execute};
  };
  const db={prepare,batch:async(items:ReturnType<typeof prepare>[])=>{
    sql.exec('BEGIN');try {const results=items.map(item=>item.execute('run'));sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}
  }} as unknown as D1Database;
  if(migrate) sql.prepare('UPDATE settings SET owner_uid=1,target_chat_id=-100123,target_thread_id=NULL WHERE singleton=1').run();
  return {db,sql,count:()=>statements,reset:()=>{statements=0;}};
}
function network(analysis:unknown,options:{groq429?:boolean}={}) {
  const requests:{url:string;body:Record<string,unknown>}[]=[];
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{
    const address=String(url);const body=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;requests.push({url:address,body});
    if(address==='https://api.groq.com/openai/v1/chat/completions') return options.groq429?Response.json({error:'test quota'},{status:429,headers:{'Retry-After':'60'}}):Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(analysis)}}],usage:{total_tokens:800}});
    if(address.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(analysis)}]}}],usageMetadata:{totalTokenCount:800}});
    if(address.includes('/getMe')) return Response.json({ok:true,result:{id:999,is_bot:true,username:'DaaboolTestBot'}});
    if(address.startsWith('https://api.telegram.org/')) return Response.json({ok:true,result:{message_id:500+requests.length}});
    throw new Error('Unexpected network endpoint');
  });
  return {requests,fetcher,telegram:new TelegramClient('123:test-token',fetcher)};
}
function event(update_id:number,text:string,group=false):TelegramUpdate {
  return {update_id,message:{message_id:update_id+100,date:NOW/1000,from:{id:2,is_bot:false,first_name:'طالب'},chat:{id:group?-100123:2,type:group?'supergroup':'private'},text}};
}
function environment(db:D1Database):Env {return {DB:db,TELEGRAM_BOT_TOKEN:'123:test-token',WEBHOOK_SECRET_TOKEN:'test-secret',GROQ_API_KEY:'synthetic-groq-key',CONTRIBUTIONS_ENABLED:'true'};}
const emptyAnalysis=(reply='هلا، شتحتاج؟')=>({intent:'chat',reply,clarification:null,items:[]});
function item(overrides:Partial<AcademicItem>):AcademicItem {return {action:'create',targetId:null,kind:'quiz',course:'graphics',courseEvidence:'رسومات',component:null,date:null,dateEvidence:null,time:null,timeEvidence:null,audience:null,audienceEvidence:null,certainty:'asserted',coverage:'',occurrenceSlots:[],occurrenceEvidence:null,details:'رسومات',evidence:'رسومات',...overrides};}

afterEach(()=>{vi.restoreAllMocks();for(const sql of databases.splice(0)) sql.close();});

describe('integrated Groq Telegram assistant',()=>{
  it('keeps the screenshot intake pending through a busy free minute and retries without charging the student twice',async()=>{
    let clock=Date.parse('2026-10-24T11:32:10Z');vi.spyOn(Date,'now').mockImplementation(()=>clock);
    const {db,sql,reset,count}=database();
    sql.prepare(`INSERT INTO assistant_ai_usage(provider,day_start,minute_start,day_requests,minute_requests,day_tokens,minute_tokens)
      VALUES('groq',?,?,4,4,4000,4000)`).run(Math.floor(clock/86_400_000),Math.floor(clock/60_000));
    const text='اريد تثبت عدنا هذا الاسبوع كوز معماريه محتمل بالاحد وكوز برمجة مرئية يوم الاثنين وكوز رسومات عملي ب DDA';
    const clauses=['كوز معماريه محتمل بالاحد','كوز برمجة مرئية يوم الاثنين','كوز رسومات عملي ب DDA'];
    const analysis={intent:'academic',reply:'',clarification:null,items:[
      item({course:'architecture',courseEvidence:'معماريه',date:'2026-10-25',dateEvidence:'الاحد',certainty:'tentative',details:clauses[0]!,evidence:clauses[0]!}),
      item({course:'visual',courseEvidence:'برمجة مرئية',date:'2026-10-26',dateEvidence:'الاثنين',details:clauses[1]!,evidence:clauses[1]!}),
      item({course:'graphics',component:'practical',coverage:'DDA',details:clauses[2]!,evidence:clauses[2]!}),
    ]};
    const net=network(analysis);const update=event(430,`@DaaboolTestBot ${text}`,true);update.message!.date=Math.floor(clock/1000);
    await expect(handleUpdate(update,net.telegram,new Date(clock),environment(db),new NluClassifier(),net.fetcher))
      .rejects.toMatchObject({name:'AssistantAiRetryError'});
    expect(sql.prepare('SELECT state FROM assistant_turns').get()?.state).toBe('processing');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
    const waiting=net.requests.filter(value=>value.url.endsWith('/sendMessage'));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.body.text).toContain('قيد المعالجة');
    clock+=61_000;reset();
    await handleUpdate(update,net.telegram,new Date(clock),environment(db),new NluClassifier(),net.fetcher);
    expect(count()).toBeLessThanOrEqual(50);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(3);
    const items=sql.prepare('SELECT body_json FROM academic_reports ORDER BY id').all().map(row=>JSON.parse(String(row.body_json)) as AcademicItem);
    expect(items[0]).toMatchObject({course:'architecture',date:'2026-10-25',certainty:'tentative'});
    expect(items[1]).toMatchObject({course:'visual',date:'2026-10-26'});
    expect(items[2]).toMatchObject({course:'graphics',component:'practical',date:null,coverage:'DDA'});
    expect(sql.prepare('SELECT requests FROM assistant_user_limits WHERE user_id=2').get()?.requests).toBe(1);
    expect(net.requests.filter(value=>value.url.includes('api.groq.com'))).toHaveLength(1);
  });

  it('lets enabled AI answer a bare call naturally instead of entering the legacy wake-word templates',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql}=database();const net=network(emptyAnalysis('ها، أسمعك 😄'));
    await handleUpdate(event(420,'دعبول',true),net.telegram,new Date(NOW),environment(db),new NluClassifier(),net.fetcher);
    expect(net.requests.filter(value=>value.url.includes('api.groq.com'))).toHaveLength(1);
    expect(net.requests.filter(value=>value.url.endsWith('/sendMessage')).at(-1)?.body.text).toBe('ها، أسمعك 😄');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  });

  it('cancels the legacy exam selected by a persisted reply without asking AI to recreate its details',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql,reset,count}=database();const store=new EventStore(db);
    await store.createEvent({id:'legacy-exam',authorId:2,authorName:'طالب',sourceChatId:-100123,status:'approved',submittedAt:NOW,
      draft:{...emptyEventDraft(),kind:'exam',course:'compilers',date:'2026-10-19',audience:'all',details:'المحاضرة الأولى والثانية لحد اليكسل مو داخله.'}});
    const net=network(emptyAnalysis());const env=environment(db);
    const ask=event(400,'@DaaboolTestBot اعرض امتحان المترجمات 2026-10-19',true);ask.message!.from!.id=1;
    await handleUpdate(ask,net.telegram,new Date(NOW),env,new NluClassifier(),net.fetcher);
    const sent=sql.prepare("SELECT message_id FROM outbox WHERE type='assistant_reply' AND state='sent'").get();
    expect(sent?.message_id).toBeTypeOf('number');
    const queryReply=sql.prepare('SELECT reply_html FROM assistant_turns WHERE id=?').get('message:400');
    expect(String(queryReply?.reply_html).match(/المطلوب حسب التبليغ/g)).toHaveLength(1);
    expect(queryReply?.reply_html).not.toContain('اختار نتيجة التبليغ');
    const remove=event(401,'@DaaboolTestBot هذا قديم التبليغ احذفه',true);remove.message!.from!.id=1;
    remove.message!.reply_to_message={message_id:Number(sent!.message_id),chat:{id:-100123,type:'supergroup'},from:{id:999,is_bot:true},text:String(queryReply?.reply_html)};
    reset();await handleUpdate(remove,net.telegram,new Date(NOW+10_000),env,new NluClassifier(),net.fetcher);
    expect(count()).toBeLessThanOrEqual(50);
    expect(await store.getEvent('legacy-exam')).toMatchObject({status:'cancelled',revision:2,publicationDeletionRevision:2});
    expect(net.requests.filter(value=>value.url.includes('api.groq.com'))).toHaveLength(0);
    expect(sql.prepare('SELECT reply_html FROM assistant_turns WHERE id=?').get('message:401')?.reply_html).toContain('انحذف التبليغ');
    await handleUpdate(remove,net.telegram,new Date(NOW+20_000),env,new NluClassifier(),net.fetcher);
    expect((await store.getEvent('legacy-exam'))?.revision).toBe(2);
  });

  it('refuses an ungrounded quoted deletion instead of sending the short command to the create schema',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql}=database();const net=network(emptyAnalysis());
    const update=event(410,'@DaaboolTestBot هذا قديم التبليغ احذفه',true);
    update.message!.reply_to_message={message_id:12345,chat:{id:-100123,type:'supergroup'},from:{id:999,is_bot:true},text:'امتحان المترجمات 2026-10-19'};
    await handleUpdate(update,net.telegram,new Date(NOW),environment(db),new NluClassifier(),net.fetcher);
    expect(net.requests.filter(value=>value.url.includes('api.groq.com'))).toHaveLength(0);
    expect(sql.prepare('SELECT reply_html FROM assistant_turns').get()?.reply_html).toContain('رد على رسالة التبليغ');
  });

  it('answers ordinary private chat once and persists isolated history across handler instances',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql}=database();const net=network(emptyAnalysis('هلا، أگدر أساعدك.'));
    const update=event(1,'هلا شلونك');
    await handleUpdate(update,net.telegram,new Date(NOW),environment(db),new NluClassifier(),net.fetcher);
    await handleUpdate(update,new TelegramClient('123:test-token',net.fetcher),new Date(NOW),environment(db),new NluClassifier(),net.fetcher);
    expect(net.requests.filter(request=>request.url.includes('api.groq.com'))).toHaveLength(1);
    expect(net.requests.filter(request=>request.url.endsWith('/sendMessage'))).toHaveLength(1);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
    expect(await assistantHistory(db,assistantScope(2,2,null),NOW)).toHaveLength(2);
    expect(await assistantHistory(db,assistantScope(3,2,null),NOW)).toEqual([]);
    expect(await assistantHistory(db,assistantScope(2,-100123,null),NOW)).toEqual([]);
  });

  it('saves the supplied three-item announcement automatically without inventing time, audience or certainty',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql,count}=database();
    const text='رسومات عملي تريد مناقشة كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج\nو بالخميس كوز بالمحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها كالت يمكن تجيبه mcq،و المعمارية نفسه ما تكوزنه يجوز يكوزنه الأحد';
    const analysis={intent:'academic',reply:'',clarification:null,items:[
      item({kind:'discussion',component:'practical',coverage:'كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج',details:'رسومات عملي تريد مناقشة كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج',evidence:'رسومات عملي تريد مناقشة كود خوارزمية DDA و الكود بورقة و ننقله للبرنامج'}),
      item({date:'2026-10-29',dateEvidence:'بالخميس',coverage:'المحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها',details:'بالخميس كوز بالمحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها كالت يمكن تجيبه mcq',evidence:'بالخميس كوز بالمحاضرة 2 و3 اهم شي الخوارزميات و الحفظ الي بيها كالت يمكن تجيبه mcq'}),
      item({course:'architecture',courseEvidence:'المعمارية',date:'2026-10-25',dateEvidence:'الأحد',certainty:'tentative',details:'المعمارية نفسه ما تكوزنه يجوز يكوزنه الأحد',evidence:'المعمارية نفسه ما تكوزنه يجوز يكوزنه الأحد'}),
    ]};
    const net=network(analysis);await handleUpdate(event(2,`@DaaboolTestBot ${text}`,true),net.telegram,new Date(NOW),environment(db),new NluClassifier(),net.fetcher);
    const rows=sql.prepare('SELECT body_json FROM academic_reports ORDER BY id').all();expect(rows).toHaveLength(3);
    const items=rows.map(row=>JSON.parse(String(row.body_json)) as AcademicItem);
    expect(items.find(value=>value.kind==='discussion')?.date).toBeNull();
    expect(items.find(value=>value.course==='architecture')?.certainty).toBe('tentative');
    const quiz=items.find(value=>value.kind==='quiz'&&value.course==='graphics');expect(quiz?.certainty).toBe('asserted');expect(quiz?.occurrenceSlots).toEqual([]);
    expect(items.every(value=>value.audience===null&&value.time===null)).toBe(true);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='review'").get()?.n).toBe(0);
    expect(net.requests.some(request=>request.url.endsWith('/sendMessage')&&String(request.body.text).includes('DDA'))).toBe(true);
    expect(count()).toBeLessThanOrEqual(50);
  });

  it('ignores unaddressed group messages without contacting providers',async()=>{
    const {db}=database();const net=network(emptyAnalysis());await handleUpdate(event(3,'بالخميس عدنا كوز رسومات',true),net.telegram,new Date(NOW),environment(db),new NluClassifier(),net.fetcher);expect(net.requests).toEqual([]);
  });

  it('routes changed lecture statements and requests to add a quiz through AI instead of returning the old timetable',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);
    for(const text of ['محاضرات باچر ملغية','جدول الاثنين تغير وصارت الشبكات الساعة عشرة','هل تكدر تضيف كوز الرسومات الخميس؟']) {
      const {db}=database();const net=network(emptyAnalysis('أحتاج تحديد المادة أو المجموعة.'));
      await handleUpdate(event(30,text),net.telegram,new Date(NOW),environment(db),new NluClassifier(),net.fetcher);
      expect(net.requests.filter(request=>request.url.includes('api.groq.com'))).toHaveLength(1);
    }
  });

  it('keeps a six-item fallback request within the free D1 statement allowance and queues delivery',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql,count}=database();
    const clauses=Array.from({length:6},(_,index)=>`رسومات كوز 2026-10-${24+index}`);const text=clauses.join('، ');
    const analysis={intent:'academic',reply:'',clarification:null,items:clauses.map((clause,index)=>item({date:`2026-10-${24+index}`,dateEvidence:`2026-10-${24+index}`,details:clause,evidence:clause}))};
    const net=network(analysis,{groq429:true});const env={...environment(db),GEMINI_API_KEY:'gemini_test_not_real'};
    const update=event(31,text);update.message!.reply_to_message={message_id:7,chat:{id:2,type:'private'},from:{id:999,is_bot:true},text:'وضح التبليغات'};
    await handleUpdate(update,net.telegram,new Date(NOW),env,new NluClassifier(),net.fetcher);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(6);
    expect(count()).toBeLessThanOrEqual(50);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='assistant_reply' AND state='pending'").get()?.n).toBeGreaterThan(0);
  });

  it('retries a busy durable turn instead of acknowledging and losing it',async()=>{
    const {db}=database();const net=network(emptyAnalysis());const update=event(32,'هلا');
    await claimAssistantTurn(db,{id:'message:32',scope:assistantScope(2,2,null),userId:2,chatId:2,threadId:null,messageId:132,question:'هلا',now:NOW});
    await expect(handleUpdate(update,net.telegram,new Date(NOW+1000),environment(db),new NluClassifier(),net.fetcher)).rejects.toThrow('still processing');
    expect(net.requests.filter(request=>request.url.includes('api.groq.com'))).toEqual([]);
  });

  it('keeps inline read-only even when the model extracts an announcement',async()=>{
    vi.spyOn(Date,'now').mockReturnValue(NOW);const {db,sql}=database();const net=network({intent:'academic',reply:'',clarification:null,items:[item({details:'كوز رسومات',evidence:'كوز رسومات'})]});
    const response=await getAssistantInlineAnswer('باچر عدنا كوز رسومات',2,environment(db),new Date(NOW),net.fetcher);
    expect(response).toContain('بالخاص');expect(sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
  });

  it('falls back to the existing bot when migrations or keys are absent',async()=>{
    const {db}=database();const net=network(emptyAnalysis());const env=environment(db);delete env.GROQ_API_KEY;
    await handleUpdate(event(4,'شنو عدنا باچر؟'),net.telegram,new Date(NOW),env,new NluClassifier(),net.fetcher);
    expect(net.requests.some(request=>request.url.includes('api.groq.com'))).toBe(false);
    expect(net.requests.some(request=>request.url.endsWith('/sendMessage'))).toBe(true);
  });

  it('atomically reserves per-user limits and keeps complete source blocks within request allowance',async()=>{
    const {db}=database();const decisions=await Promise.all(Array.from({length:9},()=>reserveAssistantUser(db,9,NOW)));expect(decisions.filter(Boolean)).toHaveLength(6);
    expect(await reserveAssistantUser(db,9,NOW+60_000)).toBe(true);
    const options={maxTokens:1200};const fitted=fitAssistantMessages('System instruction','SOURCE='+ 'س'.repeat(10000),[{role:'user',content:'ه'.repeat(2000)},{role:'assistant',content:'ب'.repeat(2000)}],'سؤال',options);
    expect(assistantRequestFits(fitted,options)).toBe(true);expect(fitted.at(-1)?.content).toBe('سؤال');
  });

  it('paginates long escaped replies durably without dropped text or broken entities',async()=>{
    const {db,sql}=database();const turn={id:'message:100',scope:assistantScope(2,2,null),userId:2,chatId:2,threadId:null,messageId:110,question:'تفاصيل',now:NOW};
    const html=Array.from({length:40},(_,index)=>`<b>تبليغ ${index}</b>\n${'تفاصيل &amp; '.repeat(30)}`).join('\n\n');
    const pages=splitAssistantHtml(html);expect(pages.length).toBeGreaterThan(1);expect(pages.every(page=>page.length<=4096)).toBe(true);
    expect(pages.join('\n')).toContain('تبليغ 39');
    const claimed=await claimAssistantTurn(db,turn);expect(await finishAssistantTurn(db,turn,claimed.token!,html,'تفاصيل',[])).toBe(true);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='assistant_reply'").get()?.n).toBe(pages.length);
    const sent:{text:string}[]=[];await dispatchEventJobs(new EventStore(db),{call:async<T>(_method:unknown,payload:unknown)=>{sent.push(payload as {text:string});return {message_id:9} as T;}},NOW+60_000,{limit:8,sleep:async()=>{}});
    expect(sent[0]?.text).toBe(pages[0]);
  });
});
