import {staleAcademicConversation} from './academic-history';
import type { JobRecord } from './event-store';
import { escapeHtml } from './format';
import { parseAssistantLinks, serializeAssistantLinks, type AssistantReference } from './assistant-references';
import type { TurnDiagnostic } from './assistant-diagnostics';

/** All generated prose is escaped; existing renderers keep each tag on one line. */
export function splitAssistantHtml(text:string):string[] {
  const pages:string[]=[];let page='';
  for(const line of text.split('\n')) {
    if(line.length>3800) {
      if(page) {pages.push(page);page='';}
      const unformatted=line.replace(/<[^>]*>/g,'').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
      const characters=Array.from(unformatted);
      for(let i=0;i<characters.length;i+=500) pages.push(escapeHtml(characters.slice(i,i+500).join('')));
    } else if(page.length+line.length+1>3800) {pages.push(page);page=line;}
    else page+=`${page?'\n':''}${line}`;
  }
  if(page) pages.push(page);
  return pages.length?pages:['وضحلي شنو تريد.'];
}

export interface AssistantTurn {
  id: string; scope: string; userId: number; chatId: number; threadId: number | null;
  messageId: number; question: string; now: number;
}
export async function assistantStorageReady(db:D1Database):Promise<boolean> {
  const row=await db.prepare("SELECT COUNT(*) AS n, EXISTS(SELECT 1 FROM pragma_table_info('assistant_turns') WHERE name='user_admitted') AS admission_ready, EXISTS(SELECT 1 FROM pragma_table_info('assistant_turns') WHERE name='diagnostic_json') AS diagnostics_ready FROM sqlite_master WHERE type='table' AND name IN ('assistant_ai_usage','assistant_ai_requests','academic_intakes','academic_reports','academic_report_changes','smart_reminder_config','smart_reminder_plans','smart_reminder_history','assistant_turns','assistant_user_limits','assistant_inline_limits','academic_alert_plans')").first<{n:number;admission_ready:number;diagnostics_ready:number}>();
  return row?.n===12 && row.admission_ready===1 && row.diagnostics_ready===1;
}
interface TurnRow { created_at:number; question: string; reply_plain: string | null; reply_html: string | null; report_ids_json: string | null }

/** Conversation context belongs to one person in one chat/topic; Inline never reads it. */
export function assistantScope(userId: number, chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? 0}:${userId}`;
}

export async function assistantHistory(db: D1Database, scope: string, now: number, includeHistoricalAcademic=false): Promise<{role:'user'|'assistant';content:string}[]> {
  const rows = await db.prepare("SELECT question,reply_plain,created_at FROM assistant_turns WHERE scope=? AND state='ready' AND created_at>=? ORDER BY created_at DESC,id DESC LIMIT 3")
    .bind(scope, now - 86_400_000).all<TurnRow>();
  return rows.results.reverse().filter(row=>includeHistoricalAcademic||!staleAcademicConversation(`${row.question}\n${row.reply_plain??''}`,row.created_at,new Date(now))).flatMap(row => row.reply_plain
    ? [{ role: 'user' as const, content: row.question.slice(0, 800) }, { role: 'assistant' as const, content: row.reply_plain.slice(0, 800) }] : []);
}

export async function claimAssistantTurn(db: D1Database, turn: AssistantTurn): Promise<{token:string|null;ready:boolean;resuming:boolean;userAdmitted:boolean;diagnostic:string|null}> {
  const token = crypto.randomUUID();
  const row = await db.prepare(`INSERT INTO assistant_turns(id,scope,user_id,chat_id,thread_id,message_id,question,lease_token,lease_until,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
    WHERE assistant_turns.state='processing' AND assistant_turns.lease_until<=? RETURNING created_at,user_admitted,diagnostic_json`)
    .bind(turn.id,turn.scope,turn.userId,turn.chatId,turn.threadId,turn.messageId,turn.question,token,turn.now+60_000,turn.now,turn.now).first<{created_at:number;user_admitted:number;diagnostic_json:string|null}>();
  if (row) return {token,ready:false,resuming:row.created_at!==turn.now,userAdmitted:row.user_admitted===1,diagnostic:row.diagnostic_json};
  const existing = await db.prepare('SELECT state,user_admitted FROM assistant_turns WHERE id=?').bind(turn.id).first<{state:string;user_admitted:number}>();
  return {token:null,ready:existing?.state==='ready',resuming:false,userAdmitted:existing?.user_admitted===1,diagnostic:null};
}

export async function releaseAssistantTurn(db: D1Database, id: string, token: string,diagnostic?:TurnDiagnostic): Promise<void> {
  await db.prepare("UPDATE assistant_turns SET lease_until=0,diagnostic_json=COALESCE(?,diagnostic_json) WHERE id=? AND state='processing' AND lease_token=?").bind(diagnostic?JSON.stringify(diagnostic):null,id,token).run();
}

export async function queueAssistantWait(db:D1Database,turn:AssistantTurn,reason:string):Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO outbox(id,type,payload_json,due_at)
    SELECT ?,'assistant_wait',?,? WHERE EXISTS(SELECT 1 FROM assistant_turns WHERE id=? AND state='processing')`)
    .bind(`assistant-wait:${turn.id}`,JSON.stringify({turnId:turn.id,reason}),turn.now,turn.id).run();
}
export async function assistantWaitOutgoing(db:D1Database,payload:unknown,now:number) {
  const p=payload as {turnId?:unknown;reason?:unknown}|null;if(typeof p?.turnId!=='string')return null;
  const row=await db.prepare("SELECT chat_id,thread_id,message_id FROM assistant_turns WHERE id=? AND state='processing' AND created_at>?")
    .bind(p.turnId,now-86400000).first<{chat_id:number;thread_id:number|null;message_id:number}>();
  if(!row)return null;
  return {chatId:row.chat_id,method:'sendMessage' as const,payload:{chat_id:row.chat_id,
    text:`${['timeout','transport','provider_error'].includes(String(p.reason))?'الاتصال بخدمة الذكاء متعثر شوي.':'الخدمة مزدحمة شوي.'} طلبك بعده قيد المعالجة؛ إذا تبليغ، ما أعتبره محفوظ لحد ما أأكدلك.`,
    reply_parameters:{message_id:row.message_id,allow_sending_without_reply:true},...(row.thread_id!==null?{message_thread_id:row.thread_id}:{})}};
}

export async function reserveAssistantUser(db: D1Database, userId: number, now: number): Promise<boolean> {
  const minute = Math.floor(now/60_000);
  const day = `d:${new Date(now).toISOString().slice(0,10)}`;
  // One row and one conditional update reserve both windows atomically.
  return await db.prepare(`INSERT INTO assistant_user_limits(user_id,period,requests,minute,minute_requests)
    VALUES(?,?,1,?,1) ON CONFLICT(user_id,period) DO UPDATE SET requests=assistant_user_limits.requests+1,
    minute=excluded.minute,minute_requests=CASE WHEN assistant_user_limits.minute=excluded.minute
      THEN assistant_user_limits.minute_requests+1 ELSE 1 END
    WHERE assistant_user_limits.requests<60 AND (assistant_user_limits.minute!=excluded.minute OR assistant_user_limits.minute_requests<6)
    RETURNING user_id`).bind(userId,day,minute).first() !== null;
}

/** Charge a durable message once, even when Telegram replays a temporary AI
 * failure. D1 batches are transactional: a crash cannot charge quota without
 * recording admission. changes() refers to the preceding quota statement. */
export async function reserveAssistantTurnUser(db: D1Database, turn: AssistantTurn, token: string): Promise<boolean> {
  const minute=Math.floor(turn.now/60_000),day=`d:${new Date(turn.now).toISOString().slice(0,10)}`;
  const results=await db.batch([
    db.prepare(`INSERT INTO assistant_user_limits(user_id,period,requests,minute,minute_requests)
      SELECT ?,?,1,?,1 WHERE EXISTS(SELECT 1 FROM assistant_turns
        WHERE id=? AND user_id=? AND state='processing' AND lease_token=? AND lease_until>? AND user_admitted=0)
      ON CONFLICT(user_id,period) DO UPDATE SET requests=assistant_user_limits.requests+1,
        minute=excluded.minute,minute_requests=CASE WHEN assistant_user_limits.minute=excluded.minute
          THEN assistant_user_limits.minute_requests+1 ELSE 1 END
      WHERE assistant_user_limits.requests<60 AND (assistant_user_limits.minute!=excluded.minute OR assistant_user_limits.minute_requests<6)`)
      .bind(turn.userId,day,minute,turn.id,turn.userId,token,turn.now),
    db.prepare(`UPDATE assistant_turns SET user_admitted=1
      WHERE id=? AND user_id=? AND state='processing' AND lease_token=? AND lease_until>?
        AND (user_admitted=1 OR changes()>0)`)
      .bind(turn.id,turn.userId,token,turn.now),
  ]);
  return results[1]!.meta.changes>0;
}

export async function reserveAssistantInline(db: D1Database, userId: number, now: number): Promise<boolean> {
  return await db.prepare(`INSERT INTO assistant_inline_limits(user_id,next_at) VALUES(?,?)
    ON CONFLICT(user_id) DO UPDATE SET next_at=excluded.next_at WHERE assistant_inline_limits.next_at<=? RETURNING user_id`)
    .bind(userId,now+3500,now).first() !== null;
}

export async function finishAssistantTurn(db: D1Database, turn: AssistantTurn, token: string,
  text: string, plain: string, reportIds: readonly string[], references: readonly AssistantReference[] = [],diagnostic?:TurnDiagnostic): Promise<boolean> {
  const pages=splitAssistantHtml(text);
  const result = await db.batch([
    db.prepare("UPDATE assistant_turns SET state='ready',reply_html=?,reply_plain=?,report_ids_json=?,lease_until=NULL,completed_at=?,diagnostic_json=COALESCE(?,diagnostic_json) WHERE id=? AND state='processing' AND lease_token=?")
      .bind(text,plain,serializeAssistantLinks(reportIds,references),Date.now(),diagnostic?JSON.stringify(diagnostic):null,turn.id,token),
    ...pages.map((_,page)=>db.prepare(`INSERT OR IGNORE INTO outbox(id,type,payload_json,due_at)
      SELECT ?,'assistant_reply',?,? WHERE EXISTS(SELECT 1 FROM assistant_turns WHERE id=? AND state='ready' AND lease_token=?)`)
      .bind(`assistant-reply:${turn.id}:${page}`,JSON.stringify({turnId:turn.id,page}),turn.now+page,turn.id,token)),
  ]);
  return result[0]!.meta.changes>0;
}

export async function assistantReplyOutgoing(db: D1Database, job: JobRecord, now: number): Promise<{chatId:number;payload:Record<string,unknown>}|null> {
  const payload=job.payload as {turnId?:unknown;page?:unknown}|null;
  if(!payload || typeof payload.turnId!=='string' || !Number.isSafeInteger(payload.page) || (payload.page as number)<0) return null;
  const row=await db.prepare("SELECT chat_id,thread_id,message_id,reply_html,report_ids_json,created_at FROM assistant_turns WHERE id=? AND state='ready'")
    .bind(payload.turnId).first<{chat_id:number;thread_id:number|null;message_id:number;reply_html:string;report_ids_json:string;created_at:number}>();
  if(!row || now-row.created_at>24*60*60_000 || !row.reply_html) return null;
  const pages=splitAssistantHtml(row.reply_html);const page=pages[payload.page as number];if(!page) return null;
  const links=parseAssistantLinks(row.report_ids_json);
  const ids=payload.page===pages.length-1?links.reportIds.filter(id=>/^[a-zA-Z0-9_-]{1,48}$/.test(id)).slice(0,6):[];
  const revisions=ids.length?(await db.prepare(`SELECT id,revision FROM academic_reports WHERE id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all<{id:string;revision:number}>()).results:[];
  return {chatId:row.chat_id,payload:{chat_id:row.chat_id,text:page,parse_mode:'HTML',
    reply_parameters:{message_id:row.message_id,allow_sending_without_reply:true},
    ...(row.thread_id!==null?{message_thread_id:row.thread_id}:{}),
    ...(revisions.length && row.chat_id < 0?{reply_markup:{inline_keyboard:revisions.map((item,index)=>[{text:revisions.length===1?'تراجع عن آخر تغيير':`تراجع عن تغيير التبليغ ${index+1}`,callback_data:`aai:undo:${item.id}:${item.revision}`}])}}:{})}};
}

export async function cleanupAssistantHistory(db:D1Database,now:number):Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM assistant_turns WHERE created_at<?').bind(now-7*86_400_000),
    db.prepare('DELETE FROM assistant_user_limits WHERE period<? AND period LIKE ?').bind(`d:${new Date(now-2*86_400_000).toISOString().slice(0,10)}`,'d:%'),
    db.prepare("DELETE FROM assistant_user_limits WHERE period LIKE 'm:%' AND CAST(SUBSTR(period,3) AS INTEGER)<?").bind(Math.floor(now/60_000)-120),
    db.prepare('DELETE FROM assistant_inline_limits WHERE next_at<?').bind(now-86_400_000),
    db.prepare('DELETE FROM admin_publication_context WHERE expires_at<?').bind(now),
  ]);
}
