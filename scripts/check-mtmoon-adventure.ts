import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, decodeCheckpoint, encodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { InputRun } from '../packages/protocol/index.ts';
import { originalStoryProgress } from '../tests/original-story-progress.ts';
import { originalTrainerPrizes } from '../tests/original-trainer-prizes.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the shared build guard.');
const [version,finalName,tag]=process.argv.slice(2);
assert(version&&['firered','leafgreen'].includes(version));assert(finalName&&/^[a-z0-9-]{1,50}$/.test(finalName));assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const output=resolve('build/adventure-qualification',tag);assert(!existsSync(output),'Preserve prior qualification evidence.');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const load=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const rootFolder=resolve(`build/adventure-qualification/${version}-brock-v2`),root=await load(rootFolder+'/report.json');
assert(root.firstGymQualified&&root.browserQualified&&root.independentGbaReadback);
const rootMovie=await load(rootFolder+'/replay.json'),game=`build/game-source/${version}/battle-text-audio-16`;
const manifest=await load(game+'/candidate.json') as EngineManifest,bytes=new Uint8Array(await readFile(game+'/candidate.wasm'));
assert.equal(hash(bytes),manifest.wasmSha256);assert.equal(manifest.id,root.artifactId);assert.equal(manifest.wasmSha256,root.wasmSha256);
assert.equal(rootMovie.expectedDigest,root.digest);assert.equal(rootMovie.expectedFrames,root.frames);
const rootPoint=resolve(rootFolder,'checkpoint.gz'),chain:any[]=[];
let current=resolve(`build/adventure-exploration/${version}/${finalName}`);
while(true){
  assert(chain.length<80&&current.startsWith(resolve('build/adventure-exploration',version)+'/'));
  const segment={...await load(current+'/report.json'),path:current};assert(!segment.planFailed,'Exclude failed exploration branches.');
  assert.equal(segment.artifactId,manifest.id);assert.equal(segment.wasmSha256,manifest.wasmSha256);assert.equal(segment.inspectionMutatesCanonicalState,false);
  assert.equal(segment.sourceCheckpointSha256,hash(gunzipSync(await readFile(segment.source))));
  assert.equal(segment.frameCount,segment.runs.reduce((sum:number,run:InputRun)=>sum+run.frames,0));
  assert.equal(segment.start.frame+segment.frameCount,segment.end.frame);chain.unshift(segment);
  if(resolve(segment.source)===rootPoint)break;
  assert.equal(basename(segment.source),'checkpoint.gz');current=dirname(segment.source);
}
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes));
const engine=await WasmEngine.create(bytes,manifest,rootMovie.seed),copies:WasmEngine[]=[];
try{
  const c=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]);
  const immutable=()=>hash(new Uint8Array(c.memory.buffer,c.kanto_immutable_ptr(),c.kanto_immutable_size())),originalAssets=immutable();
  // Reproduce the complete earlier movie, then every accepted new segment.
  // Neither exploration checkpoints nor inspection decisions supply game state.
  for(const run of rootMovie.runs)engine.advance([run]);
  assert.equal(engine.frame,root.frames);assert.equal(engine.digest(),root.digest);assert.equal(hash(engine.flash()),root.flashSha256);
  const initial=originalStoryProgress(engine),startingPoint=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256);
  const milestones:{name:string;frame:number;digest:string;restore:boolean}[]=[];
  for(const [index,segment] of chain.entries()){
    assert.equal(engine.frame,segment.start.frame);assert.equal(engine.digest(),segment.start.digest);
    for(const run of segment.runs)engine.advance([run]);
    assert.equal(engine.frame,segment.end.frame);assert.equal(engine.digest(),segment.end.digest);
    milestones.push({name:`moon-${index}`,frame:engine.frame,digest:engine.digest(),restore:true});
    console.log(JSON.stringify({segment:basename(segment.path),frame:engine.frame}));
  }
  const expected=originalStoryProgress(engine),flash=engine.flash();
  assert.deepEqual(expected.map,[3,3],'Finish with a saved adventure in Cerulean City.');
  assert.deepEqual(expected.badges,[true,false,false,false,false,false,false,false]);
  assert(expected.brockDefeated&&expected.brockTrainer&&expected.liamDefeated&&expected.runningShoes&&expected.tm39Received);
  assert.equal(expected.tm39,initial.tm39);assert.equal(expected.balls,initial.balls);assert.equal(expected.teachyTv,initial.teachyTv);
  assert.equal(expected.storageSha256,initial.storageSha256);assert.equal(expected.trades,initial.trades);
  assert(expected.fossilReceived);assert.notEqual(expected.domeFossil,expected.helixFossil);
  assert.equal(expected.domeFossils,expected.domeFossil?1:0);assert.equal(expected.helixFossils,expected.helixFossil?1:0);
  assert.equal(expected.party.length,2);assert.equal(expected.party[0]!.species,2,'Bulbasaur must naturally evolve into Ivysaur.');
  assert.equal(expected.evolutions,initial.evolutions+1);assert(expected.pokeCenters>=initial.pokeCenters+3);
  assert(expected.party[0]!.level>=16&&expected.party[0]!.level<32);assert(expected.party[0]!.moves.includes(33)&&expected.party[0]!.moves.includes(22));
  assert(expected.party.every(mon=>mon.hp===mon.maxHp&&mon.status===0),'Finish healed through the original Pokemon Center.');
  for(let i=0;i<2;i++)for(const key of ['personality','trainerId'] as const)assert.equal(expected.party[i]![key],initial.party[i]![key]);
  assert.equal(expected.party[1]!.species,initial.party[1]!.species);assert.equal(expected.party[1]!.experience,initial.party[1]!.experience);
  assert.equal(expected.fieldLocked,0);assert.equal(expected.scriptEnabled,0);assert.equal(expected.fileStatus,1);assert(expected.questLog<2);
  assert.equal(new DataView(c.memory.buffer).getUint16(c.gSaveAttemptStatus.value,true),1);
  const newlyDefeated=expected.defeatedTrainers.filter(id=>!initial.defeatedTrainers.includes(id));
  for(const required of [89,105,106,107,118,170])assert(newlyDefeated.includes(required),`Required original trainer ${required} was not defeated.`);
  assert(newlyDefeated.some(id=>id>=351&&id<=354),'The recorded chapter must defeat Team Rocket in Mt Moon.');
  const prizes=await originalTrainerPrizes(newlyDefeated);
  assert.equal(expected.money-initial.money,prizes.total,'Every prize must match the original singles formula without unrecorded spending.');
  assert.equal(immutable(),originalAssets);
  const loaded=await WasmEngine.create(bytes,manifest,rootMovie.seed,flash);copies.push(loaded);
  const continueRuns:InputRun[]=[...(await load('tests/replays/continue.json')).runs];for(const run of continueRuns)loaded.advance([run]);
  for(let i=0;i<120&&originalStoryProgress(loaded).questLog>=2;i++)for(const run of [{buttons:2,frames:1},{buttons:0,frames:30}]){loaded.advance([run]);continueRuns.push(run);}
  for(const run of [{buttons:0,frames:60},{buttons:0,frames:60}]){loaded.advance([run]);continueRuns.push(run);}
  const recovered=()=>{
    const actual=originalStoryProgress(loaded);
    const {questLog:unusedExpected,...stableExpected}=expected,{questLog:unusedActual,...stableActual}=actual;
    assert.deepEqual(stableActual,stableExpected,'Original Continue must restore the entire selected story state.');
    assert(actual.questLog<2);assert.equal(hash(loaded.flash()),hash(flash));
  };
  recovered();loaded.advance([{buttons:15,frames:1}]);for(const run of continueRuns)loaded.advance([run]);recovered();
  const point=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256),copy=await WasmEngine.create(bytes,manifest,rootMovie.seed);copies.push(copy);
  copy.restore(decodeCheckpoint(point,baseline,manifest.wasmSha256));assert.equal(copy.digest(),engine.digest());assert.deepEqual(originalStoryProgress(copy),expected);
  await mkdir(output);
  const party=Buffer.from(c.memory.buffer,c.gPlayerParty.value,200),m=new DataView(c.memory.buffer),storage=Buffer.from(c.memory.buffer,m.getUint32(c.gPokemonStoragePtr.value,true),0x83d0);
  await writeFile(output+'/adventure.sav',flash);await writeFile(output+'/party.bin',party);await writeFile(output+'/storage.bin',storage);await writeFile(output+'/checkpoint.gz',gzipSync(point));
  const runs:InputRun[]=chain.flatMap(segment=>segment.runs);
  await writeFile(output+'/replay.json',JSON.stringify({...rootMovie,description:'Input-earned Route 3 trainers, running shoes, natural Ivysaur evolution, Mt Moon, Team Rocket, fossil choice, Cerulean healing and original Save.',
    runs:[...rootMovie.runs,...runs],expectedFrames:engine.frame,expectedDigest:engine.digest(),expectedParty:expected.party,expectedProgress:expected,
    milestones:[...(rootMovie.milestones??[]),...milestones]},null,2)+'\n');
  const partyRuns=[...continueRuns,{buttons:8,frames:1},{buttons:0,frames:30},{buttons:128,frames:1},{buttons:0,frames:24},{buttons:1,frames:1},{buttons:0,frames:60},{buttons:0,frames:60},{buttons:0,frames:60}];
  await writeFile(output+'/continue-party.json',JSON.stringify({seed:rootMovie.seed,sourceCommit:manifest.upstreamCommit,variants:[version],runs:partyRuns,expectedFrames:partyRuns.reduce((sum,run)=>sum+run.frames,0)},null,2)+'\n');
  await writeFile(output+'/browser-start.checkpoint.gz',gzipSync(startingPoint));await writeFile(output+'/browser.sav',flash);
  await writeFile(output+'/browser-inputs.json',JSON.stringify({seed:rootMovie.seed,sourceCommit:manifest.upstreamCommit,artifactId:manifest.id,startDigest:root.digest,runs,
    expectedFrames:engine.frame,expectedDigest:engine.digest(),milestones},null,2)+'\n');
  const sources=['scripts/check-mtmoon-adventure.ts','scripts/explore-route.ts','tests/original-story-progress.ts','tests/original-game-progress.ts','tests/original-trainer-prizes.ts'];
  await writeFile(output+'/report.json',JSON.stringify({artifactId:manifest.id,wasmSha256:manifest.wasmSha256,gameDirectory:game,frames:engine.frame,digest:engine.digest(),initial,expected,
    flashSha256:hash(flash),partySha256:hash(party),storageSha256:hash(storage),pureInputReplay:true,pureInputContinuation:true,earlierFullMovieProof:rootFolder+'/report.json',
    earlierFullMovieProofSha256:hash(await readFile(rootFolder+'/report.json')),startingFrame:root.frames,newFrames:engine.frame-root.frames,
    lineage:await Promise.all(chain.map(async segment=>({path:segment.path,reportSha256:hash(await readFile(segment.path+'/report.json')),sourceCheckpointSha256:segment.sourceCheckpointSha256,frame:segment.end.frame}))),
    immutableAssetsUnchanged:true,originalMenuSave:true,freshContinue:true,warmResetContinue:true,completeCheckpointRestore:true,naturalEvolution:true,prizes,milestones,
    sourceSha256:Object.fromEntries(await Promise.all(sources.map(async path=>[path,hash(await readFile(path))]))),
    browserQualified:false,independentGbaReadback:false,mtMoonQualified:false,fullAdventureQualified:false,publicReleaseQualified:false,
    scope:'Complete fresh-boot C replay; browser continuation starts from the previously qualified same-artifact first-gym checkpoint.'},null,2)+'\n');
  console.log(JSON.stringify({output,frames:engine.frame,newFrames:engine.frame-root.frames,money:expected.money,party:expected.party,fossil:expected.domeFossil?'dome':'helix'}));
}finally{for(const copy of copies)copy.close();engine.close();}
