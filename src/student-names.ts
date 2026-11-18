import { stripMentions } from './input';
import { stripWakeWord } from './personality';
import { conversationalText } from './assistant-knowledge';
import { STUDENT_NAMES_COUNT, STUDENT_NAMES_FILENAME, STUDENT_NAMES_PDF_BASE64 } from './student-names-document';
import type { TelegramClient } from './telegram';
import type { TelegramMessage } from './types';

function namesQuery(text: string): string {
  return conversationalText(stripWakeWord(stripMentions(text)) ?? stripMentions(text)).toLowerCase();
}

/** Match requests for the supplied roster, without treating ordinary student mentions as requests. */
export function isStudentNamesRequest(text: string): boolean {
  const query = namesQuery(text);
  const courtesy = '(?:(?:هلا|حبيبي|لو\\s+سمحت|رجاء|رجاءا|ممكن|اذا\\s+ممكن|بلا\\s+زحمه)\\s*)*';
  const request = '(?:(?:دزلي|دزلنا|دزلنه|دز|تدزلي|ارسللي|ارسل\\s+لي|ارسل|ارسلي|ابعثلي|ابعث|انطيني|عطيني|اعطيني|اريد|نريد|احتاج|محتاج|هات|اعرض|طلعلي|عدك|عندك|اكو|وين|شنو|تكدر\\s+تدزلي)\\s*)?';
  const list = '(?:ملف|قائمه|لسته|كشف)';
  const names = '(?:ال)?(?:اسماء|اسامي)';
  const students = '(?:ال)?(?:طلاب(?:نا)?|طلب(?:ه|تنا))';
  const belonging = '(?:(?:مال|تبع|لل|ل)\\s*)?';
  const target = `(?:(?:${list}\\s*(?:ب\\s*)?)?${names}\\s*${belonging}${students}|${list}\\s*${students}|${list}\\s*${names})`;
  const stage = '(?:\\s*(?:(?:مال|لل|ل|في|ب)\\s*)?(?:ال)?مرحله\\s*(?:الثالثه|3|٣))?';
  const group = '(?:\\s*(?:(?:مال|ل|لل)\\s*)?(?:ال)?(?:مجموعه|كروب|شعبه|group)\\s*[abاب])?';
  const ending = '(?:\\s*(?:كلهم|كلها|كامل|كامله|pdf|بي\\s+دي\\s+اف|لو\\s+سمحت|رجاء|رجاءا|ممكن))*';
  return new RegExp(`^${courtesy}${request}${target}${stage}${group}${ending}$`, 'u').test(query);
}

export async function sendStudentNames(message: TelegramMessage, telegram: TelegramClient, text: string): Promise<string> {
  const reply = { message_id: message.message_id, allow_sending_without_reply: true };
  const thread = message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {};
  if (!STUDENT_NAMES_PDF_BASE64 || STUDENT_NAMES_COUNT === 0) {
    await telegram.call('sendMessage', {
      chat_id: message.chat.id,
      text: 'ملف الأسماء مو مضمّن بالنسخة العامة. يگدر الأدمن يربط مصدر الأسماء الخاص قبل استخدام هالميزة.',
      reply_parameters: reply,
      ...thread,
    });
    return 'أوضحت أن ملف الأسماء يحتاج إعداداً خاصاً قبل الإرسال.';
  }
  if (/(?:مجموعه|كروب|شعبه|group)\s*[abاب](?:\s|$)/u.test(namesQuery(text))) {
    await telegram.call('sendMessage', {
      chat_id: message.chat.id,
      text: 'الملف الموجود عندي يضم أسماء طلاب المرحلة الثالثة كاملة، وما بيه تقسيم حسب مجموعة A أو B. اطلب «أسماء الطلاب» حتى أدزّه إلك.',
      reply_parameters: reply,
      ...thread,
    });
    return 'وضحت أن ملف أسماء طلاب المرحلة الثالثة للقائمة الكاملة، وما متوفر تقسيم حسب المجموعة.';
  }
  const bytes = Uint8Array.from(atob(STUDENT_NAMES_PDF_BASE64), character => character.charCodeAt(0));
  const form = new FormData();
  form.set('chat_id', String(message.chat.id));
  form.set('document', new Blob([bytes], { type: 'application/pdf' }), STUDENT_NAMES_FILENAME);
  form.set('caption', `أسماء طلاب المرحلة الثالثة — ${STUDENT_NAMES_COUNT} اسم`);
  form.set('reply_parameters', JSON.stringify(reply));
  if (message.message_thread_id !== undefined) form.set('message_thread_id', String(message.message_thread_id));
  await telegram.call('sendDocument', form);
  return 'أرسلت ملف أسماء طلاب المرحلة الثالثة بصيغة PDF للقائمة الكاملة.';
}
