import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { GameVersion } from '../packages/protocol/index.ts';
import { OriginalTradeCore } from '../packages/trading/original-core.ts';
import type { Database } from '../apps/server/src/database.ts';
import { PostgresTrades } from '../apps/server/src/trade-repository.ts';
import { TradeOffers } from '../apps/server/src/trade-offers.ts';
import { TradeSceneStore } from '../apps/server/src/trade-scene-store.ts';
import { TradeScenes, type TradeSceneBootstrap } from '../apps/server/src/trade-scenes.ts';
import {TradeWorkerPool,type TradeEngine} from '../packages/trading/worker-pool.ts';
import {originalGameDirectory,originalGameProvider} from './original-game-provider.ts';

/** Opt-in qualification against actual C artifacts and a disposable Postgres.
 * Input policy/clock are explicit test drivers, never production automation. */
export async function checkOriginalTradeScenes(database: Database, owners: [string,string], saves: [string,string]): Promise<void> {
  const audio=process.env.KANTO_CHECK_TRADE_AUDIO==='1';
  const registry = await originalGameProvider(false,audio);
  const fixtures = audio ? await originalGameProvider() : registry;
  // Qualification provider only: manifests/capabilities remain unchanged and
  // no candidate is installed into the public application's registry.
  const repository=new PostgresTrades(database), store=new TradeSceneStore(database), offers=new TradeOffers(database,registry);
  const pool=new TradeWorkerPool(4),latest=new Map<GameVersion,TradeEngine>(),restore=pool.restore.bind(pool);
  pool.restore=async(...args)=>{const engine=await restore(...args);latest.set(engine.manifest.version,engine);return engine;};
  let clock=0;
  const create=()=>new TradeScenes(registry,repository,store,offers,()=>clock,pool);
  const results=[];
  try{
  for (const name of ['ordinary','learn-move'] as const) {
    await database.pool.query('savepoint original_scene_case');
    let service=create(), replacement=create();
    const clients:OriginalTradeCore[]=[];
    try {
      const original=[];
      for (const [side,version] of (['firered','leafgreen'] as const).entries()) {
        const path=`${originalGameDirectory(version)}/exchange-checks/${name}-${side===0?'a':'b'}`;
        const meta=JSON.parse(await readFile(`${path}-inputs.json`,'utf8'));
        // Decode retained checkpoints with their exact original artifact.
        // Only its cartridge flash crosses into the new audio trade core.
        const source=await OriginalTradeCore.restore(fixtures.artifact(version),fixtures.manifest(version),meta.seed,
          fixtures.decodeCheckpoint(version,gunzipSync(await readFile(`${path}-start.checkpoint.gz`))));
        const flash=Buffer.from(source.engine.flash()); source.close();
        original.push(flash);
        await database.pool.query('update private.adventures set flash=$2 where id=$1',[saves[side],flash]);
      }
      await database.pool.query("update private.game_sessions set status='closed' where owner_id=any($1::uuid[])",[owners]);
      for (let side=0;side<2;side++) await database.pool.query(`insert into private.game_sessions
        (id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
        select gen_random_uuid(),owner_id,id,$2,0,revision,'lobby',clock_timestamp()+interval '60 seconds'
        from private.adventures where id=$1`,[saves[side],registry.manifest(side===0?'firered':'leafgreen').id]);
      if (name==='ordinary' && process.env.KANTO_CHECK_TRADE_UI==='1') {
        await database.pool.query('savepoint trade_ui_contract');
        try {
          const { checkTradeUi }=await import('./trade-ui-qualification.ts');
          await checkTradeUi(database,registry,owners,saves);
        } finally {await database.pool.query('rollback to savepoint trade_ui_contract');}
        // The independent sequential browser/audio flow can outlive the
        // setup's lobby-presence lease. Start the following API contract with
        // fresh fixture presence; production presence/expiry rules stay intact.
        await database.pool.query("update private.game_sessions set lease_expires_at=clock_timestamp()+interval '60 seconds' where owner_id=any($1::uuid[]) and status='lobby' and superseded_at is null",[owners]);
      }
      const invitation=await offers.invite(owners[0],owners[1]);
      for (let side=0;side<2;side++) {
        const version=side===0?'firered':'leafgreen';
        const party=await registry.lobbyParty(version,0,original[side]!);
        const saved=await database.pool.query('select revision from private.adventures where id=$1',[saves[side]]);
        await offers.offer(owners[side]!,invitation.id,side,{ partySlot:1,pokemonDigest:party[1]!.digest,saveRevision:Number(saved.rows[0].revision) });
      }
      await offers.confirm(owners[0],invitation.id,2); await offers.confirm(owners[1],invitation.id,2);
      let boots=[await service.begin(owners[0],invitation.id,2) as TradeSceneBootstrap,
        await service.begin(owners[1],invitation.id,2) as TradeSceneBootstrap];
      for (let side=0;side<2;side++) {
        const boot=boots[side]!, version=side===0?'firered':'leafgreen';
        const point=await service.checkpoint(owners[side]!,invitation.id);
        clients.push(await OriginalTradeCore.restore(registry.artifact(version),registry.manifest(version),boot.seed,
          registry.decodeCheckpoint(version,gunzipSync(point.bytes))));
        assert.equal(clients[side]!.engine.digest(),boot.digest);
        service.resume(owners[side]!,invitation.id,service.connection(owners[side]!,invitation.id).fence);
      }
      const sequence=[0,0];let restarted=false,crashed=false;
      const drive=async (side:number)=> {
        const client=clients[side]!, owner=owners[side]!, start=client.engine.frame;
        const runs=Array.from({length:15},(_,i)=>({ buttons:(start+i)%61===0?1:0,frames:1 }));
        const batch={ type:'input',protocol:1,sessionId:boots[side]!.id,operationId:randomUUID(),sequence:sequence[side]!,startFrame:start,runs };
        clock+=1000;
        if(name==='ordinary'&&side===0&&sequence[0]===6&&!crashed){
          const target=latest.get('firered')!,advance=target.advance.bind(target);let started=false;
          target.advance=async inputs=>advance(inputs,()=>{started=true;void pool.terminate(target);});
          await assert.rejects(service.accept(owner,invitation.id,batch,service.connection(owner,invitation.id).fence),{code:'TRADE_WORKER_LOST'});
          assert(started);const row=await store.row(owner,invitation.id);
          assert.equal(Number(row.frame),client.engine.frame);assert.equal(Number(row.next_sequence),sequence[0]);
          assert.equal((await latest.get('leafgreen')!.captureCheckpoint()).digest,clients[1]!.engine.digest(),'A failed worker changed the other scene.');
          boots[0]=await service.begin(owner,invitation.id,2) as TradeSceneBootstrap;
          assert.equal(boots[0]!.digest,client.engine.digest());assert.equal(boots[0]!.nextSequence,sequence[0]);
          service.resume(owner,invitation.id,service.connection(owner,invitation.id).fence);
          await assert.rejects(service.accept(owner,invitation.id,batch,service.connection(owner,invitation.id).fence),{code:'INPUT_TOO_FAST'});
          clock+=1000;crashed=true;
        }
        const ack=await service.accept(owner,invitation.id,batch,service.connection(owner,invitation.id).fence);
        client.engine.advance(runs);
        assert.equal(ack.digest,client.engine.digest()); assert.equal(ack.frame,client.engine.frame);
        assert.deepEqual(await service.accept(owner,invitation.id,batch,service.connection(owner,invitation.id).fence),ack,'Durable retry changed the acknowledgement.');
        sequence[side]!++;
      };
      // First player's complete movie cannot edit either canonical save.
      while (clients[0]!.phase===2 && clients[0]!.engine.frame<12000) {
        await drive(0);
        if (!restarted && sequence[0]===3) {
          await service.close();
          await database.pool.query("update private.trade_scenes set lease_expires_at=now()-interval '1 second' where trade_id=$1",[invitation.id]);
          service=replacement; replacement=create();
          for (let side=0;side<2;side++) {
            boots[side]=await service.begin(owners[side]!,invitation.id,2) as TradeSceneBootstrap;
            assert.equal(boots[side]!.frame,clients[side]!.engine.frame);
            assert.equal(boots[side]!.digest,clients[side]!.engine.digest());
            service.resume(owners[side]!,invitation.id,service.connection(owners[side]!,invitation.id).fence);
          }
          restarted=true;
        }
      }
      assert.equal(clients[0]!.phase,3);
      assert.deepEqual(await service.finish(owners[0],invitation.id),{ done:false });
      for (let side=0;side<2;side++) assert.deepEqual((await database.pool.query('select flash from private.adventures where id=$1',[saves[side]])).rows[0].flash,original[side]);
      while (clients[1]!.phase===2 && clients[1]!.engine.frame<12000) await drive(1);
      assert.equal(clients[1]!.phase,3);
      const result=await service.finish(owners[1],invitation.id); assert.equal(result.done,true); assert(result.receipt);
      assert.deepEqual(await service.finish(owners[0],invitation.id),result);
      for (let side=0;side<2;side++) {
        const flash=(await database.pool.query('select flash from private.adventures where id=$1',[saves[side]])).rows[0].flash;
        assert.deepEqual(flash,Buffer.from(clients[side]!.engine.flash()));
        const verify=await OriginalTradeCore.create(registry.artifact(side===0?'firered':'leafgreen'),registry.manifest(side===0?'firered':'leafgreen'),0,flash);
        try {
          assert.equal(verify.party().length,2); assert(verify.party().every(mon=>!mon.badEgg));
          if (name==='learn-move' && side===0) {
            assert.equal(verify.party()[1]!.species,186,'The original Poliwhirl did not evolve into Politoed.');
            assert(verify.party()[1]!.moves.includes(195),'The original move-learning input did not teach Perish Song.');
          }
        }
        finally { verify.close(); }
      }
      if(name==='ordinary')assert(crashed);
      results.push({name,originalC:true,crossVersion:true,isolatedWorkers:true,journalReplay:true,
        workerCrashChecked:crashed,oneSidedSaveUnchanged:true,atomicCommit:true,frames:clients.map(c=>c.engine.frame),artifacts:boots.map(b=>b.manifest.id)});
      console.log(JSON.stringify({ originalTradeScene:name,frames:clients.map(c=>c.engine.frame),journalReplay:true,atomicCommit:true }));
    } finally {
      await service.close();await replacement.close();for(const client of clients)client.close();
      await database.pool.query('rollback to savepoint original_scene_case');
    }
  }
  const evidenceTag=process.env.KANTO_UI_EVIDENCE_TAG;
  if(evidenceTag)assert(/^[a-z0-9-]{1,32}$/.test(evidenceTag));
  await writeFile(`build/${evidenceTag?evidenceTag+'-':''}trade-scenes-report.json`,JSON.stringify({ fixtureCartridges:true,testInputPolicy:true,testClock:true,
    audioArtifacts:audio,fixtureArtifactIds:(['firered','leafgreen'] as const).map(version=>fixtures.manifest(version).id),
    fixtureTransfer:'Only original-format cartridge flash; no cross-artifact checkpoint restoration.',cases:results,publicReleaseQualified:false },null,2)+'\n');
  }finally{await offers.close();await pool.close();}
}
