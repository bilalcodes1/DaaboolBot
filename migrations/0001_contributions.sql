PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  body_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  draft_expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id, thread_id)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(draft_expires_at);
CREATE TABLE IF NOT EXISTS conversation_locks (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id, thread_id)
);
CREATE INDEX IF NOT EXISTS conversation_locks_expiry ON conversation_locks(lease_until);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  source_chat_id INTEGER NOT NULL,
  source_thread_id INTEGER,
  source_message_id INTEGER,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','needs_changes')),
  event_date TEXT,
  course TEXT,
  kind TEXT,
  audience TEXT,
  submitted_at INTEGER NOT NULL,
  approved_at INTEGER,
  duplicate_of TEXT,
  fingerprint TEXT NOT NULL,
  published_message_id INTEGER
);
CREATE INDEX IF NOT EXISTS events_status_date ON events(status,event_date);
CREATE INDEX IF NOT EXISTS events_approved_author ON events(status,approved_at,author_id);
CREATE INDEX IF NOT EXISTS events_delivery_revision ON events(status,revision,submitted_at,id);
CREATE INDEX IF NOT EXISTS events_published ON events(published_message_id) WHERE published_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_fingerprint ON events(fingerprint,status);
CREATE UNIQUE INDEX IF NOT EXISTS events_approved_unique ON events(fingerprint) WHERE status='approved' AND duplicate_of IS NULL;

CREATE TABLE IF NOT EXISTS settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_uid INTEGER,
  target_chat_id INTEGER,
  target_thread_id INTEGER
);
INSERT OR IGNORE INTO settings(singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed','cancelled')),
  last_error TEXT,
  message_id INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state,due_at);
CREATE INDEX IF NOT EXISTS outbox_lease ON outbox(state,lease_until);
CREATE TABLE IF NOT EXISTS delivery_slots (
  chat_id INTEGER PRIMARY KEY,
  next_send_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('processing','done')),
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS processed_updates_expiry ON processed_updates(updated_at);
