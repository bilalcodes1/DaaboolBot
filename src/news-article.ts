import { readPublicSource } from './source-http';
import { publisherFor } from './news-registry';

export interface ArticleMedia {type:'photo'|'video';url:string;license:string;credit:string;articleUrl:string}
export interface VerifiedArticle {title:string;body:string;publishedAt:number;media?:ArticleMedia;imagePreview?:string}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function cleanArticle(value:string):string {return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();}
function attrs(tag:string):Record<string,string>{return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1]!.toLowerCase(),m[2]!.replace(/&amp;/g,'&')]));}
function safeUrl(value:string,article:string):boolean{try{const u=new URL(value),a=new URL(article);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname===a.hostname||u.hostname.endsWith('.'+a.hostname.replace(/^www\./,'')));}catch{return false;}}
function metadata(html:string):Record<string,string>{const result:Record<string,string>={};for(const tag of html.matchAll(/<meta\s[^>]*>/gi)){const a=attrs(tag[0]);if(a.property||a.name)result[a.property??a.name!]=a.content??'';}return result;}
function structured(html:string):Record<string,unknown>[] {const result:Record<string,unknown>[]=[];for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const raw:unknown=JSON.parse(m[1]!);const rows=Array.isArray(raw)?raw:object(raw)&&Array.isArray(raw['@graph'])?raw['@graph']:[raw];for(const row of rows)if(object(row))result.push(row);}catch{}}return result.slice(0,100);}
function sameArticle(a:string,b:string):boolean {try{const clean=(s:string)=>{const u=new URL(s);return u.origin+u.pathname.replace(/\/$/,'');};return clean(a)===clean(b);}catch{return false;}}
/** Only article-level licensed media. An og:image alone grants no reuse permission. */
export function parseVerifiedArticle(html:string,url:string,feedTitle:string,feedPublished:number,now:number):VerifiedArticle|null {
 const meta=metadata(html),rows=structured(html),article=rows.find(r=>/Article|NewsArticle|BlogPosting/u.test(String(r['@type']))&&(!r.url||sameArticle(String(r.url),url)));
 const canonical=meta['og:url'];if(canonical&&!sameArticle(canonical,url))return null;
 if(article?.isAccessibleForFree===false||article?.isAccessibleForFree==='False')return null;
 const title=cleanArticle(String(article?.headline??meta['og:title']??''));if(!title||title.length>250)return null;
 // Match the actual article to the feed. Locale-independent Unicode word overlap, not a guessed URL.
 const words=(s:string)=>new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[]),a=words(title),b=words(feedTitle);
 if(!b.size||[...b].filter(w=>a.has(w)).length/Math.min(a.size,b.size)<0.55)return null;
 const dateRaw=article?.datePublished??meta['article:published_time']??meta['datePublished'];
 const publishedAt=dateRaw?Date.parse(String(dateRaw)):feedPublished;
 if(!Number.isFinite(publishedAt)||publishedAt>now||now-publishedAt>72*3600000||Math.abs(publishedAt-feedPublished)>86400000)return null;
 const main=/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i.exec(html)?.[1]??'';
 const body=cleanArticle(typeof article?.articleBody==='string'?article.articleBody:main).slice(0,10000);
 if(body.length<180)return null;
 let media:ArticleMedia|undefined;
 for(const key of ['video','image'] as const){
  const values=Array.isArray(article?.[key])?article[key]:[article?.[key]];
  for(const v of values){if(!object(v))continue;const link=String(v.contentUrl??v.url??''),license=String(v.license??''),credit=typeof v.creditText==='string'?v.creditText:object(v.creator)&&typeof v.creator.name==='string'?v.creator.name:'';
   if(!safeUrl(link,url)||!/^https:\/\/creativecommons.org\/(?:licenses\/by\/4.0|publicdomain\/zero\/1.0)\/?$/u.test(license)||!credit.trim()||credit.length>120)continue;
   if(key==='video'&&!/\.mp4(?:\?|$)/iu.test(link))continue;
   if(key==='image'&&!/\.(?:jpe?g|png|webp)(?:\?|$)/iu.test(link))continue;
   media={type:key==='video'?'video':'photo',url:link,license,credit,articleUrl:url};break;
  }if(media)break;
 }
 return {title,body,publishedAt,...(media?{media}:{}),...(safeUrl(meta['og:image']??'',url)?{imagePreview:meta['og:image']}: {})};
}
export async function verifyNewsArticle(url:string,title:string,publishedAt:number,now:number,fetcher:typeof fetch):Promise<VerifiedArticle|null>{
 const p=publisherFor(url);if(!p)return null;
 const html=await readPublicSource(url,fetcher,{allowed:value=>{try{return new URL(value).hostname===p.host&&safeUrl(value,url);}catch{return false;}},maxBytes:700000,redirects:2});
 if(!html)return null;
 const article=parseVerifiedArticle(html,url,title,publishedAt,now);if(!article?.media)return article;
 try{const response=await fetcher(article.media.url,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(4000)});const type=response.headers.get('content-type')??'',size=Number(response.headers.get('content-length'));
  if(!response.ok||!size||size>(article.media.type==='photo'?10:20)*1024*1024||!(article.media.type==='photo'?/^image\/(jpeg|png|webp)/:/^video\/mp4/).test(type))delete article.media;
  await response.body?.cancel();
 }catch{delete article.media;}
 return article;
}
