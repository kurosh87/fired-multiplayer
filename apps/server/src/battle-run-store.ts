import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Database} from './database.ts';
import type {ReservedBattle} from './battle-repository.ts';
import {assertRecord,DomainError,type GameVersion} from '../../../packages/protocol/index.ts';
import type {BattleResult} from '../../../packages/battles/session.ts';
import {battleId,battleInput,type BattleInputAck} from '../../../packages/battles/protocol.ts';
import {notifyLiveBattle} from './lobby-presence.ts';

export type DecisionState={kind:'turn'|'switch'|null;mask:number;epoch:number;deadline:number|null};
export type BattleProgress={sequence:number;startFrame:number;ticks:number;buttons:[number,number];
  digests:[string,string];transportDigest:string;state:DecisionState;result?:BattleResult};
export type BattleRunRow={battle_id:string;player_a:string;player_b:string;adventure_a:string;adventure_b:string;
  artifact_a:string;artifact_b:string;version_a:GameVersion;version_b:GameVersion;seed:string;expires_at:Date;
  initial_checkpoint_a:Buffer;initial_checkpoint_b:Buffer;checkpoint_a:Buffer|null;checkpoint_b:Buffer|null;
  checkpoint_state:DecisionState|null;
  checkpoint_frame:string|null;checkpoint_sequence:string|null;frame:string;next_sequence:string;
  next_input_a:string;next_input_b:string;buttons_a:number;buttons_b:number;connection_a:string;connection_b:string;
  disconnected_a:Date|null;disconnected_b:Date|null;decision_kind:DecisionState['kind'];decision_mask:number;
  decision_epoch:string;decision_deadline:Date|null;engine_result:BattleResult|null;fence:string;lease_expires_at:Date};
export type BattleJournalRow={sequence:string;start_frame:string;end_frame:string;ticks:number;buttons_a:number;buttons_b:number;
  digest_a:string;digest_b:string;transport_digest:string;state:DecisionState};
const select=`select r.*,b.player_a,b.player_b,b.adventure_a,b.adventure_b,b.artifact_a,b.artifact_b,b.seed,b.expires_at,
  aa.version as version_a,ab.version as version_b from private.battle_runs r join private.battles b on b.id=r.battle_id
  join private.adventures aa on aa.id=b.adventure_a and aa.owner_id=b.player_a
  join private.adventures ab on ab.id=b.adventure_b and ab.owner_id=b.player_b`;
function leaseLost():never{throw new DomainError('BATTLE_LEASE_LOST','Reconnect to restore the battle from its verified inputs.',409);}
export function decisionState(value:unknown):DecisionState{
  assertRecord(value);
  if(Object.keys(value).some(key=>!['kind','mask','epoch','deadline'].includes(key)))throw new DomainError('INVALID_BATTLE_STATE','Invalid private decision metadata.',503);
  if(value.kind!==null&&value.kind!=='turn'&&value.kind!=='switch'
    ||typeof value.mask!=='number'||!Number.isInteger(value.mask)||value.mask<0||value.mask>3
    ||typeof value.epoch!=='number'||!Number.isSafeInteger(value.epoch)||value.epoch<0
    ||(value.kind===null?(value.mask!==0||value.deadline!==null):typeof value.deadline!=='number'||!Number.isSafeInteger(value.deadline)))
    throw new DomainError('INVALID_BATTLE_STATE','The server returned invalid battle decision state.',503);
  return {kind:value.kind as DecisionState['kind'],mask:Number(value.mask),epoch:Number(value.epoch),deadline:value.deadline===null?null:Number(value.deadline)};
}

/** One durable owner for both private consoles. Every input ACK follows its
 * transaction; speculative ticks cannot be reused after a failed append. */
export class BattleRunStore{
  private database:Database;
  constructor(database:Database){this.database=database;}
  private async active(client:PoolClient,id:string,owner?:string):Promise<{player_a:string;player_b:string}>{
    const result=await client.query(`select player_a,player_b from private.battles where id=$1 and status='active'
      ${owner?'and (player_a=$2 or player_b=$2)':''} for update`,owner?[battleId(id),owner]:[battleId(id)]);
    if(!result.rows[0])throw new DomainError('BATTLE_CHANGED','This battle is no longer active.',409);return result.rows[0];
  }
  async initialize(battle:ReservedBattle,points:[Buffer,Buffer]):Promise<void>{
    await this.database.transaction(async client=>{
      const result=await client.query(`select status,player_a,player_b,adventure_a,adventure_b,artifact_a,artifact_b,seed,
        reservation_expires_at from private.battles where id=$1 for update`,[battle.id]);
      const row=result.rows[0];
      if(!row||!['starting','active'].includes(row.status)||row.player_a!==battle.saveA.ownerId||row.player_b!==battle.saveB.ownerId
        ||row.adventure_a!==battle.saveA.id||row.adventure_b!==battle.saveB.id
        ||row.artifact_a!==battle.artifacts[0]||row.artifact_b!==battle.artifacts[1]||Number(row.seed)!==battle.seed)
        throw new DomainError('BATTLE_CHANGED','The battle reservation changed before its consoles were saved.',409);
      const existing=await client.query('select battle_id from private.battle_runs where battle_id=$1',[battle.id]);
      if(row.status==='active'&&existing.rowCount)return;
      if(row.status!=='starting'||existing.rowCount||row.reservation_expires_at.getTime()<=Date.now())
        throw new DomainError('BATTLE_EXPIRED','The battle could not initialize before its reservation expired.',409);
      const saved=await client.query('select id,owner_id,revision from private.adventures where id in ($1,$2) order by id for update',[battle.saveA.id,battle.saveB.id]);
      for(const save of [battle.saveA,battle.saveB])if(!saved.rows.some(s=>s.id===save.id&&s.owner_id===save.ownerId&&Number(s.revision)===save.revision))
        throw new DomainError('SAVE_CHANGED','A reserved adventure changed.',409);
      const sessions=await client.query("select owner_id,adventure_id,status from private.game_sessions where owner_id in ($1,$2) and status<>'closed' order by id for update",[battle.saveA.ownerId,battle.saveB.ownerId]);
      if(sessions.rows.length!==2||sessions.rows.some(s=>s.status!=='battle'||s.adventure_id!==(s.owner_id===battle.saveA.ownerId?battle.saveA.id:battle.saveB.id)))
        throw new DomainError('BATTLE_CHANGED','The reserved adventure sessions changed.',409);
      await client.query(`insert into private.battle_runs(battle_id,initial_checkpoint_a,initial_checkpoint_b,disconnected_a,disconnected_b)
        values($1,$2,$3,clock_timestamp(),clock_timestamp())`,[battle.id,...points]);
      await client.query("update private.battles set status='active',reservation_expires_at=null,updated_at=now() where id=$1",[battle.id]);
      await notifyLiveBattle(client,battle.id);
    });
  }
  async row(owner:string,id:string):Promise<BattleRunRow>{
    const result=await this.database.pool.query<BattleRunRow>(`${select} where b.id=$1 and (b.player_a=$2 or b.player_b=$2)`,[battleId(id),owner]);
    if(!result.rows[0])throw new DomainError('BATTLE_RUN_NOT_FOUND','The battle consoles were not found.',404);return result.rows[0];
  }
  async claim(owner:string,id:string,localFence?:number):Promise<BattleRunRow>{
    await this.database.transaction(async client=>{
      await this.active(client,id,owner);
      if(this.database.identity==='netlify'&&(await client.query('select battle_id from private.battle_request_runs where battle_id=$1',[id])).rowCount)
        throw new DomainError('BATTLE_TRANSPORT_CONFLICT','Open this battle through its request transport.',409);
      const result=await client.query<BattleRunRow>('select * from private.battle_runs where battle_id=$1 for update',[id]);
      const row=result.rows[0];if(!row)throw new DomainError('BATTLE_RUN_NOT_FOUND','The battle consoles were not found.',404);
      if(row.lease_expires_at.getTime()>Date.now()&&Number(row.fence)!==localFence)
        throw new DomainError('BATTLE_ACTIVE_ELSEWHERE','This battle is active on another worker. Retry after one minute.',409);
      await client.query(`update private.battle_runs set fence=fence+1,lease_expires_at=clock_timestamp()+interval '60 seconds',
        connection_a=connection_a+1,connection_b=connection_b+1,buttons_a=0,buttons_b=0,
        disconnected_a=coalesce(disconnected_a,clock_timestamp()),disconnected_b=coalesce(disconnected_b,clock_timestamp()),updated_at=now() where battle_id=$1`,[id]);
    });
    return this.row(owner,id);
  }
  async connect(owner:string,id:string,fence:number):Promise<{epoch:number;nextSequence:number;frame:number}>{
    return this.database.transaction(async client=>{
      const battle=await this.active(client,id,owner),side=battle.player_a===owner?'a':'b';
      const result=await client.query(`update private.battle_runs set connection_${side}=connection_${side}+1,
        disconnected_${side}=null,buttons_${side}=0,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
        where battle_id=$1 and fence=$2 and lease_expires_at>clock_timestamp() returning connection_${side} as epoch,next_input_${side} as next_sequence,frame`,[id,fence]);
      if(!result.rows[0])leaseLost();const row=result.rows[0];return {epoch:Number(row.epoch),nextSequence:Number(row.next_sequence),frame:Number(row.frame)};
    });
  }
  async disconnect(owner:string,id:string,fence:number,epoch:number):Promise<boolean>{
    return this.database.transaction(async client=>{
      const battle=await this.active(client,id,owner),side=battle.player_a===owner?'a':'b';
      const result=await client.query(`update private.battle_runs set disconnected_${side}=coalesce(disconnected_${side},clock_timestamp()),
        buttons_${side}=0,updated_at=now() where battle_id=$1 and fence=$2 and connection_${side}=$3`,[id,fence,epoch]);
      return Boolean(result.rowCount);
    });
  }
  async command(owner:string,id:string,fence:number,epoch:number,frame:number,value:unknown):Promise<BattleInputAck>{
    const input=battleInput(value),fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.database.transaction(async client=>{
      const battle=await this.active(client,id,owner),side=battle.player_a===owner?'a':'b';
      const locked=await client.query<BattleRunRow>('select * from private.battle_runs where battle_id=$1 for update',[id]);
      const row=locked.rows[0];
      if(!row||Number(row.fence)!==fence||row.lease_expires_at.getTime()<=Date.now())leaseLost();
      if(Number(side==='a'?row.connection_a:row.connection_b)!==epoch||(side==='a'?row.disconnected_a:row.disconnected_b)!==null)
        throw new DomainError('BATTLE_CONNECTION_REPLACED','Reconnect your battle controls.',409);
      const prior=await client.query(`select fingerprint,sequence,operation_id,apply_frame from private.battle_commands
        where battle_id=$1 and owner_id=$2 and (sequence=$3 or operation_id=$4)`,[id,owner,input.sequence,input.operationId]);
      if(prior.rows[0]){
        const stored=prior.rows[0];
        if(prior.rows.length!==1||stored.fingerprint!==fingerprint)throw new DomainError('BATTLE_INPUT_CONFLICT','An accepted button command cannot be rewritten.',409);
        return {type:'buttons-accepted',protocol:1,sequence:Number(stored.sequence),operationId:stored.operation_id,frame:Number(stored.apply_frame)};
      }
      if(row.engine_result)throw new DomainError('BATTLE_FINISHED','The original consoles have finished.',409);
      if(Number(side==='a'?row.next_input_a:row.next_input_b)!==input.sequence||Number(row.frame)!==frame)
        throw new DomainError('BATTLE_INPUT_OUT_OF_ORDER','Resume from the last accepted battle command.',409);
      await client.query(`insert into private.battle_commands(battle_id,owner_id,sequence,operation_id,fingerprint,buttons,apply_frame,connection_epoch)
        values($1,$2,$3,$4,$5,$6,$7,$8)`,[id,owner,input.sequence,input.operationId,fingerprint,input.buttons,frame,epoch]);
      await client.query(`update private.battle_runs set next_input_${side}=next_input_${side}+1,buttons_${side}=$2,
        lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now() where battle_id=$1`,[id,input.buttons]);
      return {type:'buttons-accepted',protocol:1,sequence:input.sequence,operationId:input.operationId,frame};
    });
  }
  async append(id:string,fence:number,entry:BattleProgress):Promise<void>{
    decisionState(entry.state);
    if(entry.result&&(entry.result.reason!=='finished'||!['a','b',null].includes(entry.result.winner)||entry.state.kind!==null||entry.state.mask!==0))
      throw new DomainError('INVALID_BATTLE_RESULT','A completed original battle has invalid private metadata.',503);
    await this.database.transaction(async client=>{
      await this.active(client,id);
      const updated=await client.query(`update private.battle_runs set frame=frame+$4,next_sequence=next_sequence+1,
        decision_kind=$7,decision_mask=$8,decision_epoch=$9,decision_deadline=$10,engine_result=$12,
        lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
        where battle_id=$1 and fence=$2 and next_sequence=$3 and frame=$5 and buttons_a=$6 and buttons_b=$11
        and lease_expires_at>clock_timestamp() and decision_epoch<=$9 and engine_result is null returning battle_id`,
      [id,fence,entry.sequence,entry.ticks,entry.startFrame,entry.buttons[0],entry.state.kind,entry.state.mask,entry.state.epoch,
        entry.state.deadline===null?null:new Date(entry.state.deadline),entry.buttons[1],entry.result??null]);
      if(!updated.rowCount)leaseLost();
      await client.query(`insert into private.battle_input_journal(battle_id,sequence,start_frame,end_frame,ticks,buttons_a,buttons_b,digest_a,digest_b,transport_digest,state)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,entry.sequence,entry.startFrame,entry.startFrame+entry.ticks,
        entry.ticks,...entry.buttons,...entry.digests,entry.transportDigest,entry.state]);
    });
  }
  async entries(id:string,sequence:number):Promise<BattleJournalRow[]>{
    const result=await this.database.pool.query<BattleJournalRow>('select * from private.battle_input_journal where battle_id=$1 and sequence>=$2 order by sequence',[battleId(id),sequence]);return result.rows;
  }
  async checkpoint(id:string,fence:number,frame:number,sequence:number,points:[Buffer,Buffer],decision:DecisionState):Promise<void>{
    decisionState(decision);
    const result=await this.database.pool.query(`update private.battle_runs r set checkpoint_a=$5,checkpoint_b=$6,
      checkpoint_frame=$3,checkpoint_sequence=$4,checkpoint_state=$7,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
      where battle_id=$1 and fence=$2 and frame=$3 and next_sequence=$4 and lease_expires_at>clock_timestamp()
      and $7::jsonb=jsonb_build_object('kind',decision_kind,'mask',decision_mask,'epoch',decision_epoch,
        'deadline',case when decision_deadline is null then null else (extract(epoch from decision_deadline)*1000)::bigint end)
      and exists(select 1 from private.battles b where b.id=r.battle_id and b.status='active' and b.expires_at>clock_timestamp())`,[id,fence,frame,sequence,...points,decision]);
    if(!result.rowCount)leaseLost();
  }
  async expireLease(id:string,fence:number):Promise<void>{await this.database.pool.query('update private.battle_runs set lease_expires_at=clock_timestamp() where battle_id=$1 and fence=$2',[battleId(id),fence]);}
  async expiredReservations():Promise<string[]>{
    const result=await this.database.pool.query("select id from private.battles where status='starting' and reservation_expires_at<=clock_timestamp() order by reservation_expires_at limit 100");return result.rows.map(row=>row.id);
  }
  async expiredRuns():Promise<{id:string;owners:[string,string]}[]>{
    const result=await this.database.pool.query(`select b.id,b.player_a,b.player_b from private.battles b
      join private.battle_runs r on r.battle_id=b.id where b.status='active'
      and b.expires_at<=clock_timestamp() and r.lease_expires_at<=clock_timestamp() order by b.expires_at limit 100`);
    return result.rows.map(row=>({id:row.id,owners:[row.player_a,row.player_b]}));
  }
}
