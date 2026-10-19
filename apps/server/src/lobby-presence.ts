import {gameVersion,type LobbyTrainer,type PartyPreviewEntry} from '../../../packages/protocol/index.ts';
import type {LiveBattle} from '../../../packages/battles/protocol.ts';
import type {DatabaseListener} from './database.ts';

export const LOBBY_CHANNEL='kanto_lobby';
/** Battle wake-ups share the directory channel but carry a marker instead of
 * an owner id, so the directory reader ignores them and the live-list reader
 * still re-queries committed state. */
export const LIVE_BATTLE_PREFIX='battle:';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

/** Notifications carry the owner id only. Readers re-query committed state, so
 * an event can never deliver a stale payload, party snapshot or private row. */
export async function notifyLobbyPresence(queries:{query:(text:string,values?:unknown[])=>Promise<unknown>},ownerId:string):Promise<void>{
  await queries.query('select pg_notify($1,$2)',[LOBBY_CHANNEL,ownerId]);
}

/** A committed start or finish wakes the live-list reader on every node. The
 * battle id stays server-side; clients only ever receive the public list. */
export async function notifyLiveBattle(queries:{query:(text:string,values?:unknown[])=>Promise<unknown>},battleId:string):Promise<void>{
  await queries.query('select pg_notify($1,$2)',[LOBBY_CHANNEL,`${LIVE_BATTLE_PREFIX}${battleId}`]);
}

/** Stored rows are server-written; this only guards against page payloads
 * growing past the bounded shape if that ever changed. */
export function presenceEntries(raw:unknown):PartyPreviewEntry[]{
  if(!Array.isArray(raw))return [];
  return raw.slice(0,6).flatMap(entry=>{
    if(!entry||typeof entry!=='object')return [];
    const {species,name,level}=entry as Record<string,unknown>;
    return typeof species==='number'&&typeof name==='string'&&typeof level==='number'
      ?[{species,name,level}]:[];
  });
}

export type LobbyPresenceMessage=
  |{type:'sync';trainers:LobbyTrainer[]}
  |{type:'put';trainer:LobbyTrainer}
  |{type:'del';ownerId:string}
  |{type:'live';battles:LiveBattle[]};

export type PresenceQueries={query(text:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};

export type LobbyPresenceOptions={
  /** Opens a dedicated LISTEN connection; reconnects are new connections. */
  listen:()=>Promise<DatabaseListener>;
  queries:PresenceQueries;
  /** Active battles for the lobby's live list. Its absence keeps every client
   * on the HTTP poll; a failed read is retried on the next wake-up or reconcile. */
  live?:()=>Promise<LiveBattle[]>;
  onError?:(error:Error)=>void;
  /** Upper bound for the pushed window, matching a comfortable directory scan. */
  maxTrainers?:number;
  /** Notification coalescing window before the changed rows are re-read. */
  flushDelayMs?:number;
  /** How often known leases are re-verified so hidden trainers drop promptly. */
  staleCheckMs?:number;
  /** Full snapshot safety net for anything an event or lease missed. */
  reconcileMs?:number;
  /** Delay before a broken LISTEN connection is replaced. */
  reconnectMs?:number;
  /** Diff size that replaces per-row events with one fresh sync. */
  syncThreshold?:number;
};

type LobbyRow={owner_id:string;handle:string;version:string;party:unknown;max_party_level:number|null;lease_expires_at:Date};
type PresenceEntry={trainer:LobbyTrainer;lease:number};
type ResolvedOptions=Required<Omit<LobbyPresenceOptions,'live'>>&{live:LobbyPresenceOptions['live']};

const DIRECTORY_COLUMNS=`s.owner_id,p.handle,a.version,lp.party,lp.max_party_level,s.lease_expires_at`;
const DIRECTORY_FROM=`from private.game_sessions s
  join public.profiles p on p.id=s.owner_id
  join private.adventures a on a.id=s.adventure_id and a.owner_id=s.owner_id
  left join private.lobby_presence lp on lp.session_id=s.id`;

/** The live half of the trainer directory and the lobby's active-battle list.
 * The HTTP page poll stays the authority for paging and filters; this stream
 * pushes joins, updates, battle and trade departures, lease expiry and returns
 * without a directory scan. */
export class LobbyPresence{
  private options:ResolvedOptions;
  private map=new Map<string,PresenceEntry>();
  private liveBattles:Map<string,LiveBattle>|undefined;
  private subscribers=new Set<(message:LobbyPresenceMessage)=>void>();
  private dirty=new Set<string>();
  private liveDirty=false;
  private listener:DatabaseListener|undefined;
  private flushTimer:ReturnType<typeof setTimeout>|undefined;
  private staleTimer:ReturnType<typeof setInterval>|undefined;
  private reconcileTimer:ReturnType<typeof setInterval>|undefined;
  private retryTimer:ReturnType<typeof setTimeout>|undefined;
  private startPromise:Promise<void>|undefined;
  private ready=false;
  private stopped=false;

  constructor(options:LobbyPresenceOptions){
    this.options={maxTrainers:200,flushDelayMs:50,staleCheckMs:5_000,reconcileMs:60_000,reconnectMs:2_000,syncThreshold:40,onError:()=>{},...options,live:options.live};
  }

  get started():boolean{return this.ready&&!this.stopped;}

  /** Loads the baseline window and opens the LISTEN connection. Started by the
   * first directory-stream connection rather than at boot, so an application
   * with missing configuration performs no directory read until a client needs
   * the stream. Throws when the baseline cannot be read; clients keep polling
   * and a later connection may retry. */
  async start():Promise<void>{
    if(this.stopped||this.ready)return;
    this.startPromise??=this.launch().catch((error:unknown)=>{
      this.startPromise=undefined;
      throw error;
    });
    return this.startPromise;
  }

  private async launch():Promise<void>{
    const rows=await this.snapshotRows();
    if(this.stopped)return;
    for(const entry of rows)this.map.set(entry.trainer.id,entry);
    // The live list is additive like the directory: a failed baseline read
    // leaves it unsupported until a wake-up or reconcile can retry.
    if(this.options.live){
      try{
        const battles=await this.options.live();
        if(!this.stopped)this.liveBattles=new Map(battles.map(battle=>[battle.id,battle]));
      }catch(error){this.report(error);}
    }
    await this.connect();
    if(this.stopped)return;
    this.ready=true;
    this.staleTimer=setInterval(()=>void this.verifyStale().catch(this.report),this.options.staleCheckMs);
    this.reconcileTimer=setInterval(()=>void this.reconcile().catch(this.report),this.options.reconcileMs);
    this.staleTimer.unref();this.reconcileTimer.unref();
  }

  /** The pushed window mirrors the HTTP page: bounded, and ordered by
   * case-insensitive handle like the directory query. */
  snapshot():LobbyTrainer[]{
    return [...this.map.values()]
      .sort((left,right)=>left.trainer.handle.toLowerCase()<right.trainer.handle.toLowerCase()?-1:1)
      .map(entry=>entry.trainer);
  }

  /** Undefined means this service has no live reader or its first read failed;
   * the client then keeps its HTTP poll and receives no stale empty list. */
  liveSnapshot():LiveBattle[]|undefined{
    return this.liveBattles?[...this.liveBattles.values()]:undefined;
  }

  subscribe(subscriber:(message:LobbyPresenceMessage)=>void):()=>void{
    this.subscribers.add(subscriber);
    return ()=>{this.subscribers.delete(subscriber);};
  }

  /** Re-verifies trainers whose known lease already passed. Renovated rows are
   * refreshed silently; anything else leaves the directory now. */
  async verifyStale():Promise<void>{
    const now=Date.now();
    const stale=[...this.map].filter(([,entry])=>entry.lease<=now).map(([id])=>id);
    if(!stale.length||this.stopped)return;
    const rows=await this.ownerRows(stale);
    for(const owner of stale)this.apply(owner,rows.get(owner));
  }

  /** Full comparison against committed state. Small drift becomes precise
   * put/del events; a large divergence is replaced by one fresh sync. */
  async reconcile():Promise<void>{
    if(this.stopped)return;
    const rows=await this.snapshotRows();
    const fresh=new Map(rows.map(entry=>[entry.trainer.id,entry]));
    let differences=0;
    for(const [id,entry] of this.map){const next=fresh.get(id);if(!next||!sameTrainer(entry.trainer,next.trainer))differences++;}
    for(const id of fresh.keys())if(!this.map.has(id))differences++;
    if(differences>this.options.syncThreshold){
      this.map=fresh;
      this.publish({type:'sync',trainers:[...fresh.values()].map(entry=>entry.trainer)});
      await this.refreshLive();
      return;
    }
    for(const owner of new Set([...this.map.keys(),...fresh.keys()]))this.apply(owner,fresh.get(owner));
    await this.refreshLive();
  }

  async stop():Promise<void>{
    this.stopped=true;this.ready=false;
    clearTimeout(this.flushTimer);clearInterval(this.staleTimer);clearInterval(this.reconcileTimer);clearTimeout(this.retryTimer);
    this.flushTimer=this.staleTimer=this.reconcileTimer=this.retryTimer=undefined;
    this.subscribers.clear();this.dirty.clear();
    this.liveDirty=false;this.liveBattles=undefined;
    const listener=this.listener;this.listener=undefined;
    if(listener)await listener.end().catch(()=>undefined);
  }

  private async connect():Promise<void>{
    const listener=await this.options.listen();
    if(this.stopped){await listener.end().catch(()=>undefined);return;}
    this.listener=listener;
    listener.onNotification(payload=>this.notified(payload));
    listener.onError(error=>{this.report(error);this.lost();});
  }

  /** A broken listener costs no client state: the next connect re-reads the
   * directory, emits the corrections and resumes streaming. */
  private lost():void{
    if(this.stopped)return;
    const listener=this.listener;this.listener=undefined;
    if(listener)void listener.end().catch(()=>undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect():void{
    if(this.stopped||this.retryTimer)return;
    this.retryTimer=setTimeout(()=>{
      this.retryTimer=undefined;
      void this.reconnect();
    },this.options.reconnectMs);
    this.retryTimer.unref();
  }

  private async reconnect():Promise<void>{
    try{await this.connect();}
    catch(error){this.report(error);this.scheduleReconnect();return;}
    try{await this.reconcile();}
    catch(error){this.report(error);}
  }

  private notified(payload:string):void{
    if(this.stopped)return;
    if(payload.startsWith(LIVE_BATTLE_PREFIX))this.liveDirty=true;
    else if(UUID.test(payload))this.dirty.add(payload.toLowerCase());
    else return;
    this.scheduleFlush();
  }

  private scheduleFlush():void{
    if(this.flushTimer)return;
    this.flushTimer=setTimeout(()=>{
      this.flushTimer=undefined;
      void this.flush().catch(this.report);
    },this.options.flushDelayMs);
    this.flushTimer.unref();
  }

  private async flush():Promise<void>{
    const owners=[...this.dirty];this.dirty.clear();
    const liveDirty=this.liveDirty;this.liveDirty=false;
    if(this.stopped||!this.ready)return;
    if(owners.length){
      const rows=await this.ownerRows(owners);
      for(const owner of new Set(owners))this.apply(owner,rows.get(owner));
    }
    if(liveDirty)await this.refreshLive();
  }

  private apply(ownerId:string,entry:PresenceEntry|undefined):void{
    const previous=this.map.get(ownerId);
    if(!entry){
      if(previous){this.map.delete(ownerId);this.publish({type:'del',ownerId});}
      return;
    }
    this.map.set(ownerId,entry);
    if(!previous||!sameTrainer(previous.trainer,entry.trainer))this.publish({type:'put',trainer:entry.trainer});
  }

  /** A bounded list replacement; frame-only changes stay silent because the
   * canvas is not part of the lobby list. */
  private async refreshLive():Promise<void>{
    if(!this.options.live||this.stopped)return;
    let battles:LiveBattle[];
    try{battles=await this.options.live();}
    catch(error){this.report(error);return;}
    if(this.stopped)return;
    const fresh=new Map(battles.map(battle=>[battle.id,battle]));
    if(this.liveBattles&&sameLive(this.liveBattles,fresh))return;
    this.liveBattles=fresh;
    this.publish({type:'live',battles:[...fresh.values()]});
  }

  private publish(message:LobbyPresenceMessage):void{
    if(!this.ready)return;
    for(const subscriber of [...this.subscribers]){
      try{subscriber(message);}catch(error){this.report(error instanceof Error?error:new Error(String(error)));}
    }
  }

  private async snapshotRows():Promise<PresenceEntry[]>{
    const result=await this.options.queries.query(`select ${DIRECTORY_COLUMNS} ${DIRECTORY_FROM}
      where s.status='lobby' and s.lease_expires_at>clock_timestamp() and p.suspended_at is null
      order by lower(p.handle) limit $1`,[this.options.maxTrainers]);
    return result.rows.map(row=>entry(row as LobbyRow));
  }

  private async ownerRows(owners:string[]):Promise<Map<string,PresenceEntry>>{
    const result=await this.options.queries.query(`select ${DIRECTORY_COLUMNS} ${DIRECTORY_FROM}
      where s.owner_id=any($1::uuid[]) and s.status='lobby' and s.lease_expires_at>clock_timestamp() and p.suspended_at is null
      order by s.updated_at`,[owners]);
    const rows=new Map<string,PresenceEntry>();
    for(const row of result.rows)rows.set((row as LobbyRow).owner_id,entry(row as LobbyRow));
    return rows;
  }

  private report=(error:unknown):void=>{this.options.onError(error instanceof Error?error:new Error(String(error)));};
}

function entry(row:LobbyRow):PresenceEntry{
  return {
    trainer:{id:row.owner_id,handle:row.handle,version:gameVersion(row.version),
      party:presenceEntries(row.party),maxLevel:row.max_party_level===null?null:Number(row.max_party_level)},
    lease:row.lease_expires_at.getTime(),
  };
}

function sameTrainer(a:LobbyTrainer,b:LobbyTrainer):boolean{
  if(a.id!==b.id||a.handle!==b.handle||a.version!==b.version||a.maxLevel!==b.maxLevel||a.party.length!==b.party.length)return false;
  return a.party.every((mon,index)=>{
    const other=b.party[index]!;
    return mon.species===other.species&&mon.name===other.name&&mon.level===other.level;
  });
}

/** The public identity of a running battle is stable; only a new or finished
 * battle should wake every lobby client. */
function sameLive(previous:Map<string,LiveBattle>,fresh:Map<string,LiveBattle>):boolean{
  if(previous.size!==fresh.size)return false;
  for(const [id,battle] of fresh){
    const old=previous.get(id);
    if(!old||old.startedAt!==battle.startedAt
      ||old.playerA.handle!==battle.playerA.handle||old.playerA.version!==battle.playerA.version
      ||old.playerB.handle!==battle.playerB.handle||old.playerB.version!==battle.playerB.version)return false;
  }
  return true;
}
