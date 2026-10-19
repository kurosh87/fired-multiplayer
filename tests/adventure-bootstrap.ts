import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {Database} from '../apps/server/src/database.ts';
import {Sessions,ADVENTURE_BOOTSTRAP_TIMEOUT_MS,type SessionOptions} from '../apps/server/src/sessions.ts';
import type {EngineRegistry} from '../packages/engine/registry.ts';
import {createApp} from '../apps/server/src/app.ts';

/** Real database/pools, controlled connection clock and arithmetic engine.
 * The API's five-second reaper interval runs on the real event loop. */
export async function checkAdventureBootstrap(database:Database,registry:EngineRegistry,options:SessionOptions,owners:[string,string]){
  const tag=process.env.KANTO_RELEASE_EVIDENCE_TAG;
  if(tag)assert(/^[a-z0-9-]{1,40}$/.test(tag));
  const path=tag?`build/${tag}-bootstrap.json`:undefined;
  if(path)assert(!existsSync(path),'Preserve retained bootstrap evidence.');
  let connectionTime=0,unblock:(()=>void)|undefined;
  const settings={...options,pool:1,clock:()=>0,connectionClock:()=>connectionTime};
  const limited=new Sessions(database,registry,settings),peer=new Sessions(database,registry,settings);
  const row=async(id:string)=>(await database.pool.query(`select frame,next_sequence,fence,checkpoint_frame,
    checkpoint_sequence,lease_expires_at<=clock_timestamp() as expired from private.game_sessions where id=$1`,[id])).rows[0];
  await database.pool.query('savepoint bootstrap_cleanup_contract');
  try{
    const canonical=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
    const first=await limited.start(owners[0],'firered'),fence=limited.connectionFence(owners[0],first.id);
    await assert.rejects(limited.start(owners[1],'firered'),{code:'ADVENTURE_CAPACITY'});
    connectionTime=ADVENTURE_BOOTSTRAP_TIMEOUT_MS-1;await limited.expireUnattached();
    assert.equal(limited.connectionFence(owners[0],first.id),fence);
    connectionTime++;await limited.expireUnattached();
    assert.throws(()=>limited.connectionFence(owners[0],first.id),{code:'SESSION_NOT_FOUND'});
    const released=await row(first.id);assert.equal(Number(released.fence),fence+1);assert(released.expired);
    assert.equal(released.frame,released.checkpoint_frame);assert.equal(released.next_sequence,released.checkpoint_sequence);
    const admitted=await limited.start(owners[1],'firered');
    const recovered=await peer.start(owners[0],'firered');
    assert.equal(recovered.id,first.id);assert.equal(recovered.digest,first.digest);assert.equal(recovered.frame,first.frame);
    assert.equal(recovered.nextSequence,first.nextSequence);assert(recovered.nextSequence>0,'Use a previously played fixture to check clock credit.');
    peer.resume(owners[0],recovered.id);connectionTime+=ADVENTURE_BOOTSTRAP_TIMEOUT_MS*5;
    await peer.expireUnattached();
    await assert.rejects(peer.accept(owners[0],recovered.id,{type:'input',protocol:1,sessionId:recovered.id,
      sequence:recovered.nextSequence,startFrame:recovered.frame,operationId:randomUUID(),runs:[{buttons:0,frames:1}]}),{code:'INPUT_TOO_FAST'});
    limited.resume(owners[1],admitted.id);await limited.pause(owners[1],admitted.id);
    const paused=await row(admitted.id);await limited.expireUnattached();assert.deepEqual(await row(admitted.id),paused);
    assert.equal(limited.connectionFence(owners[1],admitted.id),Number(paused.fence));
    await limited.disconnect(owners[1],admitted.id,Number(paused.fence));
    await peer.disconnect(owners[0],recovered.id,peer.connectionFence(owners[0],recovered.id));

    // A connection arriving exactly as cleanup queues takes priority when the
    // candidate is rechecked inside its owner lock.
    const arriving=await limited.start(owners[0],'firered'),arrivingFence=limited.connectionFence(owners[0],arriving.id);
    connectionTime+=ADVENTURE_BOOTSTRAP_TIMEOUT_MS;
    const sweep=limited.expireUnattached();limited.resume(owners[0],arriving.id,arrivingFence);await sweep;
    assert.equal(limited.connectionFence(owners[0],arriving.id),arrivingFence);
    await limited.disconnect(owners[0],arriving.id,arrivingFence);

    // A sweep queued behind rebootstrap must not retire the fresh replacement.
    const old=await limited.start(owners[0],'firered');connectionTime+=ADVENTURE_BOOTSTRAP_TIMEOUT_MS;
    const checkpoint=limited.checkpoint.bind(limited);let reached!:()=>void;
    const waiting=new Promise<void>(resolve=>{reached=resolve;}),gate=new Promise<void>(resolve=>{unblock=resolve;});
    limited.checkpoint=async(...args)=>{const point=await checkpoint(...args);reached();await gate;return point;};
    const replacing=limited.start(owners[0],'firered');await waiting;
    const staleSweep=limited.expireUnattached();unblock!();const replacement=await replacing;await staleSweep;
    limited.checkpoint=checkpoint;assert.equal(replacement.id,old.id);
    assert.equal(replacement.digest,old.digest);const replacementFence=limited.connectionFence(owners[0],replacement.id);
    await limited.disconnect(owners[0],replacement.id,replacementFence);

    // Production API wiring: no play socket opens. Advance only its injected
    // connection clock, then wait for the actual five-second interval.
    const provider=createServer((request,response)=>{
      const owner=request.headers.authorization==='Bearer bootstrap-alice'?owners[0]
        :request.headers.authorization==='Bearer bootstrap-bob'?owners[1]:undefined;
      response.setHeader('Content-Type','application/json');
      if(request.url!=='/auth/v1/user'||!owner){response.writeHead(401);response.end('{}');return;}
      response.end(JSON.stringify({id:owner,aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',
        app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
    });
    await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
    const app=await createApp({origin:'http://kanto-bootstrap.invalid',engineDirectory:'unused-bootstrap-fixture',
      supabaseUrl:`http://127.0.0.1:${address.port}`,publishableKey:'bootstrap-fixture-only',publicRelease:false},
    {database,registry,sessionOptions:settings});
    let cleanupElapsedMs=0;
    try{
      await app.listen({host:'127.0.0.1',port:0});
      const started=await app.inject({method:'POST',url:'/api/sessions',headers:{authorization:'Bearer bootstrap-alice'},payload:{version:'firered'}});
      assert.equal(started.statusCode,200,started.body);const bootstrap=started.json(),before=await row(bootstrap.id);
      const busy=await app.inject({method:'POST',url:'/api/sessions',headers:{authorization:'Bearer bootstrap-bob'},payload:{version:'firered'}});
      assert.equal(busy.statusCode,503);assert.equal(busy.json().error,'ADVENTURE_CAPACITY');
      connectionTime+=ADVENTURE_BOOTSTRAP_TIMEOUT_MS;const began=Date.now();
      while(!(await row(bootstrap.id)).expired){
        assert(Date.now()-began<10_000,'The actual API bootstrap reaper did not run.');await new Promise(resolve=>setTimeout(resolve,50));
      }
      cleanupElapsedMs=Date.now()-began;assert.equal(Number((await row(bootstrap.id)).fence),Number(before.fence)+1);
      const next=await app.inject({method:'POST',url:'/api/sessions',headers:{authorization:'Bearer bootstrap-bob'},payload:{version:'firered'}});
      assert.equal(next.statusCode,200,next.body);
    }finally{await app.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
    assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
    const result={realPostgres:true,arithmeticFixture:true,oneSlotPool:true,deadlineBoundaryChecked:true,
      expiredBootstrapFencedAndCheckpointed:true,newPlayerAdmitted:true,immediateOtherServiceRecovery:true,
      digestFrameAndSequencePreserved:true,connectionClockCannotMintGameFrames:true,healthyPausedConnectionKept:true,
      arrivingConnectionWinsCleanupRace:true,staleSweepCannotRetireReplacement:true,
      actualApiIntervalReclaimedUnconnectedBootstrap:true,apiCleanupElapsedAfterControlledDeadlineMs:cleanupElapsedMs,
      realAuthGetUserFixture:true,canonicalSavesUnchanged:true,hostedAccountsQualified:false,capacity1000Qualified:false};
    if(path)await writeFile(path,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({bootstrapCleanup:true,actualApiInterval:true,oneSlotReclaimed:true}));
  }finally{
    unblock?.();await limited.close();await peer.close();
    await database.pool.query('rollback to savepoint bootstrap_cleanup_contract');
    await database.pool.query('release savepoint bootstrap_cleanup_contract');
  }
}
