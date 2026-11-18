-- Provider allowances are shared by all keys, models and Worker instances.
CREATE TABLE IF NOT EXISTS assistant_ai_usage (
  provider TEXT PRIMARY KEY CHECK (provider IN ('groq','gemini')),
  day_start INTEGER NOT NULL DEFAULT 0,
  minute_start INTEGER NOT NULL DEFAULT 0,
  day_requests INTEGER NOT NULL DEFAULT 0,
  minute_requests INTEGER NOT NULL DEFAULT 0,
  day_tokens INTEGER NOT NULL DEFAULT 0,
  minute_tokens INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);

-- Neither API keys nor input messages are persisted. Keys are SHA-256 digests
-- of the caller's request identity, input, provider, model and output contract.
CREATE TABLE IF NOT EXISTS assistant_ai_requests (
  cache_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('groq','gemini')),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','refused','error')),
  result_json TEXT,
  lease_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_ai_requests_expiry ON assistant_ai_requests(expires_at);
