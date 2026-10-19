import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { WasmEngine } from '../packages/engine/runtime.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const tag=process.argv[2];assert(tag&&/^[a-z0-9-]{1,28}$/.test(tag));
const output=`build/${tag}-validation.json`,source=`build/${tag}-source`;
assert(!existsSync(output)&&!existsSync(source),'Preserve retained qualification evidence.');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const evidence:Record<string,string>={},cases:any[]=[],sourceMovies:string[]=[],pendingCopies:{from:string;to:string}[]=[];
const reportUpdates:{folder:string;report:any;browser:any[]}[]=[];
for(const version of ['firered','leafgreen']){
  const folder:string=`build/adventure-qualification/${version}-${tag}`;
  const game:string=`build/game-source/${version}/battle-text-audio-16`;
  const report=await load(folder+'/report.json'),movie=await load(folder+'/replay.json'),manifest=await load(game+'/candidate.json');
  const bytes=new Uint8Array(await readFile(game+'/candidate.wasm')),inputs=await load(game+'/battle-text-inputs.json');
  assert.equal(report.gameDirectory,game);assert.equal(report.artifactId,manifest.id);assert.equal(sha(bytes),report.wasmSha256);
  assert(Object.values(manifest.capabilities).every(value=>value===false));
  assert(report.pureInputReplay&&report.freshContinue&&report.warmResetContinue&&report.completeCheckpointRestore&&report.originalMenuSave);
  assert(report.prefixOriginalSaveUnchanged&&report.battleFlagsPreserved&&report.longDialogue.identicalOriginalDialogue);
  assert.equal(report.longDialogue.textCapacity,1024);assert.equal(report.longDialogue.bytesIncludingTerminator,373);
  assert.equal(inputs.capacity,1024);assert.equal(inputs.adaptationSha256,sha(await readFile('engine/port/prepare_battle_text.py')));
  assert.equal(report.sourceHashes.qualifier,sha(await readFile('scripts/check-brock-adventure.ts')));
  assert.equal(report.sourceHashes.explorer,sha(await readFile('scripts/explore-route.ts')));
  assert(report.independentGbaReadback&&report.independentSaveProof.allPartyBytesIdentical&&report.independentSaveProof.all14BoxesIdentical);
  assert.equal(report.independentSaveProof.sourceSha256,sha(await readFile('scripts/check-brock-readback.ts')));
  assert.deepEqual(report.expected.badges,[true,false,false,false,false,false,false,false]);assert.equal(report.expected.tm39,1);
  assert.equal(report.prizeMoneyDelta,1620);assert.equal(report.expected.money-report.initial.money,1620);
  assert.equal(movie.expectedFrames,report.frames);assert.equal(movie.expectedDigest,report.digest);assert.equal(movie.artifactId,manifest.id);
  const flash:Buffer=await readFile(folder+'/adventure.sav');
  const party:Buffer=await readFile(folder+'/party.bin');
  const storage:Buffer=await readFile(folder+'/storage.bin');
  assert.equal(sha(flash),report.flashSha256);assert.equal(sha(party),report.partySha256);assert.equal(sha(storage),report.storageSha256);
  const reference:string=`build/reference/${version}-${tag}`,native=await load(reference+'/report.json');
  assert.equal(native.restoredFlashSha256,report.flashSha256);
  assert.deepEqual((await readFile(reference+'/party.bin')).subarray(0,200),party);assert.deepEqual(await readFile(reference+'/storage.bin'),storage);
  const browser=[];
  for(const viewport of ['desktop','mobile']){
    const prefix=game+`/route-${tag}-${viewport}`,proof=await load(prefix+'-checkpoint.json');
    assert.equal(proof.artifactId,manifest.id);assert.equal(proof.frame,report.frames);assert.equal(proof.digest,report.digest);
    assert(proof.browserParity&&proof.browserCheckpointRestore&&proof.audioPackets.nonSilent>100);
    const point=new Uint8Array(await readFile(prefix+'.checkpoint')),engine=await WasmEngine.create(bytes,manifest,movie.seed);
    try{
      engine.restore(point);assert.equal(engine.digest(),report.digest);assert.equal(sha(engine.flash()),report.flashSha256);
      const core=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]),m=new DataView(core.memory.buffer);
      assert.deepEqual(Buffer.from(core.memory.buffer,core.gPlayerParty.value,200),party);
      assert.deepEqual(Buffer.from(core.memory.buffer,m.getUint32(core.gPokemonStoragePtr.value,true),0x83d0),storage);
      assert.equal(m.getUint32(core.gBattleTypeFlags.value,true),12);
    }finally{engine.close();}
    evidence[prefix+'-checkpoint.json']=sha(await readFile(prefix+'-checkpoint.json'));evidence[prefix+'.checkpoint']=sha(point);
    browser.push({viewport,freshBootFullMovieFrames:proof.frame,canonicalDigest:proof.digest,checkpointRestore:true,
      cartridgeMatchesOriginalGbaAcceptedSave:true,audioPackets:proof.audioPackets});
  }
  const replayPath=`tests/replays/${version}-brock-audio.json`;assert(!existsSync(replayPath));
  pendingCopies.push({from:folder+'/replay.json',to:replayPath});sourceMovies.push(replayPath);
  for(const path of [folder+'/report.json',folder+'/replay.json',reference+'/report.json',game+'/candidate.wasm',game+'/battle-text-inputs.json',
    `build/${version}-battle-text-overflow-v1.json`,`build/${version}-${tag}-check.log`,`build/${version}-${tag}-browser.log`,`build/${version}-${tag}-reference.log`])
    evidence[path]=sha(await readFile(path));
  assert((await readFile(`build/${version}-${tag}-browser.log`,'utf8')).includes('2 passed'));
  assert.equal(report.firstGymQualified,false);assert(!existsSync(folder+'/source-save-report.json'));
  reportUpdates.push({folder,report,browser});
  cases.push({version,artifactId:manifest.id,pureInputReplayFromFreshBoot:true,frames:report.frames,firstBadgeEarned:true,tm39:1,
    prizeMoneyDelta:1620,money:report.expected.money,party:report.expected.party,longDialogue:report.longDialogue,
    originalMenuSave:true,freshContinue:true,warmResetContinue:true,browser,independentGbaSaveReadback:true,all14BoxesPreserved:true,
    flashSha256:report.flashSha256});
}
const regressionPath=`build/${tag}-regression-final3.log`,regression=await readFile(regressionPath,'utf8');
assert(regression.includes('ℹ pass 75')&&regression.includes('ℹ fail 0')&&regression.includes('Ran 28 tests')&&regression.includes('\nOK\n'));
evidence[regressionPath]=sha(Buffer.from(regression));
for(const {folder,report,browser} of reportUpdates){
  await copyFile(folder+'/report.json',folder+'/source-save-report.json');
  evidence[folder+'/source-save-report.json']=sha(await readFile(folder+'/source-save-report.json'));
  await writeFile(folder+'/report.json',JSON.stringify({...report,browserQualified:true,firstGymQualified:true,
    firstGymProof:{browser,sourceSaveReport:'source-save-report.json',finalizerSha256:sha(await readFile('scripts/finalize-brock-evidence.ts'))}},null,2)+'\n');
  evidence[folder+'/report.json']=sha(await readFile(folder+'/report.json'));
}
for(const pending of pendingCopies)await copyFile(pending.from,pending.to);
const paths=['README.md','engine/BROCK.md','engine/FOREST.md','engine/ADVENTURE.md','engine/port/prepare_battle_text.py',
  'scripts/compile-game.py','scripts/link-candidate.py','scripts/build-battle-candidate.py','scripts/check-battle-text-overflow.ts','scripts/run-local.py','tests/run_local_test.py',
  'scripts/check-brock-adventure.ts','scripts/check-brock-readback.ts','scripts/finalize-brock-evidence.ts','scripts/explore-route.ts',
  'tests/prepare_battle_text_test.py','tests/engine.browser.spec.ts','scripts/run-reference.py','engine/reference/headless.c','engine/upstream.lock.json',
  'apps/web/src/game.worker.ts','packages/engine/runtime.ts','packages/engine/checkpoint.ts','packages/protocol/index.ts',...sourceMovies];
await mkdir(source);const sources:Record<string,string>={};
for(const path of paths){const destination=resolve(source,path);await mkdir(dirname(destination),{recursive:true});await copyFile(path,destination);sources[path]=sha(await readFile(path));}
await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),source,sourceIdentities:sources,evidenceIdentities:evidence,cases,
  browserScope:'Complete fresh-boot movies on each repaired core, desktop and mobile Chrome emulation, with actual worker replacement and batch-by-batch original-C replay parity.',
  textStorageRepair:true,firstGymQualified:true,nodeUnitsPassed:75,nodePostgresSkipped:1,pythonPassed:28,typecheck:true,
  originalGameplayPixelOrAudioParityQualified:false,physicalDevicesQualified:false,fullAdventureQualified:false,
  hostedAccountsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false,publicPreviewChanged:false},null,2)+'\n');
console.log(JSON.stringify({output,editions:cases.length,browserCases:4,originalGbaSaveReadbacks:2,firstGymQualified:true}));
