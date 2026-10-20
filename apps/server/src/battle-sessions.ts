import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import type {Database} from './database.ts';
import type {EngineRegistry} from '../../../packages/engine/registry.ts';
import {DomainError,FRAME_MILLISECONDS,type GameVersion} from '../../../packages/protocol/index.ts';
import {battleInput,battleId,type BattleView,type BattleInputAck,type LiveBattle,type WatchSide} from '../../../packages/battles/protocol.ts';
import type {BattleResult,Side} from '../../../packages/battles/session.ts';
import type {BattleArtifact} from '../../../packages/battles/original-pair.ts';
import {BattleConsolePool,type BattleConsole} from '../../../packages/battles/console-pool.ts';
import {BattleRepository,type ReservedBattle} from './battle-repository.ts';
import {BattleRunStore,decisionState,type DecisionState,type BattleRunRow} from './battle-run-store.ts';

const initialDecision=():DecisionState=>({kind:null,mask:0,epoch:0,deadline:null});
type Live={id:string;owners:[string,string];versions:[GameVersion,GameVersion];pair:BattleConsole;fence:number;
  sequence:number;buttons:[number,number];connection:[number,number];disconnected:[number|null,number|null];
  decision:DecisionState;expiresAt:number;clock:number;credit:number;pending:number;startFrame:number;
  pendingButtons:[number,number];checkpointFrame:number;screenFrame:number;poisoned:boolean};
export type BattleBootstrap={id:string;protocol:1;frame:number;width:240;height:160;battle:BattleView};
export type BattleScreenEvent={id:string;ownerId:string;side:0|1;frame:number;pixels:Uint8Array};
export type BattleWatch={frame:number;pixels:Uint8Array;battle:BattleView};

/** Shared authoritative clock and private original consoles. Only rendered
 * personal screens, own button acknowledgements and public results leave this
 * service. Clients cannot supply frames, opponents' inputs or snapshots. */
export class BattleSessions extends EventEmitter{
  readonly repository:BattleRepository;
  private database:Database;
  private registry:EngineRegistry;
  private store:BattleRunStore;
  private clock:()=>number;
  private pool:BattleConsolePool;
  private ownsPool:boolean;
  private live=new Map<string,Live>();
  private locks=new Map<string,Promise<unknown>>();
  private ticking=new Set<string>();
  private closing=false;
  constructor(database:Database,registry:EngineRegistry,clock:()=>number=Date.now,pool?:BattleConsolePool|number){
    super();this.registry=registry;this.clock=clock;this.store=new BattleRunStore(database);this.database=database;
    this.pool=pool instanceof BattleConsolePool?pool:new BattleConsolePool(pool);this.ownsPool=!(pool instanceof BattleConsolePool);
    this.repository=new BattleRepository(database,saves=>{for(const save of saves)this.registry.manifest(save.version);});
  }
  private async exclusive<T>(id:string,body:()=>Promise<T>):Promise<T>{
    const prior=this.locks.get(id)??Promise.resolve(),task=prior.catch(()=>undefined).then(body);this.locks.set(id,task);
    try{return await task;}finally{if(this.locks.get(id)===task)this.locks.delete(id);}
  }
  private artifacts(versions:[GameVersion,GameVersion],ids:[string,string],seed:number):[BattleArtifact,BattleArtifact]{
    return versions.map((version,side)=>{
      const manifest=this.registry.manifest(version);
      if(manifest.id!==ids[side])throw new DomainError('BATTLE_ENGINE_PINNED','This battle requires its original game artifacts.',503);
      return {bytes:this.registry.artifact(version),manifest,seed};
    }) as [BattleArtifact,BattleArtifact];
  }
  challenge(owner:string,peer:string,watchable=false):Promise<BattleView>{return this.repository.challenge(owner,peer,watchable);}
  get(owner:string,id:string):Promise<BattleView>{return this.repository.get(owner,id);}
  list(owner:string):Promise<BattleView[]>{return this.repository.list(owner);}
  async accept(owner:string,id:string):Promise<BattleBootstrap>{
    const view=await this.repository.get(owner,id);
    const artifacts:[string,string]=[this.registry.manifest(view.playerA.version).id,this.registry.manifest(view.playerB.version).id];
    await this.repository.reserve(owner,id,artifacts,randomBytes(4).readUInt32LE());return this.open(owner,id);
  }
  /** Quick match: both trainers consented by queueing, so the server creates
   * the challenge and accepts it in one step. A start that fails this far
   * declines its own offer instead of leaving it to expire. */
  async quickPair(challenger:string,challenged:string):Promise<BattleBootstrap>{
    // Queueing is consent to battle, not consent to being watched. A quick
    // match therefore starts private; only an explicit directory challenge can
    // opt in to spectators. A reusable directory challenge may already be
    // watchable, so decline it and create a private replacement instead of
    // silently starting it.
    let offered=await this.repository.challenge(challenger,challenged,false);
    if(offered.watchable){
      await this.repository.decline(challenged,offered.id);
      offered=await this.repository.challenge(challenger,challenged,false);
    }
    try{return await this.accept(challenged,offered.id);}
    catch(error){
      try{await this.repository.decline(challenged,offered.id);}catch{/* The offer expires on its own. */}
      throw error;
    }
  }
  private async initialize(reserved:ReservedBattle):Promise<BattleConsole>{
    const versions:[GameVersion,GameVersion]=[reserved.saveA.version,reserved.saveB.version];
    let pair:BattleConsole|undefined,writing=false;
    try{
      pair=await this.pool.create(this.artifacts(versions,reserved.artifacts,reserved.seed),[reserved.saveA.flash,reserved.saveB.flash]);
      const points=await pair.checkpoint();
      writing=true;await this.store.initialize(reserved,points);
      return pair;
    }catch(error){await pair?.close();if(!writing)await this.repository.releaseStarting(reserved.id);throw error;}
  }
  private advanceDecision(previous:DecisionState,current:{kind:DecisionState['kind'];mask:number},now:number):DecisionState{
    if(current.kind===previous.kind)return {...previous,mask:current.mask};
    return {kind:current.kind,mask:current.mask,epoch:previous.epoch+(current.kind===null?0:1),deadline:current.kind===null?null:Math.trunc(now)+90_000};
  }
  private rowDecision(row:BattleRunRow):DecisionState{return {kind:row.decision_kind,mask:row.decision_mask,
    epoch:Number(row.decision_epoch),deadline:row.decision_deadline?.getTime()??null};}
  async open(owner:string,id:string):Promise<BattleBootstrap>{
    if(this.closing)throw new DomainError('SERVER_RESTARTING','The battle service is restarting.',503);
    return this.exclusive(id,async()=>{
      let view=await this.repository.get(owner,id);
      let initialized:BattleConsole|undefined;
      if(view.status==='finished')return {id,protocol:1,frame:0,width:240,height:160,battle:view};
      if(view.status==='starting'){
        initialized=await this.initialize(await this.repository.reserved(owner,id));
        try{view=await this.repository.get(owner,id);}catch(error){await initialized.close();throw error;}
      }
      if(view.status!=='active'){await initialized?.close();throw new DomainError('BATTLE_CHANGED','Accept this challenge before opening its battle.',409);}
      const local=this.live.get(id);
      if(local&&!local.poisoned)return {id,protocol:1,frame:local.pair.frame,width:240,height:160,battle:view};
      let row:BattleRunRow;
      try{row=await this.store.claim(owner,id,local?.fence);}catch(error){await initialized?.close();throw error;}
      await local?.pair.close();this.live.delete(id);
      const versions:[GameVersion,GameVersion]=[row.version_a,row.version_b],ids:[string,string]=[row.artifact_a,row.artifact_b];
      let pair:BattleConsole|undefined;
      try{
        const points:[Buffer,Buffer]=row.checkpoint_a?[row.checkpoint_a,row.checkpoint_b!]:[row.initial_checkpoint_a,row.initial_checkpoint_b];
        if(initialized&&Number(row.frame)===0&&Number(row.next_sequence)===0)pair=initialized;
        else{await initialized?.close();pair=await this.pool.restore(this.artifacts(versions,ids,Number(row.seed)),Number(row.checkpoint_frame??0),points);}
        let sequence=Number(row.checkpoint_sequence??0),decision=decisionState(row.checkpoint_state??initialDecision());
        for(const entry of await this.store.entries(id,sequence)){
          entry.state=decisionState(entry.state);
          if(Number(entry.sequence)!==sequence||Number(entry.start_frame)!==pair.frame||entry.ticks<1||entry.ticks>60)
            throw new DomainError('BATTLE_JOURNAL_CORRUPT','The private battle journal is incomplete.',503);
          let calculated=decision;
          for(const current of await pair.advance([entry.buttons_a,entry.buttons_b],entry.ticks)){
            // Count C decision transitions; stored wall-clock deadlines are
            // retained, never recreated from replay speed or reconnect time.
            calculated=this.advanceDecision(calculated,current,0);
          }
          const {digests,transportDigest}=await pair.progress();
          if(pair.frame!==Number(entry.end_frame)||digests[0]!==entry.digest_a||digests[1]!==entry.digest_b
            ||transportDigest!==entry.transport_digest||calculated.kind!==entry.state.kind
            ||calculated.mask!==entry.state.mask||calculated.epoch!==entry.state.epoch
            ||entry.state.kind===decision.kind&&entry.state.epoch===decision.epoch&&entry.state.deadline!==decision.deadline)
            throw new DomainError('BATTLE_JOURNAL_DIVERGED','The original consoles differ from their verified journal.',503);
          decision=entry.state;sequence++;
        }
        if(sequence!==Number(row.next_sequence)||pair.frame!==Number(row.frame)
          ||JSON.stringify(decision)!==JSON.stringify(this.rowDecision(row)))
          throw new DomainError('BATTLE_JOURNAL_CORRUPT','The battle is missing verified progress.',503);
        const now=this.clock();
        this.live.set(id,{id,owners:[row.player_a,row.player_b],versions,pair,fence:Number(row.fence),sequence,
          buttons:[row.buttons_a,row.buttons_b],connection:[Number(row.connection_a),Number(row.connection_b)],
          disconnected:[row.disconnected_a?.getTime()??null,row.disconnected_b?.getTime()??null],decision,
          expiresAt:row.expires_at.getTime(),clock:now,credit:0,pending:0,startFrame:pair.frame,pendingButtons:[row.buttons_a,row.buttons_b],
          checkpointFrame:pair.frame,screenFrame:-4,poisoned:false});
        return {id,protocol:1,frame:pair.frame,width:240,height:160,battle:view};
      }catch(error){await pair?.close();await this.store.expireLease(id,Number(row.fence));throw error;}
    });
  }
  private owned(owner:string,id:string):{live:Live;side:0|1}{
    const live=this.live.get(id);
    if(!live||!live.owners.includes(owner))throw new DomainError('BATTLE_RUN_NOT_FOUND','Open your battle before sending controls.',404);
    if(live.poisoned)throw new DomainError('BATTLE_RECOVERY_REQUIRED','Reconnect to restore verified battle progress.',409);
    return {live,side:live.owners[0]===owner?0:1};
  }
  private async poison(live:Live):Promise<void>{
    live.poisoned=true;await live.pair.close();
    try{await this.store.expireLease(live.id,live.fence);}
    catch(error){this.emit('run-error',{id:live.id,error});}
    finally{this.emit('recovery-required',{id:live.id,owners:live.owners});}
  }
  private async seal(live:Live):Promise<void>{
    if(!live.pending)return;
    try{
      const {digests,transportDigest}=await live.pair.progress();
      await this.store.append(live.id,live.fence,{sequence:live.sequence,startFrame:live.startFrame,ticks:live.pending,
        buttons:live.pendingButtons,digests,transportDigest,state:live.decision,
        result:live.pair.result()});
      live.sequence++;live.pending=0;live.startFrame=live.pair.frame;
    }catch(error){await this.poison(live);throw error;}
  }
  async connect(owner:string,id:string):Promise<{epoch:number;nextSequence:number;frame:number}>{
    await this.open(owner,id);
    return this.exclusive(id,async()=>{
      const {live,side}=this.owned(owner,id);await this.seal(live);
      let connection;
      try{connection=await this.store.connect(owner,id,live.fence);}
      catch(error){await this.poison(live);throw error;}
      live.connection[side]=connection.epoch;live.disconnected[side]=null;live.buttons[side]=0;
      return connection;
    });
  }
  async input(owner:string,id:string,epoch:number,value:unknown):Promise<BattleInputAck>{
    const input=battleInput(value);
    return this.exclusive(id,async()=>{
      const {live,side}=this.owned(owner,id);
      if(live.connection[side]!==epoch||live.disconnected[side]!==null)
        throw new DomainError('BATTLE_CONNECTION_REPLACED','Reconnect your battle controls.',409);
      await this.seal(live);
      let acknowledgement;
      try{acknowledgement=await this.store.command(owner,id,live.fence,epoch,live.pair.frame,input);}
      catch(error){
        if(!(error instanceof DomainError)||['BATTLE_LEASE_LOST','BATTLE_CHANGED'].includes(error.code))await this.poison(live);
        throw error;
      }
      // A durable retry reports its old frame without applying the old held
      // state again after a newer command or a connection reset.
      try{
        const row=await this.store.row(owner,id);
        if(Number(row.fence)!==live.fence)throw new DomainError('BATTLE_LEASE_LOST','Reconnect to your verified battle.',409);
        live.buttons=[row.buttons_a,row.buttons_b];
      }catch(error){await this.poison(live);throw error;}
      return acknowledgement;
    });
  }
  async disconnect(owner:string,id:string,epoch:number):Promise<void>{
    return this.exclusive(id,async()=>{
      const found=this.live.get(id);if(!found||found.poisoned)return;
      const {live,side}=this.owned(owner,id);if(live.connection[side]!==epoch)return;
      await this.seal(live);
      try{if(await this.store.disconnect(owner,id,live.fence,epoch)){live.buttons[side]=0;live.disconnected[side]=this.clock();}}
      catch(error){await this.poison(live);throw error;}
    });
  }
  private timeout(live:Live,now:number):BattleResult|undefined{
    const absent=live.disconnected.map(time=>time!==null&&now-time>=60_000);
    if(absent[0]||absent[1])return {winner:absent[0]&&absent[1]?null:absent[0]?'b':'a',reason:'disconnect'};
    if(now>=live.expiresAt)return {winner:null,reason:'timeout'};
    if(live.decision.deadline!==null&&now>=live.decision.deadline&&live.decision.mask)
      return {winner:live.decision.mask===3?null:live.decision.mask===1?'b':'a',reason:'timeout'};
    return undefined;
  }
  private async finish(live:Live,result:BattleResult):Promise<BattleResult>{
    await this.seal(live);const saved=await this.repository.finish(live.id,result,live.fence);
    await live.pair.close();this.live.delete(live.id);this.emit('finished',{id:live.id,owners:live.owners,result:saved});return saved;
  }
  private async checkpoint(live:Live):Promise<void>{
    await this.seal(live);const points=await live.pair.checkpoint();
    await this.store.checkpoint(live.id,live.fence,live.pair.frame,live.sequence,points,live.decision);
    live.checkpointFrame=live.pair.frame;
  }
  async save(owner:string,id:string):Promise<void>{
    return this.exclusive(id,async()=>{const {live}=this.owned(owner,id);await this.checkpoint(live);});
  }
  async screen(owner:string,id:string):Promise<{frame:number;pixels:Uint8Array}>{
    return this.exclusive(id,async()=>{const {live,side}=this.owned(owner,id);
      return {frame:live.pair.frame,pixels:(await live.pair.screens([side===0?'a':'b']))[0]!};});
  }
  private async lobbyMember(owner:string):Promise<void>{
    const admission=await this.database.pool.query<{suspended_at:Date|null;in_lobby:boolean}>(
      `select p.suspended_at,exists(select 1 from private.game_sessions s
        where s.owner_id=p.id and s.status='lobby' and s.lease_expires_at>clock_timestamp()) as in_lobby
       from public.profiles p where p.id=$1`,[owner]);
    const profile=admission.rows[0];
    if(!profile)throw new DomainError('TRAINER_NOT_FOUND','That trainer was not found.',404);
    if(profile.suspended_at)throw new DomainError('ACCOUNT_SUSPENDED','This account cannot enter online play.',403);
    if(!profile.in_lobby)throw new DomainError('LOBBY_NOT_FOUND','Enter the lobby from your adventure first.',409);
  }
  /** The lobby list is SQL truth plus whatever frame this node actually hosts;
   * non-owning workers report null frames rather than guessing. This is the
   * server-internal projection used by the presence push; HTTP callers must use
   * `liveBattlesFor`, which enforces the lobby-session admission boundary. */
  async liveBattles():Promise<LiveBattle[]>{
    const battles=await this.repository.live();
    return battles.map(battle=>({...battle,frame:this.live.get(battle.id)?.pair.frame??null}));
  }
  /** The live list follows the same lobby-session and suspension contract as
   * spectating, so a signed-in account outside the lobby cannot browse it. */
  async liveBattlesFor(owner:string):Promise<LiveBattle[]>{
    await this.lobbyMember(owner);
    return this.liveBattles();
  }
  /** Spectators need a live lobby session, an unsuspended account and a battle
   * whose challenger opted in; they receive the same rendered pixels an owner
   * sees and nothing else. */
  async watch(owner:string,id:string,side:WatchSide):Promise<BattleWatch>{
    const battle=battleId(id);
    await this.lobbyMember(owner);
    return this.exclusive(battle,async()=>{
      const live=this.live.get(battle);
      if(!live||live.poisoned)throw new DomainError('BATTLE_NOT_FOUND','That live battle is no longer available.',404);
      const view=await this.repository.watchView(battle);
      if(!view||view.status!=='active')throw new DomainError('BATTLE_NOT_FOUND','That live battle is no longer available.',404);
      if(!view.watchable)throw new DomainError('WATCH_DISABLED','This trainer has not opened their battle to spectators.',403);
      return {frame:live.pair.frame,pixels:(await live.pair.screens([side]))[0]!,battle:{...view,side}};
    });
  }
  frame(owner:string,id:string):number{return this.owned(owner,id).live.pair.frame;}
  async tick():Promise<void>{
    if(this.closing)return;
    await Promise.all([...this.live].map(async([id,entry])=>{
        if(entry.poisoned||this.ticking.has(id))return;this.ticking.add(id);
        try{
        await this.exclusive(id,async()=>{
          const live=this.live.get(id);if(!live||live.poisoned)return;
          try{
            if(live.pair.done){await this.finish(live,live.pair.result()!);return;}
            const now=this.clock(),timeout=this.timeout(live,now);
            if(timeout){await this.finish(live,timeout);return;}
            live.credit=Math.min(75,live.credit+Math.max(0,now-live.clock)/FRAME_MILLISECONDS);live.clock=now;
            const frames=Math.min(4,Math.floor(live.credit));live.credit-=frames;
            let remaining=frames;
            while(remaining){
              if(!live.pending){live.startFrame=live.pair.frame;live.pendingButtons=[...live.buttons];}
              const count=Math.min(remaining,15-live.pending),decisions=await live.pair.advance(live.buttons,count);
              live.pending+=decisions.length;remaining-=decisions.length;
              for(const decision of decisions)live.decision=this.advanceDecision(live.decision,decision,now);
              if(live.pending>=15)await this.seal(live);
              if(live.pair.done){await this.finish(live,live.pair.result()!);return;}
            }
            if(live.pair.frame-live.checkpointFrame>=600)await this.checkpoint(live);
            if(live.pair.frame-live.screenFrame>=4){
              live.screenFrame=live.pair.frame;
              const sides=(live.owners.map((_,side)=>side) as (0|1)[]).filter(side=>live.disconnected[side]===null);
              const screens=await live.pair.screens(sides.map(side=>side===0?'a':'b'));
              for(const [index,side] of sides.entries())this.emit('screen',{id,ownerId:live.owners[side]!,side,frame:live.pair.frame,pixels:screens[index]!} satisfies BattleScreenEvent);
            }
          }catch(error){if(!live.poisoned)await this.poison(live);this.emit('run-error',{id,error});}
        });
        }finally{this.ticking.delete(id);}
    }));
  }
  async forfeit(owner:string,id:string):Promise<BattleResult>{
    const view=await this.repository.get(owner,id);
    return this.exclusive(id,async()=>{
      const live=this.live.get(id);
      if(live&&!live.poisoned)return this.finish(live,live.pair.result()??{winner:view.side==='a'?'b':'a',reason:'forfeit'});
      return this.repository.forfeit(owner,id);
    });
  }
  async decline(owner:string,id:string):Promise<BattleView>{return this.repository.decline(owner,id);}
  async expire():Promise<void>{
    for(const id of await this.store.expiredReservations())await this.repository.releaseStarting(id);
    for(const run of await this.store.expiredRuns())await this.exclusive(run.id,async()=>{
      const live=this.live.get(run.id);
      if(live&&!live.poisoned)return;
      const result=await this.repository.finish(run.id,{winner:null,reason:'timeout'});
      await live?.pair.close();this.live.delete(run.id);this.emit('finished',{...run,result});
    });
  }
  async close():Promise<void>{
    this.closing=true;
    let failure:unknown;
    for(const id of [...this.live.keys()])await this.exclusive(id,async()=>{
      const live=this.live.get(id);if(!live)return;
      try{if(!live.poisoned)await this.checkpoint(live);}catch(error){failure??=error;}
      finally{
        await live.pair.close();this.live.delete(id);
        try{await this.store.expireLease(id,live.fence);}catch(error){failure??=error;}
      }
    });
    if(this.ownsPool)await this.pool.close();
    if(failure)throw failure;
  }
}
