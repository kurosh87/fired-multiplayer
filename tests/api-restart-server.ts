// Private qualification entry only. Never built into the web app or linked
// from production main. Uses the production API and verifier with real C/PG.
import assert from 'node:assert/strict';
import {subscribe} from 'node:diagnostics_channel';
import {resolve} from 'node:path';
import {Database} from '../apps/server/src/database.ts';
import {createApp} from '../apps/server/src/app.ts';
import {PRIVATE_WORKER_POOL_CHANNEL,type PrivateWorkerPool,type PrivateWorkerPoolEvent} from '../packages/engine/private-worker-pool.ts';
import {originalGameProvider} from './original-game-provider.ts';

assert(process.send&&process.connected,'Use the owned restart qualification parent.');
assert.equal(process.env.GAME_WORKER_TRANSPORT,'process');
const url=new URL(process.env.DATABASE_TEST_URL!);
assert.equal(url.hostname,'localhost');assert.equal(url.username,'kanto_test');
assert(/^\/kanto_restart_\d+$/.test(url.pathname));
assert.equal(url.searchParams.get('host'),resolve('build/postgres-test/socket'));
const auth=new URL(process.env.KANTO_TEST_AUTH_URL!);assert.equal(auth.hostname,'127.0.0.1');
const pools=new Set<PrivateWorkerPool>();
subscribe(PRIVATE_WORKER_POOL_CHANNEL,message=>{
  const event=message as PrivateWorkerPoolEvent;
  if(event.event==='opened')pools.add(event.pool);else pools.delete(event.pool);
});
const database=new Database(url.href),registry=await originalGameProvider(false,true);
const blockSessions=new Set<string>();
const append=database.append.bind(database);
database.append=async(sessionId,fence,entry)=>{
  if(blockSessions.delete(sessionId)){
    process.send!({event:'append-blocked',sessionId,sequence:entry.batch.sequence,frame:entry.acknowledgement.frame});
    // Explicit fault injection after original C advances, before the real PG
    // append starts. The parent kills this process; no client can enable it.
    await new Promise<void>(()=>{});
  }
  return append(sessionId,fence,entry);
};
const app=await createApp({origin:process.env.KANTO_TEST_WEB_ORIGIN!,engineDirectory:'unused-private-restart-provider',
  supabaseUrl:auth.href,publishableKey:'restart-fixture-only',publicRelease:false,
  adventureWorkers:2,inspectionWorkers:1,tradeWorkers:1,battleWorkers:1},{database,registry});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{
  void app.close().then(()=>database.close()).then(()=>process.exit(0)).catch(()=>process.exit(1));
});
process.on('message',message=>{
  const body=message as {id:number;operation:string;sessionId?:string};
  void(async()=>{
    if(body.operation==='block-next-append'){assert.equal(typeof body.sessionId,'string');blockSessions.add(body.sessionId!);return true;}
    assert.equal(body.operation,'resources');
    return Promise.all([...pools].map(pool=>pool.resources()));
  })().then(data=>process.send!({event:'reply',id:body.id,data}),()=>process.send!({event:'reply',id:body.id,error:'Private qualification command failed.'}));
});
const base=await app.listen({host:'127.0.0.1',port:0});
process.send!({event:'listening',base,pid:process.pid});
