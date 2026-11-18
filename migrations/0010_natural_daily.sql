CREATE TABLE IF NOT EXISTS publication_locks (
  chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL,
  PRIMARY KEY(chat_id,thread_id)
);
CREATE TABLE IF NOT EXISTS publication_receipts (
  kind TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
  chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER NOT NULL, sent_at INTEGER NOT NULL, job_id TEXT NOT NULL,
  PRIMARY KEY(kind,record_id,revision,chat_id,thread_id)
);
CREATE TABLE IF NOT EXISTS news_days (
  local_date TEXT PRIMARY KEY, body_json TEXT, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  source_url TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anonymous_requests (
  id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  body TEXT NOT NULL, message_json TEXT, expires_at INTEGER NOT NULL, confirmed_by INTEGER, confirmed_update_id INTEGER
);
-- Cancel pre-upgrade scheduled work, retain delivered audit/history.
UPDATE outbox SET state='cancelled',lease_token=NULL,lease_until=NULL
WHERE state='pending' AND type IN ('lecture_brief','digest','digest_page','academic_report','smart_reminder','award','award_page');
DELETE FROM smart_reminder_plans;
