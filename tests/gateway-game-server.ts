// Private two-process qualification entry. Never imported by production main.
import assert from 'node:assert/strict';
import {subscribe} from 'node:diagnostics_channel';
import {resolve} from 'node:path';
import {Database} from '../apps/server/src/database.ts';
import {createApp} from '../apps/server/src/app.ts';
import {PRIVATE_WORKER_POOL_CHANNEL,type PrivateWorkerPool,type PrivateWorkerPoolEvent} from '../packages/engine/private-worker-pool.ts';
import {originalGameProvider} from './original-game-provider.ts';

assert(process.send&&process.connected,'Use the owned gateway qualification parent.');
assert.equal(process.env.GAME_WORKER_TRANSPORT,'process');
const url=new URL(process.env.DATABASE_TEST_URL!);
assert.equal(url.hostname,'localhost');assert.equal(url.username,'kanto_test');
assert(/^\/kanto_gateway_\d+$/.test(url.pathname));
assert.equal(url.searchParams.get('host'),resolve('build/postgres-test/socket'));
const auth=new URL(process.env.KANTO_TEST_AUTH_URL!);assert.equal(auth.hostname,'127.0.0.1');
const pools=new Set<PrivateWorkerPool>();
subscribe(PRIVATE_WORKER_POOL_CHANNEL,message=>{
  const event=message as PrivateWorkerPoolEvent;
  if(event.event==='opened')pools.add(event.pool);else pools.delete(event.pool);
});
assert([undefined,'1'].includes(process.env.KANTO_GATEWAY_BATTLE_TEXT));
const database=new Database(url.href),registry=await originalGameProvider(false,true,process.env.KANTO_GATEWAY_BATTLE_TEXT==='1'),battleRegistry=await originalGameProvider(true);
const app=await createApp({origin:process.env.KANTO_TEST_WEB_ORIGIN!,engineDirectory:'unused-private-gateway-provider',
  supabaseUrl:auth.href,publishableKey:'gateway-fixture-only',publicRelease:false,trustedProxyCidrs:['127.0.0.1/32'],
  adventureWorkers:1,inspectionWorkers:1,tradeWorkers:1,battleWorkers:1},{database,registry,battleRegistry});
app.addHook('onRequest',async request=>{process.send?.({event:'request',path:request.url,method:request.method});});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{
  void app.close().then(()=>database.close()).then(()=>process.exit(0)).catch(()=>process.exit(1));
});
process.on('disconnect',()=>{void app.close().then(()=>database.close()).finally(()=>process.exit(1));});
process.on('message',message=>{
  const body=message as {id:number;operation:string};
  void(async()=>{assert.equal(body.operation,'resources');return Promise.all([...pools].map(pool=>pool.resources()));})()
    .then(data=>process.send!({event:'reply',id:body.id,data}),()=>process.send!({event:'reply',id:body.id,error:'Private qualification command failed.'}));
});
const base=await app.listen({host:'127.0.0.1',port:0});
process.send!({event:'listening',base,pid:process.pid});
