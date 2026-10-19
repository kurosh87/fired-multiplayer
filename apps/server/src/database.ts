import pg from 'pg';
import type { PoolClient } from 'pg';
import type {EventEmitter} from 'node:events';
import { DomainError, type AdventureSummary, type PublicProfile, type GameVersion } from '../../../packages/protocol/index.ts';
import type { InputJournal, JournalEntry } from '../../../packages/verification/verifier.ts';

/** Only promise-based SQL is exposed. Pool checkout stays inside transaction(),
 * so a managed Netlify connection cannot skip its transaction-local game role. */
export interface GameQueries {
  query<R extends pg.QueryResultRow = any>(text: string, values?: any[]): Promise<pg.QueryResult<R>>;
}

/** Dedicated LISTEN connection outside the pool. Notifications are wake-ups;
 * readers always re-query committed state. */
export type DatabaseListener={
  end():Promise<void>;
  onNotification(handler:(payload:string)=>void):void;
  onError(handler:(error:Error)=>void):void;
};

export class Database implements InputJournal {
  pool: GameQueries;
  readonly poolEvents: EventEmitter;
  private connections: pg.Pool;
  private connectionUrl: string;
  private managedGameRole: boolean;
  readonly identity:'legacy'|'netlify';
  constructor(url: string,onIdleError:(error:Error)=>void=()=>{},identity:'legacy'|'netlify'='legacy',options:{managedGameRole?:boolean}={}) {
    if(options.managedGameRole && identity!=='netlify')throw new Error('The managed game role requires Netlify account identities.');
    this.identity=identity;
    this.connectionUrl=url;
    this.managedGameRole=options.managedGameRole===true;
    this.connections = new pg.Pool({ connectionString: url, max: this.managedGameRole?2:10, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 5000, application_name: 'kanto-online' });
    // pg removes a failed idle client itself. Handle its background error so
    // a network loss cannot become an uncaught EventEmitter error in the API.
    this.connections.on('error',onIdleError);
    this.poolEvents=this.connections;
    this.pool=this.managedGameRole?{
      query:<R extends pg.QueryResultRow=any>(text:string,values?:any[])=>this.transaction(client=>client.query<R>(text,values)),
    }:this.connections;
  }

  get waitingConnections():number{return this.connections.waitingCount;}

  /** A dedicated LISTEN connection, never a pooled one: a slow notification
   * consumer must not stall verified game traffic. */
  async listen(channel:string):Promise<DatabaseListener>{
    if(!/^[a-z_][a-z0-9_]{0,30}$/.test(channel))throw new Error('Invalid watch channel.');
    const client=new pg.Client({connectionString:this.connectionUrl,application_name:'kanto-online-listener'});
    await client.connect();
    try{await client.query(`listen ${channel}`);}
    catch(error){await client.end().catch(()=>undefined);throw error;}
    return {
      end:()=>client.end(),
      onNotification:handler=>{client.on('notification',message=>{
        if(message.channel===channel&&typeof message.payload==='string'&&message.payload)handler(message.payload);
      });},
      onError:handler=>{client.on('error',handler);},
    };
  }

  async transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connections.connect();
    let discard:Error|undefined;
    try {
      await client.query('begin');
      // Fixed application role, never a caller-supplied identifier. SET LOCAL
      // is repeated for every checkout and survives transaction-pooler routing.
      if(this.managedGameRole)await client.query('set local role kanto_game_runtime');
      const result = await body(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try{await client.query('rollback');}catch{discard=new Error('Game transaction rollback failed.');}
      throw error;
    }
    finally { client.release(discard); }
  }

  async profile(ownerId: string): Promise<PublicProfile | undefined> {
    const result = await this.pool.query('select id, handle, suspended_at from public.profiles where id=$1', [ownerId]);
    const profile = result.rows[0];
    if (profile?.suspended_at) throw new DomainError('ACCOUNT_SUSPENDED', 'This account cannot enter online play.', 403);
    return profile ? { id: profile.id, handle: profile.handle } : undefined;
  }

  async createProfile(ownerId: string, handle: string): Promise<PublicProfile> {
    if(this.identity==='netlify')throw new DomainError('ACCOUNT_PROFILE_REQUIRED','Reserve your trainer name through your Kanto account.',409);
    try {
      return await this.transaction(async client => {
        const result = await client.query('insert into public.profiles(id,handle) values($1,$2) returning id,handle', [ownerId, handle]);
        await client.query("insert into private.adventures(owner_id,version) values($1,'firered'),($1,'leafgreen')", [ownerId]);
        return result.rows[0] as PublicProfile;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('HANDLE_UNAVAILABLE', 'That name is already reserved, or your account already has a trainer.', 409);
      throw error;
    }
  }

  async adventures(ownerId: string): Promise<AdventureSummary[]> {
    if(this.identity==='netlify')await this.syncAccountAdventures(ownerId);
    const result = await this.pool.query(`select a.id,a.version,a.revision,a.updated_at,${this.identity==='netlify'?'a.slot':'0'} as slot,
      (a.flash is not null or exists(select 1 from private.game_sessions s where s.adventure_id=a.id and s.frame>0)) as has_save
      from private.adventures a where a.owner_id=$1 order by a.version${this.identity==='netlify'?',a.slot':''}`, [ownerId]);
    return result.rows.map(row => ({ id: row.id, version: row.version as GameVersion, revision: Number(row.revision),
      slot:row.slot,updatedAt: row.updated_at.toISOString(), hasSave: row.has_save }));
  }

  /** Share reserved slot identities, never promote an uploaded cartridge into
   * verified multiplayer progress. The composite FK enforces the owner/edition
   * and slot mapping. The game role cannot even SELECT the solo flash column. */
  async syncAccountAdventures(ownerId:string):Promise<void>{
    if(this.identity!=='netlify')return;
    await this.pool.query(`insert into private.adventures(id,owner_id,version,slot)
      select id,owner_uuid,version,slot from kanto_preview.adventures where owner_uuid=$1
      order by id
      on conflict(id) do nothing`,[ownerId]);
  }

  async find(sessionId: string, sequence: number): Promise<JournalEntry | undefined> {
    const result = await this.pool.query('select batch,fingerprint,acknowledgement from private.input_journal where session_id=$1 and sequence=$2', [sessionId, sequence]);
    return result.rows[0] as JournalEntry | undefined;
  }

  async append(sessionId: string, fence: number, entry: JournalEntry): Promise<void> {
    await this.transaction(async client => {
      const updated = await client.query(`update private.game_sessions set next_sequence=next_sequence+1,
        frame=$4,updated_at=now(),lease_expires_at=clock_timestamp()+interval '60 seconds'
        where id=$1 and fence=$2 and next_sequence=$3 and status='adventure'
        and frame=$5 and lease_expires_at > clock_timestamp() returning id`,
        [sessionId, fence, entry.batch.sequence, entry.acknowledgement.frame, entry.batch.startFrame]);
      if (!updated.rowCount) throw new DomainError('SESSION_LEASE_LOST', 'Reconnect to restore the active session.', 409);
      await client.query(`insert into private.input_journal
        (session_id,sequence,operation_id,fingerprint,batch,acknowledgement) values($1,$2,$3,$4,$5,$6)`,
        [sessionId, entry.batch.sequence, entry.batch.operationId, entry.fingerprint, entry.batch, entry.acknowledgement]);
    });
  }

  async close(): Promise<void> { await this.connections.end(); }
}
