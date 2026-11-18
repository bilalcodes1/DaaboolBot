import {afterEach,describe,it,expect} from 'vitest';
import {productHarness} from './helpers/product';
import {queueManualPublication,setManualConfig,cancelManualPublication,saveManualReminder,changeManualReminderState,queueManualReminders} from '../src/manual-delivery';
import {saveManualAnnouncement} from '../src/manual-academic';
import {reconcileControlledAttempt,dispatchControlledJobs as dispatchActual,queueControlledJob} from '../src/controlled-scheduler';
import {PRODUCT_HANDLERS,runProductCron} from '../src/product-jobs';
import {EventStore} from '../src/event-store';
const dispatchControlledJobs:typeof dispatchActual=(db,tg,now,handlers,options={})=>dispatchActual(db,tg,now,handlers,{...options,clock:options.clock??(()=>now)});
const opened:ReturnType<typeof productHarness>[]=[];const setup=()=>{const h=productHarness();opened.push(h);return h;};afterEach(()=>{for(const h of opened.splice(0))h.close();});
const scope={userId:9001,chatId:9001,threadId:null};
async function announcement(h:ReturnType<typeof setup>){await h.enable();await setManualConfig(h.db,scope,100,h.getNow(),'academic_publications',1,true);const r=await saveManualAnnouncement(h.db,scope,101,h.getNow(),{kind:'exam',course:'networks',date:'2026-11-09',time:null,audience:null,details:'',coverage:''});return {kind:'academic' as const,id:r.id!,revision:r.revision!};}
describe('operational recovery without fabricated success',()=>{
 it('reschedules a cancelled publication while concurrent identical queue requests remain one job',async()=>{
  const h=setup(),ref=await announcement(h);const first=await queueManualPublication(h.db,scope,102,h.getNow(),ref,h.getNow()+60000);expect(first.ok).toBe(true);await cancelManualPublication(h.db,scope,103,h.getNow(),first.id!);
  const results=await Promise.all([queueManualPublication(h.db,scope,104,h.getNow(),ref,h.getNow()+120000),queueManualPublication(h.db,scope,105,h.getNow(),ref,h.getNow()+120000)]);expect(results.every(r=>r.ok)).toBe(true);expect(h.sqlite.prepare("SELECT COUNT(*) n FROM outbox WHERE state='pending'").get()?.n).toBe(1);
 });
 it('requires admin and real message evidence for manual reconciliation; repairs receipt without a second Telegram call',async()=>{
  const h=setup(),ref=await announcement(h);await queueManualPublication(h.db,scope,102,h.getNow(),ref,h.getNow());h.faults.set('sendMessage',[0]);await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);const attempt=String(h.sqlite.prepare('SELECT id FROM controlled_attempts').get()?.id);
  expect((await queueManualPublication(h.db,scope,103,h.getNow(),ref,h.getNow())).ok).toBe(false);
  await expect(reconcileControlledAttempt(h.db,{userId:9002,chatId:9002,threadId:null},attempt,'confirmed','شاهدت الرسالة بالقناة',{message_id:55},h.getNow())).rejects.toThrow('FORBIDDEN');
  expect(await reconcileControlledAttempt(h.db,scope,attempt,'confirmed','شاهدت الرسالة بالقناة',null,h.getNow())).toBe(false);
  expect(await reconcileControlledAttempt(h.db,scope,attempt,'confirmed','شاهدت الرسالة بالقناة ورقمها 55',{message_id:55},h.getNow())).toBe(true);
  await dispatchControlledJobs(h.db,h.telegram,h.getNow()+1000,PRODUCT_HANDLERS);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);expect(h.sqlite.prepare('SELECT message_id FROM publication_receipts').get()?.message_id).toBe(55);
 });
 it('honors disabled reminders, time edits, cancelled reminders, and explicit known failed retry',async()=>{
  const h=setup();await h.enable();await setManualConfig(h.db,scope,1,h.getNow(),'academic_reminders',1,true);const due=h.getNow()+60000;
  const r=await saveManualReminder(h.db,scope,2,h.getNow(),{enabled:false,text:'تذكير تجريبي',dueAt:due,chatId:-100777,threadId:null});expect(await queueManualReminders(h.db,h.getNow())).toBe(0);
  await changeManualReminderState(h.db,scope,3,h.getNow(),{id:r.id!,revision:1},'enable');expect(await queueManualReminders(h.db,h.getNow())).toBe(1);
  await saveManualReminder(h.db,scope,4,h.getNow(),{enabled:true,text:'تذكير تجريبي',dueAt:due+60000,chatId:-100777,threadId:null},{id:r.id!,revision:2});await dispatchControlledJobs(h.db,h.telegram,due,PRODUCT_HANDLERS);expect(h.calls).toHaveLength(0);await queueManualReminders(h.db,h.getNow());await dispatchControlledJobs(h.db,h.telegram,due+60000,PRODUCT_HANDLERS);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
 });
 it('supports all reminder fields and confirmation through the integrated buttons',async()=>{
  const h=setup();await h.text(9001,'🔔 التذكيرات');await h.click(9001,'إضافة تذكير');await h.answer(9001,'موعد تحضير تجريبي');await h.answer(9001,'2026-11-09 15:00');await h.click(9001,'استخدام الوجهة المرتبطة');expect(h.sqlite.prepare('SELECT COUNT(*) n FROM manual_reminders').get()?.n).toBe(0);await h.click(9001,'تأكيد الحفظ');expect(h.sqlite.prepare('SELECT enabled FROM manual_reminders').get()?.enabled).toBe(0);
  await h.text(9001,'🔔 التذكيرات');const label=h.latest().reply_markup.inline_keyboard.flat().find((b:any)=>b.text.includes('موعد تحضير')).text;await h.click(9001,label);await h.click(9001,'التاريخ والوقت');await h.answer(9001,'2026-11-09 16:00');await h.click(9001,'تأكيد الحفظ');expect(h.sqlite.prepare('SELECT due_at FROM manual_reminders').get()?.due_at).toBe(Date.parse('2026-11-09T16:00:00+03:00'));
 });
 it('rechecks the prayer delivery window with the actual dispatch time',async()=>{
  const h=setup();await h.enable();const before=h.getNow();
  await queueControlledJob(h.db,{id:'controlled:late',type:'controlled_window_test',payload:{},dueAt:before,chatId:-100777,threadId:null,family:'prayer',expiresAt:before+2000,executionWindow:{start:before-59000,end:before+1000}},before);
  const result=await dispatchControlledJobs(h.db,h.telegram,before,[{types:['controlled_window_test'],async resolve(){
   return {chatId:-100777,method:'sendMessage',payload:{chat_id:-100777,text:'تذكير تجريبي'}};
  }}],{clock:()=>before+1001});
  expect(result.cancelled).toBe(1);expect(h.calls).toHaveLength(0);
 });
 it('previews escaped long fields in safe pages and bounds publication without broken HTML',async()=>{
  const h=setup();await h.enable();await setManualConfig(h.db,scope,1,h.getNow(),'academic_publications',1,true);
  const r=await saveManualAnnouncement(h.db,scope,2,h.getNow(),{kind:'note',course:null,date:null,time:null,audience:null,details:'<&>'.repeat(800),coverage:''});
  expect(r.ok).toBe(true);await queueManualPublication(h.db,scope,3,h.getNow(),{kind:'academic',id:r.id!,revision:1},h.getNow());await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);
  const text=h.calls.find(c=>c.method==='sendMessage'&&c.payload.chat_id===-100777)?.payload.text;expect(text.length).toBeLessThan(4096);expect(text).toContain('التفاصيل الكاملة');expect(text).not.toMatch(/&(?:a|am|l|g|qu)$/u);
 });
 it('measures actual local button and single-delivery query counts under the 50-query execution cap',async()=>{
  const h=setup(),ref=await announcement(h);h.resetQueryCount();const start=performance.now();await h.text(9001,'📢 التبليغات');const ms=performance.now()-start;const button=h.queryCount();expect(button).toBeLessThanOrEqual(50);
  await queueManualPublication(h.db,scope,102,h.getNow(),ref,h.getNow());h.resetQueryCount();await runProductCron(h.env,h.telegram,h.getNow(),h.fetcher);const delivery=h.queryCount();expect(delivery).toBeLessThanOrEqual(50);console.info('product_local_metrics',JSON.stringify({buttonQueries:button,buttonMs:ms,deliveryQueries:delivery,mockedExternalTransport:true}));
 });
});
