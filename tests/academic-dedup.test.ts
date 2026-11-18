import {afterEach,describe,it,expect,vi} from 'vitest';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {academicDuplicateKey,cleanAcademicDuplicates,planAcademicDuplicates,duplicateCleanupIntent} from '../src/academic-dedup';
import {applyAcademicAnalysis,getAcademicReport,type AcademicItem,type AcademicReport} from '../src/academic-ai';
const NOW=Date.parse('2026-10-28T19:24:00+03:00'),ADMIN=111111111,CHANNEL=-1002222222222,GROUP=-1001111111111;
const dbs:DatabaseSync[]=[];
function fixture(){
 const sql=new DatabaseSync(':memory:');dbs.push(sql);for(const name of readdirSync(resolve(import.meta.dirname,'../migrations')).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(resolve(import.meta.dirname,'../migrations',name),'utf8'));
 sql.exec(`UPDATE settings SET owner_uid=${ADMIN},target_chat_id=${CHANNEL},target_thread_id=NULL`);let queries=0;
 class P{constructor(readonly q:string,readonly v:SQLInputValue[]=[]){ }bind(...v:SQLInputValue[]){return new P(this.q,v);}admit(){if(++queries>50)throw Error('D1 budget exceeded');}async first<T>(){this.admit();return(sql.prepare(this.q).get(...this.v)??null)as T|null;}async all<T>(){this.admit();return{success:true,results:sql.prepare(this.q).all(...this.v)as T[]};}async run(){this.admit();return{success:true,meta:{changes:Number(sql.prepare(this.q).run(...this.v).changes)}};}}
 const db={prepare:(q:string)=>new P(q),batch:async(ps:P[])=>{sql.exec('BEGIN');try{const r=[];for(const p of ps){p.admit();r.push({success:true,meta:{changes:Number(sql.prepare(p.q).run(...p.v).changes)}});}sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}}as unknown as D1Database;
 const seed=(id:string,item:AcademicItem,uid=ADMIN,thread:number|null=null)=>{sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,audience,component,certainty,destination_chat_id,destination_thread_id,last_update_id,created_at,updated_at) VALUES(?,?,'طالب',?,1,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id,uid,GROUP,JSON.stringify(item),item.course,item.kind,item.date,item.audience,item.component,item.certainty,CHANNEL,thread,NOW,NOW);};
 return{sql,db,seed,reset:()=>{queries=0;},count:()=>queries};
}
function item(overrides:Partial<AcademicItem>={}):AcademicItem{return{action:'create',targetId:null,kind:'exam',course:'networks',courseEvidence:'الشبكات',component:null,date:'2026-11-05',dateEvidence:'5/11',time:null,timeEvidence:null,audience:null,audienceEvidence:null,certainty:'asserted',coverage:'',occurrenceSlots:[],occurrenceEvidence:null,details:'امتحان مادة الشبكات',evidence:'عدنا يوم الخميس 5/11 امتحان مادة الشبكات',...overrides};}
function source(id:number,text:string,uid=ADMIN){return{updateId:id,userId:uid,userName:'طالب',chatId:GROUP,threadId:null,messageId:id,text,now:NOW};}
afterEach(()=>{vi.restoreAllMocks();for(const db of dbs.splice(0))db.close();});
describe('semantic duplicate identity and physical record cleanup',()=>{
 it('recognizes the two actual network descriptions without deleting differences in requirements',async()=>{
  expect(await academicDuplicateKey(item({details:'امتحان بمادة الشبكات'}),NOW)).toBe(await academicDuplicateKey(item(),NOW));
  for(const change of [{audience:'A'},{audience:'B'},{component:'practical'},{time:'09:00'},{certainty:'tentative'},{coverage:'الفصل الاول'},{details:'امتحان مادة الشبكات الفصل الاول داخل'},{details:'امتحان مادة الشبكات الفصل الاول مو داخل'}]as Partial<AcademicItem>[])
   expect(await academicDuplicateKey(item(change),NOW)).not.toBe(await academicDuplicateKey(item(),NOW));
 });
 it('matches the old undated mobile record only when its original date evidence proves the same date',async()=>{
  const old=item({course:'mobile',courseEvidence:'تطبيقات الموبايل',details:'امتحان مادة تطبيقات الموبايل',date:null,dateEvidence:'يوم الثلاثاء المصادف 3/11'});
  expect(await academicDuplicateKey(old,NOW)).toBe(await academicDuplicateKey({...old,date:'2026-11-03'},NOW));
  expect(await academicDuplicateKey({...old,dateEvidence:null},NOW)).toBeNull();
 });
 it('physically removes the two screenshot duplicates, keeps four records and transfers existing send receipts',async()=>{
  const f=fixture();const mobile=item({course:'mobile',courseEvidence:'تطبيقات الموبايل',details:'امتحان مادة تطبيقات الموبايل',date:'2026-11-03',dateEvidence:'3/11'});
  f.seed('ar-1-0',item({details:'امتحان بمادة الشبكات'}));f.seed('ar-2-0',item());
  f.seed('ar-3-0',{...mobile,date:null,dateEvidence:'يوم الثلاثاء المصادف 3/11'});f.seed('ar-4-0',mobile);
  f.seed('ar-5-0',item({kind:'quiz',course:'graphics',date:'2026-10-29',details:'كوز مادة الرسومات'}));
  f.seed('ar-6-0',item({kind:'quiz',course:'architecture',date:'2026-10-29',details:'كوز بمادة المعمارية'}));
  f.sql.prepare("INSERT INTO publication_receipts VALUES('academic','ar-2-0',1,?,0,100,?,'old-publication')").run(CHANNEL,NOW);
  const result=await cleanAcademicDuplicates(f.db,ADMIN,ADMIN,NOW);
  expect(result.removed).toBe(2);expect(result.remaining).toBe(4);expect(f.count()).toBeLessThan(50);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(4);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_merges').get()?.n).toBe(2);
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE id IN ('ar-2-0','ar-3-0')").get()?.n).toBe(0);
  expect(f.sql.prepare("SELECT message_id FROM publication_receipts WHERE record_id='ar-1-0'").get()?.message_id).toBe(100);
  expect(f.sql.prepare("SELECT event_date FROM academic_reports WHERE id='ar-4-0'").get()?.event_date).toBe('2026-11-03');
  f.reset();expect((await cleanAcademicDuplicates(f.db,ADMIN,GROUP,NOW+1)).removed).toBe(0);
 });
 it('does not merge a different author, topic, audience or ambiguous unknown date; students clean only their own records',async()=>{
  const f=fixture();f.seed('ar-1-0',item(),123);f.seed('ar-2-0',item(),123);f.seed('ar-3-0',item(),456);f.seed('ar-4-0',item(),456);
  f.seed('ar-5-0',item({audience:'A'}),123);f.seed('ar-6-0',item(),123,7);
  expect((await cleanAcademicDuplicates(f.db,123,123,NOW)).removed).toBe(1);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports WHERE author_id=456').get()?.n).toBe(2);
  f.reset();expect((await cleanAcademicDuplicates(f.db,ADMIN,-100999,NOW)).removed).toBe(0);
 });
 it.each(['لا تحذف التبليغات المكررة','شلون احذف التبليغات المكررة','قال احذف التبليغات المكررة','لو احذف التكرار؟'])('does not execute %s',text=>expect(duplicateCleanupIntent(text)).toBe(false));
 it('uses the unique database identity across two different concurrent updates',async()=>{
  const f=fixture();const first=item(),second=item({details:'امتحان بمادة الشبكات'});
  const a={intent:'academic' as const,reply:'',clarification:null,items:[first]},b={...a,items:[second]};
  const results=await Promise.all([applyAcademicAnalysis(f.db,source(100,first.evidence),a),applyAcademicAnalysis(f.db,source(101,second.evidence),b)]);
  expect(results[0]?.reportIds).toEqual(results[1]?.reportIds);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
 });
 it('does not create a second row when an edit collides with an existing identical assessment',async()=>{
  const f=fixture();const a=item(),b=item({date:'2026-11-07',dateEvidence:'7/11'});
  await applyAcademicAnalysis(f.db,source(110,a.evidence),{intent:'academic',reply:'',clarification:null,items:[a]});f.reset();
  await applyAcademicAnalysis(f.db,source(111,b.evidence),{intent:'academic',reply:'',clarification:null,items:[b]});f.reset();
  f.sql.prepare("INSERT INTO publication_receipts VALUES('academic','ar-110-0',1,?,0,100,?,'old-date-send')").run(CHANNEL,NOW);
  const edit=item({action:'update',targetId:'ar-110-0',course:null,courseEvidence:null,date:'2026-11-07',dateEvidence:'7/11',details:'عدل موعد امتحان الشبكات وخليه السبت 7/11',evidence:'عدل موعد امتحان الشبكات وخليه السبت 7/11'});
  const result=await applyAcademicAnalysis(f.db,source(112,edit.evidence),{intent:'academic',reply:'',clarification:null,items:[edit]});
  expect(result.text).toContain('دمجت');expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM publication_receipts WHERE record_id='ar-111-0'").get()?.n).toBe(0);
 });
});

describe('edit revision safety',()=>{
 it('rejects an edit based on an obsolete verified revision without overwriting a newer record',async()=>{
  const f=fixture();const initial=item();await applyAcademicAnalysis(f.db,source(940,initial.evidence),{intent:'academic',reply:'',clarification:null,items:[initial]});
  f.sql.exec("UPDATE academic_reports SET revision=2 WHERE id='ar-940-0'");f.reset();
  const edit=item({action:'update',targetId:'ar-940-0',date:'2026-11-07',details:'عدل موعد امتحان الشبكات وخليه السبت 7/11'});
  const result=await applyAcademicAnalysis(f.db,{...source(941,edit.details),expectedRevisions:{'ar-940-0':1}},{intent:'academic',reply:'',clarification:null,items:[edit]});
  expect(result.reportIds).toHaveLength(0);expect(result.text).toContain('تغيّر بعد النسخة');
  expect(f.sql.prepare("SELECT event_date FROM academic_reports WHERE id='ar-940-0'").get()?.event_date).toBe('2026-11-05');
 });
});
