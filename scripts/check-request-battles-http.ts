import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import type { Database } from '../apps/server/src/database.ts';
import { createBetterAuthAuthenticator } from '../apps/server/src/account-auth.ts';
import type { createPreviewCloud } from '../apps/server/src/preview-cloud.ts';
import { RequestBattles } from '../apps/server/src/request-battles.ts';
import { requestBattleHttp } from '../apps/server/src/request-battle-http.ts';
import { BattleRunStore } from '../apps/server/src/battle-run-store.ts';
import { BattleConsolePool } from '../packages/battles/console-pool.ts';
import { BattleScreenDecoder } from '../packages/battles/screen.ts';
import { decodeBattleResponse, type RequestBattleInput, type RequestBattleMetadata, type RequestBattleController } from '../packages/battles/request-protocol.ts';
import { originalGameProvider } from '../tests/original-game-provider.ts';
import { seedBattleLobby } from '../tests/battle-ui-qualification.ts';
import { battleWorkload } from './battle-workload.ts';
import { OriginalBattlePair } from '../packages/battles/original-pair.ts';
import { gunzipSync } from 'node:zlib';
import { checkRequestBattleBrowser } from './check-request-battle-browser.ts';

type Account={id:string;email:string;cookie:string;token:string};
/** Real HTTP, SDK identities, restricted game SQL and original consoles. The
 * extended movie uses an explicit trusted server-clock fixture; no HTTP field
 * controls time. The ordinary-clock path is separately exercised below. */
export async function checkRequestBattlesHttp(game:Database,owner:pg.Client,accountDatabaseUrl:string,authOrigin:string,secret:string,
  cloud:ReturnType<typeof createPreviewCloud>,accounts:[Account,Account,Account],password:string,saves:[string,string],output:string){
  const [a,b,c]=accounts,workload=await battleWorkload(),registry=await originalGameProvider(true);
  const accountPool=new pg.Pool({connectionString:accountDatabaseUrl,max:2});
  const authenticate=createBetterAuthAuthenticator(accountPool,authOrigin,secret);
  const reportPath=output+'/request-battles-http-report.json',checks:string[]=[],counters=[0,0],through=[0,0];
  const sourceSha256=Object.fromEntries(await Promise.all(['apps/server/src/request-battles.ts','apps/server/src/request-battle-store.ts',
    'apps/server/src/request-battle-http.ts','apps/server/src/battle-repository.ts','apps/server/src/battle-run-store.ts',
    'packages/battles/request-protocol.ts','packages/battles/request-clock.ts','scripts/check-request-battles-http.ts',
    'infra/netlify-request-battles.sql','infra/netlify-battle-controls.sql','scripts/check-request-battle-browser.ts',
    'apps/web/src/request-battle.tsx','apps/web/src/battle-panel.tsx','apps/web/src/battle.tsx',
    'apps/web/src/lib/request-battle-fetch.ts','apps/web/src/lib/request-battle-playback.ts','apps/web/src/lib/battle-api.ts','apps/web/src/lobby.tsx','tests/request-battle-ui-entry.tsx',
    'netlify/database/migrations/20261017152100_battle-control-connections/migration.sql'].map(async path=>[path,createHash('sha256').update(await import('node:fs/promises').then(fs=>fs.readFile(path))).digest('hex')])));
  let now=BigInt(Date.now())*1000n,service=new RequestBattles(game,registry,{clock:async()=>now,entropy:()=>workload.artifacts[0].seed});
  let handler:ReturnType<typeof requestBattleHttp>,frame=0,requests=0,workerFailureRecovered=false;
  const requestTimings=new WeakMap<Response,number>(),advancingHttpMs:number[]=[];
  const server=createServer((incoming,outgoing)=>{
    void(async()=>{
      const chunks:Buffer[]=[];let size=0;for await(const chunk of incoming){size+=chunk.length;if(size>16384)throw new Error('Oversized native HTTP fixture');chunks.push(Buffer.from(chunk));}
      const headers=new Headers();for(const [key,value] of Object.entries(incoming.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const response=await handler(new Request(base+incoming.url,{method:incoming.method,headers,...(incoming.method==='GET'?{}:{body:new Uint8Array(Buffer.concat(chunks))})}));
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(()=>{outgoing.writeHead(500);outgoing.end('{}');});
  });
  let base='',battleId='',canonical:unknown;
  const raw=async(side:number,path:string,body?:unknown,token=accounts[side]!.token,origin?:string)=>{
    requests++;const start=performance.now(),response=await fetch(base+'/api/online/battles'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Origin:origin??base,
      ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});requestTimings.set(response,performance.now()-start);return response;
  };
  const okay=async(response:Response,status=200)=>{if(response.status!==status)assert.equal(response.status,status,await response.clone().text());return response;};
  const controllers=new Map<string,RequestBattleController[]>();
  const openBattle=async(id:string)=>{const values:RequestBattleController[]=[];for(const side of [0,1]){const view=await(await okay(await raw(side,`/${id}`))).json();const reply=await(await okay(await raw(side,`/${id}/open`,{connectionId:randomUUID(),expectedEpoch:view.controllerEpoch}))).json();values.push(reply.controller);}controllers.set(id,values);};
  const controller=(side:number,id=battleId)=>controllers.get(id)?.[side]??{connectionId:randomUUID(),epoch:1};
  const request=(side:number,runs:RequestBattleInput['runs']=[]):RequestBattleInput=>({protocol:1,action:'step',operationId:randomUUID(),sequence:counters[side]!,controller:controller(side),runs});
  const acceptResponse=async(side:number,response:Response)=>{
    await okay(response);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
    assert.equal(response.headers.get('Content-Type'),'application/vnd.kanto.battle-response');
    const bytes=new Uint8Array(await response.arrayBuffer()),decoded=decodeBattleResponse(bytes),decoder=new BattleScreenDecoder();
    for(const packet of decoded.packets)decoder.apply(packet);
    assert.equal(decoded.metadata.side,side?'b':'a');assert.equal(decoded.metadata.sequence,counters[side]);
    assert(decoder.frame<=decoded.metadata.frame);assert(decoded.metadata.frame>=frame);
    if(decoded.metadata.frame>frame)advancingHttpMs.push(requestTimings.get(response)!);frame=decoded.metadata.frame;
    counters[side]=decoded.metadata.nextSequence;through[side]=decoded.metadata.inputThrough;
    return {bytes,metadata:decoded.metadata,pixels:Buffer.from(decoder.pixels)};
  };
  try{
    await seedBattleLobby(game,[a.id,b.id],saves,await originalGameProvider());
    for(const [side,id] of saves.entries())await game.pool.query('update private.adventures set flash=$2 where id=$1',[id,workload.saves[side]]);
    canonical=(await game.pool.query('select id,revision,flash from private.adventures order by id')).rows;
    for(const table of ['battle_request_runs','battle_request_inputs','battle_request_receipts','battle_control_connections'])await assert.rejects(accountPool.query(`select * from private.${table}`),{code:'42501'});
    await assert.rejects(game.pool.query('delete from private.battle_request_receipts'),{code:'42501'});
    checks.push('Account role cannot read request consoles/queues/receipts; game runtime cannot delete immutable response receipts');
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}`;
    handler=requestBattleHttp(service,authenticate,base);
    await okay(await raw(0,'',undefined,'missing'),401);
    await owner.query('update kanto_auth."user" set "emailVerified"=false where id=$1',[c.id]);await okay(await raw(2,''),403);await owner.query('update kanto_auth."user" set "emailVerified"=true where id=$1',[c.id]);
    await cloud.store.reserve(c.id,'RequestScout');
    await okay(await raw(0,'',undefined,a.token,'https://unrelated.invalid'),403);
    const offered=await(await okay(await raw(0,'',{trainerId:b.id}))).json();battleId=offered.id;
    await okay(await raw(0,`/${battleId}/accept`,{}),403);
    await okay(await raw(1,`/${battleId}/accept`,{seed:0}),400);
    const accepted=await(await okay(await raw(1,`/${battleId}/accept`,{}))).json();assert.equal(accepted.frame,0);await openBattle(battleId);
    await okay(await raw(2,`/${battleId}`),404);await okay(await raw(2,`/${battleId}/step`,request(0)),404);
    await assert.rejects(new BattleRunStore(game).claim(a.id,battleId),{code:'BATTLE_TRANSPORT_CONFLICT'});
    checks.push('Actual confirmed SDK accounts, strict origin and membership checks, native challenge/acceptance, and exclusive request transport');
    await okay(await raw(0,`/${battleId}/step`,{...request(0),frame:1000}),400);
    await okay(await raw(0,`/${battleId}/step`,{...request(0),ownerId:b.id}),400);
    await okay(await raw(0,`/${battleId}/step`,{...request(0),runs:[{buttons:0,frames:16}]}),400);
    const lost=request(0),first=await raw(0,`/${battleId}/step`,lost);await okay(first);const discarded=new Uint8Array(await first.arrayBuffer());
    // Discard the reply and recreate the service as if its invocation vanished.
    service=new RequestBattles(game,registry,{clock:async()=>now,entropy:()=>workload.artifacts[0].seed});handler=requestBattleHttp(service,authenticate,base);
    const retried=await acceptResponse(0,await raw(0,`/${battleId}/step`,lost));assert.deepEqual(retried.bytes,discarded);
    await okay(await raw(0,`/${battleId}/step`,{...lost,runs:[{buttons:1,frames:1}]}),409);
    const concurrent=request(0),race=await Promise.all([raw(0,`/${battleId}/step`,concurrent),raw(0,`/${battleId}/step`,concurrent)]);
    for(const response of race){assert([200,409].includes(response.status));await response.arrayBuffer();}
    await acceptResponse(0,await raw(0,`/${battleId}/step`,concurrent));
    assert.equal(Number((await game.pool.query('select count(*) from private.battle_request_receipts where battle_id=$1 and owner_id=$2 and operation_id=$3',[battleId,a.id,concurrent.operationId])).rows[0].count),1);
    const held=request(0),heldClaim=await service.store.claim(a.id,battleId,held);assert('claim'in heldClaim);
    const peerWaiting=request(1),busy=await okay(await raw(1,`/${battleId}/step`,peerWaiting),409);assert.equal((await busy.json()).error,'BATTLE_REQUEST_BUSY');await service.store.release(heldClaim.claim);
    const yielded=await okay(await raw(0,`/${battleId}/step`,held),409);assert.equal((await yielded.json()).error,'BATTLE_REQUEST_BUSY');
    await acceptResponse(1,await raw(1,`/${battleId}/step`,peerWaiting));
    const stale=await service.store.claim(a.id,battleId,held);assert('claim'in stale);
    await game.pool.query("update private.battle_request_runs set claim_until=clock_timestamp()-interval '1 second' where battle_id=$1",[battleId]);
    const replacement=await service.store.claim(a.id,battleId,held);assert('claim'in replacement);
    await assert.rejects(service.store.commit(stale.claim,{frame:0,caches:[stale.claim.state.screen_a,stale.claim.state.screen_b],decision:stale.claim.decision,
      entries:[],buttons:[0,0],clock:stale.claim.clock,result:null,response:Buffer.from('must never commit')}),{code:'BATTLE_REQUEST_CHANGED'});
    await service.store.release(replacement.claim);await acceptResponse(0,await raw(0,`/${battleId}/step`,held));
    checks.push('Discarded replies return identical durable receipts; conflicting retries and replaced/parallel claims cannot change progress');
    await acceptResponse(0,await raw(0,`/${battleId}/step`,request(0)));
    const clockBefore=(await game.pool.query('select clock_us,credit from private.battle_request_runs where battle_id=$1',[battleId])).rows[0];
    for(let index=0;index<4;index++){
      service=new RequestBattles(game,registry,{clock:async()=>now});handler=requestBattleHttp(service,authenticate,base);
      await acceptResponse(index%2,await raw(index%2,`/${battleId}/step`,request(index%2)));
    }
    assert.deepEqual((await game.pool.query('select clock_us,credit from private.battle_request_runs where battle_id=$1',[battleId])).rows[0],clockBefore);assert.equal(frame,0);
    checks.push('Cold service recreation at unchanged time does not mint clock credit or grant startup frames');
    const oldToken=a.token;
    await okay(await cloud.fetch(new Request(authOrigin+'/api/cloud/auth/sign-out',{method:'POST',headers:{Origin:authOrigin,Cookie:a.cookie,'Content-Type':'application/json'},body:'{}'}),'192.0.2.220'));
    await okay(await raw(0,`/${battleId}`,undefined,oldToken),401);
    const login=await okay(await cloud.fetch(new Request(authOrigin+'/api/cloud/auth/sign-in/email',{method:'POST',headers:{Origin:authOrigin,'Content-Type':'application/json'},body:JSON.stringify({email:a.email,password})}),'192.0.2.220'));
    a.cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');a.token=(await login.json()).token;
    const renewed=await(await okay(await raw(0,`/${battleId}`))).json();assert.equal(renewed.nextSequence,counters[0]);
    checks.push('Logout invalidates the old HTTP session; fresh SDK login preserves request sequencing and battle state');
    const full=process.env.KANTO_REQUEST_BATTLE_FULL==='1',limit=full?workload.inputs.length:120;
    let finalMetadata:RequestBattleMetadata|undefined;
    while(frame<limit){
      // Queue the recorded personal inputs before advancing this fixture's
      // trusted clock. The real server never waits for a peer input queue.
      for(const side of [0,1]){
        const end=Math.min(limit,through[side]!+15),runs:RequestBattleInput['runs']=[];
        for(let cursor=through[side]!;cursor<end;cursor++){
          const buttons=workload.inputs[cursor]![side]!,last=runs.at(-1);if(last&&last.buttons===buttons)last.frames++;else runs.push({buttons,frames:1});
        }
        await acceptResponse(side,await raw(side,`/${battleId}/step`,request(side,runs)));
      }
      now+=251143n;
      const side=0,body=request(side);
        if(!workerFailureRecovered){
          const snapshot=(await game.pool.query('select revision,clock_us,credit,input_through_a,input_through_b from private.battle_request_runs where battle_id=$1',[battleId])).rows[0];
          service=new RequestBattles(game,registry,{clock:async()=>now,workerFactory:()=>{const pool=new BattleConsolePool(1);void pool.close();return pool;}});handler=requestBattleHttp(service,authenticate,base);
          await okay(await raw(side,`/${battleId}/step`,body),503);
          assert.deepEqual((await game.pool.query('select revision,clock_us,credit,input_through_a,input_through_b from private.battle_request_runs where battle_id=$1',[battleId])).rows[0],snapshot);
          service=new RequestBattles(game,registry,{clock:async()=>now});handler=requestBattleHttp(service,authenticate,base);
          const journal=(await game.pool.query('select frame,next_sequence,checkpoint_a,checkpoint_b from private.battle_runs where battle_id=$1',[battleId])).rows[0];
          await owner.query(`create function private.request_receipt_failure() returns trigger language plpgsql as $$ begin perform pg_sleep(2); raise exception 'native receipt rollback check'; end $$`);
          await owner.query('create trigger request_receipt_failure before insert on private.battle_request_receipts for each row execute function private.request_receipt_failure()');
          const failedWriteAt=performance.now();try{await okay(await raw(side,`/${battleId}/step`,body),503);assert(performance.now()-failedWriteAt<5000);}
          finally{await owner.query('drop trigger request_receipt_failure on private.battle_request_receipts');await owner.query('drop function private.request_receipt_failure()');}
          assert.deepEqual((await game.pool.query('select revision,clock_us,credit,input_through_a,input_through_b from private.battle_request_runs where battle_id=$1',[battleId])).rows[0],snapshot);
          assert.deepEqual((await game.pool.query('select frame,next_sequence,checkpoint_a,checkpoint_b from private.battle_runs where battle_id=$1',[battleId])).rows[0],journal);
          workerFailureRecovered=true;
          checks.push('A lost worker and a statement deadline at final receipt insertion roll back clock, queues, console checkpoints and journals before an identical retry succeeds');
        }
      const response=await acceptResponse(side,await raw(side,`/${battleId}/step`,body));finalMetadata=response.metadata;
      const saved=(await game.pool.query('select screen_a as screen from private.battle_request_runs where battle_id=$1',[battleId])).rows[0];
      const decoder=new BattleScreenDecoder();decoder.apply(gunzipSync(saved.screen));assert.deepEqual(response.pixels,Buffer.from(decoder.pixels));
      if(requests%150<3)console.log(JSON.stringify({requestBattleFrames:frame,targetFrames:limit,requests}));
    }
    const reference=await OriginalBattlePair.create(workload.artifacts,workload.saves);
    try{
      for(let cursor=0;cursor<frame;cursor++)reference.tick(workload.inputs[cursor]!);
      const privateScreens=(await game.pool.query('select screen_a,screen_b from private.battle_request_runs where battle_id=$1',[battleId])).rows[0];
      for(const side of ['a','b'] as const){const decoder=new BattleScreenDecoder();decoder.apply(gunzipSync(privateScreens['screen_'+side]));assert.deepEqual(Buffer.from(decoder.pixels),Buffer.from(reference.screen(side)));}
    }finally{reference.close();}
    checks.push('Each personal response picture matches the same side of a separate uninterrupted original-C reference');
    if(full){
      assert.deepEqual(finalMetadata?.result,{winner:'a',reason:'finished'});
      const digests=(await game.pool.query('select digest_a,digest_b from private.battle_input_journal where battle_id=$1 order by sequence desc limit 1',[battleId])).rows[0];
      assert.deepEqual([digests.digest_a,digests.digest_b],workload.report.finalDigests);
      checks.push('Full recorded original-C match has identical final digests and result across independent HTTP invocations');
    }else{
      const forfeit={...request(0),action:'forfeit' as const};const finished=await acceptResponse(0,await raw(0,`/${battleId}/step`,forfeit));assert.deepEqual(finished.metadata.result,{winner:'b',reason:'forfeit'});
      checks.push('Original-C intro advances through bounded HTTP input batches and commits an atomic forfeit');
    }
    const final=await acceptResponse(1,await raw(1,`/${battleId}/step`,request(1)));assert(final.metadata.result);
    const afterFinish=await raw(0,`/${battleId}/step`,lost);await okay(afterFinish);assert.deepEqual(new Uint8Array(await afterFinish.arrayBuffer()),discarded);
    assert.deepEqual((await game.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
    const sessions=(await game.pool.query("select status from private.game_sessions where owner_id in ($1,$2) and status<>'closed'",[a.id,b.id])).rows;assert.equal(sessions.length,2);assert(sessions.every(row=>row.status==='lobby'));
    // The ordinary implementation reads real database time. No clock fixture
    // participates in this independent second challenge and input round trip.
    service=new RequestBattles(game,registry);handler=requestBattleHttp(service,authenticate,base);
    const realtime=await(await okay(await raw(0,'',{trainerId:b.id}))).json();await okay(await raw(1,`/${realtime.id}/accept`,{}));await openBattle(realtime.id);
    const realClockStart=BigInt((await game.pool.query('select clock_us from private.battle_request_runs where battle_id=$1',[realtime.id])).rows[0].clock_us);
    for(const side of [0,1])await okay(await raw(side,`/${realtime.id}/step`,{protocol:1,action:'step',controller:controller(side,realtime.id),operationId:randomUUID(),sequence:0,runs:[{buttons:0,frames:15}]}));
    await new Promise(done=>setTimeout(done,40));
    const ordinary=decodeBattleResponse(new Uint8Array(await(await okay(await raw(0,`/${realtime.id}/step`,{protocol:1,action:'step',controller:controller(0,realtime.id),operationId:randomUUID(),sequence:1,runs:[]}))).arrayBuffer()));
    assert(ordinary.metadata.frame>0);
    const realClock=(await game.pool.query('select q.clock_us,r.frame from private.battle_request_runs q join private.battle_runs r using(battle_id) where q.battle_id=$1',[realtime.id])).rows[0];
    assert(BigInt(realClock.frame)*280896n*1000000n<=(BigInt(realClock.clock_us)-realClockStart)*16777216n);
    const realForfeit=decodeBattleResponse(new Uint8Array(await(await okay(await raw(0,`/${realtime.id}/step`,{protocol:1,action:'forfeit',controller:controller(0,realtime.id),operationId:randomUUID(),sequence:2,runs:[]}))).arrayBuffer()));
    assert.deepEqual(realForfeit.metadata.result,{winner:'b',reason:'forfeit'});
    checks.push('A separate battle uses the production database clock, advances admitted original-C frames and returns to the lobby');
    service=new RequestBattles(game,registry,{clock:async()=>now});handler=requestBattleHttp(service,authenticate,base);
    const fairBattle=await(await okay(await raw(0,'',{trainerId:b.id}))).json();await okay(await raw(1,`/${fairBattle.id}/accept`,{}));await openBattle(fairBattle.id);
    await okay(await raw(1,`/${fairBattle.id}/step`,{protocol:1,action:'step',controller:controller(1,fairBattle.id),operationId:randomUUID(),sequence:0,runs:[]}));
    now+=251143n;
    const independent=decodeBattleResponse(new Uint8Array(await(await okay(await raw(0,`/${fairBattle.id}/step`,{protocol:1,action:'step',controller:controller(0,fairBattle.id),operationId:randomUUID(),sequence:0,runs:[{buttons:1,frames:1},{buttons:0,frames:14}]}))).arrayBuffer()));
    assert(independent.metadata.frame>0,'A polling peer withholding inputs must not freeze the other console');
    const fairSeed=Number((await game.pool.query('select seed from private.battles where id=$1',[fairBattle.id])).rows[0].seed);
    const fairReference=await OriginalBattlePair.create(workload.artifacts.map(artifact=>({...artifact,seed:fairSeed})) as typeof workload.artifacts,workload.saves);
    try{
      for(let index=0;index<independent.metadata.frame;index++)fairReference.tick([index===0?1:0,0]);
      const fairDigests=(await game.pool.query('select digest_a,digest_b from private.battle_input_journal where battle_id=$1 order by sequence desc limit 1',[fairBattle.id])).rows[0];
      assert.deepEqual([fairDigests.digest_a,fairDigests.digest_b],fairReference.digests());
    }finally{fairReference.close();}
    await okay(await raw(0,`/${fairBattle.id}/step`,{protocol:1,action:'forfeit',controller:controller(0,fairBattle.id),operationId:randomUUID(),sequence:1,runs:[]}));
    checks.push('One-frame taps advance without a peer input queue; missing controls are neutral rather than a way to stall a decision');
    const tabs=await(await okay(await raw(0,'',{trainerId:b.id}))).json();await okay(await raw(1,`/${tabs.id}/accept`,{}));await openBattle(tabs.id);
    const firstController=controller(0,tabs.id),peerController=controller(1,tabs.id);
    const firstTab:RequestBattleInput={protocol:1,action:'step',controller:firstController,operationId:randomUUID(),sequence:0,runs:[{buttons:1,frames:15}]};
    await okay(await raw(0,`/${tabs.id}/step`,firstTab));
    await okay(await raw(1,`/${tabs.id}/step`,{...firstTab,controller:peerController,operationId:randomUUID(),runs:[{buttons:2,frames:15}]}));
    const speculative=await service.store.claim(a.id,tabs.id,{...firstTab,operationId:randomUUID(),sequence:1,runs:[]});assert('claim'in speculative);
    const newId=randomUUID(),secondTab=await(await okay(await raw(0,`/${tabs.id}/open`,{connectionId:newId,expectedEpoch:firstController.epoch}))).json();
    assert.equal(secondTab.controller.epoch,firstController.epoch+1);assert.equal(secondTab.nextSequence,1);assert.equal(secondTab.inputThrough,0);
    const queued=(await game.pool.query('select side,buttons from private.battle_request_inputs where battle_id=$1',[tabs.id])).rows;
    assert.deepEqual(queued,[{side:'b',buttons:2}]);
    await assert.rejects(service.store.commit(speculative.claim,{frame:0,caches:[speculative.claim.state.screen_a,speculative.claim.state.screen_b],decision:speculative.claim.decision,
      entries:[],buttons:[0,0],clock:speculative.claim.clock,result:null,response:Buffer.from('obsolete tab must not commit')}),{code:'BATTLE_REQUEST_CHANGED'});
    const afterOpen=(await game.pool.query('select revision,clock_us,credit from private.battle_request_runs where battle_id=$1',[tabs.id])).rows[0];
    const sameTab=await(await okay(await raw(0,`/${tabs.id}/open`,{connectionId:newId,expectedEpoch:firstController.epoch}))).json();assert.deepEqual(sameTab.controller,secondTab.controller);
    assert.deepEqual((await game.pool.query('select revision,clock_us,credit from private.battle_request_runs where battle_id=$1',[tabs.id])).rows[0],afterOpen);
    for(const body of [firstTab,{...firstTab,sequence:1,operationId:randomUUID(),action:'forfeit',runs:[]}]){
      const stale=await okay(await raw(0,`/${tabs.id}/step`,body),409);assert.equal((await stale.json()).error,'BATTLE_CONTROL_REPLACED');
    }
    const delayed=await okay(await raw(0,`/${tabs.id}/open`,{connectionId:randomUUID(),expectedEpoch:firstController.epoch}),409);assert.equal((await delayed.json()).error,'BATTLE_CONTROL_CHANGED');
    const reopen=await okay(await raw(0,`/${tabs.id}/open`,{connectionId:firstController.connectionId,expectedEpoch:0}),409);assert.equal((await reopen.json()).error,'BATTLE_CONTROL_REPLACED');
    await okay(await raw(2,`/${tabs.id}/open`,{connectionId:randomUUID(),expectedEpoch:0}),404);
    await okay(await raw(1,`/${tabs.id}/step`,{...firstTab,controller:secondTab.controller,sequence:1,operationId:randomUUID(),runs:[]}),409);
    await okay(await raw(0,`/${tabs.id}/step`,{...firstTab,controller:secondTab.controller,action:'forfeit',sequence:1,operationId:randomUUID(),runs:[]}));
    await assert.rejects(game.pool.query('delete from private.battle_control_connections'),{code:'42501'});
    await assert.rejects(game.pool.query('update private.battle_control_connections set epoch=99'),{code:'42501'});
    checks.push('Explicit tab replacement fences in-flight computation, clears only personal queued controls, preserves clock and peer inputs, rejects old steps/receipts/forfeits/open retries, and keeps current open retries idempotent');
    const contention=await(await okay(await raw(0,'',{trainerId:b.id}))).json();await okay(await raw(1,`/${contention.id}/accept`,{}));await openBattle(contention.id);
    const contentionBody=(side:number,sequence:number):RequestBattleInput=>({protocol:1,action:'step',operationId:randomUUID(),controller:controller(side,contention.id),sequence,runs:[]});
    const acceptedBeforeWait=contentionBody(0,0),acceptedBeforeWaitBytes=new Uint8Array(await(await okay(await raw(0,`/${contention.id}/step`,acceptedBeforeWait))).arrayBuffer());
    const activeBody=contentionBody(0,1),waitingBody=contentionBody(1,0),active=await service.store.claim(a.id,contention.id,activeBody);assert('claim'in active);
    const durableBefore=(await game.pool.query('select revision,clock_us,credit,input_through_a,input_through_b from private.battle_request_runs where battle_id=$1',[contention.id])).rows[0];
    // Trusted-clock fixture: repeated authenticated retries are live presence,
    // even though none can acknowledge controls while the writer is held.
    for(const elapsed of [30_000_000n,29_000_000n]){
      now+=elapsed;
      assert.deepEqual(new Uint8Array(await(await okay(await raw(0,`/${contention.id}/step`,acceptedBeforeWait))).arrayBuffer()),acceptedBeforeWaitBytes);
      await okay(await raw(1,`/${contention.id}/step`,waitingBody),409);
    }
    assert.deepEqual((await game.pool.query('select revision,clock_us,credit,input_through_a,input_through_b from private.battle_request_runs where battle_id=$1',[contention.id])).rows[0],durableBefore);
    await service.store.release(active.claim);now+=1_000_000n;
    await okay(await raw(0,`/${contention.id}/step`,activeBody),409);
    const admittedPeer=decodeBattleResponse(new Uint8Array(await(await okay(await raw(1,`/${contention.id}/step`,waitingBody))).arrayBuffer()));
    assert.equal(admittedPeer.metadata.result,null,'A trainer actively retrying must not lose by disconnect');
    const repeated=contentionBody(1,1);await okay(await raw(1,`/${contention.id}/step`,repeated),409);
    now+=3_000_000n;
    const afterPreference=decodeBattleResponse(new Uint8Array(await(await okay(await raw(1,`/${contention.id}/step`,repeated))).arrayBuffer()));
    assert(afterPreference.metadata.frame>admittedPeer.metadata.frame,'An abandoned preference must expire without freezing the clock');
    await okay(await raw(0,`/${contention.id}/step`,{...activeBody,action:'forfeit'}));
    checks.push('A waiting peer gets the next writer turn; busy retries and latest-receipt replays preserve live presence without acknowledging input or clock credit; abandoned priority expires and forfeits remain available');
    const timeoutBattle=await(await okay(await raw(0,'',{trainerId:b.id}))).json();await okay(await raw(1,`/${timeoutBattle.id}/accept`,{}));await openBattle(timeoutBattle.id);
    const timeoutRetry:RequestBattleInput={protocol:1,controller:controller(1,timeoutBattle.id),operationId:randomUUID(),action:'step',sequence:0,runs:[]};
    const beforeAbsence=new Uint8Array(await(await okay(await raw(1,`/${timeoutBattle.id}/step`,timeoutRetry))).arrayBuffer());
    const absentSeen=(await game.pool.query('select seen_us_b from private.battle_request_runs where battle_id=$1',[timeoutBattle.id])).rows[0].seen_us_b;
    for(const [sequence,elapsed] of [[0,30_000_000n],[1,31_000_000n]] as const){
      now+=elapsed;
      if(sequence===1){
        assert.deepEqual(new Uint8Array(await(await okay(await raw(1,`/${timeoutBattle.id}/step`,timeoutRetry))).arrayBuffer()),beforeAbsence);
        assert.equal((await game.pool.query('select seen_us_b from private.battle_request_runs where battle_id=$1',[timeoutBattle.id])).rows[0].seen_us_b,absentSeen);
      }
      const response=decodeBattleResponse(new Uint8Array(await(await okay(await raw(0,`/${timeoutBattle.id}/step`,{protocol:1,action:'step',controller:controller(0,timeoutBattle.id),operationId:randomUUID(),sequence,runs:[]}))).arrayBuffer()));
      if(sequence===1)assert.deepEqual(response.metadata.result,{winner:'a',reason:'disconnect'});
    }
    checks.push('A missing opponent times out from durable server heartbeat time; replaying a receipt after the absence deadline cannot revive expired presence');
    const browserValidation=process.env.KANTO_CHECK_REQUEST_BATTLE_BROWSER==='1'
      ?await checkRequestBattleBrowser(game,new RequestBattles(game,registry),authenticate,[a,b],output):null;
    assert.deepEqual((await game.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
    const sorted=advancingHttpMs.slice().sort((a,b)=>a-b),httpTiming={samples:sorted.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};
    await writeFile(reportPath,JSON.stringify({checkedAt:new Date().toISOString(),sourceSha256,checks,actualHttp:true,actualBetterAuth:true,
      independentRestrictedPostgresTransactions:true,realOriginalC:true,recordedCartridgeFixtures:true,trustedClockFixture:true,
      fullRecordedMatch:full,frames:frame,requests,workerFailureRecovered,commitFailureRollback:true,databaseStatementTimeoutRollback:true,
      advancingHttp: httpTiming,realDatabaseClockSmoke:true,disconnectTimeout:true,browserValidation,
      independentReferenceScreens:true,peerCannotStallWithMissingInputs:true,oneFrameTapReferenceParity:true,explicitTabOwnership:true,oldTabCannotReclaimOnRetry:true,tabReplacementFencesSpeculativeWork:true,
      fairWriterHandoff:true,busyRetryPresenceWithoutClockCredit:true,abandonedPriorityExpires:true,expiredPresenceCannotBeRevived:true,privateScreenResponsesOnly:true,exactReplyLossRecovery:true,
      canonicalCartridgesUnchanged:true,atomicResultReceiptAndLobbyReturn:true,externalEmailsSent:0,hosted:false,publicReleaseQualified:false},null,2)+'\n');
  }catch(error){await writeFile(output+'/request-battles-http-failure.json',JSON.stringify({error:String(error),checks,frame,requests,counters,through,sourceSha256},null,2)+'\n');throw error;}
  finally{await owner.query('update kanto_auth."user" set "emailVerified"=true where id=$1',[c.id]);server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await accountPool.end();}
}
