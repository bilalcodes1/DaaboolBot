// One-time, idempotent rollout to private chats that have already used this bot.
// Telegram delivery uses the normal outbox, including retries and blocked-user handling.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sql = `
WITH known_chats AS (
 SELECT chat_id FROM assistant_turns WHERE chat_id>0
 UNION SELECT chat_id FROM sessions WHERE chat_id>0
 UNION SELECT source_chat_id FROM events WHERE source_chat_id>0
 UNION SELECT delivered_chat_id FROM outbox WHERE delivered_chat_id>0
), kinds(kind,offset_ms) AS (VALUES('keyboard_cleanup',0),('keyboard_refresh',1000))
INSERT OR IGNORE INTO outbox(id,type,payload_json,due_at)
SELECT 'natural-ui-v2:'||kind||':'||chat_id,kind,json_object('chatId',chat_id),
 CAST(strftime('%s','now') AS INTEGER)*1000+offset_ms
FROM known_chats CROSS JOIN kinds;
SELECT type,state,COUNT(*) AS count FROM outbox
WHERE id LIKE 'natural-ui-v2:%' GROUP BY type,state;
`;
const result = spawnSync(process.execPath, [
 fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
 'd1', 'execute', 'DB', '--remote', '--command', sql, '--json',
], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', maxBuffer: 2_000_000 });
if (result.status !== 0) {
 console.error('Could not queue the private UI update. No private chat IDs or credentials printed.');
 process.exitCode = 1;
} else {
 try {
  const batches = JSON.parse(result.stdout);
  const counts = batches.flatMap(batch => batch.results ?? [])
   .filter(row => ['keyboard_cleanup','keyboard_refresh'].includes(row.type))
   .map(({type,state,count}) => ({type,state,count}));
  console.log(JSON.stringify({queued: true, counts}));
 } catch {
  console.error('Could not read the rollout result; check outbox status before retrying.');
  process.exitCode = 1;
 }
}
