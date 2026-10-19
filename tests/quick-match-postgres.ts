import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Database} from '../apps/server/src/database.ts';
import {DomainError} from '../packages/protocol/index.ts';
import {QuickMatch} from '../apps/server/src/quick-match.ts';
import type {BattleBootstrap} from '../apps/server/src/battle-sessions.ts';

/** Queue and pairing contracts against real SQL. The starter is an opaque
 * stub: the original challenge/accept path, console capacity and C execution
 * are qualified separately in the battle and engine contracts. */
export async function checkQuickMatch(database:Database,a:string,b:string):Promise<void>{
  await database.pool.query('savepoint quick_match_contract');
  try{
    const starts:string[][]=[],bootstrap={trio:'opaque-bootstrap-fixture'} as unknown as BattleBootstrap;
    let failing=false;
    const quick=new QuickMatch(database,async(challenger,challenged)=>{
      starts.push([challenger,challenged]);
      if(failing){failing=false;throw new DomainError('TOO_MANY_CHALLENGES','This trainer is already in matches.',409);}
      return bootstrap;
    });
    const session=async(owner:string)=>(await database.pool.query(
      "select id from private.game_sessions where owner_id=$1 and status='lobby' limit 1",[owner])).rows[0].id as string;
    const presence=async(owner:string,level:number)=>{const id=await session(owner);
      await database.pool.query(`insert into private.lobby_presence(session_id,owner_id,version,max_party_level,party)
        select s.id,$1,a.version,$2,'[]'::jsonb from private.game_sessions s join private.adventures a on a.id=s.adventure_id
        where s.id=$3 on conflict(session_id) do update set max_party_level=excluded.max_party_level`,[owner,level,id]);};
    const queue=async()=>((await database.pool.query(
      'select owner_id,session_id,ruleset,max_party_level from private.quick_match_queue order by enqueued_at,owner_id')).rows);
    const owners=async()=>((await queue()).map(row=>row.owner_id).sort());
    // Fixture leases are refreshed so the real liveness filters are exercised
    // against a live lobby state, not an accident of test timing.
    await database.pool.query(`update private.game_sessions set lease_expires_at=clock_timestamp()+interval '60 seconds'
      where owner_id in ($1,$2) and status='lobby'`,[a,b]);
    // Only a live, unsuspended lobby session may queue.
    await assert.rejects(quick.enqueue(randomUUID()),{code:'TRAINER_NOT_READY'});
    const bSession=await session(b);
    await database.pool.query("update private.game_sessions set status='adventure' where id=$1",[bSession]);
    await assert.rejects(quick.enqueue(b),{code:'TRAINER_NOT_READY'});
    await database.pool.query("update private.game_sessions set status='lobby' where id=$1",[bSession]);
    await database.pool.query('update public.profiles set suspended_at=now() where id=$1',[b]);
    await assert.rejects(quick.enqueue(b),{code:'TRAINER_NOT_READY'});
    await database.pool.query('update public.profiles set suspended_at=null where id=$1',[b]);
    // The first entry waits with its snapshot level and stores the live session.
    const aSession=await session(a);
    await presence(a,35);
    assert.deepEqual(await quick.enqueue(a),{status:'waiting',maxLevel:35});
    const waiting=await queue();
    assert.equal(waiting.length,1);assert.equal(waiting[0]!.owner_id,a);assert.equal(waiting[0]!.session_id,aSession);
    assert.equal(Number(waiting[0]!.max_party_level),35);assert.equal(waiting[0]!.ruleset,'open');
    // A fresh in-band partner pairs immediately and consumes both entries.
    await presence(b,40);
    assert.deepEqual(await quick.enqueue(b),{status:'paired',bootstrap});
    assert.deepEqual(starts,[[a,b]]);assert.equal((await queue()).length,0);
    // Fresh entries outside the level band keep waiting.
    assert.deepEqual(await quick.enqueue(a),{status:'waiting',maxLevel:35});
    await presence(b,90);
    assert.deepEqual(await quick.enqueue(b),{status:'waiting',maxLevel:90});
    assert.equal(starts.length,1);assert.equal((await queue()).length,2);
    // Ageing past the relax window lets the sweep pair them anyway.
    await database.pool.query("update private.quick_match_queue set enqueued_at=clock_timestamp()-interval '61 seconds'");
    await quick.sweep();
    assert.equal((await queue()).length,0);assert.equal(starts.length,2);
    assert.deepEqual(new Set(starts.at(-1)!),new Set([a,b]));
    // A failed start restores both claimed entries instead of losing either.
    await presence(a,35);await presence(b,40);
    assert.deepEqual(await quick.enqueue(a),{status:'waiting',maxLevel:35});
    failing=true;
    assert.deepEqual(await quick.enqueue(b),{status:'waiting',maxLevel:40});
    assert.equal(starts.length,3);assert.equal((await queue()).length,2,'A failed pairing start dropped a queued trainer.');
    assert.deepEqual(await quick.enqueue(a),{status:'paired',bootstrap},'The restored entries could not retry.');
    assert.deepEqual(starts.at(-1),[b,a]);assert.equal((await queue()).length,0);
    // Cancel is idempotent and never pairs.
    assert.deepEqual(await quick.enqueue(a),{status:'waiting',maxLevel:35});
    assert.deepEqual(await quick.cancel(a),{status:'idle'});
    assert.deepEqual(await quick.cancel(randomUUID()),{status:'idle'});
    assert.equal((await queue()).length,0);assert.equal(starts.length,4);
    // Abandoned entries expire instead of waiting forever: through the sweep,
    // and opportunistically when someone else queues.
    await quick.enqueue(b);
    await database.pool.query("update private.quick_match_queue set enqueued_at=clock_timestamp()-interval '11 minutes' where owner_id=$1",[b]);
    await quick.sweep();
    assert.equal((await queue()).length,0);
    assert.deepEqual(await quick.enqueue(a),{status:'waiting',maxLevel:35});
    await presence(b,90);
    assert.deepEqual(await quick.enqueue(b),{status:'waiting',maxLevel:90});
    await database.pool.query("update private.quick_match_queue set enqueued_at=clock_timestamp()-interval '11 minutes' where owner_id=$1",[b]);
    await presence(a,35);
    assert.deepEqual(await quick.enqueue(a),{status:'waiting',maxLevel:35});
    assert.deepEqual(await owners(),[a],'A stale entry survived an enqueue sweep.');
    assert.equal(starts.length,4);
    await quick.cancel(a);
    // A peer whose session left the lobby is not selected, even while its
    // queue row remains.
    await presence(b,40);
    await quick.enqueue(b);
    await database.pool.query("update private.game_sessions set status='adventure' where id=$1",[bSession]);
    await presence(a,35);
    await quick.enqueue(a);
    assert.deepEqual(await owners(),[a,b].sort());
    assert.equal(starts.length,4,'A departed peer was paired.');
    await database.pool.query("update private.game_sessions set status='lobby' where id=$1",[bSession]);
    await quick.cancel(a);await quick.cancel(b);
    // A suspended peer is not selected either, and its row is left intact.
    await presence(b,40);
    await quick.enqueue(b);
    await database.pool.query('update public.profiles set suspended_at=now() where id=$1',[b]);
    await quick.enqueue(a);
    assert.deepEqual(await owners(),[a,b].sort());
    assert.equal(starts.length,4,'A suspended peer was paired.');
    assert.equal((await queue()).length,2);
    await database.pool.query('update public.profiles set suspended_at=null where id=$1',[b]);
    await quick.cancel(a);await quick.cancel(b);
    assert.equal((await database.pool.query('select count(*)::int as n from private.quick_match_queue')).rows[0].n,0);
  }finally{await database.pool.query('rollback to savepoint quick_match_contract');}
}
