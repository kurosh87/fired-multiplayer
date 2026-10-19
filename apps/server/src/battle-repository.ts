import type {PoolClient} from 'pg';
import type {Database} from './database.ts';
import {DomainError,gameVersion} from '../../../packages/protocol/index.ts';
import {battleId,type BattleView,type LiveBattle} from '../../../packages/battles/protocol.ts';
import type {BattleResult} from '../../../packages/battles/session.ts';
import type {CanonicalSave} from '../../../packages/trading/atomic-trade.ts';
import {notifyLobbyPresence,notifyLiveBattle} from './lobby-presence.ts';

type BattleRow={id:string;player_a:string;player_b:string;adventure_a:string;adventure_b:string;
  revision_a:string;revision_b:string;status:BattleView['status'];handle_a:string;handle_b:string;
  version_a:string;version_b:string;expires_at:Date;reservation_expires_at:Date|null;seed:string|null;
  artifact_a:string|null;artifact_b:string|null;result:BattleResult|null;updated_at:Date};
const selection=`select b.*,pa.handle as handle_a,pb.handle as handle_b,aa.version as version_a,ab.version as version_b
  from private.battles b join public.profiles pa on pa.id=b.player_a join public.profiles pb on pb.id=b.player_b
  join private.adventures aa on aa.id=b.adventure_a join private.adventures ab on ab.id=b.adventure_b`;
export type ReservedBattle={id:string;saveA:CanonicalSave;saveB:CanonicalSave;seed:number;artifacts:[string,string];expiresAt:number};
function view(row:BattleRow,owner:string):BattleView{
  return {id:row.id,side:row.player_a===owner?'a':'b',
    status:row.status==='offered'&&row.expires_at.getTime()<=Date.now()?'expired':row.status,
    playerA:{id:row.player_a,handle:row.handle_a,version:gameVersion(row.version_a)},
    playerB:{id:row.player_b,handle:row.handle_b,version:gameVersion(row.version_b)},
    rules:{format:'singles',levels:'earned',ranked:false},expiresAt:row.expires_at.getTime(),result:row.result};
}

/** Admission/result transactions never write an adventure cartridge. Battle
 * cores run separately, with the exact adventures/revisions reserved here. */
export class BattleRepository{
  private database:Database;
  private ready:((saves:[CanonicalSave,CanonicalSave])=>void)|undefined;
  constructor(database:Database,ready?:(saves:[CanonicalSave,CanonicalSave])=>void){this.database=database;this.ready=ready;}
  private async owned(client:PoolClient,id:string,owner:string,lock=true):Promise<BattleRow>{
    const result=await client.query<BattleRow>(`${selection} where b.id=$1 and (b.player_a=$2 or b.player_b=$2)${lock?' for update of b':''}`,[battleId(id),owner]);
    if(!result.rows[0])throw new DomainError('BATTLE_NOT_FOUND','The battle was not found.',404);return result.rows[0];
  }
  private async saves(client:PoolClient,row:Pick<BattleRow,'player_a'|'player_b'|'adventure_a'|'adventure_b'>,
    status:'lobby'|'battle',expected?:[number,number]):Promise<[CanonicalSave,CanonicalSave]>{
    const profiles=await client.query('select id,suspended_at from public.profiles where id in ($1,$2)',[row.player_a,row.player_b]);
    if(profiles.rows.length!==2||profiles.rows.some(p=>p.suspended_at))throw new DomainError('TRAINER_NOT_READY','Both trainers must be available.',409);
    const saved=await client.query('select id,owner_id,version,revision,flash from private.adventures where id in ($1,$2) order by id for update',[row.adventure_a,row.adventure_b]);
    const find=(id:string,owner:string):CanonicalSave=>{
      const save=saved.rows.find(item=>item.id===id&&item.owner_id===owner);
      if(!save?.flash)throw new DomainError('SAVE_REQUIRED','Both trainers need verified saved adventures.',409);
      return {id,ownerId:owner,version:gameVersion(save.version),revision:Number(save.revision),flash:new Uint8Array(save.flash)};
    };
    const saves:[CanonicalSave,CanonicalSave]=[find(row.adventure_a,row.player_a),find(row.adventure_b,row.player_b)];
    if(expected&&saves.some((save,i)=>save.revision!==expected[i]))throw new DomainError('SAVE_CHANGED','A party changed. Send a new battle challenge.',409);
    const sessions=await client.query(`select id,owner_id,adventure_id,status,lease_expires_at from private.game_sessions
      where owner_id in ($1,$2) and status<>'closed' order by id for update`,[row.player_a,row.player_b]);
    if(sessions.rows.length!==2||sessions.rows.some(s=>s.status!==status
      ||s.adventure_id!==(s.owner_id===row.player_a?saves[0].id:saves[1].id)
      ||status==='lobby'&&s.lease_expires_at.getTime()<=Date.now()))
      throw new DomainError('TRAINER_NOT_READY','Both trainers must pause these adventures in the lobby.',409);
    return saves;
  }
  async get(owner:string,id:string):Promise<BattleView>{return this.database.transaction(async client=>view(await this.owned(client,id,owner,false),owner));}
  async list(owner:string):Promise<BattleView[]>{
    const result=await this.database.pool.query<BattleRow>(`${selection} where (b.player_a=$1 or b.player_b=$1)
      and (b.status in ('starting','active') or b.status='offered' and b.expires_at>clock_timestamp()) order by b.created_at desc limit 32`,[owner]);
    return result.rows.map(row=>view(row,owner));
  }
  /** Public projection of running battles for the lobby's live list. Frames are
   * filled in by the node that hosts the battle; no console or journal reads. */
  async live():Promise<LiveBattle[]>{
    const result=await this.database.pool.query<BattleRow>(`${selection} where b.status='active'
      order by b.updated_at desc limit 50`);
    return result.rows.map(row=>({id:row.id,
      playerA:{handle:row.handle_a,version:gameVersion(row.version_a)},
      playerB:{handle:row.handle_b,version:gameVersion(row.version_b)},
      frame:null,startedAt:row.updated_at.getTime()}));
  }
  /** A running battle's public projection for spectators; ownership is not
   * required because it carries only what the lobby already shows. */
  async watchView(id:string):Promise<BattleView|null>{
    const result=await this.database.pool.query<BattleRow>(`${selection} where b.id=$1`,[battleId(id)]);
    const row=result.rows[0];return row?view(row,row.player_a):null;
  }
  async challenge(owner:string,peer:string):Promise<BattleView>{
    peer=battleId(peer);if(peer===owner)throw new DomainError('INVALID_BATTLE','Choose another trainer.');
    return this.database.transaction(async client=>{
      const profiles=await client.query('select id from public.profiles where id in ($1,$2) order by id for update',[owner,peer]);
      if(profiles.rows.length!==2)throw new DomainError('TRAINER_NOT_FOUND','That trainer was not found.',404);
      // No battle row lock after profile locks: accept holds battle then saves.
      const existing=await client.query<BattleRow>(`${selection} where ((b.player_a=$1 and b.player_b=$2) or (b.player_a=$2 and b.player_b=$1))
        and (b.status in ('starting','active') or b.status='offered' and b.expires_at>clock_timestamp()) order by b.created_at desc limit 1`,[owner,peer]);
      if(existing.rows[0])return view(existing.rows[0],owner);
      const pending=await client.query("select player_a,player_b from private.battles where status='offered' and expires_at>clock_timestamp() and (player_a in ($1,$2) or player_b in ($1,$2))",[owner,peer]);
      if([owner,peer].some(id=>pending.rows.filter(row=>row.player_a===id||row.player_b===id).length>=16))
        throw new DomainError('TOO_MANY_CHALLENGES','Finish or decline an existing challenge first.',429);
      const sessions=await client.query("select owner_id,adventure_id from private.game_sessions where owner_id in ($1,$2) and status='lobby'",[owner,peer]);
      const a=sessions.rows.find(row=>row.owner_id===owner),b=sessions.rows.find(row=>row.owner_id===peer);
      if(!a||!b)throw new DomainError('TRAINER_NOT_READY','Both trainers must be in the lobby.',409);
      const saves=await this.saves(client,{player_a:owner,player_b:peer,adventure_a:a.adventure_id,adventure_b:b.adventure_id},'lobby');
      this.ready?.(saves);
      const inserted=await client.query(`insert into private.battles(player_a,player_b,adventure_a,adventure_b,revision_a,revision_b,expires_at)
        values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '5 minutes') returning id`,[owner,peer,saves[0].id,saves[1].id,saves[0].revision,saves[1].revision]);
      return view(await this.owned(client,inserted.rows[0].id,owner),owner);
    });
  }
  async reserve(owner:string,id:string,artifacts:[string,string],seed:number):Promise<ReservedBattle>{
    if(!Number.isInteger(seed)||seed<0||seed>0xffffffff||artifacts.some(value=>!/^[a-z0-9][a-z0-9._-]{2,99}$/.test(value)))
      throw new DomainError('INVALID_BATTLE_ENGINE','Invalid server battle artifact or entropy.',503);
    return this.database.transaction(async client=>{
      const row=await this.owned(client,id,owner);
      if(owner!==row.player_b)throw new DomainError('BATTLE_ACCEPT_FORBIDDEN','Only the challenged trainer can accept.',403);
      if(!['offered','starting','active'].includes(row.status))throw new DomainError('BATTLE_CHANGED','This challenge is no longer available.',409);
      const status=row.status==='offered'?'lobby':'battle';
      if(row.expires_at.getTime()<=Date.now()||row.status==='starting'&&row.reservation_expires_at!.getTime()<=Date.now())
        throw new DomainError('BATTLE_EXPIRED','The battle challenge expired.',409);
      const saves=await this.saves(client,row,status,[Number(row.revision_a),Number(row.revision_b)]);
      if(row.status==='offered'){
        const changed=await client.query(`update private.battles set status='starting',seed=$2,artifact_a=$3,artifact_b=$4,
          expires_at=clock_timestamp()+interval '1 hour',reservation_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now() where id=$1 returning *`,[row.id,seed,...artifacts]);
        Object.assign(row,changed.rows[0]);
        await client.query(`update private.game_sessions set status='battle',fence=fence+1,updated_at=now()
          where owner_id in ($1,$2) and status='lobby'`,[row.player_a,row.player_b]);
        await notifyLobbyPresence(client,row.player_a);
        await notifyLobbyPresence(client,row.player_b);
      }
      return {id:row.id,saveA:saves[0],saveB:saves[1],seed:Number(row.seed),artifacts:[row.artifact_a!,row.artifact_b!],expiresAt:row.expires_at.getTime()};
    });
  }
  async reserved(owner:string,id:string):Promise<ReservedBattle>{
    return this.database.transaction(async client=>{
      const row=await this.owned(client,id,owner);
      if(!['starting','active'].includes(row.status))throw new DomainError('BATTLE_CHANGED','This battle is no longer running.',409);
      if(row.expires_at.getTime()<=Date.now()||row.status==='starting'&&row.reservation_expires_at!.getTime()<=Date.now())
        throw new DomainError('BATTLE_EXPIRED','This battle reservation expired.',409);
      const saves=await this.saves(client,row,'battle',[Number(row.revision_a),Number(row.revision_b)]);
      return {id:row.id,saveA:saves[0],saveB:saves[1],seed:Number(row.seed),artifacts:[row.artifact_a!,row.artifact_b!],expiresAt:row.expires_at.getTime()};
    });
  }
  async decline(owner:string,id:string):Promise<BattleView>{
    return this.database.transaction(async client=>{
      const row=await this.owned(client,id,owner);
      if(['cancelled','expired'].includes(row.status))return view(row,owner);
      if(row.status!=='offered')throw new DomainError('BATTLE_BUSY','This battle has started. Forfeit to leave it.',409);
      await client.query("update private.battles set status='cancelled',updated_at=now() where id=$1",[row.id]);
      return view(await this.owned(client,id,owner),owner);
    });
  }
  async releaseStarting(id:string):Promise<void>{
    await this.database.transaction(async client=>{
      const result=await client.query("select * from private.battles where id=$1 and status='starting' for update",[battleId(id)]);
      const row=result.rows[0];if(!row)return;
      await client.query('select id from private.adventures where id in ($1,$2) order by id for update',[row.adventure_a,row.adventure_b]);
      await client.query("select id from private.game_sessions where adventure_id in ($1,$2) and status='battle' order by id for update",[row.adventure_a,row.adventure_b]);
      await client.query("update private.battles set status='cancelled',reservation_expires_at=null,updated_at=now() where id=$1",[row.id]);
      const returned=await client.query<{owner_id:string}>(`update private.game_sessions set status='lobby',fence=fence+1,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
        where adventure_id in ($1,$2) and status='battle' returning owner_id`,[row.adventure_a,row.adventure_b]);
      for(const session of returned.rows)await notifyLobbyPresence(client,session.owner_id);
    });
  }
  async finish(id:string,result:BattleResult,expectedFence?:number):Promise<BattleResult>{
    return this.database.transaction(client=>this.finishWithin(client,id,result,expectedFence));
  }
  /** Request-driven execution commits consoles, clocks, result and response
   * receipt in one transaction. The caller owns the transaction boundary. */
  async finishWithin(client:PoolClient,id:string,result:BattleResult,expectedFence?:number):Promise<BattleResult>{
    if(!['finished','forfeit','disconnect','timeout','engine_error'].includes(result.reason)||!['a','b',null].includes(result.winner)
      ||result.reason==='engine_error'&&result.winner!==null)
      throw new DomainError('INVALID_BATTLE_RESULT','The server returned an invalid battle result.',503);
      const saved=await client.query<BattleRow>('select * from private.battles where id=$1 for update',[battleId(id)]);
      const row=saved.rows[0];if(!row)throw new DomainError('BATTLE_NOT_FOUND','The battle was not found.',404);
      if(row.status==='finished')return row.result!;
      if(row.status!=='active')throw new DomainError('BATTLE_CHANGED','This battle is no longer active.',409);
      const engine=await client.query('select engine_result from private.battle_runs where battle_id=$1',[row.id]);
      const resolved:BattleResult=engine.rows[0]?.engine_result??result;
      if(expectedFence!==undefined){
        const run=await client.query('select fence,lease_expires_at from private.battle_runs where battle_id=$1',[row.id]);
        if(!run.rows[0]||Number(run.rows[0].fence)!==expectedFence||run.rows[0].lease_expires_at.getTime()<=Date.now())
          throw new DomainError('BATTLE_LEASE_LOST','The battle resumed on another worker.',409);
      }
      await client.query('select id from private.adventures where id in ($1,$2) order by id for update',[row.adventure_a,row.adventure_b]);
      await client.query("select id from private.game_sessions where adventure_id in ($1,$2) and status='battle' order by id for update",[row.adventure_a,row.adventure_b]);
      await client.query("update private.battles set status='finished',result=$2,updated_at=now() where id=$1",[row.id,resolved]);
      await notifyLiveBattle(client,row.id);
      const returned=await client.query<{owner_id:string}>(`update private.game_sessions set status='lobby',fence=fence+1,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
        where adventure_id in ($1,$2) and status='battle' returning owner_id`,[row.adventure_a,row.adventure_b]);
      for(const session of returned.rows)await notifyLobbyPresence(client,session.owner_id);
      await client.query('update private.battle_runs set fence=fence+1,lease_expires_at=clock_timestamp() where battle_id=$1',[row.id]);
      return resolved;
  }
  async forfeit(owner:string,id:string):Promise<BattleResult>{
    const battle=await this.get(owner,id);
    return this.finish(id,{winner:battle.side==='a'?'b':'a',reason:'forfeit'});
  }
}
