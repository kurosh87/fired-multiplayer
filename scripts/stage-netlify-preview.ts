import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build, version } from 'esbuild';
import {buildNetlifyBattleRuntime} from './build-netlify-battle-runtime.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the project resource guard.');
const stage=resolve(homedir(),'.local/share/kanto-netlify-accounts-v1');
const battlePreview=process.argv.includes('--battle-preview');
if(battlePreview){
  const proof=resolve(process.env.KANTO_NETLIFY_BATTLE_PROOF??'');
  assert(proof.startsWith(resolve('build')+'/'),'Provide the native Netlify battle proof.');
  const report=JSON.parse(await readFile(proof,'utf8'));
  assert.equal(report.databaseMajor,18);
  assert.equal(JSON.parse(await readFile(resolve(proof,'../netlify-battles-local-report.json'),'utf8')).serviceRecreatedExactReply,true);
  const role=JSON.parse(await readFile(resolve(proof,'../game-role-switch-report.json'),'utf8'));
  assert(role.managedAdapterRestrictsPrivilegedLogin && role.managedAdapterRollbackAndReuse);
  for(const [path,hash] of Object.entries(report.sourceSha256))
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),hash,`Native source changed: ${path}`);
}
const source=resolve(process.env.KANTO_PREVIEW_OUTPUT??'build/netlify-accounts-v4');
for(const entry of await readdir('netlify/database/migrations'))assert(!(await readFile('netlify/database/migrations/'+entry+'/migration.sql','utf8')).startsWith('-- Write your migration'),'Finish and qualify every migration before staging.');
assert(source.startsWith(resolve('build')+'/'));
assert.equal(JSON.parse(await readFile(stage+'/.netlify/state.json','utf8')).siteId,'4fcf6389-9abb-4239-8134-d99fa08b85d8');
if(existsSync(stage+'/public')) {
  assert(process.argv.includes('--retain-previous'),'Preserve the previous staging bundle; pass --retain-previous to move it into retained/.');
  const prior=JSON.parse(await readFile(stage+'/bundle-manifest.json','utf8'));
  for(const [path,hash] of Object.entries(prior.hashes))assert.equal(createHash('sha256').update(await readFile(stage+'/'+path)).digest('hex'),hash);
  const retained=stage+'/retained/'+Date.now();await mkdir(retained,{recursive:true,mode:0o700});
  for(const path of ['public','functions','netlify.toml','bundle-manifest.json','verify-bundle.mjs','build'])
    if(existsSync(stage+'/'+path))await rename(stage+'/'+path,retained+'/'+path);
}
await mkdir(stage+'/functions',{recursive:true});
await build({entryPoints:['netlify/functions/cloud.mts'],outfile:stage+'/functions/cloud.mjs',bundle:true,platform:'node',target:'node24',
  format:'esm',external:['pg-native'],sourcemap:false,metafile:true,
  banner:{js:'import { createRequire as kantoCreateRequire } from "node:module"; const require = kantoCreateRequire(import.meta.url);'}});
if(battlePreview){
  await buildNetlifyBattleRuntime(stage+'/build/netlify-battle-runtime');
  await build({entryPoints:['netlify/functions/battles.mts'],outfile:stage+'/functions/battles.mjs',bundle:true,platform:'node',target:'node24',
    format:'esm',external:['pg-native'],sourcemap:false,
    banner:{js:'import { createRequire as kantoCreateRequire } from "node:module"; const require = kantoCreateRequire(import.meta.url);'}});
}
await cp(source,stage+'/public',{recursive:true,errorOnExist:true,force:false});
await cp('netlify/database/migrations',stage+'/netlify/database/migrations',{recursive:true});
await writeFile(stage+'/netlify.toml',(await readFile('netlify.toml','utf8')).replace('command = "npm run build:preview"','command = "node verify-bundle.mjs"')
  .replace('publish = "build/netlify-preview"','publish = "public"').replace('directory = "netlify/functions"','directory = "functions"'));
const hashes:Record<string,string>={};
for(const top of ['public','functions','netlify/database/migrations',...(battlePreview?['build/netlify-battle-runtime']:[])])for(const name of await readdir(stage+'/'+top,{recursive:true,withFileTypes:true})){
  if(!name.isFile())continue;const path=resolve(name.parentPath,name.name),relative=path.slice(stage.length+1);
  hashes[relative]=createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile(stage+'/bundle-manifest.json',JSON.stringify({builtAt:new Date().toISOString(),siteId:'4fcf6389-9abb-4239-8134-d99fa08b85d8',battlePreview,esbuild:version,hashes},null,2)+'\n');
await writeFile(stage+'/verify-bundle.mjs',`import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const manifest=JSON.parse(await readFile('bundle-manifest.json','utf8'));
for(const [path,hash] of Object.entries(manifest.hashes)){if(createHash('sha256').update(await readFile(path)).digest('hex')!==hash)throw new Error('Bundle changed: '+path);}
console.log('Verified Kanto browser, Function and migration bundle.');\n`);
await writeFile('build/netlify-accounts-bundle.json',JSON.stringify({stage,source,esbuild:version,files:Object.keys(hashes).length,
  siteId:'4fcf6389-9abb-4239-8134-d99fa08b85d8',localStateIgnored:true},null,2)+'\n');
console.log(JSON.stringify({stage,files:Object.keys(hashes).length,esbuild:version}));
