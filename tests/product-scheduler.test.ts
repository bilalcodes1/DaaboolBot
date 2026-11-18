import { afterEach,describe,it,expect } from 'vitest';
import { productHarness } from './helpers/product';
import { queueControlledJob,dispatchControlledJobs as dispatchActual,type ControlledHandler } from '../src/controlled-scheduler';
import { PRODUCT_HANDLERS,queueProductAcademic,runProductCron } from '../src/product-jobs';
import { queueManualPublication,setManualConfig,cancelManualPublication } from '../src/manual-delivery';
import { saveManualAnnouncement,deleteManualAnnouncement } from '../src/manual-academic';
import { officialTimetable, saveManualTimetable } from '../src/manual-timetable';
import { EventStore } from '../src/event-store';
const dispatchControlledJobs:typeof dispatchActual=(db,tg,now,handlers,options={})=>dispatchActual(db,tg,now,handlers,{...options,clock:options.clock??(()=>now)});
const opened:ReturnType<typeof productHarness>[]=[];
const setup=()=>{const h=productHarness();opened.push(h);return h;};
afterEach(()=>{for(const h of opened.splice(0))h.close();});
const scope={userId:9001,chatId:9001,threadId:null};
const handler:ControlledHandler={types:['controlled_test'],async resolve(_db,job){return {chatId:-100777,method:'sendMessage',payload:{chat_id:-100777,text:job.id}};}};
const at=(date:string,time:string)=>Date.parse(`${date}T${time}:00+03:00`);
async function queued(h:ReturnType<typeof setup>,id='controlled:test:1',family:'official'|'academic'|'news'='official',due=h.getNow()){
 await queueControlledJob(h.db,{id,type:'controlled_test',payload:{},dueAt:due,chatId:-100777,threadId:null,family,expiresAt:due+30*60000},h.getNow());return id;
}
describe('single controlled outbox, leases and evidence',()=>{
 it('keeps defaults off and never drains legacy jobs in product mode',async()=>{
  const h=setup();await h.db.prepare("INSERT INTO outbox(id,type,payload_json,due_at) VALUES('legacy','event_publish','{}',0)").run();await queued(h);
  await runProductCron(h.env,h.telegram,h.getNow(),h.fetcher);expect(h.calls).toHaveLength(0);expect((await new EventStore(h.db).getJob('legacy'))?.state).toBe('pending');
  await h.enable();await dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler]);expect((await new EventStore(h.db).getJob('legacy'))?.state).toBe('pending');
 });
 it('sends a job once under concurrent cron and after restart',async()=>{
  const h=setup();await h.enable();const id=await queued(h);
  await Promise.all([dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler]),dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler])]);
  await dispatchControlledJobs(h.db,h.telegram,h.getNow()+180000,[handler]);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);expect((await new EventStore(h.db).getJob(id))?.state).toBe('sent');expect(h.sqlite.prepare('SELECT COUNT(*) n FROM controlled_deliveries').get()?.n).toBe(1);
 });
 it('quarantines a network timeout and never resends an unknown outcome',async()=>{
  const h=setup();await h.enable();const id=await queued(h);h.faults.set('sendMessage',[0]);expect((await dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler])).unknown).toBe(1);
  await dispatchControlledJobs(h.db,h.telegram,h.getNow()+180000,[handler]);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);expect((await new EventStore(h.db).getJob(id))?.lastError).toBe('delivery_outcome_unknown');
 });
 it('treats a recent unknown delivery as a possible message for collision prevention',async()=>{
  const h=setup();await h.enable();await queued(h);h.faults.set('sendMessage',[0]);await dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler]);
  const later=h.getNow()+2*60000;
  await queueControlledJob(h.db,{id:'controlled:possible-collision',type:'controlled_test',payload:{},chatId:-100777,threadId:null,dueAt:later,expiresAt:later+60000,family:'news'},h.getNow());
  await dispatchControlledJobs(h.db,h.telegram,later,[handler]);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);expect((await new EventStore(h.db).getJob('controlled:possible-collision'))?.state).toBe('cancelled');
 });
 it('recovers a crashed in-flight request as unknown; confirmed callbacks recover without sending again',async()=>{
  const h=setup();await h.enable();const id=await queued(h);const [job]=await new EventStore(h.db).claimJobs(h.getNow(),1,1000,undefined,[id]);
  await h.db.prepare("INSERT INTO controlled_attempts(id,job_id,lease_token,state,started_at,outgoing_json) VALUES('crashed',?,?,'requesting',?,'{}')").bind(id,job!.leaseToken,h.getNow()).run();
  await dispatchControlledJobs(h.db,h.telegram,h.getNow()+2000,[handler]);expect(h.calls).toHaveLength(0);expect(h.sqlite.prepare("SELECT state FROM controlled_attempts WHERE id='crashed'").get()?.state).toBe('unknown');
  const id2=await queued(h,'controlled:test:2');let callbacks=0;const callbackHandler={...handler,delivered:async()=>{callbacks++;if(callbacks===1)throw Error('crash after Telegram receipt');}};
  await expect(dispatchControlledJobs(h.db,h.telegram,h.getNow(),[callbackHandler])).rejects.toThrow('crash after');expect((await new EventStore(h.db).getJob(id2))?.state).toBe('sent');
  await dispatchControlledJobs(h.db,h.telegram,h.getNow()+2000,[callbackHandler]);expect(callbacks).toBe(2);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
 });
 it('only retries a definite 429, stops 403 and respects expiry',async()=>{
  const h=setup();await h.enable();const id=await queued(h);h.faults.set('sendMessage',[429]);expect((await dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler])).retried).toBe(1);await dispatchControlledJobs(h.db,h.telegram,h.getNow()+2000,[handler]);expect((await new EventStore(h.db).getJob(id))?.state).toBe('sent');
  const id2=await queued(h,'controlled:test:2','official',h.getNow()+31*60000);h.faults.set('sendMessage',[403]);expect((await dispatchControlledJobs(h.db,h.telegram,h.getNow()+31*60000,[handler])).failed).toBe(1);expect((await new EventStore(h.db).getJob(id2))?.lastError).toBe('telegram_403');
  const id3=await queued(h,'controlled:test:3');await dispatchControlledJobs(h.db,h.telegram,h.getNow()+93*60000,[handler]);expect((await new EventStore(h.db).getJob(id3))?.state).toBe('cancelled');
 });
 it('prioritizes official over news, avoids collisions and rejects a destination changed before send',async()=>{
  const h=setup();await h.enable();await queued(h,'controlled:news','news');await queued(h,'controlled:official','official');await dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler]);expect(h.calls.find(c=>c.method==='sendMessage')?.payload.text).toBe('controlled:official');expect((await new EventStore(h.db).getJob('controlled:news'))?.state).toBe('cancelled');
  await new EventStore(h.db).saveSettings({targetChatId:-100888});await dispatchControlledJobs(h.db,h.telegram,h.getNow()+5*60000,[handler]);expect((await new EventStore(h.db).getJob('controlled:news'))?.state).toBe('cancelled');
 });
 it('discards missing metadata, malformed destination and direct unapproved job paths',async()=>{
  const h=setup();await h.enable();await new EventStore(h.db).enqueueJob({id:'controlled:untrusted',type:'controlled_test',payload:{},dueAt:h.getNow()});await dispatchControlledJobs(h.db,h.telegram,h.getNow(),[handler]);expect(h.calls).toHaveLength(0);
  await expect(queueControlledJob(h.db,{id:'controlled:private',type:'controlled_test',payload:{},dueAt:h.getNow(),chatId:9002,threadId:null,family:'official',expiresAt:h.getNow()+1000})).rejects.toThrow('Invalid');
 });
});
describe('academic timing and delivery state',()=>{
 it('posts the clean timetable without lecture times, teacher names or room numbers', async () => {
  const h = setup(), now = at('2026-11-09', '16:00');
  h.setNow(now);
  await h.enable();
  await setManualConfig(h.db, scope, 1, now, 'academic_reminders', 1, true);
  const lectures = officialTimetable().lectures.filter(row => row.day === 2);
  lectures[0]!.time = '08:30';
  expect((await saveManualTimetable(h.db, scope, 2, now, 0, lectures)).ok).toBe(true);
  await runProductCron(h.env, h.telegram, now, h.fetcher);
  const sent = h.calls.find(call => call.method === 'sendMessage');
  expect(sent?.payload.text).toBe([
    '📅 <b>جدول باچر</b>', '',
    '<b>الثلاثاء | 10 تشرين الثاني</b>', '',
    '━━━━━━━━━━━━━', '',
    '① <b>تطبيقات الموبايل</b> • نظري',
    '',
    '② <b>الشبكات</b> • نظري',
    '',
    '③ <b>المختبرات</b>',
    '🅱️ المرئية',
  ].join('\n'));
 });
it('uses only 16:00 tomorrow timetable and keeps the retired 18:00 digest disabled',async()=>{
  const h=setup();await h.enable();await setManualConfig(h.db,scope,1,h.getNow(),'academic_reminders',1,true);await setManualConfig(h.db,scope,2,h.getNow(),'academic_publications',1,true);
  const r=await saveManualAnnouncement(h.db,scope,3,h.getNow(),{kind:'exam',course:'networks',date:'2026-11-09',time:'09:30',audience:'B',details:'أحضروا الدفتر.',coverage:'المحاضرة الثانية'});const ref={kind:'academic' as const,id:r.id!,revision:1};
  expect(await queueProductAcademic(h.db,at('2026-11-08','08:00'))).toBe(0);expect(await queueProductAcademic(h.db,at('2026-11-08','16:00'))).toBe(1);
  const p=await queueManualPublication(h.db,scope,4,h.getNow(),ref,h.getNow());expect(p.ok).toBe(true);await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);
  expect(h.calls.find(call => call.method === 'sendMessage')?.payload.text).toBe(
    '📣 <b>امتحان · شبكات الحاسبة</b>\nالاثنين 9 تشرين الثاني · 9:30 ص · مجموعة B فقط\nالمطلوب المحاضرة الثانية\nأحضروا الدفتر.',
  );
  expect(h.sqlite.prepare('SELECT COUNT(*) n FROM publication_receipts').get()?.n).toBe(1);
  expect(await queueProductAcademic(h.db,at('2026-11-08','18:00'))).toBe(0);await dispatchControlledJobs(h.db,h.telegram,at('2026-11-08','18:00'),PRODUCT_HANDLERS);
  expect(h.calls.filter(c=>c.method==='sendMessage'&&String(c.payload.text).includes('تبليغات باچر'))).toHaveLength(0);
 });
 it('cancellation never queues a cancellation broadcast and edits invalidate pending revisions',async()=>{
  const h=setup();await h.enable();await setManualConfig(h.db,scope,1,h.getNow(),'academic_publications',1,true);
  const r=await saveManualAnnouncement(h.db,scope,2,h.getNow(),{kind:'quiz',course:'graphics',date:'2026-11-09',time:null,audience:null,details:'',coverage:''});const ref={kind:'academic' as const,id:r.id!,revision:1};await queueManualPublication(h.db,scope,3,h.getNow(),ref,h.getNow());await deleteManualAnnouncement(h.db,scope,4,h.getNow(),ref);await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);expect(h.calls).toHaveLength(0);
 });
});
