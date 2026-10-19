import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import { BattleRepository } from './battle-repository.ts';
import { decisionState, type BattleRunRow, type BattleProgress, type DecisionState } from './battle-run-store.ts';
import { DomainError } from '../../../packages/protocol/index.ts';
import { battleId, type BattleView } from '../../../packages/battles/protocol.ts';
import { REQUEST_INPUT_LEAD, type RequestBattleInput, type RequestBattleController } from '../../../packages/battles/request-protocol.ts';
import { refillRequestClock, requestClockFrames, spendRequestClock, type RequestClock } from '../../../packages/battles/request-clock.ts';
import type { BattleResult, Side } from '../../../packages/battles/session.ts';

type Run = BattleRunRow & { status: BattleView['status']; result: BattleResult | null };
type State = { battle_id: string; revision: string; claim_id: string | null; claim_until: Date | null;
  control_id_a: string | null; control_id_b: string | null; control_epoch_a: string; control_epoch_b: string;
  last_request_side: Side | null; waiting_us_a: string | null; waiting_us_b: string | null;
  clock_us: string; credit: string; input_through_a: string; input_through_b: string; seen_us_a: string; seen_us_b: string; screen_a: Buffer; screen_b: Buffer };
export type QueuedBattleInput = { side: Side; start: number; end: number; buttons: number };
export type RequestBattleClaim = { run: Run; state: State; owner: string; side: Side; request: RequestBattleInput; fingerprint: string;
  claimId: string; fence: number; clock: RequestClock; nowUs: bigint; inputThrough: [number, number]; added: QueuedBattleInput[];
  inputs: QueuedBattleInput[]; frames: number; decision: DecisionState; terminal: BattleResult | null };
export type RequestBattleComputation = { frame: number; points?: [Buffer, Buffer]; caches: [Buffer, Buffer];
  decision: DecisionState; entries: BattleProgress[]; buttons: [number, number]; clock: RequestClock;
  engineResult?: BattleResult; result: BattleResult | null; response: Buffer };
export type RequestClockReader = (client: PoolClient) => Promise<bigint>;
type ClaimResult = { receipt: Buffer } | { claim: RequestBattleClaim };
const dbClock: RequestClockReader = async client => BigInt((await client.query("select floor(extract(epoch from clock_timestamp())*1000000)::bigint as us")).rows[0].us);
function integer(value: string | number): number {
  const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new DomainError('BATTLE_STATE_INVALID','The durable battle counters are invalid.',503); return result;
}
function changed(): never { throw new DomainError('BATTLE_REQUEST_CHANGED', 'The battle changed while this request was running. Retry the same request.', 409); }
function replaced(): never { throw new DomainError('BATTLE_CONTROL_REPLACED','This battle is open in another tab. Reconnect here to take control.',409); }

/** Claim/compute/commit. Only the two short SQL phases hold locks. Neither a
 * process cache nor an uncommitted worker can grant time or acknowledge input. */
export class RequestBattleStore {
  readonly database: Database;
  private clock: RequestClockReader;
  private repository: BattleRepository;
  constructor(database: Database, clock: RequestClockReader = dbClock) {
    if (database.identity !== 'netlify') throw new Error('Request battles require the shared Kanto account schema.');
    this.database = database; this.clock = clock; this.repository = new BattleRepository(database);
  }
  private transaction<T>(body:(client:PoolClient)=>Promise<T>):Promise<T>{
    return this.database.transaction(async client=>{
      // Bound individual queries and the complete SQL phase, including a slow
      // final receipt write. This requires transaction_timeout (Postgres 17+).
      await client.query("set local transaction_timeout='8s'; set local statement_timeout='1500ms'; set local lock_timeout='1s'; set local idle_in_transaction_session_timeout='5s'");
      return body(client);
    });
  }
  async counters(owner: string, id: string): Promise<{ frame: number; nextSequence: number; inputThrough: number; controllerEpoch:number }> {
    const row = (await this.database.pool.query(`select r.frame,
      case when b.player_a=$2 then r.next_input_a else r.next_input_b end as sequence,
      case when b.player_a=$2 then q.input_through_a else q.input_through_b end as through,
      case when b.player_a=$2 then q.control_epoch_a else q.control_epoch_b end as control_epoch
      from private.battles b join private.battle_runs r on r.battle_id=b.id
      join private.battle_request_runs q on q.battle_id=b.id where b.id=$1 and (b.player_a=$2 or b.player_b=$2)`, [battleId(id),owner])).rows[0];
    if (!row) throw new DomainError('BATTLE_RUN_NOT_FOUND','The request-driven battle was not found.',404);
    return { frame: integer(row.frame), nextSequence: integer(row.sequence), inputThrough: Math.max(integer(row.frame),integer(row.through)), controllerEpoch:integer(row.control_epoch) };
  }
  private async locked(client: PoolClient, owner: string, id: string): Promise<Run> {
    const battle = (await client.query(`select b.*,aa.version as version_a,ab.version as version_b from private.battles b
      join private.adventures aa on aa.id=b.adventure_a and aa.owner_id=b.player_a
      join private.adventures ab on ab.id=b.adventure_b and ab.owner_id=b.player_b
      where b.id=$1 and (b.player_a=$2 or b.player_b=$2) for update of b`, [battleId(id), owner])).rows[0];
    if (!battle) throw new DomainError('BATTLE_NOT_FOUND', 'The battle was not found.', 404);
    const run = (await client.query('select * from private.battle_runs where battle_id=$1 for update', [id])).rows[0];
    if (!run) throw new DomainError('BATTLE_RUN_NOT_FOUND', 'Accept the battle before opening its consoles.', 409);
    return { ...run, ...battle, battle_id: id };
  }
  private async presence(client:PoolClient,run:Run,state:State,side:Side,atUs:bigint,waiting=false):Promise<void>{
    // Presence can survive a busy/replayed request without acknowledging its
    // controls or minting frame credit. An expired absence cannot be revived.
    if(run.status!=='active'||atUs-BigInt(state[`seen_us_${side}`])>=60_000_000n)return;
    await client.query(`update private.battle_request_runs set seen_us_${side}=greatest(seen_us_${side},$2)
      ${waiting?`,waiting_us_${side}=$2`:''} where battle_id=$1`,[run.battle_id,atUs.toString()]);
  }
  async attach(owner: string, id: string, caches: [Buffer, Buffer]): Promise<void> {
    await this.transaction(async client => {
      const run = await this.locked(client, owner, id);
      if ((await client.query('select battle_id from private.battle_request_runs where battle_id=$1', [id])).rowCount) return;
      if (run.status !== 'active' || integer(run.frame) !== 0 || integer(run.next_sequence) !== 0
        || (await client.query('select 1 from private.battle_runs where battle_id=$1 and lease_expires_at>clock_timestamp()', [id])).rowCount)
        throw new DomainError('BATTLE_TRANSPORT_CONFLICT', 'This battle already belongs to another execution transport.', 409);
      const now = await this.clock(client);
      await client.query(`insert into private.battle_request_runs(battle_id,clock_us,seen_us_a,seen_us_b,screen_a,screen_b)
        values($1,$2,$2,$2,$3,$4)`, [id, now.toString(), ...caches]);
      await client.query('update private.battle_runs set fence=fence+1,lease_expires_at=clock_timestamp() where battle_id=$1', [id]);
    });
  }
  async open(owner: string, id: string, connectionId: string, expectedEpoch:number): Promise<RequestBattleController> {
    battleId(connectionId);
    return this.transaction(async client => {
      const run=await this.locked(client,owner,id), side:Side=run.player_a===owner?'a':'b';
      const state=(await client.query<State>('select * from private.battle_request_runs where battle_id=$1 for update',[id])).rows[0];
      if(!state)throw new DomainError('BATTLE_TRANSPORT_CONFLICT','This battle does not use request-driven execution.',409);
      if(!['active','finished'].includes(run.status))throw new DomainError('BATTLE_CHANGED','This battle is not active.',409);
      const prior=(await client.query('select epoch from private.battle_control_connections where battle_id=$1 and owner_id=$2 and connection_id=$3',[id,owner,connectionId])).rows[0];
      const current=integer(state[`control_epoch_${side}`]);
      if(prior){
        if(integer(prior.epoch)!==current||state[`control_id_${side}`]!==connectionId)replaced();
        return {connectionId,epoch:current};
      }
      if(current!==expectedEpoch)throw new DomainError('BATTLE_CONTROL_CHANGED','Another tab connected while this tab was opening. Reconnect here to take control.',409);
      const epoch=current+1; if(!Number.isSafeInteger(epoch))throw new Error('Battle controller epoch overflow.');
      await client.query('insert into private.battle_control_connections(battle_id,owner_id,connection_id,epoch) values($1,$2,$3,$4)',[id,owner,connectionId,epoch]);
      // Release this tab's unprocessed held controls. Preserve the opponent's
      // queue and clock; invalidate speculative work under the same lock order.
      await client.query('delete from private.battle_request_inputs where battle_id=$1 and side=$2',[id,side]);
      await client.query(`update private.battle_request_runs set control_id_${side}=$2,control_epoch_${side}=$3,
        input_through_${side}=$4,waiting_us_${side}=null,revision=revision+1,claim_id=null,claim_until=null where battle_id=$1`,[id,connectionId,epoch,run.frame]);
      await client.query('update private.battle_runs set fence=fence+1,lease_expires_at=clock_timestamp() where battle_id=$1',[id]);
      return {connectionId,epoch};
    });
  }
  async claim(owner: string, id: string, request: RequestBattleInput): Promise<ClaimResult> {
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const outcome=await this.transaction<ClaimResult|{busy:true}>(async client => {
      const run = await this.locked(client, owner, id), side: Side = run.player_a === owner ? 'a' : 'b';
      const state = (await client.query<State>('select * from private.battle_request_runs where battle_id=$1 for update', [id])).rows[0];
      if (!state) throw new DomainError('BATTLE_TRANSPORT_CONFLICT', 'This battle does not use request-driven execution.', 409);
      if(state[`control_id_${side}`]!==request.controller.connectionId||integer(state[`control_epoch_${side}`])!==request.controller.epoch)replaced();
      const receipts = (await client.query('select fingerprint,response from private.battle_request_receipts where battle_id=$1 and owner_id=$2 and (sequence=$3 or operation_id=$4)',
        [id, owner, request.sequence, request.operationId])).rows;
      if (receipts.length) {
        if (receipts.length !== 1 || receipts[0].fingerprint !== fingerprint) throw new DomainError('BATTLE_INPUT_CONFLICT', 'An accepted request cannot be rewritten.', 409);
        if(integer(side==='a'?run.next_input_a:run.next_input_b)===request.sequence+1){
          const observed=await this.clock(client),atUs=observed>BigInt(state.clock_us)?observed:BigInt(state.clock_us);
          await this.presence(client,run,state,side,atUs);
        }
        return { receipt: receipts[0].response };
      }
      if (!['active', 'finished'].includes(run.status)) throw new DomainError('BATTLE_CHANGED', 'This battle is not active.', 409);
      if (integer(side === 'a' ? run.next_input_a : run.next_input_b) !== request.sequence)
        throw new DomainError('BATTLE_INPUT_OUT_OF_ORDER', 'Retry from your last accepted request sequence.', 409);
      const nowUs = await this.clock(client), clock = refillRequestClock({ atUs: BigInt(state.clock_us), credit: BigInt(state.credit) }, nowUs);
      if (state.claim_id && (await client.query('select 1 from private.battle_request_runs where battle_id=$1 and claim_until>clock_timestamp()', [id])).rowCount){
        const frame=integer(run.frame),through=Math.max(frame,integer(state[`input_through_${side}`]))+request.runs.reduce((sum,run)=>sum+run.frames,0);
        await this.presence(client,run,state,side,clock.atUs,through<=frame+REQUEST_INPUT_LEAD);return {busy:true};
      }
      const frame = integer(run.frame), inputThrough: [number, number] = [Math.max(frame,integer(state.input_through_a)), Math.max(frame,integer(state.input_through_b))];
      const decision = decisionState({ kind: run.decision_kind, mask: run.decision_mask, epoch: integer(run.decision_epoch), deadline: run.decision_deadline?.getTime() ?? null });
      let terminal = run.result;
      if (run.status === 'active') {
        const absent = [state.seen_us_a, state.seen_us_b].map(time => clock.atUs - BigInt(time) >= 60_000_000n);
        if (absent[0] || absent[1]) terminal = { winner: absent[0] && absent[1] ? null : absent[0] ? 'b' : 'a', reason: 'disconnect' };
        else if (clock.atUs >= BigInt(run.expires_at.getTime()) * 1000n) terminal = { winner: null, reason: 'timeout' };
        else if (decision.deadline !== null && decision.mask && clock.atUs >= BigInt(decision.deadline) * 1000n)
          terminal = { winner: decision.mask === 3 ? null : decision.mask === 1 ? 'b' : 'a', reason: 'timeout' };
        else if (request.action === 'forfeit') terminal = { winner: side === 'a' ? 'b' : 'a', reason: 'forfeit' };
      }
      const added: QueuedBattleInput[] = [], index = side === 'a' ? 0 : 1;
      if (!terminal) for (const value of request.runs) {
        const start = inputThrough[index]; inputThrough[index] += value.frames;
        added.push({ side, start, end: inputThrough[index], buttons: value.buttons });
      }
      if (inputThrough.some(through => through < frame || through > frame + REQUEST_INPUT_LEAD))
        throw new DomainError('BATTLE_INPUT_BUFFER_FULL', 'Wait for queued controls to advance.', 409);
      const peer=side==='a'?'b':'a',waiting=state[`waiting_us_${peer}`],age=waiting===null?null:clock.atUs-BigInt(waiting);
      if(!terminal&&state.last_request_side===side&&age!==null&&age>=0n&&age<=2_000_000n){
        // Yield one turn to a peer that recently requested work. If it stops
        // retrying, its preference expires instead of freezing the battle.
        await this.presence(client,run,state,side,clock.atUs,true);return {busy:true};
      }
      const queued = (await client.query('select side,start_frame,end_frame,buttons from private.battle_request_inputs where battle_id=$1 and end_frame>$2 order by side,start_frame', [id, frame])).rows;
      const inputs: QueuedBattleInput[] = [...queued.map(row => ({ side: row.side as Side, start: integer(row.start_frame), end: integer(row.end_frame), buttons: row.buttons })), ...added];
      for (const [index, value] of (['a', 'b'] as const).entries()) {
        let through = frame;
        for (const input of inputs.filter(item => item.side === value).sort((a, b) => a.start - b.start)) {
          if (input.start > through || input.end <= through || input.start < through && through !== frame)
            throw new DomainError('BATTLE_INPUT_JOURNAL_INVALID', 'The durable input queue is incomplete.', 503);
          through = input.end;
        }
        if (through !== inputThrough[index]) throw new DomainError('BATTLE_INPUT_JOURNAL_INVALID', 'The durable input queue is incomplete.', 503);
      }
      const claimId = randomUUID(), fence = integer(run.fence) + 1;
      await client.query("update private.battle_request_runs set claim_id=$2,claim_until=clock_timestamp()+interval '20 seconds' where battle_id=$1", [id, claimId]);
      await client.query("update private.battle_runs set fence=$2,lease_expires_at=clock_timestamp()+interval '20 seconds' where battle_id=$1", [id, fence]);
      return { claim: { run, state, owner, side, request, fingerprint, claimId, fence, clock, nowUs: clock.atUs, inputThrough, inputs, added,
        frames: terminal ? 0 : requestClockFrames(clock,60), decision, terminal } };
    });
    if('busy'in outcome)throw new DomainError('BATTLE_REQUEST_BUSY','Another request is committing this battle. Retry shortly.',409);
    return outcome;
  }
  async commit(claim: RequestBattleClaim, value: RequestBattleComputation): Promise<void> {
    await this.transaction(async client => {
      const run = await this.locked(client, claim.owner, claim.run.battle_id);
      const state = (await client.query<State>('select * from private.battle_request_runs where battle_id=$1 for update', [claim.run.battle_id])).rows[0];
      if (!state || state.claim_id !== claim.claimId || state.revision !== claim.state.revision || integer(run.fence) !== claim.fence
        || run.status !== claim.run.status || run.frame !== claim.run.frame || run.next_sequence !== claim.run.next_sequence
        || !(await client.query('select 1 from private.battle_request_runs where battle_id=$1 and claim_until>clock_timestamp()', [claim.run.battle_id])).rowCount) changed();
      if (value.frame < integer(run.frame) || value.frame > integer(run.frame) + claim.frames) throw new Error('Invalid computed battle interval.');
      const expectedClock=spendRequestClock(claim.clock,value.frame-integer(run.frame));
      if(value.clock.atUs!==expectedClock.atUs||value.clock.credit!==expectedClock.credit)throw new Error('The computed battle changed durable clock credit.');
      decisionState(value.decision);
      for (const input of claim.added) await client.query(`insert into private.battle_request_inputs(battle_id,side,start_frame,end_frame,buttons) values($1,$2,$3,$4,$5)`,
        [run.battle_id, input.side, input.start, input.end, input.buttons]);
      await client.query('delete from private.battle_request_inputs where battle_id=$1 and end_frame<=$2', [run.battle_id, value.frame]);
      let sequence = integer(run.next_sequence), frame = integer(run.frame);
      for (const entry of value.entries) {
        if (entry.sequence !== sequence || entry.startFrame !== frame || entry.ticks < 1 || entry.ticks > 15) throw new Error('Invalid computed battle journal.');
        await client.query(`insert into private.battle_input_journal(battle_id,sequence,start_frame,end_frame,ticks,buttons_a,buttons_b,digest_a,digest_b,transport_digest,state)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [run.battle_id, sequence, frame, frame + entry.ticks, entry.ticks, ...entry.buttons, ...entry.digests, entry.transportDigest, entry.state]);
        sequence++; frame += entry.ticks;
      }
      if (frame !== value.frame || (frame !== integer(run.frame)) !== Boolean(value.points)) throw new Error('A battle interval requires its exact checkpoint.');
      await client.query(`update private.battle_runs set frame=$2,next_sequence=$3,next_input_${claim.side}=next_input_${claim.side}+1,
        buttons_a=$4,buttons_b=$5,decision_kind=$6,decision_mask=$7,decision_epoch=$8,decision_deadline=$9,
        engine_result=$10,updated_at=now() where battle_id=$1`, [run.battle_id, value.frame, sequence, ...value.buttons,
        value.decision.kind, value.decision.mask, value.decision.epoch, value.decision.deadline === null ? null : new Date(value.decision.deadline), value.engineResult ?? run.engine_result]);
      if (value.points) await client.query(`update private.battle_runs set checkpoint_a=$2,checkpoint_b=$3,checkpoint_frame=$4,checkpoint_sequence=$5,checkpoint_state=$6 where battle_id=$1`,
        [run.battle_id, ...value.points, value.frame, sequence, value.decision]);
      if (value.result && run.status === 'active') {
        const resolved = await this.repository.finishWithin(client, run.battle_id, value.result, claim.fence);
        if (resolved.winner!==value.result.winner||resolved.reason!==value.result.reason) throw new Error('The durable result differs from its response.');
      } else await client.query('update private.battle_runs set lease_expires_at=clock_timestamp() where battle_id=$1', [run.battle_id]);
      const acknowledged=await client.query(`update private.battle_request_runs set revision=revision+1,claim_id=null,claim_until=null,clock_us=$2,credit=$3,
        input_through_a=$4,input_through_b=$5,seen_us_${claim.side}=greatest(seen_us_${claim.side},$6),screen_a=$7,screen_b=$8,
        last_request_side='${claim.side}',waiting_us_${claim.side}=null
        where battle_id=$1 and claim_id=$9 and claim_until>clock_timestamp() returning battle_id`,
        [run.battle_id, value.clock.atUs.toString(), value.clock.credit.toString(), ...claim.inputThrough, claim.nowUs.toString(), ...value.caches,claim.claimId]);
      if(!acknowledged.rowCount)changed();
      await client.query(`insert into private.battle_request_receipts(battle_id,owner_id,sequence,operation_id,fingerprint,request,response) values($1,$2,$3,$4,$5,$6,$7)`,
        [run.battle_id, claim.owner, claim.request.sequence, claim.request.operationId, claim.fingerprint, claim.request, value.response]);
    });
  }
  async release(claim: RequestBattleClaim): Promise<void> {
    await this.transaction(async client => {
      await this.locked(client, claim.owner, claim.run.battle_id);
      const updated = await client.query('update private.battle_request_runs set claim_id=null,claim_until=null where battle_id=$1 and claim_id=$2 returning battle_id', [claim.run.battle_id, claim.claimId]);
      if (updated.rowCount) await client.query('update private.battle_runs set lease_expires_at=clock_timestamp() where battle_id=$1 and fence=$2', [claim.run.battle_id, claim.fence]);
    });
  }
}
