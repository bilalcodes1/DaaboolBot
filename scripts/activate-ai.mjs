import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deploymentUrl, readPrivateJson, writePrivateJson } from './setup.mjs';
import { promptGroqKey, validateGroqKey } from './setup-ai.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'openai/gpt-oss-120b';
const TABLES = ['assistant_ai_usage', 'assistant_ai_requests', 'academic_intakes', 'academic_reports',
  'academic_report_changes', 'smart_reminder_config', 'smart_reminder_plans', 'smart_reminder_history',
  'assistant_turns', 'assistant_user_limits', 'assistant_inline_limits', 'academic_alert_plans'];
const DATABASE = 'DB';

/** Captured output is never printed, including failed child diagnostics. */
async function command(args, { stdin, description = 'خطوة الإعداد', timeout = 180_000, directory = ROOT } = {}) {
  return new Promise((resolveCommand, reject) => {
    const environment = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log',
      WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
    for (const name of ['TELEGRAM_BOT_TOKEN', 'WEBHOOK_SECRET_TOKEN', 'GROQ_API_KEY', 'GROQ_API_KEYS', 'GEMINI_API_KEY',
      'OPENAI_API_KEY', 'DEBUG', 'NODE_DEBUG', 'NODE_OPTIONS', 'WRANGLER_OUTPUT_FILE_PATH', 'WRANGLER_OUTPUT_FILE_DIRECTORY']) delete environment[name];
    let child;
    try { child = spawn(process.execPath, args, { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error(`تعذّر تشغيل ${description}.`)); return; }
    let output = ''; let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { if (output.length < 2_000_000) output += chunk.toString('utf8'); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error(`تعذّر تشغيل ${description}.`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired || code !== 0) reject(new Error(`لم تكتمل ${description}؛ توقّف الإعداد دون عرض التفاصيل الحساسة.`));
      else resolveCommand(output);
    });
    child.stdin.end(stdin);
  });
}

async function responseJson(response, maximum = 16_384) {
  if (Number(response.headers.get('content-length')) > maximum) throw new Error('oversized');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty');
  let size = 0; const chunks = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('oversized'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function smokeTest(key, fetchImpl) {
  let response;
  try {
    response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, stream: false, temperature: 0, max_completion_tokens: 512,
        reasoning_effort: 'low', include_reasoning: false,
        messages: [{ role: 'system', content: 'Return only the requested JSON object.' },
          { role: 'user', content: 'Return a JSON object whose ok field is true.' }],
        response_format: { type: 'json_schema', json_schema: { name: 'activation_probe', strict: true,
          schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean', enum: [true] } } } } },
      }),
    });
  } catch { throw new Error('تعذّر الوصول إلى Groq؛ لم يُنشر أي تغيير. المفتاح محفوظ محلياً لإعادة المحاولة.'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) throw new Error('رفض Groq المفتاح أو صلاحياته؛ صحّح المفتاح وأعد المحاولة. لم يُنشر أي تغيير.');
    if (response.status === 429) throw new Error('حصة Groq مستنفدة الآن؛ انتظر تجدد الحصة وأعد المحاولة. لم يُنشر أي تغيير.');
    throw new Error('لم ينجح اختبار Groq؛ افحص حالة حسابك وأعد المحاولة. لم يُنشر أي تغيير.');
  }
  try {
    const data = await responseJson(response);
    const choice = data?.choices?.[0];
    const answer = JSON.parse(choice?.message?.content);
    if (choice?.finish_reason !== 'stop' || choice.message.refusal || answer?.ok !== true || Object.keys(answer).length !== 1) throw new Error('invalid');
  } catch { throw new Error('لم يؤكد نموذج Groq الاختبار المنظم؛ لم يُنشر أي تغيير.'); }
}

function d1Rows(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value) || !value.length || value.some(item => item?.success !== true || !Array.isArray(item.results))) throw new Error('invalid');
  return value.flatMap(item => item.results);
}

/** The browser handoff calls this only after the human submits their key.
 * skipChecks is for a caller which has just completed trusted local checks.
 * No Telegram test messages or webhook changes are made by this activation.
 */
export async function activateAi(value, { onProgress = () => {}, run = command, fetchImpl = fetch, directory = ROOT, skipChecks = false } = {}) {
  const key = validateGroqKey(value);
  directory = resolve(directory);
  const wrangler = join(directory, 'node_modules/wrangler/bin/wrangler.js');
  const progress = async text => { try { await onProgress(text); } catch { /* Losing a browser listener must not interrupt authorized setup. */ } };
  const stage = async (args, description, options = {}) => {
    try { return await run(args, { directory, description, ...options }); }
    catch { throw new Error(`لم تكتمل ${description}؛ توقّف الإعداد. لم تُعرض تفاصيل قد تحتوي أسراراً.`); }
  };
  const wranglerStage = (args, description, options) => stage([wrangler, ...args], description, options);
  await progress('حفظ المفتاح محلياً بصلاحيات خاصة…');
  try { await writePrivateJson(join(directory, '.local', 'assistant-secrets.json'), { GROQ_API_KEY: key }); }
  catch { throw new Error('تعذّر حفظ المفتاح محلياً بأمان؛ لم يبدأ التفعيل.'); }
  await progress('اختبار Groq بطلب اصطناعي صغير دون إرسال بيانات الطلاب…');
  await smokeTest(key, fetchImpl);
  await progress('التحقق من تفويض Cloudflare…');
  try {
    const identity = JSON.parse(await wranglerStage(['whoami', '--json'], 'التحقق من تفويض Cloudflare'));
    if (identity.loggedIn !== true || !Array.isArray(identity.accounts) || identity.accounts.length === 0) throw new Error('invalid');
  } catch { throw new Error('تفويض Cloudflare غير متاح؛ سجّل الدخول محلياً وأعد المحاولة. لم يُنشر أي تغيير.'); }
  let expectedUrl = null;
  try {
    const saved = await readPrivateJson(join(directory, '.local', 'deployment.json'));
    if (saved?.workerUrl) expectedUrl = deploymentUrl(saved.workerUrl);
  } catch { throw new Error('تعذّر التحقق من عنوان Worker المحفوظ بأمان؛ لم يُنشر أي تغيير.'); }
  if (!skipChecks) {
    await progress('تشغيل اختبارات المشروع وفحص الأنواع…');
    let npm;
    try { npm = await realpath(join(dirname(process.execPath), 'npm')); }
    catch { throw new Error('تعذّر العثور على npm المحلي؛ لم يُنشر أي تغيير.'); }
    await stage([npm, 'run', 'check'], 'اختبارات المشروع وفحص الأنواع', { timeout: 600_000 });
  }
  await progress('بناء نسخة تجريبية قبل تحديث البوت…');
  await wranglerStage(['deploy', '--dry-run', '--outdir', join(directory, '.local', 'activation-build')], 'البناء التجريبي');
  await progress('تحديث جداول قاعدة البيانات…');
  await wranglerStage(['d1', 'migrations', 'apply', DATABASE, '--remote'], 'تطبيق تحديثات قاعدة البيانات');
  const schemaSql = `SELECT COUNT(*) AS ready_tables FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(name => `'${name}'`).join(',')})`;
  try {
    const rows = d1Rows(await wranglerStage(['d1', 'execute', DATABASE, '--remote', '--json', '--command', schemaSql], 'فحص جداول الذكاء'));
    if (rows[0]?.ready_tables !== TABLES.length) throw new Error('incomplete');
  } catch { throw new Error('جداول الذكاء غير مكتملة؛ لم يُرفع المفتاح ولم تُنشر نسخة جديدة.'); }
  await progress('رفع المفتاح إلى أسرار Worker دون عرضه…');
  await wranglerStage(['secret', 'put', 'GROQ_API_KEY'], 'رفع مفتاح Groq', { stdin: `${key}\n`, timeout: 90_000 });
  await progress('نشر النسخة المحدّثة على عنوان البوت الحالي…');
  const deployed = await wranglerStage(['deploy'], 'نشر البوت');
  let workerUrl;
  try { workerUrl = deploymentUrl(deployed); }
  catch { if (expectedUrl) workerUrl = expectedUrl; else throw new Error('اكتمل أمر النشر لكن تعذّر تأكيد عنوان Worker؛ لم يُؤكَّد التفعيل.'); }
  if (expectedUrl && workerUrl !== expectedUrl) throw new Error('عنوان النشر يختلف عن عنوان البوت المحفوظ؛ لم يُؤكَّد التفعيل ولم يُغيّر Webhook.');
  await progress('فحص استجابة البوت بعد النشر…');
  try {
    const response = await fetchImpl(`${workerUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json' } });
    const health = await responseJson(response);
    if (!response.ok || health?.service !== 'daabool-telegram-bot' || health.status !== 'ready') throw new Error('not-ready');
  } catch { throw new Error('تم النشر لكن فحص البوت لم يؤكد الجاهزية؛ أعد المحاولة للتحقق.'); }
  await progress('تشغيل التذكيرات اليومية عند وجود كروب نشر مربوط…');
  const enabledAt = Date.now();
  const enableSql = `UPDATE smart_reminder_config SET enabled=1,enabled_at=${enabledAt},generation=generation+1 WHERE singleton=1 AND enabled=0 AND EXISTS(SELECT 1 FROM settings WHERE singleton=1 AND target_chat_id IS NOT NULL AND target_chat_id<0); SELECT EXISTS(SELECT 1 FROM settings WHERE singleton=1 AND target_chat_id IS NOT NULL AND target_chat_id<0) AS target_configured,EXISTS(SELECT 1 FROM smart_reminder_config WHERE singleton=1 AND enabled=1) AS reminders_enabled;`;
  let remindersEnabled;
  try {
    const rows = d1Rows(await wranglerStage(['d1', 'execute', DATABASE, '--remote', '--json', '--command', enableSql], 'تشغيل التذكيرات اليومية'));
    const status = rows.find(row => Object.hasOwn(row, 'target_configured') && Object.hasOwn(row, 'reminders_enabled'));
    if (!status || ![0, 1].includes(status.target_configured) || ![0, 1].includes(status.reminders_enabled)) throw new Error('invalid');
    remindersEnabled = status.target_configured === 1 && status.reminders_enabled === 1;
  } catch { throw new Error('البوت اجتاز فحص الجاهزية، لكن تعذّر تأكيد تشغيل التذكيرات اليومية؛ أعد المحاولة.'); }
  await progress(remindersEnabled ? 'اكتمل التفعيل والتذكيرات تبدأ من الموعد القادم.' : 'اكتمل تفعيل الذكاء؛ اربط كروب النشر من إدارة البوت حتى تبدأ التذكيرات اليومية.');
  return { active: true, workerUrl, model: MODEL, remindersEnabled, checkedAt: new Date().toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) { console.error('لا تضع المفتاح ضمن الأمر؛ شغّل الأداة دون وسائط والصقه في الإدخال المخفي.'); process.exitCode = 1; }
  else Promise.resolve().then(() => promptGroqKey()).then(key => activateAi(key, { onProgress: text => console.log(text) })).catch(error => {
    console.error(error instanceof Error ? error.message : 'تعذّر التفعيل.'); process.exitCode = 1;
  });
}
