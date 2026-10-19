import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import type {Database} from '../apps/server/src/database.ts';
import {Sessions,type SessionOptions} from '../apps/server/src/sessions.ts';
import type {EngineRegistry} from '../packages/engine/registry.ts';

/** Real PostgreSQL and a one-slot private pool. The arithmetic engine checks
 * persistence/lifecycle behavior; original-C compatibility is separate. */
export async function checkAdventureDisconnect(database:Database,registry:EngineRegistry,options:SessionOptions,owners:[string,string]){
  const tag=process.env.KANTO_RELEASE_EVIDENCE_TAG;
  if(tag)assert(/^[a-z0-9-]{1,40}$/.test(tag));
  const reportPath=tag?`build/${tag}-disconnect.json`:undefined;
  if(reportPath)assert(!existsSync(reportPath),'Preserve retained worker-release evidence.');
  let clock=0,holdNext=false,failNext=false,reached!:()=>void,unblock!:()=>void;
  let gate:Promise<void>;
  const scoped=Object.assign(Object.create(Object.getPrototypeOf(database)),{
    transaction:database.transaction.bind(database),
    pool:{query:async(...args:Parameters<Database['pool']['query']>)=>{
      const sql=String(args[0]);
      if(sql.startsWith('update private.game_sessions set checkpoint=')){
        if(holdNext){holdNext=false;reached();await gate;}
        if(failNext){failNext=false;throw new Error('injected checkpoint write failure');}
      }
      return Reflect.apply(database.pool.query,database.pool,args);
    }},
  }) as Database;
  const limited=new Sessions(scoped,registry,{...options,pool:1,clock:()=>clock});
  const peer=new Sessions(database,registry,{...options,pool:1,clock:()=>clock});
  await database.pool.query('savepoint adventure_disconnect_contract');
  try{
    const canonical=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
    const first=await limited.start(owners[0],'firered'),fence=limited.connectionFence(owners[0],first.id);
    limited.resume(owners[0],first.id,fence);clock+=100;
    const ack=await limited.accept(owners[0],first.id,{type:'input',protocol:1,sessionId:first.id,
      sequence:first.nextSequence,startFrame:first.frame,operationId:randomUUID(),runs:[{buttons:0,frames:5}]},fence);
    await assert.rejects(limited.start(owners[1],'firered'),{code:'ADVENTURE_CAPACITY'});
    await limited.disconnect(owners[0],first.id,fence);
    assert.throws(()=>limited.connectionFence(owners[0],first.id),{code:'SESSION_NOT_FOUND'});
    const stored=async(id:string)=>(await database.pool.query(`select frame,next_sequence,fence,checkpoint_frame,checkpoint_sequence,
      lease_expires_at,lease_expires_at<=clock_timestamp() as expired from private.game_sessions where id=$1`,[id])).rows[0];
    const released=await stored(first.id);
    assert.equal(Number(released.fence),fence+1);assert.equal(released.expired,true);
    assert.equal(Number(released.frame),ack.frame);assert.equal(released.frame,released.checkpoint_frame);
    assert.equal(released.next_sequence,released.checkpoint_sequence);
    await limited.disconnect(owners[0],first.id,fence);assert.deepEqual(await stored(first.id),released);
    const other=await limited.start(owners[1],'firered');
    const recovered=await peer.start(owners[0],'firered');
    assert.equal(recovered.id,first.id);assert.equal(recovered.digest,ack.digest);
    assert.equal(recovered.frame,ack.frame);assert.equal(recovered.nextSequence,first.nextSequence+1);
    const current=await stored(first.id);
    await limited.disconnect(owners[0],first.id,fence);assert.deepEqual(await stored(first.id),current);
    await peer.disconnect(owners[0],first.id,peer.connectionFence(owners[0],first.id));
    await limited.disconnect(owners[1],other.id,limited.connectionFence(owners[1],other.id));

    // Pause requests can already have captured a checkpoint before the socket
    // disappears. Hold its SQL write until retirement and reacquisition finish.
    const racing=await limited.start(owners[0],'firered'),oldFence=limited.connectionFence(owners[0],racing.id);
    const waiting=new Promise<void>(resolve=>{reached=resolve;});gate=new Promise(resolve=>{unblock=resolve;});holdNext=true;
    const oldWrite=limited.checkpoint(owners[0],racing.id,oldFence);
    const refusedOldWrite=assert.rejects(oldWrite,{code:'SESSION_LEASE_LOST'});
    await waiting;
    await limited.disconnect(owners[0],racing.id,oldFence);
    const restored=await peer.start(owners[0],'firered'),protectedRow=await stored(restored.id);
    unblock();await refusedOldWrite;assert.deepEqual(await stored(restored.id),protectedRow);
    await peer.disconnect(owners[0],restored.id,peer.connectionFence(owners[0],restored.id));
    const sameInstance=await limited.start(owners[0],'firered');
    const sameInstanceFence=limited.connectionFence(owners[0],sameInstance.id),sameInstanceRow=await stored(sameInstance.id);
    await limited.disconnect(owners[0],sameInstance.id,oldFence);
    assert.equal(limited.connectionFence(owners[0],sameInstance.id),sameInstanceFence);
    assert.deepEqual(await stored(sameInstance.id),sameInstanceRow);
    await limited.disconnect(owners[0],sameInstance.id,sameInstanceFence);

    // A checkpoint failure still retires the worker. Durable acknowledgements
    // remain recoverable from the preceding checkpoint and journal.
    const failing=await limited.start(owners[0],'firered'),failureFence=limited.connectionFence(owners[0],failing.id);
    failNext=true;
    await assert.rejects(limited.disconnect(owners[0],failing.id,failureFence),/injected checkpoint write failure/);
    const admitted=await limited.start(owners[1],'firered');
    const afterFailure=await peer.start(owners[0],'firered');assert.equal(afterFailure.digest,failing.digest);
    await limited.disconnect(owners[1],admitted.id,limited.connectionFence(owners[1],admitted.id));
    await peer.disconnect(owners[0],afterFailure.id,peer.connectionFence(owners[0],afterFailure.id));

    // A same-owner reconnect waits for retirement. A server shutdown denies a
    // start already queued behind that retirement instead of leaking a worker.
    const ending=await limited.start(owners[0],'firered'),endingFence=limited.connectionFence(owners[0],ending.id);
    const original=limited.checkpoint.bind(limited);
    const reachedEnd=new Promise<void>(resolve=>{reached=resolve;});gate=new Promise(resolve=>{unblock=resolve;});
    limited.checkpoint=async(...args)=>{const point=await original(...args);reached();await gate;return point;};
    const dropping=limited.disconnect(owners[0],ending.id,endingFence);await reachedEnd;
    const queued=limited.start(owners[0],'firered');
    const denied=assert.rejects(queued,{code:'SERVER_RESTARTING'});
    const closing=limited.close();unblock();await dropping;await denied;await closing;
    assert.equal((await stored(ending.id)).expired,true);
    assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
    const result={realPostgres:true,arithmeticFixture:true,oneSlotPool:true,capacityFullBeforeDisconnect:true,
      differentPlayerAdmittedAfterDisconnect:true,immediateOtherServiceRecovery:true,acknowledgedDigestPreserved:true,
      duplicateAndStaleDisconnectHarmless:true,lateCheckpointCannotRenewOrOverwriteReplacement:true,
      staleDisconnectCannotRetireSameInstanceReplacement:true,
      checkpointFailureStillReleasesWorker:true,queuedStartDeniedDuringShutdown:true,canonicalSavesUnchanged:true,
      publicReleaseQualified:false,capacity1000Qualified:false};
    if(reportPath)await writeFile(reportPath,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({adventureDisconnect:true,oneSlotReclaimed:true,lateCheckpointFenced:true}));
  }finally{
    unblock?.();await limited.close();await peer.close();
    await database.pool.query('rollback to savepoint adventure_disconnect_contract');
    await database.pool.query('release savepoint adventure_disconnect_contract');
  }
}
