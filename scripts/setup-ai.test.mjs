import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { main, promptGroqKey, uploadGroqKey, validateGroqKey } from './setup-ai.mjs';

const KEY='synthetic-groq-key';
test('Groq setup accepts only a key value and never permits command-line secret entry',async()=>{
  assert.equal(validateGroqKey(` ${KEY} `),KEY);assert.throws(()=>validateGroqKey('not-a-key'));
  await assert.rejects(main(['--key',KEY]),/الأوامر المدعومة/);
});
test('hidden Groq input restores the terminal without echoing the secret',async()=>{
  const input=new PassThrough();input.isTTY=true;input.isRaw=false;input.setRawMode=value=>{input.isRaw=value;};
  const output=new PassThrough();output.isTTY=true;let shown='';output.on('data',chunk=>{shown+=chunk;});
  const pending=promptGroqKey({input,output});input.write(`${KEY}\r`);assert.equal(await pending,KEY);
  assert.equal(input.isRaw,false);assert.ok(shown.includes('GROQ_API_KEY'));assert.ok(!shown.includes(KEY));
  assert.throws(()=>promptGroqKey({input:new PassThrough(),output}),/Terminal/);
});
test('local setup writes a private ignored file and never uploads unless requested',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'daabool-ai-test-'));
  try {
    const file=join(directory,'.local','assistant-secrets.json');let uploads=0;let shown='';const output={write:value=>{shown+=value;}};
    await main([],{file,prompt:async()=>KEY,upload:async()=>{uploads++;},output});
    assert.equal(uploads,0);assert.equal((await stat(file)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(file,'utf8')).GROQ_API_KEY,KEY);
    await main(['--check'],{file,output});assert.ok(!shown.includes(KEY));
    await main(['--upload'],{file,upload:async key=>{assert.equal(key,KEY);uploads++;},output});assert.equal(uploads,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('upload supplies the key through stdin and suppresses credential-bearing child output',async()=>{
  let stdin='';let called;
  const spawnImpl=(command,args,options)=>{
    called={command,args,options};const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin.on('data',chunk=>{stdin+=chunk;});child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.write(KEY);child.stderr.write(KEY);child.emit('close',0);});return child;
  };
  await uploadGroqKey(KEY,{spawnImpl});assert.equal(stdin,`${KEY}\n`);assert.ok(called.args.includes('GROQ_API_KEY'));assert.ok(!called.args.includes(KEY));assert.deepEqual(called.options.stdio,['pipe','pipe','pipe']);
});
