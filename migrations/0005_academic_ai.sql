CREATE TABLE IF NOT EXISTS academic_intakes (
  id TEXT PRIMARY KEY,
  author_id INTEGER NOT NULL,
  source_chat_id INTEGER NOT NULL,
  source_thread_id INTEGER,
  source_message_id INTEGER NOT NULL,
  source_text TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  response_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS academic_reports (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','cancelled')),
  author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  source_chat_id INTEGER NOT NULL,
  source_thread_id INTEGER,
  source_message_id INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  course TEXT,
  kind TEXT NOT NULL,
  event_date TEXT,
  audience TEXT,
  certainty TEXT NOT NULL,
  component TEXT,
  conflict_with_json TEXT NOT NULL DEFAULT '[]',
  destination_chat_id INTEGER,
  destination_thread_id INTEGER,
  last_update_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS academic_reports_date ON academic_reports(state,event_date,course);
CREATE INDEX IF NOT EXISTS academic_reports_author ON academic_reports(author_id,state,updated_at);
CREATE INDEX IF NOT EXISTS academic_reports_destination ON academic_reports(destination_chat_id,state,event_date);
CREATE TABLE IF NOT EXISTS academic_report_changes (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  intake_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id,revision)
);
