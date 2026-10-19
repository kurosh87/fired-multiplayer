import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
assert.equal(process.env.NODE_ENV,'production','Use NODE_ENV=production for both builds.');
const output=process.argv[2];assert(output&&/^build\/[a-z0-9-]+$/.test(output)&&!existsSync(output));
await mkdir(output);
const oldEntry='build/netlify-accounts-release-1792244496/source/apps/web/src/main.tsx';
const baseline=await readFile(oldEntry,'utf8'),entry=resolve('apps/web/src/main.tsx');
assert(baseline.includes("import { Game } from './game.tsx'"));assert(!baseline.includes('const Game = lazy'));
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const measurements=[];
for(const label of ['before','after'] as const){
  let replacements=0;const directory=resolve(output,label);
  await build({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),
    define:{'import.meta.env.VITE_ACCOUNT_PROVIDER':JSON.stringify('better-auth'),'import.meta.env.VITE_API_URL':JSON.stringify('https://game-build-check.invalid')},
    plugins:label==='before'?[{name:'retained-entry-baseline',enforce:'pre',load(id){if(id===entry){replacements++;return baseline;}}}]:[],
    build:{outDir:directory,emptyOutDir:false,sourcemap:false,manifest:true}});
  assert.equal(replacements,label==='before'?1:0);
  const manifest:Record<string,{file:string;imports?:string[];isEntry?:boolean}>=JSON.parse(await readFile(resolve(directory,'.vite/manifest.json'),'utf8'));
  const main=Object.keys(manifest).find(key=>manifest[key]!.isEntry);assert(main);
  const closure=new Set<string>();function visit(key:string){if(closure.has(key))return;closure.add(key);for(const child of manifest[key]!.imports??[])visit(child);}visit(main);
  const initialJavaScript=await Promise.all([...closure].map(async key=>{
    const path=manifest[key]!.file,bytes=await readFile(resolve(directory,path));
    assert(!bytes.toString().includes('is using incorrect casing'),'React development runtime leaked into production output');
    return {path,bytes:bytes.length,gzipBytes:gzipSync(bytes,{level:6}).length,sha256:hash(bytes)};
  }));
  measurements.push({label,initialJavaScript,bytes:initialJavaScript.reduce((sum,item)=>sum+item.bytes,0),gzipBytes:initialJavaScript.reduce((sum,item)=>sum+item.gzipBytes,0)});
}
const [before,after]=measurements;assert(before&&after);assert(after.bytes<before.bytes);
const report={checkedAt:new Date().toISOString(),nodeEnv:process.env.NODE_ENV,baselineEntry:oldEntry,baselineEntrySha256:hash(baseline),
  currentEntrySha256:hash(await readFile(entry)),measurements,initialBytesReductionPercent:100*(1-after.bytes/before.bytes),gzipReductionPercent:100*(1-after.gzipBytes/before.gzipBytes),
  scope:'Same production environment, endpoint and current dependencies. Baseline replaces only the main entry with its retained pre-split source; current styles are shared. Initial JavaScript excludes deferred screen chunks and WASM. No physical-device FPS claim.'};
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
