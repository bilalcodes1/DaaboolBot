CREATE TABLE admin_publication_context (
  scope TEXT PRIMARY KEY,
  references_json TEXT NOT NULL,
  request_update_id INTEGER NOT NULL,
  consumed_update_id INTEGER,
  prompt_message_id INTEGER,
  referenced_message_id INTEGER,
  expires_at INTEGER NOT NULL
);
