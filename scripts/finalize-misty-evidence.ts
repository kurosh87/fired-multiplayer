import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WasmEngine } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import { originalStoryProgress } from '../tests/original-story-progress.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the shared build guard.');
const tag=process.argv[2];assert(tag&&/^[a-z0-9-]{1,28}$/.test(tag));
const output=`build/${tag}-validation.json`,source=`build/${tag}-source`;
assert(!existsSync(output)&&!existsSync(source),'Preserve retained verification results.');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const evidence:Record<string,string>={},sources=new Set<string>(),updates:any[]=[],cases:any[]=[];
const remember=async(path:string)=>{evidence[path]=hash(await readFile(path));};
const explorerAudit=await load('build/misty-explorer-source-audit.json');assert(explorerAudit.allExecutedSourcesRetained);
for(const entry of explorerAudit.reports){
  assert.equal(hash(await readFile(entry.retainedSource)),entry.helperSha256);sources.add(entry.retainedSource);
  const segment=await load(entry.report);assert.equal(segment.helperSha256,entry.helperSha256);
  if(segment.plan){assert.equal(hash(await readFile(segment.plan)),segment.planSha256);sources.add(segment.plan);}
}
await remember('build/misty-explorer-source-audit.json');sources.add('build/misty-explorer-source-audit.py');
for(const version of ['firered','leafgreen']){
  const folder:string=`build/adventure-qualification/${version}-${tag}`,report=await load(folder+'/report.json'),native=await load(folder+'/native-proof.json');
  const game:string=`build/game-source/${version}/battle-text-audio-16`,manifest=await load(game+'/candidate.json'),bytes=new Uint8Array(await readFile(game+'/candidate.wasm'));
  assert.equal(report.artifactId,manifest.id);assert.equal(report.wasmSha256,hash(bytes));assert.equal(report.gameDirectory,game);
  assert(Object.values(manifest.capabilities).every(value=>value===false));
  assert(report.pureInputContinuation&&!report.freshBootFullMovieReplayedThisCase&&report.freshContinue&&report.warmResetContinue&&report.originalMenuSave&&report.completeCheckpointRestore&&report.naturalEvolutionPreserved);
  assert.equal(report.pureInputReplay,false);assert.equal(report.freshBootFullMovieReplayedThisCase,false);assert(report.immutableAssetsUnchanged);
  assert.equal(report.browserQualified,false);assert.equal(report.independentGbaReadback,false);assert.equal(report.secondGymQualified,false);
  assert.equal(native.qualificationReportSha256,hash(await readFile(folder+'/report.json')));assert.equal(native.sourceSha256,hash(await readFile('scripts/check-misty-readback.ts')));
  assert(native.allPartyBytesIdentical&&native.all14BoxesIdentical&&native.noBadEggs);
  assert.equal(native.referenceReportSha256,hash(await readFile(native.referenceFolder+'/report.json')));
  assert.equal(report.earlierFullMovieProofSha256,hash(await readFile(report.earlierFullMovieProof)));
  assert.equal(report.earlierChapterValidationSha256,hash(await readFile(report.earlierChapterValidation)));
  assert.equal(report.qualifiedPrefixCheckpointSha256,hash(await readFile(dirname(report.earlierFullMovieProof)+'/checkpoint.gz')));
  await remember(report.earlierFullMovieProof);await remember(report.earlierChapterValidation);
  assert(report.expected.mistyDefeated&&report.expected.tm03Received&&report.expected.tm03===1);
  assert.deepEqual(report.trainerWins.map((win:any)=>win.id),[234,150,415]);
  assert.equal(report.prizes.total,2544);
  for(const [path,identity] of Object.entries({...report.sourceSha256,...report.prizes.sourceSha256})){
    assert.equal(hash(await readFile(path)),identity);sources.add(path);
  }
  for(const segment of report.lineage){await remember(segment.path+'/report.json');assert.equal(evidence[segment.path+'/report.json'],segment.reportSha256);}
  const movie=await load(folder+'/replay.json'),continuation=await load(folder+'/browser-inputs.json');
  assert.equal(movie.expectedFrames,report.frames);assert.equal(movie.expectedDigest,report.digest);
  assert.equal(continuation.expectedFrames,report.frames);assert.equal(continuation.expectedDigest,report.digest);
  const flash=await readFile(folder+'/adventure.sav'),party=await readFile(folder+'/party.bin'),storage=await readFile(folder+'/storage.bin');
  assert.equal(hash(flash),report.flashSha256);assert.equal(hash(party),report.partySha256);assert.equal(hash(storage),report.storageSha256);
  const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes)),browser=[];
  for(const viewport of ['desktop','mobile']){
    const prefix=folder+`/browser-worker-${viewport}`,proof=await load(prefix+'-checkpoint.json');
    assert.equal(proof.artifactId,manifest.id);assert.equal(proof.frame,report.frames);assert.equal(proof.digest,report.digest);
    assert(proof.browserParity&&proof.browserCheckpointRestore&&proof.audioPackets.nonSilent>100);
    const engine=await WasmEngine.create(bytes,manifest,movie.seed);
    try{
      engine.restore(decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(prefix+'.checkpoint.gz'))),baseline,manifest.wasmSha256));
      assert.equal(engine.digest(),report.digest);assert.equal(hash(engine.flash()),report.flashSha256);assert.deepEqual(originalStoryProgress(engine),report.expected);
      const c=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]),m=new DataView(c.memory.buffer);
      assert.deepEqual(Buffer.from(c.memory.buffer,c.gPlayerParty.value,200),party);
      assert.deepEqual(Buffer.from(c.memory.buffer,m.getUint32(c.gPokemonStoragePtr.value,true),0x83d0),storage);
    }finally{engine.close();}
    await remember(prefix+'-checkpoint.json');await remember(prefix+'.checkpoint.gz');
    browser.push({viewport,continuationFromQualifiedMtMoon:true,startingFrame:report.startingFrame,newFrames:report.newFrames,finalFrame:proof.frame,
      digest:proof.digest,checkpointRestore:true,audioPackets:proof.audioPackets});
  }
  const browserLog:string=`build/${version}-${tag}-browser.log`;assert((await readFile(browserLog,'utf8')).includes('2 passed'));await remember(browserLog);
  for(const file of ['replay.json','browser-inputs.json','browser-start.checkpoint.gz','checkpoint.gz','adventure.sav','party.bin','storage.bin','native-proof.json','continue-party.json'])await remember(folder+'/'+file);
  await remember(`build/${version}-${tag}-check.log`);await remember(`build/${version}-${tag}-reference.log`);await remember(native.referenceFolder+'/report.json');
  const replayPath=`tests/replays/${version}-misty-audio.json`;assert(!existsSync(replayPath));assert(!existsSync(folder+'/source-save-report.json'));
  updates.push({folder,report,browser,replayPath});sources.add(replayPath);
  cases.push({version,artifactId:manifest.id,pureInputContinuation:true,freshBootFullMovieReplayedThisCase:false,earlierFullMovieProof:report.earlierFullMovieProof,earlierFullMovieProofSha256:report.earlierFullMovieProofSha256,frames:report.frames,newFrames:report.newFrames,originalGbaSaveReadback:true,
    runningShoesPreserved:true,naturalIvysaurEvolutionPreserved:true,fossil:report.expected.domeFossil?'dome':'helix',cascadeBadge:true,tm03:true,party:report.expected.party,
    money:report.expected.money,prizes:report.prizes.prizes,all14BoxesPreserved:true,originalMenuSave:true,freshContinue:true,warmResetContinue:true,browser,flashSha256:report.flashSha256});
}
for(const {folder,report,browser,replayPath} of updates){
  await copyFile(folder+'/report.json',folder+'/source-save-report.json');await remember(folder+'/source-save-report.json');
  await writeFile(folder+'/report.json',JSON.stringify({...report,independentGbaReadback:true,browserQualified:true,secondGymQualified:true,
    chapterProof:{browser,native:'native-proof.json',sourceSaveReport:'source-save-report.json',finalizerSha256:hash(await readFile('scripts/finalize-misty-evidence.ts'))}},null,2)+'\n');
  await remember(folder+'/report.json');await copyFile(folder+'/replay.json',replayPath);
}
for(const path of ['README.md','engine/MISTY.md','scripts/finalize-misty-evidence.ts','scripts/run-local.py','scripts/run-reference.py','engine/reference/headless.c',
  'engine/upstream.lock.json','tests/engine.browser.spec.ts','apps/web/src/game.worker.ts','packages/engine/runtime.ts','packages/engine/checkpoint.ts','packages/protocol/index.ts',
  'build/misty-explorer-before.ts','build/misty-progress-before.ts','build/misty-prizes-before.ts',
  'build/misty-qualify-v1.py','build/misty-browser-v1.py','build/misty-process-audit.py','build/misty-close.py'])sources.add(path);
await mkdir(source);const sourceIdentities:Record<string,string>={};
for(const path of sources){
  const name=relative(resolve('.'),resolve(path));assert(name&&!isAbsolute(name)&&!name.startsWith('../'));
  const destination=resolve(source,name);assert(destination.startsWith(resolve(source)+'/'));
  await mkdir(dirname(destination),{recursive:true});await copyFile(path,destination);sourceIdentities[name]=hash(await readFile(path));
}
await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),source,sourceIdentities,evidenceIdentities:evidence,cases,secondGymQualified:true,
  visualReview:['FireRed and LeafGreen final Cerulean canvas framing on desktop and mobile Chrome emulation'],
  browserScope:'Both complete new input segments from the fully qualified Mt Moon checkpoint, independently replayed in the C core and with actual-worker replacement on desktop and mobile Chrome emulation. The linked prior chapter provides the complete fresh-boot prefix; that prefix is not replayed in this case.',
  originalGameplayPixelOrAudioParityQualified:false,physicalDevicesQualified:false,fullAdventureQualified:false,hostedAccountsQualified:false,
  capacity1000Qualified:false,publicReleaseQualified:false,publicPreviewChanged:false},null,2)+'\n');
console.log(JSON.stringify({output,editions:2,browserCases:4,originalGbaSaveReadbacks:2,secondGymQualified:true}));
