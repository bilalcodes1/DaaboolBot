import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { contents: "export * from './src/event-store'; export * from './src/event-jobs'; export { emptyEventDraft } from './src/event-types'; export { TelegramError } from './src/telegram';", resolveDir: ROOT }, bundle: true, format: 'esm', platform: 'node', write: false });
const { EventStore, emptyEventDraft, queueReview, queuePublish, queueStatusUpdate, queueEventQuery, queueScheduledEventJobs, dispatchEventJobs, queueMessageCleanup, queueReviewCleanup, queuePublicationDeletion, TelegramError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const NOW = Date.parse('2026-10-19T17:00:00Z'); // Monday 20:00 Baghdad.
function draft(overrides = {}) {
  return { ...emptyEventDraft(), kind: 'exam', course: 'graphics', date: '2026-10-20', audience: 'all', details: 'لا يشمل الفصل الخامس <استثناء>', ...overrides };
}
function input(id, overrides = {}) {
  return { id, authorId: 101, authorName: 'طالب <أ>', sourceChatId: 101, draft: draft(), submittedAt: NOW, ...overrides };
}
function telegramMock() {
  const calls = [];
  return { calls, async call(method, payload) { calls.push({ method, payload }); return { message_id: 500 + calls.length }; } };
}

test('contribution persistence and jobs use real local D1/SQLite without external requests', { timeout: 60_000 }, async (suite) => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-13', script: 'export default { fetch(){ return new Response("local"); } }', d1Databases: { DB: 'contribution-test', LEGACY: 'contribution-migration-test' } }));
  suite.after(async () => { await mf.dispose(); });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(resolve(ROOT, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    const migration = await readFile(resolve(ROOT, 'migrations', name), 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const store = new EventStore(db);
  // Mock sleeps do not advance wall time; isolate pacing reservations between scenarios.
  suite.beforeEach(async () => { await db.prepare('DELETE FROM delivery_slots').run(); });

  await suite.test('the publication destination migration backfills existing public messages before a destination change', async () => {
    const legacy = await mf.getD1Database('LEGACY');
    const apply = async name => {
      const migration = await readFile(resolve(ROOT, 'migrations', name), 'utf8');
      for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await legacy.prepare(statement).run();
    };
    await apply('0001_contributions.sql');
    await legacy.prepare('UPDATE settings SET target_chat_id=?,target_thread_id=? WHERE singleton=1').bind(-100333, 9).run();
    await legacy.prepare("INSERT INTO events(id,author_id,author_name,source_chat_id,body_json,status,submitted_at,fingerprint,published_message_id) VALUES(?,?,?,?,?,'approved',?,?,?)")
      .bind('legacy-publication', 101, 'legacy-author', 101, JSON.stringify(draft()), NOW, 'legacy-fingerprint', 80).run();
    await apply('0002_publication_destinations.sql');
    const migrated = new EventStore(legacy);
    assert.equal((await migrated.getEvent('legacy-publication')).publishedChatId, -100333);
    assert.equal((await migrated.getEvent('legacy-publication')).publishedThreadId, 9);
    await migrated.saveSettings({ targetChatId: -100444, targetThreadId: 19 });
    assert.equal((await migrated.getEvent('legacy-publication')).publishedChatId, -100333);
    assert.equal((await migrated.getEvent('legacy-publication')).publishedThreadId, 9);
  });

  await suite.test('profiles persist once and sessions isolate user/chat/topic while preserving expired drafts', async () => {
    await store.saveProfile(101, 'طالب <أ>', NOW);
    assert.deepEqual(await store.getProfile(101), { userId: 101, name: 'طالب <أ>', updatedAt: NOW });
    const session = { userId: 101, chatId: -100123, threadId: null, state: 'collect', draft: draft(), promptIds: [20], expiresAt: NOW - 1, draftExpiresAt: NOW + 86_400_000, eventId: null, eventRevision: null, lastUpdateId: 41 };
    await store.saveSession(session);
    assert.deepEqual(await store.getSession(101, -100123), session);
    assert.equal(await store.getSession(102, -100123), null);
    assert.equal(await store.getSession(101, -100123, 5), null);
    await store.saveSession({ ...session, threadId: 5, promptIds: [21] });
    assert.deepEqual((await store.getSession(101, -100123, 5)).promptIds, [21]);
    await store.clearSession(101, -100123);
    assert.equal(await store.getSession(101, -100123), null);
    assert.ok(await store.getSession(101, -100123, 5));
  });

  await suite.test('conversation leases serialize one user/chat/topic and only their current token can release them', async () => {
    const otherWorker = new EventStore(db);
    const claims = await Promise.all([
      store.claimConversation(101, -100123, null, NOW),
      otherWorker.claimConversation(101, -100123, null, NOW),
      store.claimConversation(101, -100123, 0, NOW),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const token = claims.find(Boolean);
    assert.equal(await otherWorker.claimConversation(101, -100123, null, NOW + 119_999), null);
    assert.equal(await store.releaseConversation(101, -100123, null, 'wrong-token'), false);
    assert.equal(await otherWorker.claimConversation(101, -100123, null, NOW + 1), null);
    for (const [userId, chatId, threadId] of [[102, -100123, null], [101, -100124, null], [101, -100123, 5]]) {
      const isolated = await otherWorker.claimConversation(userId, chatId, threadId, NOW);
      assert.ok(isolated);
      assert.equal(await store.releaseConversation(userId, chatId, threadId, token), false);
      assert.equal(await otherWorker.releaseConversation(userId, chatId, threadId, isolated), true);
    }
    const replacement = await otherWorker.claimConversation(101, -100123, null, NOW + 120_000);
    assert.ok(replacement);
    assert.notEqual(replacement, token);
    assert.equal(await store.releaseConversation(101, -100123, null, token), false);
    assert.equal(await store.claimConversation(101, -100123, null, NOW + 120_001), null);
    assert.equal(await otherWorker.releaseConversation(101, -100123, null, replacement), true);
    const reacquired = await store.claimConversation(101, -100123, null, NOW + 120_002, 1000);
    assert.ok(reacquired);
    assert.equal(await otherWorker.claimConversation(101, -100123, null, NOW + 121_001), null);
    assert.ok(await otherWorker.claimConversation(101, -100123, null, NOW + 121_002));
  });

  await suite.test('event creation is idempotent and only one concurrent revision update wins', async () => {
    const original = await store.createEvent(input('cas'));
    assert.equal(original.revision, 1);
    const repeat = await store.createEvent(input('cas', { draft: draft({ details: 'must not overwrite the first message' }) }));
    assert.equal(repeat.draft.details, original.draft.details);
    const updates = await Promise.all([
      store.updateEvent('cas', 1, { status: 'approved', approvedAt: NOW }),
      store.updateEvent('cas', 1, { status: 'rejected' }),
    ]);
    assert.equal(updates.filter(Boolean).length, 1);
    assert.equal((await store.getEvent('cas')).revision, 2);
    assert.equal(await store.updateEvent('cas', 1, { status: 'cancelled' }), null);
  });

  await suite.test('canonical dated duplicates ignore rewording; later pending notes never disqualify the first', async () => {
    const first = await store.createEvent(input('duplicate-first', { submittedAt: NOW + 10, draft: draft({ course: 'mobile' }) }));
    const second = await store.createEvent(input('duplicate-second', { submittedAt: NOW + 11, draft: draft({ course: 'mobile', details: 'نفس الامتحان بصياغة مختلفة', attachment: { kind: 'photo', fileId: 'synthetic-file' } }) }));
    assert.equal(await store.findDuplicate(first), null);
    assert.equal((await store.findDuplicate(second)).id, first.id);
    await store.updateEvent(first.id, 1, { status: 'approved', approvedAt: NOW });
    await assert.rejects(store.updateEvent(second.id, 1, { status: 'approved', approvedAt: NOW }));
    const differentAudience = await store.createEvent(input('different-audience', { draft: draft({ course: 'mobile', audience: 'A' }) }));
    assert.equal(await store.findDuplicate(differentAudience), null);
  });

  await suite.test('canonical fingerprints sort lecture slots and the database rejects concurrent duplicate approval', async () => {
    const first = await store.createEvent(input('duplicate-race-a', { submittedAt: NOW + 20, draft: draft({ course: 'mobile', slots: [1, 3] }) }));
    const second = await store.createEvent(input('duplicate-race-b', { submittedAt: NOW + 20, draft: draft({ course: 'mobile', slots: [3, 1], details: 'صياغة ثانية' }) }));
    assert.equal(await store.findDuplicate(first), null);
    assert.equal((await store.findDuplicate(second)).id, first.id);
    const approvals = await Promise.allSettled([
      store.updateEvent(first.id, first.revision, { status: 'approved', approvedAt: NOW }),
      store.updateEvent(second.id, second.revision, { status: 'approved', approvedAt: NOW }),
    ]);
    assert.equal(approvals.filter(result => result.status === 'fulfilled' && result.value).length, 1);
    assert.equal(approvals.filter(result => result.status === 'rejected').length, 1);
    const unique = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE id IN (?,?) AND status='approved' AND duplicate_of IS NULL").bind(first.id, second.id).first();
    assert.equal(unique.n, 1);
  });

  await suite.test('owner bootstrap is atomic and approved listing excludes rejected/duplicate records', async () => {
    const claims = await Promise.all([store.bootstrapOwner(1), store.bootstrapOwner(2)]);
    assert.equal(claims.filter(Boolean).length, 1);
    await store.saveSettings({ ownerUid: 1, targetChatId: -100123456, targetThreadId: 9 });
    assert.deepEqual(await store.getSettings(), { ownerUid: 1, targetChatId: -100123456, targetThreadId: 9 });
    await store.createEvent(input('listed-approved', { draft: draft({ course: 'networks', audience: 'A' }), status: 'approved', approvedAt: NOW }));
    await store.createEvent(input('listed-duplicate', { draft: draft({ course: 'networks', audience: 'B' }), status: 'approved', approvedAt: NOW, duplicateOf: 'listed-approved' }));
    assert.deepEqual((await store.listApproved({ date: '2026-10-20', kind: 'exam', course: 'networks', audience: 'A' })).map(event => event.id), ['listed-approved']);
  });

  await suite.test('an explicit shared audience filter excludes group-specific events while A/B include shared events', async () => {
    for (const audience of ['all', 'A', 'B']) {
      await store.createEvent(input(`audience-${audience}`, { draft: draft({ course: 'architecture', date: '2026-10-25', audience }), status: 'approved', approvedAt: NOW }));
    }
    const filter = { date: '2026-10-25', course: 'architecture' };
    assert.deepEqual((await store.listApproved({ ...filter, audience: 'all' })).map(event => event.id), ['audience-all']);
    assert.deepEqual((await store.listApproved({ ...filter, audience: 'A' })).map(event => event.id).sort(), ['audience-A', 'audience-all']);
    assert.deepEqual((await store.listApproved({ ...filter, audience: 'B' })).map(event => event.id).sort(), ['audience-B', 'audience-all']);
    assert.equal((await store.listApproved(filter)).length, 3);
  });

  await suite.test('outbox uniqueness and leases prevent parallel dispatch and stale completion', async () => {
    await store.enqueueJob({ id: 'lease', type: 'test', payload: { value: 1 }, dueAt: NOW });
    assert.equal(await store.enqueueJob({ id: 'lease', type: 'test', payload: {}, dueAt: NOW }), false);
    const attempts = await Promise.all([store.claimJobs(NOW), store.claimJobs(NOW)]);
    assert.equal(attempts.flat().length, 1);
    const job = attempts.flat()[0];
    assert.equal(await store.completeJob('lease', 'wrong-token'), false);
    await store.retryJob('lease', job.leaseToken, NOW + 1000, 'telegram_429');
    assert.deepEqual(await store.claimJobs(NOW + 999), []);
    const [retry] = await store.claimJobs(NOW + 1000);
    assert.equal(retry.attempts, 2);
    assert.equal(await store.completeJob('lease', job.leaseToken), false);
    assert.equal(await store.completeJob('lease', retry.leaseToken, 77), true);
    assert.equal((await store.getJob('lease')).messageId, 77);
  });

  await suite.test('durable update claims distinguish busy/completed retries and can release failures', async () => {
    assert.equal(await store.claimUpdate(100, NOW), 'claimed');
    assert.equal(await store.claimUpdate(100, NOW + 1), 'busy');
    await store.completeUpdate(100, NOW + 2);
    assert.equal(await store.claimUpdate(100, NOW + 70_000), 'done');
    assert.equal(await store.claimUpdate(101, NOW), 'claimed');
    await store.releaseUpdate(101);
    assert.equal(await store.claimUpdate(101, NOW + 1), 'claimed');
    assert.equal(await store.claimUpdate(102, NOW), 'claimed');
    assert.equal(await store.claimUpdate(102, NOW + 60_000), 'busy');
    assert.equal(await store.claimUpdate(102, NOW + 119_999), 'busy');
    assert.equal(await store.claimUpdate(102, NOW + 120_000), 'claimed');
  });

  await suite.test('delivery backlog defers a job to its slot without sleeping more than ten seconds', async () => {
    const target = (await store.getSettings()).targetChatId;
    await db.prepare('INSERT INTO delivery_slots(chat_id,next_send_at) VALUES(?,?)').bind(target, NOW + 20_000).run();
    await store.enqueueJob({ id: 'pacing', type: 'award_page', payload: { text: 'queued' }, dueAt: NOW });
    const fake = telegramMock();
    const sleeps = [];
    const first = await dispatchEventJobs(store, fake, NOW, { sleep: async milliseconds => { sleeps.push(milliseconds); } });
    assert.deepEqual(first, { sent: 0, retried: 1, cancelled: 0, failed: 0 });
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(sleeps, []);
    const deferred = await store.getJob('pacing');
    assert.equal(deferred.state, 'pending');
    assert.equal(deferred.dueAt, NOW + 20_000);
    assert.equal(deferred.leaseToken, null);
    assert.equal(deferred.leaseUntil, null);
    assert.equal(deferred.lastError, 'delivery_pacing');
    assert.deepEqual(await store.claimJobs(NOW + 19_999), []);
    const second = await dispatchEventJobs(store, fake, deferred.dueAt, { sleep: async milliseconds => { sleeps.push(milliseconds); } });
    assert.equal(second.sent, 1);
    assert.equal(fake.calls.length, 1);
    assert.ok(sleeps.every(milliseconds => milliseconds <= 10_000));
    assert.equal((await store.getJob('pacing')).lastError, null);
  });

  await suite.test('review includes media before approval buttons and publish reuses file IDs plus author attribution', async () => {
    const event = await store.createEvent(input('media', { draft: draft({ course: 'visual', attachment: { kind: 'document', fileId: 'synthetic-doc-id', fileName: 'note.pdf' } }) }));
    await queueReview(store, event.id, event.revision, NOW);
    const review = telegramMock();
    assert.equal((await dispatchEventJobs(store, review, NOW, { sleep: async () => {} })).sent, 2);
    assert.equal(review.calls[0].method, 'sendDocument');
    assert.equal(review.calls[0].payload.document, 'synthetic-doc-id');
    assert.match(review.calls[1].payload.text, /طالب &lt;أ&gt;/);
    assert.equal(review.calls[1].payload.reply_markup.inline_keyboard[0][0].callback_data, 'evt:approve:media:1');
    const approved = await store.updateEvent(event.id, 1, { status: 'approved', approvedAt: NOW });
    await queuePublish(store, approved.id, approved.revision, NOW);
    const publishing = telegramMock();
    const result = await dispatchEventJobs(store, publishing, NOW, { sleep: async () => {} });
    assert.equal(result.sent, 2);
    assert.equal(publishing.calls[0].method, 'sendMessage');
    assert.equal(publishing.calls[0].payload.message_thread_id, 9);
    assert.equal(publishing.calls[1].method, 'sendDocument');
    assert.equal(publishing.calls[1].payload.document, 'synthetic-doc-id');
    assert.equal(publishing.calls[1].payload.reply_parameters.message_id, 501);
    assert.equal((await store.getEvent(event.id)).revision, approved.revision);
  });

  await suite.test('stale revisions cancel before publishing, status changes edit the canonical public message', async () => {
    const event = await store.createEvent(input('stale', { draft: draft({ course: 'architecture' }), status: 'approved', approvedAt: NOW }));
    await queuePublish(store, event.id, event.revision, NOW);
    await store.updateEvent(event.id, event.revision, { status: 'cancelled' });
    const fake = telegramMock();
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).cancelled, 1);
    assert.equal(fake.calls.length, 0);
    const old = await store.getEvent('media');
    const edited = await store.updateEvent(old.id, old.revision, { status: 'needs_changes' });
    await queueStatusUpdate(store, edited.id, edited.revision, NOW);
    await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} });
    assert.equal(fake.calls[0].method, 'editMessageText');
    assert.equal(fake.calls[0].payload.message_id, 501);
    assert.match(fake.calls[0].payload.text, /تحتاج تعديل قبل الاعتماد/);
    const reapproved = await store.updateEvent(edited.id, edited.revision, { status: 'approved', approvedAt: NOW });
    await queuePublish(store, reapproved.id, reapproved.revision, NOW);
    fake.calls.length = 0;
    await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} });
    assert.equal(fake.calls[0].method, 'editMessageText');
  });

  await suite.test('public status edits withhold every unapproved draft field until reapproval', async () => {
    const original = await store.createEvent(input('unreviewed-edit', { draft: draft({ course: 'visual', date: '2026-10-22' }), status: 'approved', approvedAt: NOW }));
    await queuePublish(store, original.id, original.revision, NOW);
    const fake = telegramMock();
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 1);
    const current = await store.getEvent(original.id);
    const unpublishedDraft = draft({
      kind: 'homework', course: 'networks', date: '2026-10-23', time: '12:34', audience: 'B',
      details: 'UNREVIEWED_PRIVATE_DETAILS', attachment: { kind: 'document', fileId: 'unreviewed-file', fileName: 'UNREVIEWED_FILE.pdf' },
    });
    const pending = await store.updateEvent(current.id, current.revision, { draft: unpublishedDraft, status: 'pending', approvedAt: null });
    await queueStatusUpdate(store, pending.id, pending.revision, NOW);
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 1);
    assert.equal(fake.calls[0].method, 'editMessageText');
    assert.equal(fake.calls[0].payload.message_id, current.publishedMessageId);
    assert.match(fake.calls[0].payload.text, /بانتظار موافقة الأدمن على التعديل/);
    assert.match(fake.calls[0].payload.text, /طالب &lt;أ&gt;/);
    assert.doesNotMatch(JSON.stringify(fake.calls), /UNREVIEWED|unreviewed-file|2026-10-23|12:34|شبكات الحاسبة|مجموعة B/);

    const approved = await store.updateEvent(pending.id, pending.revision, { status: 'approved', approvedAt: NOW });
    await queuePublish(store, approved.id, approved.revision, NOW);
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 2);
    assert.equal(fake.calls[0].method, 'editMessageText');
    assert.match(fake.calls[0].payload.text, /UNREVIEWED_PRIVATE_DETAILS/);
    assert.equal(fake.calls[1].method, 'sendDocument');
    assert.equal(fake.calls[1].payload.document, 'unreviewed-file');
  });

  await suite.test('429 retries respect retry_after and failures store only a safe numeric code', async () => {
    const event = await store.createEvent(input('retry', { draft: draft({ course: 'compilers' }), status: 'approved', approvedAt: NOW }));
    await queuePublish(store, event.id, event.revision, NOW);
    const fake = { async call() { throw new TelegramError(429, true, 90); } };
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).retried, 1);
    const job = await store.getJob('publish:retry:1:0-text');
    assert.equal(job.state, 'pending');
    assert.equal(job.dueAt, NOW + 90_000);
    assert.equal(job.lastError, 'telegram_429');
    await db.prepare("UPDATE outbox SET state='cancelled' WHERE id=?").bind(job.id).run();
  });

  await suite.test('legacy scheduler no longer queues morning or night digests',async()=>{
    for(const at of [NOW,NOW+60000,Date.parse('2026-10-20T04:30:00Z')]) await queueScheduledEventJobs(store,at);
    assert.equal(await store.getJob('digest:evening:2026-10-20'),null);
    assert.equal(await store.getJob('digest:morning:2026-10-20'),null);
  });

  await suite.test('weekly winners count approved unique notes only and a delayed Saturday tick catches Friday', async () => {
    const friday = Date.parse('2026-10-23T17:05:00Z');
    const winners = await store.weeklyContributors(friday - 7 * 86_400_000, friday);
    assert.ok(winners.every(winner => winner.count > 0));
    const approvedCount = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE status='approved' AND duplicate_of IS NULL AND approved_at>=? AND approved_at<?").bind(friday - 7 * 86_400_000, friday).first();
    assert.equal(winners.reduce((sum, winner) => sum + winner.count, 0), approvedCount.n);
    await queueScheduledEventJobs(store, friday + 12 * 3_600_000);
    assert.equal(await store.getJob('award:2026-10-23'), null);
  });

  await suite.test('large tied weekly awards paginate within Telegram limits and escape every saved name', async () => {
    const friday = Date.parse('2026-10-23T17:05:00Z');
    const original = store.weeklyContributors;
    store.weeklyContributors = async () => Array.from({ length: 200 }, (_, index) => ({ authorId: index + 1000, authorName: `طالب ${index} <${'ن'.repeat(60)}>`, count: 1 }));
    await store.enqueueJob({id:'award:2026-10-23',type:'award',payload:{from:friday-7*86400000,to:friday,period:'2026-10-23'},dueAt:friday});
    try {
      const fake = telegramMock();
      // Mock sleeps leave future slots reserved, so large pages need later sweeps.
      for (let sweep = 0; sweep < 6; sweep++) {
        await dispatchEventJobs(store, fake, friday + sweep * 60_000, { limit: 20, sleep: async () => {} });
        const remaining = await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'").first();
        if (remaining.n === 0) break;
      }
      const awardCalls = fake.calls.filter(call => typeof call.payload.text === 'string' && call.payload.text.includes('مساهم الأسبوع'));
      assert.ok(awardCalls.length > 1);
      assert.ok(awardCalls.every(call => call.payload.text.length <= 4096));
      const combined = awardCalls.map(call => call.payload.text).join('\n');
      assert.match(combined, /طالب 0 &lt;/);
      assert.match(combined, /طالب 199 &lt;/);
      assert.doesNotMatch(combined, /<ن/);
    } finally { store.weeklyContributors = original; }
  });

  await suite.test('scheduled sweeps repair current missing review, publish, attachment and public status jobs', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await db.prepare('DELETE FROM events').run();
    await store.saveSettings({ ownerUid: 1, targetChatId: null, targetThreadId: null });
    assert.equal(await store.hasPublishedEvents(), false);
    const attachment = { kind: 'photo', fileId: 'synthetic-repair-file' };
    const review = await store.createEvent(input('repair-review', { draft: draft({ course: 'architecture', attachment }) }));
    const reviewSplit = await store.createEvent(input('repair-review-split', { draft: draft({ course: 'mobile', attachment }) }));
    await queueReview(store, reviewSplit.id, reviewSplit.revision, NOW);
    await db.prepare('DELETE FROM outbox WHERE id=?').bind('review:repair-review-split:1:0-attachment').run();
    const publish = await store.createEvent(input('repair-publish', { status: 'approved', approvedAt: NOW }));
    const publishSplit = await store.createEvent(input('repair-publish-split', { draft: draft({ course: 'visual', attachment }), status: 'approved', approvedAt: NOW }));
    await queuePublish(store, publishSplit.id, publishSplit.revision, NOW);
    await db.prepare('DELETE FROM outbox WHERE id=?').bind('publish:repair-publish-split:1:1-attachment').run();
    await store.createEvent(input('repair-duplicate', { status: 'approved', approvedAt: NOW, duplicateOf: publish.id }));
    const original = await store.createEvent(input('repair-status', { draft: draft({ course: 'compilers' }), status: 'approved', approvedAt: NOW }));
    assert.equal(await store.markPublished(original.id, original.revision, 888), true);
    assert.equal(await store.hasPublishedEvents(), true);
    const status = await store.updateEvent(original.id, original.revision, { status: 'needs_changes' });
    await store.enqueueJob({ id: 'status:repair-status:1', type: 'status', payload: { eventId: original.id, revision: 1 }, dueAt: NOW });
    const pendingOriginal = await store.createEvent(input('repair-pending-status', { draft: draft({ course: 'networks' }), status: 'approved', approvedAt: NOW }));
    await store.markPublished(pendingOriginal.id, pendingOriginal.revision, 889);
    const pendingStatus = await store.updateEvent(pendingOriginal.id, pendingOriginal.revision, { status: 'pending', approvedAt: null });
    await queueReview(store, pendingStatus.id, pendingStatus.revision, NOW);

    await queueScheduledEventJobs(store, NOW);
    assert.ok(await store.getJob('review:repair-review:1:1-text'));
    assert.ok(await store.getJob('review:repair-review:1:0-attachment'));
    assert.ok(await store.getJob('review:repair-review-split:1:0-attachment'));
    assert.equal(await store.getJob('publish:repair-publish:1:0-text'), null);
    assert.equal(await store.getJob('publish:repair-publish-split:1:1-attachment'), null);
    assert.equal(await store.getJob(`status:${status.id}:${status.revision}`), null);
    assert.equal(await store.getJob(`status:${pendingStatus.id}:${pendingStatus.revision}`), null);

    await store.saveSettings({ targetChatId: -100123456 });
    await queueScheduledEventJobs(store, NOW);
    await queueScheduledEventJobs(store, NOW + 60_000);
    assert.equal(await store.getJob('publish:repair-publish:1:0-text'),null);
    assert.ok(await store.getJob('publish:repair-publish-split:1:1-attachment'));
    assert.ok(await store.getJob(`status:${status.id}:${status.revision}`));
    assert.ok(await store.getJob(`status:${pendingStatus.id}:${pendingStatus.revision}`));
    assert.equal(await store.getJob('publish:repair-duplicate:1:0-text'), null);
    assert.deepEqual(await store.listDeliveryCandidates(), []);

    const revised = await store.updateEvent(review.id, review.revision, { draft: draft({ course: 'architecture', attachment, details: 'نسخة جديدة' }) });
    assert.deepEqual((await store.listDeliveryCandidates(1)).map(event => [event.id, event.revision]), [[revised.id, revised.revision]]);
    await queueScheduledEventJobs(store, NOW);
    assert.ok(await store.getJob('review:repair-review:2:1-text'));
    assert.ok(await store.getJob('review:repair-review:2:0-attachment'));
    assert.deepEqual(await store.listDeliveryCandidates(), []);
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM outbox').first()).n;
    await queueScheduledEventJobs(store, NOW + 60_000);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM outbox').first()).n, count);
  });

  await suite.test('event queries persist paced replies and media in the original chat/topic without a publishing target', async () => {
    await db.prepare("UPDATE outbox SET state='cancelled' WHERE state IN ('pending','sending')").run();
    await store.saveSettings({ ownerUid: null, targetChatId: null, targetThreadId: null });
    const first = await store.createEvent(input('query-first', { draft: draft({ course: 'architecture', date: '2026-10-26' }), status: 'approved', approvedAt: NOW }));
    const media = await store.createEvent(input('query-media', { draft: draft({ course: 'visual', date: '2026-10-26', attachment: { kind: 'document', fileId: 'query-file' } }), status: 'approved', approvedAt: NOW }));
    await store.markPublished(media.id, media.revision, 777);
    const third = await store.createEvent(input('query-third', { draft: draft({ course: 'mobile', date: '2026-10-26' }), status: 'approved', approvedAt: NOW }));
    const fourth = await store.createEvent(input('query-fourth', { draft: draft({ course: 'networks', date: '2026-10-26' }), status: 'approved', approvedAt: NOW }));
    const request = { updateId: 800, chatId: -100999, threadId: 17, replyTo: 42, eventIds: [first.id, media.id, third.id, fourth.id] };
    await queueEventQuery(store, request, NOW);
    await queueEventQuery(store, request, NOW + 1);
    const queued = await db.prepare("SELECT id FROM outbox WHERE type='query' ORDER BY id").all();
    assert.deepEqual(queued.results.map(row => row.id), ['query:800:0:0-text', 'query:800:1:0-text', 'query:800:1:1-attachment', 'query:800:2:0-text']);
    const fake = telegramMock();
    const sleeps = [];
    assert.equal((await dispatchEventJobs(store, fake, NOW, { limit: 20, sleep: async milliseconds => { sleeps.push(milliseconds); } })).sent, 4);
    assert.equal(fake.calls.length, 4);
    assert.ok(fake.calls.every(call => call.payload.chat_id === request.chatId && call.payload.message_thread_id === request.threadId && call.payload.reply_parameters.message_id === request.replyTo));
    assert.ok(sleeps.length > 0 && sleeps.every(milliseconds => milliseconds <= 10_000));
    assert.equal(fake.calls.find(call => call.method === 'sendDocument').payload.document, 'query-file');
    assert.equal((await store.getEvent(first.id)).publishedMessageId, null);
    assert.equal((await store.getEvent(media.id)).publishedMessageId, 777);
    await queueEventQuery(store, request, NOW + 60_000);
    assert.equal((await dispatchEventJobs(store, fake, NOW + 60_000, { sleep: async () => {} })).sent, 0);
    assert.equal(fake.calls.length, 4);
  });

  await suite.test('query jobs retry Telegram failures and cancel changed, withdrawn or duplicate revisions', async () => {
    const event = await store.getEvent('query-first');
    const request = { updateId: 801, chatId: 101, threadId: null, replyTo: 43, eventIds: [event.id] };
    await queueEventQuery(store, request, NOW + 60_000);
    const failed = { async call() { throw new TelegramError(429, true, 90); } };
    assert.equal((await dispatchEventJobs(store, failed, NOW + 60_000, { sleep: async () => {} })).retried, 1);
    const retry = await store.getJob('query:801:0:0-text');
    assert.equal(retry.state, 'pending');
    assert.equal(retry.dueAt, NOW + 150_000);
    assert.equal(retry.lastError, 'telegram_429');
    const fake = telegramMock();
    assert.equal((await dispatchEventJobs(store, fake, retry.dueAt, { sleep: async () => {} })).sent, 1);
    assert.equal(fake.calls[0].payload.chat_id, 101);
    assert.equal(fake.calls[0].payload.message_thread_id, undefined);
    assert.equal(fake.calls[0].payload.reply_parameters.message_id, 43);

    const media = await store.getEvent('query-media');
    const third = await store.getEvent('query-third');
    await queueEventQuery(store, { ...request, updateId: 802, eventIds: [event.id, media.id, third.id] }, NOW + 180_000);
    await store.updateEvent(event.id, event.revision, { status: 'cancelled' });
    await store.updateEvent(media.id, media.revision, { duplicateOf: event.id });
    await store.updateEvent(third.id, third.revision, { draft: { ...third.draft, details: 'changed after this query was queued' } });
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW + 180_000, { limit: 20, sleep: async () => {} })).cancelled, 4);
    assert.equal(fake.calls.length, 0);
  });

  await suite.test('destination changes keep existing edits and media at their saved destination and exclude test notes from new reminders and awards', async () => {
    await store.saveSettings({ ownerUid: 1, targetChatId: -100333, targetThreadId: 9 });
    const original = await store.createEvent(input('snapshot-old', { authorId: 2001, authorName: 'old-test-author', draft: draft({ date: '2026-10-27', details: 'OLD_TEST_NOTE', attachment: { kind: 'document', fileId: 'old-test-file' } }), status: 'approved', approvedAt: NOW }));
    await queuePublish(store, original.id, original.revision, NOW);
    const fake = telegramMock();
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 2);
    const saved = await store.getEvent(original.id);
    assert.equal(saved.publishedChatId, -100333);
    assert.equal(saved.publishedThreadId, 9);
    await store.saveSettings({ targetChatId: -100444, targetThreadId: 19 });

    const pending = await store.updateEvent(saved.id, saved.revision, { status: 'pending', approvedAt: null, draft: { ...saved.draft, details: 'PRIVATE_EDIT', attachment: { kind: 'document', fileId: 'reapproved-file' } } });
    await queueStatusUpdate(store, pending.id, pending.revision, NOW + 60_000);
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW + 60_000, { sleep: async () => {} })).sent, 1);
    assert.equal(fake.calls[0].method, 'editMessageText');
    assert.equal(fake.calls[0].payload.chat_id, -100333);
    assert.equal(fake.calls[0].payload.message_thread_id, 9);
    assert.equal(fake.calls[0].payload.message_id, saved.publishedMessageId);
    assert.doesNotMatch(fake.calls[0].payload.text, /PRIVATE_EDIT/);
    const approved = await store.updateEvent(pending.id, pending.revision, { status: 'approved', approvedAt: NOW + 120_000 });
    await queuePublish(store, approved.id, approved.revision, NOW + 120_000);
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW + 120_000, { sleep: async () => {} })).sent, 2);
    assert.ok(fake.calls.every(call => call.payload.chat_id === -100333 && call.payload.message_thread_id === 9));
    assert.equal(fake.calls.find(call => call.method === 'sendDocument').payload.reply_parameters.message_id, saved.publishedMessageId);
    assert.equal((await store.getEvent(approved.id)).publishedChatId, -100333);

    const real = await store.createEvent(input('snapshot-new', { authorId: 2002, authorName: 'real-author', draft: draft({ course: 'mobile', date: '2026-10-27', details: 'REAL_STUDENT_NOTE' }), status: 'approved', approvedAt: NOW + 180_000 }));
    await queuePublish(store, real.id, real.revision, NOW + 180_000);
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW + 180_000, { sleep: async () => {} })).sent, 1);
    assert.equal(fake.calls[0].payload.chat_id, -100444);
    assert.equal(fake.calls[0].payload.message_thread_id, 19);
    const realSaved = await store.getEvent(real.id);
    assert.equal(realSaved.publishedChatId, -100444);
    assert.equal(realSaved.publishedThreadId, 19);
    await store.enqueueJob({ id: 'snapshot-digest', type: 'digest', payload: { date: '2026-10-27', heading: 'current target' }, dueAt: NOW + 240_000 });
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW + 240_000, { sleep: async () => {} })).sent, 1);
    assert.equal(fake.calls[0].payload.chat_id, -100444);
    assert.match(fake.calls[0].payload.text, /REAL_STUDENT_NOTE/);
    assert.match(fake.calls[0].payload.text, new RegExp(`https://t.me/c/444/${realSaved.publishedMessageId}`));
    assert.doesNotMatch(fake.calls[0].payload.text, /OLD_TEST_NOTE|PRIVATE_EDIT|old-test-author/);

    const from = NOW + 1, to = NOW + 300_000;
    assert.deepEqual((await store.weeklyContributors(from, to)).map(author => author.authorId), [2001, 2002]);
    assert.deepEqual((await store.weeklyContributors(from, to, -100333)).map(author => author.authorId), [2001]);
    assert.deepEqual((await store.weeklyContributors(from, to, -100444)).map(author => author.authorId), [2002]);
    await store.enqueueJob({ id: 'snapshot-award', type: 'award', payload: { from, to, period: 'current' }, dueAt: to });
    await store.enqueueJob({ id: 'snapshot-old-award', type: 'award', payload: { from, to, period: 'old', targetChatId: -100333 }, dueAt: to });
    await store.enqueueJob({ id: 'snapshot-old-award-page', type: 'award_page', payload: { text: 'OLD_TEST_NOTE', targetChatId: -100333 }, dueAt: to });
    fake.calls.length = 0;
    const awards = await dispatchEventJobs(store, fake, to, { sleep: async () => {} });
    assert.equal(awards.sent, 1);
    assert.equal(awards.cancelled, 2);
    assert.match(fake.calls[0].payload.text, /real-author/);
    assert.doesNotMatch(fake.calls[0].payload.text, /old-test-author|OLD_TEST_NOTE/);
  });

  await suite.test('D1/quota failures propagate instead of reporting a saved or delivered result', async () => {
    const fake = telegramMock();
    const unavailable = { async claimJobs() { throw new Error('synthetic D1 quota exceeded'); } };
    await assert.rejects(dispatchEventJobs(unavailable, fake, NOW), /synthetic D1 quota exceeded/);
    assert.equal(fake.calls.length, 0);
  });

  await suite.test('upcoming mixed-kind filters exclude past notes and put undated notes after actual dates; admin listing remains separate', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await db.prepare('DELETE FROM events').run();
    const examples = [
      ['old-exam', { kind: 'exam', date: '2026-10-18' }, 'approved'],
      ['future-quiz', { kind: 'quiz', date: '2026-10-21' }, 'approved'],
      ['future-exam', { kind: 'exam', date: '2026-10-20' }, 'approved'],
      ['future-homework', { kind: 'homework', date: '2026-10-20' }, 'approved'],
      ['undated-quiz', { kind: 'quiz', date: null, dateUnspecified: true }, 'approved'],
      ['needs-change', { kind: 'homework', date: '2026-10-22' }, 'needs_changes'],
      ['rejected-note', { kind: 'homework', date: '2026-10-23' }, 'rejected'],
      ['cancelled-note', { kind: 'homework', date: '2026-10-24' }, 'cancelled'],
    ];
    for (const [index, [id, fields, status]] of examples.entries()) await store.createEvent(input(id, { draft: draft(fields), status, submittedAt: NOW + index }));
    assert.deepEqual((await store.listApproved({ dateFrom: '2026-10-19', kinds: ['exam', 'quiz'] })).map(event => event.id), ['future-exam', 'future-quiz', 'undated-quiz']);
    assert.deepEqual(await store.listApproved({ kinds: [] }), []);
    assert.deepEqual((await store.listManageable(2)).map(event => event.id), ['needs-change', 'undated-quiz']);
    assert.deepEqual((await store.listManageable(2, 2)).map(event => event.id), ['future-homework', 'future-exam']);
  });

  await suite.test('closed calendar weeks include both boundaries and only matching approved dated notes before the result limit', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await db.prepare('DELETE FROM events').run();
    const attachment = { kind: 'document', fileId: 'literal-student-file-id', fileUniqueId: 'week-original-file', fileName: 'المحاضرات.pdf' };
    const examples = [
      ['range-start', { date: '2026-10-18' }, 'approved'],
      ['range-middle', { kind: 'quiz', date: '2026-10-21', attachment }, 'approved'],
      ['range-end', { date: '2026-10-24' }, 'approved'],
      ['range-before', { date: '2026-10-17' }, 'approved'],
      ['range-after', { date: '2026-10-25' }, 'approved'],
      ['range-undated', { date: null, dateUnspecified: true }, 'approved'],
      ['range-pending', { date: '2026-10-19' }, 'pending'],
      ['range-needs-changes', { date: '2026-10-19' }, 'needs_changes'],
      ['range-rejected', { date: '2026-10-19' }, 'rejected'],
      ['range-cancelled', { date: '2026-10-19' }, 'cancelled'],
      ['range-homework', { kind: 'homework', date: '2026-10-20' }, 'approved'],
      ['range-audience-A', { audience: 'A', date: '2026-10-20' }, 'approved'],
      ['range-other-course', { course: 'mobile', date: '2026-10-20' }, 'approved'],
    ];
    for (const [index, [id, fields, status]] of examples.entries()) {
      await store.createEvent(input(id, { draft: draft({ course: 'compilers', ...fields }), status, submittedAt: NOW + index }));
    }
    await store.createEvent(input('range-duplicate', {
      draft: draft({ course: 'compilers', date: '2026-10-18' }), status: 'approved', duplicateOf: 'range-start',
    }));
    // More than the ordinary result cap outside the week must never crowd out
    // matching rows: filtering belongs in SQL, before ORDER BY/LIMIT.
    const oldDraft = draft({ course: 'compilers', date: '2026-10-16' });
    await db.batch(Array.from({ length: 205 }, (_, index) => db.prepare(
      "INSERT INTO events(id,author_id,author_name,source_chat_id,body_json,status,event_date,course,kind,audience,submitted_at,fingerprint) VALUES(?,?,?,?,?,'approved',?,?,?,?,?,?)",
    ).bind(`range-old-${index}`, 101, 'طالب', 101, JSON.stringify(oldDraft), oldDraft.date, oldDraft.course, oldDraft.kind, oldDraft.audience, NOW, `old-range-fingerprint-${index}`)));
    const filter = { dateFrom: '2026-10-18', dateTo: '2026-10-24', course: 'compilers', kinds: ['exam', 'quiz'], audience: 'B' };
    const results = await store.listApproved(filter);
    assert.deepEqual(results.map(event => event.id), ['range-start', 'range-middle', 'range-end']);
    assert.deepEqual(results[1].draft.attachment, attachment);
    assert.deepEqual(await store.listApproved({ ...filter, dateFrom: '2026-10-25' }), []);
    assert.equal((await store.listApproved({ dateTo: '2026-10-24' })).some(event => event.id === 'range-undated'), false);
  });

  await suite.test('disposable feedback cleanup is idempotent, delayed and independent of chat send pacing', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await queueMessageCleanup(store, { chatId: 101, messageId: 88 }, NOW);
    await queueMessageCleanup(store, { chatId: 101, messageId: 88 }, NOW + 1000);
    assert.equal((await store.getJob('cleanup:101:88')).dueAt, NOW + 20_000);
    await assert.rejects(queueMessageCleanup(store, { chatId: 101, messageId: -4 }, NOW), /Invalid cleanup/);
    const fake = telegramMock();
    assert.equal((await dispatchEventJobs(store, fake, NOW + 19_999)).sent, 0);
    const reserve = store.reserveDelivery;
    store.reserveDelivery = async () => { throw new Error('cleanup must not reserve send slots'); };
    try { assert.equal((await dispatchEventJobs(store, fake, NOW + 20_000)).sent, 1); }
    finally { store.reserveDelivery = reserve; }
    assert.deepEqual(fake.calls, [{ method: 'deleteMessage', payload: { chat_id: 101, message_id: 88 } }]);
    assert.equal((await dispatchEventJobs(store, fake, NOW + 80_000)).sent, 0);
    assert.equal(fake.calls.length, 1);
  });

  await suite.test('cleanup retries rate limits but safely stops for missing or undeletable messages', async () => {
    await queueMessageCleanup(store, { chatId: 101, messageId: 89 }, NOW, 0);
    assert.equal((await dispatchEventJobs(store, { async call() { throw new TelegramError(429, true, 90); } }, NOW)).retried, 1);
    const retry = await store.getJob('cleanup:101:89');
    assert.equal(retry.dueAt, NOW + 90_000);
    const calls = [];
    assert.equal((await dispatchEventJobs(store, { async call(method, payload) { calls.push({ method, payload }); throw new TelegramError(400, false); } }, NOW + 90_000)).failed, 1);
    assert.equal((await store.getJob('cleanup:101:89')).state, 'failed');
    assert.deepEqual(calls.map(call => call.method), ['deleteMessage']);
  });

  await suite.test('review cleanup uses its saved owner destination and removes only the reviewed bot card and file', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await store.saveSettings({ ownerUid: 1, targetChatId: -100333, targetThreadId: null });
    const event = await store.createEvent(input('review-cleanup', { draft: draft({ course: 'mobile', date: '2026-10-28', attachment: { kind: 'photo', fileId: 'review-snapshot-file' } }) }));
    await queueReview(store, event.id, event.revision, NOW);
    const fake = telegramMock();
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 2);
    await store.saveSettings({ ownerUid: 2 });
    await queueReviewCleanup(store, event.id, event.revision, NOW, 0);
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 2);
    assert.deepEqual(fake.calls.map(call => [call.method, call.payload.chat_id, call.payload.message_id]), [['deleteMessage', 1, 501], ['deleteMessage', 1, 502]]);
    assert.equal((await store.getEvent(event.id)).status, 'pending');
  });

  await suite.test('explicit publication deletion removes the canonical post and all original attachments at their saved destination', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await db.prepare('DELETE FROM events').run();
    await store.saveSettings({ ownerUid: 1, targetChatId: -100333, targetThreadId: 9 });
    let nextId = 900;
    const calls = [];
    const fake = { async call(method, payload) { calls.push({ method, payload }); return { message_id: method === 'editMessageText' ? payload.message_id : ++nextId }; } };
    const original = await store.createEvent(input('deletion-media', { status: 'approved', draft: draft({ date: '2026-10-29', attachment: { kind: 'document', fileId: 'first-file' } }) }));
    await queuePublish(store, original.id, original.revision, NOW);
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).sent, 2);
    const saved = await store.getEvent(original.id);
    const second = await store.updateEvent(saved.id, saved.revision, { draft: { ...saved.draft, attachment: { kind: 'photo', fileId: 'second-file' } } });
    await queuePublish(store, second.id, second.revision, NOW + 60_000);
    assert.equal((await dispatchEventJobs(store, fake, NOW + 60_000, { sleep: async () => {} })).sent, 2);
    await store.saveSettings({ targetChatId: -100444, targetThreadId: 19 });

    // An ordinary author cancellation must not grant permission to remove public posts.
    const cancelled = await store.updateEvent(second.id, second.revision, { status: 'cancelled' });
    await queuePublicationDeletion(store, cancelled.id, cancelled.revision, NOW + 120_000);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='publication_delete'").first()).n, 0);
    const deleted = await store.requestPublicationDeletion(cancelled.id, cancelled.revision);
    assert.equal(deleted.publicationDeletionRevision, deleted.revision);
    assert.equal(await store.requestPublicationDeletion(deleted.id, cancelled.revision), null);
    await queuePublicationDeletion(store, deleted.id, deleted.revision, NOW + 120_000);
    await queuePublicationDeletion(store, deleted.id, deleted.revision, NOW + 120_001);
    calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW + 120_001, { sleep: async () => {} })).sent, 3);
    assert.deepEqual(calls.map(call => [call.method, call.payload.chat_id, call.payload.message_id]).sort((a, b) => a[2] - b[2]), [
      ['deleteMessage', -100333, 901], ['deleteMessage', -100333, 902], ['deleteMessage', -100333, 903],
    ]);
    assert.deepEqual(await store.listPublicationDeletionTargets(deleted.id, deleted.revision), []);
    assert.equal((await store.listApproved()).some(event => event.id === deleted.id), false);
    assert.equal((await store.listManageable()).some(event => event.id === deleted.id), false);
  });

  await suite.test('deletion recovery stays bounded and invalidates jobs if the revision changes before delivery', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await db.prepare('DELETE FROM events').run();
    await store.saveSettings({ ownerUid: 1, targetChatId: null, targetThreadId: null });
    const event = await store.createEvent(input('delete-many', { status: 'approved', draft: draft({ date: '2026-10-30' }) }));
    await store.markPublished(event.id, event.revision, 1000, -100333);
    for (let index = 0; index < 8; index++) {
      await store.enqueueJob({ id: `publish:delete-many:${index + 1}:1-attachment`, type: 'publish', payload: { eventId: event.id, revision: index + 1, part: 'attachment' }, dueAt: NOW });
      const [job] = await store.claimJobs(NOW, 1);
      await store.completeJob(job.id, job.leaseToken, 1001 + index, -100333);
    }
    const deleted = await store.requestPublicationDeletion(event.id, event.revision);
    // Simulate a crash after persisting the tombstone and before enqueuing anything.
    let statements = 0;
    const counted = new EventStore({ prepare(query) { statements++; return db.prepare(query); }, batch(queries) { statements += queries.length; return db.batch(queries); } });
    const fake = telegramMock();
    for (let sweep = 0; sweep < 3; sweep++) {
      const before = statements;
      await queueScheduledEventJobs(counted, NOW + sweep * 60_000);
      await dispatchEventJobs(counted, fake, NOW + sweep * 60_000, { sleep: async () => {} });
      assert.ok(statements - before <= 50, `per-sweep statements: ${statements - before}`);
      assert.equal(fake.calls.length, (sweep + 1) * 3);
    }
    assert.deepEqual(await store.listDeliveryCandidates(), []);

    const stale = await store.createEvent(input('delete-stale', { draft: draft({ course: 'networks', date: '2026-10-30' }), status: 'approved' }));
    await store.markPublished(stale.id, stale.revision, 2000, -100333);
    const tombstone = await store.requestPublicationDeletion(stale.id, stale.revision);
    await queuePublicationDeletion(store, tombstone.id, tombstone.revision, NOW);
    await store.updateEvent(tombstone.id, tombstone.revision, { status: 'approved' });
    fake.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, fake, NOW, { sleep: async () => {} })).cancelled, 1);
    assert.equal(fake.calls.length, 0);
  });

  await suite.test('publication deletion retries 429 and withdraws old Telegram text and media when physical removal is unavailable', async () => {
    await db.prepare('DELETE FROM outbox').run();
    await db.prepare('DELETE FROM events').run();
    const event = await store.createEvent(input('delete-old', { status: 'approved' }));
    await store.markPublished(event.id, event.revision, 3000, -100333);
    await store.enqueueJob({ id: 'publish:delete-old:1:1-attachment', type: 'publish', payload: { eventId: event.id, revision: 1, part: 'attachment' }, dueAt: NOW });
    const [attachment] = await store.claimJobs(NOW, 1);
    await store.completeJob(attachment.id, attachment.leaseToken, 3001, -100333);
    const deleted = await store.requestPublicationDeletion(event.id, event.revision);
    await queuePublicationDeletion(store, deleted.id, deleted.revision, NOW);
    assert.equal((await dispatchEventJobs(store, { async call() { throw new TelegramError(429, true, 90); } }, NOW)).retried, 2);
    const calls = [];
    const oldMessage = { async call(method, payload) {
      calls.push({ method, payload });
      if (method === 'deleteMessage') throw new TelegramError(400, false);
      return { message_id: payload.message_id };
    } };
    assert.equal((await dispatchEventJobs(store, oldMessage, NOW + 90_000, { sleep: async () => {} })).sent, 2);
    assert.deepEqual(calls.map(call => call.method), ['deleteMessage', 'editMessageText', 'deleteMessage', 'editMessageCaption']);
    assert.ok(calls.filter(call => call.method.startsWith('edit')).every(call => /انحذف/.test(call.payload.text ?? call.payload.caption)));
    assert.equal((await store.getJob(`delete:${deleted.id}:${deleted.revision}:-100333:3000`)).lastError, 'withdrawal_fallback');
    const notices = telegramMock();
    assert.equal((await dispatchEventJobs(store, notices, NOW + 91_000, { sleep: async () => {} })).sent, 2);
    assert.ok(notices.calls.every(call => call.method === 'sendMessage' && call.payload.chat_id === 1));
    assert.match(notices.calls[0].payload.text, /وسّمته ملغي/);
    assert.match(notices.calls[0].payload.text, /https:\/\/t.me\/c\/333\/3000/);

    const inaccessible = await store.createEvent(input('delete-uneditable', { status: 'approved' }));
    await store.markPublished(inaccessible.id, inaccessible.revision, 4000, -100333);
    const tombstone = await store.requestPublicationDeletion(inaccessible.id, inaccessible.revision);
    await queuePublicationDeletion(store, tombstone.id, tombstone.revision, NOW + 120_000);
    assert.equal((await dispatchEventJobs(store, { async call() { throw new TelegramError(403, false); } }, NOW + 120_000)).failed, 1);
    assert.equal((await store.getJob(`delete:${tombstone.id}:${tombstone.revision}:-100333:4000`)).lastError, 'telegram_403');
    notices.calls.length = 0;
    assert.equal((await dispatchEventJobs(store, notices, NOW + 180_000, { sleep: async () => {} })).sent, 1);
    assert.match(notices.calls[0].payload.text, /تعذّر حذف أو تعديل/);
    assert.doesNotMatch(notices.calls[0].payload.text, /وسّمته ملغي/);
  });
});
