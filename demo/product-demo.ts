import assert from 'node:assert/strict';
import {productHarness} from '../tests/helpers/product';
import {saveManualAnnouncement,deleteManualAnnouncement} from '../src/manual-academic';
import {saveManualTimetable,officialTimetable} from '../src/manual-timetable';
import {setManualConfig,queueManualPublication,cancelManualPublication} from '../src/manual-delivery';
import {issueStudentChallenge,verifyStudentChallenge} from '../src/student-identity';
import {dispatchControlledJobs as dispatchActual,configureAutomation} from '../src/controlled-scheduler';
import {PRODUCT_HANDLERS} from '../src/product-jobs';
import {refreshControlledNews,queueControlledNews} from '../src/content-sources';
import {configurePrayer,queueControlledPrayers,type PrayerConfiguration} from '../src/prayer-times';
const dispatchControlledJobs:typeof dispatchActual=(db,tg,now,handlers,options={})=>dispatchActual(db,tg,now,handlers,{...options,clock:options.clock??(()=>now)});

/** Actual integrated handlers, real local SQLite and external transports that never leave this process. */
export async function runProductDemo(){
 const h=productHarness(undefined,{reply:'هلا، الموجود بالجدول أشرحه إلك، وتعديلاته من أزرار الأدمن 😄'}),scope={userId:9001,chatId:9001,threadId:null};
 const stages:{name:string;ms:number;queries:number}[]=[];
 const stage=async(name:string,work:()=>Promise<void>)=>{h.resetQueryCount();const start=performance.now();try{await work();}catch(error){throw new Error(name+': '+(error instanceof Error?error.message:'error'));}stages.push({name,ms:Math.round((performance.now()-start)*100)/100,queries:h.queryCount()});};
 try{
 await stage('admin_preview_create_edit_and_student_read',async()=>{
  await h.text(9001,'/start');await h.text(9001,'📢 التبليغات');await h.click(9001,'إضافة تبليغ');await h.click(9001,'امتحان');await h.click(9001,'شبكات الحاسبة');await h.answer(9001,'2026-11-09');await h.click(9001,'بدون وقت محدد');await h.click(9001,'للكل');await h.click(9001,'بدون وصف');await h.click(9001,'بدون مشمول');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n,0);await h.click(9001,'تأكيد الحفظ');
  await h.text(9001,'📢 التبليغات');await h.click(9001,'امتحان شبكات الحاسبة 2026-11-09');await h.click(9001,'تعديل / تصحيح');await h.click(9001,'الوقت');await h.answer(9001,'09:45');await h.click(9001,'تأكيد الحفظ');await h.text(9002,'📢 التبليغات');await h.click(9002,'امتحان شبكات الحاسبة 2026-11-09');assert.match(h.latest(9002).text,/09:45/u);
 });
 const ref={kind:'academic' as const,id:String(h.sqlite.prepare('SELECT id FROM academic_reports').get()!.id),revision:2};
 await stage('schedule_cancel_delete_and_timetable_history',async()=>{
  await h.enable();await setManualConfig(h.db,scope,20000,h.getNow(),'academic_publications',1,true);const queued=await queueManualPublication(h.db,scope,20001,h.getNow(),ref,h.getNow()+3600000);assert(queued.ok);assert((await cancelManualPublication(h.db,scope,20002,h.getNow(),queued.id!)).ok);
  assert((await deleteManualAnnouncement(h.db,scope,20003,h.getNow(),ref)).ok);assert((await saveManualTimetable(h.db,scope,20004,h.getNow(),0,officialTimetable().lectures)).ok);await h.text(9002,'📅 الجدول الدراسي');await h.click(9002,'باچر');
 });
 await stage('numeric_identity_private_consent_and_opt_out',async()=>{
  h.sqlite.prepare('INSERT INTO student_roster(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('demo-student','طالب تجريبي مستقل',h.getNow(),h.getNow());const code=await issueStudentChallenge(h.db,'demo-student',9001,h.getNow());await h.text(9002,`ربط حسابي ${code}`);await h.click(9002,'أوافق وأسمح باسمي الأول');const hash=String(h.sqlite.prepare('SELECT token_hash FROM student_link_challenges').get()!.token_hash);assert(await verifyStudentChallenge(h.db,hash,9001,h.getNow()));await h.text(9002,'إيقاف استخدام اسمي');
 });
 await stage('group_reply_only_provider_simulation',async()=>{
  h.env.GROQ_API_KEY='synthetic-local-demo-credential';h.env.GROUP_AI_ENABLED='true';await h.dispatch({update_id:30000,message:{message_id:30000,from:{id:9002,is_bot:false},chat:{id:-100777,type:'supergroup'},text:'@DaaboolLocalBot هلا، تگدر تغير الجدول؟'}});assert.equal(h.providerRequests(),1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM manual_timetable_history').get()?.n,1);
 });
 await stage('sourced_arabic_news',async()=>{
  const body='The research institute reported a preliminary laboratory prototype. Researchers cautioned that the experiment has not been tested in people and is not a commercial product.';
  const make=(url:string)=>new Response(`<rss><item><title>${url.includes('news.mit.edu')?'Independent prototype report':'Preliminary laboratory prototype'}</title><link>${url}</link><description>${body}</description><pubDate>${new Date(h.getNow()-60000).toUTCString()}</pubDate></item></rss>`);
  const summarize=async(d:{digest:string})=>({title:'نموذج تجريبي داخل المختبر',claims:[{arabic:'عرض المعهد نموذجاً أولياً داخل المختبر، وبعده مو منتج تجاري وما تجرّب على البشر.',evidence:body}],sourceDigest:d.digest});
  assert.equal(await refreshControlledNews(h.db,h.getNow(),async url=>String(url).includes('news.mit.edu')?make('https://news.mit.edu/synthetic-demo-news'):new Response('<rss/>'),summarize),1);
  h.setNow(h.getNow()+5*3600000);await configureAutomation(h.db,'news',{enabled:true},h.getNow());assert.equal(await queueControlledNews(h.db,h.getNow()),1);await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);
 });
 await stage('daily_prayer_fixture_and_unknown_send_quarantine',async()=>{
  const date=new Date(h.getNow()+3*3600000).toISOString().slice(0,10),c:PrayerConfiguration={city:'الرمادي',region:'Al-Anbar',country:'Iraq',latitude:33.4258,longitude:43.2992,timezone:'Asia/Baghdad',method:3,school:0,adjustments:{},enabledPrayers:['Isha'],localVerified:true,verificationDate:date,verificationSource:'fixture only, no actual local validation',allowOutsideQuietWindow:false};
  h.setNow(h.getNow()+3600000);await configurePrayer(h.db,c,true,h.getNow()-60000);await queueControlledPrayers(h.db,h.getNow(),async()=>Response.json({code:200,data:{meta:{timezone:'Asia/Baghdad',latitude:c.latitude,longitude:c.longitude,method:{id:3},school:0},date:{gregorian:{date:date.split('-').reverse().join('-')}},timings:{Fajr:'05:00',Dhuhr:'12:00',Asr:'14:00',Maghrib:'17:00',Isha:'20:00'}}}));await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);
  h.setNow(h.getNow()+120000);const r=await saveManualAnnouncement(h.db,scope,60000,h.getNow(),{kind:'note',course:null,date:null,time:null,audience:null,details:'اختبار تعطل الإرسال ببيانات تجريبية',coverage:''});await queueManualPublication(h.db,scope,60001,h.getNow(),{kind:'academic',id:r.id!,revision:1},h.getNow());h.faults.set('sendMessage',[0]);await dispatchControlledJobs(h.db,h.telegram,h.getNow(),PRODUCT_HANDLERS);assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM controlled_attempts WHERE state='unknown'").get()?.n,1);const sent=h.calls.length;await dispatchControlledJobs(h.db,h.telegram,h.getNow()+180000,PRODUCT_HANDLERS);assert.equal(h.calls.length,sent);
 });
 return {mode:'offline_integrated_demo',externalCalls:0,realAiAccuracyVerified:false,realTelegramPermissionsVerified:false,syntheticDataOnly:true,stages,providerSimulationRequests:h.providerRequests(),telegramSimulationRequests:h.calls.length,announcements:Number(h.sqlite.prepare('SELECT COUNT(*) n FROM academic_reports').get()?.n),confirmedDeliveries:Number(h.sqlite.prepare('SELECT COUNT(*) n FROM controlled_deliveries').get()?.n),unknownDeliveries:Number(h.sqlite.prepare("SELECT COUNT(*) n FROM controlled_attempts WHERE state='unknown'").get()?.n)};
 }finally{h.close();}
}
