import type { EventDraft, EventAudience, EventKind } from "./event-types";
import type { CourseId } from "./nlu-schema";

/** All persisted timestamps and lease times use Unix milliseconds. */
export interface ProfileRecord { userId: number; name: string; updatedAt: number }
export type SessionState = "collect" | "name" | "kind" | "course" | "date" | "audience" | "attach" | "rename" | "admin_correction";
export interface SessionRecord {
  userId: number; chatId: number; threadId: number | null; state: SessionState;
  draft: EventDraft; promptIds: number[]; expiresAt: number; draftExpiresAt: number;
  eventId: string | null; eventRevision: number | null; context?: string | undefined; lastUpdateId?: number | undefined; greetingIndex?: number | undefined;
  adminEdit?: boolean; adminPanelId?: number;
}
export type EventStatus = "pending" | "approved" | "rejected" | "cancelled" | "needs_changes";
export interface EventRecord {
  id: string; revision: number; authorId: number; authorName: string;
  sourceChatId: number; sourceThreadId: number | null; sourceMessageId: number | null;
  draft: EventDraft; status: EventStatus; submittedAt: number; approvedAt: number | null;
  duplicateOf: string | null; publishedMessageId: number | null;
  publishedChatId: number | null; publishedThreadId: number | null;
  publicationDeletionRevision: number | null;
}
export type NewEventRecord = Pick<EventRecord, "id" | "authorId" | "authorName" | "sourceChatId" | "draft"> &
  Partial<Pick<EventRecord, "sourceThreadId" | "sourceMessageId" | "status" | "submittedAt" | "approvedAt" | "duplicateOf">>;
export type EventPatch = Partial<Pick<EventRecord, "draft" | "status" | "authorName" | "approvedAt" | "duplicateOf" | "publishedMessageId" | "publicationDeletionRevision">>;
export interface SettingsRecord { ownerUid: number | null; targetChatId: number | null; targetThreadId: number | null }
export interface EventFilter { date?: string; dateFrom?: string; dateTo?: string; from?: number; to?: number; course?: CourseId; kind?: EventKind; kinds?: EventKind[]; audience?: EventAudience }
export type JobState = "pending" | "sending" | "sent" | "failed" | "cancelled";
export interface JobRecord {
  id: string; type: string; payload: unknown; dueAt: number; leaseUntil: number | null;
  leaseToken: string | null; attempts: number; state: JobState; lastError: string | null; messageId: number | null;
  deliveredChatId: number | null;
}
export interface NewJob { id: string; type: string; payload: unknown; dueAt: number }

interface EventRow {
  id: string; revision: number; author_id: number; author_name: string; source_chat_id: number;
  source_thread_id: number | null; source_message_id: number | null; body_json: string;
  status: EventStatus; submitted_at: number; approved_at: number | null;
  duplicate_of: string | null; published_message_id: number | null;
  published_chat_id: number | null; published_thread_id: number | null;
  publication_delete_revision: number | null;
}
interface JobRow {
  id: string; type: string; payload_json: string; due_at: number; lease_until: number | null;
  lease_token: string | null; attempts: number; state: JobState; last_error: string | null; message_id: number | null; delivered_chat_id: number | null;
}
function eventRecord(row: EventRow): EventRecord {
  return {
    id: row.id, revision: row.revision, authorId: row.author_id, authorName: row.author_name,
    sourceChatId: row.source_chat_id, sourceThreadId: row.source_thread_id, sourceMessageId: row.source_message_id,
    draft: JSON.parse(row.body_json) as EventDraft, status: row.status, submittedAt: row.submitted_at,
    approvedAt: row.approved_at, duplicateOf: row.duplicate_of, publishedMessageId: row.published_message_id,
    publishedChatId: row.published_chat_id, publishedThreadId: row.published_thread_id,
    publicationDeletionRevision: row.publication_delete_revision ?? null,
  };
}
function jobRecord(row: JobRow): JobRecord {
  return {
    id: row.id, type: row.type, payload: JSON.parse(row.payload_json) as unknown, dueAt: row.due_at,
    leaseUntil: row.lease_until, leaseToken: row.lease_token, attempts: row.attempts,
    state: row.state, lastError: row.last_error, messageId: row.message_id, deliveredChatId: row.delivered_chat_id ?? null,
  };
}
export async function fingerprint(draft: EventDraft): Promise<string> {
  const stable = JSON.stringify(draft.date ? {
    kind: draft.kind, course: draft.course, date: draft.date, audience: draft.audience,
    slots: [...draft.slots].sort(), time: draft.time,
  } : { kind: draft.kind, course: draft.course, teacher: draft.teacher,
    date: draft.date, dateUnspecified: draft.dateUnspecified, time: draft.time,
    slots: [...draft.slots].sort(), audience: draft.audience,
    details: draft.details.normalize("NFKC").replace(/\s+/g, " ").trim(),
    attachment: draft.attachment?.fileUniqueId ?? draft.attachment?.fileId ?? null });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Authorization is checked by the workflow; this layer guarantees durable CAS and uniqueness. */
export class EventStore {
  constructor(readonly db: D1Database) {}

  async getProfile(userId: number): Promise<ProfileRecord | null> {
    const row = await this.db.prepare("SELECT user_id,name,updated_at FROM profiles WHERE user_id=?").bind(userId)
      .first<{ user_id: number; name: string; updated_at: number }>();
    return row ? { userId: row.user_id, name: row.name, updatedAt: row.updated_at } : null;
  }
  async saveProfile(userId: number, name: string, now = Date.now()): Promise<ProfileRecord> {
    if (!name.trim() || name.length > 80) throw new RangeError("Invalid profile name.");
    await this.db.prepare("INSERT INTO profiles(user_id,name,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at")
      .bind(userId, name.trim(), now).run();
    return { userId, name: name.trim(), updatedAt: now };
  }
  async getSession(userId: number, chatId: number, threadId: number | null = null): Promise<SessionRecord | null> {
    const row = await this.db.prepare("SELECT body_json FROM sessions WHERE user_id=? AND chat_id=? AND thread_id=?")
      .bind(userId, chatId, threadId ?? 0).first<{ body_json: string }>();
    return row ? JSON.parse(row.body_json) as SessionRecord : null;
  }
  async saveSession(session: SessionRecord): Promise<void> {
    await this.db.prepare("INSERT INTO sessions(user_id,chat_id,thread_id,body_json,expires_at,draft_expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,chat_id,thread_id) DO UPDATE SET body_json=excluded.body_json,expires_at=excluded.expires_at,draft_expires_at=excluded.draft_expires_at")
      .bind(session.userId, session.chatId, session.threadId ?? 0, JSON.stringify(session), session.expiresAt, session.draftExpiresAt).run();
  }
  async clearSession(userId: number, chatId: number, threadId: number | null = null): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE user_id=? AND chat_id=? AND thread_id=?").bind(userId, chatId, threadId ?? 0).run();
  }
  async claimConversation(userId: number, chatId: number, threadId: number | null, now = Date.now(), leaseMs = 120_000): Promise<string | null> {
    const token = crypto.randomUUID();
    const row = await this.db.prepare("INSERT INTO conversation_locks(user_id,chat_id,thread_id,lease_token,lease_until) VALUES(?,?,?,?,?) ON CONFLICT(user_id,chat_id,thread_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until WHERE conversation_locks.lease_until<=? RETURNING lease_token")
      .bind(userId, chatId, threadId ?? 0, token, now + leaseMs, now).first<{ lease_token: string }>();
    return row?.lease_token ?? null;
  }
  async releaseConversation(userId: number, chatId: number, threadId: number | null, token: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM conversation_locks WHERE user_id=? AND chat_id=? AND thread_id=? AND lease_token=?")
      .bind(userId, chatId, threadId ?? 0, token).run();
    return result.meta.changes > 0;
  }
  async getEvent(id: string): Promise<EventRecord | null> {
    const row = await this.db.prepare("SELECT * FROM events WHERE id=?").bind(id).first<EventRow>();
    return row ? eventRecord(row) : null;
  }
  async createEvent(input: NewEventRecord): Promise<EventRecord> {
    await this.db.prepare("INSERT OR IGNORE INTO events(id,author_id,author_name,source_chat_id,source_thread_id,source_message_id,body_json,status,event_date,course,kind,audience,submitted_at,approved_at,duplicate_of,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(input.id, input.authorId, input.authorName, input.sourceChatId, input.sourceThreadId ?? null,
        input.sourceMessageId ?? null, JSON.stringify(input.draft), input.status ?? "pending", input.draft.date,
        input.draft.course, input.draft.kind, input.draft.audience, input.submittedAt ?? Date.now(),
        input.approvedAt ?? null, input.duplicateOf ?? null, await fingerprint(input.draft)).run();
    const event = await this.getEvent(input.id);
    if (!event) throw new Error("Event was not saved.");
    return event;
  }
  async updateEvent(id: string, expectedRevision: number, patch: EventPatch): Promise<EventRecord | null> {
    const existing = await this.getEvent(id);
    if (!existing || existing.revision !== expectedRevision) return null;
    const next = { ...existing, ...patch };
    const result = await this.db.prepare("UPDATE events SET revision=revision+1,author_name=?,body_json=?,status=?,event_date=?,course=?,kind=?,audience=?,approved_at=?,duplicate_of=?,fingerprint=?,published_message_id=?,publication_delete_revision=? WHERE id=? AND revision=?")
      .bind(next.authorName, JSON.stringify(next.draft), next.status, next.draft.date, next.draft.course,
        next.draft.kind, next.draft.audience, next.approvedAt, next.duplicateOf, await fingerprint(next.draft),
        next.publishedMessageId, next.publicationDeletionRevision, id, expectedRevision).run();
    return result.meta.changes ? this.getEvent(id) : null;
  }
  async markPublished(id: string, revision: number, messageId: number, chatId?: number, threadId: number | null = null): Promise<boolean> {
    const result = await this.db.prepare("UPDATE events SET published_message_id=?,published_chat_id=COALESCE(?,(SELECT target_chat_id FROM settings WHERE singleton=1)),published_thread_id=CASE WHEN ? IS NULL THEN (SELECT target_thread_id FROM settings WHERE singleton=1) ELSE ? END WHERE id=? AND revision=? AND status='approved'")
      .bind(messageId, chatId ?? null, chatId ?? null, threadId, id, revision).run();
    return result.meta.changes > 0;
  }
  async hasPublishedEvents(): Promise<boolean> {
    return await this.db.prepare("SELECT 1 FROM events WHERE published_message_id IS NOT NULL LIMIT 1").first() !== null;
  }
  async requestPublicationDeletion(id: string, expectedRevision: number): Promise<EventRecord | null> {
    return this.updateEvent(id, expectedRevision, { status: "cancelled", publicationDeletionRevision: expectedRevision + 1 });
  }
  async listManageable(limit = 5, offset = 0): Promise<EventRecord[]> {
    const rows = await this.db.prepare("SELECT * FROM events WHERE status IN ('pending','approved','needs_changes') ORDER BY submitted_at DESC,id DESC LIMIT ? OFFSET ?")
      .bind(Math.min(10, Math.max(1, Math.trunc(limit))), Math.max(0, Math.trunc(offset))).all<EventRow>();
    return rows.results.map(eventRecord);
  }
  async listReviewMessages(eventId: string, revision: number): Promise<{ chatId: number; messageId: number }[]> {
    const rows = await this.db.prepare("SELECT delivered_chat_id AS chat_id,message_id FROM outbox WHERE type='review' AND state='sent' AND json_extract(payload_json,'$.eventId')=? AND json_extract(payload_json,'$.revision')=? AND delivered_chat_id IS NOT NULL AND message_id IS NOT NULL LIMIT 2")
      .bind(eventId, revision).all<{ chat_id: number; message_id: number }>();
    return rows.results.map(row => ({ chatId: row.chat_id, messageId: row.message_id }));
  }
  async listPublicationDeletionTargets(eventId: string, revision: number, limit = 3): Promise<{ chatId: number; messageId: number; part: "text" | "attachment" }[]> {
    const rows = await this.db.prepare(`SELECT chat_id,message_id,MAX(part) AS part FROM (
      SELECT published_chat_id AS chat_id,published_message_id AS message_id,'text' AS part FROM events WHERE id=?
      UNION ALL SELECT delivered_chat_id,message_id,CASE WHEN json_extract(payload_json,'$.part')='attachment' THEN 'attachment' ELSE 'text' END
      FROM outbox WHERE type='publish' AND state='sent' AND json_extract(payload_json,'$.eventId')=?
    ) deliveries WHERE chat_id IS NOT NULL AND message_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM outbox WHERE id='delete:'||?||':'||CAST(? AS INTEGER)||':'||deliveries.chat_id||':'||deliveries.message_id
    ) GROUP BY chat_id,message_id ORDER BY part DESC,message_id LIMIT ?`)
      .bind(eventId, eventId, eventId, revision, Math.min(3, Math.max(1, limit))).all<{ chat_id: number; message_id: number; part: "text" | "attachment" }>();
    return rows.results.map(row => ({ chatId: row.chat_id, messageId: row.message_id, part: row.part }));
  }
  async listDeliveryCandidates(limit = 100): Promise<EventRecord[]> {
    const rows = await this.db.prepare(`SELECT * FROM events WHERE
      (status='pending' AND EXISTS (SELECT 1 FROM settings WHERE singleton=1 AND owner_uid IS NOT NULL) AND (
        NOT EXISTS (SELECT 1 FROM outbox WHERE id='review:'||events.id||':'||events.revision||':1-text') OR
        (json_type(body_json,'$.attachment')='object' AND NOT EXISTS (SELECT 1 FROM outbox WHERE id='review:'||events.id||':'||events.revision||':0-attachment'))
      )) OR
      (status='approved' AND duplicate_of IS NULL AND (published_message_id IS NOT NULL OR EXISTS (SELECT 1 FROM outbox WHERE type='publish' AND json_extract(payload_json,'$.eventId')=events.id AND json_extract(payload_json,'$.revision')=events.revision)) AND (published_chat_id IS NOT NULL OR EXISTS (SELECT 1 FROM settings WHERE singleton=1 AND target_chat_id IS NOT NULL)) AND (
        NOT EXISTS (SELECT 1 FROM outbox WHERE id='publish:'||events.id||':'||events.revision||':0-text') OR
        (json_type(body_json,'$.attachment')='object' AND NOT EXISTS (SELECT 1 FROM outbox WHERE id='publish:'||events.id||':'||events.revision||':1-attachment'))
      )) OR
      (status IN ('pending','needs_changes','cancelled','rejected') AND NOT (status='cancelled' AND COALESCE(publication_delete_revision,0)=revision) AND published_message_id IS NOT NULL AND
        (published_chat_id IS NOT NULL OR EXISTS (SELECT 1 FROM settings WHERE singleton=1 AND target_chat_id IS NOT NULL)) AND
        NOT EXISTS (SELECT 1 FROM outbox WHERE id='status:'||events.id||':'||events.revision)) OR
      (status='cancelled' AND publication_delete_revision=revision AND (
        (published_message_id IS NOT NULL AND published_chat_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM outbox WHERE id='delete:'||events.id||':'||events.revision||':'||events.published_chat_id||':'||events.published_message_id
        )) OR EXISTS (SELECT 1 FROM outbox delivered WHERE delivered.type='publish' AND delivered.state='sent' AND
          json_extract(delivered.payload_json,'$.eventId')=events.id AND delivered.message_id IS NOT NULL AND delivered.delivered_chat_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM outbox WHERE id='delete:'||events.id||':'||events.revision||':'||delivered.delivered_chat_id||':'||delivered.message_id
          ))
      ))
      ORDER BY submitted_at,id LIMIT ?`).bind(Math.min(100, Math.max(1, limit))).all<EventRow>();
    return rows.results.map(eventRecord);
  }
  async listApproved(filter: EventFilter = {}): Promise<EventRecord[]> {
    const where = ["status='approved'", "duplicate_of IS NULL"];
    const values: (string | number)[] = [];
    if (filter.date !== undefined) { where.push("event_date=?"); values.push(filter.date); }
    if (filter.dateFrom !== undefined) {
      // A broad upcoming lookup also lists explicitly undated notes. A closed
      // calendar range requires an actual date inside both inclusive bounds.
      where.push(filter.dateTo === undefined ? "(event_date IS NULL OR event_date>=?)" : "event_date>=?"); values.push(filter.dateFrom);
    }
    if (filter.dateTo !== undefined) { where.push("event_date IS NOT NULL AND event_date<=?"); values.push(filter.dateTo); }
    if (filter.from !== undefined) { where.push("approved_at>=?"); values.push(filter.from); }
    if (filter.to !== undefined) { where.push("approved_at<?"); values.push(filter.to); }
    if (filter.course !== undefined) { where.push("course=?"); values.push(filter.course); }
    if (filter.kind !== undefined) { where.push("kind=?"); values.push(filter.kind); }
    if (filter.kinds !== undefined) {
      const kinds = [...new Set(filter.kinds)].filter(value => value === "exam" || value === "quiz" || value === "homework");
      if (kinds.length === 0) return [];
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`); values.push(...kinds);
    }
    if (filter.audience !== undefined) {
      where.push(filter.audience === "all" ? "audience=?" : "(audience=? OR audience='all')");
      values.push(filter.audience);
    }
    const rows = await this.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY ${filter.dateFrom !== undefined ? "(event_date IS NULL)," : ""}event_date,submitted_at,id LIMIT 200`)
      .bind(...values).all<EventRow>();
    return rows.results.map(eventRecord);
  }
  async weeklyContributors(from: number, to: number, targetChatId?: number): Promise<{ authorId: number; authorName: string; count: number }[]> {
    const target = targetChatId === undefined ? "" : " AND (events.published_chat_id IS NULL OR events.published_chat_id=?)";
    const rows = await this.db.prepare(`SELECT events.author_id,COALESCE(profiles.name,MAX(events.author_name)) AS author_name,COUNT(*) AS count FROM events LEFT JOIN profiles ON profiles.user_id=events.author_id WHERE events.status='approved' AND events.duplicate_of IS NULL AND events.approved_at>=? AND events.approved_at<?${target} GROUP BY events.author_id,profiles.name ORDER BY count DESC,events.author_id LIMIT 200`)
      .bind(...(targetChatId === undefined ? [from, to] : [from, to, targetChatId])).all<{ author_id: number; author_name: string; count: number }>();
    return rows.results.map(row => ({ authorId: row.author_id, authorName: row.author_name, count: row.count }));
  }
  async findDuplicate(event: Pick<EventRecord, "id" | "draft">): Promise<EventRecord | null> {
    const existing = await this.getEvent(event.id);
    const submittedAt = existing?.submittedAt ?? Number.MAX_SAFE_INTEGER;
    const row = await this.db.prepare("SELECT * FROM events WHERE fingerprint=? AND id<>? AND duplicate_of IS NULL AND (status='approved' OR (status IN ('pending','needs_changes') AND (submitted_at<? OR (submitted_at=? AND id<?)))) ORDER BY (status='approved') DESC,submitted_at,id LIMIT 1")
      .bind(await fingerprint(event.draft), event.id, submittedAt, submittedAt, event.id).first<EventRow>();
    return row ? eventRecord(row) : null;
  }
  async getSettings(): Promise<SettingsRecord> {
    const row = await this.db.prepare("SELECT owner_uid,target_chat_id,target_thread_id FROM settings WHERE singleton=1")
      .first<{ owner_uid: number | null; target_chat_id: number | null; target_thread_id: number | null }>();
    return { ownerUid: row?.owner_uid ?? null, targetChatId: row?.target_chat_id ?? null, targetThreadId: row?.target_thread_id ?? null };
  }
  async bootstrapOwner(userId: number): Promise<boolean> {
    const result = await this.db.prepare("UPDATE settings SET owner_uid=? WHERE singleton=1 AND owner_uid IS NULL").bind(userId).run();
    return result.meta.changes > 0;
  }
  async saveSettings(patch: Partial<SettingsRecord>): Promise<void> {
    const existing = await this.getSettings();
    const next = { ...existing, ...patch };
    await this.db.prepare("UPDATE settings SET owner_uid=?,target_chat_id=?,target_thread_id=? WHERE singleton=1")
      .bind(next.ownerUid, next.targetChatId, next.targetThreadId).run();
  }
  async enqueueJob(job: NewJob): Promise<boolean> {
    const result = await this.db.prepare("INSERT OR IGNORE INTO outbox(id,type,payload_json,due_at) VALUES(?,?,?,?)")
      .bind(job.id, job.type, JSON.stringify(job.payload), job.dueAt).run();
    return result.meta.changes > 0;
  }
  async claimJobs(now: number, limit = 8, leaseMs = 300_000, types?: readonly string[],jobIds?:readonly string[]): Promise<JobRecord[]> {
    const token = crypto.randomUUID();
    const selected=types?.length?types.slice(0,8):[];
    const filter=selected.length?` AND type IN (${selected.map(()=>'?').join(',')})`:'';
    const ids=jobIds?.slice(0,20)??[];
    const idFilter=ids.length?` AND id IN (${ids.map(()=>'?').join(',')})`:'';
    const rows = await this.db.prepare(`UPDATE outbox SET state='sending',lease_until=?,lease_token=?,attempts=attempts+1 WHERE id IN (SELECT id FROM outbox WHERE ((state='pending' AND due_at<=?) OR (state='sending' AND lease_until<=?))${filter}${idFilter} ORDER BY due_at,id LIMIT ?) RETURNING *`)
      .bind(now + leaseMs, token, now, now, ...selected,...ids, Math.min(20, Math.max(1, limit))).all<JobRow>();
    return rows.results.map(jobRecord).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  }
  async getJob(id: string): Promise<JobRecord | null> {
    const row = await this.db.prepare("SELECT * FROM outbox WHERE id=?").bind(id).first<JobRow>();
    return row ? jobRecord(row) : null;
  }
  async completeJob(id: string, leaseToken: string, messageId: number | null = null, deliveredChatId: number | null = null, finalNote: string | null = null): Promise<boolean> {
    const result = await this.db.prepare("UPDATE outbox SET state='sent',message_id=?,delivered_chat_id=?,lease_until=NULL,lease_token=NULL,last_error=? WHERE id=? AND state='sending' AND lease_token=?")
      .bind(messageId, deliveredChatId, finalNote, id, leaseToken).run();
    return result.meta.changes > 0;
  }
  async retryJob(id: string, leaseToken: string, dueAt: number, errorCode: string): Promise<void> {
    await this.db.prepare("UPDATE outbox SET state='pending',due_at=?,last_error=?,lease_until=NULL,lease_token=NULL WHERE id=? AND state='sending' AND lease_token=?")
      .bind(dueAt, errorCode.slice(0, 80), id, leaseToken).run();
  }
  async failJob(id: string, leaseToken: string, errorCode: string): Promise<void> {
    await this.db.prepare("UPDATE outbox SET state='failed',last_error=?,lease_until=NULL,lease_token=NULL WHERE id=? AND state='sending' AND lease_token=?")
      .bind(errorCode.slice(0, 80), id, leaseToken).run();
  }
  async cancelJob(id: string, leaseToken: string): Promise<void> {
    await this.db.prepare("UPDATE outbox SET state='cancelled',lease_until=NULL,lease_token=NULL WHERE id=? AND state='sending' AND lease_token=?")
      .bind(id, leaseToken).run();
  }
  async reserveDelivery(chatId: number, now: number, spacingMs: number): Promise<number> {
    const row = await this.db.prepare("INSERT INTO delivery_slots(chat_id,next_send_at) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET next_send_at=MAX(delivery_slots.next_send_at,?)+? RETURNING next_send_at-? AS send_at")
      .bind(chatId, now + spacingMs, now, spacingMs, spacingMs).first<{ send_at: number }>();
    if (!row) throw new Error("Delivery slot was not reserved.");
    return row.send_at;
  }
  async claimUpdate(updateId: number, now = Date.now()): Promise<"claimed" | "done" | "busy"> {
    const row = await this.db.prepare("INSERT INTO processed_updates(update_id,state,lease_until,updated_at) VALUES(?,'processing',?,?) ON CONFLICT(update_id) DO UPDATE SET lease_until=excluded.lease_until,updated_at=excluded.updated_at WHERE processed_updates.state='processing' AND processed_updates.lease_until<=? RETURNING update_id")
      .bind(updateId, now + 120_000, now, now).first();
    if (row) return "claimed";
    const existing = await this.db.prepare("SELECT state FROM processed_updates WHERE update_id=?").bind(updateId).first<{ state: string }>();
    return existing?.state === "done" ? "done" : "busy";
  }
  async completeUpdate(updateId: number, now = Date.now()): Promise<void> {
    await this.db.prepare("UPDATE processed_updates SET state='done',updated_at=? WHERE update_id=?").bind(now, updateId).run();
  }
  async releaseUpdate(updateId: number): Promise<void> {
    await this.db.prepare("DELETE FROM processed_updates WHERE update_id=? AND state='processing'").bind(updateId).run();
  }
  async cleanup(now = Date.now()): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE draft_expires_at<?").bind(now),
      this.db.prepare("DELETE FROM conversation_locks WHERE lease_until<=?").bind(now),
      this.db.prepare("DELETE FROM processed_updates WHERE updated_at<?").bind(now - 7 * 86_400_000),
    ]);
  }
}
