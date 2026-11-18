import { describe, expect, it, vi } from 'vitest';
import { isStudentNamesRequest, sendStudentNames } from '../src/student-names';
import { STUDENT_NAMES_FILENAME, STUDENT_NAMES_PDF_BASE64 } from '../src/student-names-document';
import type { TelegramClient } from '../src/telegram';
import type { TelegramMessage } from '../src/types';

describe('student names requests', () => {
  it.each([
    'اسماء الطلاب', 'أسماء الطلبة', 'إسماء الطُّلَّاب؟', 'قائمة أسماء طلاب المرحلة الثالثة',
    'قائمة الطلاب', 'قائمة الطلبة', 'دزلي ملف الاسماء', 'دعبول دزلي أسماء الطلاب',
    'أريد أسماء طلاب المرحلة الثالثة', 'ممكن قائمة الطلاب؟', 'ارسل قائمة بأسماء الطلاب',
    '@ActualDaaboolBot عندك ملف أسماء الطلبة؟', 'اسماءالطلاب', 'دزليملفالاسماء',
    'ملف أسماء الطلاب PDF', 'شنو أسماء الطلاب؟', 'أسماء الطلاب كلهم', 'أسماء الطلاب مجموعة B', 'اسماء طلاب مجموعة أ',
    'الاسماء مال الطلاب', 'دعبول دزلي الاسماء مال الطلاب', 'دزلي قائمة بأسماء الطلاب',
    'أريد ملف الأسماء', 'أسامي الطلاب', 'الأسماء تبع الطلاب', 'اسماء لـ الطلاب',
    'اسماء للطلاب', 'اسماء طلابنا', 'أسامي طلبتنا', 'قائمة طلابنا', 'ملف أسامي الطلبة',
    'هممم زين شنو اسماء طلابنا ؟', 'عفيه دزلي اسماء الطلاب',
  ])('recognizes a roster request: %s', text => {
    expect(isStudentNamesRequest(text)).toBe(true);
  });

  it.each([
    '', 'اسماء', 'اسم الطالب', 'منو الدكتور مال المحاضرة الجاية؟', 'اسماء دكاترة المرحلة الثالثة',
    'دزلي ملف امتحان المترجمات', 'قائمة مواد الطلاب', 'شعدنا امتحانات للطلاب باجر؟',
    'باجر امتحان للطلاب', 'اسماء الطلاب لازم تنكتب على ورقة الامتحان',
    'عدنا قائمة أسماء الطلاب', 'اريد اسماء المواد', 'غير اسمي', 'اسماء الطلاب الناجحين',
    'شنو أسماء الطلبة الموجودين بالمختبر اليوم؟',
    'اسماءالدكاترة', 'ملفاسماءالاساتذة', 'دزلي الاسماء مال الدكاترة', 'أسامي الأساتذة',
  ])('leaves other questions and statements alone: %s', text => {
    expect(isStudentNamesRequest(text)).toBe(false);
  });
});

describe('student names document', () => {
  const message: TelegramMessage = {
    message_id: 12, from: { id: 42, is_bot: false }, chat: { id: -100123, type: 'supergroup' },
    message_thread_id: 77, text: 'دعبول أسماء الطلاب',
  };

  it('uploads the supplied PDF bytes with the original reply and topic', async () => {
    const call = vi.fn().mockResolvedValue(true);
    const summary = await sendStudentNames(message, { call } as unknown as TelegramClient, 'أسماء الطلاب');
    expect(summary).toBe('أرسلت ملف أسماء طلاب المرحلة الثالثة بصيغة PDF للقائمة الكاملة.');
    expect(call).toHaveBeenCalledTimes(1);
    const [method, form] = call.mock.calls[0]! as [string, FormData];
    expect(method).toBe('sendDocument');
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe('-100123');
    expect(form.get('message_thread_id')).toBe('77');
    expect(form.get('caption')).toBe('أسماء طلاب المرحلة الثالثة — 41 اسم');
    expect(JSON.parse(form.get('reply_parameters') as string)).toEqual({
      message_id: 12, allow_sending_without_reply: true,
    });
    const document = form.get('document') as File;
    expect(document.name).toBe(STUDENT_NAMES_FILENAME);
    expect(document.type).toBe('application/pdf');
    const bytes = new Uint8Array(await document.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''))).toBe(STUDENT_NAMES_PDF_BASE64);
  });

  it('clarifies group requests without inventing a group-specific roster', async () => {
    const call = vi.fn().mockResolvedValue(true);
    const summary = await sendStudentNames(message, { call } as unknown as TelegramClient, 'أسماء الطلاب مجموعة B');
    expect(summary).toContain('ما متوفر تقسيم حسب المجموعة');
    expect(summary).not.toContain('أرسلت');
    expect(call).toHaveBeenCalledWith('sendMessage', expect.objectContaining({
      chat_id: -100123, message_thread_id: 77,
      text: expect.stringContaining('المرحلة الثالثة كاملة'),
      reply_parameters: { message_id: 12, allow_sending_without_reply: true },
    }));
    expect(call).toHaveBeenCalledTimes(1);
  });
});
