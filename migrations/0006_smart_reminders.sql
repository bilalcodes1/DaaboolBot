CREATE TABLE IF NOT EXISTS smart_reminder_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  enabled_at INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO smart_reminder_config(singleton) VALUES(1);

CREATE TABLE IF NOT EXISTS smart_reminder_plans (
  local_date TEXT PRIMARY KEY,
  body_json TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  queued_generation INTEGER NOT NULL DEFAULT -1,
  queued_destination TEXT NOT NULL DEFAULT '',
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS smart_reminder_history (
  job_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  hadith_key TEXT NOT NULL,
  meaning_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('hadith','news','history'))
);
CREATE INDEX IF NOT EXISTS smart_reminder_history_date ON smart_reminder_history(scheduled_at);
