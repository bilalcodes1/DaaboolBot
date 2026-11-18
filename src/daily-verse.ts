import { getBaghdadNow } from './calendar';
import { baghdadMidnight, verseMinute } from './channel-calendar';
import { EventStore } from './event-store';
import { getAutomationConfig, queueControlledJob, type ControlledHandler } from './controlled-scheduler';
import { escapeHtml } from './format';
import { readPublicSource } from './source-http';

// References are curated for manageable length and varied topics. Text/meaning are never model output.
export const VERSE_REFERENCES = ['94:5','94:6','20:114','49:13','16:90','39:53','13:28','2:152','2:153','3:159','7:56','29:69','41:34','55:13','67:3','30:22','6:160','42:43','31:18','31:19','17:36','17:37','93:11','62:9'] as const;
export interface VerifiedVerse { reference:string; surah:string; ayah:number; text:string; meaning:string; source:string; tafsirSource:string }
const base = 'https://api.alquran.cloud/v1/ayah/';
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
function edition(raw:unknown, reference:string, identifier:string):Record<string,unknown>|null {
  if (!object(raw) || raw.code!==200 || !object(raw.data)) return null;
  const d=raw.data, [surah,ayah]=reference.split(':').map(Number);
  if (!object(d.edition) || d.edition.identifier!==identifier || !object(d.surah) || d.surah.number!==surah || d.numberInSurah!==ayah
    || typeof d.text!=='string' || !/\p{Script=Arabic}/u.test(d.text) || /[<>]|https?:/iu.test(d.text)) return null;
  return d;
}
export function parseVerifiedVerse(quran:unknown,tafsir:unknown,reference:string):VerifiedVerse|null {
  if (!(VERSE_REFERENCES as readonly string[]).includes(reference)) return null;
  const q=edition(quran,reference,'quran-uthmani'),t=edition(tafsir,reference,'ar.muyassar');
  if (!q || !t || (q.text as string).length>1800 || (t.text as string).length>900 || !object(q.surah) || typeof q.surah.name!=='string' || /[<>]/u.test(q.surah.name)) return null;
  return {reference,surah:q.surah.name,ayah:Number(reference.split(':')[1]),text:q.text as string,meaning:t.text as string,
    source:`https://quran.com/${reference.replace(':','/')}`,tafsirSource:base+reference+'/ar.muyassar'};
}
export async function loadVerse(reference:string,fetcher:typeof fetch):Promise<VerifiedVerse|null> {
  if (!(VERSE_REFERENCES as readonly string[]).includes(reference)) return null;
  const outputs:unknown[]=[];
  for (const edition of ['quran-uthmani','ar.muyassar']) {
    const url=base+reference+'/'+edition;
    const raw=await readPublicSource(url,fetcher,{allowed:value=>value===url,maxBytes:20000});
    if (!raw) return null;
    try { outputs.push(JSON.parse(raw)); } catch { return null; }
  }
  return parseVerifiedVerse(outputs[0],outputs[1],reference);
}
/** Immutable reviewed copy; no hadith quotation or unverified attribution is generated. */
export const FRIDAY_NOTE='🕌 <b>تذكير الجمعة</b>\nأكثروا من الصلاة على النبي ﷺ، واقرؤوا سورة الكهف. ولمن يذهب للجمعة: الغسل والتبكير للصلاة.\n'
  +'<a href="https://sunnah.com/abudawud:1047">الصلاة على النبي</a> · <a href="https://dorar.net/h/rnbzE0ww">الكهف</a> · <a href="https://hadeethenc.com/ar/browse/hadith/5393">الغسل والتبكير</a>';
/** Exact registered Gregorian dates with a reviewed source. Never derive moon sightings from a civil calendar. */
export function observanceNote(body:Record<string,unknown>,date:string):string|null {
  const notices:Record<string,string>={ramadan:'رمضان مبارك؛ تقبّل الله صيامكم وصالح أعمالكم.',eid_fitr:'عيد فطر مبارك؛ تقبّل الله طاعتكم.',eid_adha:'عيد أضحى مبارك؛ تقبّل الله طاعتكم.',arafah:'يوم عرفة؛ أكثروا من الدعاء وذكر الله.',dhul_hijjah:'أيام العشر من ذي الحجة؛ أكثروا من ذكر الله والعمل الصالح.',white_days:'الأيام البيض؛ تذكير لمن اعتاد صيامها.'};
  if (!Array.isArray(body.verifiedObservances)) return null;
  const item=body.verifiedObservances.slice(0,60).find((x:unknown)=>object(x)&&x.date===date&&x.verified===true&&typeof x.kind==='string'&&Object.hasOwn(notices,x.kind)
    &&typeof x.source==='string'&&/^https:\/\/(?:dorar.net|hadeethenc.com|sunnah.com)\/[\w/?=:%.-]+$/u.test(x.source));
  return object(item)?`${notices[String(item.kind)]}\n<a href="${escapeHtml(String(item.source))}">المصدر</a>`:null;
}
export function renderDailyVerse(verse:VerifiedVerse,friday=false,occasion:string|null=null):string {
  return `📖 <b>آية اليوم</b>\n\n━━━━━━━━━━━━━\n\n﴿ ${escapeHtml(verse.text)} ﴾\n\n${escapeHtml(verse.surah)} | الآية ${verse.ayah}\n\n━━━━━━━━━━━━━\n\n🌿 <b>المعنى — التفسير الميسر:</b>\n${escapeHtml(verse.meaning)}\n\n<a href="${escapeHtml(verse.source)}">📚 اقرأ الآية في المصحف</a>`
    +(friday?'\n\n'+FRIDAY_NOTE:'')+(occasion?'\n\n'+occasion:'');
}
export async function queueDailyVerse(db:D1Database,now:number,fetcher:typeof fetch):Promise<boolean> {
  const clock=getBaghdadNow(new Date(now)),due=baghdadMidnight(clock.date)+verseMinute(clock.weekday)*60000;
  if (now<due-8*60000 || now>=due) return false;
  const cfg=await getAutomationConfig(db,'religion');
  if (!cfg.enabled || cfg.body.verseEnabled!==true) return false;
  const settings=await new EventStore(db).getSettings(); if(settings.targetChatId===null)return false;
  const id=`controlled:verse:${settings.targetChatId}:${clock.date}`;
  // Atomic once-per-day admission persists outages and concurrent preparation attempts.
  const claim=await db.prepare("INSERT OR IGNORE INTO controlled_preparations(id,kind,state,started_at) VALUES(?,'verse','running',?)").bind(id,now).run();
  if(!claim.meta.changes)return false;
  try {
    const seen=await db.prepare("SELECT content_id,MAX(sent_at) AS at FROM controlled_deliveries WHERE job_id LIKE 'controlled:verse:%' GROUP BY content_id ORDER BY at DESC LIMIT 30").all<{content_id:string;at:number}>();
    const latest=new Map(seen.results.map(r=>[r.content_id,r.at]));
    const offset=Math.floor(baghdadMidnight(clock.date)/86400000)%VERSE_REFERENCES.length;
    const rotation=[...VERSE_REFERENCES.slice(offset),...VERSE_REFERENCES.slice(0,offset)];
    const reference=rotation.sort((a,b)=>(latest.get('verse:'+a)??0)-(latest.get('verse:'+b)??0))[0]!;
    const verse=await loadVerse(reference,fetcher);
    if (!verse) { await db.prepare("UPDATE controlled_preparations SET state='failed',finished_at=?,reason='unverified_verse' WHERE id=?").bind(now,id).run(); return true; }
    await queueControlledJob(db,{id,type:'controlled_verse',family:'prayer',priority:observanceNote(cfg.body,clock.date)?110:70,contentId:'verse:'+reference,
      dueAt:due,expiresAt:due+30*60000,chatId:settings.targetChatId,threadId:settings.targetThreadId,config:{key:'religion',generation:cfg.generation},
      payload:{version:1,date:clock.date,verse,generation:cfg.generation}},now);
    await db.prepare("UPDATE controlled_preparations SET state='complete',finished_at=?,saved=1,result_json=? WHERE id=?").bind(now,JSON.stringify(verse),id).run();
  } catch { await db.prepare("UPDATE controlled_preparations SET state='failed',finished_at=?,reason='preparation_failed' WHERE id=?").bind(now,id).run(); }
  return true;
}
export const dailyVerseHandler:ControlledHandler={types:['controlled_verse'],async resolve(db,job,now){
  const p=job.payload;
  if(!object(p)||p.version!==1||!object(p.verse)||typeof p.date!=='string'||p.date!==getBaghdadNow(new Date(now)).date)return null;
  const cfg=await getAutomationConfig(db,'religion');
  if(!cfg.enabled||cfg.body.verseEnabled!==true||cfg.generation!==p.generation)return null;
  const trusted=await db.prepare("SELECT result_json FROM controlled_preparations WHERE id=? AND state='complete'").bind(job.id).first<{result_json:string}>();
  if(!trusted||trusted.result_json!==JSON.stringify(p.verse))return null;
  const settings=await new EventStore(db).getSettings();if(settings.targetChatId===null)return null;
  const verse=p.verse as unknown as VerifiedVerse;
  const text=renderDailyVerse(verse,getBaghdadNow(new Date(now)).weekday===5,observanceNote(cfg.body,p.date));
  if(text.length>4000)return null;
  return {chatId:settings.targetChatId,method:'sendMessage',family:'prayer',priority:observanceNote(cfg.body,p.date)?110:70,payload:{chat_id:settings.targetChatId,...(settings.targetThreadId===null?{}:{message_thread_id:settings.targetThreadId}),text,parse_mode:'HTML',link_preview_options:{is_disabled:true}}};
}};
