import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { TradeScenes } from '../apps/server/src/trade-scenes.ts';
import { TradeWorkerPool, type TradeEngine } from '../packages/trading/worker-pool.ts';
import { DomainError } from '../packages/protocol/index.ts';
import type { VerificationEngine } from '../packages/verification/verifier.ts';
import type { EngineRegistry } from '../packages/engine/registry.ts';
import type { PostgresTrades } from '../apps/server/src/trade-repository.ts';
import type { TradeSceneStore, SceneRow } from '../apps/server/src/trade-scene-store.ts';
import type { TradeOffers } from '../apps/server/src/trade-offers.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

function fixture(){
  let fence=0,receipt:any,checkpointCalls=0;
  const started=deferred(),persisted=deferred(),engines:{closed:boolean;closeCalls:number}[]=[];
  const row=()=>({id:'scene',owner_id:'alice',trade_id:'trade',version:'firered',artifact_id:'test-core',seed:'1',
    checkpoint:null,initial_checkpoint:Buffer.from([1]),next_sequence:'0',frame:'0',status:'running',fence:String(++fence)} as SceneRow);
  const store={claim:async()=>row(),entries:async()=>[],find:async()=>undefined,
    checkpoint:async()=>{if(++checkpointCalls===1){started.resolve();await persisted.promise;}},expireLease:async()=>undefined} as unknown as TradeSceneStore;
  // A worker-boundary double controls persistence timing. Original-C gateway
  // checks cover the real workers; these tests exercise service lifecycle races.
  const pool=Object.create(TradeWorkerPool.prototype) as TradeWorkerPool;
  pool.restore=async()=>{
    const state={closed:false,closeCalls:0};engines.push(state);
    const engine:VerificationEngine={frame:0,advance:()=>undefined,digest:()=>{assert(!state.closed);return '0'.repeat(64);},
      snapshot:()=>new Uint8Array([1]),flash:()=>new Uint8Array(128*1024),
      captureCheckpoint:async()=>({checkpoint:new Uint8Array([1]),frame:0,digest:'0'.repeat(64),flash:new Uint8Array(128*1024)}),
      close:()=>{state.closed=true;state.closeCalls++;}};
    return {engine,get phase(){if(state.closed)throw new DomainError('TRADE_WORKER_LOST','Worker closed',503);return 2;},close:()=>engine.close()} as unknown as TradeEngine;
  };
  const registry={manifest:()=>({id:'test-core',wasmSha256:'0'.repeat(64)}),artifact:()=>new Uint8Array()} as unknown as EngineRegistry;
  const repository={receipt:async()=>receipt} as unknown as PostgresTrades;
  const offers={get:async()=>({status:receipt?'committed':'committing'})} as unknown as TradeOffers;
  const service=new TradeScenes(registry,repository,store,offers,()=>0,pool);
  return {service,engines,started,persisted,commit:()=>{receipt={tradeId:'trade',revisionA:2,revisionB:2,result:{}};}};
}

test('trade shutdown waits for an in-flight checkpoint before releasing its worker',async()=>{
  const f=fixture();await f.service.open('alice','trade');
  const checkpoint=f.service.checkpoint('alice','trade',1).then(value=>({value}),error=>({error}));
  await f.started.promise;const closing=f.service.close();await setImmediate();const releasedEarly=f.engines[0]!.closed;
  f.persisted.resolve();const result=await checkpoint;await closing;
  assert.equal(releasedEarly,false);assert(!('error' in result));assert.equal(f.engines[0]!.closeCalls,1);
});

test('a durable receipt from another API retires the local completed-trade runtime',async()=>{
  const f=fixture();await f.service.open('alice','trade');f.commit();
  const result=await f.service.finish('alice','trade');assert.equal(result.done,true);
  const released=f.engines[0]!.closed;await f.service.close();assert.equal(released,true);assert.equal(f.engines[0]!.closeCalls,1);
});

test('disconnect and reopen cannot remove or close a replacement trade runtime',async()=>{
  const f=fixture();await f.service.open('alice','trade');
  const disconnect=f.service.disconnect('alice','trade',1).then(()=>undefined,error=>error);
  await f.started.promise;
  const reopening=f.service.open('alice','trade').then(value=>({value}),error=>({error}));
  await setImmediate();f.persisted.resolve();const disconnected=await disconnect,result=await reopening;
  try{
    assert.equal(disconnected,undefined);assert(!('error' in result));
    assert.equal(f.service.connection('alice','trade').fence,2);assert.equal(f.engines[1]!.closed,false);
  }finally{await f.service.close();}
});
