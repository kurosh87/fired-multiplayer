import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, decodeCheckpoint } from '../packages/engine/checkpoint.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const [directory,tag]=process.argv.slice(2);assert(directory&&tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const root=resolve(directory),output=resolve(`build/${tag}-files.json`);assert(root.startsWith(resolve('build')+'/'));
assert(!existsSync(output));assert(!(await lstat(root)).isSymbolicLink());
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const qualificationPath='build/brock-v2-validation.json',qualification=JSON.parse(await readFile(qualificationPath,'utf8'));
assert(qualification.firstGymQualified&&qualification.cases.length===2);
const files:{path:string;bytes:number;sha256:string}[]=[];
async function visit(folder:string){
  for(const entry of await readdir(folder,{withFileTypes:true})){
    const path=resolve(folder,entry.name);assert(!entry.isSymbolicLink());
    if(entry.isDirectory())await visit(path);
    else{
      assert(entry.isFile());const name=relative(root,path);
      assert(/^(index\.html|engine-preview\.html|robots\.txt|assets\/[^/]+\.(js|css)|preview-data\/(firered|leafgreen)\/(boot\.json|[a-f0-9]{64}\.(wasm|checkpoint)))$/.test(name),`Unexpected public file: ${name}`);
      const data=await readFile(path);files.push({path:name,bytes:data.length,sha256:sha(data)});
    }
  }
}
await visit(root);
const editions=[];
for(const version of ['firered','leafgreen']){
  const boot=JSON.parse(await readFile(resolve(root,`preview-data/${version}/boot.json`),'utf8'));
  const manifest=boot.manifest as EngineManifest,proof=qualification.cases.find((value:any)=>value.version===version);
  assert(proof);assert.equal(manifest.id,proof.artifactId);assert.equal(manifest.version,version);
  assert.equal(manifest.wasmSha256,qualification.evidenceIdentities[`build/game-source/${version}/battle-text-audio-16/candidate.wasm`]);
  assert(Object.values(manifest.capabilities).every(value=>value===false));
  assert.equal(boot.artifactUrl,`/preview-data/${version}/${manifest.wasmSha256}.wasm`);
  assert(new RegExp(`^/preview-data/${version}/[a-f0-9]{64}\\.checkpoint$`).test(boot.checkpointUrl));
  const bytes=new Uint8Array(await readFile(resolve(root,'.'+boot.artifactUrl)));assert.equal(sha(bytes),manifest.wasmSha256);
  const point=new Uint8Array(await readFile(resolve(root,'.'+boot.checkpointUrl)));
  assert.equal(boot.checkpointUrl.split('/').at(-1),sha(point)+'.checkpoint');
  const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes)),engine=await WasmEngine.create(bytes,manifest,boot.seed);
  try{
    assert.equal(engine.frame,0);assert.equal(engine.digest(),boot.digest);
    assert.equal(sha(decodeCheckpoint(point,baseline,manifest.wasmSha256)),sha(engine.snapshot()),'Publish only a freshly generated boot checkpoint.');
    assert(engine.flash().every(value=>value===255),'A published boot must contain no saved adventure.');
  }finally{engine.close();}
  editions.push({version,artifactId:manifest.id,wasmSha256:manifest.wasmSha256,freshBootCheckpoint:true,emptyCartridge:true});
}
for(const path of ['index.html','engine-preview.html','robots.txt'])assert(files.some(file=>file.path===path));
assert.equal(files.filter(file=>file.path.endsWith('.wasm')).length,2);assert.equal(files.filter(file=>file.path.endsWith('.checkpoint')).length,2);
await writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),directory:root,files,totalBytes:files.reduce((n,file)=>n+file.bytes,0),editions,
  sourceSha256:sha(await readFile('scripts/check-preview-package.ts')),qualification:qualificationPath,qualificationSha256:sha(await readFile(qualificationPath)),
  noRomOrSaveFiles:true,noSourceMapsOrBackendFiles:true,onlyFreshBootCheckpoints:true,publicCapabilitiesEnabled:false},null,2)+'\n');
console.log(JSON.stringify({output,files:files.length,totalBytes:files.reduce((n,file)=>n+file.bytes,0),editions}));
