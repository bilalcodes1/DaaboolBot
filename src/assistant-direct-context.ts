import { assistantScope } from './assistant-store';

export interface AssistantDeliveredTurn {
  updateId: number;
  userId: number;
  chatId: number;
  threadId: number | null;
  messageId: number;
  question: string;
  now: number;
}

/** Record a factual summary only after a direct Telegram action succeeds. */
export async function recordAssistantDeliveredTurn(db: D1Database, turn: AssistantDeliveredTurn,
  summary: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO assistant_turns
    (id,scope,user_id,chat_id,thread_id,message_id,question,reply_plain,report_ids_json,state,created_at,completed_at,delivered_at,diagnostic_json)
    VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?,?,?)`)
    .bind(`message:${turn.updateId}`, assistantScope(turn.userId, turn.chatId, turn.threadId),
      turn.userId, turn.chatId, turn.threadId, turn.messageId, turn.question.slice(0, 800),
      summary.slice(0, 800), '[]', turn.now,turn.now,Date.now(),JSON.stringify({version:1,reason:'local_lookup',lookupMs:0,modelMs:0,waitMs:0,deliveryMs:Math.max(0,Date.now()-turn.now)})).run();
}
