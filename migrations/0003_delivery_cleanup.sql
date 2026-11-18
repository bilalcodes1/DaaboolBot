ALTER TABLE events ADD COLUMN publication_delete_revision INTEGER;
ALTER TABLE outbox ADD COLUMN delivered_chat_id INTEGER;

UPDATE outbox SET delivered_chat_id = CASE
  WHEN type = 'review' THEN (SELECT owner_uid FROM settings WHERE singleton = 1)
  WHEN type IN ('publish','status') THEN (
    SELECT published_chat_id FROM events WHERE id = json_extract(outbox.payload_json,'$.eventId')
  )
  WHEN type = 'query' THEN json_extract(payload_json,'$.chatId')
END WHERE state = 'sent';

CREATE INDEX IF NOT EXISTS outbox_event_deliveries
  ON outbox(type,state,json_extract(payload_json,'$.eventId'));
