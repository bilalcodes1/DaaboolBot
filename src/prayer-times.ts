import { getBaghdadNow } from './calendar';
import { EventStore } from './event-store';
import { escapeHtml } from './format';
import { configureAutomation, getAutomationConfig, queueControlledJob, type ControlledHandler } from './controlled-scheduler';
import { notificationTime } from './notification-format';
import { formatMinuteOfDay } from './timing';

const MINUTE=60000;
export const PRAYER_NAMES=['Fajr','Dhuhr','Asr','Maghrib','Isha'] as const;
export type PrayerName=typeof PRAYER_NAMES[number];
const ARABIC_PRAYERS:Record<PrayerName,string>={Fajr:'الفجر',Dhuhr:'الظهر',Asr:'العصر',Maghrib:'المغرب',Isha:'العشاء'};
export interface PrayerConfiguration {
  city:string; region:'Al-Anbar'; country:'Iraq';latitude:number;longitude:number;timezone:'Asia/Baghdad';
  method:number;school:0|1;adjustments:Partial<Record<PrayerName,number>>;enabledPrayers:PrayerName[];
  allowOutsideQuietWindow:boolean;localVerified:boolean;verificationDate?:string;verificationSource?:string;
  verificationMode?:'local_timetable'|'provider_calculation';
}
export interface PrayerDay {date:string;timezone:'Asia/Baghdad';latitude:number;longitude:number;method:number;school:0|1;minutes:Record<PrayerName,number>;fetchedAt:number;configFingerprint:string}
interface PrayerCacheRow {body_json:string;config_json:string;fetched_at:number;verified:number}
interface PrayerJobPayload {date:string;prayer:PrayerName;minute:number;generation:number;fingerprint:string}
interface PrayerJob {id:string;chatId:number;threadId:number|null;dueAt:number;payload:PrayerJobPayload}
interface PrayerJobRow {id:string;type:string;state:string;last_error:string|null;payload_json:string}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
export function validPrayerConfiguration(v:unknown,requireVerification=true):v is PrayerConfiguration{
  if(!object(v)||typeof v.city!=='string'||v.city.trim().length<2||v.city.length>80||/^(?:الأنبار|الانبار|anbar|al-anbar)$/iu.test(v.city)
    ||v.region!=='Al-Anbar'||v.country!=='Iraq'||v.timezone!=='Asia/Baghdad'||!Number.isFinite(v.latitude)||!Number.isFinite(v.longitude)
    ||Number(v.latitude)<31||Number(v.latitude)>36||Number(v.longitude)<38||Number(v.longitude)>45
    ||!Number.isInteger(v.method)||Number(v.method)<0||Number(v.method)>23||![0,1].includes(v.school as number)||!object(v.adjustments)
    ||!Array.isArray(v.enabledPrayers)||!v.enabledPrayers.every(p=>PRAYER_NAMES.includes(p as PrayerName))||typeof v.allowOutsideQuietWindow!=='boolean')return false;
  if(Object.entries(v.adjustments).some(([key,n])=>!PRAYER_NAMES.includes(key as PrayerName)||!Number.isInteger(n)||Number(n)<-15||Number(n)>15))return false;
  const provider=v.verificationMode==='provider_calculation'&&v.localVerified===false&&v.verificationSource==='https://aladhan.com/prayer-times-api';
  const local=v.localVerified===true&&(v.verificationMode===undefined||v.verificationMode==='local_timetable');
  if(requireVerification&&(!provider&&!local||typeof v.verificationSource!=='string'||v.verificationSource.trim().length<5||typeof v.verificationDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.verificationDate)))return false;
  return true;
}
export function prayerConfigFingerprint(config:PrayerConfiguration):string{
  return JSON.stringify({city:config.city,latitude:config.latitude,longitude:config.longitude,timezone:config.timezone,method:config.method,school:config.school,adjustments:config.adjustments,
    verificationDate:config.verificationDate??null,verificationSource:config.verificationSource??null,localVerified:config.localVerified,verificationMode:config.verificationMode??'local_timetable'});
}
export function prayerApiUrl(date:string,config:PrayerConfiguration):string{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!validPrayerConfiguration(config))throw new RangeError('Verified city-specific prayer configuration required.');
  const [year,month,day]=date.split('-');const url=new URL(`https://api.aladhan.com/v1/timings/${day}-${month}-${year}`);
  url.search=new URLSearchParams({latitude:String(config.latitude),longitude:String(config.longitude),method:String(config.method),school:String(config.school),timezonestring:config.timezone}).toString();return url.toString();
}
export function parsePrayerDay(raw:unknown,date:string,config:PrayerConfiguration,now:number):PrayerDay|null{
  if(!validPrayerConfiguration(config)||!object(raw)||raw.code!==200||!object(raw.data)||!object(raw.data.meta)||!object(raw.data.date)||!object(raw.data.timings))return null;
  const {meta,timings}=raw.data,providerDate=raw.data.date;
  if(!object(providerDate.gregorian)||providerDate.gregorian.date!==date.split('-').reverse().join('-')||meta.timezone!==config.timezone
    ||typeof meta.latitude!=='number'||typeof meta.longitude!=='number'||Math.abs(meta.latitude-config.latitude)>0.02||Math.abs(meta.longitude-config.longitude)>0.02
    ||!object(meta.method)||meta.method.id!==config.method)return null;
  // School is bound to the request and cache identity; reject any conflicting response metadata.
  const responseSchool=meta.school==='STANDARD'?0:meta.school==='HANAFI'?1:meta.school;
  if(responseSchool!==undefined&&responseSchool!==config.school)return null;
  const minutes={} as Record<PrayerName,number>;
  for(const prayer of PRAYER_NAMES){const value=timings[prayer];if(typeof value!=='string')return null;const match=/^(\d{2}):(\d{2})(?:\s*\((?:\+03|\+0300|\+03:00)\))?$/.exec(value);
    if(!match||Number(match[1])>23||Number(match[2])>59)return null;
    const minute=Number(match[1])*60+Number(match[2])+(config.adjustments[prayer]??0);if(minute<0||minute>=1440)return null;minutes[prayer]=minute;}
  if(!PRAYER_NAMES.every((prayer,i)=>i===0||minutes[PRAYER_NAMES[i-1]!]!<minutes[prayer]))return null;
  return {date,timezone:config.timezone,latitude:config.latitude,longitude:config.longitude,method:config.method,school:config.school,minutes,fetchedAt:now,configFingerprint:prayerConfigFingerprint(config)};
}
export async function configurePrayer(db:D1Database,config:PrayerConfiguration,enabled:boolean,now=Date.now()):Promise<void>{
  if(!validPrayerConfiguration(config,enabled))throw new RangeError('Prayer settings need an actual city, calculation method, school and an explicit timing source.');
  // Prayer notifications are time-critical and are not subject to the quiet
  // window used by ordinary channel content. Keep the legacy field true for
  // old readers, while delivery below no longer gates on it.
  const allDay={...config,allowOutsideQuietWindow:true};
  await configureAutomation(db,'religion',{enabled,body:{prayer:allDay,localVerified:config.localVerified}},now);
}
/** Fetch is injected and bounded. A failure can reuse only a validated cache for the identical date/configuration. */
export async function loadPrayerDay(db:D1Database,date:string,config:PrayerConfiguration,now:number,fetcher?:typeof fetch):Promise<PrayerDay|null>{
  if(!validPrayerConfiguration(config)||date!==getBaghdadNow(new Date(now)).date)return null;
  const fingerprint=prayerConfigFingerprint(config),key=`${date}:${fingerprint}`;
  const cacheQuery=db.prepare('SELECT body_json,config_json,fetched_at,verified FROM controlled_prayer_cache WHERE cache_key=? AND local_date=?').bind(key,date);
  const readCache=(cached:PrayerCacheRow|null):PrayerDay|null=>{try{
    const day=JSON.parse(cached?.body_json??'null') as PrayerDay|null;
    if(cached?.verified!==1||cached.config_json!==fingerprint||day?.date!==date||day.configFingerprint!==fingerprint||day.fetchedAt!==cached.fetched_at||day.fetchedAt>now
      ||day.timezone!==config.timezone||day.latitude!==config.latitude||day.longitude!==config.longitude||day.method!==config.method||day.school!==config.school||!object(day.minutes)
      ||!PRAYER_NAMES.every((name,i)=>Number.isInteger(day.minutes[name])&&day.minutes[name]>=0&&day.minutes[name]<1440&&(i===0||day.minutes[name]>day.minutes[PRAYER_NAMES[i-1]!])) )return null;
    return day;
  }catch{return null;}};
  const saved=readCache(await cacheQuery.first<PrayerCacheRow>());if(saved&&now-saved.fetchedAt<6*60*MINUTE)return saved;
  if(!fetcher)return saved;
  try{
    const response=await fetcher(prayerApiUrl(date,config),{redirect:'manual',signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
    if(!response.ok||Number(response.headers.get('content-length'))>100000){await response.body?.cancel();return saved;}
    if(!response.body)return saved;const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>100000){await reader.cancel();return saved;}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    const day=parsePrayerDay(JSON.parse(text),date,config,now);if(!day)return saved;
    const savedRefresh=await db.prepare(`INSERT INTO controlled_prayer_cache(cache_key,local_date,config_json,body_json,fetched_at,verified) VALUES(?,?,?,?,?,1)
      ON CONFLICT(cache_key) DO UPDATE SET body_json=excluded.body_json,fetched_at=excluded.fetched_at,verified=1
      WHERE controlled_prayer_cache.fetched_at<excluded.fetched_at`)
      .bind(key,date,fingerprint,JSON.stringify(day),now).run();
    return savedRefresh.meta.changes ? day : readCache(await cacheQuery.first<PrayerCacheRow>());
  }catch{return saved;}
}
/** Move an unsent prayer to the latest verified time or configuration under the same daily ID. */
async function refreshPrayerJob(db:D1Database,existing:PrayerJobRow,job:PrayerJob,day:PrayerDay):Promise<boolean>{
  const {id,chatId,threadId,dueAt,payload}=job;
  if(existing.type!=='controlled_prayer'||(existing.state!=='pending'&&existing.state!=='cancelled'))return false;
  let old:unknown;try{old=JSON.parse(existing.payload_json);}catch{return false;}
  if(!object(old)||old.date!==payload.date||old.prayer!==payload.prayer||typeof old.generation!=='number'
    ||!Number.isSafeInteger(old.generation))return false;
  const timeChanged=existing.last_error===null&&old.generation===payload.generation
    &&old.fingerprint===payload.fingerprint&&old.minute!==payload.minute;
  const configurationChanged=existing.state==='cancelled'&&old.generation<payload.generation
    &&(existing.last_error==='configuration_changed'||existing.last_error===null);
  if(!timeChanged&&!configurationChanged)return false;

  const body=JSON.stringify(payload),end=dueAt+MINUTE;
  const [changed]=await db.batch([
    db.prepare(`UPDATE outbox SET payload_json=?,due_at=?,state='pending',lease_token=NULL,lease_until=NULL,last_error=NULL
      WHERE id=? AND type='controlled_prayer' AND state=? AND last_error IS ? AND payload_json=?
        AND NOT EXISTS(SELECT 1 FROM controlled_attempts WHERE job_id=outbox.id)
        AND NOT EXISTS(SELECT 1 FROM controlled_deliveries WHERE job_id=outbox.id)
        AND EXISTS(SELECT 1 FROM controlled_jobs WHERE job_id=outbox.id AND family='prayer' AND chat_id=? AND thread_id=? AND config_key='religion' AND generation=?)
        AND EXISTS(SELECT 1 FROM controlled_config WHERE key='religion' AND enabled=1 AND generation=?)
        AND EXISTS(SELECT 1 FROM controlled_prayer_cache WHERE cache_key=? AND verified=1 AND fetched_at=? AND json_extract(body_json,?)=?)`)
      .bind(body,dueAt,id,existing.state,existing.last_error,existing.payload_json,chatId,threadId??0,old.generation,payload.generation,
        `${payload.date}:${payload.fingerprint}`,day.fetchedAt,`$.minutes.${payload.prayer}`,payload.minute),
    db.prepare(`UPDATE controlled_jobs SET expires_at=?,window_start=?,window_end=?,generation=?
      WHERE job_id=? AND family='prayer' AND chat_id=? AND thread_id=? AND config_key='religion' AND generation=?
        AND EXISTS(SELECT 1 FROM outbox WHERE id=controlled_jobs.job_id AND type='controlled_prayer' AND state='pending' AND due_at=? AND payload_json=?)`)
      .bind(end,dueAt,end,payload.generation,id,chatId,threadId??0,old.generation,dueAt,body),
  ]);
  return (changed?.meta.changes??0)>0;
}

export async function queueControlledPrayers(db:D1Database,now:number,fetcher?:typeof fetch):Promise<number>{
  const config=await getAutomationConfig(db,'religion'),product=await getAutomationConfig(db,'product'),clock=getBaghdadNow(new Date(now));
  if(!config.enabled||!product.enabled)return 0;
  const settings=await new EventStore(db).getSettings();if(settings.targetChatId===null)return 0;let count=0;
  const prayer=config.body.prayer;
  if(validPrayerConfiguration(prayer)){
    const day=await loadPrayerDay(db,clock.date,prayer,now,fetcher);
    const jobs:PrayerJob[]=[];
    for(const name of PRAYER_NAMES){
      if(!prayer.enabledPrayers.includes(name))continue;
      if(!day)break;const minute=day.minutes[name];
      const dueAt=Date.parse(`${clock.date}T00:00:00+03:00`)+minute*MINUTE;
      if(now>=dueAt+MINUTE||dueAt<config.updatedAt)continue;
      jobs.push({id:`controlled:prayer:${settings.targetChatId}:${clock.date}:${name}`,chatId:settings.targetChatId,threadId:settings.targetThreadId,dueAt,
        payload:{date:clock.date,prayer:name,minute,generation:config.generation,fingerprint:day.configFingerprint}});
    }
    if(day&&jobs.length){
      const rows=await db.prepare(`SELECT id,type,state,last_error,payload_json FROM outbox WHERE id IN (${jobs.map(()=>'?').join(',')})`)
        .bind(...jobs.map(job=>job.id)).all<PrayerJobRow>();
      const existing=new Map(rows.results.map(row=>[row.id,row]));
      for(const job of jobs){
        const previous=existing.get(job.id),end=job.dueAt+MINUTE;
        const queued=previous?await refreshPrayerJob(db,previous,job,day):await queueControlledJob(db,{...job,type:'controlled_prayer',family:'prayer',expiresAt:end,
          config:{key:'religion',generation:config.generation},executionWindow:{start:job.dueAt,end}},now);
        if(queued)count++;
      }
    }
  }
  return count;
}
export const controlledPrayerHandler:ControlledHandler={types:['controlled_prayer'],async resolve(db,job,now){
  if(!object(job.payload))return null;const config=await getAutomationConfig(db,'religion'),settings=await new EventStore(db).getSettings();
  if(!config.enabled||config.generation!==job.payload.generation||settings.targetChatId===null)return null;
  const prayer=config.body.prayer;if(!validPrayerConfiguration(prayer)||typeof job.payload.date!=='string'||job.payload.date!==getBaghdadNow(new Date(now)).date||!PRAYER_NAMES.includes(job.payload.prayer as PrayerName)
    ||!prayer.enabledPrayers.includes(job.payload.prayer as PrayerName)||job.payload.fingerprint!==prayerConfigFingerprint(prayer))return null;
  const day=await loadPrayerDay(db,job.payload.date,prayer,now),name=job.payload.prayer as PrayerName;if(!day||day.minutes[name]!==job.payload.minute)return null;
  const dueAt=Date.parse(`${day.date}T00:00:00+03:00`)+day.minutes[name]*MINUTE;if(now<dueAt||now>=dueAt+MINUTE)return null;
  const time = notificationTime(formatMinuteOfDay(day.minutes[name]));
  const previous=await db.prepare("SELECT a.outgoing_json FROM controlled_attempts a JOIN controlled_deliveries d ON d.job_id=a.job_id WHERE a.state='confirmed' AND d.job_id LIKE 'controlled:prayer:%' ORDER BY d.sent_at DESC LIMIT 1").first<{outgoing_json:string}>();
  const prior=previous?String(JSON.parse(previous.outgoing_json).payload?.text??'').split('🤍 ').at(-1):undefined;
  const text = renderPrayerNotice(day.date, name, time, prayer.city,prior);
  return {chatId:settings.targetChatId,method:'sendMessage',family:'prayer',config:{key:'religion',generation:config.generation},payload:{chat_id:settings.targetChatId,...(settings.targetThreadId===null?{}:{message_thread_id:settings.targetThreadId}),text,parse_mode:'HTML'}};
}};

const PRAYER_LINES = ['حيّ على الصلاة، حيّ على الفلاح', 'اللهم أعنّا على ذكرك وشكرك', 'اللهم تقبّل صلاتنا ودعاءنا', 'أقم صلاتك واذكر ربك', 'اللهم اجعلنا من المحافظين على الصلاة', 'حيّ على الصلاة وذكر الله', 'اللهم ارزقنا الخشوع في الصلاة'];
export function renderPrayerNotice(date: string, name: PrayerName, time: string, city = 'الرمادي', previous?:string): string {
  const weekday = getBaghdadNow(new Date(date + 'T12:00:00+03:00')).weekday;
  const friday = weekday === 5 && name === 'Dhuhr';
  const dayIndex = Math.floor(Date.parse(date + 'T00:00:00+03:00') / 86400000);
  let line = name === 'Fajr' ? 'الصلاة خير من النوم' : PRAYER_LINES[(dayIndex * 5 + PRAYER_NAMES.indexOf(name)) % PRAYER_LINES.length]!;
  if(line===previous)line=PRAYER_LINES.find(x=>x!==previous)!;
  return `🕌 <b>${friday ? 'تذكير صلاة الجمعة' : `حان وقت صلاة ${ARABIC_PRAYERS[name]}`}</b>\n\n📍 ${escapeHtml(city)} | ${time}`
    + (friday ? '\nدخل وقت الظهر؛ موعد الخطبة والإقامة حسب مسجدك.' : '') + `\n\n🤍 ${line}`;
}
