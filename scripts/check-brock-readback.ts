import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const [version,tag]=process.argv.slice(2);assert(version&&['firered','leafgreen'].includes(version));assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const folder=resolve(`build/adventure-qualification/${tag}`),referenceFolder=resolve(`build/reference/${tag}`);
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8')),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const report=await load(folder+'/report.json'),expected=report.expected,reference=await load(referenceFolder+'/report.json');
assert.equal(report.independentGbaReadback,false,'Preserve an already augmented report.');
assert.equal(report.gameDirectory,`build/game-source/${version}/battle-text-audio-16`);
const baseline=await load(`build/baseline/${version}.json`),lock=await load('engine/upstream.lock.json'),manifest=await load(report.gameDirectory+'/candidate.json');
assert.equal(manifest.id,report.artifactId);assert.equal(sha(await readFile(report.gameDirectory+'/candidate.wasm')),report.wasmSha256);
assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
assert.equal(createHash('sha1').update(await readFile(resolve(baseline.rom))).digest('hex'),baseline.sha1);
assert.equal(reference.romSha1,baseline.sha1);assert.equal(reference.referenceCommit,lock.mgbaReference.commit);assert.equal(reference.storageReadback,true);
assert.equal(reference.sourceHashes.runner,sha(await readFile('scripts/run-reference.py')));assert.equal(reference.sourceHashes.harness,sha(await readFile('engine/reference/headless.c')));
assert.equal(sha(await readFile(folder+'/adventure.sav')),report.flashSha256);assert.equal(reference.restoredFlashSha256,report.flashSha256);
const continuation=await load(folder+'/continue-party.json');assert.equal(reference.frames,continuation.expectedFrames);
const last=reference.points.at(-1);assert(last);assert.equal(last.callback,'CB2_UpdatePartyMenu');assert.equal(last.saveStatus,1);assert(last.questLog<2);assert.equal(last.partyCount,2);
assert.deepEqual([last.mapGroup,last.mapNumber],expected.map);
const party=await readFile(folder+'/party.bin'),nativeParty=await readFile(referenceFolder+'/party.bin');
assert.equal(party.length,200);assert.equal(nativeParty.length,600);assert.equal(sha(party),report.partySha256);assert.deepEqual(nativeParty.subarray(0,200),party);
for(let i=0;i<2;i++)assert.equal(nativeParty[i*100+0x13]!&1,0);
for(let i=2;i<6;i++)assert.equal(nativeParty[i*100+0x13]!&2,0);
const storage=await readFile(folder+'/storage.bin'),nativeStorage=await readFile(referenceFolder+'/storage.bin');
assert.equal(storage.length,0x83d0);assert.equal(nativeStorage.length,0x83d0);assert.equal(sha(storage),report.storageSha256);assert.deepEqual(nativeStorage,storage);
const save=await readFile(referenceFolder+'/saveblock1.bin'),save2=await readFile(referenceFolder+'/saveblock2.bin');assert.equal(save.length,0x3d68);assert.equal(save2.length,0xf24);
assert.deepEqual([save.readInt16LE(0),save.readInt16LE(2)],expected.position);
const flag=(id:number)=>Boolean(save[0xee0+(id>>>3)]!&(1<<(id&7))),key=save2.readUInt32LE(0xf20)&0xffff;
const count=(offset:number,slots:number,id:number)=>Array.from({length:slots},(_,i)=>({id:save.readUInt16LE(offset+i*4),quantity:save.readUInt16LE(offset+i*4+2)^key}))
  .filter(item=>item.id===id).reduce((sum,item)=>sum+item.quantity,0);
const nativeProgress={badges:Array.from({length:8},(_,i)=>flag(0x820+i)),brockDefeated:flag(0x4b0),brockTrainer:flag(0x500+414),liamDefeated:flag(0x500+142),
  tm39Received:flag(0x254),tm39:count(0x464,58,327),teachyTv:count(0x3b8,30,366),balls:count(0x430,13,4),pokedex:flag(0x829),money:(save.readUInt32LE(0x290)^save2.readUInt32LE(0xf20))>>>0};
for(const [name,value] of Object.entries(nativeProgress))assert.deepEqual(value,expected[name],`Original GBA saved progress ${name}`);
const proof={scope:'Original GBA Continue and native party/storage/badge/TM/money RAM; not full gameplay pixel/audio parity.',
  romSha1:baseline.sha1,referenceCommit:reference.referenceCommit,allPartyBytesIdentical:true,all14BoxesIdentical:true,noBadEggs:true,
  nativeProgress,referenceFolder,referenceSourceHashes:reference.sourceHashes,sourceSha256:sha(await readFile('scripts/check-brock-readback.ts'))};
await writeFile(folder+'/report.json',JSON.stringify({...report,independentGbaReadback:true,independentSaveProof:proof},null,2)+'\n');
console.log(JSON.stringify({version,tag,...proof}));
