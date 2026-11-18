import {build} from 'esbuild';
import {writeFile,mkdir,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
// No dotenv/production config/credentials. Block accidental raw fetch as well as injecting fake transports.
globalThis.fetch=async()=>{throw Error('LOCAL_DEMO_NETWORK_FORBIDDEN');};
try{
 const built=await build({entryPoints:[resolve(root,'demo/product-demo.ts')],bundle:true,platform:'node',format:'esm',target:'es2023',write:false,logLevel:'silent'});
 const {runProductDemo}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
 const result=await runProductDemo();await mkdir(resolve(root,'.rebuild'),{recursive:true});const destination=resolve(root,'.rebuild/demo-result.json'),temporary=destination+'.tmp';await writeFile(temporary,JSON.stringify(result,null,2)+'\n',{mode:0o600});await rename(temporary,destination);
 console.log(JSON.stringify({status:'PASS',...result,artifact:destination}));
}catch(error){console.error('Local demo failed: '+(error instanceof Error?error.message.slice(0,200):'unknown error'));process.exitCode=1;}
