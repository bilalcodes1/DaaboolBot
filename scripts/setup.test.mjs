import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkDeployment, commandFailure, deploymentUrl, main, promptSecret, publicError, readPrivateJson,
  redact, SetupError, telegramCall, validateSecrets, workerOrigin, writePrivateJson, WEBHOOK_UPDATE_TYPES,
} from './setup.mjs';

// Test credentials are deliberately synthetic, never read from the user's environment.
const TOKEN = `123456789:${'x'.repeat(35)}`;
const WEBHOOK_SECRET = 'w'.repeat(43);
const SECRETS = { TELEGRAM_BOT_TOKEN: TOKEN, WEBHOOK_SECRET_TOKEN: WEBHOOK_SECRET };
const ORIGIN = 'https://daabool-telegram-bot.example.workers.dev';

class TerminalInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  setRawMode(value) { this.isRaw = value; }
  resume() { this.paused = false; }
  pause() { this.paused = true; }
}

function terminal() {
  const input = new TerminalInput();
  let displayed = '';
  const output = { isTTY: true, write(value) { displayed += value; } };
  return { input, output, displayed: () => displayed };
}

test('the hidden prompt never echoes a pasted token and restores terminal state', async () => {
  const tty = terminal();
  const answer = promptSecret(tty);
  assert.equal(tty.input.isRaw, true);
  tty.input.emit('data', Buffer.from(`${TOKEN}\r`));
  assert.equal(await answer, TOKEN);
  assert.equal(tty.input.isRaw, false);
  assert.equal(tty.input.paused, true);
  assert.equal(tty.input.listenerCount('data'), 0);
  assert.ok(!tty.displayed().includes(TOKEN));
  assert.ok(tty.displayed().endsWith('\n'));
});

test('hidden input handles correction, cancellation, oversized input and non-TTY safely', async () => {
  const corrected = terminal();
  const answer = promptSecret(corrected);
  corrected.input.emit('data', Buffer.from('abcx\u007f\r'));
  assert.equal(await answer, 'abc');
  for (const value of ['\u0003', '\u0004', 'x'.repeat(257), '\u001b']) {
    const tty = terminal();
    const cancelled = promptSecret(tty);
    tty.input.emit('data', Buffer.from(value));
    await assert.rejects(cancelled, SetupError);
    assert.equal(tty.input.isRaw, false);
    assert.equal(tty.input.listenerCount('data'), 0);
    assert.ok(!tty.displayed().includes('x'.repeat(257)));
  }
  assert.throws(() => promptSecret({ input: { isTTY: false }, output: { isTTY: true } }), SetupError);
});

test('the hidden prompt restores existing raw mode and cleans up stream errors', async () => {
  const tty = terminal();
  tty.input.isRaw = true;
  const answer = promptSecret(tty);
  tty.input.emit('error', new Error(TOKEN));
  await assert.rejects(answer, (error) => !publicError(error).includes(TOKEN));
  assert.equal(tty.input.isRaw, true);
});

test('private JSON persists with 0600, repairs insecure file mode and rejects symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daabool-setup-'));
  const local = join(directory, '.local');
  const path = join(local, 'secrets.json');
  try {
    await writePrivateJson(path, SECRETS);
    assert.equal((await lstat(local)).mode & 0o777, 0o700);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivateJson(path), SECRETS);
    await chmod(path, 0o644);
    await readPrivateJson(path);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), SECRETS);
    const link = join(local, 'linked.json');
    await symlink(path, link);
    await assert.rejects(readPrivateJson(link), SetupError);
    const localLink = join(directory, 'local-link');
    await symlink(local, localLink);
    await assert.rejects(writePrivateJson(join(localLink, 'unsafe.json'), SECRETS), SetupError);
    assert.equal(await readPrivateJson(join(local, 'missing.json')), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('secret validation keeps only required keys and redaction removes values and Telegram URLs', () => {
  assert.deepEqual(validateSecrets({ ...SECRETS, unexpected: TOKEN }), SECRETS);
  for (const invalid of [null, {}, { ...SECRETS, TELEGRAM_BOT_TOKEN: 'bad' }, { ...SECRETS, WEBHOOK_SECRET_TOKEN: 'tiny' }]) {
    assert.throws(() => validateSecrets(invalid), SetupError);
  }
  const safe = redact(`https://api.telegram.org/bot${TOKEN}/getMe ${TOKEN} ${WEBHOOK_SECRET}`, Object.values(SECRETS));
  assert.ok(!safe.includes(TOKEN));
  assert.ok(!safe.includes(WEBHOOK_SECRET));
  assert.ok(!publicError(new Error(`failed ${TOKEN}`)).includes(TOKEN));
});

test('actual workers.dev deployment URL is extracted without accepting preview or hostile URLs', () => {
  assert.equal(deploymentUrl(`Uploaded\n\u001b[32m${ORIGIN}\u001b[0m\nCurrent Version ID: abc`), ORIGIN);
  assert.equal(workerOrigin(`${ORIGIN}/`), ORIGIN);
  for (const candidate of [
    `${ORIGIN}.evil.example`, `${ORIGIN}/path`, `${ORIGIN}?token=x`, `${ORIGIN}#x`,
    ORIGIN.replace('https:', 'http:'), ORIGIN.replace('example.', 'preview.example.'),
    ORIGIN.replace('daabool-telegram-bot', 'another-worker'),
    'https://user:secret@daabool-telegram-bot.example.workers.dev',
  ]) {
    assert.equal(workerOrigin(candidate), null);
    assert.throws(() => deploymentUrl(candidate), SetupError);
  }
});

test('Telegram uses JSON POST, disables redirects and suppresses malicious API error details', async () => {
  let request;
  const result = await telegramCall(TOKEN, 'setWebhook', { url: `${ORIGIN}/webhook`, secret_token: WEBHOOK_SECRET }, async (url, options) => {
    request = { url, options };
    return Response.json({ ok: true, result: true });
  });
  assert.equal(result, true);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { url: `${ORIGIN}/webhook`, secret_token: WEBHOOK_SECRET });
  for (const fetcher of [
    async () => { throw new Error(`request https://api.telegram.org/bot${TOKEN}/getMe`); },
    async () => Response.json({ ok: false, description: `${TOKEN} ${WEBHOOK_SECRET}` }, { status: 401 }),
    async () => new Response(TOKEN, { status: 500 }),
  ]) {
    await assert.rejects(telegramCall(TOKEN, 'getMe', {}, fetcher), (error) => {
      assert.ok(error instanceof SetupError);
      assert.ok(!publicError(error).includes(TOKEN));
      assert.ok(!publicError(error).includes(WEBHOOK_SECRET));
      return true;
    });
  }
});

function deploymentFetch({ forbiddenStatus = 403, authenticatedStatus = 200, healthStatus = 'ready', webhookUrl = `${ORIGIN}/webhook`, allowedUpdates = ['message', 'inline_query'] } = {}) {
  const requests = [];
  const fetcher = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/getMe')) return Response.json({ ok: true, result: {
      is_bot: true, username: 'ActualDaaboolBot', can_join_groups: true,
      supports_inline_queries: false, can_read_all_group_messages: false,
      unexpectedSecret: TOKEN,
    } });
    if (url.endsWith('/getWebhookInfo')) return Response.json({ ok: true, result: {
      url: webhookUrl, pending_update_count: 0, allowed_updates: allowedUpdates,
      last_error_message: TOKEN,
    } });
    if (url.endsWith('/health')) return Response.json({ service: 'daabool-telegram-bot', status: healthStatus, timezone: 'Asia/Baghdad' });
    return Response.json({}, { status: options.headers?.['X-Telegram-Bot-Api-Secret-Token'] ? authenticatedStatus : forbiddenStatus });
  };
  return { fetcher, requests };
}

test('deployment check validates health, webhook URL, secret acceptance and public BotFather flags without messages', async () => {
  const mock = deploymentFetch();
  const status = await checkDeployment(SECRETS, ORIGIN, mock.fetcher);
  assert.equal(status.botUsername, 'ActualDaaboolBot');
  assert.equal(status.supportsInlineQueries, false);
  assert.equal(status.canJoinGroups, true);
  assert.equal(status.canReadAllGroupMessages, false);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  assert.ok(!JSON.stringify(status).includes(WEBHOOK_SECRET));
  assert.equal(mock.requests.filter(({ url }) => url.endsWith('/webhook')).length, 2);
  assert.ok(mock.requests.every(({ url }) => !/sendMessage|answerInlineQuery|setWebhook/.test(url)));
  const authenticated = mock.requests.find(({ options }) => options.headers?.['X-Telegram-Bot-Api-Secret-Token']);
  assert.deepEqual(JSON.parse(authenticated.options.body), { update_id: 0 });
});

test('new webhook registrations include callbacks and contribution checks require them without breaking legacy bots', async () => {
  assert.deepEqual(WEBHOOK_UPDATE_TYPES, ['message', 'inline_query', 'callback_query', 'channel_post']);
  assert.equal((await checkDeployment(SECRETS, ORIGIN, deploymentFetch().fetcher)).supportsCallbackQueries, false);
  await assert.rejects(checkDeployment(SECRETS, ORIGIN, deploymentFetch().fetcher, { contributionsEnabled: true }), SetupError);
  const status = await checkDeployment(SECRETS, ORIGIN, deploymentFetch({ allowedUpdates: WEBHOOK_UPDATE_TYPES }).fetcher, { contributionsEnabled: true });
  assert.equal(status.supportsCallbackQueries, true);
});

test('deployment verification fails closed on misconfiguration and never trusts a foreign hostname', async () => {
  for (const change of [
    { forbiddenStatus: 200 }, { authenticatedStatus: 403 }, { healthStatus: 'not_configured' },
    { webhookUrl: 'https://other.example/webhook' },
  ]) {
    await assert.rejects(checkDeployment(SECRETS, ORIGIN, deploymentFetch(change).fetcher), SetupError);
  }
  let called = false;
  await assert.rejects(checkDeployment(SECRETS, 'https://evil.example', async () => { called = true; }), SetupError);
  assert.equal(called, false);
});

test('command-line token entry and incompatible flags are rejected before any network request', async () => {
  await assert.rejects(main([TOKEN]), (error) => !publicError(error).includes(TOKEN));
  await assert.rejects(main(['--check', '--replace-token']), SetupError);
});

test('Wrangler failures report a safe subdomain action or exit status without echoing captured details', () => {
  const output = `You need to register a workers.dev subdomain before publishing to workers.dev\n${TOKEN}\n${WEBHOOK_SECRET}\nhttps://dash.cloudflare.com/private-account/workers/onboarding`;
  const message = publicError(commandFailure('نشر Worker', output, 1));
  assert.ok(message.includes('workers.dev'));
  assert.ok(message.includes('npx wrangler deploy'));
  assert.ok(message.includes('npm run setup'));
  for (const privateValue of [TOKEN, WEBHOOK_SECRET, 'private-account', 'https://dash.cloudflare.com']) {
    assert.ok(!message.includes(privateValue));
  }
  const generic = publicError(commandFailure('رفع أسرار Worker', `${TOKEN} ${WEBHOOK_SECRET}`, 2));
  assert.ok(generic.includes('2'));
  assert.ok(!generic.includes(TOKEN));
  assert.ok(!generic.includes(WEBHOOK_SECRET));
  assert.ok(publicError(commandFailure('Wrangler', TOKEN, null, true)).includes('مهلة'));
});
