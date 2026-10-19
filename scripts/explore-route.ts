import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync, deflateSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { InputRun } from '../packages/protocol/index.ts';

const guard=resolve(process.env.HOME??'', '.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0){
  process.exit(spawnSync(guard,['--',process.execPath,'--experimental-strip-types',...process.argv.slice(1)],{stdio:'inherit'}).status??1);
}

// Trusted, finite exploration harness. Inspection never writes game memory;
// every gameplay change must be a recorded kanto_step button input. No public
// engine registry, account save or existing qualification evidence is edited.
const [version = 'firered', name = 'initial', from, planPath] = process.argv.slice(2);
const helperSha256=createHash('sha256').update(await readFile('scripts/explore-route.ts')).digest('hex');
assert(['firered', 'leafgreen'].includes(version));
assert(/^[a-z0-9-]{1,50}$/.test(name));
// Audio candidates are opt-in private exploration inputs, never registry admission.
assert([undefined,'1'].includes(process.env.KANTO_EXPLORATION_BATTLE_TEXT));
if(process.env.KANTO_EXPLORATION_BATTLE_TEXT==='1')assert.equal(process.env.KANTO_EXPLORATION_AUDIO,'1');
const variant=process.env.KANTO_EXPLORATION_BATTLE_TEXT==='1'?'battle-text-audio-16':process.env.KANTO_EXPLORATION_AUDIO==='1'?'audio-16':'memory-16';
const directory = resolve(`build/game-source/${version}/${variant}`);
const output = resolve(`build/adventure-exploration/${version}/${name}`);
assert(!existsSync(output),'Preserve retained exploration evidence; choose a fresh name.');
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
const baseline = await createCheckpointBaseline(await WebAssembly.compile(bytes));
const engine = await WasmEngine.create(bytes, manifest, 12345);
const source = resolve(from ?? resolve(directory, 'gameplay.checkpoint'));
let checkpoint = new Uint8Array(await readFile(source));
if (source.endsWith('.gz')) checkpoint = new Uint8Array(gunzipSync(checkpoint));
engine.restore(decodeCheckpoint(checkpoint, baseline, manifest.wasmSha256, { allowLegacy: true }));
type Core = Record<string, any> & { memory: WebAssembly.Memory };
const core = engine.bindExtension<Core>('kanto_lobby_save_abi_version', 1,
  ['MapGridGetCollisionAt', 'MapGridGetMetatileBehaviorAt', 'GetMonData2', 'CheckBagHasItem', 'GetBoxMonData2']);
const memory = new DataView(core.memory.buffer);
const pointer = (name: string): number => core[name].value;
const u8 = (name: string): number => memory.getUint8(pointer(name));
const u32 = (name: string): number => memory.getUint32(pointer(name), true);
const table = core.__indirect_function_table as WebAssembly.Table;
const exportedNames = new Map<Function, string>(Object.entries(core).filter(([,v]) => typeof v === 'function').map(([k,v])=>[v,k]));
const callback = (id: number) => id === 0 ? 'null' : exportedNames.get(table.get(id)) ?? `static#${id}`;
function observe() {
  const before = engine.digest();
  function read<T>(label:string,operation:()=>T):T{
    if(process.env.KANTO_EXPLORATION_AUDIT_READS!=='1')return operation();
    const digest=engine.digest();
    const old=new Uint8Array(core.memory.buffer,core.kanto_state_ptr(),core.kanto_state_size()).slice();
    const result=operation();
    if(engine.digest()!==digest){
      const now=new Uint8Array(core.memory.buffer,core.kanto_state_ptr(),core.kanto_state_size());
      const changed=[];for(let i=0;i<old.length&&changed.length<20;i++)if(old[i]!==now[i])changed.push({offset:i,before:old[i],after:now[i]});
      throw new Error(`Read ${label} changed canonical state: ${JSON.stringify(changed)}`);
    }
    return result;
  }
  const save = u32('gSaveBlock1Ptr');
  // VarGet/FlagGet are NOT passive reads while the original quest log records:
  // they can append observations and update gLastQuestLogStoredFlagOrVarIdx.
  // These GBA-compatible SaveBlock1 offsets come from pinned global.h.
  const variable=(id:number)=>memory.getUint16(save+0x1000+(id-0x4000)*2,true);
  const flag=(id:number)=>Boolean(memory.getUint8(save+0xee0+(id>>>3))&(1<<(id&7)));
  const itemCount=(id:number)=>{
    let low=0,high=65535;
    while(low<high){const mid=Math.floor((low+high+1)/2);if(core.CheckBagHasItem(id,mid))low=mid;else high=mid-1;}
    return low;
  };
  const avatar = pointer('gPlayerAvatar'), objectId = memory.getUint8(avatar + 5);
  const player = pointer('gObjectEvents') + objectId * 0x24;
  const x = memory.getInt16(player + 0x10,true), y = memory.getInt16(player + 0x12,true);
  const mapLayout = memory.getUint32(pointer('gMapHeader'),true);
  const monData=(mon:number)=>{
    const get=(field:number)=>read(`Pokemon 0x${mon.toString(16)} field ${field}`,()=>core.GetMonData2(mon,field));
    return {species:get(11),level:get(56),hp:get(57),maxHp:get(58),
      experience:get(25),personality:get(0)>>>0,trainerId:get(1)>>>0,checksum:get(9),moves:[13,14,15,16].map(get),pp:[17,18,19,20].map(get)};
  };
  const party = Array.from({length:process.env.KANTO_EXPLORATION_STORAGE==='1'?6:u8('gPlayerPartyCount')},(_,index)=>{
    const mon=pointer('gPlayerParty')+100*index;
    return monData(mon);
  }).filter(mon=>mon.species!==0);
  const storage = process.env.KANTO_EXPLORATION_STORAGE === '1' ? read('PC storage',()=>{
    // ARM and wasm32 record-layout checks pin PokemonStorage: four-byte aligned
    // BoxPokemon records start at +4, each 80 bytes, 14 boxes of 30 slots.
    const address=u32('gPokemonStoragePtr');
    const occupied=[];
    for(let box=0;box<14;box++)for(let slot=0;slot<30;slot++){
      const mon=address+4+(box*30+slot)*80,get=(field:number)=>core.GetBoxMonData2(mon,field);
      const species=get(11);
      if(species)occupied.push({box,slot,species,personality:get(0)>>>0,trainerId:get(1)>>>0,
        checksum:get(9),badEgg:get(4),experience:get(25),moves:[13,14,15,16].map(get),
        recordSha256:createHash('sha256').update(new Uint8Array(core.memory.buffer,mon,80)).digest('hex')});
    }
    return {currentBox:memory.getUint8(address),occupied,
      sha256:createHash('sha256').update(new Uint8Array(core.memory.buffer,address,0x83d0)).digest('hex')};
  }):undefined;
  const interactables:{x:number;y:number;behavior:number}[]=[];
  if(storage)for(let yy=0;yy<memory.getInt32(mapLayout+4,true);yy++)for(let xx=0;xx<memory.getInt32(mapLayout,true);xx++){
    const behavior=core.MapGridGetMetatileBehaviorAt(xx+7,yy+7);
    if(behavior===0x83)interactables.push({x:xx,y:yy,behavior});
  }
  const objects = Array.from({length:16},(_,i)=>{
    const p=pointer('gObjectEvents')+i*0x24;
    return {index:i,active:Boolean(memory.getUint8(p)&1),localId:memory.getUint8(p+8),x:memory.getInt16(p+0x10,true)-7,y:memory.getInt16(p+0x12,true)-7};
  }).filter(o=>o.active);
  const grid = Array.from({length:15},(_,dy)=>Array.from({length:19},(_,dx)=>{
    const xx=x+dx-9,yy=y+dy-7;
    if(xx===x&&yy===y)return 'P';
    if(objects.some(o=>o.index!==objectId&&o.x===xx-7&&o.y===yy-7))return 'o';
    return core.MapGridGetCollisionAt(xx,yy) === 0 ? '.' : '#';
  }).join(''));
  const status = {frame:engine.frame,digest:before,mapGroup:memory.getUint8(save+4),mapNumber:memory.getUint8(save+5),
    savedPosition:{x:memory.getInt16(save,true),y:memory.getInt16(save+2,true)},
    position:{x:x-7,y:y-7},facing:memory.getUint8(player+0x18)&15,
    avatar:{running:memory.getUint8(avatar+2),transition:memory.getUint8(avatar+3),preventStep:memory.getUint8(avatar+6)},
    mapSize:{width:memory.getInt32(mapLayout,true),height:memory.getInt32(mapLayout+4,true)},
    callbacks:[callback(memory.getUint32(pointer('gMain'),true)),callback(memory.getUint32(pointer('gMain')+4,true))],
    inBattle:Boolean(memory.getUint8(pointer('gMain')+0x439)&2),battleType:u32('gBattleTypeFlags'),battleOutcome:u8('gBattleOutcome'),
    enemy:monData(pointer('gEnemyParty')),
    battleControls:{execFlags:u32('gBattleControllerExecFlags'),commands:Array.from({length:4},(_,i)=>memory.getUint8(pointer('gBattleBufferA')+i*0x200)),
      actions:Array.from({length:4},(_,i)=>memory.getUint8(pointer('gActionSelectionCursor')+i)),moves:Array.from({length:4},(_,i)=>memory.getUint8(pointer('gMoveSelectionCursor')+i))},
    bag:{location:memory.getUint8(pointer('gBagMenuState')+4),open:memory.getUint8(pointer('gBagMenuState')+5),pocket:memory.getUint16(pointer('gBagMenuState')+6,true)},
    inventory:read('inventory',()=>({parcel:itemCount(349)>0,balls:itemCount(4),potion:itemCount(13)>0,pokedex:flag(0x829)})),
    fieldLocked:typeof core.ArePlayerFieldControlsLocked==='function'?core.ArePlayerFieldControlsLocked():undefined,
    scriptEnabled:typeof core.ScriptContext_IsEnabled==='function'?core.ScriptContext_IsEnabled():undefined,
    scene:variable(0x4055),questLog:u8('gQuestLogState'),party,storage,interactables,objects,grid,
    terrain:process.env.KANTO_EXPLORATION_MAP==='1'?Array.from({length:memory.getInt32(mapLayout+4,true)},(_,yy)=>
      Array.from({length:memory.getInt32(mapLayout,true)},(_,xx)=>xx===x-7&&yy===y-7?'P':objects.some(o=>o.index!==objectId&&o.x===xx&&o.y===yy)?'o':
        core.MapGridGetCollisionAt(xx+7,yy+7)===0?'.':'#').join('')):undefined,
    grass:process.env.KANTO_EXPLORATION_GRASS==='1'?Array.from({length:memory.getInt32(mapLayout+4,true)},(_,yy)=>
      Array.from({length:memory.getInt32(mapLayout,true)},(_,xx)=>core.MapGridGetCollisionAt(xx+7,yy+7)===0&&core.MapGridGetMetatileBehaviorAt(xx+7,yy+7)===2?[xx,yy]:undefined).filter(Boolean)).flat():undefined,
    progress:{firstBadge:flag(0x820),brockDefeated:flag(0x4b0),brockTrainer:flag(0x500+414),liamDefeated:flag(0x500+142),
      secondBadge:flag(0x821),mistyDefeated:flag(0x4b1),tm03Received:flag(0x297),tm03:itemCount(291),
      rivalCerulean:flag(0x500+334),fameCheckerReceived:flag(0x29b),fameChecker:itemCount(363),
      billHelped:flag(0x233),ssTicketReceived:flag(0x234),ssTicketDuplicateFlag:flag(0x235),ssTickets:itemCount(265),nuggets:itemCount(110),
      nuggetBridgeScene:variable(0x406b),ceruleanRivalScene:variable(0x4052),
      runningShoes:flag(0x82f),fossilReceived:flag(0x232),domeFossil:flag(0x272),helixFossil:flag(0x273),
      defeatedTrainers:Array.from({length:743},(_,id)=>flag(0x500+id)?id:-1).filter(id=>id>=0),
      tm39Received:flag(0x254),tm39:itemCount(327),money:(memory.getUint32(save+0x290,true)^memory.getUint32(u32('gSaveBlock2Ptr')+0xf20,true))>>>0,
      trainerOpponent:core.gTrainerBattleOpponent_A?memory.getUint16(core.gTrainerBattleOpponent_A.value,true):undefined}};
  Object.assign(status,{save:{file:memory.getUint16(pointer('gSaveFileStatus'),true),attempt:memory.getUint16(pointer('gSaveAttemptStatus'),true),
    flashSha256:createHash('sha256').update(engine.flash()).digest('hex')}});
  assert.equal(engine.digest(),before,'Inspection changed canonical gameplay state.');
  return status;
}
const start = observe();
type Step=(InputRun & {repeat?:number;label?:string})|{walkTo:[number,number];label?:string;maxSteps?:number;encounters?:'fight'|'run'|'flee-wild';talk?:boolean}
  & {moves?:number[];declineNewMoves?:boolean;stopAfterBattle?:boolean;moveForSpecies?:Record<string,number|number[]>;battleMaxFrames?:number;allowLedges?:boolean}
  |{battle:'fight'|'run';maxFrames?:number;label?:string;moves?:number[];declineNewMoves?:boolean;moveForSpecies?:Record<string,number|number[]>}|{battleStart:true;maxPulses?:number;label?:string}
  |{seekBattle:[number,number][];maxLaps?:number;label?:string}
  |{untilLevel:number;maxRepeats?:number;steps:Step[];label?:string}
  |{expectMap:[number,number];healed?:boolean;label?:string}
  |{battleAction:'bag'|'fight';label?:string}|{dialogue:true;maxPulses?:number;label?:string}|{dialogueUntil:[number,number];maxPulses?:number;label?:string};
const plan = planPath ? JSON.parse(await readFile(resolve(planPath),'utf8')) as {steps:Step[]} : {steps:[]};
const runs: InputRun[]=[];
const stages:{label:string;status:ReturnType<typeof observe>}[]=[];
function input(buttons:number,frames:number){engine.advance([{buttons,frames}]);runs.push({buttons,frames});}
function position(){
  const p=pointer('gObjectEvents')+memory.getUint8(pointer('gPlayerAvatar')+5)*0x24;
  const save=u32('gSaveBlock1Ptr');
  return {x:memory.getInt16(p+0x10,true)-7,y:memory.getInt16(p+0x12,true)-7,map:`${memory.getUint8(save+4)}:${memory.getUint8(save+5)}`,
    battle:Boolean(memory.getUint8(pointer('gMain')+0x439)&2)};
}
function press(button:number){input(button,1);input(0,12);}
function chooseAction(action:'bag'|'fight'){
  const startFrame=engine.frame;
  while(position().battle&&engine.frame-startFrame<6000){
    const command=memory.getUint8(pointer('gBattleBufferA'));
    if(command===18&&(u32('gBattleControllerExecFlags')&1)){
      input(0,30);
      const cursor=memory.getUint8(pointer('gActionSelectionCursor'));
      const target=action==='bag'?1:0;
      if(cursor&2)press(64);if((cursor&1)!==target)press(target?16:32);
      press(1);input(0,60);return;
    }
    if(command===20&&(u32('gBattleControllerExecFlags')&1)){press(2);input(0,30);}
    else{input(1,20);input(0,10);}
  }
}
function finishBattle(action:'fight'|'run',maxFrames=12000,moves:number[]=[0],declineNewMoves=false,moveForSpecies:Record<string,number|number[]>={}){
  assert(maxFrames>0&&maxFrames<=30000);
  assert(moves.length>=1&&moves.length<=32&&moves.every(slot=>Number.isInteger(slot)&&slot>=0&&slot<4));
  assert(Object.keys(moveForSpecies).length<=32&&Object.entries(moveForSpecies).every(([species,slot])=>/^\d{1,3}$/.test(species)&&Number(species)>0&&Number(species)<412&&[slot].flat().length>=1&&[slot].flat().length<=32&&[slot].flat().every(value=>Number.isInteger(value)&&value>=0&&value<4)));
  let turn=0,enemyTurn=0,previousEnemySlot=-1;
  const startFrame=engine.frame;
  while(position().battle&&engine.frame-startFrame<maxFrames){
    if(declineNewMoves){
      // Original battle-script opcodes 0x5a/0x5b and learnMoveState +0x1f
      // identify the two learning prompts. B declines the replacement and A
      // confirms stopping. Never let repeated fight inputs choose a move slot.
      const script=u32('gBattlescriptCurrInstr'),opcode=script?memory.getUint8(script):0;
      if((opcode===0x5a||opcode===0x5b)&&memory.getUint8(pointer('gBattleScripting')+0x1f)===1){
        press(opcode===0x5a?2:1);input(0,30);continue;
      }
    }
    const command=memory.getUint8(pointer('gBattleBufferA'));
    if(command===22&&(u32('gBattleControllerExecFlags')&1)){
      // Keep the active first Pokemon at the optional Shift prompt. A forced
      // faint replacement remains a reviewable stopping point for this plan.
      if(core.GetMonData2(pointer('gPlayerParty'),57)===0)return;
      press(2);input(0,60);continue;
    }
    if((u32('gBattleControllerExecFlags')&1)&&[18,20].includes(command)){
      input(0,30); // finish the original controller's menu initialization
      if(memory.getUint8(pointer('gBattleBufferA'))!==command)continue;
      if(command===18){
        if(action==='run')assert((u32('gBattleTypeFlags')&8)===0,'Never attempt to run from a trainer battle.');
        const cursor=memory.getUint8(pointer('gActionSelectionCursor'));
        const target=action==='run'?3:0;
        if((cursor&2)!==(target&2))press(target&2?128:64);
        if((cursor&1)!==(target&1))press(target&1?16:32);
        press(1);
      }else{
        if(action==='run'){press(2);continue;}
        const cursor=memory.getUint8(pointer('gMoveSelectionCursor'));
        const before=engine.digest(),enemySlot=memory.getUint16(pointer('gBattlerPartyIndexes')+2,true);assert(enemySlot<6);
        const enemySpecies=core.GetMonData2(pointer('gEnemyParty')+enemySlot*100,11);
        assert.equal(engine.digest(),before,'Reading the active opponent changed canonical gameplay.');
        if(enemySlot!==previousEnemySlot){previousEnemySlot=enemySlot;enemyTurn=0;}
        const strategy=moveForSpecies[String(enemySpecies)];
        const selected=typeof strategy==='number'?strategy:Array.isArray(strategy)?strategy[enemyTurn++%strategy.length]!:moves[turn++%moves.length]!;
        // Pass through slot zero: with only three moves, a diagonal change
        // through the empty fourth slot is rejected by the original menu.
        if(cursor&2)press(64);if(cursor&1)press(32);
        if(selected&2)press(128);if(selected&1)press(16);
        assert.equal(memory.getUint8(pointer('gMoveSelectionCursor')),selected,'Move menu did not accept the recorded direction inputs.');
        press(1);
      }
      input(0,60);
    }else{input(1,15);input(0,15);}
  }
  if(!position().battle)input(0,60);
}
function walkTo(target:[number,number],maximum=250,encounters?:'fight'|'run'|'flee-wild',talk=false,moves:number[]=[0],declineNewMoves=false,stopAfterBattle=false,moveForSpecies?:Record<string,number|number[]>,battleMaxFrames=12000,allowLedges=false){
  assert(Number.isInteger(maximum)&&maximum>=1&&maximum<=1000);
  assert(target.length===2&&target.every(Number.isInteger));
  const initial=position();
  const blocked=new Set<string>();
  for(let attempt=0;attempt<maximum;attempt++){
    const at=position();
    if(at.map!==initial.map||at.x===target[0]&&at.y===target[1])return;
    if(at.battle){if(!encounters)return;finishBattle(encounters==='flee-wild'?((u32('gBattleTypeFlags')&8)?'fight':'run'):encounters,battleMaxFrames,moves,declineNewMoves,moveForSpecies);if(position().battle||stopAfterBattle)return;continue;}
    if(core.ArePlayerFieldControlsLocked()||core.ScriptContext_IsEnabled()){
      if(talk&&core.ScriptContext_IsEnabled()){input(1,1);input(0,29);}else input(0,30);
      continue;
    }
    const before=engine.digest();
    const layout=memory.getUint32(pointer('gMapHeader'),true);
    const width=memory.getInt32(layout,true),height=memory.getInt32(layout+4,true);
    const occupied=new Set<string>();
    for(let i=0;i<16;i++){
      const p=pointer('gObjectEvents')+i*0x24;
      if((memory.getUint8(p)&1)&&i!==memory.getUint8(pointer('gPlayerAvatar')+5))occupied.add(`${memory.getInt16(p+0x10,true)-7},${memory.getInt16(p+0x12,true)-7}`);
    }
    type Node={x:number;y:number;first:number};
    const queue:Node[]=[{x:at.x,y:at.y,first:0}],seen=new Set([`${at.x},${at.y}`]);let button=0;
    for(let index=0;index<queue.length;index++){
      const node=queue[index]!;
      if(node.x===target[0]&&node.y===target[1]){button=node.first;break;}
      for(const [dx,dy,bit] of [[0,-1,64],[0,1,128],[-1,0,32],[1,0,16]]){
        let x=node.x+dx!,y=node.y+dy!;
        if(blocked.has(`${node.x},${node.y}:${x},${y}`)||occupied.has(`${x},${y}`))continue;
        // Match GetLedgeJumpDirection's original directional metatile checks.
        // The game still performs the jump from recorded D-pad input; only
        // the private route planner treats its two-tile landing as an edge.
        if(allowLedges&&core.MapGridGetMetatileBehaviorAt(x+7,y+7)===(bit===16?0x38:bit===32?0x39:bit===64?0x3a:0x3b)){
          x+=dx!;y+=dy!;
        }
        const key=`${x},${y}`;
        if(x< -1||x>width||y< -1||y>height||seen.has(key)||occupied.has(key)
          ||blocked.has(`${node.x},${node.y}:${x},${y}`)||core.MapGridGetCollisionAt(x+7,y+7)!==0)continue;
        seen.add(key);queue.push({x,y,first:node.first||bit!});
      }
    }
    assert.equal(engine.digest(),before,'Reading navigation geometry changed canonical state.');
    if(!button){console.log(`No walking path from ${at.x},${at.y} to ${target}.`);return;}
    // The original turn animation can consume the first eight held frames.
    input(button,12);input(0,allowLedges?48:24);
    const after=position();
    if(after.map===at.map&&!after.battle&&after.x===at.x&&after.y===at.y){
      const [dx,dy]=button===64?[0,-1]:button===128?[0,1]:button===32?[-1,0]:[1,0];
      blocked.add(`${at.x},${at.y}:${at.x+dx!},${at.y+dy!}`);
    }
  }
}
function execute(steps:Step[],depth=0){
assert(depth<=3,'Bound nested exploration plans.');
for(const step of steps){
  if('walkTo' in step)walkTo(step.walkTo,step.maxSteps,step.encounters,step.talk,step.moves,step.declineNewMoves,step.stopAfterBattle,step.moveForSpecies,step.battleMaxFrames,step.allowLedges);
  else if('expectMap' in step){
    const state=observe();assert.deepEqual([state.mapGroup,state.mapNumber],step.expectMap,'The recorded route missed its intended map.');
    if(step.healed)assert(state.party.every(mon=>mon.hp===mon.maxHp),'The original nurse interaction did not heal the party.');
  }
  else if('seekBattle' in step){
    const limit=step.maxLaps??80;assert(Number.isInteger(limit)&&limit>=1&&limit<=200);
    assert(step.seekBattle.length>=2&&step.seekBattle.length<=8);
    for(let i=0;i<limit&&!position().battle;i++)for(const point of step.seekBattle){if(position().battle)break;walkTo(point,20);}
    assert(position().battle,'The recorded walking route did not produce an encounter.');
  }
  else if('untilLevel' in step){
    const limit=step.maxRepeats??32;assert(Number.isInteger(limit)&&limit>=1&&limit<=50);
    assert(Number.isInteger(step.untilLevel)&&step.untilLevel>=1&&step.untilLevel<=100);
    const level=()=>{const before=engine.digest(),value=core.GetMonData2(pointer('gPlayerParty'),56);assert.equal(engine.digest(),before);return value;};
    for(let i=0;i<limit&&level()<step.untilLevel;i++){
      execute(step.steps,depth+1);
      assert(core.GetMonData2(pointer('gPlayerParty'),57)>0,'The training plan needs a healthy first Pokemon.');
      console.log(JSON.stringify({trainingCycle:i+1,level:level(),frame:engine.frame}));
    }
    assert(level()>=step.untilLevel,'The bounded training route did not earn the target level.');
  }
  else if('battle' in step)finishBattle(step.battle,step.maxFrames,step.moves,step.declineNewMoves,step.moveForSpecies);
  else if('battleStart' in step){
    const limit=step.maxPulses??150;assert(Number.isInteger(limit)&&limit>=1&&limit<=500);
    for(let i=0;i<limit&&!position().battle;i++){input(1,1);input(0,29);}
  }
  else if('battleAction' in step)chooseAction(step.battleAction);
  else if('dialogue' in step){
    const limit=step.maxPulses??200;assert(Number.isInteger(limit)&&limit>0&&limit<=500);
    for(let i=0;i<limit&&(core.ScriptContext_IsEnabled()||core.ArePlayerFieldControlsLocked());i++){input(1,1);input(0,29);}
  }
  else if('dialogueUntil' in step){
    const [variable,value]=step.dialogueUntil;assert(variable>=0x4000&&variable<0x4100&&Number.isInteger(variable));
    const limit=step.maxPulses??100;assert(Number.isInteger(limit)&&limit>0&&limit<=500);
    for(let i=0;i<limit;i++){
      const save=u32('gSaveBlock1Ptr');
      if(memory.getUint16(save+0x1000+(variable-0x4000)*2,true)===value&&!core.ScriptContext_IsEnabled()&&!core.ArePlayerFieldControlsLocked())break;
      input(1,20);input(0,10);
    }
  }
  else{
    assert(Number.isInteger(step.repeat??1)&&(step.repeat??1)>=1&&(step.repeat??1)<=1000);
    for(let i=0;i<(step.repeat??1);i++)input(step.buttons,step.frames);
  }
  if(step.label)stages.push({label:step.label,status:observe()});
}
}
let planFailure:unknown;
try{execute(plan.steps);}catch(error){planFailure=error;}
const end=observe();
await mkdir(resolve('build/adventure-exploration',version),{recursive:true});
await mkdir(output); // fail rather than overwrite retained exploration evidence
await writeFile(resolve(output,'checkpoint.gz'),gzipSync(encodeCheckpoint(engine.snapshot(),baseline,manifest.wasmSha256),{level:6}));
await writeFile(resolve(output,'cartridge.sav'),engine.flash());
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type:string,bytes:Uint8Array){const text=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([text,bytes])));return Buffer.concat([length,text,bytes,crc]);}
assert.equal(core.kanto_render_frame(),0);
const pixels=new Uint8Array(core.memory.buffer,core.kanto_framebuffer_ptr(),core.kanto_framebuffer_size());
const header=Buffer.alloc(13);header.writeUInt32BE(240);header.writeUInt32BE(160,4);header[8]=8;header[9]=6;
const scan=Buffer.alloc(160*(240*4+1));for(let row=0;row<160;row++)scan.set(pixels.subarray(row*240*4,(row+1)*240*4),row*(240*4+1)+1);
await writeFile(resolve(output,'screen.png'),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',new Uint8Array())]));
assert.equal(createHash('sha256').update(await readFile('scripts/explore-route.ts')).digest('hex'),helperSha256,'Explorer source changed during the run.');
const report={artifactId:manifest.id,wasmSha256:manifest.wasmSha256,gameDirectory:directory,helperSha256,
  plan:planPath?resolve(planPath):null,planSha256:planPath?createHash('sha256').update(await readFile(resolve(planPath))).digest('hex'):null,
  source,sourceCheckpointSha256:createHash('sha256').update(checkpoint).digest('hex'),start,end,stages,runs,
  frameCount:runs.reduce((sum,r)=>sum+r.frames,0),inspectionMutatesCanonicalState:false,gameplayMutations:'recorded button inputs only',qualified:false,
  ...(planFailure?{planFailed:true,error:String(planFailure),stack:planFailure instanceof Error?planFailure.stack:undefined}:{planFailed:false})};
await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,start:{frame:start.frame,position:start.position,map:[start.mapGroup,start.mapNumber]},end},null,2));
engine.close();
if(planFailure)throw planFailure;
