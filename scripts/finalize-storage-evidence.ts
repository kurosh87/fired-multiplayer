import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';

// Lightweight evidence join: it never executes the game, promotes a core, or
// substitutes report flags for the native/browser runs that produced them.
const args=process.argv.slice(2),checkOnly=args.includes('--check');
const [version='leafgreen',tag=`${version}-storage`]=args.filter(arg=>arg!=='--check');
assert(['firered','leafgreen'].includes(version));assert(/^[a-z0-9-]{1,60}$/.test(tag));
const directory=resolve('build/adventure-qualification',tag),path=resolve(directory,'report.json');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const report=await load(path),manifest=await load(`build/game-source/${version}/memory-16/candidate.json`);
assert.equal(report.artifactId,manifest.id);assert.equal(report.wasmSha256,manifest.wasmSha256);
assert.equal(await sha(`build/game-source/${version}/memory-16/candidate.wasm`),report.wasmSha256);
const baseline=await load(`build/baseline/${version}.json`),lock=await load('engine/upstream.lock.json');
assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
assert.equal(createHash('sha1').update(await readFile(resolve(baseline.rom))).digest('hex'),baseline.sha1);
for(const flag of ['pureInputReplay','immutableAssetsUnchanged','completeCheckpointReplay','passiveInspection','independentGbaReadback'])assert.equal(report[flag],true,flag);
for(const flag of ['fullAdventureQualified','hostedAccountsQualified','capacity1000Qualified','publicReleaseQualified'])assert.equal(report[flag],false,flag);
for(const [key,source] of Object.entries({qualifier:'scripts/check-storage-adventure.ts',explorer:'scripts/explore-route.ts'}))
  assert.equal(report.sourceHashes[key],await sha(source),`Executed ${key} source changed; retain and audit its original snapshot.`);
const fixture=`tests/replays/${version}-pc-storage-roundtrip.json`;
for(const [generated,source] of [['replay.json',fixture],['deposit-continue-party.json',`tests/replays/${version}-pc-deposit-continue-party.json`],
  ['withdraw-continue-party.json',`tests/replays/${version}-pc-withdraw-continue-party.json`]])assert.equal(await sha(resolve(directory,generated!)),await sha(source!));
assert.equal(report.sourceHashes.prefixReplay,await sha(`tests/replays/${version}-route1-catch-save.json`));
const replay=await load(fixture);assert.equal(replay.expectedFrames,report.frames);assert.equal(replay.expectedDigest,report.digest);
for(const phase of ['deposit','withdraw']){
  const state=report.phases[phase];
  for(const flag of ['originalMenuSave','freshInstanceContinue','warmResetContinue','noDuplicateOrMissingPokemon','originalGbaReadback'])assert.equal(state[flag],true,`${phase} ${flag}`);
  const native=state.independentSaveProof;assert.equal(native.allPartyBytesIdentical,true);assert.equal(native.all14BoxesIdentical,true);
  assert.equal(native.romSha1,baseline.sha1);assert.equal(native.referenceCommit,lock.mgbaReference.commit);
  assert.equal(native.boxNamesAndWallpapersIdentical,true);assert.equal(native.noBadEggFlags,true);
  assert.equal(native.sourceSha256,await sha('scripts/check-storage-readback.ts'));
  assert.equal(native.referenceSourceHashes.runner,await sha('scripts/run-reference.py'));
  assert.equal(native.referenceSourceHashes.harness,await sha('engine/reference/headless.c'));
  for(const [suffix,key] of [['.sav','flashSha256'],['-party.bin','partySha256'],['-storage.bin','storageSha256']])
    assert.equal(await sha(resolve(directory,phase+suffix)),state[key!]);
  const nativeReport=await load(resolve(native.referenceDirectory,'report.json'));
  assert.equal(nativeReport.restoredFlashSha256,state.flashSha256);assert.equal(nativeReport.romSha1,native.romSha1);
  assert.equal(nativeReport.frames,(await load(resolve(directory,phase+'-continue-party.json'))).expectedFrames);
  const storage=await readFile(resolve(directory,phase+'-storage.bin')),nativeStorage=await readFile(resolve(native.referenceDirectory,'storage.bin'));
  assert.equal(storage.length,33744);assert(storage.equals(nativeStorage),'Native storage bytes changed.');
  const party=await readFile(resolve(directory,phase+'-party.bin')),nativeParty=await readFile(resolve(native.referenceDirectory,'party.bin'));
  assert(party.equals(nativeParty.subarray(0,party.length)),'Native party bytes changed.');
}
const browserSource=checkOnly&&report.sourceSnapshots?.browser?.path?report.sourceSnapshots.browser.path:'tests/engine.browser.spec.ts';
const browser:any={frames:report.frames,viewports:{},sourceSha256:await sha(browserSource),fixtureSha256:await sha(fixture),physicalDeviceCoverage:false};
for(const viewport of ['desktop','mobile']){
  const base=`build/game-source/${version}/memory-16/route-pc-storage-${viewport}`,metadataPath=base+'-checkpoint.json';
  const metadata=await load(metadataPath),checkpoint=await readFile(base+'.checkpoint');
  assert.equal(metadata.artifactId,report.artifactId);assert.equal(metadata.frame,report.frames);assert.equal(metadata.digest,report.digest);
  assert.equal(metadata.browserParity,true);assert.equal(metadata.browserCheckpointRestore,true);assert.equal(checkpoint.length,16*1024*1024);
  browser.viewports[viewport]={report:metadataPath,reportSha256:await sha(metadataPath),checkpointSha256:await sha(base+'.checkpoint'),actualWorkerParity:true,completeCheckpointRestore:true};
}
const layoutPath='build/record-abi-storage/report.json',layout=await load(layoutPath);
assert.equal(layout.matching,true);assert.equal(layout.mismatches.length,0);assert.equal(Object.keys(layout.members).length,111);
assert.equal(layout.runnerSha256,await sha('scripts/check-record-layout.py'));
assert.deepEqual(layout.members['sizeof(PokemonStorage)'],{arm:33744,wasm:33744});
assert.deepEqual(layout.members['PokemonStorage.boxes'],{arm:4,wasm:4});
const layoutProof={report:layoutPath,reportSha256:await sha(layoutPath),checks:111,pokemonStorage:Object.fromEntries(Object.entries(layout.members).filter(([key])=>key.includes('PokemonStorage')))};
const lobbyPath=relative(process.cwd(),resolve(directory,'lobby-integration.json')),lobby=await load(lobbyPath);
assert.equal(lobby.artifactId,report.artifactId);
for(const flag of ['lobbySavePreservesPartyAndAllBoxes','sourceCheckpointUnchanged','midPcAdmissionRejected','pcReopenedAfterSaveRejected'])assert.equal(lobby[flag],true,flag);
assert.equal(lobby.sourceHashes.qualifier,await sha('scripts/check-storage-lobby.ts'));
assert.equal(lobby.sourceHashes.productionBinding,await sha('packages/trading/prepare-lobby.ts'));
assert.equal(lobby.phases.deposit.partyCount,1);assert.equal(lobby.phases.withdraw.partyCount,2);
assert.equal(lobby.hostedAccountCoverage,false);assert.equal(lobby.networkedTradeCoverage,false);
const lobbyProof={report:lobbyPath,reportSha256:await sha(lobbyPath),currentPartyOnly:true,safeFieldAdmission:true,midPcRejected:true,allBoxesPreserved:true,hostedAccountCoverage:false};
if(checkOnly){
  assert.deepEqual(report.browserRouteParity,browser);assert.deepEqual(report.recordLayoutProof,layoutProof);assert.deepEqual(report.lobbyIntegrationProof,lobbyProof);
  for(const snapshot of Object.values(report.sourceSnapshots??{}) as any[])assert.equal(await sha(snapshot.path),snapshot.sha256);
}else{
  assert(!report.evidenceFinalization,'Already finalized; use --check for a read-only audit.');
  const sources={qualifier:'scripts/check-storage-adventure.ts',explorer:'scripts/explore-route.ts',readback:'scripts/check-storage-readback.ts',lobby:'scripts/check-storage-lobby.ts',
    referenceRunner:'scripts/run-reference.py',referenceHarness:'engine/reference/headless.c',recordLayout:'scripts/check-record-layout.py',browser:'tests/engine.browser.spec.ts',finalizer:'scripts/finalize-storage-evidence.ts'};
  const snapshots:any={};await mkdir(resolve(directory,'source'),{recursive:true});
  for(const [key,source] of Object.entries(sources)){
    const target=resolve(directory,'source',basename(source));
    if(existsSync(target))assert.equal(await sha(target),await sha(source));else await writeFile(target,await readFile(source));
    snapshots[key]={path:relative(process.cwd(),target),sha256:await sha(target)};
  }
  await writeFile(path,JSON.stringify({...report,browserRouteParity:browser,recordLayoutProof:layoutProof,lobbyIntegrationProof:lobbyProof,sourceSnapshots:snapshots,
    updatedAt:new Date().toISOString(),evidenceFinalization:{sourceSha256:await sha('scripts/finalize-storage-evidence.ts'),source:'scripts/finalize-storage-evidence.ts'}},null,2)+'\n');
}
console.log(JSON.stringify({version,frames:report.frames,checkOnly,originalGbaSaves:2,browserViewports:['desktop','mobile'],layoutChecks:111,lobbyIntegration:true,publicReleaseQualified:false}));
