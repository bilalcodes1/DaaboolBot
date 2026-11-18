CREATE TABLE IF NOT EXISTS academic_alert_plans (
  local_date TEXT PRIMARY KEY,
  body_json TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
