import assert from 'node:assert/strict';
import {createServer as reservePort} from 'node:http';
import {createServer} from 'vite';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createApp} from '../apps/server/src/app.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const output=process.argv[2];assert(output&&/^build\/[a-z0-9-]+$/.test(output)&&!existsSync(output),'Choose a fresh build output.');
const reservation=reservePort();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done));
const address=reservation.address();assert(address&&typeof address!=='string');const port=address.port,origin=`http://127.0.0.1:${port}`;
await new Promise<void>(done=>reservation.close(()=>done()));
const app=await createApp({origin,engineDirectory:resolve('engine/artifacts'),publicRelease:false});
let web:Awaited<ReturnType<typeof createServer>>|undefined;
try{
  const base=await app.listen({host:'127.0.0.1',port:0});
  web=await createServer({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),cacheDir:resolve('build/web-local-vite-cache'),logLevel:'warn',
    define:{'import.meta.env.VITE_ACCOUNT_PROVIDER':JSON.stringify('supabase'),'import.meta.env.VITE_SUPABASE_URL':'""','import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':'""','import.meta.env.VITE_API_URL':JSON.stringify(base)},
    server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[resolve('.')]}}});await web.listen();
  const code=await new Promise<number|null>((done,reject)=>{
    const child=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','playwright.config.ts'],{
      env:{...process.env,KANTO_WEB_URL:origin},stdio:'inherit'});child.once('error',reject);child.once('exit',done);
  });assert.equal(code,0,'Main UI browser checks failed.');
  const productionConfig={root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),
    define:{'import.meta.env.VITE_ACCOUNT_PROVIDER':JSON.stringify('better-auth'),'import.meta.env.VITE_API_URL':JSON.stringify('https://game-build-check.invalid')},
    build:{outDir:resolve(output),emptyOutDir:false,sourcemap:false}};
  // createServer sets NODE_ENV=development in this process. Compile in a fresh
  // production process so the build does not accidentally include React's dev
  // runtime. The child keeps the same actual guard lease and owned output.
  const buildCode=await new Promise<number|null>((done,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','--eval',
      "import {build} from 'vite'; await build(JSON.parse(process.argv[1]));",JSON.stringify(productionConfig)],
      {env:{...process.env,NODE_ENV:'production'},stdio:'inherit'});
    child.once('error',reject);child.once('exit',done);
  });assert.equal(buildCode,0,'Production compilation failed.');
  console.log(JSON.stringify({ownedFrontend:true,legacyMainUiPassed:true,betterAuthProductionCompilationPassed:true,
    output,deployableEndpointConfigured:false}));
}finally{await web?.close();await app.close();}
