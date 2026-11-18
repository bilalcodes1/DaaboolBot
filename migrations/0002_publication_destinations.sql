ALTER TABLE events ADD COLUMN published_chat_id INTEGER;
ALTER TABLE events ADD COLUMN published_thread_id INTEGER;

UPDATE events SET
  published_chat_id = (SELECT target_chat_id FROM settings WHERE singleton = 1),
  published_thread_id = (SELECT target_thread_id FROM settings WHERE singleton = 1)
WHERE published_message_id IS NOT NULL;
