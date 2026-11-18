import { build } from 'esbuild';
import { readFile,writeFile,rename,rm } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed local files only; no environment keys, fetch or live runner imported.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const input=resolve(root,'output/semantic-eval/paced-smoke-2026-10-30T18-44-20-305Z.json');
const output=resolve(root,'output/semantic-eval/phase-3f-v4-offline-rescore.json');
const before=await readFile(input),hash=createHash('sha256').update(before).digest('hex');
if(before.byteLength>4194304)throw Error('Input report too large');
if(hash!=='4842c421798ed6f9fe3cb4032f509d4db02487f3a277c2326cc014d898bf46e0')throw Error('Historical report hash mismatch');
const built=await build({entryPoints:[resolve(root,'eval/semantic-contract-replay.ts')],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {replayContractResults}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const result=await replayContractResults(JSON.parse(before.toString('utf8')));
const encoded=JSON.stringify({...result,sourceFileSha256:hash},null,2)+'\n';
if(Buffer.byteLength(encoded)>4194304)throw Error('Output report too large');
if(!before.equals(await readFile(input)))throw Error('Historical report changed');
const temporary=output+'.'+randomUUID()+'.tmp';
try {await writeFile(temporary,encoded,{flag:'wx',mode:0o600});await rename(temporary,output);}
finally {await rm(temporary,{force:true});}
console.log(JSON.stringify({mode:result.mode,output,liveRequests:0,summary:result.summary,prompt:result.prompt,totalProposedReserved:result.totalProposedReserved}));
