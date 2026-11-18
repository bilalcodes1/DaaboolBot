import {afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {productHarness} from './helpers/product';
import {issueStudentChallenge,claimStudentChallenge,consentStudentChallenge,verifyStudentChallenge,minimumVerifiedName,forgetGroupMemory} from '../src/student-identity';
import {validPrayerConfiguration,parsePrayerDay,loadPrayerDay,queueControlledPrayers,prayerApiUrl,configurePrayer,type PrayerConfiguration} from '../src/prayer-times';
import {dispatchControlledJobs as dispatchActual,configureAutomation} from '../src/controlled-scheduler';
import {PRODUCT_HANDLERS,runProductCron} from '../src/product-jobs';
import {cleanupGroupMemory} from '../src/group-chat';
import {saveManualAnnouncement,listManualAnnouncements} from '../src/manual-academic';
const dispatchControlledJobs:typeof dispatchActual=(db,tg,now,handlers,options={})=>dispatchActual(db,tg,now,handlers,{...options,clock:options.clock??(()=>now)});
const opened:ReturnType<typeof productHarness>[]=[];const setup=()=>{const h=productHarness();opened.push(h);return h;};afterEach(()=>{vi.useRealTimers();for(const h of opened.splice(0))h.close();});
const config:PrayerConfiguration={city:'الرمادي',region:'Al-Anbar',country:'Iraq',latitude:33.4258,longitude:43.2992,timezone:'Asia/Baghdad',method:3,school:0,adjustments:{},enabledPrayers:['Fajr','Dhuhr','Asr','Maghrib','Isha'],allowOutsideQuietWindow:false,localVerified:true,verificationDate:'2026-11-08',verificationSource:'جدول محلي تجريبي للاختبار فقط'};
function fixture(date='2026-11-08'){return {code:200,data:{meta:{timezone:'Asia/Baghdad',latitude:33.4258,longitude:43.2992,method:{id:3},school:0},date:{gregorian:{date:date.split('-').reverse().join('-')}},timings:{Fajr:'05:00',Dhuhr:'12:00',Asr:'14:00',Maghrib:'17:00',Isha:'18:30'}}};}
const ramadiTime=(hhmm:string)=>Date.parse(`2026-11-08T${hhmm}:00+03:00`);
function prayerWithAsr(hhmm:string):typeof fetch{
  const data=fixture();data.data.timings.Asr=hhmm;
  return async()=>Response.json(data);
}
const scope={userId:9001,chatId:9001,threadId:null};
describe('consented verified numeric student identity',()=>{
 it('requires trusted actor plus private ownership consent and explicit admin verification; no username authority',async()=>{
  const h=setup(),at=h.getNow();h.sqlite.prepare('INSERT INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('student-a','سيف اسم تجريبي',at,at);
  expect(await issueStudentChallenge(h.db,'student-a',9002,at)).toBeNull();const code=await issueStudentChallenge(h.db,'student-a',9001,at);expect(code).toMatch(/^[a-f0-9]{24}$/);const claimed=await claimStudentChallenge(h.db,code!,9002,at+1);expect(claimed).toBeTruthy();
  expect(await minimumVerifiedName(h.db,9002)).toBeNull();expect(await verifyStudentChallenge(h.db,claimed!.token_hash,9001,at+2)).toBe(false);expect(await consentStudentChallenge(h.db,claimed!.token_hash,9003,true,at+2)).toBe(false);
  expect(await consentStudentChallenge(h.db,claimed!.token_hash,9002,true,at+2)).toBe(true);expect(await verifyStudentChallenge(h.db,claimed!.token_hash,9002,at+3)).toBe(false);expect(await verifyStudentChallenge(h.db,claimed!.token_hash,9001,at+3)).toBe(true);expect(await minimumVerifiedName(h.db,9002)).toBe('سيف');
  await h.dispatch({update_id:88,message:{message_id:88,chat:{id:9002,type:'private'},from:{id:9002,is_bot:false,username:'changed_name'},text:'هويتي'}});expect(h.latest(9002).text).toContain('حسابك موثّق');
  await h.text(9002,'إيقاف استخدام اسمي');expect(await minimumVerifiedName(h.db,9002)).toBeNull();
 });
 it('replacement uses previous numeric account CAS and revoked/expired challenges cannot reassign',async()=>{
  const h=setup(),at=h.getNow();h.sqlite.prepare('INSERT INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('student-a','سيف تجريبي',at,at);
  const first=await claimStudentChallenge(h.db,(await issueStudentChallenge(h.db,'student-a',9001,at))!,9002,at+1);await consentStudentChallenge(h.db,first!.token_hash,9002,true,at+2);await verifyStudentChallenge(h.db,first!.token_hash,9001,at+3);
  const second=await issueStudentChallenge(h.db,'student-a',9001,at+4),third=await issueStudentChallenge(h.db,'student-a',9001,at+5);expect(await claimStudentChallenge(h.db,second!,9003,at+6)).toBeNull();const claimed=await claimStudentChallenge(h.db,third!,9003,at+6);await consentStudentChallenge(h.db,claimed!.token_hash,9003,true,at+7);expect(await verifyStudentChallenge(h.db,claimed!.token_hash,9001,at+8)).toBe(true);expect(await minimumVerifiedName(h.db,9002)).toBeNull();expect(await minimumVerifiedName(h.db,9003)).toBe('سيف');
  const expired=await issueStudentChallenge(h.db,'student-a',9001,at+9);expect(await claimStudentChallenge(h.db,expired!,9004,at+16*60000)).toBeNull();
 });
 it('exposes self-service privacy from the student menu; erases memory without touching academics',async()=>{
  const h=setup();await saveManualAnnouncement(h.db,scope,1,h.getNow(),{kind:'note',course:null,date:null,time:null,audience:null,details:'ملاحظة تجريبية',coverage:''});await h.text(9002,'ℹ️ معلومات القسم');expect(h.latest(9002).reply_markup.keyboard.flat().some((b:any)=>b.text==='هويتي')).toBe(true);await h.text(9002,'انسَ محادثاتي');expect(h.sqlite.prepare('SELECT memory_enabled FROM student_privacy WHERE user_id=9002').get()?.memory_enabled).toBe(0);expect(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n).toBe(1);
 });
 it('denies stale/cross-account identity callbacks and forwarded identity claims',async()=>{
  const h=setup();await h.text(9002,'هويتي');const b=h.button(9002,'انسَ محادثاتي وأوقف الذاكرة');await h.dispatch({update_id:500,callback_query:{id:'forged',chat_instance:'local',from:{id:9003,is_bot:false},data:b.data,message:{message_id:b.message.message_id,chat:{id:9003,type:'private'}}}});expect(h.sqlite.prepare('SELECT COUNT(*) n FROM student_privacy WHERE user_id=9003').get()?.n).toBe(0);
 });
});
describe('dynamic verified prayer schedule, failure and rollover',()=>{
 it('accepts the recorded public Ramadi API response with honest provider provenance',()=>{
  const provider:PrayerConfiguration={...config,localVerified:false,verificationMode:'provider_calculation',verificationSource:'https://aladhan.com/prayer-times-api'};
  const raw=JSON.parse(readFileSync('tests/fixtures/aladhan-ramadi-2026-11-08.json','utf8'));
  expect(validPrayerConfiguration(provider)).toBe(true);expect(parsePrayerDay(raw,'2026-11-08',provider,1)?.minutes).toEqual({Fajr:307,Dhuhr:711,Asr:888,Maghrib:1029,Isha:1109});
  expect(validPrayerConfiguration({...provider,verificationSource:'https://attacker.test'})).toBe(false);
  expect(validPrayerConfiguration({...provider,localVerified:true})).toBe(false);
  raw.data.meta.school='HANAFI';expect(parsePrayerDay(raw,'2026-11-08',provider,1)).toBeNull();
 });
 it.each(['STANDARD','HANAFI',0,1] as const)('binds provider school %s to the configured Asr calculation',school=>{
  const raw=fixture() as any;raw.data.meta.school=school;const expected=school==='HANAFI'||school===1?1:0;
  expect(parsePrayerDay(raw,'2026-11-08',{...config,school:expected},1)).toBeTruthy();expect(parsePrayerDay(raw,'2026-11-08',{...config,school:expected===0?1:0},1)).toBeNull();
 });
 it('publishes only the prayer, city and local time calculated from the API',async()=>{
  const h=setup();await h.enable();const now=h.getNow();const provider:PrayerConfiguration={...config,localVerified:false,verificationMode:'provider_calculation',verificationSource:'https://aladhan.com/prayer-times-api'};
  await configurePrayer(h.db,provider,true,now-60000);await queueControlledPrayers(h.db,now,async()=>Response.json(fixture()));await dispatchControlledJobs(h.db,h.telegram,now,PRODUCT_HANDLERS);
  expect(h.calls.find(c => c.method === 'sendMessage')?.payload).toMatchObject({
    text: '🕌 <b>حان وقت صلاة العصر</b>\n\n📍 الرمادي | 2:00 م\n\n🤍 حيّ على الصلاة وذكر الله', parse_mode: 'HTML',
  });
 });
 it('lets the verified admin choose provider calculation and keeps local verification separate',async()=>{
  const h=setup();await h.text(9001,'🕌 التذكيرات الدينية');await h.click(9001,'اعتماد حساب AlAdhan API');let row=h.sqlite.prepare("SELECT body_json FROM controlled_config WHERE key='religion'").get()!;let body=JSON.parse(String(row.body_json));
  expect(body.prayer.verificationMode).toBe('provider_calculation');expect(body.prayer.localVerified).toBe(false);expect(h.latest(9001).text).toContain('حساب AlAdhan API');
  await h.click(9001,'مطابقة الصلاة بجدول محلي');await h.answer(9001,'جدول محلي تجريبي منفصل');row=h.sqlite.prepare("SELECT body_json FROM controlled_config WHERE key='religion'").get()!;body=JSON.parse(String(row.body_json));expect(body.prayer.verificationMode).toBe('local_timetable');expect(body.prayer.localVerified).toBe(true);expect(validPrayerConfiguration(body.prayer)).toBe(true);
 });
 it('delivers a prayer at :05 instead of losing its one-minute window to hourly cleanup',async()=>{
  const h=setup();await h.enable();const due=Date.parse('2026-11-08T14:05:00+03:00'),sample=fixture();sample.data.timings.Asr='14:05';await configurePrayer(h.db,config,true,h.getNow()-60000);await queueControlledPrayers(h.db,h.getNow(),async()=>Response.json(sample));
  h.resetQueryCount();await runProductCron(h.env,h.telegram,due,h.fetcher);expect(h.calls.find(c=>c.method==='sendMessage')?.payload.text).toContain('صلاة العصر');expect(h.queryCount()).toBeLessThanOrEqual(50);
 });
 it('binds actual city/method/Asr/timezone/date, applies local adjustments only once',()=>{
  expect(validPrayerConfiguration({...config,city:'الأنبار'})).toBe(false);expect(validPrayerConfiguration({...config,school:'0'})).toBe(false);expect(validPrayerConfiguration({...config,localVerified:false})).toBe(false);
  expect(prayerApiUrl('2026-11-08',config)).toContain('timezonestring=Asia%2FBaghdad');const sample=fixture();expect(parsePrayerDay(sample,'2026-11-08',{...config,adjustments:{Asr:2}},1)?.minutes.Asr).toBe(842);
  sample.data.meta.timezone='UTC';expect(parsePrayerDay(sample,'2026-11-08',config,1)).toBeNull();
 });
 for(const fault of ['date','location','method','missing','unordered'] as const)it(`rejects ${fault} mismatch`,()=>{
  const sample=fixture();if(fault==='date')sample.data.date.gregorian.date='07-11-2026';if(fault==='location')sample.data.meta.latitude=34;if(fault==='method')sample.data.meta.method.id=4;if(fault==='missing')delete (sample.data.timings as any).Asr;if(fault==='unordered')sample.data.timings.Asr='11:59';expect(parsePrayerDay(sample,'2026-11-08',config,1)).toBeNull();
 });
 it('caches current-date verified data, rejects tampering and never carries yesterday into today',async()=>{
  const h=setup(),now=h.getNow();let requests=0;const fetcher:typeof fetch=async()=>{requests++;return Response.json(fixture());};expect(await loadPrayerDay(h.db,'2026-11-08',config,now,fetcher)).toBeTruthy();expect(await loadPrayerDay(h.db,'2026-11-08',config,now+60000,fetcher)).toBeTruthy();expect(requests).toBe(1);
  expect(await loadPrayerDay(h.db,'2026-11-09',config,now+86400000,async()=>{throw Error('outage');})).toBeNull();
  h.sqlite.exec("UPDATE controlled_prayer_cache SET body_json=json_set(body_json,'$.minutes.Asr',1)");expect(await loadPrayerDay(h.db,'2026-11-08',config,now+60000)).toBeNull();
 });
 it('queues dynamic prayers once, publishes at actual time and never sends late',async()=>{
  const h=setup();await h.enable();const now=h.getNow();await configurePrayer(h.db,config,true,now-60000);const fetcher:typeof fetch=async()=>Response.json(fixture());expect(await queueControlledPrayers(h.db,now,fetcher)).toBe(3);expect(await queueControlledPrayers(h.db,now,fetcher)).toBe(0);
  await dispatchControlledJobs(h.db,h.telegram,now,PRODUCT_HANDLERS);expect(h.calls.some(c=>c.method==='sendMessage'&&String(c.payload.text).includes('صلاة العصر'))).toBe(true);
  await dispatchControlledJobs(h.db,h.telegram,now+4*3600000,PRODUCT_HANDLERS);expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
 });
 it('moves the pending 14:47 Asr job and its window when the afternoon source says 14:48',async()=>{
  const h=setup();await h.enable();await configurePrayer(h.db,config,true,ramadiTime('00:00'));
  await queueControlledPrayers(h.db,ramadiTime('00:02'),prayerWithAsr('14:47'));
  h.resetQueryCount();await runProductCron(h.env,h.telegram,ramadiTime('12:02'),prayerWithAsr('14:48'));
  expect(h.queryCount()).toBeLessThanOrEqual(50);
  const due=ramadiTime('14:48');
  expect(h.sqlite.prepare(`SELECT due_at,window_start,window_end FROM outbox JOIN controlled_jobs ON id=job_id WHERE id LIKE '%:Asr'`).all())
    .toEqual([{due_at:due,window_start:due,window_end:due+60_000}]);
  await runProductCron(h.env,h.telegram,ramadiTime('14:47'));
  expect(h.calls).toHaveLength(0);
  await runProductCron(h.env,h.telegram,due);await runProductCron(h.env,h.telegram,due+60_000);
  expect(h.calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text)).toEqual(['🕌 <b>حان وقت صلاة العصر</b>\n\n📍 الرمادي | 2:48 م\n\n🤍 حيّ على الصلاة وذكر الله']);
 });
 it('can recover a cancelled old slot if no send was attempted and the corrected time is still ahead',async()=>{
  const h=setup();await h.enable();await configurePrayer(h.db,config,true,ramadiTime('00:00'));
  await queueControlledPrayers(h.db,ramadiTime('00:02'),prayerWithAsr('14:47'));
  await loadPrayerDay(h.db,'2026-11-08',config,ramadiTime('12:02'),prayerWithAsr('14:48'));
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('14:47'),PRODUCT_HANDLERS);
  expect(h.sqlite.prepare("SELECT state FROM outbox WHERE id LIKE '%:Asr'").get()?.state).toBe('cancelled');
  expect(h.calls).toHaveLength(0);
  expect(await queueControlledPrayers(h.db,ramadiTime('14:47'))).toBe(1);
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('14:48'),PRODUCT_HANDLERS);
  expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
 });
 it('preserves an already delivered prayer when the source later moves its time',async()=>{
  const h=setup();await h.enable();await configurePrayer(h.db,config,true,ramadiTime('00:00'));
  await queueControlledPrayers(h.db,ramadiTime('00:02'),prayerWithAsr('14:47'));
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('14:47'),PRODUCT_HANDLERS);
  expect(await queueControlledPrayers(h.db,ramadiTime('14:47')+10_000,prayerWithAsr('14:48'))).toBe(0);
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('14:48'),PRODUCT_HANDLERS);
  expect(h.calls.filter(c=>c.method==='sendMessage')).toHaveLength(1);
  expect(h.sqlite.prepare("SELECT state,due_at FROM outbox WHERE id LIKE '%:Asr'").get()).toEqual({state:'sent',due_at:ramadiTime('14:47')});
 });
 it('delivers in the same tick when refresh advances the prayer to the current minute',async()=>{
  const h=setup();await h.enable();await configurePrayer(h.db,config,true,ramadiTime('00:00'));
  await queueControlledPrayers(h.db,ramadiTime('00:02'),prayerWithAsr('14:51'));
  h.resetQueryCount();await runProductCron(h.env,h.telegram,ramadiTime('14:50'),prayerWithAsr('14:50'));
  expect(h.calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text)).toEqual(['🕌 <b>حان وقت صلاة العصر</b>\n\n📍 الرمادي | 2:50 م\n\n🤍 حيّ على الصلاة وذكر الله']);
  expect(h.queryCount()).toBeLessThanOrEqual(50);
 });
 it('stays within the query budget when all five pending prayer times change together',async()=>{
  const h=setup();await h.enable();await configurePrayer(h.db,{...config,allowOutsideQuietWindow:true},true,ramadiTime('00:00'));
  const old=fixture();old.data.timings.Fajr='06:03';
  await queueControlledPrayers(h.db,ramadiTime('00:02'),async()=>Response.json(old));
  const refreshed=fixture();refreshed.data.timings={Fajr:'06:02',Dhuhr:'12:01',Asr:'14:01',Maghrib:'17:01',Isha:'18:31'};
  h.resetQueryCount();await runProductCron(h.env,h.telegram,ramadiTime('06:02'),async()=>Response.json(refreshed));
  expect(h.calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text)).toEqual(['🕌 <b>حان وقت صلاة الفجر</b>\n\n📍 الرمادي | 6:02 ص\n\n🤍 الصلاة خير من النوم']);
  expect(h.queryCount()).toBeLessThanOrEqual(50);
 });
 it('keeps the newest verified snapshot when an older request finishes later',async()=>{
  const h=setup(),at=ramadiTime('12:02');let resolveOld!:(response:Response)=>void;
  const pending=new Promise<Response>(resolve=>{resolveOld=resolve;});
  const first=loadPrayerDay(h.db,'2026-11-08',config,at,async()=>pending);
  await loadPrayerDay(h.db,'2026-11-08',config,at+1000,prayerWithAsr('14:48'));
  const old=fixture();old.data.timings.Asr='14:47';resolveOld(Response.json(old));await first;
  expect((await loadPrayerDay(h.db,'2026-11-08',config,at+2000))?.minutes.Asr).toBe(888);
 });
 it('delivers Fajr despite the legacy quiet setting and normalizes the saved configuration',async()=>{
  const h=setup();await h.enable();const now=Date.parse('2026-11-08T05:00:00+03:00');await configurePrayer(h.db,{...config,allowOutsideQuietWindow:false},true,now-60000);
  const saved=JSON.parse(String(h.sqlite.prepare("SELECT body_json FROM controlled_config WHERE key='religion'").get()!.body_json));expect(saved.prayer.allowOutsideQuietWindow).toBe(true);
  expect(await queueControlledPrayers(h.db,now,async()=>Response.json(fixture()))).toBe(5);await dispatchControlledJobs(h.db,h.telegram,now,PRODUCT_HANDLERS);expect(h.calls.find(c=>c.method==='sendMessage')?.payload.text).toContain('صلاة الفجر');
 });
 it('preserves future same-day prayers when enabling the 24-hour exception, then queues all five tomorrow',async()=>{
  const h=setup();await h.enable();await configurePrayer(h.db,config,true,ramadiTime('00:00'));
  await queueControlledPrayers(h.db,ramadiTime('00:02'),async()=>Response.json(fixture()));
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('14:00'),PRODUCT_HANDLERS);
  const activation=ramadiTime('15:00');
  await configurePrayer(h.db,{...config,allowOutsideQuietWindow:true},true,activation);
  expect(await queueControlledPrayers(h.db,activation,async()=>Response.json(fixture()))).toBe(2);
  expect(h.sqlite.prepare("SELECT json_extract(payload_json,'$.prayer') AS prayer,state FROM outbox WHERE type='controlled_prayer' ORDER BY due_at").all())
    .toEqual([{prayer:'Fajr',state:'cancelled'},{prayer:'Dhuhr',state:'cancelled'},{prayer:'Asr',state:'sent'},{prayer:'Maghrib',state:'pending'},{prayer:'Isha',state:'pending'}]);
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('17:00'),PRODUCT_HANDLERS);
  expect(h.calls.filter(c=>c.method==='sendMessage').map(c=>c.payload.text)).toHaveLength(2);
  const tomorrow=ramadiTime('00:02')+86_400_000;
  expect(await queueControlledPrayers(h.db,tomorrow,async()=>Response.json(fixture('2026-11-09')))).toBe(5);
  await dispatchControlledJobs(h.db,h.telegram,ramadiTime('05:00')+86_400_000,PRODUCT_HANDLERS);
  expect(h.calls.at(-1)?.payload.text).toContain('صلاة الفجر');
 });
});
describe('expiry and deterministic destination setup',()=>{
 it('hides expired records from student/group views after Baghdad midnight but preserves history',async()=>{
  const h=setup(),now=h.getNow();await saveManualAnnouncement(h.db,scope,1,now,{kind:'quiz',course:'graphics',date:'2026-11-08',time:null,audience:'all',details:'اختبار',coverage:''});expect(await listManualAnnouncements(h.db,{publicOnly:true,scopeChatId:9002,now})).toHaveLength(1);expect(await listManualAnnouncements(h.db,{publicOnly:true,scopeChatId:9002,now:Date.parse('2026-11-09T00:00:00+03:00')})).toHaveLength(0);expect(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n).toBe(1);
 });
 it('binds destination only after explicit confirmation and actual mock bot + actor permission checks',async()=>{
  const h=setup();await h.text(9001,'⚙️ الإعدادات');await h.click(9001,'ربط وجهة النشر');await h.answer(9001,'-100888');expect(h.sqlite.prepare('SELECT target_chat_id FROM settings').get()?.target_chat_id).toBe(-100777);await h.click(9001,'تأكيد الربط');expect(h.sqlite.prepare('SELECT target_chat_id FROM settings').get()?.target_chat_id).toBe(-100888);expect(h.calls.filter(c=>c.method==='getChatMember')).toHaveLength(4);expect(h.calls.some(c=>c.method==='sendMessage'&&Number(c.payload.chat_id)<0)).toBe(false);
 });
 it('lost permissions prevent destination mutation',async()=>{
  const h=setup();await h.text(9001,'⚙️ الإعدادات');await h.click(9001,'ربط وجهة النشر');h.faults.set('getChatMember',[403]);await expect(h.answer(9001,'-100888')).rejects.toThrow();expect(h.sqlite.prepare('SELECT target_chat_id FROM settings').get()?.target_chat_id).toBe(-100777);
 });
});
