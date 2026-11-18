import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activateAi } from './activate-ai.mjs';
import { validateGroqKey } from './setup-ai.mjs';
import { writePrivateJson } from './setup.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function page(content,refresh=false) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh?'<meta http-equiv="refresh" content="2;url=/status">':''}<title>ربط دعبول مع Groq</title><style>body{font:18px system-ui;background:#10171a;color:#eef7f5;margin:0;padding:40px 20px;line-height:1.8}main{max-width:620px;margin:6vh auto;background:#19252a;padding:32px;border-radius:20px;border:1px solid #34474e}h1{font-size:28px;margin:0 0 12px}label{display:block;margin-top:24px}input{box-sizing:border-box;width:100%;padding:14px;margin:10px 0 18px;border:1px solid #61827a;border-radius:10px;background:#0e171b;color:white;font:17px monospace;direction:ltr}button{background:#80dec3;color:#09221a;border:0;border-radius:10px;padding:12px 26px;font:700 17px system-ui;cursor:pointer}a{color:#96e8d0}small{color:#bed1cf}p{overflow-wrap:anywhere}.stage{background:#0e171b;border-radius:10px;padding:16px}</style></head><body><main>${content}</main></body></html>`;
}

/** Loopback-only credential handoff. No key is put in a URL, response, or log. */
export async function startAiSetupServer({activate=activateAi,directory=ROOT,skipChecks=false,ttl=30*60_000,saveStatus=true}={}) {
  const nonce=randomBytes(32).toString('hex');let origin='';let busy=false;let finished=false;
  let state={phase:'waiting',message:'بانتظار المفتاح؛ البوت المنشور لم يتغيّر.'};
  const persist=()=>saveStatus?writePrivateJson(join(directory,'.local','assistant-activation-status.json'),state):Promise.resolve();
  const server=createServer(async(request,response)=>{
    const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
    const send=(code,html)=>{response.writeHead(code,headers);response.end(html);};
    try {
      if(request.headers.host!==new URL(origin).host) {send(403,page('<h1>طلب غير مسموح</h1>'));return;}
      const path=new URL(request.url??'/',origin).pathname;
      if(request.method==='GET'&&path==='/') {
        if(busy||finished) {response.writeHead(303,{Location:'/status','Cache-Control':'no-store'});response.end();return;}
        send(200,page(`<h1>ربط دعبول مع Groq</h1><p>الصق مفتاحك مرة واحدة، والباقي يصير تلقائياً: فحص المفتاح، تجهيز قاعدة البيانات، نشر التحديث وتفعيل التذكيرات.</p><form method="post" action="/activate" autocomplete="off"><input type="hidden" name="csrf" value="${nonce}"><label for="key">مفتاح Groq API</label><input id="key" name="key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="24" maxlength="256" placeholder="gsk_…" required autofocus><button type="submit">ربط وتشغيل دعبول</button></form><p><small>هذه صفحة محلية على جهازك. يُحفظ المفتاح بملف خاص ويُرفع إلى أسرار البوت في Cloudflare؛ لا يظهر بالكروب أو المحادثة.</small></p><a href="https://console.groq.com/keys" rel="noreferrer" target="_blank">فتح صفحة إنشاء المفتاح</a>`));return;
      }
      if(request.method==='GET'&&path==='/status') {
        const success=state.phase==='complete';
        send(200,page(`<h1>${success?'دعبول جاهز ✅':state.phase==='failed'?'تعذّر إكمال الربط':'جارٍ تجهيز دعبول'}</h1><p class="stage">${escape(state.message)}</p>${success?'<p>تگدر تحچي وياه بالخاص أو تمنشنه بالكروب. التبليغات الجديدة تنحفظ تلقائياً حسب كلام الطالب.</p>':''}${state.phase==='failed'?'<p>المفتاح ما يظهر هنا. بعد معالجة السبب تگدر تعيد المحاولة بنفس المفتاح.</p><a href="/">الرجوع للإعداد</a>':''}`,busy));return;
      }
      if(request.method!=='POST'||path!=='/activate') {send(404,page('<h1>الصفحة غير موجودة</h1>'));return;}
      if(request.headers.origin!==origin || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {send(403,page('<h1>الطلب لازم يجي من صفحة الإعداد نفسها</h1>'));return;}
      if(busy||finished) {send(409,page('<h1>طلب الربط قيد المعالجة أو مكتمل</h1>'));return;}
      let body='';let bytes=0;
      for await(const chunk of request) {bytes+=chunk.length;if(bytes>2048){send(413,page('<h1>الإدخال أطول من المطلوب</h1>'));request.destroy();return;}body+=chunk.toString('utf8');}
      const data=new URLSearchParams(body);const csrf=data.get('csrf')??'';
      if(!/^[a-f\d]{64}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf),Buffer.from(nonce))) {send(403,page('<h1>حدّث صفحة الإعداد وأعد المحاولة</h1>'));return;}
      let key;
      try {key=validateGroqKey(data.get('key'));}catch {send(400,page('<h1>المفتاح غير صالح</h1><p>انسخ Groq API key كاملاً، ثم ارجع وأعد المحاولة.</p><a href="/">رجوع</a>'));return;}
      body='';busy=true;state={phase:'running',message:'جارٍ فحص مفتاح Groq…'};await persist();
      response.writeHead(303,{Location:'/status','Cache-Control':'no-store'});response.end();
      void (async()=>{
        try {
          const result=await activate(key,{directory,skipChecks,onProgress:async message=>{state={phase:'running',message};await persist();}});
          state={phase:'complete',message:result.remindersEnabled===false?'اشتغل المساعد على البوت. التذكيرات تحتاج تحديد وجهة النشر من المالك.':'اكتمل الربط والنشر وتفعيل التذكيرات بنجاح.',workerUrl:result.workerUrl};finished=true;
        }catch(error) {
          // Activation errors are authored safe messages; never expose nested provider/CLI output.
          state={phase:'failed',message:error instanceof Error?error.message.replaceAll(key,'[مفتاح محجوب]').replace(/gsk_[a-zA-Z0-9_-]+/g,'[مفتاح محجوب]'):'تعذّر إكمال الربط. أعد المحاولة.'};
        }finally {key='';busy=false;await persist();}
      })();
    }catch {if(!response.headersSent)send(500,page('<h1>تعذّر إكمال الطلب المحلي</h1>'));else response.end();}
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  origin=`http://127.0.0.1:${server.address().port}`;
  await persist();
  const timeout=setTimeout(()=>{if(!busy)server.close();},ttl);timeout.unref();
  return {url:origin,close:()=>new Promise(resolveClose=>{clearTimeout(timeout);server.close(resolveClose);}),status:()=>({...state})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.slice(2).some(arg=>arg!=='--checks-passed')) {console.error('خيار إعداد غير معروف.');process.exitCode=1;}
  else startAiSetupServer({skipChecks:process.argv.includes('--checks-passed')}).then(server=>{console.log(JSON.stringify({status:'waiting_for_key',url:server.url}));}).catch(()=>{console.error('تعذّر تشغيل صفحة الإعداد المحلية.');process.exitCode=1;});
}
