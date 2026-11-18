-- Additive private administration state. Existing academic records/outbox remain canonical.
CREATE TABLE manual_panels (
 token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
 thread_id INTEGER NOT NULL DEFAULT 0, message_id INTEGER NOT NULL,
 actions_json TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_update_id INTEGER
);
CREATE INDEX manual_panels_expiry ON manual_panels(expires_at);
CREATE TABLE manual_forms (
 user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, body_json TEXT NOT NULL, prompt_id INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, PRIMARY KEY(user_id,chat_id,thread_id)
);
CREATE TABLE manual_operations (
 id TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
 request_json TEXT NOT NULL, nonce TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0,
 result_json TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE manual_timetable (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 body_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by INTEGER NOT NULL
);
CREATE TABLE manual_timetable_history (
 revision INTEGER PRIMARY KEY, body_json TEXT NOT NULL, actor_id INTEGER NOT NULL,
 operation_id TEXT NOT NULL, changed_at INTEGER NOT NULL
);
CREATE TABLE manual_reminders (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','cancelled')),
 body_json TEXT NOT NULL, due_at INTEGER NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER,
 actor_id INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX manual_reminders_due ON manual_reminders(state,enabled,due_at);
CREATE TABLE manual_settings (
 key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, value_json TEXT NOT NULL,
 updated_by INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO manual_settings(key,value_json) VALUES('academic_publications','{"enabled":false}');
INSERT INTO manual_settings(key,value_json) VALUES('academic_reminders','{"enabled":false}');
