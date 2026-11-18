import {extractEventQuery} from './event-extract';
import {normalizeArabic} from './input';
import {parseAssistantLinks,serializeAssistantLinks,type AssistantReference} from './assistant-references';
const norm=(s:string)=>normalizeArabic(s).replace(/ة/g,'ه').replace(/ى/g,'ي');
export const publicationScope=(userId:number,chatId:number,threadId:number|null)=>`${chatId}:${threadId??0}:${userId}`;
export function publicationFollowupCandidate(text:string,now:Date):boolean {
 const n=norm(text);if(/^(?:اي|نعم|نشره|انشره|تمام|الغي الطلب|الغيه|لا|وقف الطلب)$/u.test(n))return true;
 if(n.length>100||/[؟?]/u.test(text)||/(?:احفظ|سجل|عدنا|عندنا|عدل|اشرح|شنو|ليش|قال|مثلا|اذا|لو)/u.test(n))return false;
 const q=extractEventQuery(text,now);
 return !q.clarification&&!!(q.course||q.date||q.kind||q.kinds?.length||q.audience);
}
export async function rememberPublication(db:D1Database,scope:string,updateId:number,refs:AssistantReference[],now:number,promptId:number|null=null,referencedId:number|null=null):Promise<void> {
 if(!refs.length||refs.length>32)return;
 await db.prepare(`INSERT INTO admin_publication_context(scope,references_json,request_update_id,expires_at,prompt_message_id,referenced_message_id) VALUES(?,?,?,?,?,?)
   ON CONFLICT(scope) DO UPDATE SET references_json=excluded.references_json,request_update_id=excluded.request_update_id,
     consumed_update_id=NULL,expires_at=excluded.expires_at,prompt_message_id=excluded.prompt_message_id,referenced_message_id=excluded.referenced_message_id
     WHERE admin_publication_context.request_update_id<>excluded.request_update_id`)
  .bind(scope,serializeAssistantLinks([],refs),updateId,now+5*60000,promptId,referencedId).run();
}
export async function pendingPublication(db:D1Database,scope:string,updateId:number,now:number,replyId?:number):Promise<{refs:AssistantReference[];requestId:number}|null> {
 const row=await db.prepare(`SELECT references_json,request_update_id,prompt_message_id,referenced_message_id FROM admin_publication_context p WHERE scope=? AND expires_at>?
   AND (consumed_update_id IS NULL OR consumed_update_id=?)
   AND NOT EXISTS(SELECT 1 FROM assistant_turns t WHERE t.scope=p.scope AND t.state='ready'
     AND COALESCE(t.delivered_at,t.completed_at,t.created_at)>p.expires_at-300000)`)
  .bind(scope,now,updateId).first<{references_json:string;request_update_id:number;prompt_message_id:number|null;referenced_message_id:number|null}>();
 if(!row)return null;
 if(replyId!==undefined&&replyId!==row.prompt_message_id&&replyId!==row.referenced_message_id)return null;
 const refs=parseAssistantLinks(row.references_json).references;return refs.length?{refs,requestId:row.request_update_id}:null;
}
export async function consumePublication(db:D1Database,scope:string,requestId:number,updateId:number,now:number):Promise<boolean> {
 const result=await db.prepare(`UPDATE admin_publication_context SET consumed_update_id=? WHERE scope=? AND request_update_id=?
   AND expires_at>? AND (consumed_update_id IS NULL OR consumed_update_id=?)`).bind(updateId,scope,requestId,now,updateId).run();
 return !!result.meta.changes;
}
