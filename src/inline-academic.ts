import { classifyAgendaQuestion, eventLookupDateBounds, renderAgendaSchedule } from './agenda';
import { classifyEventAction, extractEventQuery } from './event-extract';
import { COURSE_LABELS, EVENT_KIND_LABELS, formatEvent } from './event-format';
import { EventStore, type EventRecord } from './event-store';
import type { ContributionEnv } from './event-workflow';
import { escapeHtml } from './format';

const PAGE_SIZE = 3;
const UNAVAILABLE = 'ما قدرت أجيب التبليغات المعتمدة هسه. جرّب بعد شوي؛ ما أگدر أجزم شعدنا بدونها.';

function resultId(scope: string, seed: string): string {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `academic-${scope}-${hash.toString(16).padStart(8, '0')}`;
}

function article(id: string, title: string, text: string, description: string): Record<string, unknown> {
  if (text.length > 4096) throw new RangeError('Inline article exceeds Telegram message limit.');
  return { type: 'article', id, title, description,
    input_message_content: { message_text: text, parse_mode: 'HTML' } };
}

function metadata(event: EventRecord): string {
  const draft = event.draft;
  const kind = draft.kind ? EVENT_KIND_LABELS[draft.kind] : 'تبليغ';
  const course = draft.course ? COURSE_LABELS[draft.course] : 'المادة تحتاج تحديد';
  const audience = draft.audience === 'all' ? 'للمجموعتين A وB' : draft.audience ? `مجموعة ${draft.audience}` : 'المجموعة تحتاج تحديد';
  return `${kind} ${course} — ${draft.date ?? 'الموعد غير محدد'} · ${audience}`;
}

/** Escape complete characters, keeping every detail across continuation articles. */
function detailChunks(details: string, budget: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of details) {
    const escaped = escapeHtml(character);
    if (chunk.length + escaped.length > budget) { chunks.push(chunk); chunk = ''; }
    chunk += escaped;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

function eventArticles(event: EventRecord): Record<string, unknown>[] {
  const title = metadata(event);
  const formatted = formatEvent(event.draft, event.authorName, 'approved');
  // Normal submissions are bounded before saving. Preserve legacy oversized
  // notes too: formatEvent's clipped preview must never hide a final exclusion.
  if (!event.draft.details || formatted.endsWith(escapeHtml(event.draft.details))) {
    return [article(resultId('note', `${event.id}:${event.revision}:0`), title, formatted, 'التبليغ المعتمد وتفاصيل المطلوب كاملة.')];
  }
  const header = formatEvent({ ...event.draft, details: '' }, event.authorName, 'approved');
  const prefix = `${header}\n\n📝 <b>المطلوب حسب التبليغ:</b>\n`;
  const chunks = detailChunks(event.draft.details, 4096 - prefix.length - 80);
  return chunks.map((chunk, index) => article(resultId('note', `${event.id}:${event.revision}:${index}`),
    `${title} · التفاصيل ${index + 1}/${chunks.length}`,
    `${prefix}${chunk}\n\n📄 تفاصيل التبليغ ${index + 1}/${chunks.length}`,
    'جزء من النص الأصلي الكامل؛ راجع جميع أجزاء التبليغ.'));
}

function attachmentResult(event: EventRecord): Record<string, unknown> | null {
  const media = event.draft.attachment;
  if (!media) return null;
  // Captions intentionally contain metadata; the separate article retains the
  // complete required reading, exceptions and original student wording.
  const caption = `📎 ${escapeHtml(metadata(event))}\nمرفق التبليغ المعتمد. راجع تفاصيله الكاملة بنتيجة التبليغ.`;
  if (caption.length > 1024) throw new RangeError('Inline caption exceeds Telegram caption limit.');
  return {
    type: media.kind === 'photo' ? 'photo' : 'document',
    id: resultId('file', `${event.id}:${event.revision}`),
    title: (media.fileName ?? `مرفق ${metadata(event)}`).slice(0, 128),
    description: metadata(event),
    ...(media.kind === 'photo' ? { photo_file_id: media.fileId } : { document_file_id: media.fileId }),
    caption, parse_mode: 'HTML',
  };
}

function overviewResults(seed: string, schedule: string | undefined, notes: string, title: string): Record<string, unknown>[] {
  const combined = [schedule, notes].filter(Boolean).join('\n\n');
  if (combined.length <= 4096) return [article(resultId('overview', seed), title, combined, 'الجدول والتبليغات المعتمدة المطابقة لسؤالك.')];
  // Keep the complete official week if it leaves too little room for notes.
  return [
    ...(schedule ? [article(resultId('schedule', seed), 'جدول المحاضرات الرسمي', schedule, 'الجدول الرسمي الكامل للفترة المطلوبة.')] : []),
    article(resultId('overview', seed), title, notes, 'التبليغات المعتمدة المطابقة لسؤالك.'),
  ];
}

/** Inline academic answers only read approved notes; they cannot open a form. */
export async function getInlineAcademicAnswer(text: string, offset: string, now: Date, env: ContributionEnv): Promise<{
  results: Record<string, unknown>[]; next_offset: string;
  /** Trusted metadata for direct replies; identifiers never enter visible text. */
  references?: { kind: 'legacy'; id: string; revision: number }[];
  /** Complete note text for direct chat, without repeating overview metadata or its timetable. */
  directText?: string;
} | null> {
  const agenda = classifyAgendaQuestion(text, now);
  // A declarative exam announcement in Inline is still a lookup. Submission
  // authorization and interactive forms belong exclusively to message updates.
  if (!agenda && classifyEventAction(text) === null) return null;
  if (offset !== '' && (!/^\d{1,3}$/u.test(offset) || Number(offset) > 200)) return { results: [], next_offset: '' };
  const start = offset === '' ? 0 : Number(offset);
  const query = agenda?.query ?? extractEventQuery(text, now);
  const seed = `${JSON.stringify(query)}:${start}`;
  if (query.clarification) return { results: [article(resultId('clarify', seed), 'وضّح سؤالك', query.clarification, 'حدد الفلتر المطلوب حتى أبحث بدقة.')], next_offset: '', directText: query.clarification };
  const schedule = agenda ? renderAgendaSchedule(agenda, now)?.text : undefined;
  if (!env.DB || env.CONTRIBUTIONS_ENABLED !== 'true') {
    return { results: overviewResults(seed, schedule, UNAVAILABLE, 'التبليغات غير متاحة هسه'), next_offset: '', directText: UNAVAILABLE };
  }
  let events: EventRecord[];
  try {
    events = (await new EventStore(env.DB).listApproved({
      ...(query.kind ? { kind: query.kind } : {}), ...(query.kinds ? { kinds: query.kinds } : {}),
      ...(query.course ? { course: query.course } : {}), ...(query.audience ? { audience: query.audience } : {}),
      ...eventLookupDateBounds(query, now),
    })).filter(event => event.status === 'approved' && event.duplicateOf === null).slice(0, 200);
  } catch {
    return { results: overviewResults(seed, schedule, UNAVAILABLE, 'التبليغات غير متاحة هسه'), next_offset: '', directText: UNAVAILABLE };
  }
  if (start > 0 && start >= events.length) return { results: [], next_offset: '' };
  const page = events.slice(start, start + PAGE_SIZE);
  const period = query.date ? `📅 ${query.date}` : query.dateRange
    ? `📅 من ${query.dateRange.fromDate} إلى ${query.dateRange.toDate}` : '📅 التبليغات القادمة';
  const summary = page.length ? [
    '<b>📌 التبليغات المعتمدة</b>', period,
    `التبليغات ${start + 1}–${start + page.length} من ${events.length}`,
    ...page.map((event, index) => `${start + index + 1}. ${escapeHtml(metadata(event))}`),
    'اختار نتيجة التبليغ حتى ترسل تفاصيل المطلوب كاملة.',
  ].join('\n') : `<b>📌 التبليغات المعتمدة</b>\n${period}\nما عندي تبليغات معتمدة مطابقة لسؤالك.`;
  const results = overviewResults(seed, schedule, summary, 'الجدول والتبليغات المعتمدة');
  const directParts: string[] = [];
  for (const event of page) {
    const details = eventArticles(event);
    results.push(...details);
    directParts.push(...details.map(result => (result.input_message_content as { message_text: string }).message_text));
    const media = attachmentResult(event);
    if (media) results.push(media);
  }
  const next = start + PAGE_SIZE < events.length ? String(start + PAGE_SIZE) : '';
  const directText = page.length ? [period, ...directParts, ...(next ? ['أكو تبليغات إضافية؛ حدد المادة أو اليوم حتى أجيبها.'] : [])].join('\n\n') : summary;
  return { results, next_offset: next, directText, references: page.map(event => ({ kind: 'legacy', id: event.id, revision: event.revision })) };
}
