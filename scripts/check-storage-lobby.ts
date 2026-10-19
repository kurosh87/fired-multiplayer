import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import { inspectLobbyParty, prepareLobbySave } from '../packages/trading/prepare-lobby.ts';
import { DomainError } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const version=process.argv[2]??'leafgreen';assert(['firered','leafgreen'].includes(version));
const directory=resolve(`build/game-source/${version}/memory-16`),evidence=resolve(`build/adventure-qualification/${version}-storage`);
const output=resolve(evidence,'lobby-integration.json');assert(!existsSync(output),'Preserve retained evidence.');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const report=JSON.parse(await readFile(resolve(evidence,'report.json'),'utf8'));
const manifest=JSON.parse(await readFile(resolve(directory,'candidate.json'),'utf8')) as EngineManifest;
assert.equal(manifest.id,report.artifactId);
const bytes=new Uint8Array(await readFile(resolve(directory,'candidate.wasm')));
assert.equal(sha(bytes),report.wasmSha256);
const replay=JSON.parse(await readFile(resolve(evidence,'replay.json'),'utf8'));
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
const identity=(mon:any)=>({species:mon.species,personality:mon.personality,trainerId:mon.trainerId,
  level:mon.level,hp:mon.hp,maxHp:mon.maxHp,checksum:mon.checksum,moves:mon.moves});
const phases:Record<string,any>={};
for(const phase of ['deposit','withdraw']){
  const flash=new Uint8Array(await readFile(resolve(evidence,phase+'.sav'))),before=sha(flash);
  assert.equal(before,report.phases[phase].flashSha256);
  const party=await inspectLobbyParty(bytes,manifest,replay.seed,flash);
  assert.deepEqual(party.map(identity),report.phases[phase].state.party.map(identity));
  assert(party.every(mon=>!mon.badEgg));assert.equal(sha(flash),before);
  phases[phase]={partyCount:party.length,species:party.map(mon=>mon.species),onlyCurrentPartyExposed:true,sourceFlashUnchanged:true};
}
const packed=new Uint8Array(gunzipSync(await readFile(resolve(evidence,'checkpoint.gz'))));
const snapshot=decodeCheckpoint(packed,baseline,manifest.wasmSha256),originalSnapshotHash=sha(snapshot);
// Repeated A inputs can reopen the nearby PC after the original Save finishes.
// Admission must reject this state until recorded controller inputs close it.
await assert.rejects(()=>prepareLobbySave(bytes,manifest,replay.seed,snapshot),error=>error instanceof DomainError&&error.code==='LOBBY_UNSAFE_LOCATION');
const bridgePath=`build/adventure-exploration/${version}/storage-field-return/report.json`;
const bridge=JSON.parse(await readFile(bridgePath,'utf8'));
assert.equal(bridge.artifactId,manifest.id);assert.equal(bridge.start.frame,report.frames);assert.equal(bridge.start.digest,report.digest);
assert.equal(bridge.inspectionMutatesCanonicalState,false);
assert.equal(bridge.end.fieldLocked,0);assert.equal(bridge.end.scriptEnabled,0);
const field=await WasmEngine.create(bytes,manifest,replay.seed);
let fieldSnapshot:Uint8Array;
try{
  field.restore(snapshot);for(const run of bridge.runs)field.advance([run]);
  assert.equal(field.frame,bridge.end.frame);assert.equal(field.digest(),bridge.end.digest);
  fieldSnapshot=field.snapshot();
}finally{field.close();}
const fieldSnapshotHash=sha(fieldSnapshot);
const prepared=await prepareLobbySave(bytes,manifest,replay.seed,fieldSnapshot);
assert.equal(sha(snapshot),originalSnapshotHash,'Lobby preparation edited the verified source checkpoint.');
assert.equal(sha(fieldSnapshot),fieldSnapshotHash,'Lobby preparation edited the field checkpoint.');
assert.deepEqual(prepared.party.map(identity),report.phases.withdraw.state.party.map(identity));
const clone=await WasmEngine.create(bytes,manifest,replay.seed);
try{
  clone.restore(prepared.snapshot);assert.equal(clone.digest(),prepared.digest);
  const c=clone.bindExtension<any>('kanto_lobby_save_abi_version',1,['kanto_lobby_save']);
  const address=new DataView(c.memory.buffer).getUint32(c.gPokemonStoragePtr.value,true);
  assert.equal(sha(new Uint8Array(c.memory.buffer,address,0x83d0)),report.phases.withdraw.storageSha256);
  assert.equal(sha(clone.flash()),sha(prepared.flash));
}finally{clone.close();}
const midPcPacked=new Uint8Array(gunzipSync(await readFile(`build/adventure-exploration/${version}/storage-deposit/checkpoint.gz`)));
const midPc=decodeCheckpoint(midPcPacked,baseline,manifest.wasmSha256),midPcHash=sha(midPc);
await assert.rejects(()=>prepareLobbySave(bytes,manifest,replay.seed,midPc),error=>error instanceof DomainError&&error.code==='LOBBY_UNSAFE_LOCATION');
assert.equal(sha(midPc),midPcHash);
await writeFile(output,JSON.stringify({artifactId:manifest.id,phases,
  lobbySavePreservesPartyAndAllBoxes:true,sourceCheckpointUnchanged:true,midPcAdmissionRejected:true,
  pcReopenedAfterSaveRejected:true,recordedFieldReturn:{runs:bridge.runs,frame:bridge.end.frame,digest:bridge.end.digest,sourceReport:bridgePath},
  sourceHashes:{qualifier:sha(new Uint8Array(await readFile('scripts/check-storage-lobby.ts'))),
    productionBinding:sha(new Uint8Array(await readFile('packages/trading/prepare-lobby.ts')))},
  hostedAccountCoverage:false,networkedTradeCoverage:false,
  scope:'Production lobby party inspection and save preparation with earned PC saves; not hosted account or end-to-end trade qualification.'},null,2)+'\n');
console.log(JSON.stringify({output,phases,lobbySavePreservesPartyAndAllBoxes:true,midPcAdmissionRejected:true}));
