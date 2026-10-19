import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { FRAME_MILLISECONDS, type InputRun } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const version=process.argv[2]??'firered';assert(['firered','leafgreen'].includes(version));
const output=resolve(`build/audio-output-${version}.json`);assert(!existsSync(output),'Preserve prior audio inspection evidence.');
const directory=resolve(`build/game-source/${version}/memory-16`),sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const bytes=new Uint8Array(await readFile(resolve(directory,'candidate.wasm')));
const manifest=JSON.parse(await readFile(resolve(directory,'candidate.json'),'utf8')) as EngineManifest;
const replay=JSON.parse(await readFile('tests/replays/new-game.json','utf8'));
assert.equal(sha(bytes),manifest.wasmSha256);
const source=await readFile('engine/port/native_platform.c','utf8');
assert(source.includes('float audio[4096];\n    uint32_t audio_samples;\n    char diagnostic[1024];'));
// Trusted inspection of the existing private KantoOutput layout, never a
// browser/runtime API. The count immediately precedes diagnostic; its 4096
// floats precede that count. Public playback needs explicit bounded exports.
function bind(engine:WasmEngine){return engine.bindExtension<any>('kanto_lobby_save_abi_version',1,['kanto_diagnostic_ptr']);}
function pcm(engine:WasmEngine){
  const digest=engine.digest(),c=bind(engine),m=new DataView(c.memory.buffer),diagnostic=c.kanto_diagnostic_ptr();
  assert(Number.isSafeInteger(diagnostic)&&diagnostic>4096*4+4&&diagnostic<c.memory.buffer.byteLength);
  const count=m.getUint32(diagnostic-4,true);assert(count<=4096&&count%2===0);
  const samples=new Float32Array(c.memory.buffer,diagnostic-4-4096*4,count).slice();
  assert(samples.every(value=>Number.isFinite(value)&&value>=-1&&value<=1));
  assert.equal(engine.digest(),digest,'PCM observation changed canonical game state.');return samples;
}
const engine=await WasmEngine.create(bytes,manifest,replay.seed);
let nonSilentFrames=0,totalSamples=0,nonZeroSamples=0,sumSquares=0,peak=0;
const counts=new Set<number>();
for(const run of replay.runs as InputRun[])for(let frame=0;frame<run.frames;frame++){
  engine.advance([{buttons:run.buttons,frames:1}]);const samples=pcm(engine);counts.add(samples.length);
  let nonSilent=false;
  for(const sample of samples){totalSamples++;sumSquares+=sample*sample;peak=Math.max(peak,Math.abs(sample));if(sample!==0){nonZeroSamples++;nonSilent=true;}}
  if(nonSilent)nonSilentFrames++;
}
assert.equal(engine.frame,replay.expectedFrames);assert(nonSilentFrames>0,'The original C mixer produced no non-silent frame.');
const restored=await WasmEngine.create(bytes,manifest,replay.seed);restored.restore(engine.snapshot());
for(let i=0;i<120;i++){
  const run={buttons:0,frames:1};engine.advance([run]);restored.advance([run]);assert.equal(engine.digest(),restored.digest());
  assert.equal(sha(new Uint8Array(pcm(engine).buffer)),sha(new Uint8Array(pcm(restored).buffer)),'PCM differs after complete checkpoint restoration.');
}
const samplesPerChannel=[...counts].filter(count=>count>0);assert.deepEqual(samplesPerChannel,[1402]);
engine.close();restored.close();
const report={version,artifactId:manifest.id,wasmSha256:manifest.wasmSha256,inspectedFrames:replay.expectedFrames,
  channelCount:2,samplesPerChannelPerFrame:701,declaredNativeMixerRate:42060,
  producedSampleFramesPerOriginalSecond:701*1000/FRAME_MILLISECONDS,
  nonSilentFrames,totalSamples,nonZeroSamples,peak,rms:Math.sqrt(sumSquares/totalSamples),allSamplesFiniteAndBounded:true,
  completeCheckpointAudioParityFrames:120,canonicalObservationInvariant:true,privateLayoutInspection:true,
  publicAudioAbi:false,browserPlaybackQualified:false,originalGbaAudioFidelityQualified:false,artifactChanged:false,
  sourceHashes:{inspector:sha(new Uint8Array(await readFile('scripts/inspect-audio-output.ts'))),nativePlatform:sha(new Uint8Array(await readFile('engine/port/native_platform.c'))),
    mixer:sha(new Uint8Array(await readFile('vendor/pokefirered-native/src/platform/sound_mixer.c'))),replay:sha(new Uint8Array(await readFile('tests/replays/new-game.json')))},
  scope:'Read-only scan of existing C PCM output and checkpoint determinism; not audible browser playback or original GBA sound fidelity.'};
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
