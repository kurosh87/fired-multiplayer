import type {Database} from './database.ts';
import {DomainError,type GameVersion} from '../../../packages/protocol/index.ts';
import type {BattleBootstrap} from './battle-sessions.ts';

/** Both queue rows are claimed with one conditional delete (deterministic id
 * order), so parallel requests cannot double-pair and cannot deadlock. */
export const QUICK_MATCH_LEVEL_BAND=15;
export const QUICK_MATCH_RELAX_MS=60_000;
export const QUICK_MATCH_TTL_MS=10*60_000;
export const QUICK_MATCH_SWEEP_MS=10_000;
/** Fresh entries pair immediately; older pairs only through the sweep. */
const SWEEP_MIN_AGE_MS=5_000;
const SWEEP_BATCH=8;

export type QuickMatchResult={status:'waiting';maxLevel:number|null}|{status:'paired';bootstrap:BattleBootstrap};
export type QuickMatchStatus={status:'idle'}|{status:'waiting';enqueuedAt:number;maxLevel:number|null};
export type QuickMatchStarter=(challenger:string,challenged:string)=>Promise<BattleBootstrap>;

type QueueRow={owner_id:string;session_id:string;version:string;ruleset:string;max_party_level:number|null;enqueued_at:Date};

/** Public battles without a directory scan: one click queues a lobby trainer,
 * the server pairs them with the closest eligible party after their own
 * consent (queueing is consent on both sides). A paired match always runs
 * through the same authenticated challenge and accept as a directory
 * challenge, so ownership, save revisions and engine pinning are unchanged. */
export class QuickMatch{
  private database:Database;
  private start:QuickMatchStarter;
  private locks=new Map<string,Promise<unknown>>();

  constructor(database:Database,start:QuickMatchStarter){this.database=database;this.start=start;}

  /** Serializes an owner's pairing work inside this process; the conditional
   * claim keeps other API processes correct without a shared lock. */
  private exclusive<T>(ownerId:string,body:()=>Promise<T>):Promise<T>{
    const previous=this.locks.get(ownerId)??Promise.resolve(),task=previous.catch(()=>undefined).then(body);
    this.locks.set(ownerId,task);
    return task.finally(()=>{if(this.locks.get(ownerId)===task)this.locks.delete(ownerId);});
  }

  private async liveSession(owner:string):Promise<{id:string;version:GameVersion;maxPartyLevel:number|null}|undefined>{
    const result=await this.database.pool.query(`select s.id,a.version,lp.max_party_level from private.game_sessions s
      join private.adventures a on a.id=s.adventure_id
      join public.profiles p on p.id=s.owner_id and p.suspended_at is null
      left join private.lobby_presence lp on lp.session_id=s.id
      where s.owner_id=$1 and s.status='lobby' and s.lease_expires_at>clock_timestamp()`,[owner]);
    const row=result.rows[0];
    return row?{id:row.id as string,version:row.version as GameVersion,
      maxPartyLevel:row.max_party_level==null?null:Number(row.max_party_level)}:undefined;
  }

  private async sweepExpired():Promise<void>{
    await this.database.pool.query(`delete from private.quick_match_queue
      where enqueued_at<clock_timestamp()-interval '1 millisecond'*$1::int`,[QUICK_MATCH_TTL_MS]);
  }

  async enqueue(owner:string):Promise<QuickMatchResult>{
    return this.exclusive(owner,async()=>{
      const session=await this.liveSession(owner);
      if(!session)throw new DomainError('TRAINER_NOT_READY','Enter the lobby before asking for a battle.',409);
      await this.sweepExpired().catch(()=>undefined);
      const upsert=await this.database.pool.query<{enqueued_at:Date}>(`insert into private.quick_match_queue(owner_id,session_id,version,max_party_level,enqueued_at)
        values($1,$2,$3,$4,clock_timestamp())
        on conflict(owner_id) do update set session_id=excluded.session_id,version=excluded.version,
        max_party_level=excluded.max_party_level,enqueued_at=excluded.enqueued_at
        returning enqueued_at`,[owner,session.id,session.version,session.maxPartyLevel]);
      const bootstrap=await this.pairOnce(owner,upsert.rows[0]!.enqueued_at,session.maxPartyLevel);
      return bootstrap?{status:'paired',bootstrap}:{status:'waiting',maxLevel:session.maxPartyLevel};
    });
  }

  /** Idempotent. A claim already past its transaction decides on its own; the
   * tiny window where a cancelled entry is claimed anyway is answered by the
   * same decline path a failed pairing uses. */
  async cancel(owner:string):Promise<{status:'idle'}>{
    return this.exclusive(owner,async()=>{
      await this.database.pool.query('delete from private.quick_match_queue where owner_id=$1',[owner]);
      return {status:'idle' as const};
    });
  }

  /** Restores the searching state after a reload or reconnect without creating
   * a second entry. A stale queue row whose lobby session expired reads idle. */
  async status(owner:string):Promise<QuickMatchStatus>{
    const result=await this.database.pool.query<{enqueued_at:Date;max_party_level:number|null}>(
      `select q.enqueued_at,q.max_party_level from private.quick_match_queue q
        join private.game_sessions s on s.id=q.session_id and s.status='lobby' and s.lease_expires_at>clock_timestamp()
        join public.profiles p on p.id=q.owner_id and p.suspended_at is null
        where q.owner_id=$1`,[owner]);
    const row=result.rows[0];
    return row?{status:'waiting',enqueuedAt:new Date(row.enqueued_at).getTime(),
      maxLevel:row.max_party_level==null?null:Number(row.max_party_level)}:{status:'idle'};
  }

  /** Opportunistic sweeper: expires TTL rows and re-attempts pairing for
   * entries older than the immediate window, so two waiting trainers still
   * meet when neither request happened to see the other. */
  async sweep():Promise<void>{
    await this.sweepExpired();
    const waiting=await this.database.pool.query(`select q.owner_id,q.enqueued_at,q.max_party_level from private.quick_match_queue q
      join private.game_sessions s on s.id=q.session_id and s.status='lobby' and s.lease_expires_at>clock_timestamp()
      join public.profiles p on p.id=q.owner_id and p.suspended_at is null
      where q.enqueued_at<clock_timestamp()-interval '1 millisecond'*$1::int
      order by q.enqueued_at asc limit $2`,[SWEEP_MIN_AGE_MS,SWEEP_BATCH]);
    for(const row of waiting.rows)
      await this.exclusive(row.owner_id as string,()=>this.pairOnce(row.owner_id as string,row.enqueued_at as Date,
        row.max_party_level==null?null:Number(row.max_party_level)).then(()=>undefined));
  }

  private async pairOnce(owner:string,enqueued:Date,level:number|null):Promise<BattleBootstrap|undefined>{
    const claimed=await this.claim(owner,enqueued,level);
    if(!claimed)return undefined;
    try{return await this.start(claimed.challenger,owner);}
    catch{
      // The other queued entry must survive a failed start: restore both
      // claimed rows. Liveness filters keep any stale restore harmless.
      await this.restore(claimed.rows);
      return undefined;
    }
  }

  /** Picks the best live candidate and claims it together with the caller's
   * row in one statement. Returns undefined when nothing was claimed: the
   * caller stays queued (or was already claimed by another side). */
  private async claim(owner:string,enqueued:Date,level:number|null):Promise<{challenger:string;rows:QueueRow[]}|undefined>{
    return this.database.transaction(async client=>{
      const pick=await client.query(`select q.owner_id,q.enqueued_at from private.quick_match_queue q
        join private.game_sessions s on s.id=q.session_id and s.status='lobby' and s.lease_expires_at>clock_timestamp()
        join public.profiles p on p.id=q.owner_id and p.suspended_at is null
        where q.owner_id<>$1 and q.ruleset='open'
        and ((q.max_party_level is not null and $2::int is not null and abs(q.max_party_level-$2)<=$5::int)
          or $3::timestamptz<clock_timestamp()-interval '1 millisecond'*$4::int
          or q.enqueued_at<clock_timestamp()-interval '1 millisecond'*$4::int)
        order by (q.max_party_level is not null and $2::int is not null and abs(q.max_party_level-$2)<=$5::int) desc,
          q.enqueued_at asc limit 1`,[owner,level,enqueued,QUICK_MATCH_RELAX_MS,QUICK_MATCH_LEVEL_BAND]);
      const candidate=pick.rows[0];
      if(!candidate)return undefined;
      // A single conditional delete in sorted-id order: concurrent claims run
      // the same statement shape and cannot deadlock or double-pair.
      const [first,second]=[owner,candidate.owner_id as string].sort();
      const order=first===owner?[enqueued,candidate.enqueued_at as Date]:[candidate.enqueued_at as Date,enqueued];
      const removed=await client.query<QueueRow>(`delete from private.quick_match_queue q
        using (values ($1::uuid,$3::timestamptz),($2::uuid,$4::timestamptz)) as v(owner_id,enqueued_at)
        where q.owner_id=v.owner_id and date_trunc('milliseconds',q.enqueued_at)=date_trunc('milliseconds',v.enqueued_at)
        returning q.owner_id,q.session_id,q.version,q.ruleset,q.max_party_level,q.enqueued_at`,[first,second,order[0],order[1]]);
      const rows=removed.rows;
      if(rows.length!==2){if(rows.length)await this.restoreIn(client,rows);return undefined;}
      return {challenger:candidate.owner_id as string,rows};
    });
  }

  private async restore(rows:QueueRow[]):Promise<void>{
    await this.database.transaction(async client=>{await this.restoreIn(client,rows);});
  }

  private async restoreIn(client:{query:(text:string,values:unknown[])=>Promise<unknown>},rows:QueueRow[]):Promise<void>{
    for(const row of rows)
      await client.query(`insert into private.quick_match_queue(owner_id,session_id,version,ruleset,max_party_level,enqueued_at)
        values($1,$2,$3,$4,$5,$6) on conflict(owner_id) do nothing`,
        [row.owner_id,row.session_id,row.version,row.ruleset,row.max_party_level,row.enqueued_at]);
  }
}
