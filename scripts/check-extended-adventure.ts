import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { InputRun } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const version=process.argv[2]??'firered';assert(['firered','leafgreen'].includes(version));
const finalDirectory=resolve(process.argv[3]??`build/adventure-exploration/${version}/save-caught-party`);
const output=resolve(process.argv[4]??`build/adventure-qualification/${version}-catch`);
const directory=resolve(`build/game-source/${version}/memory-16`);
const manifest=JSON.parse(await readFile(resolve(directory,'candidate.json'),'utf8')) as EngineManifest;
const bytes=new Uint8Array(await readFile(resolve(directory,'candidate.wasm')));
const originalPath=resolve(version==='firered'?'tests/replays/starter-rival-save.json':'tests/replays/leafgreen-starter-rival-save.json');
const original=JSON.parse(await readFile(originalPath,'utf8'));
const baseCheckpoint=resolve(directory,'gameplay.checkpoint');
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
type Point={frame:number;digest:string;mapGroup:number;mapNumber:number;position:{x:number;y:number};scene:number;party:any[];inventory?:any;save?:any};
type Segment={path:string;source:string;start:Point;end:Point;runs:InputRun[];frameCount:number;artifactId:string;sourceCheckpointSha256:string;inspectionMutatesCanonicalState:boolean};
const chain:Segment[]=[];let current=finalDirectory;
while(true){
  assert(current.startsWith(resolve('build/adventure-exploration',version)+'/'));
  assert(chain.length<100,'Cyclic exploration lineage.');
  const segment={...JSON.parse(await readFile(resolve(current,'report.json'),'utf8')),path:current} as Segment;
  assert.equal(segment.artifactId,manifest.id);assert.equal(segment.inspectionMutatesCanonicalState,false);
  let source=new Uint8Array(await readFile(segment.source));if(segment.source.endsWith('.gz'))source=new Uint8Array(gunzipSync(source));
  assert.equal(sha(source),segment.sourceCheckpointSha256);
  assert.equal(segment.frameCount,segment.runs.reduce((sum,run)=>sum+run.frames,0));
  assert.equal(segment.start.frame+segment.frameCount,segment.end.frame);
  chain.unshift(segment);
  if(resolve(segment.source)===baseCheckpoint)break;
  assert.equal(basename(segment.source),'checkpoint.gz');current=dirname(segment.source);
}
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
const engine=await WasmEngine.create(bytes,manifest,original.seed);
type Core=Record<string,any>&{memory:WebAssembly.Memory};
const bind=(engine:WasmEngine)=>engine.bindExtension<Core>('kanto_lobby_save_abi_version',1,['GetMonData2','CheckBagHasItem']);
const core=bind(engine);
const immutableHash=()=>sha(new Uint8Array(core.memory.buffer,core.kanto_immutable_ptr(),core.kanto_immutable_size()));
const initialImmutable=immutableHash();
for(const run of original.runs as InputRun[])engine.advance([run]);
assert.equal(engine.frame,original.expectedFrames);assert.equal(engine.digest(),chain[0]!.start.digest);
const completed=[];
for(const segment of chain){
  assert.equal(engine.frame,segment.start.frame);assert.equal(engine.digest(),segment.start.digest,`Lineage start ${segment.path}`);
  for(const run of segment.runs)engine.advance([run]);
  assert.equal(engine.frame,segment.end.frame);assert.equal(engine.digest(),segment.end.digest,`Pure input replay ${segment.path}`);
  completed.push({name:basename(segment.path),frame:engine.frame,digest:engine.digest()});
}
assert.equal(immutableHash(),initialImmutable,'Extended gameplay changed immutable assets.');
const final=chain.at(-1)!.end;
const ballAttempts=5-final.inventory.balls;
assert(Number.isInteger(ballAttempts)&&ballAttempts>=1&&ballAttempts<=5);
const healingSegment=chain.find(segment=>basename(segment.path)==='heal-party');
const healing=healingSegment?{
  frame:healingSegment.end.frame,digest:healingSegment.end.digest,
  beforeHp:healingSegment.start.party.map(mon=>mon.hp),afterHp:healingSegment.end.party.map(mon=>mon.hp),
  unchangedExperience:healingSegment.start.party.every((mon,index)=>mon.experience===healingSegment.end.party[index]?.experience),
  unchangedPokemonIdentity:healingSegment.start.party.every((mon,index)=>['species','personality','trainerId'].every(key=>mon[key]===healingSegment.end.party[index]?.[key])),
}:undefined;
if(healingSegment){
  assert(healingSegment.start.party.some(mon=>mon.hp<mon.maxHp));
  assert.equal(healingSegment.start.party.length,healingSegment.end.party.length);
  assert(healingSegment.end.party.every(mon=>mon.hp===mon.maxHp));
  assert(healing?.unchangedExperience);
  assert(healing?.unchangedPokemonIdentity);
}
const flash=engine.flash();assert.equal(sha(flash),sha(new Uint8Array(await readFile(resolve(finalDirectory,'cartridge.sav')))));
assert(final.save?.attempt===1);assert.equal(final.party.length,2);assert.equal(final.inventory.pokedex,true);assert.equal(final.inventory.parcel,false);
assert(final.inventory.balls>=0&&final.inventory.balls<5);assert.equal(final.scene,6);
assert.equal(final.party[0].species,1);assert.equal(final.party[1].species,19);
function inspect(engine:WasmEngine){
  const before=engine.digest(),c=bind(engine),m=new DataView(c.memory.buffer);
  const addr=(name:string)=>c[name].value as number;
  const save=m.getUint32(addr('gSaveBlock1Ptr'),true),count=m.getUint8(addr('gPlayerPartyCount'));assert(count<=6);
  const party=Array.from({length:count},(_,slot)=>{
    const p=addr('gPlayerParty')+slot*100,get=(field:number)=>c.GetMonData2(p,field);
    assert.equal(get(4),0,'The original C decoder rejected a saved Pokemon.');
    return {species:get(11),level:get(56),hp:get(57),maxHp:get(58),experience:get(25),personality:get(0)>>>0,trainerId:get(1)>>>0,
      checksum:get(9),moves:[13,14,15,16].map(get)};
  });
  let low=0,high=65535;while(low<high){const mid=Math.floor((low+high+1)/2);if(c.CheckBagHasItem(4,mid))low=mid;else high=mid-1;}
  const result={mapGroup:m.getUint8(save+4),mapNumber:m.getUint8(save+5),position:{x:m.getInt16(save,true),y:m.getInt16(save+2,true)},
    scene:m.getUint16(save+0x1000+0x55*2,true),party,balls:low,pokedex:Boolean(m.getUint8(save+0xee0+(0x829>>>3))&(1<<(0x829&7))),
    fileStatus:m.getUint16(addr('gSaveFileStatus'),true),questLog:m.getUint8(addr('gQuestLogState'))};
  assert.equal(engine.digest(),before,'Saved-party inspection changed canonical state.');return result;
}
const expected=inspect(engine);
assert.deepEqual(expected.party,final.party);assert.equal(expected.balls,final.inventory.balls);
const continuation=JSON.parse(await readFile('tests/replays/continue.json','utf8'));
const loaded=await WasmEngine.create(bytes,manifest,original.seed,flash);
const continueRuns:InputRun[]=[...continuation.runs];
function checkLoaded(){
  const actual=inspect(loaded);assert.equal(actual.fileStatus,1);assert(actual.questLog<2);
  for(const key of ['mapGroup','mapNumber','position','scene','party','balls','pokedex'] as const)assert.deepEqual(actual[key],expected[key],`Continue ${key}`);
  assert.equal(sha(loaded.flash()),sha(flash));return actual;
}
for(const run of continueRuns)loaded.advance([run]);
const loadedCore=bind(loaded),loadedMemory=new DataView(loadedCore.memory.buffer);
for(let i=0;i<120&&loadedMemory.getUint8(loadedCore.gQuestLogState.value)>=2;i++){
  for(const input of [{buttons:2,frames:1},{buttons:0,frames:30}]){loaded.advance([input]);continueRuns.push(input);}
}
for(const input of [{buttons:0,frames:60},{buttons:0,frames:60}]){loaded.advance([input]);continueRuns.push(input);}
const continued=checkLoaded();
loaded.advance([{buttons:15,frames:1}]);assert.equal(sha(loaded.flash()),sha(flash));
for(const run of continueRuns)loaded.advance([run]);checkLoaded();loaded.close();
const packed=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256);
const a=await WasmEngine.create(bytes,manifest,original.seed),b=await WasmEngine.create(bytes,manifest,original.seed);
for(const copy of [a,b])copy.restore(decodeCheckpoint(packed,baseline,manifest.wasmSha256));
for(const input of [{buttons:0,frames:30},{buttons:32,frames:1},{buttons:0,frames:30}]){a.advance([input]);b.advance([input]);assert.equal(a.digest(),b.digest());}
a.close();b.close();
await mkdir(dirname(output),{recursive:true});await mkdir(output);
await writeFile(resolve(output,'adventure.sav'),flash);await writeFile(resolve(output,'checkpoint.gz'),gzipSync(packed));
const partyBytes=new Uint8Array(core.memory.buffer,core.gPlayerParty.value,final.party.length*100).slice();await writeFile(resolve(output,'party.bin'),partyBytes);
const milestoneNames:Record<string,string>={'reach-viridian-readonly':'viridian','heal-party':'pokecenter-heal','collect-parcel':'parcel','earn-pokedex-exit':'pokedex',
  'open-catch-bag':'bag','throw-third-ball':'caught','finish-third-ball':'two-pokemon','finish-first-ball':'two-pokemon','save-caught-party':'catch-save'};
const milestones=[...(original.milestones??[]).map((m:any)=>m.name==='bedroom'?{...m,name:'starter-save',restore:true}:m),
  ...completed.filter(p=>milestoneNames[p.name]).map(p=>({frame:p.frame,name:milestoneNames[p.name],...(['heal-party','open-catch-bag','finish-third-ball','finish-first-ball','save-caught-party'].includes(p.name)?{restore:true}:{})}))];
const replay={...original,description:`Original starter/rival route, Route 1 wild win, ${healing?'Pokemon Center healing, ':''}earned parcel/Pokedex/Poke Balls, ${ballAttempts} ball attempt${ballAttempts===1?'':'s'}, caught Rattata, and original-menu save.`,
  runs:[...original.runs,...chain.flatMap(s=>s.runs)],expectedFrames:engine.frame,expectedDigest:engine.digest(),expectedParty:final.party,expectedInventory:final.inventory,milestones};
await writeFile(resolve(output,'replay.json'),JSON.stringify(replay,null,2)+'\n');
const continuePartyRuns:InputRun[]=[...continueRuns,{buttons:8,frames:1},{buttons:0,frames:30},{buttons:128,frames:1},{buttons:0,frames:24},
  {buttons:1,frames:1},{buttons:0,frames:60},{buttons:0,frames:60},{buttons:0,frames:60}];
await writeFile(resolve(output,'continue-party.json'),JSON.stringify({seed:original.seed,sourceCommit:manifest.upstreamCommit,variants:[version],
  description:'Continue the caught-party cartridge, skip the original quest-log recap with B, and open Pokemon after the unlocked Pokedex menu entry.',
  runs:continuePartyRuns,expectedFrames:continuePartyRuns.reduce((sum,r)=>sum+r.frames,0)},null,2)+'\n');
await writeFile(resolve(output,'report.json'),JSON.stringify({artifactId:manifest.id,wasmSha256:manifest.wasmSha256,frames:engine.frame,digest:engine.digest(),
  flashSha256:sha(flash),partySha256:sha(partyBytes),party:final.party,inventory:final.inventory,position:expected.position,map:[expected.mapGroup,expected.mapNumber],
  originalMenuSave:true,pureInputReplay:true,independentInspectionDidNotChangeState:true,freshInstanceContinue:true,warmResetContinue:true,
  immutableAssetsUnchanged:true,completeCheckpointReplay:true,continued,continueFrames:continueRuns.reduce((sum,r)=>sum+r.frames,0),completed,ballAttempts,healing,
  sourceHashes:{qualifier:sha(new Uint8Array(await readFile('scripts/check-extended-adventure.ts'))),explorer:sha(new Uint8Array(await readFile('scripts/explore-route.ts')))},
  browserQualified:false,independentGbaReadback:false,fullAdventureQualified:false,hostedAccountsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
engine.close();console.log(JSON.stringify({output,frames:replay.expectedFrames,party:expected.party,inventory:final.inventory,pureInputReplay:true,freshInstanceContinue:true,warmResetContinue:true}));
