import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Database,type DatabaseListener} from '../apps/server/src/database.ts';
import {LIVE_BATTLE_PREFIX,LobbyPresence,LOBBY_CHANNEL,notifyLiveBattle,notifyLobbyPresence,type LobbyPresenceMessage} from '../apps/server/src/lobby-presence.ts';

/** Real SQL for the live directory: the presence service runs its own queries
 * against the disposable contract database, its notifications are simulated at
 * the exact moments the committed transitions raise them, and Database.listen
 * is proven against one real committed NOTIFY round-trip. No original game or
 * hosted account capability is inferred from these fixtures. */
export async function checkLobbyPresence(database:Database):Promise<void>{
  await database.pool.query('savepoint lobby_presence');
  const real=new Database(process.env.DATABASE_TEST_URL!);
  const handlers:((payload:string)=>void)[]=[];
  const presence=new LobbyPresence({
    // The contract transaction never commits, so committed wake-ups cannot
    // arrive here; the handler is invoked directly instead.
    listen:async()=>({
      end:async()=>{},
      onNotification:handler=>{handlers.push(handler);},
      onError:()=>{},
    }),
    queries:database.pool,
    onError:()=>{},
    flushDelayMs:2,
    staleCheckMs:60_000,
    reconcileMs:60_000,
  });
  try{
    // One real committed NOTIFY delivered to a real dedicated listener.
    const probe=randomUUID();
    await new Promise<void>((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('The lobby notification never arrived.')),5_000);
      void real.listen(LOBBY_CHANNEL).then(listener=>{
        listener.onNotification(payload=>{
          if(payload!==probe)return;
          clearTimeout(deadline);
          void listener.end().then(resolve,resolve);
        });
        return notifyLobbyPresence(real.pool,probe);
      }).catch(reject);
    });
    // Battle start/finish wake-ups share the channel with a marked payload.
    const wake=randomUUID();
    await new Promise<void>((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new Error('The live battle notification never arrived.')),5_000);
      void real.listen(LOBBY_CHANNEL).then(listener=>{
        listener.onNotification(payload=>{
          if(payload!==`${LIVE_BATTLE_PREFIX}${wake}`)return;
          clearTimeout(deadline);
          void listener.end().then(resolve,resolve);
        });
        return notifyLiveBattle(real.pool,wake);
      }).catch(reject);
    });

    const names=['Presence001','Presence002','Presence003','Presence004'];
    const ids=names.map(()=>randomUUID());
    const [p1,p2,p3,p4]=ids as [string,string,string,string];
    await database.pool.query('insert into auth.users(id) select unnest($1::uuid[])',[ids]);
    await database.pool.query('insert into public.profiles(id,handle) select * from unnest($1::uuid[],$2::text[])',[ids,names]);
    await database.pool.query(`insert into private.adventures(owner_id,version)
      select id,'firered' from unnest($1::uuid[]) with ordinality as v(id,ordinal)`,[ids]);
    await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
      select gen_random_uuid(),owner_id,id,'presence-fixture',0,revision,'lobby',clock_timestamp()+interval '60 seconds'
      from private.adventures where owner_id=any($1::uuid[])`,[ids]);
    await database.pool.query(`insert into private.lobby_presence(session_id,owner_id,version,max_party_level,party)
      select s.id,$1,'firered',30,$2::jsonb from private.game_sessions s where s.owner_id=$1 and s.status='lobby'`,
    [p1,JSON.stringify([{species:1,name:'BULBASAUR',level:30}])]);
    await database.pool.query('update public.profiles set suspended_at=clock_timestamp() where id=$1',[p3]);
    await database.pool.query("update private.game_sessions set lease_expires_at=clock_timestamp()-interval '1 second' where owner_id=$1",[p4]);

    await presence.start();
    await database.pool.query(`update private.game_sessions set lease_expires_at=clock_timestamp()+interval '60 seconds'
      where owner_id=any($1::uuid[])`,[ids]);
    const messages:LobbyPresenceMessage[]=[];
    presence.subscribe(message=>messages.push(message));
    const visible=()=>presence.snapshot().filter(trainer=>trainer.handle.startsWith('Presence')).map(trainer=>trainer.handle);
    const changed=async(label:string,owner:string,count:number)=>{
      await notifyLobbyPresence(database.pool,owner);
      handlers.at(-1)!(owner);
      const deadline=Date.now()+3_000;
      while(messages.length<count){assert(Date.now()<deadline,`No presence event for ${label}`);await new Promise(resolve=>setTimeout(resolve,3));}
    };
    /** Re-reads a committed row without expecting any visible event. */
    const settle=async(owner:string)=>{
      await notifyLobbyPresence(database.pool,owner);
      handlers.at(-1)!(owner);
      await new Promise(resolve=>setTimeout(resolve,40));
    };

    assert.deepEqual(visible(),['Presence001','Presence002'],
      'Suspended, expired and busy trainers must not enter the baseline.');
    const snapshotted=presence.snapshot().find(trainer=>trainer.id===p1)!;
    assert.deepEqual(snapshotted.party,[{species:1,name:'BULBASAUR',level:30}]);
    assert.equal(snapshotted.maxLevel,30);

    await database.pool.query('update public.profiles set suspended_at=null where id=$1',[p3]);
    await changed('unsuspension',p3,1);
    assert.equal(messages.at(-1)!.type,'put');
    assert.deepEqual(visible(),['Presence001','Presence002','Presence003']);

    await changed('renewed lease',p4,2);
    assert.deepEqual(visible(),['Presence001','Presence002','Presence003','Presence004']);

    await database.pool.query("update private.game_sessions set status='battle' where owner_id=$1",[p2]);
    await changed('battle start',p2,3);
    assert.deepEqual(messages.at(-1),{type:'del',ownerId:p2});
    assert.deepEqual(visible(),['Presence001','Presence003','Presence004']);

    await database.pool.query(`update private.game_sessions set status='lobby',lease_expires_at=clock_timestamp()+interval '60 seconds'
      where owner_id=$1`,[p2]);
    await changed('battle finish',p2,4);
    assert.equal(messages.at(-1)!.type,'put');

    await database.pool.query(`update private.lobby_presence set party=$2::jsonb,max_party_level=45
      where owner_id=$1`,[p1,JSON.stringify([{species:1,name:'BULBASAUR',level:45}])]);
    await changed('party update',p1,5);
    const updated=presence.snapshot().find(trainer=>trainer.id===p1)!;
    assert.equal(updated.maxLevel,45);
    assert.deepEqual(updated.party,[{species:1,name:'BULBASAUR',level:45}]);

    await database.pool.query("update private.game_sessions set lease_expires_at=clock_timestamp()+interval '1 second' where owner_id=$1",[p1]);
    await settle(p1);
    await new Promise(resolve=>setTimeout(resolve,1_100));
    await presence.verifyStale();
    assert.deepEqual(messages.at(-1),{type:'del',ownerId:p1},'The lease timer hides a silent trainer without a notification.');
    await database.pool.query(`update private.game_sessions set lease_expires_at=clock_timestamp()+interval '60 seconds' where owner_id=$1`,[p1]);
    await changed('return',p1,7);
    assert.equal(messages.at(-1)!.type,'put');

    await database.pool.query('update public.profiles set suspended_at=clock_timestamp() where id=$1',[p3]);
    await changed('suspension',p3,8);
    assert.deepEqual(messages.at(-1),{type:'del',ownerId:p3});
    assert.deepEqual(visible(),['Presence001','Presence002','Presence004']);

    await writeFile('build/lobby-presence-report.json',JSON.stringify({realPostgres:true,realNotifyDelivery:true,
      dedicatedListener:true,fixtureTrainers:4,baselineExcludesExpiredSuspendedAndBusy:true,unsuspensionReturns:true,
      renewedLeaseReturns:true,battleDepartureAndReturn:true,partyUpdateVisible:true,leaseTimerDeparture:true,
      suspensionDeparture:true,hostedAccountsQualified:false,publicReleaseQualified:false},null,2)+'\n');
  }finally{
    await presence.stop();
    await real.close().catch(()=>undefined);
    await database.pool.query('rollback to savepoint lobby_presence');
  }
}
