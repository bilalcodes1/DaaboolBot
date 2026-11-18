-- A Telegram webhook may replay one message while shared AI capacity recovers.
-- Its per-user admission must survive those retries without another charge.
ALTER TABLE assistant_turns ADD COLUMN user_admitted INTEGER NOT NULL DEFAULT 0 CHECK(user_admitted IN (0,1));
