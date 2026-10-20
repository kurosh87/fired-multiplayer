import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BattleSessions} from '../apps/server/src/battle-sessions.ts';
import type {Database} from '../apps/server/src/database.ts';
import type {BattleView} from '../packages/battles/protocol.ts';
import type {EngineRegistry} from '../packages/engine/registry.ts';

const BATTLE='00000000-0000-4000-8000-000000000003';
const owner='00000000-0000-4000-8000-000000000001';
/** Admission-only fixture: no console is opened and no battle row is read
 * unless the lobby predicate passes. Original-C pixels are qualified elsewhere. */
function service(row:{suspended_at:Date|null;in_lobby:boolean}|undefined){
  const database={pool:{query:async()=>({rows:row?[row]:[]})}} as unknown as Database;
  return new BattleSessions(database,{} as EngineRegistry);
}

test('watchers must be unsuspended members of the live lobby',async()=>{
  await assert.rejects(service(undefined).watch(owner,BATTLE,'a'),{code:'TRAINER_NOT_FOUND'});
  await assert.rejects(service({suspended_at:new Date(),in_lobby:true}).watch(owner,BATTLE,'a'),{code:'ACCOUNT_SUSPENDED'});
  await assert.rejects(service({suspended_at:null,in_lobby:false}).watch(owner,BATTLE,'a'),{code:'LOBBY_NOT_FOUND'});
  await assert.rejects(service({suspended_at:null,in_lobby:true}).watch(owner,BATTLE,'a'),{code:'BATTLE_NOT_FOUND'});
});

test('the live list uses the same lobby membership contract as watching',async()=>{
  await assert.rejects(service(undefined).liveBattlesFor(owner),{code:'TRAINER_NOT_FOUND'});
  await assert.rejects(service({suspended_at:new Date(),in_lobby:true}).liveBattlesFor(owner),{code:'ACCOUNT_SUSPENDED'});
  await assert.rejects(service({suspended_at:null,in_lobby:false}).liveBattlesFor(owner),{code:'LOBBY_NOT_FOUND'});
});

test('a quick match replaces a reusable watchable challenge with a private one',async()=>{
  const view=(watchable:boolean)=>({id:BATTLE,watchable} as unknown as BattleView);
  const run=async(existingWatchable:boolean)=>{
    const calls:string[]=[];
    const session=new BattleSessions({pool:{query:async()=>({rows:[]})}} as unknown as Database,{} as EngineRegistry);
    let first=true;
    (session as unknown as {repository:{
      challenge(a:string,b:string,watchable?:boolean):Promise<BattleView>;
      decline(b:string,id:string):Promise<BattleView>;
    }}).repository={
      async challenge(_a,_b,watchable=false){calls.push(`challenge:${watchable}`);const value=first?existingWatchable:false;first=false;return view(value);},
      async decline(){calls.push('decline');return view(true);},
    };
    (session as unknown as {accept:(b:string,id:string)=>Promise<unknown>}).accept=async()=>{calls.push('accept');return {};};
    await session.quickPair(owner,'00000000-0000-4000-8000-000000000002');
    return calls;
  };
  assert.deepEqual(await run(true),['challenge:false','decline','challenge:false','accept'],
    'A quick match silently reused a watchable challenge.');
  assert.deepEqual(await run(false),['challenge:false','accept'],
    'A private challenge should be reused without a decline.');
});

test('an invalid battle id is rejected before admission or console access',async()=>{
  await assert.rejects(service({suspended_at:null,in_lobby:true}).watch(owner,'not-a-battle','a'),{code:'INVALID_BATTLE'});
});
