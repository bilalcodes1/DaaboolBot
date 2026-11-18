ALTER TABLE assistant_turns ADD COLUMN diagnostic_json TEXT;
ALTER TABLE assistant_turns ADD COLUMN completed_at INTEGER;
ALTER TABLE assistant_turns ADD COLUMN delivered_at INTEGER;
