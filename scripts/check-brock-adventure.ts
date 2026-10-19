import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,dirname,basename} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {WasmEngine,type EngineManifest} from '../packages/engine/runtime.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint} from '../packages/engine/checkpoint.ts';
import type {InputRun} from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const [version,finalName,tag]=process.argv.slice(2);
assert(version&&['firered','leafgreen'].includes(version));assert(finalName&&/^[a-z0-9-]{1,50}$/.test(finalName));assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag));
const output=resolve(`build/adventure-qualification/${tag}`);assert(!existsSync(output),'Preserve prior evidence.');
const priorFolder=`build/adventure-qualification/${version}-forest-v1`,baseReport=JSON.parse(await readFile(priorFolder+'/report.json','utf8'));
assert(baseReport.pureInputReplay&&baseReport.freshContinue&&baseReport.independentGbaReadback);
const baseMovie=JSON.parse(await readFile(`tests/replays/${version}-forest-pewter-audio.json`,'utf8'));
assert.equal(baseMovie.expectedFrames,baseReport.frames);assert.equal(baseMovie.expectedDigest,baseReport.digest);
const game=`build/game-source/${version}/battle-text-audio-16`,manifest=JSON.parse(await readFile(game+'/candidate.json','utf8')) as EngineManifest;
const oldGame=`build/game-source/${version}/audio-16`,oldManifest=JSON.parse(await readFile(oldGame+'/candidate.json','utf8')) as EngineManifest;
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bytes=new Uint8Array(await readFile(game+'/candidate.wasm'));assert.equal(sha(bytes),manifest.wasmSha256);assert.equal(oldManifest.id,baseReport.artifactId);
assert.notEqual(manifest.wasmSha256,oldManifest.wasmSha256);
const rootPoint=resolve(priorFolder,'checkpoint.gz'),chain:any[]=[];let current=resolve(`build/adventure-exploration/${version}/${finalName}`);
while(true){
  assert(chain.length<30&&current.startsWith(resolve('build/adventure-exploration',version)+'/'));
  const segment={...JSON.parse(await readFile(current+'/report.json','utf8')),path:current};
  assert.equal(segment.artifactId,oldManifest.id);assert.equal(segment.wasmSha256,oldManifest.wasmSha256);assert.equal(segment.inspectionMutatesCanonicalState,false);
  assert.equal(sha(gunzipSync(await readFile(segment.source))),segment.sourceCheckpointSha256);
  assert.equal(segment.frameCount,segment.runs.reduce((n:number,r:InputRun)=>n+r.frames,0));
  assert.equal(segment.start.frame+segment.frameCount,segment.end.frame);chain.unshift(segment);
  if(resolve(segment.source)===rootPoint)break;
  assert.equal(basename(segment.source),'checkpoint.gz');current=dirname(segment.source);
}
const baseline=await createCheckpointBaseline(await WebAssembly.compile(bytes)),engine=await WasmEngine.create(bytes,manifest,baseMovie.seed),copies:WasmEngine[]=[];
function inspect(target:WasmEngine){
  const before=target.digest(),c=target.bindExtension<any>('kanto_lobby_save_abi_version',1,['GetMonData2','CheckBagHasItem']),m=new DataView(c.memory.buffer);
  const save=m.getUint32(c.gSaveBlock1Ptr.value,true),save2=m.getUint32(c.gSaveBlock2Ptr.value,true),flag=(id:number)=>Boolean(m.getUint8(save+0xee0+(id>>>3))&(1<<(id&7)));
  const quantity=(item:number)=>{let lo=0,hi=65535;while(lo<hi){const mid=Math.floor((lo+hi+1)/2);if(c.CheckBagHasItem(item,mid))lo=mid;else hi=mid-1;}return lo;};
  const party=Array.from({length:m.getUint8(c.gPlayerPartyCount.value)},(_,slot)=>{
    const get=(field:number)=>c.GetMonData2(c.gPlayerParty.value+slot*100,field);assert.equal(get(4),0);
    return {species:get(11),personality:get(0)>>>0,trainerId:get(1)>>>0,experience:get(25),level:get(56),hp:get(57),maxHp:get(58),
      checksum:get(9),heldItem:get(12),moves:[13,14,15,16].map(get),pp:[17,18,19,20].map(get)};
  });
  const storage=m.getUint32(c.gPokemonStoragePtr.value,true),state={map:[m.getUint8(save+4),m.getUint8(save+5)],position:[m.getInt16(save,true),m.getInt16(save+2,true)],
    party,badges:Array.from({length:8},(_,i)=>flag(0x820+i)),brockDefeated:flag(0x4b0),brockTrainer:flag(0x500+414),liamDefeated:flag(0x500+142),
    tm39Received:flag(0x254),tm39:quantity(327),teachyTv:quantity(366),balls:quantity(4),pokedex:flag(0x829),
    money:(m.getUint32(save+0x290,true)^m.getUint32(save2+0xf20,true))>>>0,
    questLog:m.getUint8(c.gQuestLogState.value),fileStatus:m.getUint16(c.gSaveFileStatus.value,true),fieldLocked:c.ArePlayerFieldControlsLocked(),scriptEnabled:c.ScriptContext_IsEnabled(),
    storageSha256:sha(new Uint8Array(c.memory.buffer,storage,0x83d0))};
  assert.equal(target.digest(),before,'Passive inspection changed the original game.');return {state,c,storage};
}
try{
  const core=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]);
  const immutable=()=>sha(new Uint8Array(core.memory.buffer,core.kanto_immutable_ptr(),core.kanto_immutable_size()));const immutableBefore=immutable();
  // Buffer growth relocates globals. Rebuild all state with fresh-boot inputs;
  // old-artifact checkpoints are evidence only, never loaded into the new core.
  const prefixMilestones:any[]=[];
  for(const run of baseMovie.runs){
    engine.advance([run]);
    for(const point of baseMovie.milestones??[])if(point.frame===engine.frame)
      prefixMilestones.push({...point,digest:engine.digest()});
  }
  assert.equal(engine.frame,baseReport.frames);
  assert.equal(sha(engine.flash()),baseReport.flashSha256,'Earlier original-game saves must be unchanged by the text storage repair.');
  const oldBytes=new Uint8Array(await readFile(oldGame+'/candidate.wasm'));assert.equal(sha(oldBytes),oldManifest.wasmSha256);
  const oldBaseline=await createCheckpointBaseline(await WebAssembly.compile(oldBytes));
  const old=await WasmEngine.create(oldBytes,oldManifest,baseMovie.seed);copies.push(old);
  old.restore(decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(rootPoint))),oldBaseline,oldManifest.wasmSha256));
  assert.equal(old.digest(),baseReport.digest);
  const initial=inspect(engine).state;assert.deepEqual(initial,inspect(old).state);
  assert(initial.badges.every(value=>!value));assert.equal(initial.tm39,0);
  const packedRoot=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256),startingDigest=engine.digest();
  const m=new DataView(core.memory.buffer),display=core.gDisplayedStringBattle.value,flags=core.gBattleTypeFlags.value;
  assert(core.gBattleTextBuff1.value>=display+1024);assert(flags>=display+1024);
  const failureProof=JSON.parse(await readFile(`build/${version}-battle-text-overflow-v1.json`,'utf8'));
  assert(failureProof.reproduced);assert.equal(failureProof.artifactId,oldManifest.id);
  const setupTransitions=failureProof.transitions.filter((value:any)=>value.frame<failureProof.firstOverflow.frame);
  assert(setupTransitions.every((value:any)=>value.current<=0xffff));
  let expectedBattleFlags=failureProof.transitions[0].previous,flagTransition=0;
  let longDialogue:any;
  const milestones:any[]=[];
  for(const segment of chain){
    assert.equal(engine.frame,segment.start.frame);
    for(const run of segment.runs){
      if(segment===chain.at(-1))for(let i=0;i<run.frames;i++){
        engine.advance([{buttons:run.buttons,frames:1}]);
        while(setupTransitions[flagTransition]?.frame<=engine.frame)expectedBattleFlags=setupTransitions[flagTransition++].current;
        assert.equal(m.getUint32(flags,true),expectedBattleFlags,'Preserve original battle setup transitions and keep battle flags intact after the long speech.');
        if(!longDialogue){
          const text=new Uint8Array(core.memory.buffer,display,1024),end=text.indexOf(255);
          if(end>300){
            const before=engine.digest(),original=Buffer.from(failureProof.firstOverflow.displayedBytes,'hex');
            assert.equal(m.getUint32(flags,true),12);
            assert.deepEqual(Buffer.from(text.subarray(0,end+1)),original.subarray(0,original.indexOf(255)+1),'Preserve every original dialogue byte and control code.');
            longDialogue={frame:engine.frame,bytesIncludingTerminator:end+1,sha256:sha(text.subarray(0,end+1)),battleFlags:m.getUint32(flags,true),textCapacity:1024,identicalOriginalDialogue:true};
            assert.equal(engine.digest(),before);
          }
        }
      }else engine.advance([run]);
    }
    assert.equal(engine.frame,segment.end.frame);
    if(segment!==chain.at(-1))assert.equal(inspect(engine).state.money,segment.end.progress.money);
    milestones.push({name:basename(segment.path),frame:engine.frame,digest:engine.digest()});
    console.log(JSON.stringify({milestone:basename(segment.path),frame:engine.frame}));
  }
  assert(longDialogue,'The regression must exercise Brock\'s original long defeat speech.');
  const {state:expected,c,storage}=inspect(engine),flash=engine.flash();
  old.restore(decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(chain.at(-1).path+'/checkpoint.gz'))),oldBaseline,oldManifest.wasmSha256));
  assert.equal(old.digest(),chain.at(-1).end.digest);
  const oldFinal=inspect(old).state;
  assert.deepEqual({...expected,money:oldFinal.money},oldFinal,'The repair changes only prize accounting in the saved progress.');
  assert.equal(oldFinal.money-expected.money,1400);
  assert.deepEqual(expected.badges,[true,false,false,false,false,false,false,false]);
  assert(expected.brockDefeated&&expected.brockTrainer&&expected.liamDefeated&&expected.tm39Received);assert.equal(expected.tm39,1);
  assert.equal(expected.money-initial.money,1620,'Liam and Brock prize money must come from their original trainer battles.');
  assert.deepEqual(expected.map,[3,2],'Finish with a saved party in Pewter City.');
  assert.equal(expected.party.length,2);assert(expected.party[0]!.moves.includes(22),'Vine Whip must be learned normally.');
  assert(expected.party.every(mon=>mon.hp===mon.maxHp));assert(expected.party[0]!.experience>initial.party[0]!.experience);
  for(let i=0;i<2;i++)for(const key of ['species','personality','trainerId'] as const)assert.equal(expected.party[i]![key],initial.party[i]![key]);
  assert.equal(expected.balls,initial.balls);assert.equal(expected.teachyTv,initial.teachyTv);assert.equal(expected.storageSha256,initial.storageSha256);
  assert.equal(immutable(),immutableBefore);assert.equal(expected.fieldLocked,0);assert.equal(expected.scriptEnabled,0);assert.equal(expected.fileStatus,1);
  assert.equal(mUint16(c.gSaveAttemptStatus.value),1);
  function mUint16(address:number){return new DataView(c.memory.buffer).getUint16(address,true);}
  const loaded=await WasmEngine.create(bytes,manifest,baseMovie.seed,flash);copies.push(loaded);
  const continueRuns:InputRun[]=[...JSON.parse(await readFile('tests/replays/continue.json','utf8')).runs];for(const run of continueRuns)loaded.advance([run]);
  for(let i=0;i<120&&inspect(loaded).state.questLog>=2;i++)for(const run of [{buttons:2,frames:1},{buttons:0,frames:30}]){loaded.advance([run]);continueRuns.push(run);}
  for(const run of [{buttons:0,frames:60},{buttons:0,frames:60}]){loaded.advance([run]);continueRuns.push(run);}
  const recover=()=>{
    const actual=inspect(loaded).state;
    for(const key of ['map','position','party','badges','brockDefeated','brockTrainer','liamDefeated','tm39Received','tm39','teachyTv','balls','pokedex','money','storageSha256'] as const)
      assert.deepEqual(actual[key],expected[key],`Original Continue ${key}`);
    assert.equal(actual.fileStatus,1);assert(actual.questLog<2);assert.equal(actual.fieldLocked,0);assert.equal(actual.scriptEnabled,0);assert.equal(sha(loaded.flash()),sha(flash));
  };
  recover();loaded.advance([{buttons:15,frames:1}]);for(const run of continueRuns)loaded.advance([run]);recover();
  const packed=encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256),copy=await WasmEngine.create(bytes,manifest,baseMovie.seed);copies.push(copy);
  const decoded=decodeCheckpoint(packed,baseline,manifest.wasmSha256);assert.equal(sha(decoded),sha(engine.snapshot()));
  copy.restore(decoded);assert.equal(copy.digest(),engine.digest());assert.equal(sha(copy.flash()),sha(flash));
  await mkdir(output);const partyBytes=Buffer.from(c.memory.buffer,c.gPlayerParty.value,200);
  await writeFile(output+'/adventure.sav',flash);await writeFile(output+'/party.bin',partyBytes);await writeFile(output+'/storage.bin',Buffer.from(c.memory.buffer,storage,0x83d0));
  await writeFile(output+'/checkpoint.gz',gzipSync(packed));
  const runs:InputRun[]=chain.flatMap(segment=>segment.runs),movie={...baseMovie,runs:[...baseMovie.runs,...runs],description:'Input-earned training and Vine Whip, Liam and Brock wins, Boulder Badge, TM39, healing and original Save.',
    expectedParty:expected.party,expectedInventory:{...baseMovie.expectedInventory,tm39:expected.tm39},expectedProgress:{badges:expected.badges,brockDefeated:true,tm39Received:true,money:expected.money},
    artifactId:manifest.id,expectedFrames:engine.frame,expectedDigest:engine.digest(),milestones:[...prefixMilestones,...milestones.map((value,index)=>({name:`brock-${index}`,frame:value.frame,restore:true}))]};
  await writeFile(output+'/replay.json',JSON.stringify(movie,null,2)+'\n');
  const partyRuns=[...continueRuns,{buttons:8,frames:1},{buttons:0,frames:30},{buttons:128,frames:1},{buttons:0,frames:24},{buttons:1,frames:1},{buttons:0,frames:60},{buttons:0,frames:60},{buttons:0,frames:60}];
  await writeFile(output+'/continue-party.json',JSON.stringify({seed:baseMovie.seed,sourceCommit:manifest.upstreamCommit,variants:[version],runs:partyRuns,expectedFrames:partyRuns.reduce((n,r)=>n+r.frames,0)},null,2)+'\n');
  await writeFile(output+'/browser-start.checkpoint.gz',gzipSync(packedRoot));await writeFile(output+'/browser.sav',flash);
  await writeFile(output+'/browser-inputs.json',JSON.stringify({seed:baseMovie.seed,artifactId:manifest.id,sourceCommit:manifest.upstreamCommit,startDigest:startingDigest,
    runs,expectedFrames:engine.frame,expectedDigest:engine.digest(),milestones:milestones.map((value,index)=>({name:`brock-${index}`,frame:value.frame,restore:true}))},null,2)+'\n');
  await writeFile(output+'/report.json',JSON.stringify({artifactId:manifest.id,wasmSha256:manifest.wasmSha256,frames:engine.frame,digest:engine.digest(),initial,expected,
    flashSha256:sha(flash),partySha256:sha(partyBytes),storageSha256:expected.storageSha256,pureInputReplay:true,pureInputContinuation:true,
    startingCheckpoint:output+'/browser-start.checkpoint.gz',startingCheckpointSha256:sha(gzipSync(packedRoot)),startingFrame:baseReport.frames,newFrames:engine.frame-baseReport.frames,
    earlierFullMovieProof:`${priorFolder}/report.json`,earlierFullMovieProofSha256:sha(await readFile(priorFolder+'/report.json')),
    immutableAssetsUnchanged:true,originalMenuSave:true,freshContinue:true,warmResetContinue:true,completeCheckpointRestore:true,milestones,
    sourceHashes:{qualifier:sha(await readFile('scripts/check-brock-adventure.ts')),explorer:sha(await readFile('scripts/explore-route.ts'))},
    longDialogue,battleFlagsPreserved:true,prefixOriginalSaveUnchanged:true,prizeMoneyDelta:expected.money-initial.money,recordedPreRepairArtifactId:oldManifest.id,
    gameDirectory:game,
    scope:'Fresh-boot replay of the entire PC/forest/training/Liam/Brock movie on the repaired core. Browser fixture starts at a new, same-core Pewter checkpoint; old-artifact checkpoints are compared read-only.',
    independentGbaReadback:false,browserQualified:false,firstGymQualified:false,fullAdventureQualified:false,publicReleaseQualified:false},null,2)+'\n');
  console.log(JSON.stringify({output,frames:engine.frame,newFrames:engine.frame-baseReport.frames,firstBadgeEarned:true,tm39:expected.tm39,money:expected.money,party:expected.party}));
}finally{for(const copy of copies)copy.close();engine.close();}
