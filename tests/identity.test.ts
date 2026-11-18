import { afterEach, describe, expect, it, vi } from 'vitest';
import { localD1 } from './helpers/local-d1';
import { claimStudentChallenge, consentStudentChallenge, forgetGroupMemory, handleIdentityUpdate,
  issueStudentChallenge, minimumVerifiedName, seedIdentityRoster, verifyStudentChallenge } from '../src/student-identity';
import { cleanupGroupMemory } from '../src/group-chat';
import type { TelegramClient } from '../src/telegram';
import type { TelegramUpdate } from '../src/types';

const NOW = Date.parse('2026-11-07T10:00:00Z');
const databases: ReturnType<typeof localD1>[] = [];
function setup() {
  const local = localD1(); databases.push(local);
  local.sqlite.exec('UPDATE settings SET owner_uid=101,target_chat_id=-100123');
  local.sqlite.prepare('INSERT INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('student-one', 'سيف أحمد محمد', NOW, NOW);
  const call = vi.fn(async () => ({ message_id: 77 }));
  const telegram = { call } as unknown as TelegramClient;
  return { ...local, telegram, call, env: { DB: local.db, PRODUCT_MODE_ENABLED: 'true' } };
}
function privateMessage(id: number, text: string, updateId = 1): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, from: { id, is_bot: false }, chat: { id, type: 'private' }, text } };
}
function callback(id: number, data: string, updateId = 2): TelegramUpdate {
  return { update_id: updateId, callback_query: { id: `q${updateId}`, from: { id, is_bot: false }, chat_instance: 'local', data,
    message: { message_id: 77, chat: { id, type: 'private' } } } };
}
function issuedButton(local:ReturnType<typeof setup>,label:string):string {
  for(const call of [...local.call.mock.calls].reverse() as unknown as [string,{reply_markup?:{inline_keyboard?:{text:string;callback_data:string}[][]}}][]){
    const found=call[1].reply_markup?.inline_keyboard?.flat().find(b=>b.text===label);if(found)return found.callback_data;
  }throw Error('Expected issued button: '+label);
}
async function pending(local: ReturnType<typeof setup>, uid: number, publicName = true) {
  const code = await issueStudentChallenge(local.db, 'student-one', 101, NOW);
  expect(code).toMatch(/^[a-f0-9]{24}$/);
  const claim = await claimStudentChallenge(local.db, code!, uid, NOW + 1);
  expect(claim).not.toBeNull();
  expect(await consentStudentChallenge(local.db, claim!.token_hash, uid, publicName, NOW + 2)).toBe(true);
  return claim!;
}
afterEach(() => { for (const local of databases.splice(0)) local.close(); });

describe('consented numeric student account linking', () => {
  it('requires one-use private-account claim, explicit consent and current admin verification', async () => {
    const local = setup();
    expect(await minimumVerifiedName(local.db, 202)).toBeNull();
    expect(await issueStudentChallenge(local.db, 'student-one', 202, NOW)).toBeNull();
    const code = await issueStudentChallenge(local.db, 'student-one', 101, NOW);
    expect(await claimStudentChallenge(local.db, code!, 202, NOW + 16 * 60_000)).toBeNull();
    const fresh = await issueStudentChallenge(local.db, 'student-one', 101, NOW);
    const claim = await claimStudentChallenge(local.db, fresh!, 202, NOW + 1);
    expect(await claimStudentChallenge(local.db, fresh!, 303, NOW + 1)).toBeNull();
    expect(await verifyStudentChallenge(local.db, claim!.token_hash, 101, NOW + 2)).toBe(false);
    expect(await consentStudentChallenge(local.db, claim!.token_hash, 303, true, NOW + 2)).toBe(false);
    expect(await consentStudentChallenge(local.db, claim!.token_hash, 202, true, NOW + 2)).toBe(true);
    expect(await verifyStudentChallenge(local.db, claim!.token_hash, 202, NOW + 3)).toBe(false);
    expect(await verifyStudentChallenge(local.db, claim!.token_hash, 101, NOW + 3)).toBe(true);
    expect(await minimumVerifiedName(local.db, 202)).toBe('سيف');
    expect(await verifyStudentChallenge(local.db, claim!.token_hash, 101, NOW + 4)).toBe(false);
  });
  it('keeps the old account until the replacement consents and admin verifies; stale replacements fail', async () => {
    const local = setup();
    const first = await pending(local, 202);
    expect(await verifyStudentChallenge(local.db, first.token_hash, 101, NOW + 3)).toBe(true);
    const replacement = await pending(local, 303, false);
    expect(await minimumVerifiedName(local.db, 202)).toBe('سيف');
    expect(await minimumVerifiedName(local.db, 303)).toBeNull();
    expect(await verifyStudentChallenge(local.db, replacement.token_hash, 101, NOW + 4)).toBe(true);
    expect(await minimumVerifiedName(local.db, 202)).toBeNull();
    expect(await minimumVerifiedName(local.db, 303)).toBeNull();
    const newer = await pending(local, 404);
    local.sqlite.prepare('UPDATE student_identities SET telegram_user_id=505 WHERE roster_id=?').run('student-one');
    expect(await verifyStudentChallenge(local.db, newer.token_hash, 101, NOW + 5)).toBe(false);
    expect(local.sqlite.prepare('SELECT telegram_user_id FROM student_identities').get()?.telegram_user_id).toBe(505);
  });
  it('never seeds numeric account mappings from roster names', async () => {
    const local = setup(); await seedIdentityRoster(local.db, NOW);
    expect(Number(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_roster').get()?.n)).toBe(42);
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_identities').get()?.n).toBe(0);
    await seedIdentityRoster(local.db, NOW + 1);
    expect(Number(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_roster').get()?.n)).toBe(42);
  });
});

describe('private identity UI and privacy controls', () => {
  it('rejects group callbacks and forwarded claims, and does not let a different account approve consent', async () => {
    const local = setup();
    const group = callback(101, 'idn:seed'); group.callback_query!.message!.chat = { id: -100123, type: 'supergroup' };
    expect(await handleIdentityUpdate(group, local.telegram, local.env, new Date(NOW))).toBe(true);
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_roster').get()?.n).toBe(1);
    const code = await issueStudentChallenge(local.db, 'student-one', 101, NOW);
    const forwarded = privateMessage(202, `ربط حسابي ${code}`);
    Object.assign(forwarded.message!, { forward_origin: { type: 'user' } });
    await handleIdentityUpdate(forwarded, local.telegram, local.env, new Date(NOW));
    expect(local.sqlite.prepare('SELECT state FROM student_link_challenges').get()?.state).toBe('issued');
    await handleIdentityUpdate(privateMessage(202, `ربط حسابي ${code}`), local.telegram, local.env, new Date(NOW));
    const hash = String(local.sqlite.prepare('SELECT token_hash FROM student_link_challenges').get()?.token_hash);
    const consent=issuedButton(local,'أوافق بدون استخدام اسمي بالكروب');
    await handleIdentityUpdate(callback(303, consent), local.telegram, local.env, new Date(NOW + 1));
    expect(local.sqlite.prepare('SELECT state FROM student_link_challenges').get()?.state).toBe('claimed');
    await handleIdentityUpdate(callback(202, consent), local.telegram, local.env, new Date(NOW + 1));
    expect(local.sqlite.prepare('SELECT state,public_consent FROM student_link_challenges').get()).toMatchObject({ state: 'consented', public_consent: 0 });
  });
  it('supports user opt-out, alias, unlink and forgetting without editing academic history', async () => {
    const local = setup(), claim = await pending(local, 202);
    await verifyStudentChallenge(local.db, claim.token_hash, 101, NOW + 3);
    await handleIdentityUpdate(privateMessage(202, 'اسمي الظاهر أبو علي'), local.telegram, local.env, new Date(NOW + 4));
    expect(await minimumVerifiedName(local.db, 202)).toBe('أبو');
    await handleIdentityUpdate(privateMessage(202,'هويتي',20),local.telegram,local.env,new Date(NOW+5));
    await handleIdentityUpdate(callback(202, issuedButton(local,'إيقاف استخدام اسمي'),21), local.telegram, local.env, new Date(NOW + 5));
    expect(await minimumVerifiedName(local.db, 202)).toBeNull();
    local.sqlite.prepare("INSERT INTO group_ai_turns(update_id,user_id,chat_id,state,question,answer,lease_until,created_at) VALUES(1,202,-100123,'sent','private context','answer',0,?)").run(NOW);
    await forgetGroupMemory(local.db, 202, NOW + 6);
    expect(local.sqlite.prepare('SELECT question,answer FROM group_ai_turns').get()).toMatchObject({ question: null, answer: null });
    expect(local.sqlite.prepare('SELECT memory_enabled FROM student_privacy').get()?.memory_enabled).toBe(0);
    await handleIdentityUpdate(callback(202, issuedButton(local,'فك ربط حسابي'),22), local.telegram, local.env, new Date(NOW + 7));
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_identities').get()?.n).toBe(1);
    await handleIdentityUpdate(callback(202, issuedButton(local,'نعم، فك الربط'),23), local.telegram, local.env, new Date(NOW + 8));
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_identities').get()?.n).toBe(0);
  });
  it('does not consume navigation as a pending name and rechecks admin authorization', async () => {
    const local = setup();
    for (const label of ['/start', '📢 التبليغات', '🕌 المواقيت', 'رجوع']) {
      await handleIdentityUpdate(privateMessage(101,'👥 إدارة الطلاب',24),local.telegram,local.env,new Date(NOW));
      await handleIdentityUpdate(callback(101,issuedButton(local,'إضافة طالب'),25), local.telegram, local.env, new Date(NOW));
      expect(await handleIdentityUpdate(privateMessage(101, label), local.telegram, local.env, new Date(NOW + 1))).toBe(false);
      expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_identity_sessions').get()?.n).toBe(0);
    }
    await handleIdentityUpdate(callback(202, 'idn:add'), local.telegram, local.env, new Date(NOW));
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM student_identity_sessions').get()?.n).toBe(0);
  });
  it('cleans conversation and challenge TTLs independently of enabled AI', async () => {
    const local = setup();
    local.sqlite.prepare("INSERT INTO group_ai_turns(update_id,user_id,chat_id,state,question,answer,lease_until,created_at) VALUES(1,202,-100123,'sent','old','old',0,?)").run(NOW - 2 * 86_400_000);
    local.sqlite.prepare("INSERT INTO group_ai_turns(update_id,user_id,chat_id,state,question,answer,lease_until,created_at) VALUES(2,202,-100123,'sent','older','older',0,?)").run(NOW - 8 * 86_400_000);
    await cleanupGroupMemory(local.db, NOW);
    expect(local.sqlite.prepare('SELECT update_id,question,answer FROM group_ai_turns').all()).toEqual([{ update_id: 1, question: null, answer: null }]);
  });
});
