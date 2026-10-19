import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [version='leafgreen',phase='deposit',tag=`${version}-storage`]=process.argv.slice(2);
assert(['firered','leafgreen'].includes(version));assert(['deposit','withdraw'].includes(phase));assert(/^[a-z0-9-]{1,60}$/.test(tag));
const directory=resolve('build/adventure-qualification',tag),referenceDirectory=resolve(`build/reference/${tag}-${phase}`);
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const report=await load(resolve(directory,'report.json')),expected=report.phases[phase];assert(expected);
const reference=await load(resolve(referenceDirectory,'report.json')),baseline=await load(`build/baseline/${version}.json`),lock=await load('engine/upstream.lock.json');
const manifest=await load(`build/game-source/${version}/memory-16/candidate.json`);
assert.equal(manifest.id,report.artifactId);assert.equal(manifest.wasmSha256,report.wasmSha256);
assert.equal(sha(await readFile(`build/game-source/${version}/memory-16/candidate.wasm`)),report.wasmSha256);
assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
assert.equal(createHash('sha1').update(await readFile(resolve(baseline.rom))).digest('hex'),baseline.sha1);
assert.equal(reference.romSha1,baseline.sha1);assert.equal(reference.referenceCommit,lock.mgbaReference.commit);assert.equal(reference.storageReadback,true);
assert.equal(reference.sourceHashes.runner,sha(await readFile('scripts/run-reference.py')));
assert.equal(reference.sourceHashes.harness,sha(await readFile('engine/reference/headless.c')));
const flash=await readFile(resolve(directory,phase+'.sav'));assert.equal(flash.length,128*1024);assert.equal(sha(flash),expected.flashSha256);
assert.equal(reference.restoredFlashSha256,expected.flashSha256);
const continuation=await load(resolve(directory,phase+'-continue-party.json'));assert.equal(reference.frames,continuation.expectedFrames);
const last=reference.points.at(-1);assert(last);assert.equal(last.callback,'CB2_UpdatePartyMenu');
assert.equal(last.saveStatus,1);assert(last.questLog<2);assert.equal(last.partyCount,expected.state.party.length);
assert.equal(last.mapGroup,expected.state.map[0]);assert.equal(last.mapNumber,expected.state.map[1]);
assert.equal(last.level,expected.state.party[0].level);assert.equal(last.hp,expected.state.party[0].hp);assert.equal(last.isBadEgg,0);
const party=await readFile(resolve(directory,phase+'-party.bin')),nativeParty=await readFile(resolve(referenceDirectory,'party.bin'));
assert.equal(party.length,expected.state.party.length*100);assert.equal(sha(party),expected.partySha256);assert.equal(nativeParty.length,600);
assert.equal(Buffer.compare(party,nativeParty.subarray(0,party.length)),0,'Native party differs after PC save/Continue.');
for(let i=0;i<last.partyCount;i++)assert.equal(nativeParty[i*100+0x13]!&1,0);
for(let i=last.partyCount;i<6;i++)assert.equal(nativeParty[i*100+0x13]!&2,0,'Unexpected occupied native party slot.');
const storage=await readFile(resolve(directory,phase+'-storage.bin')),nativeStorage=await readFile(resolve(referenceDirectory,'storage.bin'));
assert.equal(storage.length,0x83d0);assert.equal(nativeStorage.length,0x83d0);assert.equal(sha(storage),expected.storageSha256);
assert.equal(Buffer.compare(storage,nativeStorage),0,'Complete original GBA PokemonStorage block differs, including boxes, names and wallpapers.');
assert.equal(nativeStorage[0],expected.state.currentBox);
const occupied=[];
for(let box=0;box<14;box++)for(let slot=0;slot<30;slot++){
  const offset=4+(box*30+slot)*80,flags=nativeStorage[offset+0x13]!;
  assert.equal(flags&1,0,'Bad egg flag in a native box.');
  if(flags&2)occupied.push({box,slot,recordSha256:sha(nativeStorage.subarray(offset,offset+80))});
}
assert.deepEqual(occupied,expected.state.boxes.map((mon:any)=>({box:mon.box,slot:mon.slot,recordSha256:mon.recordSha256})));
const save1=await readFile(resolve(referenceDirectory,'saveblock1.bin'));assert.equal(save1.length,0x3d68);
assert.deepEqual([save1.readInt16LE(0),save1.readInt16LE(2)],expected.state.position);
const proof={scope:'Original GBA Continue and party menu; complete PokemonStorage RAM bytes, not full gameplay pixel parity or all PC operations.',
  romSha1:baseline.sha1,referenceCommit:reference.referenceCommit,flashSha256:expected.flashSha256,
  partySha256:expected.partySha256,storageSha256:expected.storageSha256,allPartyBytesIdentical:true,all14BoxesIdentical:true,
  boxNamesAndWallpapersIdentical:true,noBadEggFlags:true,occupiedSlots:occupied,referenceDirectory,
  referenceSourceHashes:reference.sourceHashes,sourceSha256:sha(await readFile('scripts/check-storage-readback.ts'))};
expected.originalGbaReadback=true;expected.independentSaveProof=proof;
report.independentGbaReadback=['deposit','withdraw'].every(name=>report.phases[name].originalGbaReadback===true);
await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({version,phase,...proof}));
