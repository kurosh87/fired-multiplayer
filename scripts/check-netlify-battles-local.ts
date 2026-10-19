import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {writeFile} from 'node:fs/promises';
import type pg from 'pg';
import type {Database} from '../apps/server/src/database.ts';
import {createNetlifyBattles} from '../apps/server/src/netlify-battles.ts';
import {buildNetlifyBattleRuntime} from './build-netlify-battle-runtime.ts';
import {seedBattleLobby} from '../tests/battle-ui-qualification.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';
import {decodeBattleResponse} from '../packages/battles/request-protocol.ts';
import {EngineRegistry} from '../packages/engine/registry.ts';
import {PRIVATE_BATTLE_PINS} from '../packages/battles/private-artifacts.ts';
import {BattleConsolePool} from '../packages/battles/console-pool.ts';
import {pathToFileURL} from 'node:url';
import {battleWorkload} from './battle-workload.ts';
import {OriginalBattlePair} from '../packages/battles/original-pair.ts';

/** Real SDK identities, transaction-local game role and the compiled worker
 * used by the Function. Local fixture seeding stays outside deployed code. */
export async function checkNetlifyBattlesLocal(game:Database,owner:pg.Client,accountUrl:string,origin:string,secret:string,
  accounts:[{id:string;token:string},{id:string;token:string}],saves:[string,string],output:string){
  const directory=output+'/battle-runtime',hashes=await buildNetlifyBattleRuntime(directory);
  const registry=new EngineRegistry();await registry.loadPrivateBattle(directory,PRIVATE_BATTLE_PINS);
  assert(registry.status().every(item=>item.available));
  assert(registry.status().every(item=>item.manifest?.capabilities.battle===false));
  const wrong=new EngineRegistry();await wrong.loadPrivateBattle(directory,{...PRIVATE_BATTLE_PINS,
    firered:{...PRIVATE_BATTLE_PINS.firered,wasmSha256:'0'.repeat(64)}});
  assert.equal(wrong.status().find(item=>item.version==='firered')!.available,false);
  const ordinary=new EngineRegistry();await ordinary.load(directory,true,'battle');assert(ordinary.status().every(item=>!item.available));
  const workload=await battleWorkload(),pool=new BattleConsolePool(1,{url:pathToFileURL(directory+'/battle-worker.mjs'),transport:'thread'});
  const reference=await OriginalBattlePair.create(workload.artifacts,workload.saves);
  try{
    const firstScope=pool.scope();let pair=await firstScope.create(workload.artifacts,workload.saves);
    for(const buttons of workload.inputs.slice(0,31)){
      reference.tick(buttons);await pair.advance(buttons,1);
    }
    assert.deepEqual((await pair.progress()).digests,reference.digests());
    const points=await pair.checkpoint();await firstScope.close();
    assert.throws(()=>pair.frame,{code:'BATTLE_WORKER_LOST'});
    const cleanScope=pool.scope(),fresh=await cleanScope.create(workload.artifacts,workload.saves);
    assert.equal(fresh.frame,0);await cleanScope.close();
    const secondScope=pool.scope();pair=await secondScope.restore(workload.artifacts,reference.frame,points);
    // A delayed watchdog from a released request cannot kill the new owner.
    await firstScope.abort();
    assert.deepEqual((await pair.progress()).digests,reference.digests());
    for(const [index,screen] of (await pair.screens(['a','b'])).entries())
      assert.deepEqual(screen,reference.screen(index===0?'a':'b'));
    assert((await pair.metrics()).environmentKeys.every(key=>key==='NODE_OPTIONS'));
    let started!:()=>void;const running=new Promise<void>(done=>{started=done;});
    const pending=pair.advance([0,0],60,started),rejected=assert.rejects(pending,{code:'BATTLE_WORKER_LOST'});
    await running;await secondScope.abort();await rejected;
    const recovered=pool.scope(),restored=await recovered.restore(workload.artifacts,reference.frame,points);
    assert.deepEqual((await restored.progress()).digests,reference.digests());await recovered.close();
  }finally{reference.close();await pool.close();}
  await seedBattleLobby(game,accounts.map(a=>a.id) as [string,string],saves,await originalGameProvider());
  const before=(await owner.query('select id,revision,flash from private.adventures order by id')).rows;
  const login='kanto_function_check_'+Date.now(),url=new URL(accountUrl);url.username=login;url.password='';
  await owner.query(`create role "${login}" login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  for(const role of ['kanto_game_runtime','kanto_netlify_runtime']){
    await owner.query(`grant ${role} to "${login}" with inherit false`);
    await owner.query(`grant ${role} to "${login}" with set true`);
  }
  let service=createNetlifyBattles(url.href,secret,directory);
  const call=(side:number,path:string,body?:unknown,token=accounts[side]!.token)=>service.fetch(new Request(origin+'/api/online/battles'+path,{
    method:body===undefined?'GET':'POST',headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }),origin);
  const okay=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response;};
  try{
    await okay(await call(0,'',undefined,'invalid'),401);
    const battle=await (await okay(await call(0,'',{trainerId:accounts[1].id}))).json();
    await okay(await call(1,`/${battle.id}/accept`,{}));
    const controllers=[];
    for(const side of [0,1])controllers.push((await(await okay(await call(side,`/${battle.id}/open`,{connectionId:randomUUID(),expectedEpoch:0}))).json()).controller);
    // An immediately repeated local request may precede even one GBA tick.
    // Let real database time accrue; never manufacture startup frame credit.
    await new Promise(done=>setTimeout(done,40));
    const input={protocol:1,action:'step',operationId:randomUUID(),sequence:0,controller:controllers[0],runs:[{buttons:0,frames:15}]};
    const response=await okay(await call(0,`/${battle.id}/step`,input));
    // Calling the handler directly returns its compressed bytes; fetch would
    // decompress these automatically on a real HTTP connection.
    const bytes=Buffer.from(await response.arrayBuffer()),decoded=decodeBattleResponse(gunzipSync(bytes));
    assert(decoded.metadata.frame>0);assert.equal(decoded.metadata.nextSequence,1);
    await service.close();service=createNetlifyBattles(url.href,secret,directory);
    const replay=Buffer.from(await(await okay(await call(0,`/${battle.id}/step`,input))).arrayBuffer());
    assert.deepEqual(replay,bytes);
    const terminal={...input,action:'forfeit',operationId:randomUUID(),sequence:1,runs:[]};
    const done=decodeBattleResponse(gunzipSync(Buffer.from(await(await okay(await call(0,`/${battle.id}/step`,terminal))).arrayBuffer())));
    assert(done.metadata.result);assert.equal((await(await okay(await call(0,`/${battle.id}`))).json()).battle.status,'finished');
    assert.deepEqual((await owner.query('select id,revision,flash from private.adventures order by id')).rows,before);
    const report={actualSdkAccounts:true,actualOriginalC:true,compiledWorkerParity:true,compiledWorkerCheckpointRestore:true,
      workerEnvironmentRestricted:true,hashPinMismatchDenied:true,publicCapabilityGatesPreserved:true,transactionLocalGameRole:true,
      requestScopesClearPlayerState:true,releasedScopeCannotTerminateLaterRequest:true,scopeAbortRecoversCold:true,
      separateAccountPool:true,serviceRecreatedExactReply:true,atomicForfeit:true,canonicalCartridgesUnchanged:true,
      runtimeHashes:hashes,responseSha256:createHash('sha256').update(bytes).digest('hex'),hosted:false};
    await writeFile(output+'/netlify-battles-local-report.json',JSON.stringify(report,null,2)+'\n');return report;
  }finally{await service.close();await owner.query(`alter role "${login}" nologin`);}
}
