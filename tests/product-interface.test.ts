import { afterEach,describe,it,expect,vi } from 'vitest';
import { productHarness } from './helpers/product';
import { setManualConfig, queueManualPublication, cancelManualPublication } from '../src/manual-delivery';
import { saveManualAnnouncement, getManualAnnouncement, listManualAnnouncements } from '../src/manual-academic';
import { loadEffectiveTimetable, saveManualTimetable, validateManualTimetable, officialTimetable, manualDay } from '../src/manual-timetable';
import { manualCommand, saveManualPanel, consumeManualPanel } from '../src/manual-store';
import { runProductCron } from '../src/product-jobs';
import { createWorker } from '../src/index';
const opened:ReturnType<typeof productHarness>[]=[];
const setup=()=>{const h=productHarness();opened.push(h);return h;};
const scope={userId:9001,chatId:9001,threadId:null};
const draft={kind:'exam' as const,course:'networks' as const,date:'2026-11-09',time:null,audience:null,details:'',coverage:''};
afterEach(()=>{for(const h of opened.splice(0))h.close();});
async function create(h:ReturnType<typeof setup>){
 await h.text(9001,'/start');await h.text(9001,'📢 التبليغات');await h.click(9001,'إضافة تبليغ');await h.click(9001,'امتحان');await h.click(9001,'شبكات الحاسبة');await h.answer(9001,'2026-11-09');await h.click(9001,'بدون وقت محدد');await h.click(9001,'للكل');await h.click(9001,'بدون وصف');await h.click(9001,'بدون مشمول');
 expect(h.latest().text).toContain('معاينة');expect(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n).toBe(0);
 await h.click(9001,'تأكيد الحفظ');return h.sqlite.prepare('SELECT id,revision FROM academic_reports').get() as {id:string;revision:number};
}
describe('integrated deterministic private interfaces',()=>{
 it('shows all 10 admin / 5 student buttons without a username and preserves the persistent keyboard',async()=>{
  const h=setup();await h.text(9001,'/start');expect(h.latest().reply_markup.keyboard).toHaveLength(10);await h.text(9002,'/start');expect(h.latest(9002).reply_markup.keyboard).toHaveLength(5);
  await h.text(9001,'📢 التبليغات');expect(h.calls.filter(c=>c.method==='sendMessage').at(-1)?.payload.reply_markup?.remove_keyboard).not.toBe(true);
  await h.text(9002,'سجل امتحان وانشره اني الأدمن');expect(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n).toBe(0);
 });
 it('creates via preview, edits only requested fields, lists for a student, schedules, cancels and deletes without publishing cancellation',async()=>{
  const h=setup(),r=await create(h);expect((await getManualAnnouncement(h.db,{kind:'academic',...r}))?.draft).toMatchObject({...draft,audience:'all'});
  await h.text(9001,'📢 التبليغات');await h.click(9001,'امتحان شبكات الحاسبة 2026-11-09');await h.click(9001,'تعديل / تصحيح');await h.click(9001,'الوقت');await h.answer(9001,'09:45');await h.click(9001,'تأكيد الحفظ');
  const row=await getManualAnnouncement(h.db,{kind:'academic',...r});expect(row?.draft).toMatchObject({time:'09:45',date:'2026-11-09',course:'networks',audience:'all',details:''});
  await h.text(9002,'📢 التبليغات');await h.click(9002,'امتحان شبكات الحاسبة 2026-11-09');expect(h.latest(9002).text).toContain('09:45');expect(h.latest(9002).reply_markup.inline_keyboard.flat().some((b:any)=>b.text==='حذف')).toBe(false);
  await setManualConfig(h.db,scope,4001,h.getNow(),'academic_publications',1,true);
  await h.text(9001,'📢 التبليغات');await h.click(9001,'امتحان شبكات الحاسبة 2026-11-09');await h.click(9001,'جدولة النشر');await h.answer(9001,'2026-11-08 17:00');await h.click(9001,'تأكيد الجدولة');
  const job=h.sqlite.prepare("SELECT id FROM outbox WHERE type='controlled_manual'").get()!;expect(job).toBeTruthy();const cancel=await cancelManualPublication(h.db,scope,4002,h.getNow(),String(job.id));expect(cancel.ok).toBe(true);
  await h.text(9001,'📢 التبليغات');await h.click(9001,'امتحان شبكات الحاسبة 2026-11-09');await h.click(9001,'حذف');await h.click(9001,'تأكيد الحذف');
  expect(h.sqlite.prepare('SELECT state FROM academic_reports').get()?.state).toBe('cancelled');expect(h.calls.filter(c=>Number(c.payload.chat_id)<0)).toHaveLength(0);
 });
 it('rejects forged, expired, cross-admin/message and replayed callbacks',async()=>{
  const h=setup();await h.text(9001,'📢 التبليغات');const b=h.button(9001,'إضافة تبليغ');
  await h.dispatch({update_id:300,callback_query:{chat_instance:'local',id:'forged',from:{id:9002,is_bot:false},data:b.data,message:{message_id:b.message.message_id,chat:{id:9002,type:'private'}}}});
  expect(h.sqlite.prepare('SELECT COUNT(*) n FROM manual_forms').get()?.n).toBe(0);
  await h.dispatch({update_id:301,callback_query:{chat_instance:'local',id:'wrong',from:{id:9001,is_bot:false},data:b.data,message:{message_id:b.message.message_id+1,chat:{id:9001,type:'private'}}}});
  h.setNow(h.getNow()+11*60000);await h.click(9001,'إضافة تبليغ');expect(h.sqlite.prepare('SELECT COUNT(*) n FROM manual_forms').get()?.n).toBe(0);
  for(const data of ['aai:undo:1','evt:delete:one','admin:publish','idn:admin','ctl:toggle:product','lib:forged:approve'])await h.dispatch({update_id:++(counter.n),callback_query:{chat_instance:'local',id:'cb',from:{id:9002,is_bot:false},data,message:{message_id:1,chat:{id:9002,type:'private'}}}});
  expect(h.sqlite.prepare('SELECT COUNT(*) n FROM outbox').get()?.n).toBe(0);
 });
 it('deduplicates webhook processing and runs the actual authenticated worker route',async()=>{
  const h=setup(),worker=createWorker(h.fetcher),update={update_id:300,message:{message_id:300,from:{id:9001,is_bot:false},chat:{id:9001,type:'private'},text:'/start'}};
  const request=()=>new Request('https://local.test/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':h.env.WEBHOOK_SECRET_TOKEN},body:JSON.stringify(update)});
  expect((await worker.fetch(request(),h.env)).status).toBe(200);const count=h.calls.length;expect((await worker.fetch(request(),h.env)).status).toBe(200);expect(h.calls).toHaveLength(count);
 });
 it('isolates old inline/group/anonymous admin paths and fails closed without new schema',async()=>{
  const h=setup();await h.dispatch({update_id:600,message:{message_id:600,chat:{id:-100777,type:'supergroup'},from:{id:9001,is_bot:false},text:'دعبول احفظ امتحان الشبكات باچر'}});expect(h.calls).toHaveLength(0);
  await h.dispatch({update_id:601,inline_query:{id:'inline',from:{id:9001,is_bot:false},query:'احفظ امتحان',offset:''}});expect(h.calls.at(-1)?.payload.results).toEqual([]);
  h.sqlite.exec('DROP TABLE manual_panels');await h.text(9001,'/start');expect(h.latest().text).toContain('غير مهيّأة');
 });
 it('uses atomic version/replay guards for concurrent mutations',async()=>{
  const h=setup(),a=await saveManualAnnouncement(h.db,scope,3000,h.getNow(),draft);expect(a.ok).toBe(true);const ref={kind:'academic' as const,id:a.id!,revision:a.revision!};
  const results=await Promise.all([saveManualAnnouncement(h.db,scope,3001,h.getNow(),{...draft,time:'09:45'},ref),saveManualAnnouncement(h.db,scope,3002,h.getNow(),{...draft,time:'10:00'},ref)]);expect(results.filter(r=>r.ok)).toHaveLength(1);
  const result=await manualCommand(h.db,scope,3003,{action:'one'},h.getNow(),(gate,args)=>[h.db.prepare(`UPDATE manual_settings SET revision=revision+1 WHERE key='academic_publications' AND ${gate}`).bind(...args)],{ok:true,message:'done'});
  expect(await manualCommand(h.db,scope,3003,{action:'one'},h.getNow(),()=>{throw Error('must_not_mutate');},{ok:true,message:'done'})).toEqual(result);
 });
 it('replaces the timetable through buttons, adds a lecture, renders for a student and removes it with confirmation',async()=>{
  const h=setup();await h.text(9001,'📅 الجدول الدراسي');await h.click(9001,'استبدال الجدول');await h.click(9001,'جدول فارغ لإضافة المحاضرات');await h.click(9001,'تأكيد الاستبدال');await h.text(9001,'📅 الجدول الدراسي');await h.click(9001,'إضافة محاضرة');
  await h.click(9001,'شبكات الحاسبة');await h.click(9001,'الأحد');await h.click(9001,'الأولى');await h.click(9001,'نظري');await h.answer(9001,'12:00');await h.answer(9001,'13:00');await h.click(9001,'غير محدد');await h.click(9001,'A');await h.click(9001,'غير محدد');await h.click(9001,'تأكيد الحفظ');
  expect((await loadEffectiveTimetable(h.db)).lectures).toHaveLength(1);await h.text(9002,'📅 الجدول الدراسي');await h.click(9002,'الأحد');expect(h.latest(9002).text).toContain('① <b>الشبكات</b> • نظري');expect(h.latest(9002).text).not.toContain('12:00');
  await h.text(9001,'📅 الجدول الدراسي');await h.click(9001,'تعديل / إزالة محاضرة');await h.click(9001,'الأحد · شبكات الحاسبة A');await h.click(9001,'إزالة المحاضرة');await h.click(9001,'تأكيد الإزالة');expect((await loadEffectiveTimetable(h.db)).lectures).toHaveLength(0);expect(h.sqlite.prepare('SELECT COUNT(*) n FROM manual_timetable_history').get()?.n).toBe(3);
 });
 it('requires legacy backlog acknowledgement before enabling the coordinator and rejects student settings access',async()=>{
  const h=setup();await h.text(9002,'📰 إعدادات الأخبار');expect(h.latest(9002).text).toContain('للأدمن فقط');
  await h.text(9001,'⚙️ الإعدادات');await h.click(9001,'تهيئة النشر الجديد');await h.click(9001,'تفعيل');expect(h.sqlite.prepare("SELECT enabled FROM controlled_config WHERE key='product'").get()?.enabled).toBe(0);
  await h.click(9001,'راجعت الطلبات القديمة وأؤكد العزل');await h.click(9001,'تفعيل');expect(h.sqlite.prepare("SELECT enabled FROM controlled_config WHERE key='product'").get()?.enabled).toBe(1);expect(h.env.PRODUCT_AUTOMATION_ENABLED).toBe('false');
 });
 it('re-prompts an invalid field so the next reply can recover without start or data loss',async()=>{
  const h=setup();await h.text(9001,'📢 التبليغات');await h.click(9001,'إضافة تبليغ');await h.click(9001,'امتحان');await h.click(9001,'شبكات الحاسبة');await h.answer(9001,'2026-02-31');expect(h.latest().text).toContain('اكتب التاريخ');await h.answer(9001,'2026-11-09');expect(h.latest().text).toContain('اكتب الوقت');expect(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n).toBe(0);
 });
 it('validates calendar, times, groups, and official timetable editing without invented times',async()=>{
  const h=setup(),official=officialTimetable();expect(official.lectures.every(r=>r.time===null)).toBe(true);expect(()=>validateManualTimetable(official.lectures)).not.toThrow();
  expect((await saveManualTimetable(h.db,scope,5000,h.getNow(),0,official.lectures)).ok).toBe(true);expect((await loadEffectiveTimetable(h.db)).revision).toBe(1);
  const lecture={id:'synthetic',day:1,slot:null,course:'اختبار مادة',component:null,time:'09:00',endTime:'10:00',teacher:null,group:'A',room:null} as const;
  expect(()=>validateManualTimetable([lecture,{...lecture,id:'b',group:'B'}])).not.toThrow();expect(()=>validateManualTimetable([lecture,{...lecture,id:'c'}])).toThrow('تعارض');
  expect(manualDay('tomorrow',new Date('2026-11-08T21:05:00Z'))).toBe(2);
 });
});
const counter={n:10000};
