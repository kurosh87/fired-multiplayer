import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type { Database } from './database.ts';
import type { EngineRegistry } from '../../../packages/engine/registry.ts';
import { DomainError,gameVersion,inputBatch,lobbyTrainerQuery,LOBBY_PAGE_SIZE,type LobbyTrainerPage,type GameVersion,type PartyPreviewEntry,type VerificationAck } from '../../../packages/protocol/index.ts';
import type { LobbyPokemon } from '../../../packages/trading/prepare-lobby.ts';
import { SessionVerifier } from '../../../packages/verification/verifier.ts';
import type { EngineManifest } from '../../../packages/engine/runtime.ts';
import {AdventurePool,type AdventureEngine,type CompressedGameState} from '../../../packages/engine/adventure-pool.ts';
import {WorkerGameInspection,type GameInspection} from '../../../packages/trading/worker-pool.ts';
import {gameArtifactUrl} from '../../../packages/engine/artifact-url.ts';
import {notifyLobbyPresence,presenceEntries} from './lobby-presence.ts';

export const ADVENTURE_BOOTSTRAP_TIMEOUT_MS=60_000;

/** Bounded public presence. Eggs and anything beyond the party stay out, so
 * the directory can never leak more than species names and levels. */
export function partyPreview(party:LobbyPokemon[]):{party:PartyPreviewEntry[];maxLevel:number|null}{
  const entries=party.filter(mon=>!mon.isEgg).slice(0,6)
    .map(mon=>({species:mon.species,name:mon.speciesName,level:mon.level}));
  return {party:entries,maxLevel:entries.length?Math.max(...entries.map(entry=>entry.level)):null};
}

type SessionRow = {
  id: string; owner_id: string; adventure_id: string; artifact_id: string; seed: string;
  initial_flash: Buffer | null; base_revision: string; fence: string; next_sequence: string;
  frame: string; status: string; checkpoint: Buffer | null; checkpoint_sequence: string | null;
  checkpoint_frame: string | null; lease_expires_at: Date;
};
type Live = { ownerId: string; engine:AdventureEngine; verifier: SessionVerifier; fence: number; version: GameVersion; manifest: EngineManifest;
  seed: number; adventureId: string; paused: boolean; attached:boolean; attachDeadline:number; exiting?: boolean; enteringLobby?: boolean };
export type LobbyState = { sessionId: string; version: GameVersion; saveRevision: number; party: LobbyPokemon[] };
export type SessionBootstrap = {
  id: string; adventureId: string; protocol: 1; manifest: EngineManifest; seed: number; frame: number;
  nextSequence: number; digest: string; checkpointUrl: string; artifactUrl: string;
};
export type SessionOptions={pool?:AdventurePool|number;clock?:()=>number;connectionClock?:()=>number;inspection?:GameInspection;
  prepareLobby?:(version:GameVersion,seed:number,point:Uint8Array,engine:AdventureEngine)=>Promise<CompressedGameState&{party:LobbyPokemon[]}>};

export class Sessions {
  private database: Database;
  private registry: EngineRegistry;
  private live = new Map<string, Live>();
  private locks = new Map<string, Promise<unknown>>();
  private pool:AdventurePool;
  private ownsPool:boolean;
  private options:SessionOptions;
  private closing=false;
  private inspection:GameInspection;
  private ownsInspection:boolean;
  private connectionClock:()=>number;

  constructor(database:Database,registry:EngineRegistry,options:SessionOptions={}){
    this.database=database;this.registry=registry;this.options=options;
    this.connectionClock=options.connectionClock??(()=>performance.now());
    this.pool=options.pool instanceof AdventurePool?options.pool:new AdventurePool(options.pool);this.ownsPool=!(options.pool instanceof AdventurePool);
    this.inspection=options.inspection??new WorkerGameInspection(registry);this.ownsInspection=!options.inspection;
  }

  private async exclusive<T>(ownerId: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(ownerId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(body);
    this.locks.set(ownerId, task);
    try { return await task; }
    finally { if (this.locks.get(ownerId) === task) this.locks.delete(ownerId); }
  }

  async start(ownerId: string, version: GameVersion, adventureId?: string): Promise<SessionBootstrap> {
    if(adventureId!==undefined&&(typeof adventureId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(adventureId)))
      throw new DomainError('INVALID_ADVENTURE','Choose a valid adventure.');
    if(this.closing)throw new DomainError('SERVER_RESTARTING','The adventure service is restarting.',503);
    return this.exclusive(ownerId, async () => {
      if(this.closing)throw new DomainError('SERVER_RESTARTING','The adventure service is restarting.',503);
      if(this.database.identity==='netlify')await this.database.syncAccountAdventures(ownerId);
      const manifest = this.registry.manifest(version);
      const selected=await this.database.pool.query(`select a.id,p.suspended_at from public.profiles p left join private.adventures a
        on a.owner_id=p.id and a.version=$2${adventureId?' and a.id=$3':''} where p.id=$1 order by a.id limit 2`,
        adventureId?[ownerId,version,adventureId]:[ownerId,version]);
      if(!selected.rows.length)throw new DomainError('TRAINER_REQUIRED','Choose your trainer name first.',409);
      if(selected.rows[0].suspended_at)throw new DomainError('ACCOUNT_SUSPENDED','This account cannot enter online play.',403);
      if(!selected.rows[0].id)throw new DomainError('ADVENTURE_NOT_FOUND','The adventure slot does not exist.',404);
      if(selected.rows.length!==1)throw new DomainError('ADVENTURE_SELECTION_REQUIRED','Choose which adventure to continue.',409);
      const selectedId=selected.rows[0].id as string;
      const local = [...this.live.entries()].find(([, entry]) => entry.ownerId === ownerId);
      if (local && (local[1].version !== version||local[1].adventureId!==selectedId)) throw new DomainError('ADVENTURE_ACTIVE', 'Exit your current adventure before switching adventures.', 409);
      if (local) {
        try { await this.checkpoint(ownerId, local[0]); }
        catch (error) {
          if (!(error instanceof DomainError)
            || !['SESSION_RECOVERY_REQUIRED','SESSION_LEASE_LOST','ADVENTURE_WORKER_LOST'].includes(error.code)) throw error;
        }
        await local[1].verifier.close(); this.live.delete(local[0]);
      }
      const row = await this.database.transaction(async client => {
        const profile = await client.query('select id,suspended_at from public.profiles where id=$1 for update', [ownerId]);
        if (!profile.rows[0]) throw new DomainError('TRAINER_REQUIRED', 'Choose your trainer name first.', 409);
        if (profile.rows[0].suspended_at) throw new DomainError('ACCOUNT_SUSPENDED', 'This account cannot enter online play.', 403);
        const existing = await client.query<SessionRow>("select * from private.game_sessions where owner_id=$1 and status<>'closed' for update", [ownerId]);
        const active = existing.rows[0];
        if (active) {
          const adventure = await client.query('select version from private.adventures where id=$1', [active.adventure_id]);
          if (adventure.rows[0]?.version !== version||active.adventure_id!==selectedId) throw new DomainError('ADVENTURE_ACTIVE', 'Resume and exit the other adventure before switching adventures.', 409);
          if (active.artifact_id !== manifest.id) throw new DomainError('ENGINE_VERSION_PINNED', 'This adventure needs its previous game version to finish recovery.', 503);
          if (active.status !== 'adventure') throw new DomainError('ADVENTURE_BUSY', 'Finish the current online interaction first.', 409);
          if((!local||local[1].fence!==Number(active.fence))&&active.lease_expires_at.getTime()>Date.now())
            throw new DomainError('SESSION_ACTIVE_ELSEWHERE','Your adventure is active on another connection. Retry after one minute.',409);
          const acquired = await client.query<SessionRow>(`update private.game_sessions set fence=fence+1,
            lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now() where id=$1 returning *`, [active.id]);
          return acquired.rows[0]!;
        }
        const adventure = await client.query('select id,revision,flash from private.adventures where owner_id=$1 and version=$2 and id=$3', [ownerId, version,selectedId]);
        if (!adventure.rows[0]) throw new DomainError('ADVENTURE_NOT_FOUND', 'The adventure slot does not exist.', 404);
        const saved = await client.query<SessionRow>(`select * from private.game_sessions where adventure_id=$1 and status='closed' and superseded_at is null
          order by updated_at desc limit 1 for update`, [adventure.rows[0].id]);
        if (saved.rows[0]) {
          if (saved.rows[0].artifact_id !== manifest.id) throw new DomainError('ENGINE_VERSION_PINNED', 'The saved adventure requires an earlier engine artifact.', 503);
          const resumed = await client.query<SessionRow>(`update private.game_sessions set status='adventure',fence=fence+1,
            lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now() where id=$1 returning *`, [saved.rows[0].id]);
          return resumed.rows[0]!;
        }
        const seed = randomBytes(4).readUInt32LE();
        const inserted = await client.query<SessionRow>(`insert into private.game_sessions
          (id,owner_id,adventure_id,artifact_id,seed,initial_flash,base_revision,lease_expires_at)
          values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '60 seconds') returning *`, [randomUUID(), ownerId, adventure.rows[0].id, manifest.id,
          seed, adventure.rows[0].flash, adventure.rows[0].revision]);
        return inserted.rows[0]!;
      });
      let engine:AdventureEngine|undefined;
      try {
        engine=await this.pool.create({bytes:this.registry.artifact(version),manifest},Number(row.seed),row.initial_flash??undefined,row.checkpoint??undefined);
        let sequence = 0;
        if (row.checkpoint) {
          sequence = Number(row.checkpoint_sequence);
          if (engine.frame !== Number(row.checkpoint_frame)) throw new DomainError('CHECKPOINT_CORRUPT', 'The saved checkpoint could not be verified.', 503);
        }
        const entries = await this.database.pool.query(`select batch,fingerprint,acknowledgement from private.input_journal
          where session_id=$1 and sequence>=$2 order by sequence`, [row.id, sequence]);
        for (const entry of entries.rows) {
          const batch=inputBatch(entry.batch);
          if(batch.sessionId!==row.id||batch.sequence!==sequence||batch.startFrame!==engine.frame
            ||createHash('sha256').update(JSON.stringify(batch)).digest('hex')!==entry.fingerprint)
            throw new DomainError('JOURNAL_CORRUPT','The input journal is incomplete.',503);
          await engine.advance(batch.runs);
          if (engine.digest() !== entry.acknowledgement.digest || engine.frame !== entry.acknowledgement.frame) throw new DomainError('JOURNAL_DIVERGED', 'The restored game does not match verified progress.', 503);
          sequence++;
        }
        if (sequence !== Number(row.next_sequence) || engine.frame !== Number(row.frame)) throw new DomainError('JOURNAL_CORRUPT', 'The saved game is missing verified input.', 503);
        const verifier=new SessionVerifier({engine,journal:this.database,sessionId:row.id,fence:Number(row.fence),nextSequence:sequence,clock:this.options.clock});
        this.live.set(row.id, { ownerId,engine,verifier,fence: Number(row.fence), version, manifest,
          seed: Number(row.seed), adventureId: row.adventure_id, paused: true,attached:false,
          attachDeadline:this.connectionClock()+ADVENTURE_BOOTSTRAP_TIMEOUT_MS });
        const state=await verifier.pauseMetadata();
        return { id: row.id, adventureId:row.adventure_id, protocol: 1, manifest, seed: Number(row.seed), frame: state.frame,
          nextSequence: sequence, digest: state.digest, checkpointUrl: `/api/sessions/${row.id}/checkpoint`,
          artifactUrl: gameArtifactUrl(version,manifest.wasmSha256) };
      } catch (error) {
        await engine?.close();this.live.delete(row.id);
        await this.database.pool.query("update private.game_sessions set lease_expires_at=clock_timestamp() where id=$1 and fence=$2", [row.id, row.fence]);
        throw error;
      }
    });
  }

  private owned(ownerId: string, sessionId: string, expectedFence?: number): Live {
    const entry = this.live.get(sessionId);
    if (!entry || entry.ownerId !== ownerId) throw new DomainError('SESSION_NOT_FOUND', 'Resume your adventure first.', 404);
    if (expectedFence !== undefined && entry.fence !== expectedFence) throw new DomainError('SESSION_REPLACED', 'The adventure resumed on another connection.', 409);
    return entry;
  }

  connectionFence(ownerId: string, sessionId: string): number { return this.owned(ownerId, sessionId).fence; }

  async checkpoint(ownerId: string, sessionId: string, expectedFence?: number): Promise<{
    bytes: Buffer; frame: number; sequence: number; flash: Uint8Array;
  }> {
    const entry = this.owned(ownerId, sessionId, expectedFence);
    entry.paused = true;
    const state=await entry.verifier.pauseCheckpoint(),bytes=Buffer.from(state.checkpoint);
    const updated = await this.database.pool.query(`update private.game_sessions set checkpoint=$3,
      checkpoint_frame=$4,checkpoint_sequence=$5,lease_expires_at=clock_timestamp()+interval '60 seconds'
      where id=$1 and fence=$2 and frame=$4 and next_sequence=$5 and status='adventure'`,
      [sessionId, entry.fence, bytes, state.frame, state.sequence]);
    if (!updated.rowCount) throw new DomainError('SESSION_LEASE_LOST', 'Reconnect to restore the active adventure.', 409);
    return { bytes, frame: state.frame, sequence: state.sequence, flash: state.flash };
  }

  resume(ownerId: string, sessionId: string, expectedFence?: number): void {
    const entry = this.owned(ownerId, sessionId, expectedFence);
    if (entry.exiting) throw new DomainError('SESSION_CLOSING', 'The adventure is saving and exiting.', 409);
    if (entry.enteringLobby) throw new DomainError('SESSION_CHANGING', 'The adventure is entering the lobby.', 409);
    entry.verifier.resume(); entry.paused = false;entry.attached=true;
  }

  async accept(ownerId: string, sessionId: string, input: unknown, expectedFence?: number): Promise<VerificationAck> {
    const entry = this.owned(ownerId, sessionId, expectedFence);
    if (entry.exiting) throw new DomainError('SESSION_CLOSING', 'The adventure is saving and exiting.', 409);
    if (entry.enteringLobby) throw new DomainError('SESSION_CHANGING', 'The adventure is entering the lobby.', 409);
    return entry.verifier.accept(input);
  }

  async pause(ownerId: string, sessionId: string, expectedFence?: number): Promise<void> { await this.checkpoint(ownerId, sessionId, expectedFence); }

  /** A closed socket no longer needs a resident verifier. Keep its durable
   * progress, revoke late writers and release the bounded worker slot. */
  async disconnect(ownerId:string,sessionId:string,expectedFence:number):Promise<void>{
    await this.exclusive(ownerId,async()=>{
      const entry=this.live.get(sessionId);
      // A delayed close from an old window must not retire its replacement.
      if(!entry||entry.ownerId!==ownerId||entry.fence!==expectedFence)return;
      await this.retire(sessionId,entry);
    });
  }

  private async retire(sessionId:string,entry:Live):Promise<void>{
    entry.exiting=true;
    let failure:unknown;
    try{await this.checkpoint(entry.ownerId,sessionId,entry.fence);}catch(error){failure=error;}
    try{await entry.verifier.close();}catch(error){failure??=error;}
    try{
      await this.database.pool.query(`update private.game_sessions set fence=fence+1,lease_expires_at=clock_timestamp()
        where id=$1 and fence=$2 and status='adventure'`,[sessionId,entry.fence]);
    }catch(error){failure??=error;}
    finally{if(this.live.get(sessionId)===entry)this.live.delete(sessionId);}
    if(failure)throw failure;
  }

  /** Reclaim bootstraps that never reached an authenticated play connection.
   * This clock is independent of the verifier's game-time budget. */
  async expireUnattached():Promise<void>{
    let failure:unknown;
    for(const [id,entry] of [...this.live]){
      if(this.closing)break;
      if(entry.attached||entry.attachDeadline>this.connectionClock())continue;
      try{
        await this.exclusive(entry.ownerId,async()=>{
          // A socket or a replacement bootstrap may have arrived while this
          // candidate waited behind another owner operation.
          if(this.closing||this.live.get(id)!==entry||entry.attached||entry.attachDeadline>this.connectionClock())return;
          await this.retire(id,entry);
        });
      }catch(error){failure??=error;}
    }
    if(failure)throw failure;
  }

  async enterLobby(ownerId: string, sessionId: string, expectedFence?: number): Promise<LobbyState> {
    return this.exclusive(ownerId, async () => {
      if (!this.live.has(sessionId)) {
        const previous = await this.database.pool.query("select id from private.game_sessions where id=$1 and owner_id=$2 and status='lobby'", [sessionId, ownerId]);
        if (previous.rowCount) return this.lobbyState(ownerId);
      }
      const entry = this.owned(ownerId, sessionId, expectedFence);
      entry.enteringLobby = true;
      let writing = false;
      try {
        const point = await this.checkpoint(ownerId, sessionId, entry.fence);
        const staged=this.options.prepareLobby?await this.options.prepareLobby(entry.version,entry.seed,point.bytes,entry.engine):await entry.engine.prepareLobby();
        if (staged.frame !== point.frame) throw new DomainError('ENGINE_ABI_ERROR', 'Lobby preparation changed the verified frame.', 503);
        const bytes=Buffer.from(staged.checkpoint);
        writing = true;
        const saveRevision = await this.database.transaction(async client => {
          // Same adventure-before-session lock order as trade reservation.
          const saved = await client.query('select revision from private.adventures where id=$1 and owner_id=$2 for update', [entry.adventureId, ownerId]);
          if (!saved.rowCount) throw new DomainError('ADVENTURE_NOT_FOUND', 'The adventure was not found.', 404);
          const revision = Number(saved.rows[0].revision) + 1;
          const moved = await client.query(`update private.game_sessions set status='lobby',fence=fence+1,
            checkpoint=$3,checkpoint_frame=$4,checkpoint_sequence=$5,base_revision=$6,
            lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
            where id=$1 and owner_id=$7 and fence=$2 and status='adventure'
            and frame=$4 and next_sequence=$5 and lease_expires_at>clock_timestamp() returning id`,
            [sessionId, entry.fence, bytes, point.frame, point.sequence, revision, ownerId]);
          if (!moved.rowCount) throw new DomainError('SESSION_LEASE_LOST', 'Reconnect before entering the lobby.', 409);
          await client.query('update private.adventures set flash=$2,revision=$3,updated_at=now() where id=$1',
            [entry.adventureId, Buffer.from(staged.flash), revision]);
          // The lobby directory reads this snapshot instead of re-inspecting
          // the cartridge per viewer; it commits with the session transition.
          const preview=partyPreview(staged.party);
          await client.query(`insert into private.lobby_presence(session_id,owner_id,version,max_party_level,party,updated_at)
            values($1,$2,$3,$4,$5,now())
            on conflict(session_id) do update set owner_id=excluded.owner_id,version=excluded.version,
            max_party_level=excluded.max_party_level,party=excluded.party,updated_at=now()`,
            [sessionId, ownerId, entry.version, preview.maxLevel, JSON.stringify(preview.party)]);
          // Directory membership changed; listeners re-query this committed row.
          await notifyLobbyPresence(client, ownerId);
          return revision;
        });
        await entry.verifier.close(); this.live.delete(sessionId);
        return { sessionId, version: entry.version, saveRevision, party: staged.party };
      } catch (error) {
        entry.enteringLobby = false;
        if (writing) {
          // An uncertain commit must not resume the pre-save runtime. Its
          // durable checkpoint remains recoverable if the transaction failed.
          await entry.verifier.close(); this.live.delete(sessionId);
          await this.database.pool.query("update private.game_sessions set lease_expires_at=clock_timestamp() where id=$1 and fence=$2 and status='adventure'", [sessionId, entry.fence]).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async lobbyState(ownerId: string): Promise<LobbyState> {
    const result = await this.database.pool.query(`with present as (
      update private.game_sessions set lease_expires_at=clock_timestamp()+interval '60 seconds'
      where owner_id=$1 and status='lobby' returning id,adventure_id,artifact_id,seed)
      select s.*,a.version,a.revision,a.flash from present s join private.adventures a on a.id=s.adventure_id and a.owner_id=$1`, [ownerId]);
    const row = result.rows[0];
    if (!row) throw new DomainError('LOBBY_NOT_FOUND', 'Enter the lobby from your adventure first.', 409);
    const version = gameVersion(row.version);
    if (this.registry.manifest(version).id !== row.artifact_id)
      throw new DomainError('ENGINE_VERSION_PINNED', 'The lobby needs its original game artifact.', 503);
    const party = await this.inspection.lobbyParty(version,Number(row.seed),new Uint8Array(row.flash));
    // Backfill the presence snapshot for sessions that entered before it
    // existed. A failed backfill must not block the lobby itself.
    const preview=partyPreview(party);
    await this.database.pool.query(`insert into private.lobby_presence(session_id,owner_id,version,max_party_level,party,updated_at)
      values($1,$2,$3,$4,$5,now())
      on conflict(session_id) do update set owner_id=excluded.owner_id,version=excluded.version,
      max_party_level=excluded.max_party_level,party=excluded.party,updated_at=now()`,
      [row.id, ownerId, version, preview.maxLevel, JSON.stringify(preview.party)]).catch(() => undefined);
    // The lease renewal above can bring a hidden trainer back. Losing this
    // wake-up only delays that by the reconciliation interval.
    await notifyLobbyPresence(this.database.pool, ownerId).catch(() => undefined);
    return { sessionId: row.id, version, saveRevision: Number(row.revision), party };
  }

  async leaveLobby(ownerId: string): Promise<SessionBootstrap> {
    const result = await this.database.transaction(async client => {
      // Lock adventures first; a concurrent reservation can hold these rows.
      const adventure = await client.query(`select a.id,a.version from private.adventures a
        join private.game_sessions s on s.adventure_id=a.id
        where s.owner_id=$1 and a.owner_id=$1 and s.status='lobby' order by a.id for update of a`, [ownerId]);
      const row = adventure.rows[0];
      if (!row) throw new DomainError('LOBBY_NOT_FOUND', 'This adventure is not available to leave the lobby.', 409);
      const left = await client.query(`update private.game_sessions set status='closed',lease_expires_at=clock_timestamp(),updated_at=now()
        where owner_id=$1 and adventure_id=$2 and status='lobby' returning id`, [ownerId, row.id]);
      if (!left.rowCount) throw new DomainError('LOBBY_BUSY', 'Finish the current online interaction first.', 409);
      // Presence and the quick-match entry only exist while the session is in
      // the lobby; pairing re-checks liveness, this is hygiene.
      await client.query('delete from private.lobby_presence where session_id=$1', [left.rows[0].id]);
      await client.query('delete from private.quick_match_queue where owner_id=$1', [ownerId]);
      await notifyLobbyPresence(client, ownerId);
      return {version:gameVersion(row.version),adventureId:row.id as string};
    });
    // start() acquires the runtime with a new fence and restores the exact
    // post-save checkpoint. Cancellation never rolls back party or progress.
    return this.start(ownerId, result.version,result.adventureId);
  }

  async lobbyTrainers(ownerId: string): Promise<{ id: string; handle: string; version: GameVersion }[]> {
    return (await this.lobbyTrainerPage(ownerId)).trainers;
  }

  async lobbyTrainerPage(ownerId:string,query:unknown={}):Promise<LobbyTrainerPage>{
    const {after,search,version:edition,minLevel,maxLevel}=lobbyTrainerQuery(query);
    const values:unknown[]=[ownerId,after,search],filters:string[]=[];
    if(edition!==undefined){values.push(edition);filters.push(`and a.version=$${values.length}`);}
    if(minLevel!==undefined){values.push(minLevel);filters.push(`and lp.max_party_level>=$${values.length}`);}
    if(maxLevel!==undefined){values.push(maxLevel);filters.push(`and lp.max_party_level<=$${values.length}`);}
    values.push(LOBBY_PAGE_SIZE+1);
    const result = await this.database.pool.query(`select p.id,p.handle,a.version,lp.party,lp.max_party_level from private.game_sessions s
      join public.profiles p on p.id=s.owner_id join private.adventures a on a.id=s.adventure_id and a.owner_id=s.owner_id
      left join private.lobby_presence lp on lp.session_id=s.id
      where s.status='lobby' and s.lease_expires_at>clock_timestamp() and p.suspended_at is null and p.id<>$1
      and lower(p.handle)>$2 and starts_with(lower(p.handle),$3)
      ${filters.join(' ')}
      order by lower(p.handle) limit $${values.length}`,values);
    const trainers=result.rows.slice(0,LOBBY_PAGE_SIZE).map(row=>({id:row.id,handle:row.handle,version:gameVersion(row.version),
      party:presenceEntries(row.party),maxLevel:row.max_party_level===null?null:Number(row.max_party_level)}));
    // Handles are immutable and unique after lowercasing. A departed cursor
    // row therefore cannot shift an offset or hide all subsequent trainers.
    return {trainers,nextCursor:result.rows.length>LOBBY_PAGE_SIZE?trainers.at(-1)!.handle.toLowerCase():null};
  }

  async lobbyPresence(ownerId: string): Promise<void> {
    const touched = await this.database.pool.query(`update private.game_sessions set lease_expires_at=clock_timestamp()+interval '60 seconds'
      where owner_id=$1 and status='lobby' returning id`, [ownerId]);
    if (!touched.rowCount) throw new DomainError('LOBBY_NOT_FOUND', 'Your lobby session has changed. Reopen the lobby.', 409);
    await notifyLobbyPresence(this.database.pool, ownerId).catch(() => undefined);
  }

  async exit(ownerId: string, sessionId: string, expectedFence?: number): Promise<void> {
    await this.exclusive(ownerId, async () => {
      const entry = this.owned(ownerId, sessionId, expectedFence);
      entry.exiting = true;
      try {
        const point = await this.checkpoint(ownerId, sessionId, entry.fence);
        // Only mirror bytes emitted by the verified game. An erased cartridge
        // has no original-menu save; its resumable runtime checkpoint survives.
        const flash = point.flash.every(byte => byte === 0xff) ? null : Buffer.from(point.flash);
        await this.database.transaction(async client => {
          // Match lobby entry and trade reservation: adventure, then session.
          const saved = await client.query('select id from private.adventures where id=$1 and owner_id=$2 for update', [entry.adventureId, ownerId]);
          if (!saved.rowCount) throw new DomainError('ADVENTURE_NOT_FOUND', 'The adventure was not found.', 404);
          const closed = await client.query(`update private.game_sessions set status='closed',lease_expires_at=clock_timestamp(),updated_at=now()
            where id=$1 and owner_id=$2 and fence=$3 and frame=$4 and next_sequence=$5
            and status='adventure' returning adventure_id`, [sessionId, ownerId, entry.fence, point.frame, point.sequence]);
          if (!closed.rows[0]) throw new DomainError('SESSION_LEASE_LOST', 'Reconnect before exiting this adventure.', 409);
          await client.query('update private.adventures set flash=$2,revision=revision+1,updated_at=now() where id=$1',
            [closed.rows[0].adventure_id, flash]);
        });
        await entry.verifier.close(); this.live.delete(sessionId);
      } catch (error) { entry.exiting = false; throw error; }
    });
  }

  async close(): Promise<void> {
    this.closing=true;
    // Finish starts/exits already holding an owner lock before collecting the
    // remaining runtimes. Queued starts recheck closing inside that lock.
    await Promise.allSettled([...this.locks.values()]);
    let failure:unknown;
    for (const [id, entry] of this.live) {
      await this.exclusive(entry.ownerId,async()=>{
        if(this.live.get(id)!==entry)return;
        entry.exiting=true;
        try { await this.checkpoint(entry.ownerId, id, entry.fence); }
        catch (error) { process.stderr.write(`Checkpoint failed for ${id}: ${error instanceof Error ? error.message : 'unknown error'}\n`); }
        try{await entry.verifier.close();}catch(error){failure??=error;}
        // Also fence any checkpoint UPDATE already outside the owner lock.
        try{await this.database.pool.query('update private.game_sessions set fence=fence+1,lease_expires_at=clock_timestamp() where id=$1 and fence=$2',[id,entry.fence]);}
        catch(error){failure??=error;}
        this.live.delete(id);
      });
    }
    this.live.clear();
    if(this.ownsPool)await this.pool.close();
    if(this.ownsInspection)await (this.inspection as WorkerGameInspection).close();
    if(failure)throw failure;
  }
}
