import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { parseUpdate } from '../src/input';
import { configureAutomation } from '../src/controlled-scheduler';
import { runProductCron } from '../src/product-jobs';
import { productHarness } from './helpers/product';

const opened: ReturnType<typeof productHarness>[] = [];
function setup() {
  const harness = productHarness();
  opened.push(harness);
  return harness;
}
afterEach(() => { for (const harness of opened.splice(0)) harness.close(); });

it('replaces cached entertainment buttons for admins and students without exposing library actions', async () => {
  const h = setup();
  const retired = /فعاليات|الميمز|الفيديوهات|القصص والحقائق/u;
  await h.text(9001, 'القائمة الرئيسية');
  expect(JSON.stringify(h.latest().reply_markup)).not.toMatch(retired);
  for (const uid of [9001, 9002]) {
    await h.text(uid, '😂 مكتبة الميمز والرياكشنات');
    const markup = h.latest(uid).reply_markup;
    expect(JSON.stringify(markup)).not.toMatch(retired);
    expect(JSON.stringify(markup)).toContain('📢 التبليغات');
    expect(JSON.stringify(markup).includes('📊 حالة النظام')).toBe(uid === 9001);
  }
  const previousMessage = h.latest().message_id;
  await h.dispatch({
    update_id: 5000,
    callback_query: {
      id: 'retired-button',
      chat_instance: 'local',
      from: { id: 9001, is_bot: false },
      message: { message_id: previousMessage, chat: { id: 9001, type: 'private' } },
      data: 'lib:retired:upload',
    },
  });
  expect(h.latest().message_id).not.toBe(previousMessage);
  expect(JSON.stringify(h.latest().reply_markup)).not.toMatch(retired);
  expect(h.calls.every(call => ['sendMessage', 'answerCallbackQuery'].includes(call.method))).toBe(true);
  await expect(configureAutomation(h.db, 'entertainment' as never, { enabled: true })).rejects.toThrow('Invalid automation setting');
});

it('ignores old poll updates and lets regular maintenance run past old jobs', async () => {
  const h = setup();
  await h.enable();
  const now = h.getNow() + 5 * 60_000;
  const pollUpdate = parseUpdate({ update_id: 6000, poll: { id: 'expired-poll' } });
  expect(pollUpdate).not.toBeNull();
  await h.dispatch(pollUpdate!);
  h.sqlite.exec(`
    INSERT INTO outbox(id,type,payload_json,due_at) VALUES('controlled:old-poll','controlled_poll_result','{}',0);
    INSERT INTO manual_panels(token,user_id,chat_id,message_id,actions_json,expires_at) VALUES('expired',9001,9001,44,'[]',0);
  `);
  await runProductCron(h.env, h.telegram, now, h.fetcher);
  expect(h.calls).toHaveLength(0);
  expect(h.sqlite.prepare('SELECT count(*) AS n FROM manual_panels').get()?.n).toBe(0);
  expect(h.sqlite.prepare("SELECT state FROM outbox WHERE id='controlled:old-poll'").get()?.state).toBe('pending');
});

it('cleans retired jobs, source records and old panels without deleting academic or news data', () => {
  const h = setup();
  h.sqlite.exec(`
    INSERT INTO controlled_config(key,enabled,updated_at) VALUES('entertainment',1,0);
    INSERT INTO outbox(id,type,payload_json,due_at) VALUES
      ('controlled:old-video','controlled_sourced_entertainment','{}',0),
      ('controlled:content-notice:meme:old','controlled_admin_notice','{}',0),
      ('controlled:old-poll','controlled_poll_close','{}',0),
      ('controlled:unrelated-notice','controlled_admin_notice','{}',0),
      ('controlled:class','controlled_academic','{}',0);
    INSERT INTO controlled_jobs(job_id,family,chat_id,expires_at,priority,created_at) VALUES
      ('controlled:old-video','entertainment',-100777,5,20,0),
      ('controlled:class','academic',-100777,5,80,0);
    INSERT INTO controlled_attempts(id,job_id,lease_token,state,started_at,outgoing_json) VALUES
      ('old-receipt','controlled:old-video','old','confirmed',0,'{}'),
      ('class-receipt','controlled:class','class','confirmed',0,'{}');
    INSERT INTO controlled_sources(id,kind,host,authorized,updated_at) VALUES ('catalogue-nasa-main','catalogue','www.nasa.gov',1,0);
    INSERT INTO controlled_source_documents(id,source_id,kind,url,published_at,fetched_at,body_json,source_digest) VALUES
      ('old-story','catalogue-nasa-main','catalogue_story','https://www.nasa.gov/old',0,0,'{}','old'),
      ('news','news-mit','news','https://news.mit.edu/new',0,0,'{}','news');
    INSERT INTO manual_panels(token,user_id,chat_id,message_id,actions_json,expires_at) VALUES
      ('old',9001,9001,1,'[{"action":"auto","key":"entertainment"}]',9),
      ('news',9001,9001,2,'[{"action":"auto","key":"news"}]',9);
    INSERT INTO content_polls(id,appearance_id,chat_id,question,options_json,category,closes_at,expires_at,state,created_at)
      VALUES('old-poll','old',-100777,'old','[]','debate',1,2,'closed',0);
  `);
  const migration = readFileSync('migrations/0019_remove_entertainment.sql', 'utf8');
  h.sqlite.exec(migration);
  h.sqlite.exec(migration);
  expect(h.sqlite.prepare('SELECT id FROM outbox ORDER BY id').all().map(row => row.id))
    .toEqual(['controlled:class', 'controlled:unrelated-notice']);
  expect(h.sqlite.prepare('SELECT id FROM controlled_attempts').all().map(row => row.id)).toEqual(['class-receipt']);
  expect(h.sqlite.prepare('SELECT id FROM controlled_source_documents').all().map(row => row.id)).toEqual(['news']);
  expect(h.sqlite.prepare('SELECT token FROM manual_panels').all().map(row => row.token)).toEqual(['news']);
  expect(h.sqlite.prepare('SELECT key FROM controlled_config ORDER BY key').all().map(row => row.key))
    .toEqual(['news', 'product', 'religion']);
  expect(h.sqlite.prepare('SELECT id FROM content_polls').all()).toEqual([]);
});
