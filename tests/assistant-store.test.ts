import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assistantStorageReady, claimAssistantTurn, finishAssistantTurn, releaseAssistantTurn,
  reserveAssistantTurnUser, type AssistantTurn } from '../src/assistant-store';

const NOW=Date.parse('2026-10-24T10:00:00Z');
const databases:DatabaseSync[]=[];
function database(admission=true,diagnostics=true) {
  const sql=new DatabaseSync(':memory:');databases.push(sql);let statements=0;
  for(const name of readdirSync(new NodeURL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) {
    if(!admission && name==='0009_assistant_turn_admission.sql') continue;
    if(!diagnostics && name==='0011_assistant_diagnostics.sql') continue;
    sql.exec(readFileSync(new NodeURL(`../migrations/${name}`,import.meta.url),'utf8'));
  }
  const prepare=(query:string,parameters:(string|number|null)[]=[])=>{
    const execute=(mode:'run'|'all'|'first')=>{
      statements++;const statement=sql.prepare(query);
      if(mode==='first') return statement.get(...parameters)??null;
      if(mode==='all') return {success:true,results:statement.all(...parameters),meta:{changes:0}};
      return {success:true,meta:{changes:Number(statement.run(...parameters).changes)}};
    };
    return {bind(...values:(string|number|null)[]){return prepare(query,values);},async first(){return execute('first');},
      async all(){return execute('all');},async run(){return execute('run');},execute};
  };
  const db={prepare,batch:async(items:ReturnType<typeof prepare>[])=>{
    sql.exec('BEGIN');try {const results=items.map(item=>item.execute('run'));sql.exec('COMMIT');return results;}
    catch(error) {sql.exec('ROLLBACK');throw error;}
  }} as unknown as D1Database;
  return {db,sql,count:()=>statements,reset:()=>{statements=0;}};
}
function turn(id='message:1',now=NOW):AssistantTurn {
  return {id,scope:'-100:0:42',userId:42,chatId:-100,threadId:null,messageId:1,question:'بالخميس كوز رسومات',now};
}
afterEach(()=>{for(const sql of databases.splice(0)) sql.close();});

describe('durable assistant turn admission',()=>{
  it('adds diagnostic columns without changing existing conversations and fails closed before migration',async()=>{
    const {db,sql}=database(true,false);
    sql.prepare("INSERT INTO assistant_turns(id,scope,user_id,chat_id,message_id,question,reply_plain,state,created_at) VALUES('old','1:0:1',1,1,1,'سؤال قديم','جواب قديم','ready',?)").run(NOW);
    expect(await assistantStorageReady(db)).toBe(false);
    sql.exec(readFileSync(new NodeURL('../migrations/0011_assistant_diagnostics.sql',import.meta.url),'utf8'));
    expect(await assistantStorageReady(db)).toBe(true);
    expect(sql.prepare("SELECT question,reply_plain,diagnostic_json,completed_at,delivered_at FROM assistant_turns WHERE id='old'").get())
      .toEqual({question:'سؤال قديم',reply_plain:'جواب قديم',diagnostic_json:null,completed_at:null,delivered_at:null});
  });
  it('requires the admission migration while checking all tables in one query',async()=>{
    const {db,sql,count,reset}=database(false);
    reset();expect(await assistantStorageReady(db)).toBe(false);expect(count()).toBe(1);
    sql.exec(readFileSync(new NodeURL('../migrations/0009_assistant_turn_admission.sql',import.meta.url),'utf8'));
    reset();expect(await assistantStorageReady(db)).toBe(true);expect(count()).toBe(1);
  });

  it('charges a message once and exposes admission on lease recovery and completion',async()=>{
    const {db,sql,count,reset}=database();const initial=turn();
    const claimed=await claimAssistantTurn(db,initial);expect(claimed).toMatchObject({ready:false,resuming:false,userAdmitted:false});
    reset();expect(await reserveAssistantTurnUser(db,initial,claimed.token!)).toBe(true);expect(count()).toBe(2);
    await releaseAssistantTurn(db,initial.id,claimed.token!);
    const replay=turn(initial.id,NOW+1_000);const reclaimed=await claimAssistantTurn(db,replay);
    expect(reclaimed).toMatchObject({ready:false,resuming:true,userAdmitted:true});
    expect(await reserveAssistantTurnUser(db,replay,reclaimed.token!)).toBe(true);
    expect(sql.prepare('SELECT requests,minute_requests FROM assistant_user_limits').get()).toEqual({requests:1,minute_requests:1});
    expect(await finishAssistantTurn(db,replay,reclaimed.token!,'انحفظ','انحفظ',[])).toBe(true);
    expect(await claimAssistantTurn(db,turn(initial.id,NOW+2_000))).toMatchObject({token:null,ready:true,userAdmitted:true});
  });

  it('makes simultaneous reservations of the same owned turn idempotent',async()=>{
    const {db,sql}=database();const current=turn();const claimed=await claimAssistantTurn(db,current);
    expect(await Promise.all(Array.from({length:8},()=>reserveAssistantTurnUser(db,current,claimed.token!)))).toEqual(Array(8).fill(true));
    expect(sql.prepare('SELECT requests,minute_requests FROM assistant_user_limits').get()).toEqual({requests:1,minute_requests:1});
  });

  it('enforces the shared six-per-minute user limit across different turns',async()=>{
    const {db,sql}=database();const attempts=await Promise.all(Array.from({length:9},async(_,index)=>{
      const current=turn(`message:${index}`),claimed=await claimAssistantTurn(db,current);
      return reserveAssistantTurnUser(db,current,claimed.token!);
    }));
    expect(attempts.filter(Boolean)).toHaveLength(6);
    expect(sql.prepare('SELECT requests,minute_requests FROM assistant_user_limits').get()).toEqual({requests:6,minute_requests:6});
    expect(sql.prepare('SELECT SUM(user_admitted) AS n FROM assistant_turns').get()?.n).toBe(6);
  });

  it('can admit an uncharged turn after the minute recovers without charging denied attempts',async()=>{
    const {db,sql}=database();const current=turn();const claimed=await claimAssistantTurn(db,current);
    sql.prepare('INSERT INTO assistant_user_limits(user_id,period,requests,minute,minute_requests) VALUES(?,?,?,?,?)')
      .run(42,'d:2026-10-24',6,Math.floor(NOW/60_000),6);
    expect(await reserveAssistantTurnUser(db,current,claimed.token!)).toBe(false);
    expect(sql.prepare('SELECT user_admitted FROM assistant_turns').get()?.user_admitted).toBe(0);
    const replay=turn(current.id,NOW+60_000);const reclaimed=await claimAssistantTurn(db,replay);
    expect(reclaimed.userAdmitted).toBe(false);
    expect(await reserveAssistantTurnUser(db,replay,reclaimed.token!)).toBe(true);
    expect(sql.prepare('SELECT requests,minute_requests FROM assistant_user_limits').get()).toEqual({requests:7,minute_requests:1});
  });

  it('does not readmit an already charged turn when user quota later fills or crosses a day',async()=>{
    const {db,sql}=database();const current=turn();const claimed=await claimAssistantTurn(db,current);
    expect(await reserveAssistantTurnUser(db,current,claimed.token!)).toBe(true);
    sql.prepare('UPDATE assistant_user_limits SET requests=60,minute_requests=6').run();
    const replay=turn(current.id,NOW+86_400_000);const reclaimed=await claimAssistantTurn(db,replay);
    expect(reclaimed.userAdmitted).toBe(true);
    expect(await reserveAssistantTurnUser(db,replay,reclaimed.token!)).toBe(true);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM assistant_user_limits').get()?.n).toBe(1);
    expect(sql.prepare('SELECT requests FROM assistant_user_limits').get()?.requests).toBe(60);
  });

  it('does not charge missing, expired, mismatched-user, stale-lease or completed turns',async()=>{
    const {db,sql}=database();const current=turn();const claimed=await claimAssistantTurn(db,current);
    expect(await reserveAssistantTurnUser(db,turn('missing'),claimed.token!)).toBe(false);
    expect(await reserveAssistantTurnUser(db,{...current,userId:99},claimed.token!)).toBe(false);
    expect(await reserveAssistantTurnUser(db,{...current,now:NOW+60_000},claimed.token!)).toBe(false);
    const replay=turn(current.id,NOW+60_000);const reclaimed=await claimAssistantTurn(db,replay);
    expect(await reserveAssistantTurnUser(db,replay,claimed.token!)).toBe(false);
    expect(await finishAssistantTurn(db,replay,reclaimed.token!,'جواب','جواب',[])).toBe(true);
    expect(await reserveAssistantTurnUser(db,replay,reclaimed.token!)).toBe(false);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM assistant_user_limits').get()?.n).toBe(0);
  });

  it('rolls quota back when durable admission cannot be recorded',async()=>{
    const {db,sql}=database();const current=turn();const claimed=await claimAssistantTurn(db,current);
    sql.exec("CREATE TRIGGER fail_admission BEFORE UPDATE OF user_admitted ON assistant_turns WHEN NEW.user_admitted=1 BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
    await expect(reserveAssistantTurnUser(db,current,claimed.token!)).rejects.toThrow('simulated write failure');
    expect(sql.prepare('SELECT COUNT(*) AS n FROM assistant_user_limits').get()?.n).toBe(0);
    expect(sql.prepare('SELECT user_admitted FROM assistant_turns').get()?.user_admitted).toBe(0);
    sql.exec('DROP TRIGGER fail_admission');
    expect(await reserveAssistantTurnUser(db,current,claimed.token!)).toBe(true);
    expect(sql.prepare('SELECT requests FROM assistant_user_limits').get()?.requests).toBe(1);
  });
});
