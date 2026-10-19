import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { AtomicTrading } from '../packages/trading/atomic-trade.ts';
import { fixtureArtifact } from './fixture-engine.ts';
import type {SessionOptions} from '../apps/server/src/sessions.ts';

test('real Postgres enforces ownership, atomic trades, packed recovery, journal replay and session fencing',
  { skip: !process.env.DATABASE_TEST_URL }, async () => {
    const { default: pg } = await import('pg');
    const { PostgresTrades } = await import('../apps/server/src/trade-repository.ts');
    const client = new pg.Client({ connectionString: process.env.DATABASE_TEST_URL, statement_timeout: 5000 });
    await client.connect();
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    const saveA = '00000000-0000-4000-8000-000000000003';
    const saveB = '00000000-0000-4000-8000-000000000004';
    const tradeId = '00000000-0000-4000-8000-000000000005';
    let savepoint = 0;
    try {
      await client.query('begin');
      const existing = await client.query("select to_regclass('public.profiles') as profiles");
      assert.equal(existing.rows[0].profiles, null, 'Use an empty disposable database, not an existing project.');
      await client.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
        do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
        do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
        create schema if not exists auth;
        create table if not exists auth.users(id uuid primary key);
        create or replace function auth.uid() returns uuid language sql stable as $$
          select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
      await client.query(await readFile(new URL('../supabase/schemas/001_kanto.sql', import.meta.url), 'utf8'));
      await client.query('insert into auth.users(id) values($1),($2)', [a,b]);
      await client.query("insert into public.profiles(id,handle) values($1,'Alice'),($2,'Bob')", [a,b]);
      await client.query('insert into private.adventures(id,owner_id,version,flash) values($1,$2,$3,$4),($5,$6,$7,$8)',
        [saveA,a,'firered',Buffer.alloc(131072,1),saveB,b,'leafgreen',Buffer.alloc(131072,2)]);
      await client.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status)
        values(gen_random_uuid(),$1,$2,'test-contract',1,0,'lobby'),(gen_random_uuid(),$3,$4,'test-contract',2,0,'lobby')`, [a,saveA,b,saveB]);
      await client.query(`insert into private.trades(id,player_a,player_b,adventure_a,adventure_b,offer_a,offer_b,confirmed_a,confirmed_b)
        values($1,$2,$3,$4,$5,$6,$7,true,true)`, [tradeId,a,b,saveA,saveB,
          { partySlot: 0, pokemonDigest: 'a'.repeat(64), saveRevision: 0 },
          { partySlot: 0, pokemonDigest: 'b'.repeat(64), saveRevision: 0 }]);
      const database = {
        pool: { query: client.query.bind(client) },
        async transaction<T>(body: (connection: typeof client) => Promise<T>): Promise<T> {
          const name = `trade_test_${++savepoint}`;
          await client.query(`savepoint ${name}`);
          try { const result = await body(client); await client.query(`release savepoint ${name}`); return result; }
          catch (error) { await client.query(`rollback to savepoint ${name}`); throw error; }
        },
      };
      const repository = new PostgresTrades(database as unknown as import('../apps/server/src/database.ts').Database);
      const service = new AtomicTrading(repository, { async swap(trade) {
        assert.equal(trade.saveA.version, 'firered');
        assert.equal(trade.saveB.version, 'leafgreen');
        return { flashA: trade.saveB.flash.slice(), flashB: trade.saveA.flash.slice(), result: { contractTest: true } };
      } });
      const receipt = await service.complete(tradeId,a,0);
      assert.deepEqual(await service.complete(tradeId,b,0), receipt);
      const saves = await client.query('select id,revision,flash from private.adventures order by id');
      assert.equal(saves.rows[0].flash[0],2); assert.equal(saves.rows[1].flash[0],1);
      assert.equal(Number(saves.rows[0].revision),1); assert.equal(Number(saves.rows[1].revision),1);
      const superseded = await client.query('select count(*)::integer as count from private.game_sessions where superseded_at is not null');
      assert.equal(superseded.rows[0].count,2);
      // Exercise real session/database methods inside the disposable test's
      // outer rollback. Only the tiny runtime-contract artifact is used here;
      // original-game execution is covered separately by the engine checks.
      const { Database } = await import('../apps/server/src/database.ts');
      const { Sessions } = await import('../apps/server/src/sessions.ts');
      const { EngineRegistry } = await import('../packages/engine/registry.ts');
      const sessionDatabase = Object.assign(Object.create(Database.prototype), database, {
        // The contract fixture has no dedicated connection; the app's presence
        // service must fail closed instead of opening a stray listener.
        listen: async () => { throw new Error('The database contract fixture has no dedicated listener.'); },
      }) as InstanceType<typeof Database>;
      const directory = await mkdtemp(join(tmpdir(), 'kanto-session-contract-'));
      const managedSessions:InstanceType<typeof Sessions>[]=[];
      try {
        const artifact = fixtureArtifact();
        await writeFile(join(directory, 'firered.json'), JSON.stringify(artifact.manifest));
        await writeFile(join(directory, 'firered.wasm'), artifact.bytes);
        const registry = new EngineRegistry();
        await registry.load(directory, false);
        // Explicit arithmetic-fixture persistence adapter. Production lobby
        // preparation uses the original C implementation in the game worker.
        const sessionOptions:SessionOptions={inspection:registry,prepareLobby:async(version,seed,point)=>{
          const staged=await registry.prepareLobby(version,seed,registry.decodeCheckpoint(version,gunzipSync(point)));
          return {...staged,checkpoint:gzipSync(registry.encodeCheckpoint(version,staged.snapshot),{level:1})};
        }};
        // Exercise several same-edition rows ahead of the permanent schema
        // migration. This savepoint restores the legacy unique constraint and
        // all fixture saves; no hosted schema is changed by this check.
        await client.query('savepoint selected_adventure_contract');
        const selection=new Sessions(sessionDatabase,registry,sessionOptions);
        try{
          await client.query('alter table private.adventures drop constraint adventures_owner_id_version_key');
          const alternate=randomUUID();
          await client.query("insert into private.adventures(id,owner_id,version,flash) values($1,$2,'firered',$3)",[alternate,a,Buffer.alloc(131072,99)]);
          const untouched=(await client.query('select flash,revision from private.adventures where id=$1',[saveA])).rows[0];
          await assert.rejects(selection.start(a,'firered'),{code:'ADVENTURE_SELECTION_REQUIRED'});
          await assert.rejects(selection.start(a,'firered','invalid'),{code:'INVALID_ADVENTURE'});
          await assert.rejects(selection.start(a,'firered',saveB),{code:'ADVENTURE_NOT_FOUND'});
          await assert.rejects(selection.start(randomUUID(),'firered',saveA),{code:'TRAINER_REQUIRED'});
          const chosen=await selection.start(a,'firered',alternate);assert.equal(chosen.adventureId,alternate);
          assert.equal((await client.query('select adventure_id from private.game_sessions where id=$1',[chosen.id])).rows[0].adventure_id,alternate);
          const chosenFence=selection.connectionFence(a,chosen.id);
          await assert.rejects(selection.start(a,'firered',saveA),{code:'ADVENTURE_ACTIVE'});
          await assert.rejects(selection.start(a,'firered',saveB),{code:'ADVENTURE_NOT_FOUND'});
          assert.equal(selection.connectionFence(a,chosen.id),chosenFence,'Invalid selection disturbed the active adventure.');
          selection.resume(a,chosen.id,chosenFence);
          await selection.accept(a,chosen.id,{type:'input',protocol:1,sessionId:chosen.id,sequence:0,operationId:randomUUID(),startFrame:0,runs:[{buttons:16,frames:5}]},chosenFence);
          await selection.exit(a,chosen.id);
          assert.deepEqual((await client.query('select flash,revision from private.adventures where id=$1',[saveA])).rows[0],untouched);
          const original=await selection.start(a,'firered',saveA);assert.equal(original.adventureId,saveA);assert.notEqual(original.id,chosen.id);assert.equal(original.frame,0);
          await selection.exit(a,original.id);
          await client.query("update private.game_sessions set status='lobby' where id=$1",[original.id]);
          const fromLobby=await selection.leaveLobby(a);assert.equal(fromLobby.adventureId,saveA);
          await selection.exit(a,fromLobby.id);
        }finally{await selection.close();await client.query('rollback to savepoint selected_adventure_contract');}
        const first=new Sessions(sessionDatabase,registry,sessionOptions);
        const second=new Sessions(sessionDatabase,registry,sessionOptions);
        const legacy=new Sessions(sessionDatabase,registry,sessionOptions);
        managedSessions.push(first,second,legacy);
        const bootstrap = await first.start(a, 'firered');
        const oldFence = first.connectionFence(a, bootstrap.id);
        first.resume(a, bootstrap.id, oldFence);
        const firstAck = await first.accept(a, bootstrap.id, { type: 'input', protocol: 1,
          sessionId: bootstrap.id, sequence: 0, operationId: randomUUID(), startFrame: 0,
          runs: [{ buttons: 16, frames: 10 }] }, oldFence);
        const checkpoint = await first.checkpoint(a, bootstrap.id, oldFence);
        const packed = gunzipSync(checkpoint.bytes);
        assert.equal(packed.subarray(0, 8).toString('ascii'), 'KCPAGE01');
        assert.equal(checkpoint.frame, 10); assert.equal(checkpoint.sequence, 1);
        const reference = await registry.create('firered', bootstrap.seed, Buffer.alloc(131072, 2));
        try {
          reference.advance([{ buttons: 16, frames: 10 }]);
          assert.equal(reference.digest(), firstAck.digest);
          reference.restore(registry.decodeCheckpoint('firered', packed));
          assert.equal(reference.digest(), firstAck.digest);
          first.resume(a, bootstrap.id, oldFence);
          const secondAck = await first.accept(a, bootstrap.id, { type: 'input', protocol: 1,
            sessionId: bootstrap.id, sequence: 1, operationId: randomUUID(), startFrame: 10,
            runs: [{ buttons: 1, frames: 5 }] }, oldFence);
          // Simulate a lost process lease without allowing it to write a newer
          // checkpoint. The fresh process must replay the committed journal.
          await client.query("update private.game_sessions set lease_expires_at=now()-interval '1 second' where id=$1", [bootstrap.id]);
          const recovered = await second.start(a, 'firered');
          assert.equal(recovered.id, bootstrap.id);
          assert.equal(recovered.frame, 15); assert.equal(recovered.nextSequence, 2);
          assert.equal(recovered.digest, secondAck.digest);
          await assert.rejects(first.checkpoint(a, bootstrap.id, oldFence), { code: 'SESSION_LEASE_LOST' });
          await assert.rejects(first.start(a,'firered'),{code:'SESSION_ACTIVE_ELSEWHERE'},'A stale local runtime stole the current worker lease.');
          const checkpointMethod = second.checkpoint.bind(second);
          let reachedCheckpoint!: () => void, releaseExit!: () => void;
          const reached = new Promise<void>(resolve => { reachedCheckpoint = resolve; });
          const release = new Promise<void>(resolve => { releaseExit = resolve; });
          second.checkpoint = async (...args) => {
            const point = await checkpointMethod(...args);
            reachedCheckpoint(); await release; return point;
          };
          const exiting = second.exit(a, recovered.id);
          await reached;
          try {
            assert.throws(() => second.resume(a, recovered.id), { code: 'SESSION_CLOSING' });
            await assert.rejects(second.accept(a, recovered.id, { type: 'input', protocol: 1,
              sessionId: recovered.id, sequence: 2, operationId: randomUUID(), startFrame: 15,
              runs: [{ buttons: 2, frames: 1 }] }), { code: 'SESSION_CLOSING' });
          } finally { releaseExit(); }
          await exiting;
          second.checkpoint = checkpointMethod;
          // Returning to a process that still holds the old fenced instance
          // must discard it and recover durable state, rather than get stuck.
          const returned = await first.start(a, 'firered');
          assert.equal(returned.frame, 15); assert.equal(returned.digest, secondAck.digest);
          await first.exit(a, returned.id);
          // Existing private full-memory checkpoints remain recoverable.
          reference.advance([{ buttons: 1, frames: 5 }]);
          assert.equal(reference.digest(), secondAck.digest);
          const mirrored = await client.query('select flash from private.adventures where id=$1', [saveA]);
          assert.equal(mirrored.rows[0].flash[0], 1, 'Exit retained the old cartridge instead of verified game output.');
          assert.deepEqual(new Uint8Array(mirrored.rows[0].flash), reference.flash());
          await client.query('update private.game_sessions set checkpoint=$2 where id=$1',
            [bootstrap.id, gzipSync(reference.snapshot(), { level: 1 })]);
          const oldFormat = await legacy.start(a, 'firered');
          assert.equal(oldFormat.frame, 15); assert.equal(oldFormat.digest, secondAck.digest);
          await legacy.exit(a, oldFormat.id);
          await client.query("insert into private.adventures(owner_id,version) values($1,'firered')", [b]);
          const empty=new Sessions(sessionDatabase,registry,sessionOptions);managedSessions.push(empty);
          const fresh = await empty.start(b, 'firered');
          await empty.exit(b, fresh.id);
          const erased = await client.query("select flash from private.adventures where owner_id=$1 and version='firered'", [b]);
          assert.equal(erased.rows[0].flash, null, 'An erased cartridge was presented as an original-menu save.');
          const {checkAdventureDisconnect}=await import('./adventure-disconnect.ts');
          await checkAdventureDisconnect(sessionDatabase,registry,sessionOptions,[a,b]);
          const {checkAdventureBootstrap}=await import('./adventure-bootstrap.ts');
          await checkAdventureBootstrap(sessionDatabase,registry,sessionOptions,[a,b]);
          // Persistence-only save transformation for the tiny arithmetic
          // fixture. Real original-C lobby eligibility/save rules are checked
          // separately by engine:check-lobby; this is never a game adapter.
          const stageFixture = async (version: 'firered'|'leafgreen', seed: number, snapshot: Uint8Array) => {
            const transformed = snapshot.slice(); transformed[12] = 99; transformed[65536 + 100] = 42;
            const saved = await registry.create(version, seed);
            try {
              saved.restore(transformed);
              return { snapshot: transformed, flash: saved.flash(), party: [], frame: saved.frame, digest: saved.digest() };
            } finally { saved.close(); }
          };
          registry.lobbyParty = async () => [];
          let reachedSave!: () => void, finishSave!: () => void;
          const reachedSavePoint = new Promise<void>(resolve => { reachedSave = resolve; });
          const finishSavePoint = new Promise<void>(resolve => { finishSave = resolve; });
          registry.prepareLobby = async (...args) => { reachedSave(); await finishSavePoint; return stageFixture(...args); };
          const lobbyStart = await second.start(a, 'firered');
          const lobbyFence = second.connectionFence(a, lobbyStart.id);
          const beforeLobby = (await client.query('select revision,flash from private.adventures where id=$1', [saveA])).rows[0];
          const moving = second.enterLobby(a, lobbyStart.id, lobbyFence);
          const rejectedMove = assert.rejects(moving, { code: 'SESSION_LEASE_LOST' });
          await reachedSavePoint;
          assert.throws(() => second.resume(a, lobbyStart.id, lobbyFence), { code: 'SESSION_CHANGING' });
          await assert.rejects(second.accept(a, lobbyStart.id, { type: 'input', protocol: 1,
            sessionId: lobbyStart.id, sequence: 2, operationId: randomUUID(), startFrame: 15,
            runs: [{ buttons: 0, frames: 1 }] }, lobbyFence), { code: 'SESSION_CHANGING' });
          // Lose the lease while original save preparation is in progress.
          // The staged cartridge and system checkpoint must not be committed.
          await client.query("update private.game_sessions set fence=fence+1,lease_expires_at=now() where id=$1", [lobbyStart.id]);
          finishSave(); await rejectedMove;
          const afterFailedLobby = (await client.query('select revision,flash from private.adventures where id=$1', [saveA])).rows[0];
          assert.deepEqual(afterFailedLobby, beforeLobby);
          registry.prepareLobby = stageFixture;
          const ready = await second.start(a, 'firered');
          assert.equal(ready.digest, lobbyStart.digest);
          await assert.rejects(second.enterLobby(b, ready.id), { code: 'SESSION_NOT_FOUND' });
          const lobby = await second.enterLobby(a, ready.id);
          assert.equal(lobby.saveRevision, Number(beforeLobby.revision) + 1);
          assert.deepEqual(await second.enterLobby(a, ready.id), lobby, 'Retry saved and incremented the cartridge twice.');
          await assert.rejects(second.start(a, 'firered'), { code: 'ADVENTURE_BUSY' });
          const stagedRow = (await client.query('select checkpoint,checkpoint_frame,checkpoint_sequence from private.game_sessions where id=$1', [ready.id])).rows[0];
          assert.equal(Number(stagedRow.checkpoint_frame), 15);
          assert.equal(Number(stagedRow.checkpoint_sequence), 2);
          const stagedSnapshot = registry.decodeCheckpoint('firered', gunzipSync(stagedRow.checkpoint));
          assert.equal(stagedSnapshot[12], 99); assert.equal(stagedSnapshot[65536 + 100], 42);
          const bob = await empty.start(b, 'firered');
          await empty.enterLobby(b, bob.id);
          assert.deepEqual(await second.lobbyTrainers(a), [{ id: b, handle: 'Bob', version: 'firered', party: [], maxLevel: null }]);
          await client.query("update private.game_sessions set lease_expires_at=now()-interval '1 second' where owner_id=$1 and status='lobby'", [b]);
          assert.deepEqual(await second.lobbyTrainers(a), []);
          await empty.lobbyState(b);
          assert.equal((await second.lobbyTrainers(a)).length, 1);
          await client.query('update public.profiles set suspended_at=now() where id=$1', [b]);
          assert.deepEqual(await second.lobbyTrainers(a), []);
          await client.query('update public.profiles set suspended_at=null where id=$1', [b]);
          const returnedFromLobby = await second.leaveLobby(a);
          assert.equal(returnedFromLobby.frame, 15); assert.equal(returnedFromLobby.nextSequence, 2);
          assert.notEqual(returnedFromLobby.digest, ready.digest, 'The pre-save runtime was restored after lobby exit.');
          const afterLeave = await second.checkpoint(a, returnedFromLobby.id);
          assert.deepEqual(registry.decodeCheckpoint('firered', gunzipSync(afterLeave.bytes)), stagedSnapshot);
          assert.equal(afterLeave.flash[100], 42);
          await second.exit(a, returnedFromLobby.id);
          const bobReturn = await empty.leaveLobby(b); await empty.exit(b, bobReturn.id);
          // Offer/orchestration contract fixtures only. The original C rules
          // and Pokemon bytes are exercised by the real engine qualification.
          let bobEgg = true;
          registry.lobbyParty = async (_version, _seed, flash) => [0, 1].map(slot => ({
            slot, personality: slot + 1, trainerId: flash[0] === 255 ? 2 : 1, species: slot ? 16 : 1,
            nickname: slot ? 'PIDGEY' : 'BULBASAUR', speciesName: slot ? 'PIDGEY' : 'BULBASAUR',
            level: 5, hp: 20, maxHp: 20, heldItem: 0, friendship: 70,
            isEgg: flash[0] === 255 && bobEgg && slot === 0, checksum: 1, badEgg: false,
            moves: [33, 0, 0, 0], pp: [30, 0, 0, 0],
            digest: (flash[0] === 255 ? slot ? 'd' : 'b' : slot ? 'c' : 'a').repeat(64),
          }));
          let tradeCodes = { a: 0, b: 0 };
          registry.tradeChecks = async () => tradeCodes;
          const { TradeOffers } = await import('../apps/server/src/trade-offers.ts');
          const offers=new TradeOffers(sessionDatabase,registry,registry);
          const aliceBoot = await second.start(a, 'firered'); await second.enterLobby(a, aliceBoot.id);
          const bobBoot = await empty.start(b, 'firered'); await empty.enterLobby(b, bobBoot.id);
          const aliceLobby = await second.lobbyState(a), bobLobby = await empty.lobbyState(b);
          const beforeOffers = (await client.query('select id,revision,flash from private.adventures order by id')).rows;
          const invitation = await offers.invite(a, b);
          assert.equal((await offers.invite(b, a)).id, invitation.id, 'Reverse invitation created a duplicate pair.');
          await assert.rejects(offers.invite(a, a), { code: 'INVALID_TRADE' });
          await assert.rejects(offers.get('00000000-0000-4000-8000-000000000099', invitation.id), { code: 'TRADE_NOT_FOUND' });
          await assert.rejects(offers.confirm(a, invitation.id, 0), { code: 'OFFERS_REQUIRED' });
          const pickA = { partySlot: 0, pokemonDigest: 'a'.repeat(64), saveRevision: aliceLobby.saveRevision };
          const pickB = { partySlot: 0, pokemonDigest: 'b'.repeat(64), saveRevision: bobLobby.saveRevision };
          await assert.rejects(offers.offer(a, invitation.id, 0, { ...pickA, pokemonDigest: '0'.repeat(64) }), { code: 'POKEMON_CHANGED' });
          await assert.rejects(offers.offer(a, invitation.id, 0, { ...pickA, saveRevision: pickA.saveRevision + 1 }), { code: 'SAVE_CHANGED' });
          await assert.rejects(offers.offer(a, invitation.id, 0, { ...pickA, partySlot: 6 }), { code: 'INVALID_TRADE' });
          const firstOffer = await offers.offer(a, invitation.id, 0, pickA);
          assert.equal(firstOffer.offerRevision, 1);
          await assert.rejects(offers.offer(b, invitation.id, 0, pickB), { code: 'TRADE_CHANGED' });
          const secondOffer = await offers.offer(b, invitation.id, 1, pickB);
          assert.equal(secondOffer.offerB!.pokemon!.isEgg, true);
          assert.equal(secondOffer.offerB!.pokemon!.speciesName, null, 'Offer disclosed an unhatched Egg species.');
          assert.equal(secondOffer.offerB!.pokemon!.level, null);
          tradeCodes = { a: 1, b: 0 };
          await assert.rejects(offers.confirm(a, invitation.id, 2), { code: 'TRADE_NOT_ALLOWED' });
          assert.equal((await offers.get(a, invitation.id)).confirmedA, false);
          tradeCodes = { a: 0, b: 0 };
          assert.equal((await offers.confirm(a, invitation.id, 2)).confirmedA, true);
          assert.equal((await offers.confirm(b, invitation.id, 2)).confirmedB, true);
          const changed = await offers.offer(b, invitation.id, 2, { ...pickB, partySlot: 1, pokemonDigest: 'd'.repeat(64) });
          assert.equal(changed.offerRevision, 3); assert(!changed.confirmedA && !changed.confirmedB);
          await assert.rejects(offers.confirm(a, invitation.id, 2), { code: 'TRADE_CHANGED' });
          await offers.confirm(a, invitation.id, 3); await offers.confirm(b, invitation.id, 3);
          const otherVersion = (await client.query("insert into private.adventures(owner_id,version,flash) values($1,'leafgreen',$2) returning id", [a, Buffer.alloc(131072, 1)])).rows[0].id;
          await client.query('update private.game_sessions set adventure_id=$2 where id=$1', [aliceBoot.id, otherVersion]);
          await assert.rejects(repository.reserve(invitation.id, a, 3), { code: 'TRAINER_NOT_READY' });
          await assert.rejects(offers.confirm(a, invitation.id, 3), { code: 'TRAINER_NOT_READY' });
          await client.query('update private.game_sessions set adventure_id=$2 where id=$1', [aliceBoot.id, saveA]);
          assert.equal((await offers.cancel(b, invitation.id, 3)).status, 'cancelled');
          assert.equal((await offers.cancel(a, invitation.id, 3)).status, 'cancelled');
          const afterOffers = (await client.query('select id,revision,flash from private.adventures where id<>$1 order by id', [otherVersion])).rows;
          assert.deepEqual(afterOffers, beforeOffers, 'Invitations/offers/confirmations edited authoritative cartridges.');
          const expiring = await offers.invite(a, b);
          await client.query("update private.trades set expires_at=now()-interval '1 second' where id=$1", [expiring.id]);
          await assert.rejects(offers.offer(a, expiring.id, 0, pickA), { code: 'TRADE_EXPIRED' });
          assert.equal((await offers.get(a, expiring.id)).status, 'expired');
          assert.deepEqual(await offers.list(a), []);
          const {checkBattleDatabase}=await import('./battle-postgres.ts');
          await checkBattleDatabase(sessionDatabase,a,b);
          const {checkQuickMatch}=await import('./quick-match-postgres.ts');
          await checkQuickMatch(sessionDatabase,a,b);
          // Scene storage contracts use opaque bytes, not pretend Pokemon
          // mechanics. Real C restoration is qualified in the engine checks.
          await client.query('savepoint scene_contract');
          try {
            const { TradeSceneStore } = await import('../apps/server/src/trade-scene-store.ts');
            const store = new TradeSceneStore(sessionDatabase);
            const staged = await offers.invite(a,b);
            await offers.offer(a,staged.id,0,pickA); await offers.offer(b,staged.id,1,pickB);
            await offers.confirm(a,staged.id,2); await offers.confirm(b,staged.id,2);
            const reserved = await repository.reserve(staged.id,a,2);
            assert(reserved.expiresAt > Date.now()+9*60_000);
            assert.deepEqual(await repository.reserved(staged.id,b,2),reserved);
            await assert.rejects(repository.reserve(staged.id,a,2),{ code:'TRADE_BUSY' });
            const initial = [
              { id:randomUUID(),ownerId:a,adventureId:saveA,side:'a' as const,artifactId:'scene-contract',seed:1,checkpoint:Buffer.from('initial-a') },
              { id:randomUUID(),ownerId:b,adventureId:reserved.saveB.id,side:'b' as const,artifactId:'scene-contract',seed:2,checkpoint:Buffer.from('initial-b') },
            ] satisfies [import('../apps/server/src/trade-scene-store.ts').NewScene,import('../apps/server/src/trade-scene-store.ts').NewScene];
            await assert.rejects(store.initialize(reserved,[{...initial[0],ownerId:b},initial[1]]),{ code:'INVALID_TRADE_SCENE' });
            await store.initialize(reserved,initial); await store.initialize(reserved,initial);
            await assert.rejects(store.row('00000000-0000-4000-8000-000000000099',staged.id),{ code:'TRADE_SCENE_NOT_FOUND' });
            const sceneA = await store.claim(a,staged.id), sceneB = await store.claim(b,staged.id);
            await assert.rejects(store.claim(a,staged.id),{ code:'TRADE_SCENE_ACTIVE_ELSEWHERE' });
            const entry = { batch:{ type:'input' as const,protocol:1 as const,sessionId:sceneA.id,operationId:randomUUID(),sequence:0,startFrame:0,
              runs:[{ buttons:0,frames:10 }] },fingerprint:'e'.repeat(64),acknowledgement:{ type:'verified' as const,protocol:1 as const,
              operationId:'scene-ack',sequence:0,frame:10,digest:'f'.repeat(64) } };
            await assert.rejects(store.append(sceneA.id,Number(sceneA.fence)-1,entry),{ code:'TRADE_SCENE_LEASE_LOST' });
            await store.append(sceneA.id,Number(sceneA.fence),entry);
            assert.deepEqual(await store.find(sceneA.id,0),entry);
            const conflicting = { ...entry,batch:{ ...entry.batch,sequence:1,startFrame:10 },acknowledgement:{ ...entry.acknowledgement,sequence:1,frame:20 } };
            await assert.rejects(store.append(sceneA.id,Number(sceneA.fence),conflicting),{ code:'23505' });
            assert.equal(Number((await store.row(a,staged.id)).next_sequence),1,'A failed journal insert advanced the scene.');
            await store.checkpoint(sceneA.id,Number(sceneA.fence),{ bytes:Buffer.from('checkpoint'),frame:10,sequence:1 });
            await store.expireLease(sceneA.id,Number(sceneA.fence));
            await assert.rejects(store.checkpoint(sceneA.id,Number(sceneA.fence),{ bytes:Buffer.from('late'),frame:10,sequence:1 }),{ code:'TRADE_SCENE_LEASE_LOST' });
            const recovered = await store.claim(a,staged.id);
            assert(Number(recovered.fence)>Number(sceneA.fence));
            assert.equal(recovered.checkpoint!.toString(),'checkpoint');
            assert.deepEqual(await store.entries(sceneA.id,0),[entry]);
            const finishedA = { ...conflicting,batch:{ ...conflicting.batch,operationId:randomUUID() } };
            const outputA=Buffer.alloc(131072,7),outputB=Buffer.alloc(131072,8);
            await store.append(sceneA.id,Number(recovered.fence),finishedA,outputA);
            assert.equal((await store.completed(staged.id)).length,1);
            await assert.rejects(repository.commit(reserved,{ flashA:outputA,flashB:outputB,result:{} }),{ code:'TRADE_SCENES_INCOMPLETE' });
            const unchanged = (await client.query('select id,revision,flash from private.adventures where id<>$1 order by id',[otherVersion])).rows;
            assert.deepEqual(unchanged,beforeOffers,'One finished scene edited adventure saves.');
            const finishedB = { ...entry,batch:{ ...entry.batch,sessionId:sceneB.id,operationId:randomUUID() } };
            await store.append(sceneB.id,Number(sceneB.fence),finishedB,outputB);
            await assert.rejects(repository.commit(reserved,{ flashA:outputB,flashB:outputA,result:{} }),{ code:'TRADE_SCENES_INCOMPLETE' });
            const committed = await repository.commit(reserved,{ flashA:outputA,flashB:outputB,result:{ sceneContract:true } });
            assert.deepEqual(await repository.commit(reserved,{ flashA:outputA,flashB:outputB,result:{} }),committed);
          } finally { await client.query('rollback to savepoint scene_contract'); }
          for(const abort of ['cancel','expiry'] as const) {
          await client.query('savepoint scene_abort_contract');
          try {
            const { TradeSceneStore } = await import('../apps/server/src/trade-scene-store.ts');
            const store = new TradeSceneStore(sessionDatabase), staged = await offers.invite(a,b);
            await offers.offer(a,staged.id,0,pickA); await offers.offer(b,staged.id,1,pickB);
            await offers.confirm(a,staged.id,2); await offers.confirm(b,staged.id,2);
            const reserved = await repository.reserve(staged.id,a,2);
            await store.initialize(reserved,[
              { id:randomUUID(),ownerId:a,adventureId:reserved.saveA.id,side:'a',artifactId:'scene-contract',seed:1,checkpoint:Buffer.from('a') },
              { id:randomUUID(),ownerId:b,adventureId:reserved.saveB.id,side:'b',artifactId:'scene-contract',seed:2,checkpoint:Buffer.from('b') },
            ]);
            const running = await store.claim(a,staged.id);
            const { TradeScenes }=await import('../apps/server/src/trade-scenes.ts');
            const scenes=new TradeScenes(registry,repository,store,offers);
            if(abort==='expiry') {
              await client.query("update private.trades set expires_at=now()-interval '1 second' where id=$1",[staged.id]);
              await scenes.expire();await scenes.expire();
            } else {await scenes.cancel(b,staged.id);await scenes.cancel(a,staged.id);}
            assert.equal((await offers.get(a,staged.id)).status,abort==='expiry'?'expired':'cancelled');
            assert.equal((await store.row(a,staged.id)).status,'aborted');
            await assert.rejects(scenes.finish(a,staged.id),{code:'TRADE_CANCELLED'});
            assert.equal((await client.query("select count(*)::int as n from private.game_sessions where owner_id in ($1,$2) and status='lobby'",[a,b])).rows[0].n,2);
            await assert.rejects(store.claim(a,staged.id,Number(running.fence)),{ code:'TRADE_CHANGED' });
            assert.deepEqual((await client.query('select id,revision,flash from private.adventures where id<>$1 order by id',[otherVersion])).rows,beforeOffers);
          } finally { await client.query('rollback to savepoint scene_abort_contract'); }
          }
          const aliceReturn = await second.leaveLobby(a); await second.exit(a, aliceReturn.id);
          const bobResume = await empty.leaveLobby(b); await empty.exit(b, bobResume.id);
          bobEgg = false;
          // Exercise real HTTP authentication and the WebSocket handoff. This
          // isolated provider fixture implements Auth's get-user contract; it
          // is not a hosted Supabase account service or a production bypass.
          const authServer = createServer((request, response) => {
            const supplied = request.headers.authorization;
            const id = supplied === 'Bearer fixture-alice' ? a : supplied === 'Bearer fixture-bob' || supplied === 'Bearer fixture-unconfirmed' ? b : undefined;
            response.setHeader('Content-Type', 'application/json');
            if (request.url !== '/auth/v1/user' || !id) { response.writeHead(401); response.end(JSON.stringify({ message: 'Invalid fixture token.' })); return; }
            response.end(JSON.stringify({ id, aud: 'authenticated', email: 'fixture@example.invalid',
              email_confirmed_at: supplied === 'Bearer fixture-unconfirmed' ? null : '2026-10-16T00:00:00Z',
              app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-10-16T00:00:00Z' }));
          });
          await new Promise<void>(resolve => authServer.listen(0, '127.0.0.1', resolve));
          const authAddress = authServer.address();
          assert(authAddress && typeof authAddress !== 'string');
          const { createApp } = await import('../apps/server/src/app.ts');
          const app = await createApp({ origin: 'http://kanto-fixture.invalid', engineDirectory: directory,
            supabaseUrl: `http://127.0.0.1:${authAddress.port}`, publishableKey: 'fixture-publishable-key', publicRelease: false },
          {database:sessionDatabase,registry,sessionOptions});
          try {
            const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
            assert.equal((await app.inject({ method: 'GET', url: '/api/lobby' })).statusCode, 401);
            assert.equal((await app.inject({ method: 'GET', url: '/api/lobby', headers: { authorization: 'Bearer fixture-unconfirmed' } })).statusCode, 403);
            const headers = { authorization: 'Bearer fixture-alice' };
            const started = await app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { version: 'firered' } });
            assert.equal(started.statusCode, 200, started.body);
            const boot = started.json();
            const connection = new WebSocket(baseUrl.replace('http:', 'ws:') + '/api/play', { headers: { origin: 'http://kanto-fixture.invalid' } });
            const waitMessage = () => new Promise<any>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Fixture WebSocket response timed out.')), 5000);
              connection.once('message', data => { clearTimeout(timeout); resolve(JSON.parse(data.toString())); });
            });
            try {
              await new Promise<void>((resolve, reject) => { connection.once('open', resolve); connection.once('error', reject); });
              const readyMessage = waitMessage();
              connection.send(JSON.stringify({ type: 'authenticate', protocol: 1, token: 'fixture-alice', sessionId: boot.id }));
              assert.equal((await readyMessage).type, 'ready');
              const beforeRefresh=(await client.query('select frame,next_sequence,fence,checkpoint from private.game_sessions where id=$1',[boot.id])).rows[0];
              const refreshMessage=waitMessage();
              connection.send(JSON.stringify({type:'refresh-auth',protocol:1,token:'fixture-alice'}));
              assert.deepEqual(await refreshMessage,{type:'auth-refreshed',protocol:1});
              assert.deepEqual((await client.query('select frame,next_sequence,fence,checkpoint from private.game_sessions where id=$1',[boot.id])).rows[0],beforeRefresh,
                'Authentication renewal changed verified game state.');
              const pauseMessage = waitMessage(); connection.send(JSON.stringify({ type: 'pause' }));
              assert.equal((await pauseMessage).type, 'paused');
              const denied = await app.inject({ method: 'POST', url: `/api/sessions/${boot.id}/lobby`, headers: { authorization: 'Bearer fixture-bob' } });
              assert.equal(denied.statusCode, 404);
              const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Lobby did not close the owning game socket.')), 5000);
                connection.once('close', (code, reason) => { clearTimeout(timeout); resolve({ code, reason: reason.toString() }); });
              });
              const entered = await app.inject({ method: 'POST', url: `/api/sessions/${boot.id}/lobby`, headers });
              assert.equal(entered.statusCode, 200, entered.body);
              assert.deepEqual(await closed, { code: 1000, reason: 'Entered lobby' });
              assert.equal((await app.inject({ method: 'GET', url: '/api/lobby', headers })).statusCode, 200);
              assert.equal((await app.inject({ method: 'GET', url: '/api/lobby/trainers', headers })).statusCode, 200);
              const {checkLobbyDiscovery}=await import('./lobby-discovery.ts');
              await checkLobbyDiscovery(sessionDatabase,app);
              const {checkQuickMatchHttp}=await import('./quick-match-http.ts');
              await checkQuickMatchHttp(sessionDatabase,app,a,b);
              const {checkLobbyPresence}=await import('./lobby-presence-journey.ts');
              await checkLobbyPresence(sessionDatabase);
              assert.equal((await app.inject({ method: 'POST', url: '/api/lobby/leave', headers })).statusCode, 200);
            } finally { connection.close(); }
          } finally {
            await app.close();
            await new Promise<void>((resolve, reject) => authServer.close(error => error ? reject(error) : resolve()));
          }
        } finally { reference.close(); }
      }finally{
        const closed=await Promise.allSettled(managedSessions.map(service=>service.close()));
        await rm(directory,{recursive:true,force:true});
        for(const result of closed)if(result.status==='rejected')throw result.reason;
      }
      await client.query('savepoint handle_check');
      await assert.rejects(client.query('update public.profiles set handle=$1 where id=$2', ['aLiCe',b]), { code: '23505' });
      await client.query('rollback to savepoint handle_check');
      await client.query("select set_config('request.jwt.claim.sub',$1,true)",[a]);
      await client.query('set local role authenticated');
      const own = await client.query('select id,handle from public.profiles');
      assert.deepEqual(own.rows,[{ id:a, handle:'Alice' }]);
      await client.query('savepoint private_check');
      await assert.rejects(client.query('select id from private.adventures'), { code:'42501' });
      await client.query('rollback to savepoint private_check');
      for(const table of ['battles','battle_runs','battle_commands','battle_input_journal']){
        await client.query('savepoint private_battle_check');
        await assert.rejects(client.query(`select * from private.${table}`),{code:'42501'});
        await client.query('rollback to savepoint private_battle_check');
      }
      await client.query('reset role');
      if(process.env.KANTO_CHECK_HOSTING_READINESS==='1'){
        const {checkActualDatabaseReadiness}=await import('./hosting-readiness.integration.ts');
        await checkActualDatabaseReadiness(process.env.DATABASE_TEST_URL!);
      }
      if(process.env.KANTO_CHECK_EARNED_TRADE_JOURNEY==='1'){
        const {checkEarnedTradeJourney}=await import('./earned-trade-journey.ts');
        await checkEarnedTradeJourney(sessionDatabase,[a,b],[saveA,saveB]);
      }
      if(process.env.KANTO_CHECK_AUDIO_GAME_UI==='1'){
        const {checkAudioGameUi}=await import('./audio-game-ui-qualification.ts');
        await checkAudioGameUi(sessionDatabase,a);
      }
      if(process.env.KANTO_CHECK_ADVENTURE_WORKERS==='1'){
        const {checkOriginalAdventureWorkers}=await import('./original-adventure-workers.ts');
        await checkOriginalAdventureWorkers(sessionDatabase,a);
      }
      if(process.env.KANTO_CHECK_BATTLE_UI==='1'){
        const {checkBattleUi}=await import('./battle-ui-qualification.ts');
        await checkBattleUi(sessionDatabase,[a,b],[saveA,saveB]);
      }
      if(process.env.KANTO_CHECK_ORIGINAL_BATTLES==='1'){
        const {checkOriginalBattleSessions}=await import('./original-battle-sessions.ts');
        await checkOriginalBattleSessions(sessionDatabase,[a,b],[saveA,saveB]);
      }
      if (process.env.KANTO_CHECK_ORIGINAL_TRADES==='1') {
        const { checkOriginalTradeScenes }=await import('./original-trade-scenes.ts');
        await checkOriginalTradeScenes(sessionDatabase,[a,b],[saveA,saveB]);
      }
    } finally { await client.query('rollback'); await client.end(); }
  });
