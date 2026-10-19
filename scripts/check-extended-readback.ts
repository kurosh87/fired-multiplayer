import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const version=process.argv[2]??'firered';assert(['firered','leafgreen'].includes(version));
const directory=resolve(process.argv[3]??`build/adventure-qualification/${version}-catch`);
const referenceDirectory=resolve(process.argv[4]??`build/reference/${version}-route1-catch`);
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const report=await load(resolve(directory,'report.json'));
const reference=await load(resolve(referenceDirectory,'report.json'));
const baseline=await load(resolve('build/baseline',`${version}.json`));
const lock=await load('engine/upstream.lock.json');
const manifest=await load(resolve(`build/game-source/${version}/memory-16/candidate.json`));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
assert.equal(report.artifactId,manifest.id);assert.equal(report.wasmSha256,manifest.wasmSha256);
assert.equal(sha(await readFile(resolve(`build/game-source/${version}/memory-16/candidate.wasm`))),manifest.wasmSha256);
assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
assert.equal(createHash('sha1').update(await readFile(resolve(baseline.rom))).digest('hex'),baseline.sha1);
assert.equal(reference.romSha1,baseline.sha1);assert.equal(reference.referenceCommit,lock.mgbaReference.commit);
const flash=await readFile(resolve(directory,'adventure.sav'));assert.equal(flash.length,128*1024);
assert.equal(sha(flash),report.flashSha256);assert.equal(reference.restoredFlashSha256,report.flashSha256);
const input=await load(resolve(directory,'continue-party.json'));assert.equal(reference.frames,input.expectedFrames);
const last=reference.points.at(-1);assert(last);
assert.equal(last.callback,'CB2_UpdatePartyMenu','Open the original GBA Pokemon menu, including the newly unlocked Pokedex entry.');
assert.equal(last.saveStatus,1);assert(last.questLog<2);assert.equal(last.partyCount,report.party.length);
assert.equal(last.mapGroup,report.map[0]);assert.equal(last.mapNumber,report.map[1]);
assert.equal(last.level,report.party[0].level);assert.equal(last.hp,report.party[0].hp);assert.equal(last.isBadEgg,0);
const expected=await readFile(resolve(directory,'party.bin'));
assert.equal(expected.length,report.party.length*100);assert.equal(sha(expected),report.partySha256);
const actual=await readFile(resolve(referenceDirectory,'party.bin'));
assert.equal(Buffer.compare(expected,actual.subarray(0,expected.length)),0,'Original GBA party bytes differ from the caught-party save.');
for(let i=0;i<report.party.length;i++)assert.equal(actual[i*100+0x13]!&1,0,`Original GBA rejected party slot ${i}.`);
const save1=await readFile(resolve(referenceDirectory,'saveblock1.bin')),save2=await readFile(resolve(referenceDirectory,'saveblock2.bin'));
assert.equal(save1.length,0x3d68);assert.equal(save2.length,0xf24);
const key=save2.readUInt32LE(0xf20)&0xffff;
const pocket=(offset:number,count:number)=>Array.from({length:count},(_,i)=>({id:save1.readUInt16LE(offset+i*4),quantity:save1.readUInt16LE(offset+i*4+2)^key}));
const nativeInventory={balls:pocket(0x430,13).filter(item=>item.id===4).reduce((sum,item)=>sum+item.quantity,0),
  parcel:pocket(0x3b8,30).some(item=>item.id===349&&item.quantity>0),
  pokedex:Boolean(save1[0xee0+(0x829>>>3)]!&(1<<(0x829&7))),scene:save1.readUInt16LE(0x1000+0x55*2)};
assert.equal(nativeInventory.balls,report.inventory.balls);assert.equal(nativeInventory.parcel,report.inventory.parcel);
assert.equal(nativeInventory.pokedex,report.inventory.pokedex);assert.equal(nativeInventory.scene,6);
const proof={scope:'original GBA saved-game load and party menu; not full gameplay pixel parity',romSha1:reference.romSha1,
  referenceCommit:reference.referenceCommit,flashSha256:report.flashSha256,partySha256:report.partySha256,allPartyBytesIdentical:true,
  noBadEggs:true,originalPartyMenu:true,nativeInventory,referenceDirectory,sourceSha256:sha(await readFile('scripts/check-extended-readback.ts'))};
await writeFile(resolve(directory,'report.json'),JSON.stringify({...report,independentGbaReadback:true,independentSaveProof:proof},null,2)+'\n');
console.log(JSON.stringify(proof));
