import type { Database } from './database.ts';
import { DomainError, gameVersion, type GameVersion } from '../../../packages/protocol/index.ts';
import type { JournalEntry } from '../../../packages/verification/verifier.ts';
import type { ConfirmedTrade } from '../../../packages/trading/atomic-trade.ts';

export type SceneRow = { id: string; trade_id: string; owner_id: string; adventure_id: string; side: 'a'|'b';
  artifact_id: string; version: GameVersion; seed: string; initial_checkpoint: Buffer; checkpoint: Buffer | null;
  checkpoint_sequence: string | null; checkpoint_frame: string | null; next_sequence: string; frame: string;
  status: 'running'|'done'|'aborted'; result_flash: Buffer | null; fence: string; lease_expires_at: Date };
export type NewScene = { id: string; ownerId: string; adventureId: string; side: 'a'|'b'; artifactId: string;
  seed: number; checkpoint: Buffer };

/** Private staged scene storage. The adventure tables are never updated by
 * scene input, checkpoints or completion; only the two-save commit may do so. */
export class TradeSceneStore {
  private database: Database;
  constructor(database: Database) { this.database = database; }

  async initialize(trade: ConfirmedTrade, scenes: [NewScene, NewScene]): Promise<void> {
    await this.database.transaction(async client => {
      const locked = await client.query(`select id from private.trades where id=$1 and status='committing'
        and offer_revision=$2 and confirmed_a and confirmed_b and expires_at>clock_timestamp() for update`, [trade.id,trade.offerRevision]);
      if (!locked.rowCount) throw new DomainError('TRADE_CHANGED', 'The trade reservation changed before its scenes were saved.', 409);
      const existing = await client.query('select id from private.trade_scenes where trade_id=$1', [trade.id]);
      if (existing.rows.length === 2) return; // Another initializer won; never reset its inputs.
      if (existing.rowCount) throw new DomainError('TRADE_SCENES_CORRUPT', 'The staged trade is incomplete.', 503);
      const saved = await client.query('select id,owner_id,revision from private.adventures where id in ($1,$2) order by id for update', [trade.saveA.id,trade.saveB.id]);
      for (const save of [trade.saveA,trade.saveB]) {
        if (!saved.rows.some(row => row.id === save.id && row.owner_id === save.ownerId && Number(row.revision) === save.revision))
          throw new DomainError('SAVE_CHANGED', 'A reserved adventure changed.', 409);
      }
      if (scenes[0].side === scenes[1].side || scenes.some(scene => !Number.isInteger(scene.seed) || scene.seed < 0 || scene.seed > 0xffffffff))
        throw new DomainError('INVALID_TRADE_SCENE', 'Invalid staged trade sides or entropy.', 503);
      for (const scene of scenes) {
        const expected = scene.side === 'a' ? trade.saveA : trade.saveB;
        if (scene.adventureId !== expected.id || scene.ownerId !== expected.ownerId)
          throw new DomainError('INVALID_TRADE_SCENE', 'Scene ownership does not match this trade.', 503);
        await client.query(`insert into private.trade_scenes
          (id,trade_id,owner_id,adventure_id,side,artifact_id,seed,initial_checkpoint)
          values($1,$2,$3,$4,$5,$6,$7,$8)`, [scene.id,trade.id,scene.ownerId,scene.adventureId,scene.side,scene.artifactId,scene.seed,scene.checkpoint]);
      }
    });
  }

  async row(owner: string, tradeId: string): Promise<SceneRow> {
    const result = await this.database.pool.query<SceneRow>(`select s.*,a.version from private.trade_scenes s
      join private.adventures a on a.id=s.adventure_id and a.owner_id=s.owner_id
      join private.trades t on t.id=s.trade_id where s.owner_id=$1 and s.trade_id=$2
      and (t.player_a=$1 or t.player_b=$1)`, [owner,tradeId]);
    const row = result.rows[0];
    if (!row) throw new DomainError('TRADE_SCENE_NOT_FOUND', 'The trade scene was not found.', 404);
    row.version = gameVersion(row.version); return row;
  }

  async claim(owner: string, tradeId: string, localFence?: number): Promise<SceneRow> {
    await this.database.transaction(async client => {
      const trade = await client.query(`select id from private.trades where id=$1 and (player_a=$2 or player_b=$2)
        and status='committing' and expires_at>clock_timestamp() for update`, [tradeId,owner]);
      if (!trade.rowCount) throw new DomainError('TRADE_CHANGED', 'This trade is no longer running.', 409);
      const result = await client.query<SceneRow>('select * from private.trade_scenes where trade_id=$1 and owner_id=$2 for update', [tradeId,owner]);
      const row = result.rows[0];
      if (!row || row.status === 'aborted') throw new DomainError('TRADE_SCENE_NOT_FOUND', 'The trade scene was not found.', 404);
      if (row.status === 'done') return;
      if (row.lease_expires_at.getTime() > Date.now() && Number(row.fence) !== localFence)
        throw new DomainError('TRADE_SCENE_ACTIVE_ELSEWHERE', 'This trade is active on another connection. Retry after one minute.', 409);
      await client.query("update private.trade_scenes set fence=fence+1,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now() where id=$1", [row.id]);
    });
    return this.row(owner,tradeId);
  }

  async find(sceneId: string, sequence: number): Promise<JournalEntry | undefined> {
    const result = await this.database.pool.query('select batch,fingerprint,acknowledgement from private.trade_input_journal where scene_id=$1 and sequence=$2', [sceneId,sequence]);
    return result.rows[0];
  }
  async entries(sceneId: string, sequence: number): Promise<JournalEntry[]> {
    const result = await this.database.pool.query('select batch,fingerprint,acknowledgement from private.trade_input_journal where scene_id=$1 and sequence>=$2 order by sequence', [sceneId,sequence]);
    return result.rows;
  }

  async append(sceneId: string, fence: number, entry: JournalEntry, resultFlash?: Uint8Array): Promise<void> {
    await this.database.transaction(async client => {
      const updated = await client.query(`update private.trade_scenes s set next_sequence=next_sequence+1,
        frame=$4,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now(),
        status=case when $6::bytea is null then 'running' else 'done' end,result_flash=$6
        where s.id=$1 and s.fence=$2 and s.next_sequence=$3 and s.frame=$5 and s.status='running'
        and s.lease_expires_at>clock_timestamp() and exists(select 1 from private.trades t
          where t.id=s.trade_id and t.status='committing' and t.expires_at>clock_timestamp()) returning s.id`,
      [sceneId,fence,entry.batch.sequence,entry.acknowledgement.frame,entry.batch.startFrame,resultFlash ? Buffer.from(resultFlash) : null]);
      if (!updated.rowCount) throw new DomainError('TRADE_SCENE_LEASE_LOST', 'Reconnect to restore the staged trade.', 409);
      await client.query(`insert into private.trade_input_journal(scene_id,sequence,operation_id,fingerprint,batch,acknowledgement)
        values($1,$2,$3,$4,$5,$6)`, [sceneId,entry.batch.sequence,entry.batch.operationId,entry.fingerprint,entry.batch,entry.acknowledgement]);
    });
  }

  async checkpoint(sceneId: string, fence: number, point: { bytes: Buffer; frame: number; sequence: number }): Promise<void> {
    const updated = await this.database.pool.query(`update private.trade_scenes s set checkpoint=$3,
      checkpoint_frame=$4,checkpoint_sequence=$5,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now()
      where s.id=$1 and s.fence=$2 and s.frame=$4 and s.next_sequence=$5 and s.status in ('running','done')
      and s.lease_expires_at>clock_timestamp()
      and exists(select 1 from private.trades t where t.id=s.trade_id and t.status='committing' and t.expires_at>clock_timestamp())`,
    [sceneId,fence,point.bytes,point.frame,point.sequence]);
    if (!updated.rowCount) throw new DomainError('TRADE_SCENE_LEASE_LOST', 'The trade scene resumed elsewhere.', 409);
  }

  async expireLease(sceneId: string, fence: number): Promise<void> {
    await this.database.pool.query('update private.trade_scenes set lease_expires_at=clock_timestamp() where id=$1 and fence=$2', [sceneId,fence]);
  }
  async completed(tradeId: string): Promise<{ ownerId: string; adventureId: string; side: 'a'|'b'; flash: Uint8Array }[]> {
    const result = await this.database.pool.query("select owner_id,adventure_id,side,result_flash from private.trade_scenes where trade_id=$1 and status='done' order by side", [tradeId]);
    return result.rows.map(row => ({ ownerId: row.owner_id, adventureId: row.adventure_id, side: row.side, flash: new Uint8Array(row.result_flash) }));
  }
  async expired(): Promise<string[]> {
    const result=await this.database.pool.query("select id from private.trades where status='committing' and expires_at<=clock_timestamp() order by expires_at limit 100");
    return result.rows.map(row=>row.id);
  }
}
