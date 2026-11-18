import { describe, expect, it } from 'vitest';
import { classifyAgendaQuestion, renderAgendaSchedule } from '../src/agenda';
import { extractEvent, extractEventQuery } from '../src/event-extract';

const NOW = new Date('2026-10-15T09:00:00Z'); // Thursday, Baghdad noon.

describe('agenda date and group preservation', () => {
  it.each(['شعدنا B', 'شنو عدنا كروب بي', 'شعندهم B'])('keeps a bare group as an upcoming-note filter: %s', text => {
    expect(classifyAgendaQuestion(text, NOW)).toMatchObject({ scope: 'upcoming', schedule: null, query: { audience: 'B', date: null } });
  });
  it.each(['شعدنا اليوم B', 'شنو عدهم اليوم B', 'شنوعدهماليومB'])('uses the same exact group and day for lectures and notices: %s', text => {
    expect(classifyAgendaQuestion(text, NOW)).toMatchObject({ scope: 'dated', schedule: { group: 'B', day: 'today' }, query: { audience: 'B', date: '2026-10-15' } });
  });
  it.each(['شعدنا باجر هندسة', 'شعدنا هندسة باجر', 'شعدنا باجر فلوس', 'شعدنا اليوم B وC', 'شعدنا C'])('never widens an unknown or conflicting filter: %s', text => {
    expect(classifyAgendaQuestion(text, NOW)).toBeNull();
  });
  it('resolves an unqualified current weekday for read queries without changing submission ambiguity', async () => {
    expect(extractEventQuery('شنو امتحانات الخميس', NOW)).toMatchObject({ date: '2026-10-15' });
    expect(extractEventQuery('شنو امتحانات الخميس', NOW).clarification).toBeUndefined();
    expect((await extractEvent('عدنا امتحان مترجمات الخميس للكل', NOW)).date).toBeNull();
    const agenda = classifyAgendaQuestion('شعدنا الخميس', NOW)!;
    expect(agenda.query.date).toBe('2026-10-15');
    expect(renderAgendaSchedule(agenda, NOW)!.text).toContain('2026-10-15');
  });
  it('keeps next weekday as a whole day rather than selecting the next lecture', () => {
    const agenda = classifyAgendaQuestion('شعدنا الأحد الجاي مجموعة B', NOW)!;
    expect(agenda).toMatchObject({ scope: 'dated', schedule: { intent: 'lookup', day: 'weekday', weekday: 0, group: 'B' }, query: { date: '2026-10-18', audience: 'B' } });
    expect(renderAgendaSchedule(agenda, NOW)!.text.match(/📖/gu)).toHaveLength(3);
  });
});
