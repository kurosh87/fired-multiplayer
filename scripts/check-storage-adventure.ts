import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { InputRun } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
const [version='leafgreen',finalName='storage-save-withdraw-confirmed',tag=`${version}-storage`]=process.argv.slice(2);
assert(['firered','leafgreen'].includes(version));
for(const name of [finalName,tag])assert(/^[a-z0-9-]{1,60}$/.test(name));
const directory=resolve(`build/game-source/${version}/memory-16`),exploration=resolve('build/adventure-exploration',version);
const output=resolve('build/adventure-qualification',tag);
assert(!existsSync(output),'Retained qualification evidence must not be overwritten.');
const manifest=JSON.parse(await readFile(resolve(directory,'candidate.json'),'utf8')) as EngineManifest;
const bytes=new Uint8Array(await readFile(resolve(directory,'candidate.wasm')));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const prefixPath=`tests/replays/${version}-route1-catch-save.json`;
const prefix=JSON.parse(await readFile(prefixPath,'utf8'));
const prefixReport=JSON.parse(await readFile(`build/adventure-qualification/${version}-catch/report.json`,'utf8'));
assert.equal(prefixReport.artifactId,manifest.id);assert.equal(prefixReport.digest,prefix.expectedDigest);
type Segment={path:string;source:string;sourceCheckpointSha256:string;artifactId:string;runs:InputRun[];frameCount:number;start:any;end:any;inspectionMutatesCanonicalState:boolean};
const chain:Segment[]=[];let current=resolve(exploration,finalName);
const base=resolve(exploration,'save-caught-party/checkpoint.gz');
while(true){
  assert(current.startsWith(exploration+'/'));assert(chain.length<100,'Cyclic storage exploration lineage.');
  const segment={...JSON.parse(await readFile(resolve(current,'report.json'),'utf8')),path:current} as Segment;
  assert.equal(segment.artifactId,manifest.id);assert.equal(segment.inspectionMutatesCanonicalState,false);
  let source=new Uint8Array(await readFile(segment.source));if(segment.source.endsWith('.gz'))source=new Uint8Array(gunzipSync(source));
  assert.equal(sha(source),segment.sourceCheckpointSha256);
  assert.equal(segment.frameCount,segment.runs.reduce((sum,run)=>sum+run.frames,0));
  assert.equal(segment.start.frame+segment.frameCount,segment.end.frame);
  chain.unshift(segment);if(resolve(segment.source)===base)break;
  assert.equal(basename(segment.source),'checkpoint.gz');current=dirname(segment.source);
}
assert.equal(chain[0]!.start.digest,prefix.expectedDigest);
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
const engine=await WasmEngine.create(bytes,manifest,prefix.seed);
type Core=Record<string,any>&{memory:WebAssembly.Memory};
const bind=(engine:WasmEngine)=>engine.bindExtension<Core>('kanto_lobby_save_abi_version',1,['GetMonData2','GetBoxMonData2']);
function inspect(engine:WasmEngine){
  const before=engine.digest(),c=bind(engine),m=new DataView(c.memory.buffer),addr=(name:string)=>c[name].value as number;
  const save=m.getUint32(addr('gSaveBlock1Ptr'),true),storage=m.getUint32(addr('gPokemonStoragePtr'),true);
  function monAt(address:number,boxed:boolean){
    const get=(field:number)=>(boxed?c.GetBoxMonData2:c.GetMonData2)(address,field);
    assert.equal(get(4),0,'Original C decoder reported a bad egg.');
    return {species:get(11),personality:get(0)>>>0,trainerId:get(1)>>>0,experience:get(25),
      checksum:get(9),moves:[13,14,15,16].map(get),...(!boxed?{level:get(56),hp:get(57),maxHp:get(58)}:{})};
  }
  const count=m.getUint8(addr('gPlayerPartyCount'));assert(count>=1&&count<=6);
  // The original PC updates gPlayerPartyCount when its screen closes. Inspect
  // all six actual slots during its transfer animation and menus.
  const party=Array.from({length:6},(_,slot)=>monAt(addr('gPlayerParty')+slot*100,false)).filter(mon=>mon.species!==0);
  const boxes=[];
  for(let box=0;box<14;box++)for(let slot=0;slot<30;slot++){
    const address=storage+4+(box*30+slot)*80;
    if(c.GetBoxMonData2(address,11))boxes.push({box,slot,...monAt(address,true),recordSha256:sha(new Uint8Array(c.memory.buffer,address,80))});
  }
  const result={map:[m.getUint8(save+4),m.getUint8(save+5)],position:[m.getInt16(save,true),m.getInt16(save+2,true)],
    party,boxes,currentBox:m.getUint8(storage),storageSha256:sha(new Uint8Array(c.memory.buffer,storage,0x83d0)),
    fileStatus:m.getUint16(addr('gSaveFileStatus'),true),questLog:m.getUint8(addr('gQuestLogState'))};
  assert.equal(engine.digest(),before,'Storage inspection changed canonical state.');return result;
}
const c=bind(engine),immutable=()=>sha(new Uint8Array(c.memory.buffer,c.kanto_immutable_ptr(),c.kanto_immutable_size()));
const immutableBefore=immutable();
for(const run of prefix.runs as InputRun[])engine.advance([run]);
assert.equal(engine.frame,prefix.expectedFrames);assert.equal(engine.digest(),prefix.expectedDigest);
const identity=(mon:any)=>({species:mon.species,personality:mon.personality,trainerId:mon.trainerId,experience:mon.experience,moves:mon.moves});
const key=(mon:any)=>`${mon.trainerId}:${mon.personality}`;
const earned=inspect(engine).party.map(identity).sort((a,b)=>key(a).localeCompare(key(b)));
function conserve(state:ReturnType<typeof inspect>){
  const all=[...state.party,...state.boxes];assert.equal(all.length,2);assert.equal(new Set(all.map(key)).size,2,'Duplicate Pokemon identity.');
  assert.deepEqual(all.map(identity).sort((a,b)=>key(a).localeCompare(key(b))),earned,'Earned Pokemon identity, experience or moves changed.');
}
const saved=new Map<string,{state:ReturnType<typeof inspect>;flash:Uint8Array;party:Uint8Array;storage:Uint8Array;frame:number;digest:string}>();
const completed=[];
for(const segment of chain){
  assert.equal(engine.frame,segment.start.frame);assert.equal(engine.digest(),segment.start.digest);
  for(const run of segment.runs)engine.advance([run]);
  assert.equal(engine.frame,segment.end.frame);assert.equal(engine.digest(),segment.end.digest,`Pure input replay ${segment.path}`);
  const name=basename(segment.path)===finalName?'storage-save-withdraw':basename(segment.path);
  completed.push({name,path:segment.path,frame:engine.frame,digest:engine.digest()});
  if(['storage-deposit','storage-save-deposit','storage-reset-continue','storage-withdraw','storage-save-withdraw'].includes(name)){
    const state=inspect(engine);conserve(state);
    const withdrawn=['storage-withdraw','storage-save-withdraw'].includes(name);
    assert.equal(state.party.length,withdrawn?2:1);assert.equal(state.boxes.length,withdrawn?0:1);
    if(!withdrawn){assert.equal(state.boxes[0]!.species,19);assert.equal(state.boxes[0]!.box,0);assert.equal(state.boxes[0]!.slot,0);}
    if(name.startsWith('storage-save-')){
      assert.equal(segment.end.save.attempt,1);assert.equal(state.party.length,memoryCount(c));
      const flash=engine.flash();assert.equal(sha(flash),sha(new Uint8Array(await readFile(resolve(segment.path,'cartridge.sav')))));
      const storageAddress=new DataView(c.memory.buffer).getUint32(c.gPokemonStoragePtr.value,true);
      saved.set(name,{state,flash,party:new Uint8Array(c.memory.buffer,c.gPlayerParty.value,state.party.length*100).slice(),
        storage:new Uint8Array(c.memory.buffer,storageAddress,0x83d0).slice(),frame:engine.frame,digest:engine.digest()});
    }
  }
}
function memoryCount(c:Core){return new DataView(c.memory.buffer).getUint8(c.gPlayerPartyCount.value);}
assert.equal(saved.size,2,'Both deposit and withdrawal require original-menu saves.');
assert.equal(immutable(),immutableBefore);
const finalDigest=engine.digest(),packed=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256);
const replacement=await WasmEngine.create(bytes,manifest,prefix.seed);replacement.restore(decodeCheckpoint(packed,baseline,manifest.wasmSha256));
assert.equal(replacement.digest(),finalDigest);
for(const input of [{buttons:0,frames:60},{buttons:0,frames:30}]){engine.advance([input]);replacement.advance([input]);assert.equal(engine.digest(),replacement.digest());}
replacement.close();
await mkdir(dirname(output),{recursive:true});await mkdir(output);
const proofs:Record<string,any>={};
for(const [name,save] of saved){
  const phase=name==='storage-save-deposit'?'deposit':'withdraw';
  const loaded=await WasmEngine.create(bytes,manifest,prefix.seed,save.flash);
  const continued=JSON.parse(await readFile('tests/replays/continue.json','utf8')).runs as InputRun[];
  const runs=[...continued];for(const run of runs)loaded.advance([run]);
  const lc=bind(loaded),lm=new DataView(lc.memory.buffer);
  for(let i=0;i<120&&lm.getUint8(lc.gQuestLogState.value)>=2;i++)for(const input of [{buttons:2,frames:1},{buttons:0,frames:30}]){loaded.advance([input]);runs.push(input);}
  for(const input of [{buttons:0,frames:60},{buttons:0,frames:60}]){loaded.advance([input]);runs.push(input);}
  function check(){
    const state=inspect(loaded);assert.equal(state.fileStatus,1);assert(state.questLog<2);conserve(state);
    for(const field of ['map','position','party','boxes','currentBox','storageSha256'] as const)assert.deepEqual(state[field],save.state[field],`Continue ${phase} ${field}`);
    assert.equal(sha(loaded.flash()),sha(save.flash));
  }
  check();loaded.advance([{buttons:15,frames:1}]);for(const run of runs)loaded.advance([run]);check();loaded.close();
  await writeFile(resolve(output,phase+'.sav'),save.flash);await writeFile(resolve(output,phase+'-party.bin'),save.party);
  await writeFile(resolve(output,phase+'-storage.bin'),save.storage);
  const partyRuns=[...runs,{buttons:8,frames:1},{buttons:0,frames:30},{buttons:128,frames:1},{buttons:0,frames:24},{buttons:1,frames:1},
    {buttons:0,frames:60},{buttons:0,frames:60},{buttons:0,frames:60}];
  await writeFile(resolve(output,phase+'-continue-party.json'),JSON.stringify({seed:prefix.seed,sourceCommit:manifest.upstreamCommit,variants:[version],runs:partyRuns,
    description:`Continue the original-menu PC ${phase} save and open the original party menu.`,expectedFrames:partyRuns.reduce((n,r)=>n+r.frames,0)},null,2)+'\n');
  proofs[phase]={frame:save.frame,digest:save.digest,state:save.state,flashSha256:sha(save.flash),partySha256:sha(save.party),storageSha256:sha(save.storage),
    originalMenuSave:true,freshInstanceContinue:true,warmResetContinue:true,noDuplicateOrMissingPokemon:true,originalGbaReadback:false};
}
const replay={...prefix,description:'Earned starter and wild catch, original PC deposit, Save/reset/Continue, withdrawal and second original-menu save.',
  runs:[...prefix.runs,...chain.flatMap(s=>s.runs)],expectedFrames:chain.at(-1)!.end.frame,expectedDigest:finalDigest,
  expectedParty:saved.get('storage-save-withdraw')!.state.party,expectedStorage:saved.get('storage-save-withdraw')!.state.boxes,
  milestones:[...prefix.milestones,...completed.filter(p=>['storage-deposit-open','storage-deposit','storage-save-deposit','storage-reset-continue','storage-withdraw-view','storage-withdraw','storage-save-withdraw'].includes(p.name))
    .map(p=>({name:p.name,frame:p.frame,restore:true}))]};
await writeFile(resolve(output,'replay.json'),JSON.stringify(replay,null,2)+'\n');
await writeFile(resolve(output,'checkpoint.gz'),gzipSync(packed));
await writeFile(resolve(output,'report.json'),JSON.stringify({artifactId:manifest.id,wasmSha256:manifest.wasmSha256,frames:replay.expectedFrames,digest:finalDigest,
  phases:proofs,pureInputReplay:true,immutableAssetsUnchanged:true,completeCheckpointReplay:true,passiveInspection:true,completed,
  sourceHashes:{qualifier:sha(new Uint8Array(await readFile('scripts/check-storage-adventure.ts'))),explorer:sha(new Uint8Array(await readFile('scripts/explore-route.ts'))),
    prefixReplay:sha(new Uint8Array(await readFile(prefixPath)))},
  browserRouteParity:false,independentGbaReadback:false,fullAdventureQualified:false,hostedAccountsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false,
  scope:'Recorded PC deposit/withdrawal round trip for these two earned Pokemon; not all PC operations or full-game qualification.'},null,2)+'\n');
engine.close();console.log(JSON.stringify({output,frames:replay.expectedFrames,phases:proofs,pureInputReplay:true,completeCheckpointReplay:true}));
