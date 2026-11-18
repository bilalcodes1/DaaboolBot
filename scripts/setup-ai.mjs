import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPrivateJson, writePrivateJson } from './setup.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const FILE=join(ROOT,'.local','assistant-secrets.json');
export function validateGroqKey(value) {
  if(typeof value!=='string' || !/^gsk_[a-zA-Z0-9_-]{20,240}$/.test(value.trim())) throw new Error('المفتاح غير صالح؛ انسخ Groq API key من حسابك.');
  return value.trim();
}
export function promptGroqKey({input=process.stdin,output=process.stdout}={}) {
  if(!input.isTTY || !output.isTTY || typeof input.setRawMode!=='function') throw new Error('شغّل npm run setup:ai في Terminal محلي تفاعلي؛ إدخال المفتاح مخفي.');
  return new Promise((resolveKey,reject)=>{
    let value='';let finished=false;const previous=Boolean(input.isRaw);
    const finish=(error)=>{if(finished)return;finished=true;input.off('data',onData);input.off('error',onError);input.off('end',onEnd);process.off('SIGINT',onCancel);process.off('SIGTERM',onCancel);input.setRawMode(previous);input.pause();output.write('\n');const key=value;value='';error?reject(error):resolveKey(key);};
    const onError=()=>finish(new Error('تعذر إدخال المفتاح.'));const onEnd=()=>finish(new Error('انتهى الإدخال قبل استلام المفتاح.'));const onCancel=()=>finish(new Error('أُلغي إدخال المفتاح.'));
    const onData=(chunk)=>{for(const char of String(chunk)) {if(char==='\u0003'||char==='\u0004'){onCancel();return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(/^[\x20-\x7e]$/.test(char))value+=char;else {onError();return;}if(value.length>256){onError();return;}}};
    input.on('data',onData);input.once('error',onError);input.once('end',onEnd);process.once('SIGINT',onCancel);process.once('SIGTERM',onCancel);
    input.setRawMode(true);output.write('ألصق GROQ_API_KEY (الإدخال مخفي)، ثم Enter: ');input.resume();
  });
}
export async function uploadGroqKey(key,{spawnImpl=spawn}={}) {
  key=validateGroqKey(key);
  await new Promise((resolveUpload,reject)=>{
    const child=spawnImpl(process.execPath,[join(ROOT,'node_modules/wrangler/bin/wrangler.js'),'secret','put','GROQ_API_KEY'],{cwd:ROOT,stdio:['pipe','pipe','pipe'],env:process.env});
    // Wrangler output is not forwarded: provider/CLI diagnostics must never echo secrets.
    child.stdout?.resume();child.stderr?.resume();child.stdin.on('error',()=>{});
    const timeout=setTimeout(()=>{child.kill();reject(new Error('انتهت مهلة رفع المفتاح.'));},90_000);
    child.once('error',()=>{clearTimeout(timeout);reject(new Error('تعذّر تشغيل Wrangler.'));});
    child.once('close',(code)=>{clearTimeout(timeout);code===0?resolveUpload():reject(new Error('تعذّر رفع المفتاح؛ تأكد من تفويض Cloudflare وأعد المحاولة.'));});
    child.stdin.end(`${key}\n`);
  });
}
export async function main(args=process.argv.slice(2),{file=FILE,prompt=promptGroqKey,upload=uploadGroqKey,output=process.stdout}={}) {
  if(args.some(arg=>!['--upload','--replace','--check'].includes(arg))) throw new Error('الأوامر المدعومة: --check أو --replace أو --upload. لا تضع المفتاح ضمن الأمر.');
  let saved=await readPrivateJson(file);
  if(args.includes('--check')) {output.write(saved?.GROQ_API_KEY?'مفتاح Groq محفوظ محلياً؛ لم يُفحص أو يُنشر عن بعد.\n':'لا يوجد مفتاح Groq محفوظ محلياً.\n');return;}
  if(!saved?.GROQ_API_KEY || args.includes('--replace')) {
    saved={GROQ_API_KEY:validateGroqKey(await prompt())};await writePrivateJson(file,saved);
    output.write('حُفظ مفتاح Groq محلياً بصلاحيات 0600؛ لم يُنشر أي تغيير على البوت.\n');
  }
  if(args.includes('--upload')) {await upload(validateGroqKey(saved.GROQ_API_KEY));output.write('رُفع مفتاح Groq إلى أسرار Worker. تأكد من تطبيق migrations ونشر الإصدار الجديد.\n');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(error=>{console.error(error instanceof Error?error.message:'تعذر إعداد Groq.');process.exitCode=1;});
