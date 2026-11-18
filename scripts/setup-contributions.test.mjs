import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { instructionsHtml, main, prepareSetup, showSetupLocally, tokenHash, uploadOwnerHash } from './setup-contributions.mjs';
import { publicError, SetupError } from './setup.mjs';

const token = 'a'.repeat(43);
const setup = { token, tokenHash: tokenHash(token), createdAt: '2026-10-15T00:00:00.000Z' };

test('owner bootstrap uses a random 32-byte token, persists privately and resumes without rotating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daabool-owner-'));
  try {
    const local = join(directory, '.local');
    const first = await prepareSetup(local);
    assert.equal(Buffer.from(first.token, 'base64url').byteLength, 32);
    assert.equal(first.tokenHash, tokenHash(first.token));
    assert.equal((await lstat(join(local, 'contributions-setup.json'))).mode & 0o777, 0o600);
    assert.equal((await lstat(first.htmlPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(local)).mode & 0o777, 0o700);
    assert.equal((await prepareSetup(local)).token, first.token);
    assert.ok((await readFile(first.htmlPath, 'utf8')).includes(`دعبول إعداد ${first.token}`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('private HTML contains no remote scripts or secret-bearing URLs', () => {
  const html = instructionsHtml(token);
  assert.ok(html.includes(`دعبول إعداد ${token}`));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes(`https://t.me/daaboolbot?`));
  assert.throws(() => instructionsHtml('<script>'), SetupError);
});

test('setup token display refuses tool/noninteractive output and is local-Terminal-only', () => {
  for (const value of [
    { input: { isTTY: false }, output: { isTTY: true }, environment: { TERM_PROGRAM: 'Apple_Terminal' } },
    { input: { isTTY: true }, output: { isTTY: true }, environment: { TERM_PROGRAM: 'Apple_Terminal', CODEX_THREAD_ID: 'test' } },
    { input: { isTTY: true }, output: { isTTY: true }, environment: { TERM_PROGRAM: 'Apple_Terminal', CI: 'true' } },
    { input: { isTTY: true }, output: { isTTY: true }, environment: {} },
  ]) assert.throws(() => showSetupLocally(setup, value), error => !publicError(error).includes(token));
  let displayed = '';
  showSetupLocally(setup, { input: { isTTY: true }, output: { isTTY: true, write: value => { displayed += value; } }, environment: { TERM_PROGRAM: 'Apple_Terminal' } });
  assert.ok(displayed.includes(`دعبول إعداد ${token}`));
});

test('secret upload passes only SHA-256 via stdin and suppresses child logs', async () => {
  let request;
  let sent;
  await uploadOwnerHash(setup.tokenHash, { environment: { TELEGRAM_BOT_TOKEN: 'unused-secret', OWNER_SETUP_TOKEN_HASH: 'unused' }, spawnImpl(executable, args, options) {
    request = { executable, args, options };
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = value => { sent = value; queueMicrotask(() => child.emit('close', 0)); };
    child.kill = () => {};
    return child;
  } });
  assert.ok(request.args.includes('OWNER_SETUP_TOKEN_HASH'));
  assert.ok(!request.args.includes(token));
  assert.ok(!request.args.includes(setup.tokenHash));
  assert.equal(sent, `${setup.tokenHash}\n`);
  assert.deepEqual(request.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(request.options.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(request.options.env.OWNER_SETUP_TOKEN_HASH, undefined);
  assert.throws(() => uploadOwnerHash(token), SetupError);
});

test('default helper outputs no token and only requests uploading its hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daabool-owner-main-'));
  let displayed = '';
  let uploaded;
  try {
    await main([], { directory, uploadHash: async hash => { uploaded = hash; }, output: { write: value => { displayed += value; } } });
    const saved = JSON.parse(await readFile(join(directory, 'contributions-setup.json'), 'utf8'));
    assert.equal(uploaded, saved.tokenHash);
    assert.ok(!displayed.includes(saved.token));
    assert.ok(!displayed.includes(saved.tokenHash));
    await assert.rejects(main([token]), error => !publicError(error).includes(token));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
