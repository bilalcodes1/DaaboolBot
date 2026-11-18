CREATE TABLE IF NOT EXISTS assistant_turns (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  message_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  reply_html TEXT,
  reply_plain TEXT,
  report_ids_json TEXT,
  state TEXT NOT NULL DEFAULT 'processing' CHECK(state IN ('processing','ready')),
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_turns_scope ON assistant_turns(scope,created_at);
CREATE TABLE IF NOT EXISTS assistant_user_limits (
  user_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  minute INTEGER NOT NULL DEFAULT 0,
  minute_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,period)
);
CREATE TABLE IF NOT EXISTS assistant_inline_limits (
  user_id INTEGER PRIMARY KEY,
  next_at INTEGER NOT NULL
);
