import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {EngineRegistry} from '../packages/engine/registry.ts';
import {createCheckpointBaseline,encodeCheckpoint,decodeCheckpoint,maxCheckpointBytes} from '../packages/engine/checkpoint.ts';
import type {EngineManifest} from '../packages/engine/runtime.ts';
import {FRAME_MILLISECONDS,type GameVersion} from '../packages/protocol/index.ts';
import {BattleSessions,type BattleScreenEvent} from '../apps/server/src/battle-sessions.ts';
import {BattleRunStore} from '../apps/server/src/battle-run-store.ts';
import type {Database} from '../apps/server/src/database.ts';

/** Actual C + Postgres service qualification. The injected clock and button
 * policy are test drivers; neither is a production or browser API parameter. */
export async function checkOriginalBattleSessions(database:Database,owners:[string,string],saves:[string,string]):Promise<void>{
  const artifacts=new Map<GameVersion,{bytes:Uint8Array;manifest:EngineManifest;baseline:Uint8Array}>();
  for(const version of ['firered','leafgreen'] as const){
    const directory=`build/game-source/${version}/battle`,bytes=new Uint8Array(await readFile(`${directory}/candidate.wasm`));
    artifacts.set(version,{bytes,manifest:JSON.parse(await readFile(`${directory}/candidate.json`,'utf8')),
      baseline:await createCheckpointBaseline(await WebAssembly.compile(bytes))});
  }
  // Trusted qualification provider. Candidate capabilities remain false and
  // the candidates are never installed into the public application's registry.
  const registry=new EngineRegistry();
  registry.artifact=version=>artifacts.get(version)!.bytes;registry.manifest=version=>artifacts.get(version)!.manifest;
  registry.encodeCheckpoint=(version,memory)=>encodeCheckpoint(memory,artifacts.get(version)!.baseline,registry.manifest(version).wasmSha256);
  registry.decodeCheckpoint=(version,payload)=>decodeCheckpoint(payload,artifacts.get(version)!.baseline,registry.manifest(version).wasmSha256);
  registry.checkpointLimit=version=>maxCheckpointBytes(artifacts.get(version)!.baseline.byteLength);
  await database.pool.query('savepoint original_battle_service');
  let now=Date.now(),service=new BattleSessions(database,registry,()=>now),old:BattleSessions|undefined;
  const errors:unknown[]=[],screens=[0,0];
  const listen=(sessions:BattleSessions)=>{
    sessions.on('run-error',event=>errors.push(event));
    sessions.on('screen',(event:BattleScreenEvent)=>{
      const side=owners.indexOf(event.ownerId);assert(side>=0);
      assert.equal(event.pixels.length,240*160*4);assert.equal(event.pixels.buffer.byteLength,240*160*4);
      assert.deepEqual(Object.keys(event).sort(),['frame','id','ownerId','pixels','side']);screens[side]!++;
    });
  };
  listen(service);
  try{
    await database.pool.query("update private.game_sessions set status='closed' where owner_id=any($1::uuid[])",[owners]);
    for(const [side,version] of (['firered','leafgreen'] as const).entries()){
      const flash=await readFile(`build/game-source/${version}/gameplay.sav`);
      await database.pool.query('update private.adventures set flash=$2 where id=$1',[saves[side],flash]);
      await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
        select gen_random_uuid(),owner_id,id,'qualification-lobby',0,revision,'lobby',clock_timestamp()+interval '60 seconds'
        from private.adventures where id=$1`,[saves[side]]);
    }
    const before=(await database.pool.query('select id,revision,flash from private.adventures where owner_id=any($1::uuid[]) order by id',[owners])).rows;
    const challenge=await service.challenge(owners[0],owners[1],true);
    assert.equal(challenge.watchable,true);
    const bootstrap=await service.accept(owners[1],challenge.id);assert.equal(bootstrap.battle.status,'active');
    assert(!('checkpoint' in bootstrap)&&!('manifest' in bootstrap)&&!('seed' in bootstrap));
    const store=new BattleRunStore(database);
    let connections=[await service.connect(owners[0],challenge.id),await service.connect(owners[1],challenge.id)];
    // Spectators are ordinary lobby members: they never open or drive a console,
    // and their pixels must be byte-identical to the owner's rendered side.
    const spectator=randomUUID(),outsider=randomUUID();
    await database.pool.query('insert into auth.users(id) values($1),($2)',[spectator,outsider]);
    await database.pool.query("insert into public.profiles(id,handle) values($1,'Watcher'),($2,'Outsider')",[spectator,outsider]);
    await database.pool.query(`insert into private.adventures(owner_id,version,flash)
      select $1,'firered',flash from private.adventures where id=$2`,[spectator,saves[0]]);
    await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
      select gen_random_uuid(),a.owner_id,a.id,'qualification-lobby',0,0,'lobby',clock_timestamp()+interval '60 seconds'
      from private.adventures a where a.owner_id=$1 and a.version='firered'`,[spectator]);
    const listed=await service.liveBattlesFor(spectator);
    assert(listed.some(battle=>battle.id===challenge.id&&battle.frame!==null),'An opted-in active battle is missing from the live list.');
    await assert.rejects(service.liveBattlesFor(outsider),{code:'LOBBY_NOT_FOUND'});
    // The live list and watch admission follow the per-battle opt-in. This is a
    // direct row toggle so the same live original-C battle can exercise both
    // states without opening a second pair of consoles.
    await database.pool.query('update private.battles set watchable=false where id=$1',[challenge.id]);
    const privateList=await service.liveBattlesFor(spectator);
    assert(!privateList.some(battle=>battle.id===challenge.id),'A private battle stayed in the live list.');
    await assert.rejects(service.watch(spectator,challenge.id,'a'),{code:'WATCH_DISABLED'});
    await database.pool.query('update private.battles set watchable=true where id=$1',[challenge.id]);
    const watchedA=await service.watch(spectator,challenge.id,'a'),ownerA=await service.screen(owners[0],challenge.id);
    assert.equal(watchedA.frame,ownerA.frame);assert.deepEqual(watchedA.pixels,ownerA.pixels);assert.equal(watchedA.battle.side,'a');
    const watchedB=await service.watch(spectator,challenge.id,'b'),ownerB=await service.screen(owners[1],challenge.id);
    assert.equal(watchedB.frame,ownerB.frame);assert.deepEqual(watchedB.pixels,ownerB.pixels);assert.equal(watchedB.battle.side,'b');
    await assert.rejects(service.watch(outsider,challenge.id,'a'),{code:'LOBBY_NOT_FOUND'});
    await database.pool.query('update public.profiles set suspended_at=now() where id=$1',[spectator]);
    await assert.rejects(service.watch(spectator,challenge.id,'a'),{code:'ACCOUNT_SUSPENDED'});
    await database.pool.query('update public.profiles set suspended_at=null where id=$1',[spectator]);
    await assert.rejects(service.watch(spectator,randomUUID(),'a'),{code:'BATTLE_NOT_FOUND'});
    let held=[0,0],recovered=false,finished=false;
    let recoveredFrame=0;
    for(let turn=0;turn<16000;turn++){
      const frame=service.frame(owners[0],challenge.id),buttons=frame%31===0?1:0;
      for(let side=0;side<2;side++)if(held[side]!==buttons){
        const connection=connections[side]!;
        const input={type:'buttons',protocol:1,sequence:connection.nextSequence,operationId:randomUUID(),buttons};
        const ack=await service.input(owners[side]!,challenge.id,connection.epoch,input);
        assert.equal(ack.sequence,connection.nextSequence);connection.nextSequence++;held[side]=buttons;
      }
      now+=FRAME_MILLISECONDS+0.01;await service.tick();assert.deepEqual(errors,[]);
      const view=await service.get(owners[0],challenge.id);
      if(view.status==='finished'){
        assert.equal(view.result!.reason,'finished');assert(['a','b',null].includes(view.result!.winner));finished=true;break;
      }
      if(!recovered&&service.frame(owners[0],challenge.id)>=2000){
        const prior=await store.row(owners[0],challenge.id);
        assert(Number(prior.frame)>Number(prior.checkpoint_frame),'The recovery fixture has no committed tail to replay.');
        await store.expireLease(challenge.id,Number(prior.fence));old=service;
        service=new BattleSessions(database,registry,()=>now);listen(service);
        const resumed=await service.open(owners[0],challenge.id);
        assert.equal(resumed.frame,Number(prior.frame));recoveredFrame=resumed.frame;
        const restored=await store.row(owners[0],challenge.id);
        assert.equal(restored.decision_deadline?.getTime(),prior.decision_deadline?.getTime(),'Recovery reset the decision deadline.');
        connections=[await service.connect(owners[0],challenge.id),await service.connect(owners[1],challenge.id)];held=[0,0];
        await assert.rejects(old.close(),{code:'BATTLE_LEASE_LOST'});old=undefined;recovered=true;
      }
    }
    assert(finished,'The durable original-C battle did not finish.');assert(recovered);assert(screens.every(count=>count>100));
    const final=await service.get(owners[0],challenge.id);
    assert.deepEqual(await service.forfeit(owners[0],challenge.id),final.result,'A retry changed the original result.');
    assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures where owner_id=any($1::uuid[]) order by id',[owners])).rows,before);
    assert.equal((await database.pool.query("select count(*)::int as n from private.game_sessions where owner_id=any($1::uuid[]) and status='lobby'",[owners])).rows[0].n,2);
    await mkdir('build',{recursive:true});
    await writeFile('build/battle-service-report.json',JSON.stringify({artifacts:[registry.manifest('firered').id,registry.manifest('leafgreen').id],
      originalC:true,postgresJournal:true,checkpointAndJournalRecovery:true,recoveredFrame,staleWorkerRejected:true,
      sourceAdventuresUnchanged:true,privateScreensOnly:true,screenCounts:screens,decisionDeadlinePreserved:true,
      spectatorPixelsMatchOwners:true,spectatorAdmissionEnforced:true,spectatorOptInEnforced:true,
      liveListRequiresLobby:true,liveListWatchableOnly:true,
      isolatedConsoleWorkers:true,
      testClock:true,testInputPolicy:true,result:final.result,hostedAccountsQualified:false,publicReleaseQualified:false},null,2)+'\n');
    console.log(JSON.stringify({originalBattleService:true,recoveredFrame,screens,result:final.result}));
  }finally{
    await service.close();if(old)try{await old.close();}catch{/* Expected stale lease during a failed qualification. */}
    await database.pool.query('rollback to savepoint original_battle_service');
  }
}
