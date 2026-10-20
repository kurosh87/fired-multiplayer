import assert from 'node:assert/strict';
import type {FastifyInstance} from 'fastify';
import type {Database} from '../apps/server/src/database.ts';

/** HTTP journey for Quick Match through the real app: two fixture accounts
 * queue from a live lobby, the second enqueue walks the same authenticated
 * claim/start path a hosted pairing uses, and queue cleanup is exercised
 * through the cancel and leave-lobby APIs. This fixture application reports no
 * battle-capable artifact, so its start leg must restore both claimed entries
 * instead of dropping a trainer; an application that reports battles ready
 * must instead return the paired bootstrap and let the match end through
 * forfeit. Pairing SQL and the successful-pair contract are qualified
 * separately in quick-match-postgres.ts. */
export async function checkQuickMatchHttp(database:Database,app:FastifyInstance,a:string,b:string):Promise<void>{
  const alice={authorization:'Bearer fixture-alice'},bob={authorization:'Bearer fixture-bob'};
  await database.pool.query('savepoint quick_match_http_contract');
  try{
    // Both trainers stand in a live lobby. The directory read refreshes the
    // lease and backfills the presence snapshot from the inspection fixture.
    const aliceLobby=await app.inject({method:'GET',url:'/api/lobby',headers:alice});
    assert.equal(aliceLobby.statusCode,200,aliceLobby.body);
    const started=await app.inject({method:'POST',url:'/api/sessions',headers:bob,payload:{version:'firered'}});
    assert.equal(started.statusCode,200,started.body);
    const boot=started.json();
    const entered=await app.inject({method:'POST',url:`/api/sessions/${boot.id}/lobby`,headers:bob});
    assert.equal(entered.statusCode,200,entered.body);
    assert.equal((await app.inject({method:'GET',url:'/api/lobby',headers:bob})).statusCode,200);
    const status=await app.inject({method:'GET',url:'/api/status'});
    assert.equal(status.statusCode,200,status.body);
    const battleReady=status.json().multiplayer.battles===true;
    // The live list follows the same lobby-session admission as spectating.
    const live=await app.inject({method:'GET',url:'/api/battles/live',headers:alice});
    assert.equal(live.statusCode,200,live.body);assert.deepEqual(live.json(),{battles:[]});
    // A valid spectator flag reaches the service; without a battle-capable
    // artifact the challenge then stops at the engine gate. A malformed flag
    // is rejected before any battle work.
    const optedIn=await app.inject({method:'POST',url:'/api/battles/challenge',headers:alice,payload:{trainerId:b,watchable:true}});
    if(battleReady){
      assert.equal(optedIn.statusCode,200,optedIn.body);assert.equal(optedIn.json().watchable,true);
      assert.equal((await app.inject({method:'POST',url:`/api/battles/${optedIn.json().id}/decline`,headers:bob,payload:{}})).statusCode,200);
    }else{
      assert.equal(optedIn.statusCode,503,optedIn.body);assert.equal(optedIn.json().error,'ENGINE_UNAVAILABLE');
    }
    const invalidWatchable=await app.inject({method:'POST',url:'/api/battles/challenge',headers:alice,payload:{trainerId:b,watchable:'yes'}});
    assert.equal(invalidWatchable.statusCode,400,invalidWatchable.body);assert.equal(invalidWatchable.json().error,'INVALID_CHALLENGE');
    // Unauthenticated or nonempty bodies never touch the queue.
    assert.equal((await app.inject({method:'POST',url:'/api/battles/quick'})).statusCode,401);
    const junk=await app.inject({method:'POST',url:'/api/battles/quick',headers:alice,payload:{level:5}});
    assert.equal(junk.statusCode,400);assert.equal(junk.json().error,'INVALID_BATTLE');
    // The first entry waits with its snapshot level; the second one follows
    // the same claim and start path a hosted pairing uses.
    const waiting=await app.inject({method:'POST',url:'/api/battles/quick',headers:alice,payload:{}});
    assert.equal(waiting.statusCode,200,waiting.body);
    assert.deepEqual(waiting.json(),{status:'waiting',maxLevel:5});
    const paired=await app.inject({method:'POST',url:'/api/battles/quick',headers:bob,payload:{}});
    assert.equal(paired.statusCode,200,paired.body);
    const outcome=paired.json();
    if(!battleReady){
      // Without a battle-capable artifact the start must fail closed: both
      // claimed entries return to the queue and neither trainer is dropped.
      assert.deepEqual(outcome,{status:'waiting',maxLevel:5});
      const queue=(await database.pool.query('select owner_id from private.quick_match_queue')).rows;
      assert.deepEqual(queue.map(row=>row.owner_id as string).sort(),[a,b].sort(),'A failed start must restore both claimed entries.');
    }else{
      assert.equal(outcome.status,'paired');
      const battleId=outcome.bootstrap?.battle?.id as string;
      assert(battleId,'A paired quick match must return its battle.');
      assert(['starting','active'].includes(outcome.bootstrap.battle.status));
      assert.equal((await database.pool.query('select count(*)::int as n from private.quick_match_queue')).rows[0].n,0,
        'A completed pairing left its queue entries behind.');
      assert.equal((await database.pool.query("select count(*)::int as n from private.game_sessions where owner_id in ($1,$2) and status='battle'",[a,b])).rows[0].n,2);
      // The match ends through the normal battle API and both trainers return
      // to the lobby; finished matches never stay listed as open.
      const forfeit=await app.inject({method:'POST',url:`/api/battles/${battleId}/forfeit`,headers:bob,payload:{}});
      assert.equal(forfeit.statusCode,200,forfeit.body);
      assert.deepEqual(forfeit.json(),{winner:'a',reason:'forfeit'});
      assert.equal((await database.pool.query("select count(*)::int as n from private.game_sessions where owner_id in ($1,$2) and status='lobby'",[a,b])).rows[0].n,2,
        'Finishing a quick match did not return both trainers to the lobby.');
      const listed=await app.inject({method:'GET',url:'/api/battles',headers:alice});
      assert.equal(listed.statusCode,200,listed.body);
      assert(!listed.json().battles.some((battle:{id:string})=>battle.id===battleId),'A finished battle stayed open in the list.');
    }
    // Cancel stays idempotent over HTTP and clears every waiting entry.
    assert.deepEqual((await app.inject({method:'POST',url:'/api/battles/quick/cancel',headers:alice,payload:{}})).json(),{status:'idle'});
    assert.deepEqual((await app.inject({method:'POST',url:'/api/battles/quick/cancel',headers:bob,payload:{}})).json(),{status:'idle'});
    assert.equal((await database.pool.query('select count(*)::int as n from private.quick_match_queue')).rows[0].n,0,'Cancel must clear every waiting entry.');
    // A queued trainer who leaves the lobby takes their entry and presence
    // snapshot with them, and cannot queue from outside the lobby again.
    assert.deepEqual((await app.inject({method:'POST',url:'/api/battles/quick',headers:bob,payload:{}})).json(),{status:'waiting',maxLevel:5});
    assert.equal((await app.inject({method:'POST',url:'/api/lobby/leave',headers:bob,payload:{}})).statusCode,200);
    assert.equal((await database.pool.query('select count(*)::int as n from private.quick_match_queue where owner_id=$1',[b])).rows[0].n,0,
      'Leaving the lobby left a quick-match entry behind.');
    assert.equal((await database.pool.query('select count(*)::int as n from private.lobby_presence where session_id=$1',[boot.id])).rows[0].n,0,
      'Leaving the lobby left its presence snapshot behind.');
    const refused=await app.inject({method:'POST',url:'/api/battles/quick',headers:bob,payload:{}});
    assert.equal(refused.statusCode,409,refused.body);assert.equal(refused.json().error,'TRAINER_NOT_READY');
    // The live list is not an auth-only directory: leaving the lobby or being
    // suspended closes it even though the account can still authenticate.
    const outside=await app.inject({method:'GET',url:'/api/battles/live',headers:bob});
    assert.equal(outside.statusCode,409,outside.body);assert.equal(outside.json().error,'LOBBY_NOT_FOUND');
    await database.pool.query('update public.profiles set suspended_at=now() where id=$1',[a]);
    const suspended=await app.inject({method:'GET',url:'/api/battles/live',headers:alice});
    assert.equal(suspended.statusCode,403,suspended.body);assert.equal(suspended.json().error,'ACCOUNT_SUSPENDED');
    await database.pool.query('update public.profiles set suspended_at=null where id=$1',[a]);
  }finally{await database.pool.query('rollback to savepoint quick_match_http_contract');}
}
