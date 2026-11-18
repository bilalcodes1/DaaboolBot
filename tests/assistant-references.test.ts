import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL as NodeURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAssistantLinks, resolveAssistantReferences, serializeAssistantLinks, type AssistantReference } from '../src/assistant-references';
import { assistantReplyOutgoing, assistantScope, claimAssistantTurn, finishAssistantTurn } from '../src/assistant-store';
import { EventStore } from '../src/event-store';

const NOW = Date.parse('2026-10-24T09:00:00Z');
const CHAT = -100123; const THREAD = 7;
const databases: DatabaseSync[] = [];
function database() {
  const sql = new DatabaseSync(':memory:'); databases.push(sql);
  for (const name of readdirSync(new NodeURL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new NodeURL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const prepare = (query: string, values: (string | number | null)[] = []) => ({
    bind(...next: (string | number | null)[]) { return prepare(query, next); },
    async first() { return sql.prepare(query).get(...values) ?? null; },
    async all() { return { success: true, results: sql.prepare(query).all(...values), meta: { changes: 0 } }; },
    async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; },
  });
  const db = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sql.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { sql, db };
}
const LEGACY: AssistantReference = { kind: 'legacy', id: 'legacy-1', revision: 2 };
const ACADEMIC: AssistantReference = { kind: 'academic', id: 'ar-100-0', revision: 3 };
const query = (overrides: Partial<Parameters<typeof resolveAssistantReferences>[1]> = {}) => ({ chatId: CHAT, threadId: THREAD, userId: 2, now: NOW, ...overrides });
function turn(sql: DatabaseSync, options: { id?: string; messageId?: number; userId?: number; chatId?: number; threadId?: number | null; createdAt?: number; links?: string } = {}) {
  sql.prepare("INSERT INTO assistant_turns(id,scope,user_id,chat_id,thread_id,message_id,question,report_ids_json,state,created_at) VALUES(?,?,?,?,?,?,?,?, 'ready',?)")
    .run(options.id ?? 'message:100', assistantScope(options.userId ?? 2, options.chatId ?? CHAT, options.threadId === undefined ? THREAD : options.threadId),
      options.userId ?? 2, options.chatId ?? CHAT, options.threadId === undefined ? THREAD : options.threadId,
      options.messageId ?? 10, 'synthetic question', options.links ?? serializeAssistantLinks([], [LEGACY]), options.createdAt ?? NOW);
}
function delivery(sql: DatabaseSync, options: { id?: string; type?: string; payload?: unknown; chatId?: number; messageId?: number; state?: string; dueAt?: number } = {}) {
  sql.prepare('INSERT INTO outbox(id,type,payload_json,due_at,state,message_id,delivered_chat_id) VALUES(?,?,?,?,?,?,?)')
    .run(options.id ?? 'delivery-1', options.type ?? 'assistant_reply', JSON.stringify(options.payload ?? { turnId: 'message:100', page: 0 }),
      options.dueAt ?? NOW, options.state ?? 'sent', options.messageId ?? 30, options.chatId ?? CHAT);
}
afterEach(() => { for (const sql of databases.splice(0)) sql.close(); });

describe('persisted assistant reference metadata', () => {
  it('round-trips legacy arrays and versioned refs while rejecting malformed, conflicting and future metadata', () => {
    expect(serializeAssistantLinks(['ar-100-0'])).toBe('["ar-100-0"]');
    expect(parseAssistantLinks('["ar-100-0"]')).toEqual({ reportIds: ['ar-100-0'], references: [] });
    const value = serializeAssistantLinks(['ar-100-0'], [ACADEMIC, LEGACY]);
    expect(JSON.parse(value)).toEqual({ version: 1, reportIds: ['ar-100-0'], references: [ACADEMIC, LEGACY] });
    expect(parseAssistantLinks(value)).toEqual({ reportIds: ['ar-100-0'], references: [ACADEMIC, LEGACY] });
    for (const invalid of ['not JSON', { version: 2, reportIds: [], references: [LEGACY] }, { version: 1, reportIds: [], references: [{ ...LEGACY, revision: 0 }] },
      { version: 1, reportIds: [], references: [LEGACY, { ...LEGACY, revision: 3 }] }, ['valid', 'invalid:id']]) {
      expect(parseAssistantLinks(invalid)).toEqual({ reportIds: [], references: [] });
    }
    expect(() => serializeAssistantLinks([], [{ ...LEGACY, revision: 0 }])).toThrow('Invalid assistant links');
  });

  it('resolves a sent bot reply and its exact original user question only in their stored chat/topic', async () => {
    const { sql, db } = database(); turn(sql); delivery(sql);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30 }))).toEqual([LEGACY]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 10 }))).toEqual([LEGACY]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 10, userId: 3 }))).toEqual([]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30, userId: 3 }))).toEqual([LEGACY]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30, threadId: 8 }))).toEqual([]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30, chatId: -100999 }))).toEqual([]);
    // A forged/unmatched reply cannot silently select the recent own answer.
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 999 }))).toEqual([]);
  });

  it('requires sent delivery even for an exact source question, never pending, failed or cancelled outbox work', async () => {
    const { sql, db } = database(); turn(sql); delivery(sql, { state: 'pending' });
    for (const state of ['pending', 'sending', 'failed', 'cancelled']) {
      sql.prepare('UPDATE outbox SET state=?').run(state);
      expect(await resolveAssistantReferences(db, query({ replyMessageId: 30 }))).toEqual([]);
      expect(await resolveAssistantReferences(db, query({ replyMessageId: 10 }))).toEqual([]);
      expect(await resolveAssistantReferences(db, query())).toEqual([]);
    }
  });

  it('permits only the latest own recent sent answer as a unique no-reply follow-up target', async () => {
    const { sql, db } = database(); turn(sql); delivery(sql);
    expect(await resolveAssistantReferences(db, query())).toEqual([LEGACY]);
    expect(await resolveAssistantReferences(db, query({ userId: 3 }))).toEqual([]);
    expect(await resolveAssistantReferences(db, query({ now: NOW + 15 * 60_000 + 1 }))).toEqual([]);
    turn(sql, { id: 'message:101', messageId: 11, createdAt: NOW + 1, links: serializeAssistantLinks([], [LEGACY, ACADEMIC]) });
    delivery(sql, { id: 'delivery-2', messageId: 31, payload: { turnId: 'message:101', page: 0 } });
    expect(await resolveAssistantReferences(db, query({ now: NOW + 2 }))).toEqual([]);
    sql.prepare('UPDATE assistant_turns SET report_ids_json=? WHERE id=?').run('[]', 'message:101');
    expect(await resolveAssistantReferences(db, query({ now: NOW + 2 }))).toEqual([]);
    // Even an unsent latest response prevents falling back to an older topic.
    sql.prepare("UPDATE outbox SET state='pending' WHERE id='delivery-2'").run();
    expect(await resolveAssistantReferences(db, query({ now: NOW + 2 }))).toEqual([]);
  });

  it('uses immutable canonical query and academic delivery payload revisions with exact destination/topic checks', async () => {
    const { sql, db } = database();
    delivery(sql, { type: 'query', payload: { eventId: LEGACY.id, revision: LEGACY.revision, chatId: CHAT, threadId: THREAD }, messageId: 40 });
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 40 }))).toEqual([LEGACY]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 40, threadId: null }))).toEqual([]);
    delivery(sql, { id: 'academic', type: 'academic_report', messageId: 41, payload: { reportId: ACADEMIC.id, revision: ACADEMIC.revision, chatId: CHAT, threadId: THREAD } });
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 41 }))).toEqual([ACADEMIC]);
    sql.prepare('UPDATE outbox SET payload_json=? WHERE id=?').run(JSON.stringify({ reportId: ACADEMIC.id, revision: ACADEMIC.revision, chatId: CHAT, threadId: 8 }), 'academic');
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 41 }))).toEqual([]);
  });

  it('resolves published messages from sent versions rather than the latest event database revision', async () => {
    const { sql, db } = database();
    sql.prepare(`INSERT INTO events(id,revision,author_id,author_name,source_chat_id,body_json,status,submitted_at,fingerprint,published_chat_id,published_thread_id,published_message_id)
      VALUES(?,9,2,'synthetic',?,'{}','approved',?,'synthetic-fingerprint',?,?,?)`).run(LEGACY.id, CHAT, NOW, CHAT, THREAD, 42);
    delivery(sql, { type: 'publish', messageId: 42, payload: { eventId: LEGACY.id, revision: 2 } });
    delivery(sql, { id: 'edited-publish', type: 'publish', messageId: 42, dueAt: NOW + 1, payload: { eventId: LEGACY.id, revision: 3 } });
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 42 }))).toEqual([{ ...LEGACY, revision: 3 }]);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 42, threadId: 8 }))).toEqual([]);
    sql.prepare('UPDATE events SET published_message_id=43').run();
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 42 }))).toEqual([]);
  });

  it('recovers old report arrays from that turn historical intake revision and refuses absent/ambiguous versions', async () => {
    const { sql, db } = database(); turn(sql, { links: '["ar-100-0"]' }); delivery(sql);
    const insert = sql.prepare('INSERT INTO academic_report_changes(report_id,revision,actor_id,intake_id,after_json,created_at) VALUES(?,?,?,?,?,?)');
    insert.run(ACADEMIC.id, 3, 2, 'academic:100', '{}', NOW);
    insert.run(ACADEMIC.id, 9, 2, 'academic:999', '{}', NOW + 1);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30 }))).toEqual([ACADEMIC]);
    sql.prepare("DELETE FROM academic_report_changes WHERE intake_id='academic:100'").run();
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30 }))).toEqual([]);
    insert.run(ACADEMIC.id, 3, 2, 'academic:100', '{}', NOW);
    insert.run(ACADEMIC.id, 4, 2, 'academic:100', '{}', NOW);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30 }))).toEqual([]);
  });

  it('persists new reference snapshots while preserving report undo links and sent answer resolution', async () => {
    const { sql, db } = database();
    sql.prepare(`INSERT INTO academic_reports(id,revision,author_id,author_name,source_chat_id,source_message_id,body_json,kind,certainty,last_update_id,created_at,updated_at)
      VALUES(?,3,2,'synthetic',?,10,'{}','note','asserted',100,?,?)`).run(ACADEMIC.id, CHAT, NOW, NOW);
    const value = { id: 'message:100', scope: assistantScope(2, CHAT, THREAD), userId: 2, chatId: CHAT, threadId: THREAD, messageId: 10, question: 'synthetic', now: NOW };
    const claim = await claimAssistantTurn(db, value);
    expect(await finishAssistantTurn(db, value, claim.token!, 'جواب', 'جواب', [ACADEMIC.id], [ACADEMIC, LEGACY])).toBe(true);
    const saved = sql.prepare('SELECT report_ids_json FROM assistant_turns').get()?.report_ids_json;
    expect(parseAssistantLinks(saved)).toEqual({ reportIds: [ACADEMIC.id], references: [ACADEMIC, LEGACY] });
    const job = (await new EventStore(db).getJob('assistant-reply:message:100:0'))!;
    const outgoing = await assistantReplyOutgoing(db, job, NOW);
    expect(outgoing?.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: 'تراجع عن آخر تغيير', callback_data: `aai:undo:${ACADEMIC.id}:3` }]] });
    sql.prepare("UPDATE outbox SET state='sent',delivered_chat_id=?,message_id=30").run(CHAT);
    expect(await resolveAssistantReferences(db, query({ replyMessageId: 30 }))).toEqual([ACADEMIC, LEGACY]);
  });
});
