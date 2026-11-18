import { isAdmin } from './admin';
import { EventStore } from './event-store';
import type { TelegramMessage, TelegramUpdate } from './types';

export type ManualAction = { action: string; [key: string]: unknown };
export interface ManualScope { userId: number; chatId: number; threadId: number | null }
export interface ManualForm { kind: string; field: string; draft: Record<string, unknown>; ref?: unknown; expectedRevision?: number }
export interface SavedManualForm { revision: number; promptId: number; expiresAt: number; form: ManualForm }
export const manualScope = (message: TelegramMessage): ManualScope => ({ userId: message.from!.id, chatId: message.chat.id, threadId: message.message_thread_id ?? null });
export async function requireManualAdmin(db: D1Database, scope: ManualScope): Promise<void> {
  const settings = await new EventStore(db).getSettings();
  if (scope.chatId !== scope.userId || scope.chatId <= 0 || !isAdmin(scope.userId, settings.ownerUid)) throw new Error('MANUAL_FORBIDDEN');
}
export async function saveManualPanel(db: D1Database, scope: ManualScope, messageId: number, actions: ManualAction[], now: number): Promise<string> {
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  await db.prepare('INSERT INTO manual_panels(token,user_id,chat_id,thread_id,message_id,actions_json,expires_at) VALUES(?,?,?,?,?,?,?)')
    .bind(token, scope.userId, scope.chatId, scope.threadId ?? 0, messageId, JSON.stringify(actions), now + 10 * 60000).run();
  return token;
}
/** Consume the whole panel, so two different buttons cannot commit from one stale view. */
export async function consumeManualPanel(db: D1Database, update: TelegramUpdate, now: number): Promise<ManualAction | null> {
  const q = update.callback_query;
  const match = /^man:([a-f0-9]{24}):(\d{1,2})$/.exec(q?.data ?? '');
  if (!q?.message || !match || q.message.chat.type !== 'private' || q.from.id !== q.message.chat.id || q.from.is_bot) return null;
  const row = await db.prepare(`UPDATE manual_panels SET consumed_update_id=? WHERE token=? AND user_id=? AND chat_id=? AND thread_id=?
    AND message_id=? AND expires_at>? AND (consumed_update_id IS NULL OR consumed_update_id=?) RETURNING actions_json`)
    .bind(update.update_id, match[1], q.from.id, q.message.chat.id, q.message.message_thread_id ?? 0, q.message.message_id, now, update.update_id)
    .first<{ actions_json: string }>();
  if (!row) return null;
  const actions = JSON.parse(row.actions_json) as ManualAction[];
  return actions[Number(match[2])] ?? null;
}
export async function invalidateManualPanels(db: D1Database, scope: ManualScope): Promise<void> {
  await db.prepare('DELETE FROM manual_panels WHERE user_id=? AND chat_id=? AND thread_id=?').bind(scope.userId, scope.chatId, scope.threadId ?? 0).run();
}
export async function getManualForm(db: D1Database, scope: ManualScope): Promise<SavedManualForm | null> {
  const row = await db.prepare('SELECT revision,body_json,prompt_id,expires_at FROM manual_forms WHERE user_id=? AND chat_id=? AND thread_id=?')
    .bind(scope.userId, scope.chatId, scope.threadId ?? 0).first<{revision:number;body_json:string;prompt_id:number;expires_at:number}>();
  return row ? { revision: row.revision, form: JSON.parse(row.body_json) as ManualForm, promptId: row.prompt_id, expiresAt: row.expires_at } : null;
}
export async function saveManualForm(db: D1Database, scope: ManualScope, form: ManualForm, promptId: number, now: number, expected?: number): Promise<boolean> {
  const result = expected === undefined
    ? await db.prepare(`INSERT INTO manual_forms(user_id,chat_id,thread_id,body_json,prompt_id,expires_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,chat_id,thread_id) DO UPDATE SET revision=manual_forms.revision+1,body_json=excluded.body_json,prompt_id=excluded.prompt_id,expires_at=excluded.expires_at`)
      .bind(scope.userId, scope.chatId, scope.threadId ?? 0, JSON.stringify(form), promptId, now + 10 * 60000).run()
    : await db.prepare('UPDATE manual_forms SET revision=revision+1,body_json=?,prompt_id=?,expires_at=? WHERE user_id=? AND chat_id=? AND thread_id=? AND revision=?')
      .bind(JSON.stringify(form), promptId, now + 10 * 60000, scope.userId, scope.chatId, scope.threadId ?? 0, expected).run();
  return !!result.meta.changes;
}
export async function clearManualForm(db: D1Database, scope: ManualScope): Promise<void> {
  await db.prepare('DELETE FROM manual_forms WHERE user_id=? AND chat_id=? AND thread_id=?').bind(scope.userId, scope.chatId, scope.threadId ?? 0).run();
}

export interface ManualCommandResult { ok: boolean; id?: string; revision?: number; message: string }
/** All commands commit the nonce admission, CAS mutation and replay result together. */
export async function manualCommand(db: D1Database, scope: ManualScope, updateId: number, request: unknown, now: number,
  mutate: (gate: string, bindings: (string | number)[], operationId: string) => D1PreparedStatement[], success: ManualCommandResult): Promise<ManualCommandResult> {
  await requireManualAdmin(db, scope);
  const id = `manual:${updateId}`, encoded = JSON.stringify(request);
  const existing = await db.prepare('SELECT actor_id,chat_id,request_json,result_json FROM manual_operations WHERE id=?').bind(id)
    .first<{actor_id:number;chat_id:number;request_json:string;result_json:string|null}>();
  if (existing) {
    if (existing.actor_id !== scope.userId || existing.chat_id !== scope.chatId || existing.request_json !== encoded) throw new Error('MANUAL_IDENTITY_MISMATCH');
    if (existing.result_json) return JSON.parse(existing.result_json) as ManualCommandResult;
  }
  const nonce = crypto.randomUUID();
  const gate = 'EXISTS(SELECT 1 FROM manual_operations WHERE id=? AND nonce=? AND result_json IS NULL)';
  const statements = mutate(gate, [id, nonce], id);
  if (!statements.length) throw new Error('MANUAL_EMPTY_COMMAND');
  const failure: ManualCommandResult = {ok:false,message:'السجل تغيّر أو الطلب قديم؛ اعرض آخر نسخة.'};
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO manual_operations(id,actor_id,chat_id,request_json,nonce,created_at) VALUES(?,?,?,?,?,?)').bind(id,scope.userId,scope.chatId,encoded,nonce,now),
    statements[0]!,
    db.prepare('UPDATE manual_operations SET changed=changes() WHERE id=? AND nonce=?').bind(id,nonce),
    ...statements.slice(1),
    db.prepare('UPDATE manual_operations SET result_json=CASE WHEN changed>0 THEN ? ELSE ? END WHERE id=? AND nonce=?')
      .bind(JSON.stringify(success),JSON.stringify(failure),id,nonce),
  ]);
  const final = await db.prepare('SELECT actor_id,chat_id,request_json,result_json FROM manual_operations WHERE id=?').bind(id)
    .first<{actor_id:number;chat_id:number;request_json:string;result_json:string|null}>();
  if (!final?.result_json || final.actor_id!==scope.userId || final.chat_id!==scope.chatId || final.request_json!==encoded) throw new Error('MANUAL_COMMAND_LOST');
  return JSON.parse(final.result_json) as ManualCommandResult;
}
export function cleanManualText(value: string, maximum = 2600, required = true): string {
  const text = value.normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/g,'').trim();
  if ((required && !text) || Array.from(text).length > maximum) throw new RangeError('النص غير صالح أو أطول من الحد.');
  return text;
}
export function parseManualDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00+03:00`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) throw new RangeError('اكتب التاريخ YYYY-MM-DD بشكل صحيح.');
  return value;
}
export function parseManualTime(value: string): string {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RangeError('اكتب الوقت HH:MM بنظام 24 ساعة.');
  return value;
}
export function parseManualDue(value: string, now: number): number {
  const [date,time,...rest] = value.trim().split(/\s+/);
  if (!date || !time || rest.length) throw new RangeError('اكتب YYYY-MM-DD HH:MM بتوقيت بغداد.');
  const due = Date.parse(`${parseManualDate(date)}T${parseManualTime(time)}:00+03:00`);
  if (due <= now || due > now+366*86400000) throw new RangeError('اختار موعداً قادماً خلال سنة.');
  return due;
}
