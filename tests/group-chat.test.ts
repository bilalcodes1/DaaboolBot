import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localD1 } from './helpers/local-d1';
import { allowedProductGroups, handleGroupChat } from '../src/group-chat';
import { generateAssistantJson } from '../src/assistant-ai';
import { forgetGroupMemory } from '../src/student-identity';
import { TelegramError, type TelegramClient } from '../src/telegram';
import type { Env, TelegramUpdate } from '../src/types';

vi.mock('../src/assistant-ai', async importOriginal => ({ ...await importOriginal<typeof import('../src/assistant-ai')>(), generateAssistantJson: vi.fn() }));
const generate = vi.mocked(generateAssistantJson);
const NOW = Date.parse('2026-11-07T10:00:00Z');
const databases: ReturnType<typeof localD1>[] = [];
function setup() {
  const local = localD1(); databases.push(local);
  local.sqlite.exec('UPDATE settings SET owner_uid=101,target_chat_id=-100123');
  const call = vi.fn(async () => ({ message_id: 77 }));
  const getMe = vi.fn(async () => ({ id: 999, is_bot: true, username: 'DaaboolTestBot' }));
  const telegram = { call, getMe } as unknown as TelegramClient;
  const env: Env = { DB: local.db, TELEGRAM_BOT_TOKEN: 'local-test', WEBHOOK_SECRET_TOKEN: 'local-test',
    PRODUCT_MODE_ENABLED: 'true', GROUP_AI_ENABLED: 'true', PRODUCT_ALLOWED_GROUP_IDS: '-100123,-100456', GROQ_API_KEY: 'local-fake-key' };
  return { ...local, telegram, call, getMe, env };
}
function message(id: number, text: string, uid = 202, chatId = -100123, thread = 1): TelegramUpdate {
  return { update_id: id, message: { message_id: id, from: { id: uid, is_bot: false }, chat: { id: chatId, type: 'supergroup' },
    message_thread_id: thread, text } };
}
function content(index = 0): string { return JSON.stringify(generate.mock.calls[index]?.[1]); }
beforeEach(() => { generate.mockReset(); generate.mockResolvedValue({ reply: 'هلا حبيبي، موجود وياكم 😄' }); });
afterEach(() => { for (const local of databases.splice(0)) local.close(); });

describe('explicit authorized group reply capability', () => {
  it('fails closed for flags, private chats, unlisted groups, bare wake words and other bot mentions', async () => {
    const local = setup();
    expect(allowedProductGroups('[-100123,"-100456"]')).toEqual([]);
    expect(allowedProductGroups('-100123,invalid')).toEqual([]);
    const privateUpdate = message(1, '@DaaboolTestBot هلا'); privateUpdate.message!.chat = { id: 202, type: 'private' };
    expect(await handleGroupChat(privateUpdate, local.telegram, local.env, new Date(NOW))).toBe(false);
    expect(await handleGroupChat(message(2, '@DaaboolTestBot هلا', 202, -999), local.telegram, local.env, new Date(NOW))).toBe(false);
    expect(await handleGroupChat(message(3, 'دعبول هلا'), local.telegram, local.env, new Date(NOW))).toBe(false);
    expect(local.getMe).not.toHaveBeenCalled();
    expect(await handleGroupChat(message(4, '@OtherBot هلا'), local.telegram, local.env, new Date(NOW))).toBe(false);
    expect(await handleGroupChat(message(5, '@DaaboolTestBot هلا'), local.telegram, { ...local.env, GROUP_AI_ENABLED: 'false' }, new Date(NOW))).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(local.call).not.toHaveBeenCalled();
    expect(local.queryCount()).toBe(0);
  });
  it('accepts exact case-insensitive mentions with UTF-16 offsets and actual bot replies', async () => {
    const local = setup(), mentioned = message(1, '😀 @DAABOOLTESTBOT هلا');
    mentioned.message!.entities = [{ type: 'mention', offset: 3, length: 15 }];
    expect(await handleGroupChat(mentioned, local.telegram, local.env, new Date(NOW))).toBe(true);
    const reply = message(2, 'شنو تقصد؟');
    reply.message!.reply_to_message = { message_id: 77, chat: { id: -100123, type: 'supergroup' }, from: { id: 999, is_bot: true }, text: 'شرح سابق' };
    expect(await handleGroupChat(reply, local.telegram, local.env, new Date(NOW + 1000))).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(content(1)).toContain('شرح سابق');
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM academic_intakes').get()?.n).toBe(0);
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
  });
  it('ignores model write payloads and false success claims without domain side effects', async () => {
    const local = setup();
    generate.mockResolvedValueOnce({ reply: 'تم حفظ الامتحان', items: [{ action: 'create' }] });
    await handleGroupChat(message(1, '@DaaboolTestBot احفظ امتحان الشبكات'), local.telegram, local.env, new Date(NOW));
    generate.mockResolvedValueOnce({ reply: 'حفظت الامتحان ونشرته' });
    await handleGroupChat(message(2, '@DaaboolTestBot انشر بالقناة'), local.telegram, local.env, new Date(NOW + 1000));
    for (const [, payload] of local.call.mock.calls as unknown as [string, { text: string }][]) expect(payload.text).not.toMatch(/تم حفظ|حفظت الامتحان/);
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM academic_reports').get()?.n).toBe(0);
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0);
    expect(local.sqlite.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n).toBe(0);
    expect(local.sqlite.prepare('SELECT enabled FROM smart_reminder_config').get()?.enabled).toBe(0);
  });
  it('sends only a verified consented first name and no automatically attached account IDs or roster', async () => {
    const local = setup(), uid = 7000000011;
    local.sqlite.prepare('INSERT INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('one', 'سيف اسموسط اسمعائلة', NOW, NOW);
    local.sqlite.prepare('INSERT INTO student_identities(roster_id,telegram_user_id,public_consent,consent_at,verified_by,verified_at,updated_at) VALUES(?,?,1,?,?,?,?)').run('one', uid, NOW, 101, NOW, NOW);
    await handleGroupChat(message(1, '@DaaboolTestBot رقمي 7000000011 هلا', uid), local.telegram, local.env, new Date(NOW));
    expect(content()).toContain('سيف'); expect(content()).not.toContain(String(uid));
    expect(content()).not.toContain('اسموسط'); expect(content()).not.toContain('اسمعائلة');
    expect(content()).not.toContain('إلهام خاشع');
    local.sqlite.prepare('UPDATE student_identities SET public_consent=0').run();
    await handleGroupChat(message(2, '@DaaboolTestBot هلا', uid), local.telegram, local.env, new Date(NOW + 1000));
    expect(content(1)).toContain('verified_first_name');
    expect(JSON.parse(generate.mock.calls[1]![1][1]!.content).verified_first_name).toBeNull();
  });
  it('isolates bounded memory by account, chat and topic; forgetting disables future memory storage', async () => {
    const local = setup();
    await handleGroupChat(message(1, '@DaaboolTestBot سؤالي الأول'), local.telegram, local.env, new Date(NOW));
    await handleGroupChat(message(2, '@DaaboolTestBot تكملة'), local.telegram, local.env, new Date(NOW + 1000));
    expect(generate.mock.calls[1]![1].some(item => item.role === 'assistant')).toBe(true);
    await handleGroupChat(message(3, '@DaaboolTestBot هلا', 303), local.telegram, local.env, new Date(NOW + 2000));
    expect(generate.mock.calls[2]![1].some(item => item.role === 'assistant')).toBe(false);
    await handleGroupChat(message(4, '@DaaboolTestBot هلا', 202, -100456), local.telegram, local.env, new Date(NOW + 3000));
    expect(generate.mock.calls[3]![1].some(item => item.role === 'assistant')).toBe(false);
    await handleGroupChat(message(5, '@DaaboolTestBot هلا', 202, -100123, 2), local.telegram, local.env, new Date(NOW + 65_000));
    expect(generate.mock.calls[4]![1].some(item => item.role === 'assistant')).toBe(false);
    await forgetGroupMemory(local.db, 202, NOW + 66_000);
    await handleGroupChat(message(6, '@DaaboolTestBot سؤال بلا ذاكرة'), local.telegram, local.env, new Date(NOW + 67_000));
    expect(generate.mock.calls[5]![1].some(item => item.role === 'assistant')).toBe(false);
    expect(local.sqlite.prepare('SELECT question,answer FROM group_ai_turns WHERE update_id=6').get()).toMatchObject({ question: null, answer: null });
  });
  it('limits three questions per minute, suppresses replay and quarantines uncertain delivery without resending', async () => {
    const local = setup();
    for (let i = 1; i <= 4; i++) await handleGroupChat(message(i, '@DaaboolTestBot هلا'), local.telegram, local.env, new Date(NOW + i));
    expect(generate).toHaveBeenCalledTimes(3);
    await handleGroupChat(message(1, '@DaaboolTestBot هلا'), local.telegram, local.env, new Date(NOW + 100));
    expect(generate).toHaveBeenCalledTimes(3);
    local.call.mockRejectedValueOnce(new TelegramError(500, true));
    await expect(handleGroupChat(message(5, '@DaaboolTestBot هلا'), local.telegram, local.env, new Date(NOW + 61_000))).resolves.toBe(true);
    expect(local.sqlite.prepare('SELECT state FROM group_ai_turns WHERE update_id=5').get()?.state).toBe('unknown');
    const sends=local.call.mock.calls.length;
    await handleGroupChat(message(5, '@DaaboolTestBot هلا'), local.telegram, local.env, new Date(NOW + 62_000));
    expect(generate).toHaveBeenCalledTimes(4);
    expect(local.call.mock.calls).toHaveLength(sends);
    expect(local.sqlite.prepare('SELECT state FROM group_ai_turns WHERE update_id=5').get()?.state).toBe('unknown');
  });
});
