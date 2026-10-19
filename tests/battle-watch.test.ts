import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BattleSessions} from '../apps/server/src/battle-sessions.ts';
import type {Database} from '../apps/server/src/database.ts';
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

test('an invalid battle id is rejected before admission or console access',async()=>{
  await assert.rejects(service({suspended_at:null,in_lobby:true}).watch(owner,'not-a-battle','a'),{code:'INVALID_BATTLE'});
});
