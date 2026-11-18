import { CHANNEL_TIMES, validSchoolClosures } from './channel-calendar';
import { getBaghdadNow } from './calendar';
import { EventStore, type JobRecord } from './event-store';
import { TelegramError, type TelegramMethod } from './telegram';
import { requireManualAdmin, type ManualScope } from './manual-store';
import { isBriefKey, type BriefKey } from './brief-schedule';

const MINUTE = 60_000;
export type ControlledFamily = 'official' | 'academic' | 'prayer' | 'news' | 'brief';
export const CONTROLLED_PRIORITIES: Record<ControlledFamily, number> = { official: 100, academic: 80, prayer: 120, news: 40, brief: 60 };
export interface ControlledOutgoing {
  chatId: number; method: TelegramMethod; payload: Record<string, unknown>;
  family?: ControlledFamily; priority?: number; expiresAt?: number;
  executionWindow?: { start: number; end: number };
  config?: { key: string; generation: number };
}
export interface ControlledTelegram { call<T>(method: TelegramMethod, payload?: unknown): Promise<T> }
export interface ControlledHandler {
  types: readonly string[];
  resolve(db: D1Database, job: JobRecord, now: number): Promise<ControlledOutgoing | null>;
  delivered?(db: D1Database, job: JobRecord, outgoing: ControlledOutgoing, result: unknown, now: number): Promise<void>;
}
export interface AutomationConfiguration {
  key: string; enabled: boolean; generation: number; body: Record<string, unknown>; updatedAt: number;
}
interface ConfigurationRow { key:string; enabled:number; generation:number; body_json:string; updated_at:number }
interface Metadata { job_id:string; family:ControlledFamily; chat_id:number; thread_id:number; config_key:string|null; generation:number|null;
  expires_at:number; window_start:number|null; window_end:number|null; priority:number; content_id:string|null }
export interface ControlledJobRequest {
  id:string; type:string; payload:unknown; dueAt:number; chatId:number; threadId:number|null;
  family:ControlledFamily; expiresAt:number; config?:{key:string;generation:number};
  executionWindow?:{start:number;end:number}; contentId?:string; priority?:number;
}
function object(v:unknown): v is Record<string,unknown> { return !!v && typeof v==='object' && !Array.isArray(v); }
export async function getAutomationConfig(db:D1Database,key:string):Promise<AutomationConfiguration> {
  const r=await db.prepare('SELECT * FROM controlled_config WHERE key=?').bind(key).first<ConfigurationRow>();
  if(!r) return {key,enabled:false,generation:0,body:{},updatedAt:0};
  let body:Record<string,unknown>={}; try{const parsed:unknown=JSON.parse(r.body_json);if(object(parsed))body=parsed;}catch{}
  return {key:r.key,enabled:r.enabled===1,generation:r.generation,body,updatedAt:r.updated_at};
}
/** All changes invalidate queued snapshots. Product activation requires an explicit legacy backlog review. */
export async function configureAutomation(db:D1Database,key:'product'|'news'|'religion'|BriefKey,patch:{enabled?:boolean;body?:Record<string,unknown>;expectedGeneration?:number},now=Date.now()):Promise<AutomationConfiguration> {
  if(key!=='product'&&key!=='news'&&key!=='religion'&&!isBriefKey(key))throw new RangeError('Invalid automation setting.');
  const current=await getAutomationConfig(db,key),body={...current.body,...patch.body};
  if(patch.expectedGeneration!==undefined&&patch.expectedGeneration!==current.generation)throw new Error('الإعداد تغيّر؛ افتح آخر نسخة.');
  if(key==='product' && patch.enabled && body.legacyReviewed!==true) throw new Error('Review the legacy pending/sending outbox before activation.');
  if (body.schoolClosures !== undefined && !validSchoolClosures(body.schoolClosures)) throw new RangeError('Invalid registered school closures.');
  if(key==='news') {
    body.minutes = [...CHANNEL_TIMES.news]; body.frequencyDays = 1;
    if(!Number.isInteger(body.frequencyDays)||Number(body.frequencyDays)<1||Number(body.frequencyDays)>30
      ||!Array.isArray(body.minutes)||!body.minutes.length||body.minutes.length>4||!body.minutes.every(n=>Number.isInteger(n)&&n>=0&&n<1440))throw new RangeError('Invalid news schedule.');
  }
  const changed=await db.prepare(`INSERT INTO controlled_config(key,enabled,generation,body_json,updated_at) VALUES(?,?,1,?,?)
    ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled,generation=controlled_config.generation+1,body_json=excluded.body_json,updated_at=excluded.updated_at WHERE controlled_config.generation=?`)
    .bind(key,Number(patch.enabled??current.enabled),JSON.stringify(body),now,current.generation).run();
  if(!changed.meta.changes)throw new Error('الإعداد تغيّر؛ افتح آخر نسخة.');
  await db.prepare(`UPDATE outbox SET state='cancelled',lease_token=NULL,lease_until=NULL,last_error='configuration_changed'
    WHERE state='pending' AND id IN(SELECT job_id FROM controlled_jobs WHERE config_key=? OR ?='product')`).bind(key,key).run();
  return getAutomationConfig(db,key);
}
function controlledJobStatements(db:D1Database,request:ControlledJobRequest,now:number):D1PreparedStatement[] {
  if(!request.type.startsWith('controlled_')||!request.id.startsWith('controlled:')||!Number.isSafeInteger(request.chatId)||request.chatId>=0
    ||!Object.hasOwn(CONTROLLED_PRIORITIES,request.family)
    ||!Number.isFinite(request.dueAt)||!Number.isFinite(request.expiresAt)||request.expiresAt<=request.dueAt)throw new RangeError('Invalid controlled job.');
  // The queue and metadata commit together; metadata references an existing outbox row.
  return [
    db.prepare('INSERT OR IGNORE INTO outbox(id,type,payload_json,due_at) VALUES(?,?,?,?)').bind(request.id,request.type,JSON.stringify(request.payload),request.dueAt),
    db.prepare(`INSERT OR IGNORE INTO controlled_jobs(job_id,family,chat_id,thread_id,config_key,generation,expires_at,window_start,window_end,priority,content_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(request.id,request.family,request.chatId,request.threadId??0,request.config?.key??null,request.config?.generation??null,
      request.expiresAt,request.executionWindow?.start??null,request.executionWindow?.end??null,request.priority??CONTROLLED_PRIORITIES[request.family],request.contentId??null,now),
  ];
}
export async function queueControlledJob(db:D1Database,request:ControlledJobRequest,now=Date.now()):Promise<boolean> {
  const result=await db.batch(controlledJobStatements(db,request,now));
  return result[0]!.meta.changes>0;
}
async function withScopeLock<T>(db:D1Database,chatId:number,now:number,action:()=>Promise<T>,busy:T,prayer=false):Promise<T> {
  if(prayer)return action();
  const token=crypto.randomUUID();
  const claim=await db.prepare(`INSERT INTO controlled_scope_locks(chat_id,lease_token,lease_until) VALUES(?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
    WHERE controlled_scope_locks.lease_until<=? RETURNING lease_token`).bind(chatId,token,now+120000,now).first<{lease_token:string}>();
  if(claim?.lease_token!==token)return busy;
  try{return await action();}finally{await db.prepare('DELETE FROM controlled_scope_locks WHERE chat_id=? AND lease_token=?').bind(chatId,token).run();}
}
async function validOutgoing(db:D1Database,out:ControlledOutgoing,meta:Metadata|null,now:number):Promise<boolean> {
  const settings=await new EventStore(db).getSettings(),product=await getAutomationConfig(db,'product');
  if(!meta||!product.enabled||product.body.legacyReviewed!==true||meta.chat_id!==settings.targetChatId||meta.thread_id!==Number(settings.targetThreadId??0)||out.chatId!==settings.targetChatId||Number(out.payload.chat_id)!==out.chatId
    ||Number(out.payload.message_thread_id??0)!==Number(settings.targetThreadId??0)||!Number.isSafeInteger(out.chatId)||out.chatId>=0
    ||!Object.hasOwn(CONTROLLED_PRIORITIES,meta.family)||!Object.hasOwn(CONTROLLED_PRIORITIES,out.family??meta.family))return false;
  const expires=out.expiresAt??meta?.expires_at;
  if(expires!==undefined&&now>=expires)return false;
  const window=out.executionWindow??(meta?.window_start!==null&&meta?.window_start!==undefined?{start:meta.window_start,end:meta.window_end!}:undefined);
  if(window&&(now<window.start||now>=window.end))return false;
  const config=out.config??(meta?.config_key&&meta.generation!==null?{key:meta.config_key,generation:meta.generation}:undefined);
  if(config){const current=await getAutomationConfig(db,config.key);if(!current.enabled||current.generation!==config.generation)return false;}
  return !['getFile','getMe','getChat','getChatMember','answerCallbackQuery','answerInlineQuery'].includes(out.method);
}
interface AttemptRow {id:string;job_id:string;outgoing_json:string;result_json:string|null;started_at:number}
async function finishCallbacks(db:D1Database,handlers:readonly ControlledHandler[],types:readonly string[],now:number):Promise<void> {
  const rows=await db.prepare(`SELECT a.* FROM controlled_attempts a JOIN outbox o ON o.id=a.job_id
    WHERE a.state='confirmed' AND a.callback_done=0 AND o.type IN(${types.map(()=>'?').join(',')})
    ORDER BY a.started_at LIMIT 1`).bind(...types).all<AttemptRow>();
  const store=new EventStore(db);
  for(const row of rows.results){const job=await store.getJob(row.job_id);if(!job)continue;const handler=handlers.find(h=>h.types.includes(job.type));if(!handler)continue;
    await handler.delivered?.(db,job,JSON.parse(row.outgoing_json) as ControlledOutgoing,JSON.parse(row.result_json??'null'),now);
    await db.prepare("UPDATE controlled_attempts SET callback_done=1 WHERE id=? AND state='confirmed'").bind(row.id).run();}
}
/** An interrupted request is ambiguous, never automatically resent. Only 429 proves a safe retry. */
export async function dispatchControlledJobs(db:D1Database,telegram:ControlledTelegram,now:number,handlers:readonly ControlledHandler[],options:{limit?:number;clock?:()=>number}={}):Promise<{sent:number;retried:number;unknown:number;cancelled:number;failed:number}> {
  const reference=now,started=performance.now(),clock=options.clock??(()=>reference+Math.floor(performance.now()-started));
  const stats={sent:0,retried:0,unknown:0,cancelled:0,failed:0},store=new EventStore(db);
  const types=[...new Set(handlers.flatMap(h=>[...h.types]))].filter(t=>t.startsWith('controlled_'));if(!types.length)return stats;
  await db.batch([
    db.prepare(`UPDATE controlled_attempts SET state='unknown',finished_at=? WHERE state='requesting' AND job_id IN
      (SELECT id FROM outbox WHERE state='sending' AND lease_until<=?)`).bind(now,now),
    db.prepare(`UPDATE outbox SET state='failed',last_error='delivery_outcome_unknown',lease_token=NULL,lease_until=NULL
      WHERE state IN ('pending','sending') AND id IN (SELECT job_id FROM controlled_attempts WHERE state='unknown')`),
  ]);
  await finishCallbacks(db,handlers,types,now);
  const ready=await db.prepare(`SELECT o.id FROM outbox o LEFT JOIN controlled_jobs j ON j.job_id=o.id WHERE
    ((o.state='pending' AND o.due_at<=?) OR (o.state='sending' AND o.lease_until<=?)) AND o.type IN(${types.map(()=>'?').join(',')})
    ORDER BY COALESCE(j.priority,100) DESC,o.due_at,o.id LIMIT ?`).bind(now,now,...types,Math.min(10,options.limit??4)).all<{id:string}>();
  if(!ready.results.length)return stats;
  const jobs=await store.claimJobs(now,ready.results.length,120000,undefined,ready.results.map(r=>r.id));
  for(const job of jobs){
    now=clock();
    if(!job.leaseToken)continue;const handler=handlers.find(h=>h.types.includes(job.type));if(!handler)continue;
    const meta=await db.prepare('SELECT * FROM controlled_jobs WHERE job_id=?').bind(job.id).first<Metadata>();
    let out=await handler.resolve(db,job,now);
    const cancel=async()=>{await store.cancelJob(job.id,job.leaseToken!);stats.cancelled++;};
    if(!out||!await validOutgoing(db,out,meta,now)){await cancel();continue;}
    await withScopeLock(db,out.chatId,now,async()=>{
      now=clock();
      out=await handler.resolve(db,job,now);if(!out||!await validOutgoing(db,out,meta,now)){await cancel();return;}
      const family=out.family??meta?.family??'official',priority=out.priority??meta?.priority??CONTROLLED_PRIORITIES[family];
      // Prayer windows are exact: ordinary posts must yield, never cancel a prayer.
      if (job.type !== 'controlled_prayer' && job.type !== 'controlled_manual') {
        const recent=await db.prepare(`SELECT MAX(sent_at + CASE WHEN family='prayer' AND job_id LIKE 'controlled:prayer:%' THEN 20 ELSE 30 END * 60000) AS next
          FROM controlled_deliveries WHERE chat_id=? AND job_id<>? AND sent_at>?`).bind(out.chatId,job.id,now-30*MINUTE).first<{next:number|null}>();
        const important=await db.prepare(`SELECT MIN(o.due_at + CASE WHEN o.type='controlled_prayer' THEN 20 ELSE 30 END * 60000) AS next
          FROM outbox o JOIN controlled_jobs j ON j.job_id=o.id WHERE j.chat_id=? AND j.priority>? AND o.state IN ('pending','sending')
          AND o.due_at BETWEEN ? AND ?`).bind(out.chatId,priority,now-15*MINUTE,now+20*MINUTE).first<{next:number|null}>();
        const possible=await db.prepare(`SELECT MAX(started_at + 30*60000) AS next FROM controlled_attempts WHERE job_id<>?
          AND state IN ('requesting','unknown') AND started_at>? AND json_extract(outgoing_json,'$.chatId')=?`)
          .bind(job.id,now-30*MINUTE,out.chatId).first<{next:number|null}>();
        const next=Math.max(now,recent?.next??0,important?.next??0,possible?.next??0);
        // Fixed devotional slots may not be prepared yet; a delayed news item still yields to them.
        const minute=getBaghdadNow(new Date(next)).minuteOfDay;
        const crowdsFixed=family==='news' && [CHANNEL_TIMES.dhikr,...CHANNEL_TIMES.news.filter(m=>m!==getBaghdadNow(new Date(job.dueAt)).minuteOfDay)]
          .some(m=>minute<=m && m-minute<30);
        if (crowdsFixed || next >= (out.expiresAt??meta!.expires_at)) { await cancel(); return; }
        if(next>now){await store.retryJob(job.id,job.leaseToken!,next,'controlled_collision');stats.retried++;return;}
      }
      const attemptId=crypto.randomUUID();
      await db.prepare("INSERT INTO controlled_attempts(id,job_id,lease_token,state,started_at,outgoing_json) VALUES(?,?,?,'requesting',?,?)")
        .bind(attemptId,job.id,job.leaseToken,now,JSON.stringify(out)).run();
      let result:unknown;
      try{result=await telegram.call(out.method,out.payload);}catch(error){
        now=clock();
        const code=error instanceof TelegramError?error.code:0,safeRetry=code===429,definite=code>=400&&code<500;
        await db.prepare('UPDATE controlled_attempts SET state=?,finished_at=?,error_code=? WHERE id=?').bind(definite?'not_sent':'unknown',now,code,attemptId).run();
        if(code===400 && job.type==='controlled_news' && ['sendPhoto','sendVideo'].includes(out.method) && object(job.payload) && job.payload.previewOnly!==true){
          await db.prepare("UPDATE outbox SET payload_json=json_set(payload_json,'$.previewOnly',json('true')) WHERE id=? AND lease_token=?").bind(job.id,job.leaseToken).run();
          await store.retryJob(job.id,job.leaseToken!,now+1000,'media_rejected_preview');stats.retried++;
        } else if(safeRetry&&job.attempts<8){const retry=Math.max(1000,(error as TelegramError).retryAfter*1000);await store.retryJob(job.id,job.leaseToken!,now+retry,'telegram_429');stats.retried++;}
        else{await store.failJob(job.id,job.leaseToken!,definite?`telegram_${code}`:'delivery_outcome_unknown');if(definite)stats.failed++;else stats.unknown++;}
        return;
      }
      now=clock();
      const messageId=object(result)&&Number.isSafeInteger(result.message_id)?Number(result.message_id):null;
      if(messageId===null&&out.method!=='deleteMessage'){
        await db.prepare("UPDATE controlled_attempts SET state='unknown',finished_at=? WHERE id=?").bind(now,attemptId).run();
        await store.failJob(job.id,job.leaseToken!,'delivery_response_missing_id');stats.unknown++;return;
      }
      await db.batch([
        db.prepare("UPDATE controlled_attempts SET state='confirmed',finished_at=?,result_json=? WHERE id=? AND state='requesting'").bind(now,JSON.stringify(result),attemptId),
        db.prepare("UPDATE outbox SET state='sent',message_id=?,delivered_chat_id=?,lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND state='sending' AND lease_token=?")
          .bind(messageId,out.chatId,job.id,job.leaseToken),
        db.prepare(`INSERT OR IGNORE INTO controlled_deliveries(job_id,chat_id,thread_id,family,content_id,sent_at,message_id) VALUES(?,?,?,?,?,?,?)`)
          .bind(job.id,out.chatId,Number(out.payload.message_thread_id??0),family,meta?.content_id??null,now,messageId),
      ]);
      await handler.delivered?.(db,job,out,result,now);
      await db.prepare("UPDATE controlled_attempts SET callback_done=1 WHERE id=? AND state='confirmed'").bind(attemptId).run();stats.sent++;
    },undefined,job.type==='controlled_prayer');
    // Another invocation owning this scope can make progress; this lease is safe to reclaim later.
  }
  return stats;
}

/** Reconciliation is explicit and evidence-bearing; an unknown request is never changed by a timer. */
export async function reconcileControlledAttempt(db:D1Database,scope:ManualScope,id:string,resolution:'confirmed'|'not_sent',evidence:string,result:unknown,now=Date.now()):Promise<boolean>{
  await requireManualAdmin(db,scope);
  if(!evidence.trim()||evidence.length>2000)return false;
  const row=await db.prepare("SELECT job_id,outgoing_json FROM controlled_attempts WHERE id=? AND state='unknown'").bind(id).first<{job_id:string;outgoing_json:string}>();if(!row)return false;
  const out=JSON.parse(row.outgoing_json) as ControlledOutgoing,meta=await db.prepare('SELECT * FROM controlled_jobs WHERE job_id=?').bind(row.job_id).first<Metadata>();
  if(!meta||!Object.hasOwn(CONTROLLED_PRIORITIES,meta.family)||!['sendMessage','sendPhoto','sendVideo'].includes(out.method)||resolution==='confirmed'&&(!object(result)||!Number.isSafeInteger(result.message_id)||Number(result.message_id)<=0))return false;
  const batch:D1PreparedStatement[]=[db.prepare("UPDATE controlled_attempts SET state=?,reconciliation_note=?,result_json=?,finished_at=?,callback_done=0 WHERE id=? AND state='unknown'")
    .bind(resolution,`actor ${scope.userId}: ${evidence}`,JSON.stringify(result),now,id)];
  const gate="EXISTS(SELECT 1 FROM controlled_attempts WHERE id=? AND state=? AND reconciliation_note=?)",bindings=[id,resolution,`actor ${scope.userId}: ${evidence}`];
  if(resolution==='not_sent')batch.push(db.prepare(`UPDATE outbox SET state='pending',due_at=?,last_error='reconciled_not_sent' WHERE id=? AND state='failed' AND ${gate}`).bind(now,row.job_id,...bindings));
  else batch.push(db.prepare(`UPDATE outbox SET state='sent',message_id=?,delivered_chat_id=?,last_error='reconciled_confirmed' WHERE id=? AND state='failed' AND ${gate}`).bind((result as {message_id:number}).message_id,out.chatId,row.job_id,...bindings),
    db.prepare(`INSERT OR IGNORE INTO controlled_deliveries(job_id,chat_id,thread_id,family,content_id,sent_at,message_id) SELECT ?,?,?,?,?,?,? WHERE ${gate}`).bind(row.job_id,out.chatId,meta.thread_id,meta.family,meta.content_id,now,(result as {message_id:number}).message_id,...bindings));
  const committed=await db.batch(batch);return (committed[0]?.meta.changes??0)>0;
}

export { handleAutomationUpdate } from './automation-interface';
