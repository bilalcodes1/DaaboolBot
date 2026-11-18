-- Additive, opt-in coordinator. Existing outbox is the only delivery queue.
CREATE TABLE IF NOT EXISTS controlled_config (
  key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 0, body_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO controlled_config(key,body_json,updated_at) VALUES
 ('product','{"legacyReviewed":false}',0),
 ('news','{"frequencyDays":1,"minutes":[1140]}',0),
 ('religion','{"dhikrEnabled":false,"dhikrMinutes":[1080],"frequencyDays":1}',0),
 ('entertainment','{"collisionMinutes":15}',0);
CREATE TABLE IF NOT EXISTS controlled_jobs (
  job_id TEXT PRIMARY KEY, family TEXT NOT NULL,
  chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0,
  config_key TEXT, generation INTEGER, expires_at INTEGER NOT NULL,
  window_start INTEGER, window_end INTEGER, priority INTEGER NOT NULL,
  appearance_id TEXT, category TEXT, content_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS controlled_jobs_scope ON controlled_jobs(chat_id,thread_id,family);
CREATE TABLE IF NOT EXISTS controlled_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requesting','confirmed','not_sent','unknown')),
  started_at INTEGER NOT NULL, finished_at INTEGER, outgoing_json TEXT NOT NULL,
  result_json TEXT, error_code INTEGER, callback_done INTEGER NOT NULL DEFAULT 0,
  reconciliation_note TEXT
);
CREATE INDEX IF NOT EXISTS controlled_attempts_job ON controlled_attempts(job_id,state);
CREATE TABLE IF NOT EXISTS controlled_deliveries (
  job_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0,
  family TEXT NOT NULL, category TEXT, content_id TEXT, sent_at INTEGER NOT NULL,
  message_id INTEGER, appearance_id TEXT
);
CREATE INDEX IF NOT EXISTS controlled_deliveries_scope ON controlled_deliveries(chat_id,sent_at);
CREATE TABLE IF NOT EXISTS controlled_entertainment_calendar (
  id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL, start_date TEXT NOT NULL, quota INTEGER NOT NULL CHECK(quota IN (2,3)),
  body_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS controlled_appearances (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0, local_date TEXT NOT NULL, due_at INTEGER NOT NULL,
  category TEXT NOT NULL, content_id TEXT, generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','sent','unknown','cancelled')),
  sent_at INTEGER, calendar_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS controlled_appearances_time ON controlled_appearances(chat_id,due_at,state);
CREATE UNIQUE INDEX IF NOT EXISTS controlled_appearances_day ON controlled_appearances(chat_id,local_date)
 WHERE state IN ('reserved','sent','unknown');
CREATE TABLE IF NOT EXISTS controlled_scope_locks (
  chat_id INTEGER PRIMARY KEY, lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS controlled_prayer_cache (
  cache_key TEXT PRIMARY KEY, local_date TEXT NOT NULL, config_json TEXT NOT NULL,
  body_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS controlled_sources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, host TEXT NOT NULL, feed_url TEXT,
  authorized INTEGER NOT NULL DEFAULT 0, license_json TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS controlled_source_documents (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, kind TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE, published_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  body_json TEXT NOT NULL, source_digest TEXT NOT NULL, approved_json TEXT,
  state TEXT NOT NULL DEFAULT 'candidate', used_at INTEGER
);
CREATE TABLE IF NOT EXISTS controlled_admin_sessions (
  user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, stage TEXT NOT NULL, config_key TEXT NOT NULL,
  generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS controlled_admin_panels (
  nonce TEXT PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  config_key TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
