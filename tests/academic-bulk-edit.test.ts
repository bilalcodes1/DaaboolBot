import {afterEach,describe,it,expect,vi} from 'vitest';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {applyBulkAudienceEdit,bulkAudiencePatch,bulkAcademicEditIntent} from '../src/academic-bulk-edit';
import {academicDuplicateKey} from '../src/academic-dedup';
import type {AcademicItem} from '../src/academic-ai';
const NOW=Date.parse('2026-10-29T04:48:00+03:00'),ADMIN=111111111,SECOND=222222222,CHANNEL=-1002222222222;
const TEXT='اريد تعدل التبليغ لكل المواد وتكتب للمجوعتين A و B';
const dbs:DatabaseSync[]=[];
function fixture(){
 const sql=new DatabaseSync(':memory:');dbs.push(sql);for(const file of readdirSync(resolve(import.meta.dirname,'../migrations')).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(resolve(import.meta.dirname,'../migrations',file),'utf8'));
 sql.exec(`UPDATE settings SET owner_uid=${ADMIN},target_chat_id=${CHANNEL},target_thread_id=NULL`);let queries=0,hook:(()=>void)|null=null;
 class P{constructor(readonly q:string,readonly v:SQLInputValue[]=[]){ }bind(...v:SQLInputValue[]){return new P(this.q,v);}admit(){if(++queries>50)throw Error('D1 query budget exceeded');}async first<T>(){this.admit();return(sql.prepare(this.q).get(...this.v)??null)as T|null;}async all<T>(){this.admit();return{success:true,results:sql.prepare(this.q).all(...this.v)as T[]};}async run(){this.admit();return{success:true,meta:{changes:Number(sql.prepare(this.q).run(...this.v).changes)}};}}
 const db={prepare:(q:string)=>new P(q),batch:async(ps:P[])=>{hook?.();hook=null;sql.exec('BEGIN');try{const out=ps.map(p=>{p.admit();return{success:true,meta:{changes:Number(sql.prepare(p.q).run(...p.v).changes)}};});sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}}as unknown as D1Database;
 const seed=async(id:string,audience:AcademicItem['audience']=null,date='2026-11-05',uid=ADMIN)=>{
  const item:AcademicItem={action:'create',targetId:null,kind:'exam',course:'networks',courseEvidence:'الشبكات',component:null,date,dateEvidence:date,time:'09:00',timeEvidence:'09:00',audience,audienceEvidence:null,certainty:'asserted',coverage:'المحاضرة الأولى والثانية',occurrenceSlots:[],occurrenceEvidence:null,details:'امتحان مادة الشبكات',evidence:'امتحان مادة الشبكات'};
  sql.prepare(`INSERT INTO academic_reports(id,author_id,author_name,source_chat_id,source_message_id,body_json,course,kind,event_date,audience,certainty,destination_chat_id,last_update_id,created_at,updated_at,dedupe_key) VALUES(?,?,'طالب',?,1,?,'networks','exam',?,?,'asserted',?,1,?,?,?)`).run(id,uid,-1001111111111,JSON.stringify(item),date,audience,CHANNEL,NOW,NOW,await academicDuplicateKey(item,NOW));
 };
 return{sql,db,seed,reset:()=>{queries=0;},count:()=>queries,beforeBatch:(f:()=>void)=>{hook=f;}};
}
const source=(id=1,uid=ADMIN,text=TEXT)=>({updateId:id,userId:uid,userName:'طالب',chatId:uid,threadId:null,messageId:id,text,now:NOW});
afterEach(()=>{vi.restoreAllMocks();for(const db of dbs.splice(0))db.close();});
describe('explicit bulk audience edits',()=>{
 it.each([TEXT,'عدل كل التبليغات للمجموعتين A و B','اريد تعدل التبليغات كلها للمجموعتين'])('parses %s as a group change rather than a new announcement',text=>{
  expect(bulkAcademicEditIntent(text)).toBe(true);expect(bulkAudiencePatch(text,new Date(NOW))?.audience).toBe('all');
 });
 it.each(['لا تعدل كل التبليغات للمجموعتين','شلون اعدل كل التبليغات للمجموعتين','قال عدل كل التبليغات للمجموعتين','لو اعدل كل التبليغات للمجموعتين؟'])('does not execute %s',text=>expect(bulkAcademicEditIntent(text)).toBe(false));
 it.each(['عدل كل التبليغات للمجموعتين A أو B','عدل كل التبليغات للمجموعتين وخلي الامتحان السبت 7/11','عدل كل التبليغات واكتب امتحان غدا','اريد تعدل التبليغ لكل المواد وتكتب المجموعة','عدل كل التبليغات للمجموعة C'])('does not silently ignore an ambiguous or additional change: %s',text=>expect(bulkAudiencePatch(text,new Date(NOW))).toBeNull());
 it.each([['عدل كل التبليغات للمجموعة A','A'],['عدل كل التبليغات للمجموعة B','B']])('distinguishes all target records from the requested audience: %s',(text,audience)=>expect(bulkAudiencePatch(text,new Date(NOW))?.audience).toBe(audience));
 it('updates existing rows in one transaction, keeps reading/time/date and original author, and replays without changing revisions',async()=>{
  const f=fixture();await f.seed('ar-1-0');await f.seed('ar-2-0',null,'2026-11-07',123);f.reset();
  const a=await applyBulkAudienceEdit(f.db,source(10,SECOND),bulkAudiencePatch(TEXT,new Date(NOW))!);f.reset();
  const b=await applyBulkAudienceEdit(f.db,source(10,SECOND),bulkAudiencePatch(TEXT,new Date(NOW))!);
  expect(a).toEqual(b);expect(a.references).toHaveLength(2);
  const rows=f.sql.prepare('SELECT * FROM academic_reports ORDER BY id').all();expect(rows).toHaveLength(2);
  for(const row of rows){const item=JSON.parse(String(row.body_json));expect(row.revision).toBe(2);expect(row.audience).toBe('all');expect(item.coverage).toBe('المحاضرة الأولى والثانية');expect(item.time).toBe('09:00');}
  expect(rows[1]?.author_id).toBe(123);
  expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_report_changes').get()?.n).toBe(2);
  f.reset();await applyBulkAudienceEdit(f.db,source(11),bulkAudiencePatch(TEXT,new Date(NOW))!);
  expect(f.sql.prepare('SELECT MAX(revision) AS n FROM academic_reports').get()?.n).toBe(2);
 });
 it('rejects a student and an unrelated group without changing data',async()=>{
  const f=fixture();await f.seed('ar-1-0');
  expect((await applyBulkAudienceEdit(f.db,source(20,123),{audience:'all',course:null,kinds:null})).text).toContain('صلاحيات');
  expect((await applyBulkAudienceEdit(f.db,{...source(21),chatId:-100999},{audience:'all',course:null,kinds:null})).text).toContain('المرتبط');
  expect(f.sql.prepare('SELECT revision FROM academic_reports').get()?.revision).toBe(1);
 });
 it('does not partly edit a batch if any target changes before the transaction',async()=>{
  const f=fixture();await f.seed('ar-1-0');await f.seed('ar-2-0',null,'2026-11-07');
  f.beforeBatch(()=>f.sql.exec("UPDATE academic_reports SET revision=2 WHERE id='ar-2-0'"));
  const result=await applyBulkAudienceEdit(f.db,source(30),{audience:'all',course:null,kinds:null});
  expect(result.reportIds).toHaveLength(0);expect(result.text).toContain('ما طبقت جزءاً');
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM academic_reports WHERE audience='all'").get()?.n).toBe(0);
 });
 it('keeps receipts for content that was already identical when merging legacy no-op duplicates',async()=>{
  const f=fixture();await f.seed('ar-1-0','all');
  f.sql.exec("UPDATE academic_reports SET dedupe_key=NULL WHERE id='ar-1-0'");await f.seed('ar-2-0','all');
  f.sql.exec("UPDATE academic_reports SET dedupe_key=NULL WHERE id='ar-2-0'");
  f.sql.prepare("INSERT INTO publication_receipts VALUES('academic','ar-2-0',1,?,0,100,?,'identical-send')").run(CHANNEL,NOW);
  const result=await applyBulkAudienceEdit(f.db,source(39),{audience:'all',course:null,kinds:null});
  expect(result.text).toContain('دمجت 1');expect(f.sql.prepare("SELECT message_id FROM publication_receipts WHERE record_id='ar-1-0' AND revision=1").get()?.message_id).toBe(100);
 });
 it('merges records that become identical without pretending their old differently addressed messages published the new version',async()=>{
  const f=fixture();await f.seed('ar-1-0','A');await f.seed('ar-2-0','B');
  f.sql.prepare("INSERT INTO publication_receipts VALUES('academic','ar-2-0',1,?,0,100,?,'old-send')").run(CHANNEL,NOW);
  const result=await applyBulkAudienceEdit(f.db,source(40),{audience:'all',course:null,kinds:null});
  expect(result.text).toContain('دمجت 1');expect(f.sql.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(1);
  expect(f.sql.prepare("SELECT COUNT(*) AS n FROM publication_receipts WHERE record_id='ar-1-0' AND revision=2").get()?.n).toBe(0);
 });
});
