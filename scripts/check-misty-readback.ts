import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the shared build guard.');
const [version,tag]=process.argv.slice(2);assert(version&&['firered','leafgreen'].includes(version));assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const folder:string=resolve('build/adventure-qualification',tag),referenceFolder:string=`build/reference/${tag}`;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
assert(!existsSync(folder+'/native-proof.json')&&!existsSync(referenceFolder),'Preserve retained native evidence.');
const report=await load(folder+'/report.json'),expected=report.expected,lock=await load('engine/upstream.lock.json');
assert(report.pureInputContinuation&&report.originalMenuSave&&report.freshContinue&&report.warmResetContinue);
assert.equal(report.gameDirectory,`build/game-source/${version}/battle-text-audio-16`);assert.equal(report.independentGbaReadback,false);
assert.equal(hash(await readFile(folder+'/adventure.sav')),report.flashSha256);
const run=spawnSync('python3',['-B','scripts/run-reference.py','--version',version,'--save',folder+'/adventure.sav',
  '--replay',folder+'/continue-party.json','--output',referenceFolder,'--dump-storage'],{stdio:'inherit'});assert.equal(run.status,0);
const native=await load(referenceFolder+'/report.json'),baseline=await load(`build/baseline/${version}.json`),movie=await load(folder+'/continue-party.json');
assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
assert.equal(createHash('sha1').update(await readFile(baseline.rom)).digest('hex'),baseline.sha1);
assert.equal(native.romSha1,baseline.sha1);assert.equal(native.referenceCommit,lock.mgbaReference.commit);assert.equal(native.storageReadback,true);
assert.equal(native.sourceHashes.runner,hash(await readFile('scripts/run-reference.py')));assert.equal(native.sourceHashes.harness,hash(await readFile('engine/reference/headless.c')));
assert.equal(native.restoredFlashSha256,report.flashSha256);assert.equal(native.frames,movie.expectedFrames);
const last=native.points.at(-1);assert(last);assert.equal(last.callback,'CB2_UpdatePartyMenu');assert.equal(last.saveStatus,1);assert(last.questLog<2);assert.equal(last.partyCount,2);
const party=await readFile(folder+'/party.bin'),nativeParty=await readFile(referenceFolder+'/party.bin');assert.equal(party.length,200);assert.equal(nativeParty.length,600);
assert.equal(hash(party),report.partySha256);assert.deepEqual(nativeParty.subarray(0,200),party);
for(let i=0;i<2;i++)assert.equal(nativeParty[i*100+0x13]!&1,0);
for(let i=2;i<6;i++)assert.equal(nativeParty[i*100+0x13]!&2,0);
const storage=await readFile(referenceFolder+'/storage.bin');assert.equal(storage.length,0x83d0);assert.equal(hash(storage),report.storageSha256);assert.deepEqual(storage,await readFile(folder+'/storage.bin'));
const save=await readFile(referenceFolder+'/saveblock1.bin'),save2=await readFile(referenceFolder+'/saveblock2.bin');assert.equal(save.length,0x3d68);assert.equal(save2.length,0xf24);
const key=save2.readUInt32LE(0xf20),flag=(id:number)=>Boolean(save[0xee0+(id>>>3)]!&(1<<(id&7)));
const count=(offset:number,slots:number,id:number)=>Array.from({length:slots},(_,i)=>({
  id:save.readUInt16LE(offset+i*4),quantity:save.readUInt16LE(offset+i*4+2)^(key&0xffff)
})).filter(item=>item.id===id).reduce((sum,item)=>sum+item.quantity,0);
const progress={map:[save[4],save[5]],position:[save.readInt16LE(0),save.readInt16LE(2)],
  badges:Array.from({length:8},(_,i)=>flag(0x820+i)),brockDefeated:flag(0x4b0),brockTrainer:flag(0x500+414),liamDefeated:flag(0x500+142),
  tm39Received:flag(0x254),tm39:count(0x464,58,327),teachyTv:count(0x3b8,30,366),balls:count(0x430,13,4),pokedex:flag(0x829),
  money:(save.readUInt32LE(0x290)^key)>>>0,trades:(save.readUInt32LE(0x1200+21*4)^key)>>>0,storageSha256:hash(storage),
  evolutions:(save.readUInt32LE(0x1200+14*4)^key)>>>0,pokeCenters:(save.readUInt32LE(0x1200+15*4)^key)>>>0,
  mistyDefeated:flag(0x4b1),tm03Received:flag(0x297),tm03:count(0x464,58,291),
  runningShoes:flag(0x82f),fossilReceived:flag(0x232),domeFossil:flag(0x272),helixFossil:flag(0x273),
  domeFossils:count(0x3b8,30,358),helixFossils:count(0x3b8,30,357),defeatedTrainers:Array.from({length:743},(_,id)=>flag(0x500+id)?id:-1).filter(id=>id>=0)};
for(const [name,value] of Object.entries(progress))assert.deepEqual(value,expected[name],`Original GBA saved story state ${name}`);
await writeFile(folder+'/native-proof.json',JSON.stringify({version,checkedAt:new Date().toISOString(),qualificationReportSha256:hash(await readFile(folder+'/report.json')),
  sourceSha256:hash(await readFile('scripts/check-misty-readback.ts')),referenceFolder,referenceReportSha256:hash(await readFile(referenceFolder+'/report.json')),
  romSha1:baseline.sha1,referenceCommit:native.referenceCommit,allPartyBytesIdentical:true,all14BoxesIdentical:true,noBadEggs:true,nativeProgress:progress,
  scope:'Original GBA Continue, complete party/storage bytes and selected native story progress; not full-game pixel/audio parity.'},null,2)+'\n');
console.log(JSON.stringify({version,tag,independentGbaReadback:true}));
