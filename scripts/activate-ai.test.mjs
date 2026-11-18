import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateAi } from './activate-ai.mjs';
import { writePrivateJson } from './setup.mjs';

const KEY = 'synthetic-groq-key';
const WORKER = 'https://your-worker.example.workers.dev';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'daabool-activate-ai-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writePrivateJson(join(directory, '.local', 'deployment.json'), { workerUrl: WORKER });
  const calls = []; const progress = []; const requests = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (overrides.command) {
      const result = overrides.command(args, options);
      if (result !== undefined) return await result;
    }
    if (args.includes('check')) return 'local checks passed';
    if (args.includes('whoami')) return JSON.stringify({ loggedIn: true, accounts: [{ id: 'private-account-marker' }], email: 'private-email-marker' });
    if (args.includes('migrations')) return 'Migrations applied';
    if (args.includes('execute')) {
      const sql = args[args.indexOf('--command') + 1];
      return JSON.stringify([{ success: true, results: sql.includes('ready_tables') ? [{ ready_tables: 12 }]
        : [{ target_configured: overrides.target === false ? 0 : 1, reminders_enabled: overrides.target === false ? 0 : 1 }] }]);
    }
    if (args.includes('secret')) return 'Secret uploaded';
    if (args.includes('--dry-run')) return 'Dry run passed';
    if (args.includes('deploy')) return `Uploaded worker\n${WORKER}`;
    throw new Error('Unexpected local command');
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (overrides.fetchImpl) return overrides.fetchImpl(url, init);
    if (url === 'https://api.groq.com/openai/v1/chat/completions') {
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
    }
    if (url === `${WORKER}/health`) return Response.json({ service: 'daabool-telegram-bot', status: 'ready' });
    throw new Error('Unexpected network destination');
  };
  return { directory, calls, progress, requests, options: { directory, run, fetchImpl, onProgress: text => progress.push(text), skipChecks: true } };
}

test('activation validates and privately saves a key, probes synthetic JSON, then migrates, uploads, deploys and enables reminders', async t => {
  const f = await fixture(t);
  const result = await activateAi(` ${KEY} `, f.options);
  assert.deepEqual({ ...result, checkedAt: '' }, { active: true, workerUrl: WORKER, model: 'openai/gpt-oss-120b', remindersEnabled: true, checkedAt: '' });
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  const file = join(f.directory, '.local', 'assistant-secrets.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).GROQ_API_KEY, KEY);
  assert.deepEqual(f.calls.map(call => call.args.slice(1, 4)), [
    ['whoami', '--json'], ['deploy', '--dry-run', '--outdir'], ['d1', 'migrations', 'apply'],
    ['d1', 'execute', 'DB'], ['secret', 'put', 'GROQ_API_KEY'], ['deploy'], ['d1', 'execute', 'DB'],
  ]);
  const upload = f.calls.find(call => call.args.includes('secret'));
  assert.equal(upload.options.stdin, `${KEY}\n`);
  assert.ok(f.calls.every(call => call.options.directory === f.directory && !call.args.includes(KEY)));
  assert.ok(f.calls.every(call => call.args[0] === join(f.directory, 'node_modules/wrangler/bin/wrangler.js')));
  assert.equal(f.requests.length, 2);
  const probe = f.requests[0];
  assert.equal(probe.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(probe.init.redirect, 'error');
  assert.ok(probe.init.signal instanceof AbortSignal);
  assert.match(JSON.stringify(JSON.parse(probe.init.body)), /activation_probe/);
  assert.equal(JSON.parse(probe.init.body).model, 'openai/gpt-oss-120b');
  assert.equal(JSON.parse(probe.init.body).response_format.json_schema.strict, true);
  assert.ok(!JSON.stringify(f.requests).includes('api.telegram.org'));
  const publicText = JSON.stringify([f.progress, result]);
  assert.ok(!publicText.includes(KEY));
  assert.ok(!publicText.includes('private-account-marker'));
  assert.ok(!publicText.includes('private-email-marker'));
  const enable = f.calls.at(-1).args.at(-1);
  assert.match(enable, /enabled_at=\d+,generation=generation\+1/);
  assert.match(enable, /enabled=0 AND EXISTS/);
});

test('default activation runs local npm check and the dry build before production changes', async t => {
  const f = await fixture(t);
  await activateAi(KEY, { ...f.options, skipChecks: false });
  const check = f.calls.findIndex(call => call.args.includes('check'));
  const build = f.calls.findIndex(call => call.args.includes('--dry-run'));
  const migrate = f.calls.findIndex(call => call.args.includes('migrations'));
  assert.ok(check >= 0 && check < build && build < migrate);
  assert.match(f.calls[check].args[0], /npm(?:-cli)?(?:\.js)?$/);
});

test('invalid key syntax never reaches disk, a child command or a provider', async t => {
  const f = await fixture(t);
  await assert.rejects(activateAi('invalid', f.options), /المفتاح غير صالح/);
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(join(f.directory, '.local', 'assistant-secrets.json')), { code: 'ENOENT' });
});

test('invalid provider keys and exhausted quota stop before any production command without exposing errors', async t => {
  for (const status of [401, 403, 429, 500]) {
    const f = await fixture(t, { fetchImpl: async () => new Response(`provider-private-error:${KEY}`, { status }) });
    await assert.rejects(activateAi(KEY, f.options), error => {
      assert.ok(!error.message.includes(KEY));
      assert.ok(!error.message.includes('provider-private-error'));
      assert.match(error.message, status === 429 ? /حصة Groq مستنفدة/ : /Groq/);
      return true;
    });
    assert.equal(f.calls.length, 0);
    assert.ok(!f.progress.some(line => line.includes('اكتمل التفعيل')));
  }
});

test('refused, malformed and oversized synthetic model replies cannot activate production', async t => {
  for (const data of [
    { choices: [{ finish_reason: 'stop', message: { content: '{"ok":false}' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{"ok":true}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', refusal: 'private-refusal' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(20_000) } }] },
  ]) {
    const f = await fixture(t, { fetchImpl: async () => Response.json(data) });
    await assert.rejects(activateAi(KEY, f.options), /لم يؤكد نموذج Groq/);
    assert.equal(f.calls.length, 0);
  }
});

test('failed Cloudflare authentication, checks, migrations and schema verification stop later stages and redact child output', async t => {
  for (const fail of ['whoami', 'check', 'migrations', 'schema']) {
    const f = await fixture(t, { command: args => {
      if (fail === 'schema' && args.includes('execute')) return JSON.stringify([{ success: true, results: [{ ready_tables: 11 }] }]);
      if (args.includes(fail)) throw new Error(`private-child-output:${KEY}`);
    } });
    await assert.rejects(activateAi(KEY, { ...f.options, skipChecks: false }), error => {
      assert.ok(!error.message.includes(KEY)); assert.ok(!error.message.includes('private-child-output')); return true;
    });
    assert.ok(!f.calls.some(call => call.args.includes('secret')));
    assert.ok(!f.calls.some(call => call.args.includes('deploy') && !call.args.includes('--dry-run')));
    assert.ok(!f.progress.some(line => line.includes('اكتمل التفعيل')));
  }
});

test('a changed deployment origin or failed health check never enables reminders or claims activation', async t => {
  for (const mode of ['origin', 'health']) {
    const f = await fixture(t, {
      command: args => mode === 'origin' && args.includes('deploy') && !args.includes('--dry-run')
        ? 'https://daabool-telegram-bot.other-account.workers.dev' : undefined,
      ...(mode === 'health' ? { fetchImpl: async url => url.endsWith('/health') ? Response.json({ status: 'not_configured' }, { status: 503 })
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) } : {}),
    });
    await assert.rejects(activateAi(KEY, f.options), /لم يُؤكَّد التفعيل|لم يؤكد الجاهزية/);
    assert.equal(f.calls.filter(call => call.args.includes('execute')).length, 1);
    assert.ok(!f.progress.some(line => line.includes('اكتمل التفعيل')));
  }
});

test('activation can use the configured saved origin and reports missing reminder destination without sending Telegram messages', async t => {
  const f = await fixture(t, { target: false, command: args => args.includes('deploy') && !args.includes('--dry-run') ? 'Deployment succeeded' : undefined });
  const result = await activateAi(KEY, f.options);
  assert.equal(result.workerUrl, WORKER);
  assert.equal(result.active, true);
  assert.equal(result.remindersEnabled, false);
  assert.match(f.progress.at(-1), /اربط كروب النشر/);
  assert.ok(f.requests.every(request => !request.url.startsWith('https://api.telegram.org/')));
});

test('async progress listeners are awaited and their failures cannot leak errors or interrupt activation', async t => {
  const f = await fixture(t); const messages = [];
  const result = await activateAi(KEY, { ...f.options, onProgress: async text => {
    await Promise.resolve(); messages.push(text);
    if (messages.length === 2) throw new Error(`private-progress-error:${KEY}`);
  } });
  assert.equal(result.active, true);
  assert.match(messages.at(-1), /اكتمل التفعيل/);
  assert.ok(messages.length >= 10);
});
