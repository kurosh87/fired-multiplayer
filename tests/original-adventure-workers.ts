import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {WasmEngine} from '../packages/engine/runtime.ts';
import {AdventurePool,type AdventureEngine} from '../packages/engine/adventure-pool.ts';
import {FRAME_MILLISECONDS,type InputRun} from '../packages/protocol/index.ts';
import {prepareLobbySave} from '../packages/trading/prepare-lobby.ts';
import {Sessions} from '../apps/server/src/sessions.ts';
import type {Database} from '../apps/server/src/database.ts';
import {originalGameProvider,originalGameDirectory} from './original-game-provider.ts';

/** Real original-C routes + real Postgres. The clock and fixed initial seed
 * are trusted test drivers; neither is accepted from the browser API. */
export async function checkOriginalAdventureWorkers(database:Database,owner:string):Promise<void>{
  const tag=process.env.KANTO_WORKER_EVIDENCE_TAG;if(tag)assert(/^[a-z0-9-]{1,32}$/.test(tag));
  const output=`build/${tag?tag+'-':''}adventure-worker-report.json`;if(tag)assert(!existsSync(output),'Preserve retained worker evidence.');
  const registry=await originalGameProvider(),cases=[];
  for(const version of ['firered','leafgreen'] as const){
    await database.pool.query('savepoint original_adventure_worker');
    const pool=new AdventurePool(2);let now=0,latest:AdventureEngine|undefined;
    const create=pool.create.bind(pool);
    pool.create=async(...args)=>{const engine=await create(...args);latest=engine;return engine;};
    const service=new Sessions(database,registry,{pool,clock:()=>now});
    let reference:WasmEngine|undefined;
    try{
      const path=originalGameDirectory(version),manifest=registry.manifest(version),bytes=registry.artifact(version);
      const replay=JSON.parse(await readFile(`tests/replays/${version==='firered'?'starter-rival-save':'leafgreen-starter-rival-save'}.json`,'utf8'));
      const qualified=JSON.parse(await readFile(`${path}/gameplay-report.json`,'utf8'));
      assert.equal(qualified.artifactId,manifest.id);assert.equal(qualified.frames,replay.expectedFrames);
      await database.pool.query("update private.game_sessions set status='closed',superseded_at=clock_timestamp() where owner_id=$1",[owner]);
      // LeafGreen uses this owner's independent version slot, not Bob's slot.
      const owned=(await database.pool.query('select id,revision from private.adventures where owner_id=$1 and version=$2',[owner,version])).rows[0];
      assert(owned);await database.pool.query('update private.adventures set flash=null where id=$1',[owned.id]);
      await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
        values(gen_random_uuid(),$1,$2,$3,$4,$5,'adventure',clock_timestamp()-interval '1 second')`,[owner,owned.id,manifest.id,replay.seed,owned.revision]);
      reference=await WasmEngine.create(bytes,manifest,replay.seed);
      let bootstrap=await service.start(owner,version),sequence=bootstrap.nextSequence;
      const execution=await latest!.lease.call<{pid:number;transport:string;environmentKeys:string[]}>('metrics');
      assert.equal(execution.transport,process.env.GAME_WORKER_TRANSPORT??'thread');
      assert(execution.environmentKeys.every(key=>key==='NODE_OPTIONS'));
      if(execution.transport==='process')assert.notEqual(execution.pid,process.pid);
      assert.equal(bootstrap.digest,reference.digest());
      await assert.rejects(service.enterLobby(owner,bootstrap.id),{code:'LOBBY_UNSAFE_LOCATION'});service.resume(owner,bootstrap.id);
      let killed=false,recovered=false,checkpointed=false,pending:InputRun[]=[],pendingFrames=0,frame=0;
      const milestones=new Map<number,string>(replay.milestones.map((point:{frame:number;name:string})=>[point.frame,point.name]));
      const boundaries=[...milestones.keys()].sort((a,b)=>a-b);let milestone=0;
      let sourceLobbyChecked=false;
      const flush=async()=>{
        if(!pendingFrames)return;
        const batch={type:'input',protocol:1,sessionId:bootstrap.id,sequence,operationId:randomUUID(),startFrame:reference!.frame,runs:pending};
        now+=pendingFrames*FRAME_MILLISECONDS+1;
        if(!killed&&reference!.frame>=2000){
          const engine=latest!,advance=engine.advance.bind(engine);let started=false;
          engine.advance=async(runs)=>advance(runs,()=>{started=true;void pool.terminate(engine);});
          await assert.rejects(service.accept(owner,bootstrap.id,batch),{code:'ADVENTURE_WORKER_LOST'});assert(started);killed=true;
          const durable=(await database.pool.query('select frame,next_sequence,checkpoint_frame from private.game_sessions where id=$1',[bootstrap.id])).rows[0];
          assert.equal(Number(durable.frame),reference!.frame);assert.equal(Number(durable.next_sequence),sequence);
          assert(Number(durable.frame)>Number(durable.checkpoint_frame),'No committed journal tail remained to replay.');
          bootstrap=await service.start(owner,version);assert.equal(bootstrap.frame,reference!.frame);assert.equal(bootstrap.digest,reference!.digest());
          assert.equal(bootstrap.nextSequence,sequence);service.resume(owner,bootstrap.id);
          await assert.rejects(service.accept(owner,bootstrap.id,batch),{code:'INPUT_TOO_FAST'});
          now+=pendingFrames*FRAME_MILLISECONDS+1;recovered=true;
        }
        const ack=await service.accept(owner,bootstrap.id,batch);reference!.advance(pending);
        assert.equal(ack.frame,reference!.frame);assert.equal(ack.digest,reference!.digest());sequence++;
        if(!checkpointed&&reference!.frame>=1200){await service.checkpoint(owner,bootstrap.id);service.resume(owner,bootstrap.id);checkpointed=true;}
        pending=[];pendingFrames=0;
      };
      for(const run of replay.runs){
        let remaining=run.frames;
        while(remaining){
          const boundary=boundaries[milestone]??replay.expectedFrames;
          const frames=Math.min(remaining,16-pendingFrames,boundary-frame);assert(frames>0);
          pending.push({buttons:run.buttons,frames});pendingFrames+=frames;frame+=frames;remaining-=frames;
          if(pendingFrames===16||frame===boundary)await flush();
          if(frame===boundary){
            const name=milestones.get(frame);
            if(name==='rival-battle'){
              await assert.rejects(service.enterLobby(owner,bootstrap.id),{code:'LOBBY_UNSAFE_LOCATION'});service.resume(owner,bootstrap.id);
            }
            if(name==='after-rival'){
              const before=latest!.digest(),staged=await latest!.prepareLobby();assert.equal(latest!.digest(),before);
              const proof=JSON.parse(await readFile(`${path}/lobby-report.json`,'utf8'));
              assert.equal(createHash('sha256').update(staged.flash).digest('hex'),proof.flashSha256);
              const restored=await create({bytes,manifest},replay.seed,undefined,staged.checkpoint);
              try{assert.equal(restored.digest(),staged.digest);assert.deepEqual(await restored.flash(),staged.flash);}finally{await restored.close();}
              sourceLobbyChecked=true;
            }
            milestone++;
          }
        }
      }
      await flush();assert.equal(frame,replay.expectedFrames);assert(recovered&&checkpointed&&sourceLobbyChecked);
      const expected=await WasmEngine.create(bytes,manifest,replay.seed);
      try{expected.restore(new Uint8Array(await readFile(`${path}/gameplay.checkpoint`)));assert.equal(reference.digest(),expected.digest());}
      finally{expected.close();}
      const point=await service.checkpoint(owner,bootstrap.id);
      assert.deepEqual(point.flash,new Uint8Array(await readFile(`${path}/gameplay.sav`)));
      assert.equal((await database.pool.query('select flash from private.adventures where id=$1',[owned.id])).rows[0].flash,null,
        'An adventure input or checkpoint wrote a canonical cartridge before save handoff.');
      service.resume(owner,bootstrap.id);
      for(const buttons of [2,0])for(let index=0;index<4;index++){
        pending=[{buttons,frames:15}];pendingFrames=15;await flush();
      }
      const staged=await prepareLobbySave(bytes,manifest,replay.seed,reference.snapshot());
      const lobby=await service.enterLobby(owner,bootstrap.id);assert.deepEqual(lobby.party,staged.party);
      assert.deepEqual((await database.pool.query('select flash from private.adventures where id=$1',[owned.id])).rows[0].flash,Buffer.from(staged.flash));
      assert.equal(lobby.saveRevision,Number(owned.revision)+1);
      const resumed=await service.leaveLobby(owner);reference.restore(staged.snapshot);
      assert.equal(resumed.digest,reference.digest());assert.equal(resumed.frame,reference.frame);assert.equal(resumed.nextSequence,sequence);
      bootstrap=resumed;service.resume(owner,bootstrap.id);
      pending=[{buttons:0,frames:15}];pendingFrames=15;await flush();await service.exit(owner,bootstrap.id);
      const again=await service.start(owner,version);assert.equal(again.digest,reference.digest());await service.exit(owner,again.id);
      cases.push({version,artifactId:manifest.id,recordedFrames:replay.expectedFrames,transport:execution.transport,executionPid:execution.pid,workerEnvironmentStripped:true,ackDigestsMatchInlineOriginal:true,
        originalMenuCartridgeMatchesQualifiedSave:true,workerStartedBeforeKill:true,unacknowledgedFramesDiscarded:true,
        checkpointAndJournalRecovery:true,reconnectCannotMintClockCredit:true,originalLobbyGuards:true,qualifiedLobbySaveMatches:true,
        lobbyPreparationLeavesLiveRuntimeUnchanged:true,atomicCanonicalHandoff:true,postSaveRuntimeResume:true,exitAndReopen:true});
      await writeFile(output,JSON.stringify({cases,originalC:true,realPostgres:true,testClock:true,
        completeAdventureQualified:false,hostedAccountsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
      console.log(JSON.stringify({originalAdventureWorker:version,recordedFrames:replay.expectedFrames,recovered:true}));
    }finally{
      reference?.close();try{await service.close();}finally{await pool.close();await database.pool.query('rollback to savepoint original_adventure_worker');}
    }
  }
}
