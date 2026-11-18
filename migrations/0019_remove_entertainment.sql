-- Retire feature data while keeping the earlier schema usable by a rollback Worker.
CREATE TABLE _retired_entertainment_jobs (job_id TEXT PRIMARY KEY);

INSERT OR IGNORE INTO _retired_entertainment_jobs (job_id)
SELECT id FROM outbox
WHERE type IN (
  'controlled_media', 'controlled_sourced_entertainment', 'controlled_entertainment_text',
  'controlled_poll_open', 'controlled_poll_close', 'controlled_poll_result'
) OR (type = 'controlled_admin_notice' AND id GLOB 'controlled:content-notice:*')
UNION
SELECT job_id FROM controlled_jobs WHERE family = 'entertainment' OR config_key = 'entertainment'
UNION
SELECT job_id FROM controlled_deliveries WHERE family = 'entertainment'
UNION
SELECT job_id FROM controlled_appearances
WHERE calendar_id IN (SELECT id FROM controlled_entertainment_calendar)
   OR job_id GLOB 'controlled:entertainment:*' OR job_id GLOB 'controlled:media:manual:*';

DELETE FROM controlled_attempts WHERE job_id IN (SELECT job_id FROM _retired_entertainment_jobs);
DELETE FROM controlled_deliveries WHERE job_id IN (SELECT job_id FROM _retired_entertainment_jobs);
DELETE FROM controlled_appearances WHERE job_id IN (SELECT job_id FROM _retired_entertainment_jobs);
DELETE FROM controlled_jobs WHERE job_id IN (SELECT job_id FROM _retired_entertainment_jobs);
DELETE FROM outbox WHERE id IN (SELECT job_id FROM _retired_entertainment_jobs);
DROP TABLE _retired_entertainment_jobs;

DELETE FROM controlled_entertainment_calendar;
DELETE FROM content_media;
DELETE FROM content_sessions;
DELETE FROM content_actions;
DELETE FROM content_previews;
DELETE FROM content_usage;
DELETE FROM content_polls;
DELETE FROM content_notices;

DELETE FROM controlled_source_documents
WHERE kind IN ('story', 'fact', 'catalogue_story', 'catalogue_fact', 'catalogue_video', 'catalogue_meme', 'catalogue_reaction')
   OR source_id IN ('catalogue-commons', 'catalogue-openmoji', 'catalogue-nasa', 'catalogue-nasa-main');
DELETE FROM controlled_sources
WHERE kind IN ('story', 'fact')
   OR id IN ('catalogue-commons', 'catalogue-openmoji', 'catalogue-nasa', 'catalogue-nasa-main');
DELETE FROM controlled_preparations WHERE kind IN ('story', 'fact', 'source_catalogue');

DELETE FROM manual_panels
WHERE EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(actions_json) THEN actions_json ELSE '[]' END) AS action
  WHERE json_extract(CASE WHEN action.type = 'object' THEN action.value ELSE '{}' END, '$.key') = 'entertainment'
    AND json_extract(CASE WHEN action.type = 'object' THEN action.value ELSE '{}' END, '$.action') = 'auto'
);
DELETE FROM manual_forms
WHERE CASE WHEN json_valid(body_json) THEN
  json_extract(body_json, '$.kind') = 'automation'
  AND json_extract(body_json, '$.draft.key') = 'entertainment'
ELSE 0 END;
DELETE FROM controlled_admin_panels WHERE config_key = 'entertainment';
DELETE FROM controlled_admin_sessions WHERE config_key = 'entertainment';
DELETE FROM controlled_config WHERE key = 'entertainment';
