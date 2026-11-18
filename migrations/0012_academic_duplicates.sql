ALTER TABLE academic_reports ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX academic_reports_identity ON academic_reports(
  COALESCE(destination_chat_id,source_chat_id),
  COALESCE(CASE WHEN destination_chat_id IS NULL THEN source_thread_id ELSE destination_thread_id END,0),
  author_id,dedupe_key
) WHERE state='active' AND dedupe_key IS NOT NULL;
CREATE TABLE academic_report_merges (
  duplicate_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  duplicate_json TEXT NOT NULL,
  canonical_revision INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  merged_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX academic_report_merges_target ON academic_report_merges(canonical_id);
