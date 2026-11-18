#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_NAME = 'daabool-telegram-bot';
export const WEBHOOK_UPDATE_TYPES = ['message', 'inline_query', 'callback_query', 'channel_post'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.local');
const SECRET_FILE = join(LOCAL, 'secrets.json');
const DEPLOYMENT_FILE = join(LOCAL, 'deployment.json');
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,128}$/;
const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/** Only errors with messages written in this file may be shown to the user. */
export class SetupError extends Error {}

export function publicError(error) {
  return error instanceof SetupError
    ? error.message
    : 'تعذّر إكمال الإعداد. لم تُعرض تفاصيل الخطأ لحماية الأسرار. أعد المحاولة بعد فحص الاتصال والاعتمادات.';
}

export function redact(text, secrets = []) {
  let safe = String(text);
  for (const secret of secrets.filter((value) => typeof value === 'string' && value)) {
    safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/https:\/\/api\.telegram\.org\/bot[^\s/]+/gi, 'https://api.telegram.org/bot[REDACTED]')
    .replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,128}\b/g, '[REDACTED]');
}

/** Recognize actionable CLI failures without forwarding any child output. */
export function commandFailure(description, output, exitCode, timedOut = false) {
  if (/You need to register a workers\.dev subdomain|register a workers\.dev subdomain here/i.test(String(output))) {
    return new SetupError('لم يكتمل النشر لأن حساب Cloudflare يحتاج تسجيل نطاق workers.dev. أكمل هذه الخطوة من Terminal تفاعلي باستخدام npx wrangler deploy، ثم أعد npm run setup؛ التوكن المحلي محفوظ ولا يحتاج إدخالاً جديداً.');
  }
  const reason = timedOut ? 'انتهت مهلة التنفيذ' : `رمز الخروج ${Number.isInteger(exitCode) ? exitCode : 'غير متاح'}`;
  return new SetupError(`لم تنجح خطوة ${description} (${reason}). أوقف الإعداد قبل الخطوة التالية. افحص تسجيل الدخول والاتصال ثم أعد المحاولة.`);
}

/** A token is accepted only through a real, echo-free terminal input. */
export function promptSecret({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new SetupError('شغّل npm run setup داخل Terminal محلي تفاعلي. أدخل توكن BotFather هناك فقط؛ لا ترسله في المحادثة أو كوسيط أمر.');
  }
  return new Promise((resolvePrompt, reject) => {
    let value = '';
    let finished = false;
    const wasRaw = Boolean(input.isRaw);
    const cleanup = () => {
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.removeListener('end', onEnd);
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('SIGINT', onTerminate);
      try { input.setRawMode(wasRaw); } catch { /* Terminal may already be closed. */ }
      input.pause();
      output.write('\n');
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolvePrompt(value.trim());
      value = '';
    };
    const onError = () => finish(new SetupError('تعذّرت قراءة الإدخال الآمن. أعد تشغيل الإعداد في Terminal.'));
    const onEnd = () => finish(new SetupError('انتهى الإدخال قبل استلام التوكن.'));
    const onTerminate = () => finish(new SetupError('أُلغي إدخال التوكن.'));
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003' || char === '\u0004') {
          finish(new SetupError('أُلغي إدخال التوكن.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/^[\x20-\x7e]$/.test(char)) value += char;
        else {
          finish(new SetupError('الإدخال يحتوي محارف غير صالحة. أعد لصق توكن BotFather وحده.'));
          return;
        }
        if (value.length > 256) {
          finish(new SetupError('الإدخال أطول من توكن Telegram صالح.'));
          return;
        }
      }
    };
    input.on('data', onData);
    input.once('error', onError);
    input.once('end', onEnd);
    process.once('SIGTERM', onTerminate);
    process.once('SIGINT', onTerminate);
    try {
      input.setRawMode(true);
      output.write('ألصق TELEGRAM_BOT_TOKEN من BotFather (الإدخال مخفي)، ثم Enter: ');
      input.resume();
    } catch {
      finish(new SetupError('تعذّر تعطيل إظهار الإدخال. أعد المحاولة في Terminal محلي.'));
    }
  });
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SetupError('مجلد .local غير آمن؛ يجب أن يكون مجلداً محلياً عادياً.');
  }
  await chmod(directory, 0o700);
}

export async function writePrivateJson(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    if (file) await file.close();
    await rm(temporary, { force: true });
  }
}

export async function readPrivateJson(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new SetupError('ملف الإعداد المحلي غير آمن.');
    await file.chmod(0o600);
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SetupError('تعذّرت قراءة ملف الإعداد المحلي بأمان.');
  } finally {
    if (file) await file.close();
  }
}

export function validateSecrets(value) {
  if (!value || typeof value !== 'object' || !TOKEN_PATTERN.test(value.TELEGRAM_BOT_TOKEN ?? '') ||
      !WEBHOOK_SECRET_PATTERN.test(value.WEBHOOK_SECRET_TOKEN ?? '')) {
    throw new SetupError('بيانات التوكن المحلية غير صالحة. شغّل npm run setup -- --replace-token لإدخال توكن جديد بأمان.');
  }
  return { TELEGRAM_BOT_TOKEN: value.TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET_TOKEN: value.WEBHOOK_SECRET_TOKEN };
}

/** Never let a parsed URL turn verification into a request to another host. */
export function workerOrigin(value, expectedName = WORKER_NAME) {
  try {
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
        url.pathname !== '/' || labels.length !== 4 || labels[0] !== expectedName ||
        !/^[a-z0-9][a-z0-9-]*$/.test(labels[1]) || labels[2] !== 'workers' || labels[3] !== 'dev') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function deploymentUrl(output, expectedName = WORKER_NAME) {
  const plain = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  const urls = plain.match(/https:\/\/[^\s<>"'`]+/g) ?? [];
  for (const value of urls) {
    const origin = workerOrigin(value.replace(/[),}\].]+$/, ''), expectedName);
    if (origin) return origin;
  }
  throw new SetupError('تم تشغيل أمر النشر لكن تعذّر تحديد رابط workers.dev الفعلي. افحص لوحة Cloudflare وأعد npm run setup؛ لم يُغيّر Webhook إلى رابط تخميني.');
}

export async function telegramCall(token, method, body = {}, fetchImpl = fetch) {
  if (!['getMe', 'getWebhookInfo', 'setWebhook'].includes(method)) throw new SetupError('طريقة Telegram غير مسموحة في أداة الإعداد.');
  let response;
  let data;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    data = await response.json();
  } catch {
    throw new SetupError(`تعذّر الاتصال بـ Telegram أثناء ${method}. افحص الإنترنت وأعد المحاولة؛ لن تُعرض تفاصيل قد تحتوي التوكن.`);
  }
  if (!response.ok || data?.ok !== true || !Object.hasOwn(data, 'result')) {
    if (method === 'getMe' && (response.status === 401 || response.status === 404)) {
      throw new SetupError('رفض Telegram التوكن. شغّل npm run setup -- --replace-token وأدخل توكن BotFather الصحيح في Terminal.');
    }
    throw new SetupError(`لم ينجح طلب Telegram ${method}. لم تُعرض رسالة الخادم لحماية الأسرار.`);
  }
  return data.result;
}

async function command(args, { stdin, description, timeout = 180_000 } = {}) {
  return new Promise((resolveCommand, reject) => {
    // Never inherit debug logging, and never print child output containing API errors.
    const environment = {
      ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG: 'log', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true',
    };
    delete environment.TELEGRAM_BOT_TOKEN;
    delete environment.WEBHOOK_SECRET_TOKEN;
    delete environment.WRANGLER_OUTPUT_FILE_PATH;
    delete environment.WRANGLER_OUTPUT_FILE_DIRECTORY;
    const child = spawn(process.execPath, args, { cwd: ROOT, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    const collect = (chunk) => {
      if (output.length < 2_000_000) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(new SetupError(`تعذّر تشغيل ${description}. تأكّد من تثبيت الاعتمادات باستخدام npm install.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut) reject(commandFailure(description, output, code, timedOut));
      else resolveCommand(output);
    });
    child.stdin.end(stdin);
  });
}

async function wrangler(args, options = {}) {
  return command([WRANGLER, ...args], { description: `Wrangler ${args.slice(0, 2).join(' ')}`, ...options });
}

async function localChecks() {
  console.log('فحص الاختبارات والأنواع وبناء Worker قبل أي نشر…');
  await command(['--test', 'scripts/setup.test.mjs', 'scripts/setup-contributions.test.mjs', 'scripts/runtime.test.mjs'], { description: 'اختبارات أداة الإعداد وبيئة Workers' });
  await command([join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run'], { description: 'اختبارات البوت' });
  await command([join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit'], { description: 'TypeScript' });
  await wrangler(['deploy', '--dry-run', '--outdir', join(LOCAL, 'dry-run')], { description: 'بناء Wrangler التجريبي' });
  console.log('نجحت الاختبارات وفحص الأنواع والبناء التجريبي.');
}

async function getIdentity(secrets) {
  const identity = await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'getMe');
  if (identity?.is_bot !== true || typeof identity.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(identity.username)) {
    throw new SetupError('لم يُرجع getMe حساب بوت واسم مستخدم صالحين.');
  }
  return identity;
}

export async function checkDeployment(secrets, origin, fetchImpl = fetch, { contributionsEnabled = false } = {}) {
  const safeOrigin = workerOrigin(origin);
  if (!safeOrigin) throw new SetupError('رابط Worker المحلي غير صالح. أعد npm run setup لتحديد رابط النشر الفعلي.');
  const identity = await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'getMe', {}, fetchImpl);
  if (identity?.is_bot !== true || typeof identity.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(identity.username)) {
    throw new SetupError('لم يُرجع getMe حساب بوت واسم مستخدم صالحين.');
  }
  const webhook = await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'getWebhookInfo', {}, fetchImpl);
  if (webhook?.url !== `${safeOrigin}/webhook` || !Array.isArray(webhook.allowed_updates) ||
      !(contributionsEnabled ? WEBHOOK_UPDATE_TYPES : ['message', 'inline_query']).every((value) => webhook.allowed_updates.includes(value))) {
    throw new SetupError('Webhook غير مطابق للرابط أو أنواع التحديثات المطلوبة. شغّل npm run setup لإعادة ربطه بأمان.');
  }
  let health;
  let healthBody;
  let denied;
  let authenticated;
  try {
    health = await fetchImpl(`${safeOrigin}/health`, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    healthBody = await health.json();
    denied = await fetchImpl(`${safeOrigin}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    // A future/unsupported Telegram update proves the secret is installed without sending a message.
    authenticated = await fetchImpl(`${safeOrigin}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secrets.WEBHOOK_SECRET_TOKEN },
      body: JSON.stringify({ update_id: 0 }), signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
  } catch {
    throw new SetupError('تعذّر الاتصال برابط Worker أثناء التحقق. انتظر انتشار النشر ثم أعد npm run setup -- --check.');
  }
  if (!health.ok || healthBody?.service !== WORKER_NAME || healthBody?.status !== 'ready' ||
      healthBody?.timezone !== 'Asia/Baghdad' || denied.status !== 403 || !authenticated.ok) {
    throw new SetupError('لم يجتز Worker فحص /health أو حماية /webhook. أعد الإعداد بعد التحقق من النشر.');
  }
  return {
    workerUrl: safeOrigin,
    botUsername: identity.username,
    botUrl: `https://t.me/${identity.username}`,
    webhookUrl: `${safeOrigin}/webhook`,
    pendingUpdates: Number.isSafeInteger(webhook.pending_update_count) ? webhook.pending_update_count : null,
    recentTelegramError: typeof webhook.last_error_date === 'number',
    canReadAllGroupMessages: identity.can_read_all_group_messages === true,
    supportsInlineQueries: identity.supports_inline_queries === true,
    canJoinGroups: identity.can_join_groups === true,
    supportsCallbackQueries: webhook.allowed_updates.includes('callback_query'),
  };
}

function printStatus(status) {
  console.log(`Worker: ${status.workerUrl}`);
  console.log(`Telegram: @${status.botUsername} — ${status.botUrl}`);
  console.log(`Webhook: ${status.webhookUrl} (message + inline_query${status.supportsCallbackQueries ? ' + callback_query' : ''})`);
  console.log('الحالة: /health يعمل؛ الطلب دون سر رُفض بـ 403؛ الطلب الموثّق مقبول.');
  console.log(`تحديثات Telegram المنتظرة: ${status.pendingUpdates ?? 'غير معروف'}`);
  if (status.recentTelegramError) console.log('Telegram يسجّل خطأ سابقاً في Webhook؛ أعد --check بعد تجربة البوت للتأكد من تسليم التحديثات الجديدة.');
  console.log(`Inline Mode: ${status.supportsInlineQueries ? 'مفعّل' : 'غير مفعّل — فعّل /setinline من BotFather ثم أعد --check'}`);
  console.log(`إضافة البوت للمجموعات: ${status.canJoinGroups ? 'مسموحة' : 'غير مسموحة — فعّل /setjoingroups من BotFather'}`);
  console.log(`Privacy Mode: ${status.canReadAllGroupMessages ? 'معطّل؛ يستطيع استقبال المنشن النصي المطلوب' : 'مفعّل؛ عطّله عبر /setprivacy ثم أزل البوت وأعد إضافته للمجموعة لاستقبال المنشن النصي المطلوب'}`);
  console.log('لم تُرسل رسائل Telegram تجريبية إلى أي محادثة. جرّب الرسالة وInline Mode داخل Telegram وفق README.');
}

export async function main(argv = process.argv.slice(2)) {
  const known = new Set(['--check', '--replace-token', '--help']);
  if (argv.some((arg) => !known.has(arg)) || (argv.includes('--check') && argv.includes('--replace-token'))) {
    throw new SetupError('الاستخدام: npm run setup [-- --check | --replace-token]. لا تقبل الأداة التوكن في وسيط أمر.');
  }
  if (argv.includes('--help')) {
    console.log('npm run setup: فحص ونشر وربط Telegram مع إدخال توكن مخفي عند الحاجة.');
    console.log('npm run setup -- --check: فحص النشر وBotFather فقط دون تعديل.');
    console.log('npm run setup -- --replace-token: استبدال التوكن بواسطة المطالبة المخفية ثم إعادة الإعداد.');
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new SetupError('استخدم Node.js 24 أو أحدث.');
  await privateDirectory(LOCAL);
  if (argv.includes('--check')) {
    const secrets = validateSecrets(await readPrivateJson(SECRET_FILE));
    const deployment = await readPrivateJson(DEPLOYMENT_FILE);
    if (!deployment?.workerUrl) throw new SetupError('لا يوجد نشر محفوظ. شغّل npm run setup أولاً.');
    const status = await checkDeployment(secrets, deployment.workerUrl);
    printStatus(status);
    return;
  }
  console.log('التحقق من تفويض Cloudflare…');
  try {
    const account = JSON.parse(await wrangler(['whoami', '--json'], { description: 'تفويض Cloudflare' }));
    if (account.loggedIn !== true || !Array.isArray(account.accounts) || account.accounts.length === 0) {
      throw new SetupError('تفويض Cloudflare لا يتضمن حساباً متاحاً.');
    }
  } catch {
    throw new SetupError('لم يُثبت تسجيل الدخول إلى Cloudflare. نفّذ npx wrangler login وأكمل التفويض الرسمي، ثم npx wrangler whoami وأعد npm run setup.');
  }
  let secrets = await readPrivateJson(SECRET_FILE);
  if (!secrets || argv.includes('--replace-token')) {
    const token = await promptSecret();
    if (!TOKEN_PATTERN.test(token)) throw new SetupError('صيغة التوكن غير صالحة. أعد الإعداد والصق التوكن من BotFather في المطالبة المحلية المخفية.');
    secrets = validateSecrets({
      TELEGRAM_BOT_TOKEN: token,
      WEBHOOK_SECRET_TOKEN: WEBHOOK_SECRET_PATTERN.test(secrets?.WEBHOOK_SECRET_TOKEN ?? '')
        ? secrets.WEBHOOK_SECRET_TOKEN : randomBytes(32).toString('base64url'),
    });
    // Validate before replacing a previously working local credential.
    await getIdentity(secrets);
    await writePrivateJson(SECRET_FILE, secrets);
    console.log('حُفظت الأسرار محلياً داخل .local/secrets.json بصلاحية 0600 لاستئناف الإعداد.');
  } else {
    secrets = validateSecrets(secrets);
    await getIdentity(secrets);
    console.log('استُخدمت الأسرار المحلية المحفوظة دون عرضها.');
  }
  await localChecks();
  console.log('رفع الأسرار إلى Cloudflare Workers Secrets…');
  await wrangler(['secret', 'bulk'], { stdin: JSON.stringify(secrets), description: 'رفع أسرار Worker' });
  console.log('نشر Worker على workers.dev…');
  const output = await wrangler(['deploy'], { description: 'نشر Worker' });
  const origin = deploymentUrl(output);
  await writePrivateJson(DEPLOYMENT_FILE, { workerUrl: origin, deployedAt: new Date().toISOString() });
  console.log('تسجيل Webhook الفعلي في Telegram…');
  const registered = await telegramCall(secrets.TELEGRAM_BOT_TOKEN, 'setWebhook', {
    url: `${origin}/webhook`, secret_token: secrets.WEBHOOK_SECRET_TOKEN,
    allowed_updates: WEBHOOK_UPDATE_TYPES, max_connections: 10,
  });
  if (registered !== true) throw new SetupError('لم يؤكد Telegram تسجيل Webhook. أعد npm run setup.');
  const status = await checkDeployment(secrets, origin);
  await writePrivateJson(DEPLOYMENT_FILE, { ...status, checkedAt: new Date().toISOString() });
  printStatus(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(publicError(error));
    process.exitCode = 1;
  });
}
