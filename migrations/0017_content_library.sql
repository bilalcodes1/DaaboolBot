-- Additive library metadata only. Binary media stays on Telegram.
CREATE TABLE IF NOT EXISTS content_media (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1,
 kind TEXT NOT NULL CHECK(kind IN ('video','meme','reaction')),
 method TEXT NOT NULL CHECK(method IN ('sendVideo','sendPhoto','sendAnimation','sendSticker')),
 file_id TEXT NOT NULL, file_unique_id TEXT NOT NULL, file_size INTEGER NOT NULL,
 duration REAL, caption TEXT NOT NULL DEFAULT '', uploaded_by INTEGER NOT NULL,
 upload_update_id INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0, approved_by INTEGER, approved_at INTEGER,
 rights_confirmed INTEGER NOT NULL DEFAULT 0, inspected_image_and_text INTEGER NOT NULL DEFAULT 0,
 deleted_at INTEGER, last_used_at INTEGER, UNIQUE(kind,file_unique_id)
);
CREATE TABLE IF NOT EXISTS content_sessions (
 user_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, token TEXT NOT NULL,
 stage TEXT NOT NULL, body_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, message_id INTEGER
);
CREATE TABLE IF NOT EXISTS content_actions (
 update_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, action TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_previews (
 user_id INTEGER NOT NULL, media_id TEXT NOT NULL, revision INTEGER NOT NULL,
 message_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,media_id,revision)
);
CREATE TABLE IF NOT EXISTS content_usage (
 job_id TEXT PRIMARY KEY, media_id TEXT, revision INTEGER, message_id INTEGER,
 chat_id INTEGER NOT NULL, category TEXT NOT NULL, sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_polls (
 id TEXT PRIMARY KEY, appearance_id TEXT NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER,
 question TEXT NOT NULL, options_json TEXT NOT NULL, category TEXT NOT NULL,
 closes_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 telegram_poll_id TEXT UNIQUE, telegram_message_id INTEGER,
 state TEXT NOT NULL CHECK(state IN ('planned','open','closed','result_sent','unavailable')),
 final_json TEXT, result_job_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS content_notices (
 id TEXT PRIMARY KEY, category TEXT NOT NULL, created_at INTEGER NOT NULL
);
