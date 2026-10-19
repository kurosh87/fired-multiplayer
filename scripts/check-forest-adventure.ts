import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename,dirname,resolve} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {WasmEngine,type EngineManifest} from '../packages/engine/runtime.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint} from '../packages/engine/checkpoint.ts';
import type {InputRun} from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const [version='firered',finalName='forest-save-audio',tag]=process.argv.slice(2);
assert(['firered','leafgreen'].includes(version));assert(/^[a-z0-9-]{1,50}$/.test(finalName));assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const output=resolve(`build/adventure-qualification/${tag}`);assert(!existsSync(output),'Preserve prior qualification evidence.');
const directory=resolve(`build/game-source/${version}/audio-16`),bytes=new Uint8Array(await readFile(directory+'/candidate.wasm'));
const manifest=JSON.parse(await readFile(directory+'/candidate.json','utf8')) as EngineManifest;
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');assert.equal(sha(bytes),manifest.wasmSha256);
const sourceReplay=`tests/replays/${version}-audio-pc-storage.json`,baseReplay=JSON.parse(await readFile(sourceReplay,'utf8'));
const sourcePoint=resolve(directory,'route-audio-pc-desktop.checkpoint');
const sourceCheckpoint=await readFile(sourcePoint),chain:any[]=[];
let current=resolve(`build/adventure-exploration/${version}/${finalName}`);
while(true){
  assert(current.startsWith(resolve('build/adventure-exploration',version)+'/'));assert(chain.length<30,'Cyclic lineage.');
  const segment={...JSON.parse(await readFile(current+'/report.json','utf8')),path:current};
  assert.equal(segment.artifactId,manifest.id);assert.equal(segment.wasmSha256,manifest.wasmSha256);
  assert.equal(segment.inspectionMutatesCanonicalState,false);
  let source=await readFile(segment.source);if(segment.source.endsWith('.gz'))source=gunzipSync(source);
  assert.equal(sha(source),segment.sourceCheckpointSha256);
  assert.equal(segment.frameCount,segment.runs.reduce((n:number,r:InputRun)=>n+r.frames,0));
  assert.equal(segment.start.frame+segment.frameCount,segment.end.frame);chain.unshift(segment);
  if(resolve(segment.source)===sourcePoint)break;
  assert.equal(basename(segment.source),'checkpoint.gz');current=dirname(segment.source);
}
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
const engine=await WasmEngine.create(bytes,manifest,baseReplay.seed),copies:WasmEngine[]=[];
type Core=Record<string,any>&{memory:WebAssembly.Memory};
function inspect(target:WasmEngine){
  const before=target.digest(),c=target.bindExtension<Core>('kanto_lobby_save_abi_version',1,['GetMonData2','CheckBagHasItem']);
  const m=new DataView(c.memory.buffer),save=m.getUint32(c.gSaveBlock1Ptr.value,true);
  const flag=(id:number)=>Boolean(m.getUint8(save+0xee0+(id>>>3))&(1<<(id&7)));
  const itemCount=(id:number)=>{let lo=0,hi=65535;while(lo<hi){const mid=Math.floor((lo+hi+1)/2);if(c.CheckBagHasItem(id,mid))lo=mid;else hi=mid-1;}return lo;};
  const count=m.getUint8(c.gPlayerPartyCount.value);assert(count>=1&&count<=6);
  const party=Array.from({length:count},(_,slot)=>{
    const get=(field:number)=>c.GetMonData2(c.gPlayerParty.value+slot*100,field);assert.equal(get(4),0);
    return {species:get(11),level:get(56),hp:get(57),maxHp:get(58),experience:get(25),personality:get(0)>>>0,trainerId:get(1)>>>0,
      checksum:get(9),moves:[13,14,15,16].map(get),pp:[17,18,19,20].map(get)};
  });
  const storage=m.getUint32(c.gPokemonStoragePtr.value,true);
  const state={map:[m.getUint8(save+4),m.getUint8(save+5)],position:[m.getInt16(save,true),m.getInt16(save+2,true)],party,
    oldManScene:m.getUint16(save+0x1000+0x51*2,true),teachyTv:itemCount(366),sammyDefeated:flag(0x500+104),forestVisited:flag(0x8a4),
    pokedex:flag(0x829),firstBadge:flag(0x820),balls:itemCount(4),questLog:m.getUint8(c.gQuestLogState.value),fileStatus:m.getUint16(c.gSaveFileStatus.value,true),
    fieldLocked:c.ArePlayerFieldControlsLocked(),scriptEnabled:c.ScriptContext_IsEnabled(),storageSha256:sha(new Uint8Array(c.memory.buffer,storage,0x83d0))};
  assert.equal(target.digest(),before,'Passive progress inspection changed canonical state.');return {state,c,storage};
}
try{
  const c=engine.bindExtension<Core>('kanto_lobby_save_abi_version',1,[]);
  const immutable=()=>sha(new Uint8Array(c.memory.buffer,c.kanto_immutable_ptr(),c.kanto_immutable_size()));
  const immutableBefore=immutable();
  for(const input of baseReplay.runs)engine.advance([input]);
  assert.equal(engine.frame,baseReplay.expectedFrames);assert.equal(engine.digest(),baseReplay.expectedDigest);
  assert.equal(sha(engine.snapshot()),sha(sourceCheckpoint),'Full replay did not match the retained browser checkpoint.');
  const initial=inspect(engine).state,milestones:any[]=[];
  for(const segment of chain){
    assert.equal(engine.frame,segment.start.frame);assert.equal(engine.digest(),segment.start.digest);
    for(const input of segment.runs)engine.advance([input]);
    assert.equal(engine.frame,segment.end.frame);assert.equal(engine.digest(),segment.end.digest,`Pure input replay: ${segment.path}`);
    milestones.push({name:basename(segment.path),frame:engine.frame,digest:engine.digest()});
  }
  const {state:expected,c:finalCore,storage}=inspect(engine),flash=engine.flash();
  assert.equal(sha(flash),sha(await readFile(resolve(`build/adventure-exploration/${version}/${finalName}/cartridge.sav`))));
  assert.deepEqual(expected.map,[3,2],'The route must finish in Pewter City.');
  assert.equal(expected.oldManScene,2);assert.equal(expected.teachyTv,1);assert(expected.sammyDefeated&&expected.forestVisited&&expected.pokedex);
  assert.equal(expected.firstBadge,false,'This route does not qualify Brock.');
  assert.equal(expected.party.length,2);assert(expected.party.every(mon=>mon.hp===mon.maxHp));
  assert(expected.party[0]!.level>initial.party[0]!.level);
  for(let i=0;i<2;i++)for(const key of ['species','personality','trainerId'] as const)assert.equal(expected.party[i]![key],initial.party[i]![key]);
  assert.equal(expected.storageSha256,initial.storageSha256);assert.equal(expected.balls,initial.balls);
  assert.equal(immutable(),immutableBefore);assert.equal(finalCore.kanto_render_frame(),0);
  const partyBytes=new Uint8Array(finalCore.memory.buffer,finalCore.gPlayerParty.value,200).slice();
  assert.equal(expected.fieldLocked,0);assert.equal(expected.scriptEnabled,0);assert.equal(expected.fileStatus,1);
  assert.equal(new DataView(finalCore.memory.buffer).getUint16(finalCore.gSaveAttemptStatus.value,true),1);
  const continuation=JSON.parse(await readFile('tests/replays/continue.json','utf8')),continueRuns:InputRun[]=[...continuation.runs];
  const loaded=await WasmEngine.create(bytes,manifest,baseReplay.seed,flash);copies.push(loaded);
  for(const run of continueRuns)loaded.advance([run]);
  for(let i=0;i<120&&inspect(loaded).state.questLog>=2;i++)for(const run of [{buttons:2,frames:1},{buttons:0,frames:30}]){loaded.advance([run]);continueRuns.push(run);}
  for(const run of [{buttons:0,frames:60},{buttons:0,frames:60}]){loaded.advance([run]);continueRuns.push(run);}
  const checkLoaded=()=>{
    const actual=inspect(loaded).state;
    for(const key of ['map','position','party','oldManScene','teachyTv','sammyDefeated','forestVisited','pokedex','firstBadge','balls','storageSha256'] as const)
      assert.deepEqual(actual[key],expected[key],`Continue ${key}`);
    assert.equal(actual.fileStatus,1);assert(actual.questLog<2);assert.equal(actual.fieldLocked,0);assert.equal(actual.scriptEnabled,0);assert.equal(sha(loaded.flash()),sha(flash));
  };
  checkLoaded();loaded.advance([{buttons:15,frames:1}]);for(const run of continueRuns)loaded.advance([run]);checkLoaded();
  const packed=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256),a=await WasmEngine.create(bytes,manifest,baseReplay.seed),b=await WasmEngine.create(bytes,manifest,baseReplay.seed);copies.push(a,b);
  for(const copy of [a,b])copy.restore(decodeCheckpoint(packed,baseline,manifest.wasmSha256));
  for(const run of [{buttons:0,frames:30},{buttons:32,frames:1},{buttons:0,frames:30}]){a.advance([run]);b.advance([run]);assert.equal(a.digest(),b.digest());}
  await mkdir(output,{recursive:false});
  await writeFile(output+'/adventure.sav',flash);await writeFile(output+'/party.bin',partyBytes);
  await writeFile(output+'/storage.bin',new Uint8Array(finalCore.memory.buffer,storage,0x83d0));await writeFile(output+'/checkpoint.gz',gzipSync(packed));
  const labels:Record<string,string>={'forest-heal-audio':'viridian-healed','forest-route2-audio':'old-man-tutorial','forest-enter-audio':'forest-intro','forest-flee-audio':'forest-trainer','forest-pewter-audio':'pewter-arrival','forest-save-audio':'pewter-saved'};
  const replay={...baseReplay,description:'Input-earned adventure through Viridian catching tutorial, Teachy TV, Route 2, Viridian Forest trainer, Pewter healing and original save.',
    expectedParty:expected.party,expectedInventory:{...baseReplay.expectedInventory,balls:expected.balls,pokedex:expected.pokedex,teachyTv:expected.teachyTv},
    expectedProgress:{oldManScene:expected.oldManScene,sammyDefeated:expected.sammyDefeated,forestVisited:expected.forestVisited,firstBadge:expected.firstBadge},
    runs:[...baseReplay.runs,...chain.flatMap(segment=>segment.runs)],expectedFrames:engine.frame,expectedDigest:engine.digest(),
    milestones:[...(baseReplay.milestones??[]),...milestones.map(m=>({name:labels[m.name]??m.name,frame:m.frame,restore:true}))]};
  await writeFile(output+'/replay.json',JSON.stringify(replay,null,2)+'\n');
  const partyRuns=[...continueRuns,{buttons:8,frames:1},{buttons:0,frames:30},{buttons:128,frames:1},{buttons:0,frames:24},{buttons:1,frames:1},{buttons:0,frames:60},{buttons:0,frames:60},{buttons:0,frames:60}];
  await writeFile(output+'/continue-party.json',JSON.stringify({seed:baseReplay.seed,sourceCommit:manifest.upstreamCommit,variants:[version],runs:partyRuns,expectedFrames:partyRuns.reduce((n,r)=>n+r.frames,0)},null,2)+'\n');
  await writeFile(output+'/report.json',JSON.stringify({artifactId:manifest.id,wasmSha256:manifest.wasmSha256,frames:engine.frame,digest:engine.digest(),
    initial,expected,flashSha256:sha(flash),partySha256:sha(partyBytes),storageSha256:expected.storageSha256,milestones,
    pureInputReplay:true,fullCheckpointLineageReplayed:true,inspectionDoesNotMutateState:true,immutableAssetsUnchanged:true,
    originalMenuSave:true,freshContinue:true,warmResetContinue:true,completeCheckpointRestore:true,
    sourceHashes:{qualifier:sha(await readFile('scripts/check-forest-adventure.ts')),explorer:sha(await readFile('scripts/explore-route.ts')),baseReplay:sha(await readFile(sourceReplay))},
    browserQualified:false,independentGbaReadback:false,firstGymQualified:false,fullAdventureQualified:false,hostedAccountsQualified:false,publicReleaseQualified:false},null,2)+'\n');
  console.log(JSON.stringify({output,version,frames:engine.frame,expected,pureInputReplay:true,freshContinue:true,warmResetContinue:true}));
}finally{for(const copy of copies)copy.close();engine.close();}
