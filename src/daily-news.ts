import { getBaghdadNow } from './calendar';
import { generateAssistantJson,type AssistantAiEnv } from './assistant-ai';
import { escapeHtml } from './format';
import { readPublicSource } from './source-http';
import { NEWS_PUBLISHERS } from './news-registry';
export const NEWS_FEEDS = [{name:'MIT News',url:'https://news.mit.edu/rss/research',host:'news.mit.edu'},...NEWS_PUBLISHERS.filter(p=>p.feedUrl&&p.id!=='mit').map(p=>({name:p.name,url:p.feedUrl!,host:p.host})),
 {name:'ScienceDaily',url:'https://www.sciencedaily.com/rss/top/health.xml',host:'www.sciencedaily.com'},
 {name:'New Atlas',url:'https://newatlas.com/technology/index.rss',host:'newatlas.com'},
 {name:'ScienceDaily',url:'https://www.sciencedaily.com/rss/top/technology.xml',host:'www.sciencedaily.com'}] as const;
export interface NewsItem {title:string;summary:string;url:string;date:string;source:string}
export function safeNewsUrl(value:string,host?:string):boolean {
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(host?u.hostname===host:NEWS_FEEDS.some(f=>f.host===u.hostname));}catch{return false;}
}
export async function readNewsText(url:string,fetcher:typeof fetch):Promise<string|null> {
  return readPublicSource(url, fetcher, { allowed: safeNewsUrl, maxBytes: 1_000_000 });
}
function clean(s:string):string {return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_all,code:string)=>{const n=code[0]!.toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
export function parseNewsFeed(xml:string,source:typeof NEWS_FEEDS[number],now:number):NewsItem[] {
  const items:NewsItem[]=[];
  for(const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)){
    const tag=(name:string)=>clean(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`,'i').exec(match[1]!)?.[1]??'');
    const url=tag('link'),title=tag('title'),summary=tag('description')||tag('content:encoded');
    const at=Date.parse(tag('pubDate'));
    if (!safeNewsUrl(url,source.host)||!title||summary.length<60||!Number.isFinite(at)||at>now||now-at>3*86400000) continue;
    items.push({title:title.slice(0,250),summary:summary.slice(0,4500),url,date:new Date(at).toISOString().slice(0,10),source:source.name});
    if(items.length===8)break;
  }return items;
}
export async function queueDailyNews(db:D1Database,env:AssistantAiEnv,now:number,fetcher:typeof fetch=fetch):Promise<void> {
  // Superseded by the controlled two-slot news scheduler. Never revive legacy jobs.
}
export async function dailyNewsOutgoing(_db:D1Database,_raw:unknown,_now:number):Promise<{chatId:number;method:'sendMessage';payload:Record<string,unknown>}|null>{ return null; }
