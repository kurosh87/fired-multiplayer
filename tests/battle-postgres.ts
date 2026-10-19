import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Database} from '../apps/server/src/database.ts';
import {BattleRepository} from '../apps/server/src/battle-repository.ts';
import {BattleRunStore,type BattleProgress} from '../apps/server/src/battle-run-store.ts';

/** Database contracts use opaque test bytes, not simulated Pokemon mechanics.
 * Original C execution is qualified separately against real game artifacts. */
export async function checkBattleDatabase(database:Database,a:string,b:string):Promise<void>{
  await database.pool.query('savepoint battle_contract');
  try{
    const before=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
    const repository=new BattleRepository(database),store=new BattleRunStore(database),artifacts:[string,string]=['test-core-a','test-core-b'];
    const invitation=await repository.challenge(a,b);
    assert.equal(invitation.status,'offered');assert.deepEqual(invitation.rules,{format:'singles',levels:'earned',ranked:false});
    assert(!('seed' in invitation)&&!('flash' in invitation)&&!('party' in invitation));
    assert.equal((await repository.challenge(b,a)).id,invitation.id);
    await assert.rejects(repository.challenge(a,a),{code:'INVALID_BATTLE'});
    const outsider='00000000-0000-4000-8000-000000000099';
    await assert.rejects(repository.get(outsider,invitation.id),{code:'BATTLE_NOT_FOUND'});
    await assert.rejects(repository.reserve(a,invitation.id,artifacts,11),{code:'BATTLE_ACCEPT_FORBIDDEN'});
    const ownerSave=(await database.pool.query("select adventure_id from private.game_sessions where owner_id=$1 and status='lobby'",[a])).rows[0].adventure_id;
    await database.pool.query('update private.adventures set revision=revision+1 where id=$1',[ownerSave]);
    await assert.rejects(repository.reserve(b,invitation.id,artifacts,11),{code:'SAVE_CHANGED'});
    await database.pool.query('update private.adventures set revision=revision-1 where id=$1',[ownerSave]);
    const otherSave=(await database.pool.query('select id from private.adventures where owner_id=$1 and id<>$2 limit 1',[a,ownerSave])).rows[0].id;
    await database.pool.query("update private.game_sessions set adventure_id=$2 where owner_id=$1 and status='lobby'",[a,otherSave]);
    await assert.rejects(repository.reserve(b,invitation.id,artifacts,11),{code:'TRAINER_NOT_READY'});
    await database.pool.query("update private.game_sessions set adventure_id=$2 where owner_id=$1 and status='lobby'",[a,ownerSave]);
    await database.pool.query('update public.profiles set suspended_at=now() where id=$1',[a]);
    await assert.rejects(repository.reserve(b,invitation.id,artifacts,11),{code:'TRAINER_NOT_READY'});
    await database.pool.query('update public.profiles set suspended_at=null where id=$1',[a]);
    const reserved=await repository.reserve(b,invitation.id,artifacts,11);
    assert.equal(reserved.seed,11);assert.deepEqual((await repository.reserve(b,invitation.id,['new-core-a','new-core-b'],22)).artifacts,artifacts);
    assert.deepEqual(await repository.reserved(a,invitation.id),reserved);
    await assert.rejects(store.initialize({...reserved,saveA:{...reserved.saveA,ownerId:b}},[Buffer.from('a'),Buffer.from('b')]),{code:'BATTLE_CHANGED'});
    await store.initialize(reserved,[Buffer.from('initial-a'),Buffer.from('initial-b')]);
    await store.initialize(reserved,[Buffer.from('replacement-a'),Buffer.from('replacement-b')]);
    assert.equal((await repository.get(a,invitation.id)).status,'active');
    const live=(await repository.live()).find(entry=>entry.id===invitation.id);
    assert(live,'An active battle is missing from the lobby live list.');
    assert.equal(live.playerA.handle,'Alice');assert.equal(live.playerB.handle,'Bob');
    const versions=(await database.pool.query(`select aa.version as version_a,ab.version as version_b
      from private.battles b join private.adventures aa on aa.id=b.adventure_a
      join private.adventures ab on ab.id=b.adventure_b where b.id=$1`,[invitation.id])).rows[0];
    assert.equal(live.playerA.version,versions.version_a);assert.equal(live.playerB.version,versions.version_b);
    assert.equal(live.frame,null);assert(Number.isFinite(live.startedAt));
    const shared=await repository.watchView(invitation.id);
    assert.equal(shared!.status,'active');assert.equal(shared!.side,'a');
    assert.equal(await repository.watchView(outsider),null);
    assert.equal((await store.row(a,invitation.id)).initial_checkpoint_a.toString(),'initial-a','A retry reset the original consoles.');
    await assert.rejects(store.row(outsider,invitation.id),{code:'BATTLE_RUN_NOT_FOUND'});
    const run=await store.claim(a,invitation.id),fence=Number(run.fence);
    await assert.rejects(store.claim(b,invitation.id),{code:'BATTLE_ACTIVE_ELSEWHERE'});
    const alice=await store.connect(a,invitation.id,fence),bob=await store.connect(b,invitation.id,fence);
    const input={type:'buttons',protocol:1,sequence:0,operationId:randomUUID(),buttons:1};
    const ack=await store.command(a,invitation.id,fence,alice.epoch,0,input);
    assert.deepEqual(await store.command(a,invitation.id,fence,alice.epoch,0,{buttons:1,operationId:input.operationId,sequence:0,protocol:1,type:'buttons'}),ack);
    await assert.rejects(store.command(a,invitation.id,fence,alice.epoch,0,{...input,buttons:2}),{code:'BATTLE_INPUT_CONFLICT'});
    await assert.rejects(store.command(a,invitation.id,fence,alice.epoch,0,{...input,sequence:7,operationId:randomUUID()}),{code:'BATTLE_INPUT_OUT_OF_ORDER'});
    await store.command(b,invitation.id,fence,bob.epoch,0,{...input,operationId:randomUUID(),buttons:128});
    const point:BattleProgress={sequence:0,startFrame:0,ticks:4,buttons:[1,128],digests:['a'.repeat(64),'b'.repeat(64)],
      transportDigest:'c'.repeat(64),state:{kind:'turn',mask:3,epoch:1,deadline:Date.now()+90_000}};
    await assert.rejects(store.append(invitation.id,fence-1,point),{code:'BATTLE_LEASE_LOST'});
    await store.append(invitation.id,fence,point);
    await assert.rejects(store.append(invitation.id,fence,{...point,sequence:1,startFrame:4,ticks:61}),{code:'23514'});
    assert.equal(Number((await store.row(a,invitation.id)).frame),4,'A failed journal insert advanced the match.');
    assert.equal((await store.entries(invitation.id,0)).length,1);
    await store.checkpoint(invitation.id,fence,4,1,[Buffer.from('checkpoint-a'),Buffer.from('checkpoint-b')],point.state);
    await assert.rejects(store.checkpoint(invitation.id,fence,4,1,[Buffer.from('reset-a'),Buffer.from('reset-b')],
      {...point.state,deadline:point.state.deadline!+90_000}),{code:'BATTLE_LEASE_LOST'});
    await assert.rejects(database.transaction(async client=>{
      await client.query('update private.battle_runs set checkpoint_b=null where battle_id=$1',[invitation.id]);
    }),{code:'23514'});
    const replacing=await store.connect(a,invitation.id,fence);
    assert(replacing.epoch>alice.epoch);assert.equal(replacing.nextSequence,1);
    assert.equal(await store.disconnect(a,invitation.id,fence,alice.epoch),false,'An old connection disconnected its replacement.');
    await assert.rejects(store.command(a,invitation.id,fence,alice.epoch,4,{...input,sequence:1,operationId:randomUUID()}),{code:'BATTLE_CONNECTION_REPLACED'});
    await store.command(a,invitation.id,fence,replacing.epoch,4,{...input,sequence:1,operationId:randomUUID(),buttons:16});
    await store.disconnect(a,invitation.id,fence,replacing.epoch);
    await assert.rejects(store.command(a,invitation.id,fence,replacing.epoch,4,{...input,sequence:2,operationId:randomUUID()}),{code:'BATTLE_CONNECTION_REPLACED'});
    await store.expireLease(invitation.id,fence);
    await assert.rejects(store.checkpoint(invitation.id,fence,4,1,[Buffer.from('late-a'),Buffer.from('late-b')],point.state),{code:'BATTLE_LEASE_LOST'});
    const recovered=await store.claim(b,invitation.id);assert(Number(recovered.fence)>fence);
    assert.equal(recovered.checkpoint_a!.toString(),'checkpoint-a');assert.equal(recovered.buttons_a,0);assert.equal(recovered.buttons_b,0);
    assert.equal(Number(recovered.next_input_a),2);assert.equal(Number(recovered.next_input_b),1);
    assert.equal(Number(recovered.decision_epoch),1);assert.equal(recovered.decision_deadline!.getTime(),point.state.deadline);
    await assert.rejects(store.command(b,invitation.id,fence,bob.epoch,4,{...input,sequence:1,operationId:randomUUID()}),{code:'BATTLE_LEASE_LOST'});
    await assert.rejects(repository.finish(invitation.id,{winner:'a',reason:'finished'},fence),{code:'BATTLE_LEASE_LOST'});
    await database.pool.query('savepoint original_result_priority');
    try{
      await store.append(invitation.id,Number(recovered.fence),{...point,sequence:1,startFrame:4,ticks:1,buttons:[0,0],
        state:{kind:null,mask:0,epoch:1,deadline:null},result:{winner:'a',reason:'finished'}});
      assert.deepEqual(await repository.forfeit(a,invitation.id),{winner:'a',reason:'finished'},'A later forfeit replaced a durable original outcome.');
    }finally{await database.pool.query('rollback to savepoint original_result_priority');}
    await database.pool.query('savepoint battle_global_expiry');
    try{
      await database.pool.query("update private.battles set expires_at=clock_timestamp()-interval '1 second' where id=$1",[invitation.id]);
      // A global timeout must still flush already simulated frames. Requiring
      // a future match deadline here would poison the worker before finishing.
      await store.append(invitation.id,Number(recovered.fence),{...point,sequence:1,startFrame:4,ticks:1,buttons:[0,0]});
      await store.expireLease(invitation.id,Number(recovered.fence));
      assert((await store.expiredRuns()).some(run=>run.id===invitation.id&&run.owners[0]===a&&run.owners[1]===b));
      assert.deepEqual(await repository.finish(invitation.id,{winner:null,reason:'timeout'}),{winner:null,reason:'timeout'});
    }finally{await database.pool.query('rollback to savepoint battle_global_expiry');}
    assert.deepEqual(await repository.forfeit(a,invitation.id),{winner:'b',reason:'forfeit'});
    assert.deepEqual(await repository.finish(invitation.id,{winner:'a',reason:'finished'}),{winner:'b',reason:'forfeit'});
    assert.equal((await repository.get(a,invitation.id)).status,'finished');
    assert(!(await repository.live()).some(entry=>entry.id===invitation.id),'A finished battle stayed in the lobby live list.');
    await assert.rejects(store.claim(a,invitation.id),{code:'BATTLE_CHANGED'});
    assert.deepEqual(await repository.list(a),[]);
    const expiring=await repository.challenge(a,b);await repository.reserve(b,expiring.id,artifacts,33);
    await database.pool.query("update private.battles set reservation_expires_at=now()-interval '1 second' where id=$1",[expiring.id]);
    await assert.rejects(repository.reserved(a,expiring.id),{code:'BATTLE_EXPIRED'});
    assert((await store.expiredReservations()).includes(expiring.id));
    await repository.releaseStarting(expiring.id);await repository.releaseStarting(expiring.id);
    assert.equal((await repository.get(b,expiring.id)).status,'cancelled');
    const declining=await repository.challenge(a,b);
    assert.equal((await repository.decline(b,declining.id)).status,'cancelled');
    assert.equal((await repository.decline(a,declining.id)).status,'cancelled');
    await assert.rejects(database.transaction(async client=>{
      await client.query('update private.battles set rules=$2 where id=$1',[declining.id,{format:'singles',levels:'earned',ranked:true}]);
    }),{code:'23514'});
    assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,before,
      'Battle admission, inputs, completion or expiry edited an authoritative adventure.');
    assert.equal((await database.pool.query("select count(*)::int as n from private.game_sessions where owner_id in ($1,$2) and status='lobby'",[a,b])).rows[0].n,2);
  }finally{await database.pool.query('rollback to savepoint battle_contract');}
}
