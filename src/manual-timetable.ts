import { SCHEDULE, WEEKDAYS, type LectureNumber } from './schedule';
import { COURSE_LABELS } from './event-format';
import { escapeHtml } from './format';
import { addCalendarDays, getBaghdadNow } from './calendar';
import { notificationDate } from './notification-format';
import { isSchoolDate } from './channel-calendar';
import { cleanManualText, manualCommand, parseManualTime, type ManualScope, type ManualCommandResult } from './manual-store';

export interface ManualLecture {
  id: string; day: number; slot: LectureNumber|null; course: string;
  component: 'theory'|'practical'|'exercises'|null; time: string|null; endTime: string|null;
  teacher: string|null; group: 'A'|'B'|'all'|null; room: string|null;
}
export interface EffectiveTimetable { revision: number; source: 'official'|'manual'; lectures: ManualLecture[] }
export function officialTimetable(): EffectiveTimetable {
  return {revision:0,source:'official',lectures:SCHEDULE.flatMap((slots,day)=>slots.flatMap((slot,index)=>slot.sessions.map((session,s)=>({
    id:`official-${day}-${index}-${s}`,day,slot:(index+1) as LectureNumber,course:session.course,
    component:/\(عملي\)\s*$/u.test(session.course)?'practical' as const:session.course.includes('(نظري)')?'theory' as const:session.course.includes('تمارين')?'exercises' as const:'laboratory' in session?'practical' as const:null,
    time:null,endTime:null,teacher:session.teacher??null,group:'group' in session?session.group:null,room:'laboratory' in session?session.laboratory:null,
  }))))};
}
export async function loadEffectiveTimetable(db:D1Database):Promise<EffectiveTimetable> {
  const row=await db.prepare('SELECT revision,body_json FROM manual_timetable WHERE singleton=1').first<{revision:number;body_json:string}>();
  return row?{revision:row.revision,source:'manual',lectures:JSON.parse(row.body_json) as ManualLecture[]}:officialTimetable();
}
const minute=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));
export function validateManualTimetable(lectures:ManualLecture[]):ManualLecture[] {
  if(!Array.isArray(lectures)||lectures.length>80)throw new RangeError('الجدول يتجاوز 80 محاضرة.');
  const ids=new Set<string>();
  const rows=lectures.map(row=>{
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(row.id)||ids.has(row.id)||!Number.isInteger(row.day)||row.day<0||row.day>6
      ||![null,1,2,3,4,5].includes(row.slot)||![null,'A','B','all'].includes(row.group)||![null,'theory','practical','exercises'].includes(row.component))throw new RangeError('حقول المحاضرة غير صالحة.');
    ids.add(row.id);
    const time=row.time===null?null:parseManualTime(row.time),endTime=row.endTime===null?null:parseManualTime(row.endTime);
    if(endTime&&(!time||minute(endTime)<=minute(time)))throw new RangeError('وقت النهاية لازم يكون بعد البداية بنفس اليوم.');
    return {...row,course:cleanManualText(row.course,120),teacher:row.teacher===null?null:cleanManualText(row.teacher,120,false),room:row.room===null?null:cleanManualText(row.room,80,false),time,endTime};
  });
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const a=rows[i]!,b=rows[j]!;
    if(a.day!==b.day||a.group&&b.group&&a.group!=='all'&&b.group!=='all'&&a.group!==b.group)continue;
    const slotCollision=a.slot!==null&&a.slot===b.slot;
    const timeCollision=a.time&&b.time&&(a.endTime&&b.endTime?minute(a.time)<minute(b.endTime)&&minute(b.time)<minute(a.endTime):a.time===b.time);
    if(slotCollision||timeCollision)throw new RangeError(`تعارض محاضرتين لنفس المجموعة يوم ${WEEKDAYS[a.day]}. حدّد المجموعة أو غيّر الموعد.`);
  }
  return rows;
}
export async function saveManualTimetable(db:D1Database,scope:ManualScope,updateId:number,now:number,expectedRevision:number,lectures:ManualLecture[]):Promise<ManualCommandResult> {
  const rows=validateManualTimetable(lectures), revision=expectedRevision+1;
  return manualCommand(db,scope,updateId,{action:'timetable-save',expectedRevision,lectures:rows},now,(gate,args,op)=>[
    db.prepare(`INSERT INTO manual_timetable(singleton,revision,body_json,updated_at,updated_by) SELECT 1,?,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM manual_timetable WHERE singleton=1 AND revision=?)) AND ${gate}
      ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by
      WHERE manual_timetable.revision=? AND ${gate}`)
      .bind(revision,JSON.stringify(rows),now,scope.userId,expectedRevision,expectedRevision,...args,expectedRevision,...args),
    db.prepare(`INSERT OR IGNORE INTO manual_timetable_history(revision,body_json,actor_id,operation_id,changed_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM manual_operations WHERE id=? AND nonce=? AND changed>0)`)
      .bind(revision,JSON.stringify(rows),scope.userId,op,now,...args),
  ],{ok:true,id:'timetable',revision,message:'تم حفظ نسخة جديدة من الجدول؛ النسخ السابقة محفوظة.'});
}
function timetableRows(table: EffectiveTimetable, day?: number, group?: 'A' | 'B'): ManualLecture[] {
  return table.lectures.filter(row=>(day===undefined||row.day===day)&&(!group||row.group===null||row.group==='all'||row.group===group))
    .sort((a,b)=>a.day-b.day||(a.slot??9)-(b.slot??9)||(a.time??'').localeCompare(b.time??''));
}

const MARKERS = ['①', '②', '③', '④', '⑤'];
function shortCourse(course: string, lab = false): string {
  const name = course.replace(/\s*\((نظري|عملي|تمارين)\)\s*$/u, '').trim();
  const names: Record<string,string> = { 'رسومات': 'الرسومات', 'رسومات الحاسبة': 'الرسومات', 'شبكات الحاسبة': 'الشبكات', 'معمارية الحاسبة': 'المعمارية', 'برمجة تطبيقات الموبايل': 'تطبيقات الموبايل' };
  return lab && name === 'البرمجة المرئية' ? 'المرئية' : names[name] ?? name;
}
/** Student/channel renderer. Administration edit previews retain their editable fields separately. */
export function formatTimetableNotification(table: EffectiveTimetable, date: string, title = 'جدول باچر', group?: 'A'|'B'): string | null {
  const rows = timetableRows(table, addCalendarDays(date, 0).weekday, group);
  if (!rows.length) return null;
  const periods: ManualLecture[][] = [];
  for (const row of rows) {
    const last = periods.at(-1);
    // Only merge explicitly simultaneous practical sessions, never two unknown slots.
    if (row.component === 'practical' && last?.every(r => r.component === 'practical')
      && (row.slot !== null && row.slot === last[0]!.slot || row.slot === null && row.time !== null && row.time === last[0]!.time)) last.push(row);
    else periods.push([row]);
  }
  const dateLabel = notificationDate(date).replace(' ', ' | ');
  const sections = periods.map((period, i) => {
    const marker = MARKERS[i] ?? String(i + 1), first = period[0]!;
    if (first.component === 'practical') {
      const names = [...new Set(period.map(row => shortCourse(row.course, true)))];
      const groupLabel = (row: ManualLecture) => row.group === 'A' ? '🅰️' : row.group === 'B' ? '🅱️' : row.group === 'all' ? '🅰️ 🅱️' : '';
      const labs = names.length === 1 ? `${period.map(groupLabel).filter(Boolean).join(' ')} ${escapeHtml(names[0]!)}`.trim()
        : period.map(row => `${groupLabel(row)} ${escapeHtml(shortCourse(row.course, true))}`.trim()).join(' | ');
      return `${marker} <b>المختبرات</b>\n${labs}`;
    }
    const component = first.component === 'theory' ? ' • نظري' : first.component === 'exercises' ? ' • تمارين' : '';
    return `${marker} <b>${escapeHtml(shortCourse(first.course))}</b>${component}`;
  });
  let text = `📅 <b>${escapeHtml(title)}</b>\n\n<b>${escapeHtml(dateLabel)}</b>\n\n━━━━━━━━━━━━━`;
  for (const section of sections) {
    if (text.length + section.length > 3850) return text + '\n\nباقي المحاضرات باختيار اليوم من الجدول.';
    text += '\n\n' + section;
  }
  return text;
}
export async function studentTimetable(db: D1Database, selection: 'today'|'tomorrow'|number|undefined, now: Date, group?: 'A'|'B'): Promise<string> {
  const clock = getBaghdadNow(now), table = await loadEffectiveTimetable(db);
  const days = selection === undefined ? [0,1,2,3,4,5,6] : [selection];
  const blocks: string[] = [];
  for (const day of days) {
    const offset = day === 'today' ? 0 : day === 'tomorrow' ? 1 : (day - clock.weekday + 7) % 7;
    const date = addCalendarDays(clock.date, offset).date;
    const title = day === 'today' ? 'جدول اليوم' : day === 'tomorrow' ? 'جدول باچر' : `جدول ${WEEKDAYS[day]}`;
    const formatted = await isSchoolDate(db, date) ? formatTimetableNotification(table, date, title, group) : null;
    if (formatted && blocks.join('\n\n').length + formatted.length < 3900) blocks.push(formatted);
    else if (days.length === 1) return `📅 <b>${title}</b>\n\nماكو دوام مسجّل بهاليوم.`;
  }
  // Split at Telegram's send layer if necessary; one normal timetable fits under its limit.
  return blocks.join('\n\n') || 'ماكو محاضرات مسجلة.';
}

export function formatManualTimetable(table:EffectiveTimetable, day?:number, group?:'A'|'B'):string {
  const rows = timetableRows(table, day, group);
  let text=`<b>📅 الجدول الدراسي${day!==undefined?` — ${WEEKDAYS[day]}`:''}</b>\n${table.source==='official'?'حسب الجدول الرسمي المخزّن؛ الأوقات غير المحددة تبقى غير محددة.':`النسخة ${table.revision}`}`;
  for(const row of rows){
    const section=`\n\n${day===undefined?`${WEEKDAYS[row.day]} · `:''}${row.slot?`المحاضرة ${row.slot} · `:''}${row.time??'وقت غير محدد'}${row.endTime?`–${row.endTime}`:''}\n${escapeHtml(row.course)}${row.component?` (${({theory:'نظري',practical:'عملي',exercises:'تمارين'})[row.component]})`:''}`+
      `${row.group?` · ${row.group==='all'?'للكل':`مجموعة ${row.group}`}`:''}${row.teacher?`\n${escapeHtml(row.teacher)}`:''}${row.room?` · ${escapeHtml(row.room)}`:''}`;
    if(text.length+section.length>3900){text+='\n\nاختار يوماً لعرض التفاصيل الباقية.';break;}text+=section;
  }
  return text+(rows.length?'':'\nماكو محاضرات مسجلة بهالاختيار.');
}
export function manualDay(selection:'today'|'tomorrow'|number,now:Date):number {
  return typeof selection==='number'?selection:addCalendarDays(getBaghdadNow(now).date,selection==='tomorrow'?1:0).weekday;
}
export const manualCourseChoices=Object.entries(COURSE_LABELS);
