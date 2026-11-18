#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPrivateJson, writePrivateJson, SetupError, publicError } from './setup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.local');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function tokenHash(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new SetupError('رمز إعداد المساهمات المحلي غير صالح.');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function validateSetup(value) {
  if (!value || typeof value !== 'object' || typeof value.token !== 'string'
    || value.tokenHash !== tokenHash(value.token)) throw new SetupError('ملف إعداد المساهمات غير صالح؛ لم تُرفع أي قيمة.');
  return { token: value.token, tokenHash: value.tokenHash, createdAt: value.createdAt };
}

export function instructionsHtml(token) {
  tokenHash(token);
  // The token alphabet cannot introduce markup. No third-party assets or scripts.
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width"><title>إعداد دعبول المحلي</title><style>body{font:18px system-ui;max-width:700px;margin:50px auto;padding:20px;line-height:1.8}textarea{width:100%;box-sizing:border-box;padding:16px;font:16px monospace;direction:ltr}a{color:#176b53}</style><h1>ربط مالك دعبول</h1><p>هذه تعليمات خاصة محفوظة في جهازك. لا تشارك الملف أو الرمز، ولا ترسلهما في محادثة عامة أو إلى Codex.</p><ol><li>افتح <a href="https://t.me/daaboolbot" rel="noreferrer">محادثة دعبول الخاصة</a>.</li><li>انسخ النص التالي وأرسله إلى البوت في الخاص مرة واحدة:</li></ol><textarea readonly rows="3" aria-label="رسالة الإعداد الخاصة">دعبول إعداد ${token}</textarea><p>بعد ربط حسابك كمالك، اتبع أزرار البوت لاختيار مجموعة النشر وإكمال الإعداد. يُستخدم الرمز مرة واحدة؛ الخادم يحتفظ ببصمته SHA-256 فقط، وتمنع قاعدة البيانات إعادة ربط مالك ثانٍ.</p><p>الأداة لا تنشئ قاعدة D1 ولا تبني كود المشروع. رفع البصمة بواسطة Wrangler يحدّث نسخة Worker المنشورة؛ يجب إكمال تجهيز قاعدة البيانات والنشر قبل إرسال رسالة الربط.</p></html>`;
}

async function writePrivateHtml(path, html) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SetupError('مجلد التعليمات المحلي غير آمن.');
  await chmod(directory, 0o700);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(html, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    if (file) await file.close();
    await rm(temporary, { force: true });
  }
}

export async function prepareSetup(directory = LOCAL) {
  const path = join(directory, 'contributions-setup.json');
  let saved = await readPrivateJson(path);
  if (!saved) {
    const token = randomBytes(32).toString('base64url');
    saved = { token, tokenHash: tokenHash(token), createdAt: new Date().toISOString() };
    await writePrivateJson(path, saved);
  }
  saved = validateSetup(saved);
  const htmlPath = join(directory, 'contributions-setup.html');
  await writePrivateHtml(htmlPath, instructionsHtml(saved.token));
  return { ...saved, htmlPath };
}

export function uploadOwnerHash(hash, { spawnImpl = spawn, environment = process.env, timeout = 90_000 } = {}) {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) throw new SetupError('بصمة إعداد المالك غير صالحة.');
  return new Promise((resolveUpload, reject) => {
    const env = { ...environment, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
    for (const key of ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_SECRET_TOKEN', 'OWNER_SETUP_TOKEN_HASH', 'WRANGLER_OUTPUT_FILE_PATH', 'WRANGLER_OUTPUT_FILE_DIRECTORY']) delete env[key];
    const child = spawnImpl(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', 'OWNER_SETUP_TOKEN_HASH'], {
      cwd: ROOT, env, stdio: ['pipe', 'ignore', 'ignore'],
    });
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolveUpload();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new SetupError('انتهت مهلة رفع بصمة المالك. افحص تفويض Cloudflare وأعد تشغيل الأداة.'));
    }, timeout);
    child.on('error', () => finish(new SetupError('تعذّر تشغيل Wrangler لرفع بصمة المالك.')));
    child.on('close', code => finish(code === 0 ? undefined : new SetupError('لم تُرفع بصمة المالك. افحص تفويض Cloudflare وإعداد Worker ثم أعد المحاولة.')));
    child.stdin.on('error', () => {});
    child.stdin.end(`${hash}\n`);
  });
}

export function showSetupLocally(setup, { input = process.stdin, output = process.stdout, environment = process.env } = {}) {
  // A tool-allocated PTY is not permission to expose this token in tool output.
  if (!input.isTTY || !output.isTTY || environment.CI || environment.CODEX_THREAD_ID
    || environment.CODEX_SANDBOX || !environment.TERM_PROGRAM) {
    throw new SetupError('عرض الرمز متاح فقط في Terminal محلي تفاعلي خارج أدوات Codex. افتح ملف التعليمات الخاص في جهازك بدلاً من ذلك.');
  }
  validateSetup(setup);
  output.write('أرسل الرسالة التالية إلى دعبول في الخاص فقط، ولا تنسخها إلى Codex أو مجموعة:\n');
  output.write(`دعبول إعداد ${setup.token}\n`);
}

export async function main(argv = process.argv.slice(2), { directory = LOCAL, uploadHash = uploadOwnerHash, output = process.stdout, input = process.stdin, environment = process.env } = {}) {
  if (argv.some(arg => !['--help', '--show-setup'].includes(arg))) throw new SetupError('الاستخدام: node scripts/setup-contributions.mjs [--show-setup]. لا تقبل الأداة أسراراً في وسائط الأمر.');
  if (argv.includes('--help')) {
    output.write('ينشئ رمز إعداد خاصاً محلياً ويرفع بصمته فقط إلى Workers Secrets. لا ينشئ D1 ولا يبني الكود؛ رفع السر يحدّث نسخة Worker المنشورة.\n--show-setup: يعرض رسالة الربط داخل Terminal محلي فقط.\n');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new SetupError('استخدم Node.js 24 أو أحدث.');
  const setup = await prepareSetup(directory);
  if (argv.includes('--show-setup')) {
    showSetupLocally(setup, { input, output, environment });
    return;
  }
  await uploadHash(setup.tokenHash);
  output.write('حُفظ رمز الربط في .local/contributions-setup.json وتعليماته في .local/contributions-setup.html بصلاحية 0600. رُفعت بصمة SHA-256 فقط إلى OWNER_SETUP_TOKEN_HASH. افتح ملف HTML محلياً لإكمال الربط؛ لم يُعرض الرمز.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(publicError(error)); process.exitCode = 1; });
}
