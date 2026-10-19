import type { Database } from './database.ts';
import { DomainError, gameVersion } from '../../../packages/protocol/index.ts';
import type { CanonicalSave, ConfirmedTrade, TradeOffer, TradeReceipt, TradeRepository } from '../../../packages/trading/atomic-trade.ts';
import {notifyLobbyPresence} from './lobby-presence.ts';

export class PostgresTrades implements TradeRepository {
  private database: Database;
  constructor(database: Database) { this.database = database; }

  async receipt(tradeId: string): Promise<TradeReceipt | undefined> {
    const result = await this.database.pool.query('select * from private.trade_receipts where trade_id=$1', [tradeId]);
    const row = result.rows[0];
    return row ? { tradeId: row.trade_id, revisionA: Number(row.revision_a), revisionB: Number(row.revision_b), result: row.result } : undefined;
  }

  async reserve(tradeId: string, ownerId: string, offerRevision: number): Promise<ConfirmedTrade> {
    return this.database.transaction(async client => {
      const result = await client.query('select * from private.trades where id=$1 for update', [tradeId]);
      const row = result.rows[0];
      if (!row || (row.player_a !== ownerId && row.player_b !== ownerId)) throw new DomainError('TRADE_NOT_FOUND', 'The trade was not found.', 404);
      if (row.status !== 'offered' && row.status !== 'committed') throw new DomainError('TRADE_BUSY', 'This trade is no longer accepting confirmations.', 409);
      const saves = await client.query(`select id,owner_id,version,revision,flash from private.adventures
        where id in ($1,$2) order by id for update`, [row.adventure_a, row.adventure_b]);
      const find = (id: string): CanonicalSave => {
        const save = saves.rows.find(item => item.id === id);
        if (!save?.flash) throw new DomainError('SAVE_REQUIRED', 'Both players need verified in-game saves.', 409);
        return { id: save.id, ownerId: save.owner_id, version: gameVersion(save.version),
          revision: Number(save.revision), flash: new Uint8Array(save.flash) };
      };
      const saveA = find(row.adventure_a); const saveB = find(row.adventure_b);
      if (saveA.ownerId !== row.player_a || saveB.ownerId !== row.player_b) throw new DomainError('INVALID_TRADE', 'Trade save ownership is inconsistent.', 409);
      if (row.status !== 'committed') {
        if (!row.confirmed_a || !row.confirmed_b || Number(row.offer_revision) !== offerRevision) throw new DomainError('TRADE_CHANGED', 'Both players must confirm the current offer.', 409);
        if (!row.offer_a || !row.offer_b || row.offer_a.saveRevision !== saveA.revision || row.offer_b.saveRevision !== saveB.revision) throw new DomainError('SAVE_CHANGED', 'A party changed. Review both offers again.', 409);
        if (row.expires_at.getTime() <= Date.now()) throw new DomainError('TRADE_EXPIRED', 'The trade expired.', 409);
        const sessions = await client.query(`select id,owner_id,adventure_id,status from private.game_sessions
          where owner_id in ($1,$2) and status<>'closed' order by id for update`, [row.player_a, row.player_b]);
        if (sessions.rows.length !== 2 || sessions.rows.some(session => session.status !== 'lobby'
          || session.adventure_id !== (session.owner_id === row.player_a ? saveA.id : saveB.id)))
          throw new DomainError('TRAINER_NOT_READY', 'Both players must pause the offered adventures in the lobby.', 409);
        const trading=await client.query<{owner_id:string}>("update private.game_sessions set status='trade' where id=any($1::uuid[]) returning owner_id", [sessions.rows.map(session => session.id)]);
        for(const session of trading.rows)await notifyLobbyPresence(client,session.owner_id);
        const started = await client.query("update private.trades set status='committing',expires_at=now()+interval '10 minutes' where id=$1 returning expires_at", [tradeId]);
        row.expires_at = started.rows[0].expires_at;
      }
      return { id: row.id, offerRevision: Number(row.offer_revision), confirmedA: row.confirmed_a,
        confirmedB: row.confirmed_b, expiresAt: row.expires_at.getTime(), saveA, saveB,
        offerA: row.offer_a as TradeOffer, offerB: row.offer_b as TradeOffer };
    });
  }

  /** Recover this operation's existing reservation without creating another
   * swap. The ordinary reserve() path still rejects concurrent completions. */
  async reserved(tradeId: string, ownerId: string, offerRevision: number): Promise<ConfirmedTrade> {
    return this.database.transaction(async client => {
      const result = await client.query('select * from private.trades where id=$1 for update', [tradeId]);
      const row = result.rows[0];
      if (!row || ![row.player_a,row.player_b].includes(ownerId)) throw new DomainError('TRADE_NOT_FOUND', 'The trade was not found.', 404);
      if (row.status !== 'committing' || Number(row.offer_revision) !== offerRevision || !row.confirmed_a || !row.confirmed_b)
        throw new DomainError('TRADE_CHANGED', 'This trade reservation changed.', 409);
      if (row.expires_at.getTime() <= Date.now()) throw new DomainError('TRADE_EXPIRED', 'The trade expired.', 409);
      const saved = await client.query('select id,owner_id,version,revision,flash from private.adventures where id in ($1,$2) order by id for update', [row.adventure_a,row.adventure_b]);
      const find = (id: string, owner: string, offer: TradeOffer): CanonicalSave => {
        const value = saved.rows.find(save => save.id === id && save.owner_id === owner);
        if (!value?.flash || !offer || Number(value.revision) !== offer.saveRevision)
          throw new DomainError('SAVE_CHANGED', 'A reserved adventure changed.', 409);
        return { id, ownerId: owner, version: gameVersion(value.version), revision: Number(value.revision), flash: new Uint8Array(value.flash) };
      };
      const saveA = find(row.adventure_a,row.player_a,row.offer_a), saveB = find(row.adventure_b,row.player_b,row.offer_b);
      const sessions = await client.query(`select owner_id,adventure_id,status from private.game_sessions
        where owner_id in ($1,$2) and status<>'closed' order by id for update`, [row.player_a,row.player_b]);
      if (sessions.rows.length !== 2 || sessions.rows.some(s => s.status !== 'trade'
        || s.adventure_id !== (s.owner_id === row.player_a ? saveA.id : saveB.id)))
        throw new DomainError('TRADE_CHANGED', 'The reserved sessions changed.', 409);
      return { id: row.id, offerRevision, confirmedA: true, confirmedB: true, expiresAt: row.expires_at.getTime(),
        saveA,saveB,offerA:row.offer_a,offerB:row.offer_b };
    });
  }

  async commit(trade: ConfirmedTrade, updates: { flashA: Uint8Array; flashB: Uint8Array; result: Record<string, unknown> }): Promise<TradeReceipt> {
    return this.database.transaction(async client => {
      // Serialize retries with the original commit, including a lost response.
      await client.query('select id from private.trades where id=$1 for update', [trade.id]);
      const prior = await client.query('select * from private.trade_receipts where trade_id=$1', [trade.id]);
      if (prior.rows[0]) return { tradeId: trade.id, revisionA: Number(prior.rows[0].revision_a),
        revisionB: Number(prior.rows[0].revision_b), result: prior.rows[0].result };
      const reservation = await client.query(`select id from private.trades where id=$1 and status='committing'
        and offer_revision=$2 and confirmed_a and confirmed_b and expires_at>now() for update`, [trade.id, trade.offerRevision]);
      if (!reservation.rowCount) throw new DomainError('TRADE_CHANGED', 'The trade reservation expired or changed.', 409);
      const scenes = await client.query('select owner_id,adventure_id,status,result_flash from private.trade_scenes where trade_id=$1', [trade.id]);
      if (scenes.rowCount && (scenes.rows.length !== 2 || [[trade.saveA,updates.flashA],[trade.saveB,updates.flashB]].some(([save,flash]) => {
        const canonical = save as CanonicalSave;
        const scene = scenes.rows.find(row => row.owner_id === canonical.ownerId && row.adventure_id === canonical.id);
        return !scene || scene.status !== 'done' || !Buffer.from(flash as Uint8Array).equals(scene.result_flash);
      }))) throw new DomainError('TRADE_SCENES_INCOMPLETE', 'Both original trade scenes must finish before either save changes.', 409);
      const saves = await client.query('select id,revision from private.adventures where id in ($1,$2) order by id for update', [trade.saveA.id, trade.saveB.id]);
      if (saves.rows.length !== 2 || saves.rows.some(row => Number(row.revision) !== (row.id === trade.saveA.id ? trade.saveA.revision : trade.saveB.revision))) throw new DomainError('SAVE_CHANGED', 'One of the saves changed during the trade.', 409);
      for (const [save, flash] of [[trade.saveA, updates.flashA], [trade.saveB, updates.flashB]] as const) {
        await client.query('update private.adventures set flash=$2,revision=revision+1,updated_at=now() where id=$1', [save.id, Buffer.from(flash)]);
      }
      const receipt: TradeReceipt = { tradeId: trade.id, revisionA: trade.saveA.revision + 1, revisionB: trade.saveB.revision + 1, result: updates.result };
      await client.query('insert into private.trade_receipts(trade_id,revision_a,revision_b,result) values($1,$2,$3,$4)',
        [receipt.tradeId, receipt.revisionA, receipt.revisionB, receipt.result]);
      await client.query("update private.trades set status='committed' where id=$1", [trade.id]);
      // Old checkpoints must never restore the pre-trade Pokémon. Keep journals
      // for audit but supersede every previous runtime for these adventures.
      const superseded=await client.query<{owner_id:string}>(`update private.game_sessions set status='closed',superseded_at=now(),
        fence=fence+1,lease_expires_at=now() where adventure_id in ($1,$2) returning owner_id`, [trade.saveA.id, trade.saveB.id]);
      for(const session of superseded.rows)await notifyLobbyPresence(client,session.owner_id);
      return receipt;
    });
  }

  async release(tradeId: string): Promise<void> {
    await this.database.transaction(async client => {
      const released = await client.query(`update private.trades set status=case when expires_at<=now() then 'expired'
        when exists(select 1 from private.trade_scenes where trade_id=$1) then 'cancelled' else 'offered' end,
        confirmed_a=false,confirmed_b=false
        where id=$1 and status='committing' returning player_a,player_b`, [tradeId]);
      const row = released.rows[0];
      if (row) {
        const restored=await client.query<{owner_id:string}>("update private.game_sessions set status='lobby' where owner_id in ($1,$2) and status='trade' returning owner_id", [row.player_a, row.player_b]);
        for(const session of restored.rows)await notifyLobbyPresence(client,session.owner_id);
        await client.query("update private.trade_scenes set status='aborted',result_flash=null,fence=fence+1,lease_expires_at=now() where trade_id=$1", [tradeId]);
      }
    });
  }
}
