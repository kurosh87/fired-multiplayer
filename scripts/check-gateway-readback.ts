import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Independent native-GBA readback of the exact two-save gateway commit. This
// does not promote experimental artifacts or qualify hosted accounts/capacity.
const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the shared build guard.');
const [tag]=process.argv.slice(2);assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag),'Use a retained gateway evidence tag.');
const output=`build/${tag}-readback.json`;assert(!existsSync(output),'Preserve retained readback evidence.');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const reportPath=`build/${tag}-report.json`,report=await load(reportPath),lock=await load('engine/upstream.lock.json');
assert(report.repairedBattleText&&report.tradeMovieAndCommitQualified&&report.earnedFirstGymProgressPreserved);
assert(report.originalTradeCounterIncrementedOnce&&report.publicArtifactsStillUnadmitted&&report.apiErrorLogsAbsent);
assert.equal(report.publicReleaseQualified,false);assert.equal(report.trade.committed.length,2);
const proofs=[];
for(const [index,version] of ['firered','leafgreen'].entries()){
  const committed=report.trade.committed[index];assert.equal(committed.version,version);
  const expected=committed.progress,artifacts=committed.artifacts,folder=resolve('build/gateway-qualification',tag);
  for(const [kind,extension] of [['cartridge','sav'],['party','bin'],['storage','bin']] as const){
    assert.equal(artifacts[kind],resolve(folder,`${version}-${kind}.${extension}`));
    assert.equal(hash(await readFile(artifacts[kind])),artifacts[kind+'Sha256']);
  }
  assert.equal(committed.flashSha256,artifacts.cartridgeSha256);assert.equal(expected.storageSha256,artifacts.storageSha256);
  assert.equal(artifacts.continuation,resolve(folder,`${version}-continue-party.json`));
  const movie=await load(artifacts.continuation);
  const referenceFolder:string=`build/reference/${tag}-${version}`;
  assert(!existsSync(referenceFolder),'Preserve retained native output.');
  const run=spawnSync('python3',['-B','scripts/run-reference.py','--version',version,'--save',artifacts.cartridge,
    '--replay',artifacts.continuation,'--output',referenceFolder,'--dump-storage'],{stdio:'inherit'});
  assert.equal(run.status,0,`Native ${version} readback failed.`);
  const native=await load(referenceFolder+'/report.json'),baseline=await load(`build/baseline/${version}.json`);
  assert.equal(baseline.matchesOriginal,true);assert.equal(baseline.sourceCommit,lock.firered.commit);
  assert.equal(createHash('sha1').update(await readFile(baseline.rom)).digest('hex'),baseline.sha1);
  assert.equal(native.romSha1,baseline.sha1);assert.equal(native.referenceCommit,lock.mgbaReference.commit);
  assert.equal(native.restoredFlashSha256,committed.flashSha256);assert.equal(native.storageReadback,true);
  assert.equal(native.sourceHashes.runner,hash(await readFile('scripts/run-reference.py')));
  assert.equal(native.sourceHashes.harness,hash(await readFile('engine/reference/headless.c')));
  assert.equal(native.frames,movie.expectedFrames);const last=native.points.at(-1);assert(last);
  assert.equal(last.callback,'CB2_UpdatePartyMenu');assert.equal(last.saveStatus,1);assert(last.questLog<2);assert.equal(last.partyCount,2);
  const party=await readFile(artifacts.party),nativeParty=await readFile(referenceFolder+'/party.bin');
  assert.equal(party.length,200);assert.equal(nativeParty.length,600);assert.deepEqual(nativeParty.subarray(0,200),party);
  for(let i=0;i<2;i++)assert.equal(nativeParty[i*100+0x13]!&1,0,'Native Bad Egg');
  for(let i=2;i<6;i++)assert.equal(nativeParty[i*100+0x13]!&2,0,'Unexpected native party member');
  const storage=await readFile(referenceFolder+'/storage.bin');assert.equal(storage.length,0x83d0);
  assert.deepEqual(storage,await readFile(artifacts.storage));
  const save=await readFile(referenceFolder+'/saveblock1.bin'),save2=await readFile(referenceFolder+'/saveblock2.bin');
  assert.equal(save.length,0x3d68);assert.equal(save2.length,0xf24);
  const key=save2.readUInt32LE(0xf20),flag=(id:number)=>Boolean(save[0xee0+(id>>>3)]!&(1<<(id&7)));
  const count=(offset:number,slots:number,id:number)=>Array.from({length:slots},(_,i)=>({
    id:save.readUInt16LE(offset+i*4),quantity:save.readUInt16LE(offset+i*4+2)^(key&0xffff)
  })).filter(item=>item.id===id).reduce((sum,item)=>sum+item.quantity,0);
  const progress={map:[save[4],save[5]],position:[save.readInt16LE(0),save.readInt16LE(2)],
    badges:Array.from({length:8},(_,i)=>flag(0x820+i)),brockDefeated:flag(0x4b0),brockTrainer:flag(0x500+414),liamDefeated:flag(0x500+142),
    tm39Received:flag(0x254),tm39:count(0x464,58,327),teachyTv:count(0x3b8,30,366),balls:count(0x430,13,4),pokedex:flag(0x829),
    money:(save.readUInt32LE(0x290)^key)>>>0,trades:(save.readUInt32LE(0x1200+21*4)^key)>>>0,storageSha256:hash(storage)};
  assert.deepEqual(progress,expected,'Original GBA progress differs from the verified online trade.');assert.equal(progress.trades,1);
  proofs.push({version,referenceFolder,romSha1:baseline.sha1,referenceCommit:native.referenceCommit,
    restoredFlashSha256:native.restoredFlashSha256,allPartyBytesIdentical:true,all14BoxesIdentical:true,noBadEggs:true,
    progress,referenceReportSha256:hash(await readFile(referenceFolder+'/report.json')),continuationSha256:hash(await readFile(artifacts.continuation))});
}
await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),gatewayReport:reportPath,
  gatewayReportSha256:hash(await readFile(reportPath)),sourceSha256:hash(await readFile('scripts/check-gateway-readback.ts')),
  independentPostTradeGbaReadback:true,proofs,publicReleaseQualified:false,hostedDeploymentQualified:false,capacity1000Qualified:false,
  scope:'Original GBA Continue, all party/storage bytes and selected earned progress after the atomic gateway trade; not full-game pixel/audio parity.'},null,2)+'\n');
console.log(JSON.stringify({independentPostTradeGbaReadback:true,output}));
