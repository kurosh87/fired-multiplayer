import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { FRAME_MILLISECONDS, type InputRun } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const version=process.argv[2]??'firered';assert(['firered','leafgreen'].includes(version));
const dir=resolve(`build/game-source/${version}/audio-16`),output=resolve(dir,'audio-report.json');assert(!existsSync(output));
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const bytes=new Uint8Array(await readFile(resolve(dir,'candidate.wasm'))),manifest=JSON.parse(await readFile(resolve(dir,'candidate.json'),'utf8')) as EngineManifest;
const initial=JSON.parse(await readFile('tests/replays/new-game.json','utf8'));
const engine=await WasmEngine.create(bytes,manifest,initial.seed);
function bind(engine:WasmEngine){return engine.bindExtension<any>('kanto_audio_abi_version',1,['kanto_audio_ptr','kanto_audio_samples','kanto_audio_capacity','kanto_audio_channels','kanto_audio_rate','kanto_audio_mixer_rate','kanto_audio_driver_rate']);}
function samples(engine:WasmEngine){
  const c=bind(engine),count=c.kanto_audio_samples(),ptr=c.kanto_audio_ptr();
  assert.equal(c.kanto_audio_capacity(),4096);assert.equal(c.kanto_audio_channels(),2);
  assert.equal(c.kanto_audio_mixer_rate(),41869);assert(Math.abs(c.kanto_audio_rate()-701*1000/FRAME_MILLISECONDS)<1e-8);
  assert(count===0||count===1402);assert(ptr>0&&ptr%4===0&&ptr+count*4<=c.memory.buffer.byteLength);
  const data=new Float32Array(c.memory.buffer,ptr,count).slice();assert(data.every(value=>Number.isFinite(value)&&Math.abs(value)<=1));
  if(count)assert.equal(c.kanto_audio_driver_rate(),41869,'The original C driver did not receive the corrected synth rate.');
  return data;
}
let nonSilentFrames=0,totalSamples=0,peak=0;
for(const run of initial.runs as InputRun[])for(let i=0;i<run.frames;i++){
  engine.advance([{buttons:run.buttons,frames:1}]);const before=engine.digest(),pcm=samples(engine);assert.equal(engine.digest(),before);
  totalSamples+=pcm.length;if(pcm.some(value=>value!==0))nonSilentFrames++;
  for(const value of pcm)peak=Math.max(peak,Math.abs(value));
}
assert(nonSilentFrames>7000);
const restored=await WasmEngine.create(bytes,manifest,initial.seed);restored.restore(engine.snapshot());
for(let tick=0;tick<120;tick++){
  engine.advance([{buttons:0,frames:4}]);for(let frame=0;frame<4;frame++)restored.advance([{buttons:0,frames:1}]);
  assert.equal(engine.digest(),restored.digest());assert.equal(sha(new Uint8Array(samples(engine).buffer)),sha(new Uint8Array(samples(restored).buffer)));
}
engine.close();restored.close();
const movie=JSON.parse(await readFile(`tests/replays/${version}-pc-storage-roundtrip.json`,'utf8'));
const old=JSON.parse(await readFile(`build/adventure-qualification/${version}-storage/report.json`,'utf8'));
const route=await WasmEngine.create(bytes,manifest,movie.seed),phaseProofs:Record<string,any>={};
for(const run of movie.runs as InputRun[]){
  route.advance([run]);
  for(const phase of ['deposit','withdraw'])if(route.frame===old.phases[phase].frame){
    const hash=sha(route.flash());assert.equal(hash,old.phases[phase].flashSha256,`${phase} original-game save changed after audio adaptation.`);
    phaseProofs[phase]={flashSha256:hash,identicalToOriginalGbaQualifiedSave:true};
  }
}
assert.equal(route.frame,movie.expectedFrames);assert.equal(Object.keys(phaseProofs).length,2);
const replay={...movie,artifactId:manifest.id,expectedDigest:route.digest()};
await mkdir(resolve('build/audio-replays'),{recursive:true});
await writeFile(resolve('build/audio-replays',`${version}-pc-storage.json`),JSON.stringify(replay,null,2)+'\n');
const report={artifactId:manifest.id,wasmSha256:manifest.wasmSha256,nonSilentFrames,totalSamples,peak,channels:2,samplesPerChannelPerFrame:701,
  effectiveRate:701*1000/FRAME_MILLISECONDS,actualDriverRate:41869,audioReadsPreserveCanonicalState:true,finiteAndBoundedSamples:true,
  checkpointAndBatchParityFrames:480,fullAdventureReplayFrames:route.frame,digest:route.digest(),savedPhases:phaseProofs,
  sourceHashes:{qualifier:sha(new Uint8Array(await readFile('scripts/check-audio-candidate.ts'))),nativePlatform:sha(new Uint8Array(await readFile('engine/port/native_platform.c'))),
    rateAdaptation:sha(new Uint8Array(await readFile('engine/port/kanto_audio_rate.h'))),linker:sha(new Uint8Array(await readFile('scripts/link-candidate.py')))},
  browserAudioQualified:false,originalGbaAudioFidelityQualified:false,fullAdventureQualified:false,publicReleaseQualified:false};
await writeFile(output,JSON.stringify(report,null,2)+'\n');route.close();console.log(JSON.stringify(report));
