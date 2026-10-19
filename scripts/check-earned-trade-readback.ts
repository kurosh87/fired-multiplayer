import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const tag=process.argv[2];assert(tag&&/^[a-z0-9-]{1,32}$/.test(tag));
const output=`build/${tag}-native-readback.json`;assert(!existsSync(output),'Preserve retained readback evidence.');
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const journey=await load(`build/${tag}-journey-report.json`),lock=await load('engine/upstream.lock.json');
const cases:Record<string,unknown>[]=[];
assert(journey.originalContinueToFieldAfterTrade&&journey.distinctCaughtPokemonExchanged);
for(const version of ['firered','leafgreen'] as const){
  const expected=journey.returned.find((item:any)=>item.version===version);assert(expected);
  const source:string=`build/${tag}`,reference:string=`build/reference/${tag}-${version}`;
  const report=await load(`${reference}/report.json`),baseline=await load(`build/baseline/${version}.json`);
  assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
  assert.equal(createHash('sha1').update(await readFile(baseline.rom)).digest('hex'),baseline.sha1);
  assert.equal(report.romSha1,baseline.sha1);assert.equal(report.referenceCommit,lock.mgbaReference.commit);
  assert.equal(report.sourceHashes.runner,sha(await readFile('scripts/run-reference.py')));
  assert.equal(report.sourceHashes.harness,sha(await readFile('engine/reference/headless.c')));
  assert(report.storageReadback);
  const flash:Buffer=await readFile(`${source}/${version}-returned.sav`);assert.equal(flash.length,131072);
  assert.equal(sha(flash),expected.flashSha256);assert.equal(report.restoredFlashSha256,expected.flashSha256);
  const movie=await load(`tests/replays/${version}-pc-withdraw-continue-party.json`);assert.equal(report.frames,movie.expectedFrames);
  const last=report.points.at(-1);assert(last);
  assert.equal(last.callback,'CB2_UpdatePartyMenu');assert.equal(last.saveStatus,1);assert(last.questLog<2);
  assert.equal(last.partyCount,expected.party.length);assert.equal(last.isBadEgg,0);
  assert.deepEqual([last.mapGroup,last.mapNumber],expected.map);
  const party:Buffer=await readFile(`${source}/${version}-returned-party.bin`),nativeParty:Buffer=await readFile(`${reference}/party.bin`);
  assert.equal(party.length,expected.party.length*100);assert.equal(sha(party),expected.partySha256);assert.equal(nativeParty.length,600);
  assert.deepEqual(nativeParty.subarray(0,party.length),party,'The unchanged GBA game read different earned party records after trading.');
  for(let slot=0;slot<6;slot++){
    assert.equal(nativeParty[slot*100+0x13]!&1,0,'Bad Egg flag in native party.');
    if(slot>=expected.party.length)assert.equal(nativeParty[slot*100+0x13]!&2,0,'Unexpected occupied native party slot.');
  }
  const storage=await readFile(`${source}/${version}-returned-storage.bin`),nativeStorage=await readFile(`${reference}/storage.bin`);
  assert.equal(storage.length,0x83d0);assert.equal(sha(storage),expected.storageSha256);assert.deepEqual(nativeStorage,storage);
  const saveBlock=await readFile(`${reference}/saveblock1.bin`);
  assert.deepEqual([saveBlock.readInt16LE(0),saveBlock.readInt16LE(2)],expected.position);
  cases.push({version,romSha1:baseline.sha1,referenceCommit:report.referenceCommit,flashSha256:expected.flashSha256,
    sourcePartySha256:expected.partySha256,sourceStorageSha256:expected.storageSha256,originalContinueAndPartyMenu:true,
    allEarnedPartyBytesIdentical:true,recordedFullStorageBytesIdentical:true,noBadEggFlags:true,savedPositionMatches:true,
    referenceDirectory:reference,referenceReportSha256:sha(await readFile(`${reference}/report.json`)),referenceSourceHashes:report.sourceHashes});
}
await writeFile(output,JSON.stringify({cases,postTradeOriginalGbaSaveAccepted:true,qualifierSha256:sha(await readFile('scripts/check-earned-trade-readback.ts')),
  sourceJourneyReportSha256:sha(await readFile(`build/${tag}-journey-report.json`)),fullAdventureQualified:false,publicReleaseQualified:false,
  scope:'Unchanged original GBA Continue/party-menu acceptance and exact earned party plus recorded storage bytes after the local browser trade. Not full pixel/audio parity, hosted Auth or all populated-box scenarios.'},null,2)+'\n');
console.log(JSON.stringify({output,originalGbaPostTradeReadback:true,cases:cases.length}));
