import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { startAiSetupServer } from './setup-ai-server.mjs';

const KEY='synthetic-groq-key';
const request=(url,options={})=>fetch(url,{...options,headers:{Connection:'close',...options.headers}});
async function token(server) {const response=await request(server.url);const html=await response.text();return {response,html,csrf:/name="csrf" value="([a-f\d]+)"/.exec(html)[1]};}
const post=(server,csrf,key=KEY,origin=server.url)=>request(`${server.url}/activate`,{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,key})});

test('local key form rejects cross-site, missing nonce and wrong host without activation',async()=>{
  let calls=0;const server=await startAiSetupServer({saveStatus:false,activate:async()=>{calls++;return {workerUrl:'https://example.workers.dev'};}});
  try {
    const {response,html,csrf}=await token(server);assert.equal(response.status,200);assert.match(html,/type="password"/);assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
    assert.equal((await post(server,csrf,KEY,'https://foreign.example')).status,403);assert.equal((await post(server,'')).status,403);
    const rejectedHost=await new Promise((resolveStatus,reject)=>{const address=new URL(server.url);const call=httpRequest({hostname:address.hostname,port:address.port,path:'/',headers:{Host:'foreign.example',Connection:'close'}},response=>{response.resume();resolveStatus(response.statusCode);});call.once('error',reject);call.end();});
    assert.equal(rejectedHost,403);assert.equal(calls,0);
  }finally {await server.close();}
});
test('only one submission runs and neither HTML nor status exposes the pasted key',async()=>{
  let release;let received;const gate=new Promise(resolve=>{release=resolve;});
  const server=await startAiSetupServer({saveStatus:false,activate:async(key,{onProgress})=>{received=key;await onProgress('جارٍ التحديث…');await gate;return {workerUrl:'https://example.workers.dev',remindersEnabled:true};}});
  try {
    const {csrf}=await token(server);assert.equal((await post(server,csrf)).status,303);assert.equal(received,KEY);
    assert.equal((await post(server,csrf)).status,409);const running=await (await request(`${server.url}/status`)).text();assert.ok(!running.includes(KEY));assert.match(running,/جارٍ التحديث/);
    release();await new Promise(resolve=>setImmediate(resolve));assert.equal(server.status().phase,'complete');
    const complete=await (await request(`${server.url}/status`)).text();assert.ok(!complete.includes(KEY));assert.match(complete,/اكتمل الربط/);
  }finally {release();await server.close();}
});
test('a failed activation reports failure safely and allows a retry',async()=>{
  const server=await startAiSetupServer({saveStatus:false,activate:async()=>{throw new Error(`اختبار خطأ يحتوي ${KEY}`);}});
  try {
    const {csrf}=await token(server);await post(server,csrf);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(server.status().phase,'failed');assert.ok(!server.status().message.includes(KEY));assert.match(server.status().message,/محجوب/);
    const again=await request(server.url);assert.equal(again.status,200);
    assert.equal((await post(server,csrf,'invalid-key')).status,400);
  }finally {await server.close();}
});
