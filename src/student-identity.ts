import { isAdmin } from './admin';
import { EventStore } from './event-store';
import { saveManualPanel, consumeManualPanel } from './manual-store';
import { escapeHtml } from './format';
import { STUDENT_ROSTER } from './roster';
import type { TelegramClient } from './telegram';
import type { Env, TelegramUpdate } from './types';

type IdentityEnv = Pick<Env, 'DB'> & { PRODUCT_MODE_ENABLED?: string };
type Button = { text: string; callback_data: string };
interface IdentityRow { roster_id: string; name: string; display_name: string | null; telegram_user_id: number; public_consent: number }
interface Challenge { token_hash: string; roster_id: string; name: string; previous_user_id: number | null; claimed_user_id: number | null; state: string; expires_at: number }
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
const cleanName = (value: string) => value.trim().replace(/\s+/gu, ' ');
const validName = (value: string) => value.length >= 2 && value.length <= 80 && !/[<>\p{Cc}\p{Cf}@]/u.test(value);
const button = (text: string, data: string): Button => ({ text, callback_data: `idn:${data}` });
const HOME = button('رجوع', 'home');
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('').slice(0, 24);
}
async function tell(db:D1Database,telegram: TelegramClient, chatId: number, text: string, rows: Button[][] = [[HOME]]) {
  const sent=await telegram.call<{message_id:number}>('sendMessage',{chat_id:chatId,text,parse_mode:'HTML'});
  if(!Number.isSafeInteger(sent?.message_id))throw Error('identity_preview_unconfirmed');
  const nonce=await saveManualPanel(db,{userId:chatId,chatId,threadId:null},sent.message_id,rows.flat().map(b=>({action:'identity',data:b.callback_data})),Date.now());
  let index=0;await telegram.call('editMessageReplyMarkup',{chat_id:chatId,message_id:sent.message_id,reply_markup:{inline_keyboard:rows.map(row=>row.map(b=>({text:b.text,callback_data:`idn:${nonce}:${index++}`})))}});
}

/** A roster name becomes account identity only after private consent and local admin verification. */
export async function minimumVerifiedName(db: D1Database, userId: number): Promise<string | null> {
  if (!positive(userId)) return null;
  const row = await db.prepare(`SELECT COALESCE(i.display_name,r.name) AS name FROM student_identities i
    JOIN student_roster r ON r.id=i.roster_id WHERE i.telegram_user_id=? AND i.public_consent=1 AND r.active=1`)
    .bind(userId).first<{ name: string }>();
  // Only a first name is needed for a warm group response; account IDs never leave this adapter.
  return row?.name ? row.name.split(/\s/u)[0]!.slice(0, 40) : null;
}
export async function groupMemoryEnabled(db: D1Database, userId: number): Promise<boolean> {
  const row = await db.prepare('SELECT memory_enabled FROM student_privacy WHERE user_id=?').bind(userId).first<{ memory_enabled: number }>();
  return row?.memory_enabled !== 0;
}
export async function forgetGroupMemory(db: D1Database, userId: number, now: number): Promise<void> {
  if (!positive(userId)) throw new RangeError('Invalid actor');
  await db.batch([
    db.prepare('UPDATE group_ai_turns SET question=NULL,answer=NULL WHERE user_id=?').bind(userId),
    db.prepare('DELETE FROM assistant_turns WHERE user_id=?').bind(userId),
    db.prepare(`INSERT INTO student_privacy(user_id,memory_enabled,updated_at) VALUES(?,0,?)
      ON CONFLICT(user_id) DO UPDATE SET memory_enabled=0,updated_at=excluded.updated_at`).bind(userId, now),
  ]);
}

export async function seedIdentityRoster(db: D1Database, now: number): Promise<void> {
  const rows = await Promise.all(STUDENT_ROSTER.map(async name => ({ id: await digest(`roster:${name}`), name })));
  await db.batch(rows.map(row => db.prepare('INSERT OR IGNORE INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)')
    .bind(row.id, row.name, now, now)));
}
export async function issueStudentChallenge(db: D1Database, rosterId: string, adminId: number, now: number): Promise<string | null> {
  const settings = await new EventStore(db).getSettings();
  if (!isAdmin(adminId, settings.ownerUid)) return null;
  const row = await db.prepare(`SELECT r.id,i.telegram_user_id FROM student_roster r LEFT JOIN student_identities i
    ON i.roster_id=r.id WHERE r.id=? AND r.active=1`).bind(rosterId).first<{ id: string; telegram_user_id: number | null }>();
  if (!row) return null;
  const code = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  const hash = await digest(code);
  await db.batch([
    db.prepare("UPDATE student_link_challenges SET state='revoked' WHERE roster_id=? AND state IN ('issued','claimed','consented')").bind(rosterId),
    db.prepare(`INSERT INTO student_link_challenges(token_hash,roster_id,issued_by,previous_user_id,created_at,expires_at)
      VALUES(?,?,?,?,?,?)`).bind(hash, rosterId, adminId, row.telegram_user_id, now, now + 15 * 60_000),
  ]);
  return code;
}
export async function claimStudentChallenge(db: D1Database, code: string, userId: number, now: number): Promise<Challenge | null> {
  if (!positive(userId) || !/^[a-f0-9]{24}$/u.test(code)) return null;
  const hash = await digest(code);
  const row = await db.prepare(`UPDATE student_link_challenges SET claimed_user_id=?,state='claimed',expires_at=?
    WHERE token_hash=? AND state='issued' AND expires_at>? AND (previous_user_id IS NULL OR previous_user_id<>?)
    AND NOT EXISTS(SELECT 1 FROM student_identities WHERE telegram_user_id=?) RETURNING token_hash,roster_id,previous_user_id,claimed_user_id,state,expires_at`)
    .bind(userId, now + 86_400_000, hash, now, userId, userId).first<Omit<Challenge, 'name'>>();
  if (!row) return null;
  const student = await db.prepare('SELECT name FROM student_roster WHERE id=? AND active=1').bind(row.roster_id).first<{ name: string }>();
  return student ? { ...row, name: student.name } : null;
}
export async function consentStudentChallenge(db: D1Database, hash: string, userId: number, publicName: boolean, now: number): Promise<boolean> {
  return (await db.prepare(`UPDATE student_link_challenges SET consent_at=?,public_consent=?,state='consented'
    WHERE token_hash=? AND claimed_user_id=? AND state='claimed' AND expires_at>?`)
    .bind(now, Number(publicName), hash, userId, now).run()).meta.changes > 0;
}
export async function verifyStudentChallenge(db: D1Database, hash: string, adminId: number, now: number): Promise<boolean> {
  const settings = await new EventStore(db).getSettings();
  if (!isAdmin(adminId, settings.ownerUid)) return false;
  // The new account must have accepted in private. Replacement compares the old account snapshot.
  const result = await db.batch([
    db.prepare(`INSERT INTO student_identities(roster_id,telegram_user_id,public_consent,consent_at,verified_by,verified_at,updated_at)
      SELECT c.roster_id,c.claimed_user_id,c.public_consent,c.consent_at,?,?,? FROM student_link_challenges c
      JOIN student_roster r ON r.id=c.roster_id AND r.active=1
      WHERE c.token_hash=? AND c.state='consented' AND c.expires_at>? AND c.claimed_user_id>0 AND c.consent_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM student_identities x WHERE x.telegram_user_id=c.claimed_user_id AND x.roster_id<>c.roster_id)
      AND COALESCE((SELECT telegram_user_id FROM student_identities WHERE roster_id=c.roster_id),0)=COALESCE(c.previous_user_id,0)
      ON CONFLICT(roster_id) DO UPDATE SET telegram_user_id=excluded.telegram_user_id,display_name=NULL,
      public_consent=excluded.public_consent,consent_at=excluded.consent_at,verified_by=excluded.verified_by,
      verified_at=excluded.verified_at,updated_at=excluded.updated_at`)
      .bind(adminId, now, now, hash, now),
    db.prepare(`UPDATE student_link_challenges SET state='verified',verified_by=?,verified_at=?
      WHERE token_hash=? AND state='consented' AND EXISTS(SELECT 1 FROM student_identities i WHERE i.roster_id=student_link_challenges.roster_id
      AND i.telegram_user_id=student_link_challenges.claimed_user_id AND i.verified_by=? AND i.verified_at=?)`)
      .bind(adminId, now, hash, adminId, now),
  ]);
  return (result[0]?.meta.changes ?? 0) > 0 && (result[1]?.meta.changes ?? 0) > 0;
}

async function selfPanel(db: D1Database, telegram: TelegramClient, userId: number, admin: boolean) {
  const row = await db.prepare(`SELECT i.*,r.name FROM student_identities i JOIN student_roster r ON r.id=i.roster_id
    WHERE i.telegram_user_id=? AND r.active=1`).bind(userId).first<IdentityRow>();
  const memory = await groupMemoryEnabled(db, userId);
  const text = row ? `حسابك موثّق باسم ${escapeHtml(row.name)}.\nالاسم الظاهر: ${escapeHtml(row.display_name ?? row.name)}\nاستخدام اسمك الأول بالكروب: ${row.public_consent ? 'مسموح' : 'متوقف'}.\nلتغيير الاسم الظاهر اكتب «اسمي الظاهر …».`
    : 'حسابك بعده مو مربوط باسم طالب. خذ رمزاً من الأدمن واكتب هنا «ربط حسابي الرمز». الربط يحتاج موافقتك ثم تحقق الأدمن؛ الاسم واليوزر وحدهم ما يثبتون الهوية.';
  await tell(db,telegram, userId, `${text}\nذاكرة أجوبتك بالكروب: ${memory ? 'آخر 24 ساعة فقط' : 'متوقفة'}.`, [
    ...(row ? [[button(row.public_consent ? 'إيقاف استخدام اسمي' : 'السماح باسمي الأول', `public:${row.public_consent ? 'off' : 'on'}`)], [button('فك ربط حسابي', 'unlink')]] : []),
    [button('انسَ محادثاتي وأوقف الذاكرة', 'forget')], [button(memory ? 'إيقاف الذاكرة' : 'تشغيل ذاكرة 24 ساعة', memory ? 'forget' : 'memory:on')],
    ...(admin ? [[button('إدارة الطلاب', 'admin')]] : []),
  ]);
}
export async function identityAdminPanel(db: D1Database, telegram: TelegramClient, userId: number, page = 0): Promise<void> {
  const settings = await new EventStore(db).getSettings();
  if (!isAdmin(userId, settings.ownerUid)) return;
  const rows = await db.prepare('SELECT id,name FROM student_roster WHERE active=1 ORDER BY name LIMIT 9 OFFSET ?').bind(page * 8).all<{ id: string; name: string }>();
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM student_link_challenges WHERE state='consented' AND expires_at>?").bind(Date.now()).first<{ n: number }>();
  await tell(db,telegram, userId, `إدارة الطلاب — طلبات التوثيق: ${pending?.n ?? 0}\nالتوثيق يربط هوية حساب رقمية بعد موافقة صاحبه.`, [
    ...rows.results.slice(0, 8).map(row => [button(row.name, `student:${row.id}`)]),
    ...(rows.results.length > 8 ? [[button('التالي', `page:${page + 1}`)]] : []),
    ...(page > 0 ? [[button('السابق', `page:${page - 1}`)]] : []),
    [button('طلبات التوثيق', 'pending')], [button('إضافة طالب', 'add')],
    ...(!rows.results.length && page === 0 ? [[button('تحميل قائمة الأسماء المتوفرة', 'seed')]] : []), [HOME],
  ]);
}

/** Private deterministic UI. This module never invokes AI or sends to another person. */
export async function handleIdentityUpdate(update: TelegramUpdate, telegram: TelegramClient, env: IdentityEnv, now = new Date()): Promise<boolean> {
  if (env.PRODUCT_MODE_ENABLED !== 'true' || !env.DB) return false;
  const query = update.callback_query;
  const message = query?.message ?? update.message;
  const actor = query?.from ?? message?.from;
  const text = message?.text?.trim() ?? '';
  const data = query?.data ?? '';
  const identityText = /^(?:👥\s*)?إدارة الطلاب$|^(?:هويتي|حسابي|ربط حسابي|اسمي الظاهر|انسَ محادثاتي|انسى محادثاتي|إيقاف استخدام اسمي|فك ربط حسابي)(?:\s|$)/u.test(text);
  if (!query && !identityText && message?.chat.type === 'private' && actor &&
    (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/iu.test(text) || /^\p{Extended_Pictographic}/u.test(text)
      || /^(?:القائمة الرئيسية|القائمه الرئيسيه|رجوع|إلغاء|الغاء)$/u.test(text))) {
    await env.DB.prepare('DELETE FROM student_identity_sessions WHERE user_id=?').bind(actor.id).run().catch(() => {});
    return false;
  }
  if (!data.startsWith('idn:') && !identityText) {
    if (!message || query || message.chat.type !== 'private' || !actor) return false;
    const session = await env.DB.prepare('SELECT action,roster_id,expires_at FROM student_identity_sessions WHERE user_id=?').bind(actor.id)
      .first<{ action: 'add' | 'rename'; roster_id: string | null; expires_at: number }>().catch(() => null);
    if (!session || session.expires_at <= now.getTime()) return false;
  }
  if (!message || !actor || actor.is_bot || message.chat.type !== 'private' || message.chat.id !== actor.id) {
    if (query && data.startsWith('idn:')) await telegram.call('answerCallbackQuery', { callback_query_id: query.id, text: 'إدارة الهوية بالخاص فقط.' });
    return data.startsWith('idn:');
  }
  const db = env.DB, uid = actor.id, at = now.getTime();
  if (query) await telegram.call('answerCallbackQuery', { callback_query_id: query.id });
  try {
    const settings = await new EventStore(db).getSettings();
    const admin = isAdmin(uid, settings.ownerUid);
    let action='';
    if(query){
      const match=/^idn:([a-f0-9]{24}):(\d{1,2})$/u.exec(data);
      const granted=match?await consumeManualPanel(db,{...update,callback_query:{...query,data:`man:${match[1]}:${match[2]}`}},at):null;
      if(!granted||granted.action!=='identity'||typeof granted.data!=='string'){await tell(db,telegram,uid,'الزر قديم أو غير صالح؛ افتح قسم الهوية من جديد.');return true;}
      action=granted.data.slice(4);
    }
    if (action === 'home' || /^(?:هويتي|حسابي)$/u.test(text)) { await selfPanel(db, telegram, uid, admin); return true; }
    if (action === 'forget' || /^(?:انسَ|انسى) محادثاتي$/u.test(text)) {
      await forgetGroupMemory(db, uid, at); await tell(db,telegram, uid, 'مسحت سياق محادثاتك وأوقفت حفظ ذاكرة جديدة. التبليغات الأكاديمية والسجل الإداري تبقى بسجلها.'); return true;
    }
    if (action === 'memory:on') {
      await db.prepare(`INSERT INTO student_privacy(user_id,memory_enabled,updated_at) VALUES(?,1,?)
        ON CONFLICT(user_id) DO UPDATE SET memory_enabled=1,updated_at=excluded.updated_at`).bind(uid, at).run();
      await selfPanel(db, telegram, uid, admin); return true;
    }
    if (action === 'unlink' || text === 'فك ربط حسابي') {
      await tell(db,telegram, uid, 'تفك ربط حسابك وتوقف استخدام اسمك؟', [[button('نعم، فك الربط', 'unlink:yes')], [HOME]]); return true;
    }
    if (action === 'unlink:yes') {
      await db.batch([db.prepare('DELETE FROM student_identities WHERE telegram_user_id=?').bind(uid),
        db.prepare("UPDATE student_link_challenges SET state='revoked' WHERE claimed_user_id=? OR previous_user_id=?").bind(uid, uid)]);
      await forgetGroupMemory(db, uid, at); await tell(db,telegram, uid, 'فكّيت الربط وأوقفت استخدام اسمك وذاكرة المحادثات.'); return true;
    }
    if (/^public:(on|off)$/u.test(action) || text === 'إيقاف استخدام اسمي') {
      await db.prepare('UPDATE student_identities SET public_consent=?,consent_at=?,updated_at=? WHERE telegram_user_id=?')
        .bind(Number(action === 'public:on'), at, at, uid).run();
      await selfPanel(db, telegram, uid, admin); return true;
    }
    if (text.startsWith('اسمي الظاهر ')) {
      const name = cleanName(text.slice('اسمي الظاهر '.length));
      if (!validName(name)) { await tell(db,telegram, uid, 'اكتب اسماً واضحاً من 2 إلى 80 حرفاً، بدون روابط أو رموز تحكم.'); return true; }
      const changed = await db.prepare('UPDATE student_identities SET display_name=?,updated_at=? WHERE telegram_user_id=?').bind(name, at, uid).run();
      await tell(db,telegram, uid, changed.meta.changes ? 'حدّثت اسمك الظاهر؛ اسم السجل الدراسي بقي مثل ما هو.' : 'وثّق حسابك أولاً حتى تختار اسماً ظاهراً.'); return true;
    }
    if (text.startsWith('ربط حسابي')) {
      if ('forward_origin' in message || 'forward_from' in message || 'forward_sender_name' in message) { await tell(db,telegram, uid, 'اكتب الرمز من حسابك مباشرةً؛ الرسائل المحوّلة ما تثبت الهوية.'); return true; }
      const code = /^ربط حسابي\s+([a-f0-9]{24})$/u.exec(text)?.[1];
      const challenge = code ? await claimStudentChallenge(db, code, uid, at) : null;
      if (!challenge) { await tell(db,telegram, uid, 'الرمز غير صالح أو مستخدم أو انتهت مدته؛ اطلب رمزاً جديداً من الأدمن.'); return true; }
      await tell(db,telegram, uid, `الربط المقترح: ${escapeHtml(challenge.name)}.\nموافقتك تربط هذا الحساب باسم السجل بعد تحقق الأدمن. تگدر توافق بدون إظهار اسمك، أو تسمح باستخدام اسمك الأول بأجوبة الكروب، وتلغي هالشي بأي وقت.`, [
        [button('أوافق بدون استخدام اسمي بالكروب', `consent:${challenge.token_hash}:no`)],
        [button('أوافق وأسمح باسمي الأول', `consent:${challenge.token_hash}:yes`)],
        [button('أرفض الربط', `decline:${challenge.token_hash}`)],
      ]); return true;
    }
    const consent = /^consent:([a-f0-9]{24}):(yes|no)$/u.exec(action);
    if (consent) {
      const changed = await consentStudentChallenge(db, consent[1]!, uid, consent[2] === 'yes', at);
      await tell(db,telegram, uid, changed ? 'سجّلت موافقتك. الربط ينتظر تحقق الأدمن من صاحب الحساب؛ ما صار موثّق بعد.' : 'طلب الموافقة انتهى أو مستخدم؛ اطلب رمزاً جديداً.'); return true;
    }
    const decline = /^decline:([a-f0-9]{24})$/u.exec(action);
    if (decline) {
      await db.prepare("UPDATE student_link_challenges SET state='declined' WHERE token_hash=? AND claimed_user_id=? AND state IN ('claimed','consented')").bind(decline[1], uid).run();
      await tell(db,telegram, uid, 'ألغيت طلب الربط.'); return true;
    }
    if (!admin) { await tell(db,telegram, uid, 'إدارة قائمة الطلاب والتوثيق للأدمن. تگدر تدير موافقتك وذاكرتك هنا.', [[HOME]]); return true; }
    if (action === 'admin' || action.startsWith('page:') || /^(?:👥\s*)?إدارة الطلاب$/u.test(text)) {
      const page = /^page:(\d{1,4})$/u.exec(action)?.[1]; await identityAdminPanel(db, telegram, uid, Number(page ?? 0)); return true;
    }
    if (action === 'seed') { await seedIdentityRoster(db, at); await identityAdminPanel(db, telegram, uid); return true; }
    if (action === 'add' || action.startsWith('rename:')) {
      const id = action.startsWith('rename:') ? action.slice(7) : null;
      await db.prepare(`INSERT INTO student_identity_sessions(user_id,action,roster_id,expires_at) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET action=excluded.action,roster_id=excluded.roster_id,expires_at=excluded.expires_at`)
        .bind(uid, id ? 'rename' : 'add', id, at + 10 * 60_000).run();
      await tell(db,telegram, uid, 'اكتب الاسم الكامل برسالة واحدة خلال 10 دقائق. «إلغاء» يرجع بدون حفظ.'); return true;
    }
    const student = /^student:([a-zA-Z0-9-]{1,36})$/u.exec(action);
    if (student) {
      const row = await db.prepare(`SELECT r.name,i.telegram_user_id FROM student_roster r LEFT JOIN student_identities i ON i.roster_id=r.id
        WHERE r.id=? AND r.active=1`).bind(student[1]).first<{ name: string; telegram_user_id: number | null }>();
      if (!row) { await tell(db,telegram, uid, 'الاسم غير موجود.'); return true; }
      await tell(db,telegram, uid, `${escapeHtml(row.name)}\n${row.telegram_user_id ? `الحساب الموثق: ${row.telegram_user_id}` : 'بدون حساب موثق'}.\nالربط البديل يحتاج موافقة الحساب الجديد ثم تحققك؛ الحساب القديم يبقى لحد اكتمال الاثنين.`, [
        [button(row.telegram_user_id ? 'دعوة حساب بديل' : 'إنشاء رمز ربط', `invite:${student[1]}`)], [button('تعديل اسم السجل', `rename:${student[1]}`)],
        [button('رجوع للقائمة', 'admin')],
      ]); return true;
    }
    const invite = /^invite:([a-zA-Z0-9-]{1,36})$/u.exec(action);
    if (invite) {
      const code = await issueStudentChallenge(db, invite[1]!, uid, at);
      await tell(db,telegram, uid, code ? `رمز صالح 15 دقيقة ولحساب واحد فقط. سلّمه للطالب بعد التأكد منه. الطالب يكتب بالخاص:\n<code>ربط حسابي ${code}</code>\nبعد موافقته افتح طلبات التوثيق وتحقق من الحساب الرقمي قبل الاعتماد.` : 'تعذر إنشاء الرمز.'); return true;
    }
    if (action === 'pending') {
      const rows = await db.prepare(`SELECT c.token_hash,c.claimed_user_id,c.previous_user_id,r.name FROM student_link_challenges c
        JOIN student_roster r ON r.id=c.roster_id WHERE c.state='consented' AND c.expires_at>? ORDER BY c.created_at LIMIT 10`).bind(at)
        .all<Pick<Challenge, 'token_hash' | 'name' | 'claimed_user_id' | 'previous_user_id'>>();
      await tell(db,telegram, uid, 'تحقق خارجياً من أن الحساب المقترح يعود لصاحب الاسم. لا تعتمد اليوزر أو الاسم الظاهر وحدهما.', [
        ...rows.results.map(row => [button(`${row.name} — ${row.claimed_user_id}${row.previous_user_id ? ' (بديل)' : ''}`, `review:${row.token_hash}`)]), [button('رجوع للقائمة', 'admin')],
      ]); return true;
    }
    const review = /^review:([a-f0-9]{24})$/u.exec(action);
    if (review) {
      const row = await db.prepare(`SELECT c.*,r.name FROM student_link_challenges c JOIN student_roster r ON r.id=c.roster_id
        WHERE c.token_hash=? AND c.state='consented' AND c.expires_at>?`).bind(review[1], at).first<Challenge>();
      await tell(db,telegram, uid, row ? `${escapeHtml(row.name)}\nالحساب الجديد: ${row.claimed_user_id}\n${row.previous_user_id ? `سيستبدل الحساب ${row.previous_user_id}.\n` : ''}صاحب الحساب الجديد وافق من الخاص. بعد تحققك المستقل من هويته، اعتمد الربط.` : 'الطلب غير صالح.',
        row ? [[button('تحققت من صاحب الحساب — اعتماد', `approve:${review[1]}`)], [button('رفض الطلب', `reject:${review[1]}`)], [button('رجوع', 'pending')]] : [[HOME]]); return true;
    }
    const approve = /^approve:([a-f0-9]{24})$/u.exec(action);
    if (approve) { const done = await verifyStudentChallenge(db, approve[1]!, uid, at); await tell(db,telegram, uid, done ? 'اعتمدت الربط بعد موافقة الحساب الجديد والتحقق.' : 'الطلب انتهى أو تغيّر الربط؛ لم أعتمد حساباً جديداً.'); return true; }
    const reject = /^reject:([a-f0-9]{24})$/u.exec(action);
    if (reject) { await db.prepare("UPDATE student_link_challenges SET state='revoked' WHERE token_hash=? AND state IN ('claimed','consented')").bind(reject[1]).run(); await tell(db,telegram, uid, 'رفضت طلب الربط.'); return true; }
    if (!query) {
      const session = await db.prepare('SELECT action,roster_id,expires_at FROM student_identity_sessions WHERE user_id=?').bind(uid)
        .first<{ action: 'add' | 'rename'; roster_id: string | null; expires_at: number }>();
      if (session && session.expires_at > at) {
        if (/^(?:إلغاء|الغاء|رجوع)$/u.test(text)) { await db.prepare('DELETE FROM student_identity_sessions WHERE user_id=?').bind(uid).run(); await identityAdminPanel(db, telegram, uid); return true; }
        const name = cleanName(text);
        if (!validName(name)) { await tell(db,telegram, uid, 'اكتب اسماً من 2 إلى 80 حرفاً بدون روابط أو رموز تحكم.'); return true; }
        await db.batch([
          session.action === 'add' ? db.prepare('INSERT INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(), name, at, at)
            : db.prepare('UPDATE student_roster SET name=?,updated_at=? WHERE id=?').bind(name, at, session.roster_id),
          ...(session.action === 'rename' ? [db.prepare('UPDATE student_identities SET public_consent=0,updated_at=? WHERE roster_id=?').bind(at, session.roster_id)] : []),
          db.prepare('DELETE FROM student_identity_sessions WHERE user_id=?').bind(uid),
        ]);
        await tell(db,telegram, uid, 'حفظت اسم السجل. لم أربطه بحساب تلقائياً.'); return true;
      }
    }
    await tell(db,telegram, uid, 'هذا الزر غير صالح؛ افتح إدارة الطلاب من جديد.'); return true;
  } catch {
    await tell(db,telegram, uid, 'إدارة الهوية غير متاحة حالياً؛ لم أؤكد أي ربط.'); return true;
  }
}
