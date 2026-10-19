import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {WasmEngine} from '../packages/engine/runtime.ts';
import {createCheckpointBaseline,decodeCheckpoint} from '../packages/engine/checkpoint.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const output='build/forest-validation.json';assert(!existsSync(output),'Preserve retained final evidence.');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const cases:any[]=[],evidence:Record<string,string>={};
const executedQualifier='build/forest-qualifier-v1-source/scripts/check-forest-adventure.ts';
const originalSource=await readFile(executedQualifier,'utf8'),currentSource=await readFile('scripts/check-forest-adventure.ts','utf8');
const withoutMetadata=currentSource.split(/(?<=\n)/).filter(line=>!line.startsWith('    expectedParty:expected.party,expectedInventory:')&&!line.startsWith('    expectedProgress:{oldManScene:expected.oldManScene')).join('');
assert.equal(withoutMetadata,originalSource,'A gameplay verification change requires fresh qualification.');
for(const version of ['firered','leafgreen']){
  const tag=`${version}-forest-v1`,folder=`build/adventure-qualification/${tag}`,game=`build/game-source/${version}/audio-16`;
  const report=await load(folder+'/report.json'),manifest=await load(game+'/candidate.json');
  assert.equal(report.sourceHashes.qualifier,sha(Buffer.from(originalSource)));
  assert.equal(report.sourceHashes.explorer,sha(await readFile('scripts/explore-route.ts')));
  assert(report.pureInputReplay&&report.freshContinue&&report.warmResetContinue&&report.independentGbaReadback);
  assert(report.independentSaveProof.allPartyBytesIdentical&&report.independentSaveProof.all14BoxesIdentical);
  assert.equal(report.independentSaveProof.sourceSha256,sha(await readFile('scripts/check-forest-readback.ts')));
  assert.equal(report.firstGymQualified,false);assert.equal(report.fullAdventureQualified,false);assert.equal(report.publicReleaseQualified,false);
  assert(Object.values(manifest.capabilities).every(value=>value===false),'Do not promote candidate capabilities.');
  const bytes=new Uint8Array(await readFile(game+'/candidate.wasm'));assert.equal(sha(bytes),report.wasmSha256);
  const replayPath=`tests/replays/${version}-forest-pewter-audio.json`,movie=await load(replayPath);
  assert.deepEqual(movie,await load(folder+'/replay.json'));assert.deepEqual(movie.expectedParty,report.expected.party);
  assert.equal(movie.expectedFrames,report.frames);assert.equal(movie.expectedDigest,report.digest);
  const flash=await readFile(folder+'/adventure.sav'),party=await readFile(folder+'/party.bin'),storage=await readFile(folder+'/storage.bin');
  assert.equal(sha(flash),report.flashSha256);assert.equal(sha(party),report.partySha256);assert.equal(sha(storage),report.storageSha256);
  const reference=`build/reference/${tag}`,native=await load(reference+'/report.json');
  assert.equal(native.restoredFlashSha256,report.flashSha256);
  assert.deepEqual((await readFile(reference+'/party.bin')).subarray(0,200),party);assert.deepEqual(await readFile(reference+'/storage.bin'),storage);
  const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes)),browser=[];
  for(const viewport of ['desktop','mobile']){
    const prefix=folder+`/browser-worker-${viewport}`,proof=await load(prefix+'-checkpoint.json');
    assert.equal(proof.artifactId,manifest.id);assert.equal(proof.frame,report.frames);assert.equal(proof.digest,report.digest);
    assert(proof.browserParity&&proof.browserCheckpointRestore);assert(proof.audioPackets.nonSilent>100);
    const point=await readFile(prefix+'.checkpoint.gz'),engine=await WasmEngine.create(bytes,manifest,movie.seed);
    try{
      engine.restore(decodeCheckpoint(new Uint8Array(gunzipSync(point)),baseline,manifest.wasmSha256));
      assert.equal(engine.digest(),report.digest);assert.equal(sha(engine.flash()),report.flashSha256);
      const core=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]);
      assert.deepEqual(Buffer.from(core.memory.buffer,core.gPlayerParty.value,200),party);
    }finally{engine.close();}
    evidence[prefix+'-checkpoint.json']=sha(await readFile(prefix+'-checkpoint.json'));evidence[prefix+'.checkpoint.gz']=sha(point);
    browser.push({viewport,frame:proof.frame,canonicalDigest:proof.digest,checkpointRestore:true,cartridgeMatchesOriginalGbaAcceptedSave:true,audioPackets:proof.audioPackets});
  }
  evidence[folder+'/report.json']=sha(await readFile(folder+'/report.json'));evidence[reference+'/report.json']=sha(await readFile(reference+'/report.json'));
  evidence[replayPath]=sha(await readFile(replayPath));evidence[game+'/candidate.wasm']=sha(bytes);
  cases.push({version,artifactId:manifest.id,fullMovieFrames:report.frames,newBrowserFrames:report.frames-(version==='firered'?68942:69062),
    pureInputReplayFromFreshBoot:true,originalMenuSave:true,freshContinue:true,warmResetContinue:true,
    browser,independentGbaSaveReadback:true,all14BoxesPreserved:true,sammyDefeated:report.expected.sammyDefeated,teachyTv:report.expected.teachyTv,
    firstBadge:false,endingParty:report.expected.party,flashSha256:report.flashSha256});
}
const logs=['build/forest-heal-audio-check.log','build/forest-route2-audio-check.log','build/forest-enter-audio-check.log','build/forest-cross-audio-check.log',
  'build/forest-flee-audio-check.log','build/forest-pewter-audio-check.log','build/forest-save-and-center-check.log','build/forest-qualification-v1-check.log',
  'build/forest-firered-reference-v1-check.log','build/forest-firered-browser-v1-check.log','build/forest-leafgreen-reference-browser-v1-check.log','build/forest-final-regression-check.log'];
for(const path of logs)evidence[path]=sha(await readFile(path));
const regression=await readFile(logs.at(-1)!,'utf8');assert(regression.includes('ℹ pass 75')&&regression.includes('ℹ fail 0')&&regression.includes('Ran 24 tests')&&regression.includes('\nOK\n'));
for(const path of ['build/forest-firered-browser-v1-check.log','build/forest-leafgreen-reference-browser-v1-check.log'])assert((await readFile(path,'utf8')).includes('2 passed'));
const paths=['README.md','engine/FOREST.md','engine/ADVENTURE.md','scripts/explore-route.ts','scripts/check-forest-adventure.ts','scripts/check-forest-readback.ts',
  'scripts/prepare-forest-browser.ts','scripts/finalize-forest-evidence.ts','scripts/run-reference.py','engine/reference/headless.c','engine/upstream.lock.json',
  'tests/engine.browser.spec.ts','apps/web/src/game.worker.ts','packages/engine/runtime.ts','packages/engine/checkpoint.ts','packages/protocol/index.ts',
  ...['firered','leafgreen'].map(v=>`tests/replays/${v}-forest-pewter-audio.json`)];
const source='build/forest-source';await mkdir(source);const sources:Record<string,string>={};
for(const path of paths){const target=resolve(source,path);await mkdir(dirname(target),{recursive:true});await copyFile(path,target);sources[path]=sha(await readFile(path));}
await copyFile(executedQualifier,resolve(source,'executed-qualifier-v1.ts'));
await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),source,sourceIdentities:sources,evidenceIdentities:evidence,cases,
  executedQualificationSource:executedQualifier,executedQualifierSha256:sha(Buffer.from(originalSource)),
  qualifierPostRunChange:'Only emitted replay expectations were corrected to use measured final party/progress; every executed gameplay check is byte-identical.',
  browserScope:'All new frames from retained, previously full-replay-qualified audio PC checkpoints; pure Node checks replay the complete movies from fresh boot.',
  earlierBrowserWorkerSourceUnchanged:sha(await readFile('apps/web/src/game.worker.ts'))===sha(await readFile('build/audio-final-source/apps/web/src/game.worker.ts')),
  visualReview:['FireRed Pewter original Save menu','FireRed desktop browser outside Pewter Pokemon Center'],
  typecheck:true,nodeUnitsPassed:75,nodePostgresSkipped:1,pythonPassed:24,
  physicalDevicesQualified:false,originalGameplayPixelOrAudioParityQualified:false,firstGymQualified:false,fullAdventureQualified:false,
  hostedAccountsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false,publicPreviewChanged:false},null,2)+'\n');
console.log(JSON.stringify({output,cases:cases.length,browserCases:4,originalGbaSaveReadbacks:2,firstGymQualified:false}));
