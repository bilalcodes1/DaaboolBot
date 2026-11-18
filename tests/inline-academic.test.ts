import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInlineAcademicAnswer } from '../src/inline-academic';
import { EventStore, type EventRecord } from '../src/event-store';
import { emptyEventDraft } from '../src/event-types';
import type { ContributionEnv } from '../src/event-workflow';

const NOW = new Date('2026-10-16T09:00:00Z');
const prepare = vi.fn(() => { throw new Error('Unexpected database access.'); });
const DB = { prepare } as unknown as D1Database;
const ENV: ContributionEnv = { DB, CONTRIBUTIONS_ENABLED: 'true' };

function event(id: string, details = 'لحد الليكسل مو داخله <نص> & التفاصيل الأصلية'): EventRecord {
  return {
    id, revision: 2, authorId: 101, authorName: 'علي <طالب>', sourceChatId: 101,
    sourceThreadId: null, sourceMessageId: 7, status: 'approved', submittedAt: NOW.getTime(), approvedAt: NOW.getTime(),
    duplicateOf: null, publishedMessageId: null, publishedChatId: null, publishedThreadId: null, publicationDeletionRevision: null,
    draft: { ...emptyEventDraft(), kind: 'quiz', course: 'compilers', date: '2026-10-19', audience: 'B', details },
  };
}

function text(result: Record<string, unknown>): string {
  return (result.input_message_content as { message_text: string }).message_text;
}

function decodeHtml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

afterEach(() => { vi.restoreAllMocks(); prepare.mockClear(); });

describe('read-only Inline academic answers', () => {
  it('leaves ordinary specific timetable questions to the existing classifier', async () => {
    const lookup = vi.spyOn(EventStore.prototype, 'listApproved');
    for (const query of ['مختبرات الأحد مجموعة B', 'المحاضرة الجاية', 'جدول اليوم', 'منو الدكتور مال المحاضرة الجاية']) {
      expect(await getInlineAcademicAnswer(query, '', NOW, ENV)).toBeNull();
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['امتحان', { kind: 'exam', dateFrom: '2026-10-16' }],
    ['واجب الموبايل باچر', { kind: 'homework', course: 'mobile', date: '2026-10-17' }],
    ['شنو كوز مترجمات مجموعة B', { kind: 'quiz', course: 'compilers', audience: 'B', dateFrom: '2026-10-16' }],
    ['شعدنا امتحانات B', { kind: 'exam', audience: 'B', dateFrom: '2026-10-16' }],
    ['اعرض امتحانات للكل', { kind: 'exam', audience: 'all', dateFrom: '2026-10-16' }],
    ['دزلي ملفات امتحانات وكوزات المترجمات الأسبوع الجاي مجموعة B', {
      kinds: ['exam', 'quiz'], course: 'compilers', audience: 'B', dateFrom: '2026-10-18', dateTo: '2026-10-24',
    }],
    ['شنو لازم اقرا للمترجمات', { course: 'compilers', dateFrom: '2026-10-16' }],
  ])('retains every supported approved-note filter for %s', async (query, filter) => {
    const lookup = vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue([]);
    const answer = await getInlineAcademicAnswer(query, '', NOW, ENV);
    expect(answer).not.toBeNull();
    expect(lookup).toHaveBeenCalledExactlyOnceWith(filter);
    expect(text(answer!.results[0]!)).toContain('ما عندي تبليغات معتمدة مطابقة');
  });

  it('combines the complete official agenda with approved metadata and full note articles', async () => {
    const note = event('approved-1');
    const pending = { ...event('pending-2'), status: 'pending' as const };
    const duplicate = { ...event('duplicate-3'), duplicateOf: 'approved-1' };
    const lookup = vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue([note, pending, duplicate]);
    const answer = await getInlineAcademicAnswer('شعدنا باچر', '', NOW, ENV);
    expect(lookup).toHaveBeenCalledExactlyOnceWith({ date: '2026-10-17' });
    expect(answer!.results).toHaveLength(2);
    const overview = text(answer!.results[0]!);
    expect(overview).toContain('جدول');
    expect(overview).toContain('2026-10-17');
    expect(overview).toContain('التبليغات 1–1 من 1');
    expect(overview).toContain('المترجمات');
    expect(overview).not.toContain('الليكسل');
    const details = text(answer!.results[1]!);
    expect(details).toContain('لحد الليكسل مو داخله &lt;نص&gt; &amp; التفاصيل الأصلية');
    expect(details).toContain('علي &lt;طالب&gt;');
    expect(answer!.next_offset).toBe('');
  });

  it('uses the original cached Telegram attachment IDs and short safe metadata captions', async () => {
    const document = event('doc');
    document.draft.attachment = { kind: 'document', fileId: 'ORIGINAL_document_file_id', fileName: 'واجب<&>.pdf' };
    const photo = event('photo');
    photo.draft.attachment = { kind: 'photo', fileId: 'ORIGINAL_photo_file_id' };
    vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue([document, photo]);
    const answer = await getInlineAcademicAnswer('دزلي ملفات كوز المترجمات', '', NOW, ENV);
    const doc = answer!.results.find(result => result.type === 'document')!;
    const image = answer!.results.find(result => result.type === 'photo')!;
    expect(doc.document_file_id).toBe('ORIGINAL_document_file_id');
    expect(image.photo_file_id).toBe('ORIGINAL_photo_file_id');
    expect(doc).not.toHaveProperty('document_url');
    expect(image).not.toHaveProperty('photo_url');
    for (const media of [doc, image]) {
      expect(media.parse_mode).toBe('HTML');
      expect((media.caption as string).length).toBeLessThanOrEqual(1024);
      expect(media.caption).not.toContain('الليكسل');
      expect(media).not.toHaveProperty('input_message_content');
    }
    expect(answer!.results.filter(result => result.type === 'article')).toHaveLength(3);
  });

  it('clarifies unresolved filters without needing a database or producing unrelated events', async () => {
    const lookup = vi.spyOn(EventStore.prototype, 'listApproved');
    for (const query of ['شنو امتحان الرياضيات', 'شنو امتحان باجر الاثنين', 'شنو كوز مجموعة C']) {
      const answer = await getInlineAcademicAnswer(query, '', NOW, {});
      expect(answer!.results).toHaveLength(1);
      expect(answer!.results[0]!.title).toBe('وضّح سؤالك');
      expect(answer!.next_offset).toBe('');
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('distinguishes unavailable D1 from an empty approved collection and keeps the official schedule', async () => {
    vi.spyOn(EventStore.prototype, 'listApproved').mockRejectedValue(new Error('private-database-marker'));
    const failed = await getInlineAcademicAnswer('شعدنا باچر', '', NOW, ENV);
    const missing = await getInlineAcademicAnswer('شعدنا باچر', '', NOW, {});
    const disabled = await getInlineAcademicAnswer('امتحان', '', NOW, { DB, CONTRIBUTIONS_ENABLED: 'false' });
    for (const answer of [failed, missing, disabled]) {
      const output = answer!.results.map(text).join('\n');
      expect(output).toContain('ما قدرت أجيب التبليغات المعتمدة');
      expect(output).not.toContain('ما عندي تبليغات معتمدة مطابقة');
      expect(output).not.toContain('private-database-marker');
      expect(answer!.next_offset).toBe('');
    }
    expect(failed!.results.map(text).join('\n')).toContain('جدول');
    expect(missing!.results.map(text).join('\n')).toContain('جدول');
  });

  it('paginates three events, with unique bounded IDs and no extra final page', async () => {
    vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue(Array.from({ length: 7 }, (_, index) => event(`note-${index}`)));
    const first = await getInlineAcademicAnswer('امتحانات', '', NOW, ENV);
    const second = await getInlineAcademicAnswer('امتحانات', first!.next_offset, NOW, ENV);
    const final = await getInlineAcademicAnswer('امتحانات', second!.next_offset, NOW, ENV);
    expect(first!.results).toHaveLength(4);
    expect(second!.results).toHaveLength(4);
    expect(final!.results).toHaveLength(2);
    expect(first!.next_offset).toBe('3');
    expect(second!.next_offset).toBe('6');
    expect(final!.next_offset).toBe('');
    expect(text(second!.results[0]!)).toContain('التبليغات 4–6 من 7');
    const ids = [...first!.results, ...second!.results, ...final!.results].map(result => result.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => /^[\x20-\x7e]{1,64}$/u.test(id))).toBe(true);
    expect(await getInlineAcademicAnswer('امتحانات', '200', NOW, ENV)).toEqual({ results: [], next_offset: '' });
  });

  it('keeps a complete official week within safe overview messages alongside page metadata', async () => {
    vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue(Array.from({ length: 200 }, (_, index) => event(`week-${index}`)));
    const answer = await getInlineAcademicAnswer('شعدنا الأسبوع الجاي', '', NOW, ENV);
    expect(answer!.next_offset).toBe('3');
    const combined = answer!.results.filter(result => result.type === 'article').map(text).join('\n');
    expect(combined).toContain('2026-10-18');
    expect(combined).toContain('2026-10-24');
    expect(combined).toContain('التبليغات 1–3 من 200');
    expect(answer!.results.every(result => result.type !== 'article' || text(result).length <= 4096)).toBe(true);
  });

  it.each(['-1', '201', '99999', '1.5', 'not-a-page'])('rejects invalid page offset %s before reading the collection', async offset => {
    const lookup = vi.spyOn(EventStore.prototype, 'listApproved');
    expect(await getInlineAcademicAnswer('امتحان', offset, NOW, ENV)).toEqual({ results: [], next_offset: '' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('preserves all oversized legacy details and final grading exclusions across safe articles', async () => {
    const details = '<&>😀"\''.repeat(1500) + '\nالفصل السادس مو داخله، لا تقرأه.';
    vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue([event('legacy-' + 'ع'.repeat(200), details)]);
    const answer = await getInlineAcademicAnswer('كوز', '', NOW, ENV);
    const articles = answer!.results.slice(1);
    expect(articles.length).toBeGreaterThan(1);
    const restored = articles.map(result => {
      const message = text(result);
      expect(message.length).toBeLessThanOrEqual(4096);
      expect(message).not.toContain('التفاصيل طويلة');
      expect((result.id as string).length).toBeLessThanOrEqual(64);
      return decodeHtml(message.split('📝 <b>المطلوب حسب التبليغ:</b>\n')[1]!
        .replace(/\n\n📄 تفاصيل التبليغ \d+\/\d+$/u, ''));
    }).join('');
    expect(restored).toBe(details);
    expect(text(articles.at(-1)!)).toContain('الفصل السادس مو داخله');
  });
  it('uses upcoming current-week bounds without changing explicit-date, last-week, or next-week lookups', async () => {
    const saturday = new Date('2026-10-24T09:00:00Z');
    const lookup = vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue([]);
    for (const [question, expected] of [
      ['شعدنا هذا الاسبوع امتحانات؟ @daaboolbot', { kind: 'exam', dateFrom: '2026-10-24', dateTo: '2026-10-24' }],
      ['شنو امتحانات الأحد هذا الأسبوع؟', { kind: 'exam', date: '2026-10-18' }],
      ['شعدنا هذا الأسبوع امتحانات حتى اللي صارت؟', { kind: 'exam', dateFrom: '2026-10-18', dateTo: '2026-10-24' }],
      ['شنو امتحانات الأسبوع الماضي؟', { kind: 'exam', dateFrom: '2026-10-11', dateTo: '2026-10-17' }],
      ['شنو امتحانات الأسبوع الجاي؟', { kind: 'exam', dateFrom: '2026-10-25', dateTo: '2026-10-31' }],
    ] as const) {
      lookup.mockClear();
      const answer = await getInlineAcademicAnswer(question, '', saturday, ENV);
      expect(answer!.references).toEqual([]);
      expect(lookup).toHaveBeenCalledExactlyOnceWith(expected);
    }
  });
  it('provides trusted references only for displayed notes and direct text without repeated overview metadata', async () => {
    const notes = Array.from({ length: 5 }, (_, index) => event(`note-${index}`, `مطلوب فريد ${index}`));
    vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue(notes);
    const answer = await getInlineAcademicAnswer('شنو كوز مترجمات', '', NOW, ENV);
    expect(answer!.references).toEqual(notes.slice(0, 3).map(note => ({ kind: 'legacy', id: note.id, revision: note.revision })));
    expect(answer!.directText).not.toContain('التبليغات 1–3');
    expect(answer!.directText).not.toContain('اختار نتيجة');
    for (let index = 0; index < 3; index++) expect(answer!.directText!.match(new RegExp(`مطلوب فريد ${index}`, 'gu'))).toHaveLength(1);
    expect(answer!.directText).not.toContain('note-0');
    expect(answer!.directText).not.toContain('مطلوب فريد 3');
    expect(answer!.directText).toContain('أكو تبليغات إضافية');
    const agenda = await getInlineAcademicAnswer('شعدنا باچر', '', NOW, ENV);
    expect(agenda!.directText).not.toContain('جدول');
  });

  it('never accesses profiles, sessions, update claims or contribution writes', async () => {
    const profile = vi.spyOn(EventStore.prototype, 'getProfile');
    const session = vi.spyOn(EventStore.prototype, 'getSession');
    const saveProfile = vi.spyOn(EventStore.prototype, 'saveProfile');
    const saveSession = vi.spyOn(EventStore.prototype, 'saveSession');
    const create = vi.spyOn(EventStore.prototype, 'createEvent');
    const claim = vi.spyOn(EventStore.prototype, 'claimUpdate');
    vi.spyOn(EventStore.prototype, 'listApproved').mockResolvedValue([event('existing')]);
    await getInlineAcademicAnswer('دعبول عدنا امتحان مترجمات الاثنين الجاي للكل', '', NOW, ENV);
    for (const operation of [profile, session, saveProfile, saveSession, create, claim]) expect(operation).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
