import { CHANNEL_TIMES, baghdadMidnight } from './channel-calendar';
import { NEWS_PUBLISHERS, publisherFor } from './news-registry';
import { verifyNewsArticle, cleanArticle, type ArticleMedia } from './news-article';
import { NEWS_FEEDS, parseNewsFeed, readNewsText, safeNewsUrl, type NewsItem } from './daily-news';
import { escapeHtml } from './format';
import { getBaghdadNow } from './calendar';
import { EventStore } from './event-store';
import { getAutomationConfig, queueControlledJob, type ControlledHandler } from './controlled-scheduler';

const DAY=86_400_000;
export interface SourceRegistration {id:string;kind:'news';host:string;feedUrl?:string;authorized:boolean;license?:{name:string;url:string;allowsReuse:boolean}}
export interface SourceDocument {id:string;sourceId:string;kind:'news';url:string;title:string;body:string;publishedAt:number;fetchedAt:number;digest:string;articleVerified?:boolean;category?:string;media?:ArticleMedia}
export interface GroundedClaim {arabic:string;evidence:string}
export interface GroundedArabicSummary {title:string;claims:GroundedClaim[];sourceDigest:string}
const EXTRA_HOSTS=['www.bbc.com','bbc.com','apnews.com','www.smithsonianmag.com','www.nationalgeographic.com','www.nasa.gov','science.nasa.gov'];
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
export function approvedSourceUrl(value:string,host?:string):boolean{
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port
    &&(host?url.hostname===host:[...NEWS_PUBLISHERS.map(f=>f.host),...EXTRA_HOSTS].includes(url.hostname));}catch{return false;}
}
/** Retrieved prose is data only. Instruction-shaped and unsafe source snippets are rejected entirely. */
export function safeSourceText(text:string):boolean{
  return text.trim().length>=40&&text.length<=12000&&!/<\/?(?:script|iframe)|ignore\s+(?:all\s+)?(?:previous|system)|system\s*prompt|developer\s*message|api[_ -]?key|bot\s*token|تجاهل\s+(?:التعليمات|كل)|تعليمات\s+النظام/iu.test(text)
    &&!/\b(?:suicide methods|pornographic|racial supremacy)\b/iu.test(text);
}
export async function sourceDigest(text:string):Promise<string>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
export async function registerControlledSource(db:D1Database,source:SourceRegistration,now=Date.now()):Promise<void>{
  if(!/^[a-z][a-z0-9_-]{1,60}$/.test(source.id)||!approvedSourceUrl(`https://${source.host}/`)||source.feedUrl&&!approvedSourceUrl(source.feedUrl,source.host))throw new RangeError('Source is not in the approved publisher registry.');
  if(source.license&&(!source.license.name.trim()||!source.license.allowsReuse||!approvedSourceUrl(source.license.url,source.host)))throw new RangeError('Image reuse needs a verified publisher license.');
  await db.prepare(`INSERT INTO controlled_sources(id,kind,host,feed_url,authorized,license_json,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,host=excluded.host,feed_url=excluded.feed_url,authorized=excluded.authorized,license_json=excluded.license_json,updated_at=excluded.updated_at`)
    .bind(source.id,source.kind,source.host,source.feedUrl??null,Number(source.authorized),source.license?JSON.stringify(source.license):null,now).run();
}
export async function persistSourceDocument(db:D1Database,input:Omit<SourceDocument,'id'|'digest'>,now=Date.now()):Promise<SourceDocument|null>{
  const source=await db.prepare('SELECT host,authorized,kind FROM controlled_sources WHERE id=?').bind(input.sourceId).first<{host:string;authorized:number;kind:string}>();
  if(source?.authorized!==1||source.kind!=='news'||input.kind!=='news'||!approvedSourceUrl(input.url,source.host)||!safeSourceText(input.body)
    ||!Number.isFinite(input.publishedAt)||!Number.isFinite(input.fetchedAt)||input.publishedAt>now||input.fetchedAt>now||now-input.fetchedAt>DAY
    ||now-input.publishedAt>3*DAY||!input.title.trim()||input.title.length>250)return null;
  const digest=await sourceDigest(`${input.title}\n${input.body}`),id=`source:${digest}`;
  const document:SourceDocument={...input,id,digest};
  const saved=await db.prepare(`INSERT OR IGNORE INTO controlled_source_documents(id,source_id,kind,url,published_at,fetched_at,body_json,source_digest) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id,input.sourceId,input.kind,input.url,input.publishedAt,input.fetchedAt,JSON.stringify(document),digest).run();
  return saved.meta.changes?document:null;
}
function digits(text:string):string[]{return (text.replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).match(/\d+(?:[.,:]\d+)*/g)??[]);}
/** Evidence must be literal source text. No new numbers, dates, quoted claims or asserted cures are permitted. */
export function validateGroundedArabicSummary(raw:unknown,document:SourceDocument,now:number):GroundedArabicSummary|null{
  if(!object(raw)||raw.sourceDigest!==document.digest||typeof raw.title!=='string'||raw.title.length>180||!/[\u0600-\u06ff]/.test(raw.title)
    ||!Array.isArray(raw.claims)||raw.claims.length<1||raw.claims.length>4||document.kind!=='news'||document.publishedAt>now||now-document.publishedAt>3*DAY)return null;
  const source=`${document.title}\n${document.body}`,claims:GroundedClaim[]=[];
  if(digits(raw.title).some(n=>!digits(source).includes(n))||/عاجل|شفاء\s+مؤكد|يعالج\s+السرطان|أثبت\s+نهائيا/u.test(raw.title))return null;
  for(const c of raw.claims){
    if(!object(c)||typeof c.arabic!=='string'||typeof c.evidence!=='string'||c.arabic.length<10||c.arabic.length>400||c.evidence.length<30||c.evidence.length>800
      ||!source.includes(c.evidence)||!/[\u0600-\u06ff]/.test(c.arabic)||!safeSourceText(`${c.evidence} ${c.arabic}`)
      ||digits(c.arabic).some(n=>!digits(String(c.evidence)).includes(n))
      ||/عاجل|شفاء\s+مؤكد|يعالج\s+السرطان|أثبت\s+نهائيا|اقتباس|قال\s+[«"]/u.test(c.arabic)
      ||/[«»“”]/u.test(c.arabic))return null;
    const evidence=c.evidence,latin=c.arabic.match(/[A-Z][A-Za-z0-9-]{2,}/g)??[];if(latin.some(name=>!evidence.includes(name)))return null;
    claims.push({arabic:c.arabic.trim(),evidence:c.evidence});
  }
  if(claims.map(c=>c.arabic).join(' ').split(/\s+/u).length>110)return null;
  return {title:raw.title,claims,sourceDigest:document.digest};
}
export function renderGroundedSource(document: SourceDocument, summary: GroundedArabicSummary, now=Date.now(), night=false): string {
  const publisher=publisherFor(document.url),category=publisher?.category??'علوم وتكنولوجيا';
  const old=now-document.publishedAt>DAY?`\n📅 نُشر في ${getBaghdadNow(new Date(document.publishedAt)).date}`:'';
  const credit=document.media?`\nالوسيط: ${escapeHtml(document.media.credit)} · <a href="${escapeHtml(document.media.license)}">الترخيص</a>`:'';
  return `${night?'🌌 <b>خبر الليل':'📰 <b>خبر اليوم'} | ${category}</b>\n\n<b>${escapeHtml(summary.title)}</b>\n\n${summary.claims.map(c=>escapeHtml(c.arabic)).join('\n\n')}${old}\n\n📡 ${escapeHtml(publisher?.name??'المصدر')} | <a href="${escapeHtml(document.url)}">🔗 اقرأ التفاصيل</a>${credit}`;
}
export type NewsSelector=(documents:readonly SourceDocument[],recentCategories:readonly string[])=>Promise<unknown>;
export type NewsSummarizer=(document:SourceDocument)=>Promise<unknown>;
export function parseControlledFeed(xml:string,feed:typeof NEWS_FEEDS[number],now:number):{item:NewsItem;publishedAt:number}[]{
 const results:{item:NewsItem;publishedAt:number}[]=[];
 for(const match of xml.matchAll(/<item\b[^>]*>[\s\S]*?<\/item>/gu)){
  const item=parseNewsFeed(match[0],feed,now)[0],raw=/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/iu.exec(match[0])?.[1];
  const at=Date.parse((raw??'').replace(/<!\[CDATA\[|\]\]>/gu,'').trim());
  if(item&&Number.isFinite(at)&&at<=now&&now-at<=3*DAY)results.push({item,publishedAt:at});
  if(results.length===8)break;
 }return results;
}
/** Bounded candidate collection, article verification, then one grounded model selection. */
export async function refreshControlledNews(db:D1Database,now:number,fetcher:typeof fetch,summarize:NewsSummarizer,limit=1,select?:NewsSelector):Promise<number>{
 const sources=await db.prepare("SELECT id,host,feed_url FROM controlled_sources WHERE kind='news' AND authorized=1 AND feed_url IS NOT NULL ORDER BY id LIMIT 50").all<{id:string;host:string;feed_url:string}>();
 const offset=Math.floor(now/(4*3600000))%Math.max(1,sources.results.length);
 const rotation=[...sources.results.slice(offset),...sources.results.slice(0,offset)].slice(0,4);
 const candidates:SourceDocument[]=[];
 for(const source of rotation){
  const feed=NEWS_FEEDS.find(f=>f.host===source.host&&f.url===source.feed_url);if(!feed)continue;
  const xml=await readNewsText(feed.url,fetcher);if(!xml)continue;
  for(const {item,publishedAt} of parseControlledFeed(xml,feed,now).slice(0,2)){
   if(await db.prepare('SELECT id FROM controlled_source_documents WHERE url=?').bind(item.url).first())continue;
   const article=await verifyNewsArticle(item.url,item.title,publishedAt,now,fetcher);if(!article)continue;
   const doc=await persistSourceDocument(db,{sourceId:source.id,kind:'news',url:item.url,title:article.title,body:article.body,publishedAt:article.publishedAt,fetchedAt:now,articleVerified:true,category:publisherFor(item.url)?.category??'علوم',...(article.media?{media:article.media}:{})},now);
   if(doc)candidates.push(doc);
   break;
  }
  if(candidates.length===4)break;
 }
 if(!candidates.length)return 0;
 candidates.sort((a,b)=>b.publishedAt-a.publishedAt);
 let document=candidates[0]!,raw:unknown;
 try{
  if(select){
   const recent=await db.prepare("SELECT d.body_json FROM controlled_source_documents d WHERE used_at IS NOT NULL ORDER BY used_at DESC LIMIT 6").all<{body_json:string}>();
   const selected=await select(candidates,recent.results.map(r=>String(JSON.parse(r.body_json).category??'')));
   if(!object(selected)||typeof selected.selectedId!=='string')return 0;
   const found=candidates.find(d=>d.id===selected.selectedId);if(!found)return 0;document=found;raw=selected.summary;
  }else raw=await summarize(document);
 }catch{return 0;}
 const summary=validateGroundedArabicSummary(raw,document,now);if(!summary)return 0;
 const text=renderGroundedSource(document,summary,now);
 if(text.replace(/<[^>]+>/gu,'').length>1000)return 0;
 await db.prepare("UPDATE controlled_source_documents SET approved_json=?,state='approved' WHERE id=? AND state='candidate'").bind(JSON.stringify(summary),document.id).run();
 return 1;
}
export async function queueControlledNews(db:D1Database,now:number):Promise<number>{
  const config=await getAutomationConfig(db,'news'),product=await getAutomationConfig(db,'product'),clock=getBaghdadNow(new Date(now));
  if(!config.enabled||!product.enabled)return 0;
  const settings=await new EventStore(db).getSettings();if(settings.targetChatId===null)return 0;
  const minutes=CHANNEL_TIMES.news;
  const last=await db.prepare("SELECT COUNT(*) AS n FROM controlled_deliveries WHERE family='news' AND chat_id=? AND sent_at>=?").bind(settings.targetChatId,baghdadMidnight(clock.date)).first<{n:number}>();
  if((last?.n??0)>=2)return 0;
  let count=0;
  for(const minute of minutes){
    const dueAt=Date.parse(`${clock.date}T00:00:00+03:00`)+minute*60000;if(now<dueAt||now>=dueAt+50*60000)continue;
    const source=await db.prepare(`SELECT id FROM controlled_source_documents WHERE kind='news' AND state='approved' AND used_at IS NULL AND published_at BETWEEN ? AND ? ORDER BY published_at DESC,id LIMIT 1`).bind(now-3*DAY,now).first<{id:string}>();if(!source)continue;
    if(await queueControlledJob(db,{id:`controlled:news:${settings.targetChatId}:${clock.date}:${minute}`,type:'controlled_news',payload:{sourceId:source.id,generation:config.generation},dueAt,expiresAt:dueAt+50*60000,
      chatId:settings.targetChatId,threadId:settings.targetThreadId,family:'news',config:{key:'news',generation:config.generation},contentId:source.id},now))count++;
  }return count;
}
export const controlledNewsHandler:ControlledHandler={types:['controlled_news'],async resolve(db,job,now){
  if(!object(job.payload)||typeof job.payload.sourceId!=='string')return null;
  const row=await db.prepare(`SELECT d.body_json,d.approved_json,d.used_at,s.authorized FROM controlled_source_documents d JOIN controlled_sources s ON s.id=d.source_id
    WHERE d.id=? AND d.state='approved' AND d.kind='news' AND s.kind='news'`)
    .bind(job.payload.sourceId).first<{body_json:string;approved_json:string|null;used_at:number|null;authorized:number}>();
  if(!row||row.authorized!==1||row.used_at!==null||!row.approved_json)return null;
  const document=JSON.parse(row.body_json) as SourceDocument,summary=validateGroundedArabicSummary(JSON.parse(row.approved_json),document,now);if(!summary||document.articleVerified!==true)return null;
  const settings=await new EventStore(db).getSettings();if(settings.targetChatId===null)return null;
  const meta=await db.prepare('SELECT created_at FROM controlled_jobs WHERE job_id=?').bind(job.id).first<{created_at:number}>();
  const slot=Number(job.id.split(':').at(-1));
  if(!meta||!(CHANNEL_TIMES.news as readonly number[]).includes(slot)||getBaghdadNow(new Date(meta.created_at)).date!==getBaghdadNow(new Date(now)).date)return null;
  const count=await db.prepare("SELECT COUNT(*) AS n FROM controlled_deliveries WHERE family='news' AND chat_id=? AND sent_at>=?").bind(settings.targetChatId,baghdadMidnight(getBaghdadNow(new Date(now)).date)).first<{n:number}>();
  if((count?.n??0)>=2)return null;
  const text=renderGroundedSource(document,summary,now,slot===1260),base={chat_id:settings.targetChatId,...(settings.targetThreadId===null?{}:{message_thread_id:settings.targetThreadId}),parse_mode:'HTML'};
  const media=job.payload.previewOnly===true?undefined:document.media;
  const payload:Record<string,unknown>=media&&text.replace(/<[^>]+>/gu,'').length<=1000?{...base,caption:text,[media.type==='photo'?'photo':'video']:media.url}:{...base,text,link_preview_options:{is_disabled:false,url:document.url,show_above_text:true}};
  return {chatId:settings.targetChatId,method:media&&'caption' in payload?(media.type==='photo'?'sendPhoto':'sendVideo'):'sendMessage',family:'news',config:{key:'news',generation:Number(job.payload.generation)},payload};
},async delivered(db,job,_out,_result,now){if(object(job.payload))await db.prepare("UPDATE controlled_source_documents SET used_at=COALESCE(used_at,?) WHERE id=? AND kind='news'").bind(now,job.payload.sourceId).run();}};

// Preserve source publication timestamps in new pipelines; the legacy parser exposes only calendar dates.
export function sourceNewsItem(item:NewsItem,publishedAt:number):NewsItem&{publishedAt:number}{return {...item,publishedAt};}
