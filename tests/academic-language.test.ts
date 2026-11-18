import{describe,it,expect}from'vitest';
import{academicLookupText,publicationSelectionText}from'../src/academic-language';
import{extractEventQuery}from'../src/event-extract';
const now=new Date('2026-10-29T03:38:00+03:00');
describe('read-only academic syntax normalization',()=>{
 it('retains dates, explicit groups and unknown course names',()=>{
  const text=academicLookupText('هسه شوفني امتحانات شبكات 2026-11-05 مجموعة B');
  expect(text).toContain('2026-11-05');expect(extractEventQuery(text,now)).toMatchObject({course:'networks',date:'2026-11-05',audience:'B'});
  expect(extractEventQuery(publicationSelectionText('بلغ الطلاب بكل الامتحانات لمادة مجهولة هسه بالقناه'),now).clarification).toBeTruthy();
 });
 it.each(['بلغ الكل','بلغ الجميع','انشر الكل'])('keeps recipient wording separate from an explicit group filter: %s',text=>{
  expect(extractEventQuery(publicationSelectionText(text),now).audience).toBeNull();
  expect(extractEventQuery(publicationSelectionText(text+' كوز شبكات مجموعة B'),now).audience).toBe('B');
 });
 it('separates all records from recipients and preserves a genuine group selector',()=>{
  expect(extractEventQuery(publicationSelectionText('بلغ الطلاب بكل الامتحانات والكوزات هسه بالقناه'),now)).toEqual({kind:null,course:null,date:null,audience:null,kinds:['exam','quiz']});
  expect(extractEventQuery(publicationSelectionText('بلغ الطلاب بكل الامتحانات للمجموعة B هسه بالقناه'),now).audience).toBe('B');
 });
});
