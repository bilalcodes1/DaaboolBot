-- Additive only: no account identity is inferred or seeded from roster names.
CREATE TABLE IF NOT EXISTS student_roster (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS student_identities (
  roster_id TEXT PRIMARY KEY REFERENCES student_roster(id),
  telegram_user_id INTEGER NOT NULL UNIQUE CHECK(telegram_user_id > 0),
  display_name TEXT,
  public_consent INTEGER NOT NULL DEFAULT 0 CHECK(public_consent IN (0,1)),
  consent_version INTEGER NOT NULL DEFAULT 1,
  consent_at INTEGER NOT NULL,
  verified_by INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS student_link_challenges (
  token_hash TEXT PRIMARY KEY,
  roster_id TEXT NOT NULL REFERENCES student_roster(id),
  issued_by INTEGER NOT NULL,
  previous_user_id INTEGER,
  claimed_user_id INTEGER,
  consent_at INTEGER,
  public_consent INTEGER NOT NULL DEFAULT 0 CHECK(public_consent IN (0,1)),
  state TEXT NOT NULL DEFAULT 'issued' CHECK(state IN ('issued','claimed','consented','verified','declined','revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_by INTEGER,
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS student_link_pending ON student_link_challenges(state,expires_at);
CREATE TABLE IF NOT EXISTS student_identity_sessions (
  user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK(action IN ('add','rename')),
  roster_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS student_privacy (
  user_id INTEGER PRIMARY KEY,
  memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK(memory_enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_ai_turns (
  update_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'processing' CHECK(state IN ('processing','ready','sending','sent','failed','unknown')),
  question TEXT,
  answer TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_message_id INTEGER
);
CREATE INDEX IF NOT EXISTS group_ai_memory_scope ON group_ai_turns(chat_id,thread_id,user_id,created_at);
CREATE TABLE IF NOT EXISTS group_ai_limits (
  scope TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
