import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import type {EngineManifest} from '../packages/engine/runtime.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint} from '../packages/engine/checkpoint.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)throw new Error('Use the shared build guard.');
const original=resolve(process.argv[2]??'build/game-source/firered'),candidate=resolve(process.argv[3]??`${original}/memory-16`);
type Core=WebAssembly.Exports&{memory:WebAssembly.Memory;[name:string]:any};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function load(directory:string){
  const bytes=new Uint8Array(await readFile(resolve(directory,'candidate.wasm'))),manifest=JSON.parse(await readFile(resolve(directory,'candidate.json'),'utf8')) as EngineManifest;
  assert.equal(hash(bytes),manifest.wasmSha256);assert.equal(manifest.status,'experimental');assert(Object.values(manifest.capabilities).every(value=>value===false));
  const module=await WebAssembly.compile(bytes);assert.deepEqual(WebAssembly.Module.imports(module),[]);
  return {bytes,manifest,module,layout:JSON.parse(await readFile(resolve(directory,'memory-layout.json'),'utf8'))};
}
const [old,next]=await Promise.all([load(original),load(candidate)]);
assert.equal(next.manifest.version,old.manifest.version);assert.equal(next.manifest.upstreamCommit,old.manifest.upstreamCommit);
for(const field of ['staticBase','readonlyBytes','mutableBase','mutableEnd','mutableBytes'])assert.equal(next.layout[field],old.layout[field]);
const version=next.manifest.version,replayPath=`tests/replays/${version==='firered'?'starter-rival-save':'leafgreen-starter-rival-save'}.json`;
const replayBytes=await readFile(replayPath),replay=JSON.parse(replayBytes.toString('utf8'));
assert.equal(replay.sourceCommit,next.manifest.upstreamCommit);
async function fresh(module:WebAssembly.Module){
  const core=(await WebAssembly.instantiate(module,{})).exports as Core;
  new Uint8Array(core.memory.buffer,core.kanto_flash_ptr(),core.kanto_flash_size()).fill(0xff);
  assert.equal(core.kanto_boot(replay.seed,0),0);assert.equal(core.kanto_after_restore(),0);return core;
}
const [a,b]=await Promise.all([fresh(old.module),fresh(next.module)]);
assert.equal(a.memory.buffer.byteLength,64*1024*1024);assert.equal(b.memory.buffer.byteLength,16*1024*1024);
const scratchEnd=Number(b.__heap_base.value)+next.layout.mutableBytes;
assert(scratchEnd<=b.memory.buffer.byteLength,'The complete canonical state cannot fit in serialization scratch.');
function canonical(core:Core):Uint8Array{return new Uint8Array(core.memory.buffer,core.kanto_state_ptr(),core.kanto_state_size());}
function pixels(core:Core):Uint8Array{return new Uint8Array(core.memory.buffer,core.kanto_framebuffer_ptr(),core.kanto_framebuffer_size());}
const assets=new Uint8Array(a.memory.buffer,a.kanto_immutable_ptr(),a.kanto_immutable_size()).slice();
const baseline=await createCheckpointBaseline(next.module),milestones=new Set<number>(replay.milestones.map((point:{frame:number})=>point.frame));
let frames=0,boundaries=0,screenChecks=0;const points=[];
function same(){
  assert.equal(a.kanto_frame(),b.kanto_frame());
  assert.equal(Buffer.compare(canonical(a),canonical(b)),0,`Canonical state diverged at ${frames}.`);boundaries++;
  assert.equal(Buffer.compare(pixels(a),pixels(b)),0,`Rendered pixels diverged at ${frames}.`);screenChecks++;
}
same();
for(const run of replay.runs){
  let remaining=run.frames;
  while(remaining){
    let count=Math.min(16-frames%16,remaining);
    for(const point of milestones)if(point>frames)count=Math.min(count,point-frames);
    assert(count>0);assert.equal(a.kanto_step(run.buttons,count),0);assert.equal(b.kanto_step(run.buttons,count),0);
    frames+=count;remaining-=count;
    if(frames%16===0||milestones.has(frames))same();
    if(milestones.has(frames)){
      assert.equal(Buffer.compare(assets,new Uint8Array(b.memory.buffer,b.kanto_immutable_ptr(),b.kanto_immutable_size())),0);
      const memory=new Uint8Array(b.memory.buffer),point=encodeCheckpoint(memory,baseline,next.manifest.wasmSha256);
      const decoded=decodeCheckpoint(point,baseline,next.manifest.wasmSha256);assert.equal(Buffer.compare(memory,decoded),0);
      const restored=await fresh(next.module);new Uint8Array(restored.memory.buffer).set(decoded);assert.equal(restored.kanto_after_restore(),0);
      assert.equal(Buffer.compare(canonical(b),canonical(restored)),0);
      points.push({frame:frames,packedBytes:point.byteLength,completeMemoryRoundTrip:true});
    }
  }
}
assert.equal(frames,replay.expectedFrames);same();
const flash=new Uint8Array(b.memory.buffer,b.kanto_flash_ptr(),b.kanto_flash_size());
assert.equal(Buffer.compare(flash,await readFile(resolve(original,'gameplay.sav'))),0,'The smaller core changed the independently qualified cartridge.');
const originalReport=JSON.parse(await readFile(resolve(original,'gameplay-report.json'),'utf8'));
assert.equal(originalReport.artifactId,old.manifest.id);assert(originalReport.independentGbaReadback);
const paths=['scripts/link-candidate.py','scripts/check-memory-candidate.ts','engine/port/native_platform.c','engine/port/kanto_bridge.c','packages/engine/checkpoint.ts'];
const report={artifacts:[old.manifest.id,next.manifest.id],sourceSha256:Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))]))),
  replaySha256:hash(replayBytes),version,frames,comparisonBoundaries:boundaries,screenChecks,canonicalStateBytes:canonical(b).byteLength,
  originalLinearMemoryBytes:a.memory.buffer.byteLength,linearMemoryBytes:b.memory.buffer.byteLength,
  serializationScratchEnd:scratchEnd,remainingLinearBytes:b.memory.buffer.byteLength-scratchEnd,staticLayoutUnchanged:true,
  originalCanonicalBytesUnchanged:true,renderedPixelsUnchanged:true,completeCheckpointRoundTrips:points,
  flashSha256:hash(flash),sameIndependentlyReadBackCartridge:true,publicCapabilitiesUnchanged:true,
  fullAdventureQualified:false,capacity1000Qualified:false,publicReleaseQualified:false};
await writeFile(resolve(candidate,'memory-parity-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({memoryParity:true,version,frames,comparisonBoundaries:boundaries,linearMemoryBytes:report.linearMemoryBytes,remainingLinearBytes:report.remainingLinearBytes}));
