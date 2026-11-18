export interface AssistantReference {
  kind: 'legacy' | 'academic';
  id: string;
  revision: number;
}
export interface AssistantLinks { reportIds: string[]; references: AssistantReference[] }
export interface AssistantReferenceQuery {
  allowMultipleRecent?:boolean;
  allowNonTopicReply?:boolean;
  chatId: number; threadId: number | null; replyMessageId?: number | undefined; userId: number; now: number;
}
const MAX_REFERENCES = 32;
function empty(): AssistantLinks { return { reportIds: [], references: [] }; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function reference(value: unknown): value is AssistantReference {
  return record(value) && (value.kind === 'legacy' || value.kind === 'academic') && id(value.id)
    && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && Number(value.revision) <= 2_147_483_647;
}
function normalize(reportIds: unknown, references: unknown): AssistantLinks | null {
  if (!Array.isArray(reportIds) || reportIds.length > MAX_REFERENCES || !reportIds.every(id)
    || !Array.isArray(references) || references.length > MAX_REFERENCES || !references.every(reference)) return null;
  const unique = new Map<string, AssistantReference>();
  for (const value of references) {
    const key = `${value.kind}:${value.id}`;
    if (unique.has(key) && unique.get(key)!.revision !== value.revision) return null;
    unique.set(key, { kind: value.kind, id: value.id, revision: value.revision });
  }
  return { reportIds: [...new Set(reportIds)], references: [...unique.values()] };
}
/** Accept existing arrays and the versioned representation; invalid metadata
 * never becomes a partial/unique target after dropping untrusted entries. */
export function parseAssistantLinks(value: unknown): AssistantLinks {
  if (typeof value === 'string') {
    if (value.length > 32_768) return empty();
    try { value = JSON.parse(value); } catch { return empty(); }
  }
  if (Array.isArray(value)) return normalize(value, []) ?? empty();
  return record(value) && value.version === 1 ? normalize(value.reportIds, value.references) ?? empty() : empty();
}
export function serializeAssistantLinks(reportIds: readonly string[], references: readonly AssistantReference[] = []): string {
  const links = normalize(reportIds, references);
  if (!links) throw new RangeError('Invalid assistant links');
  return JSON.stringify(links.references.length ? { version: 1, ...links } : links.reportIds);
}

interface TurnRow { id: string; report_ids_json: string | null; created_at: number }
interface OutboxRow { type: string; payload_json: string }
function threadMatches(value: unknown, expected: number | null): boolean { return value === expected || expected === null && value === 0; }
function payload(text: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(text); return record(value) ? value : null; } catch { return null; } }

async function turnReferences(db: D1Database, turn: TurnRow): Promise<AssistantReference[]> {
  const links = parseAssistantLinks(turn.report_ids_json);
  const references = [...links.references];
  const missing = links.reportIds.filter(reportId => !references.some(value => value.kind === 'academic' && value.id === reportId));
  if (!missing.length) return references;
  const updateId = /^message:(\d{1,16})$/.exec(turn.id)?.[1];
  if (!updateId) return [];
  // Old arrays carry no version. Recover the revision written by THIS turn's
  // intake, never the report's current revision or a later unrelated edit.
  const rows = await db.prepare(`SELECT report_id,revision FROM academic_report_changes WHERE intake_id=? AND report_id IN (${missing.map(() => '?').join(',')})`)
    .bind(`academic:${updateId}`, ...missing).all<{ report_id: string; revision: number }>();
  for (const reportId of missing) {
    const versions = [...new Set(rows.results.filter(row => row.report_id === reportId).map(row => row.revision))];
    if (versions.length !== 1 || !reference({ kind: 'academic', id: reportId, revision: versions[0] })) return [];
    references.push({ kind: 'academic', id: reportId, revision: versions[0]! });
  }
  return references;
}
async function sentTurn(db: D1Database, turn: TurnRow, chatId: number): Promise<boolean> {
  return await db.prepare(`SELECT 1 FROM outbox WHERE type='assistant_reply' AND state='sent' AND delivered_chat_id=? AND message_id IS NOT NULL
    AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.turnId') ELSE NULL END=? LIMIT 1`)
    .bind(chatId, turn.id).first() !== null;
}
async function questionTurn(db: D1Database, query: AssistantReferenceQuery): Promise<TurnRow | null> {
  if (query.replyMessageId !== undefined) return db.prepare(`SELECT id,report_ids_json,created_at FROM assistant_turns
    WHERE chat_id=? AND COALESCE(thread_id,0)=? AND user_id=? AND message_id=? AND state='ready' LIMIT 1`)
    .bind(query.chatId, query.threadId ?? 0, query.userId, query.replyMessageId).first<TurnRow>();
  return db.prepare(`SELECT id,report_ids_json,created_at FROM assistant_turns WHERE chat_id=? AND COALESCE(thread_id,0)=?
    AND user_id=? AND state='ready' AND created_at>=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1`)
    .bind(query.chatId, query.threadId ?? 0, query.userId, query.now - 15 * 60_000, query.now).first<TurnRow>();
}

/** Resolve references only from persisted delivery/source message identities.
 * The mutation layer still checks permissions and performs revision CAS.
 * An explicit unmatched reply never falls back to another recent conversation.
 */
export async function resolveAssistantReferences(db: D1Database, query: AssistantReferenceQuery): Promise<AssistantReference[]> {
  if (!Number.isSafeInteger(query.chatId) || query.chatId === 0 || !Number.isSafeInteger(query.userId) || query.userId <= 0
    || !(query.threadId === null || Number.isSafeInteger(query.threadId) && query.threadId > 0) || !Number.isFinite(query.now)
    || query.replyMessageId !== undefined && (!Number.isSafeInteger(query.replyMessageId) || query.replyMessageId <= 0)) return [];
  try {
    if (query.replyMessageId !== undefined) {
      const rows = await db.prepare(`SELECT type,payload_json FROM outbox WHERE state='sent' AND delivered_chat_id=? AND message_id=?
        AND type IN ('assistant_reply','query','publish','academic_report','review') ORDER BY due_at DESC,id DESC LIMIT 32`)
        .bind(query.chatId, query.replyMessageId).all<OutboxRow>();
      const references: AssistantReference[] = [];
      for (const row of rows.results) {
        const value = payload(row.payload_json);
        if (!value) continue;
        if (row.type === 'assistant_reply' && typeof value.turnId === 'string' && value.turnId.length <= 128) {
          const turn = await db.prepare(`SELECT id,report_ids_json,created_at FROM assistant_turns WHERE id=? AND chat_id=?
            AND (?=1 OR COALESCE(thread_id,0)=?) AND state='ready'`).bind(value.turnId, query.chatId, Number(query.allowNonTopicReply===true),query.threadId ?? 0).first<TurnRow>();
          if (turn) references.push(...await turnReferences(db, turn));
        } else if (row.type === 'academic_report' && value.chatId === query.chatId && (query.allowNonTopicReply===true||threadMatches(value.threadId, query.threadId))
          && reference({ kind: 'academic', id: value.reportId, revision: value.revision })) {
          references.push({ kind: 'academic', id: value.reportId as string, revision: value.revision as number });
        } else if ((row.type === 'query' || row.type === 'publish' || row.type === 'review') && reference({ kind: 'legacy', id: value.eventId, revision: value.revision })) {
          if (row.type === 'query') {
            if (value.chatId !== query.chatId || !query.allowNonTopicReply&&!threadMatches(value.threadId, query.threadId)) continue;
          } else if (row.type === 'publish') {
            const destination = await db.prepare('SELECT published_chat_id,published_thread_id,published_message_id FROM events WHERE id=?')
              .bind(value.eventId as string).first<{ published_chat_id: number | null; published_thread_id: number | null; published_message_id: number | null }>();
            if (destination?.published_chat_id !== query.chatId || destination.published_message_id !== query.replyMessageId
              || !query.allowNonTopicReply&&!threadMatches(destination.published_thread_id, query.threadId)) continue;
          }
          references.push({ kind: 'legacy', id: value.eventId as string, revision: value.revision as number });
        }
      }
      if (!references.length) {
        try {const receipts=await db.prepare('SELECT kind,record_id AS id,revision FROM publication_receipts WHERE chat_id=? AND (?=1 OR thread_id=?) AND message_id=?')
          .bind(query.chatId,Number(query.allowNonTopicReply===true),query.threadId??0,query.replyMessageId).all<AssistantReference>();
        references.push(...receipts.results.filter(reference));} catch { /* Pre-migration databases have no aggregate receipts. */ }
      }
      if (references.length) {
        // Telegram edits retain a message ID. The greatest SENT canonical
        // payload revision is the version actually last rendered there.
        const unique = new Map<string, AssistantReference>();
        for (const value of references) {
          const key = `${value.kind}:${value.id}`;
          if (!unique.has(key) || unique.get(key)!.revision < value.revision) unique.set(key, value);
        }
        return [...unique.values()];
      }
    }
    const turn = await questionTurn(db, query);
    if (!turn || !await sentTurn(db, turn, query.chatId)) return [];
    const references = await turnReferences(db, turn);
    return query.replyMessageId !== undefined || references.length === 1 || query.allowMultipleRecent ? references : [];
  } catch { return []; }
}
