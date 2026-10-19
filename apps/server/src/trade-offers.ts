import type { PoolClient } from 'pg';
import type { Database } from './database.ts';
import type { EngineRegistry } from '../../../packages/engine/registry.ts';
import { DomainError, gameVersion } from '../../../packages/protocol/index.ts';
import type { CanonicalSave, TradeOffer } from '../../../packages/trading/atomic-trade.ts';
import type { PublicTradeOffer, TradeView, TradePokemon } from '../../../packages/trading/offers.ts';
import {WorkerGameInspection,type GameInspection} from '../../../packages/trading/worker-pool.ts';

type Offer = TradeOffer & { pokemon?: TradePokemon };
type Row = { id: string; player_a: string; player_b: string; adventure_a: string; adventure_b: string;
  handle_a: string; handle_b: string; status: TradeView['status']; offer_revision: string;
  offer_a: Offer | null; offer_b: Offer | null; confirmed_a: boolean; confirmed_b: boolean; expires_at: Date };
const select = `select t.*,a.handle as handle_a,b.handle as handle_b from private.trades t
  join public.profiles a on a.id=t.player_a join public.profiles b on b.id=t.player_b`;
function uuid(value: string) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))
    throw new DomainError('INVALID_TRADE', 'Choose a valid trainer or trade.');
  return value.toLowerCase();
}
function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError('INVALID_TRADE', 'Review the current trade offer.');
}
function view(row: Row, owner: string): TradeView {
  const offer = (value: Offer | null): PublicTradeOffer | null => value ? { partySlot: value.partySlot,
    pokemonDigest: value.pokemonDigest, saveRevision: value.saveRevision, pokemon: value.pokemon ?? null } : null;
  return { id: row.id, side: row.player_a === owner ? 'a' : 'b',
    status: row.status === 'offered' && row.expires_at.getTime() <= Date.now() ? 'expired' : row.status,
    offerRevision: Number(row.offer_revision), expiresAt: row.expires_at.getTime(),
    playerA: { id: row.player_a, handle: row.handle_a }, playerB: { id: row.player_b, handle: row.handle_b },
    offerA: offer(row.offer_a), offerB: offer(row.offer_b), confirmedA: row.confirmed_a, confirmedB: row.confirmed_b };
}

/** Invitations and confirmations never edit a cartridge. Every offer is bound
 * to the current server save, and original C rechecks both exact selections
 * before confirmation. Scene execution/atomic commit is a separate step. */
export class TradeOffers {
  private database: Database;
  private inspection:GameInspection;
  private ownsInspection:boolean;
  constructor(database:Database,registry:EngineRegistry,inspection?:GameInspection){
    this.database=database;this.inspection=inspection??new WorkerGameInspection(registry);this.ownsInspection=!inspection;
  }
  async close():Promise<void>{if(this.ownsInspection)await (this.inspection as WorkerGameInspection).close();}

  private async row(client: PoolClient, id: string, owner: string, lock = true): Promise<Row> {
    const result = await client.query<Row>(`${select} where t.id=$1 and (t.player_a=$2 or t.player_b=$2)${lock ? ' for update of t' : ''}`, [uuid(id), owner]);
    if (!result.rows[0]) throw new DomainError('TRADE_NOT_FOUND', 'The trade was not found.', 404);
    return result.rows[0];
  }
  private writable(row: Row, expected: number) {
    revision(expected);
    if (row.status !== 'offered') throw new DomainError('TRADE_BUSY', 'This trade is no longer accepting offers.', 409);
    if (row.expires_at.getTime() <= Date.now()) throw new DomainError('TRADE_EXPIRED', 'This invitation expired.', 409);
    if (Number(row.offer_revision) !== expected) throw new DomainError('TRADE_CHANGED', 'The offer changed. Review both Pokemon again.', 409);
  }
  private async saves(client: PoolClient, row: Pick<Row, 'player_a'|'player_b'|'adventure_a'|'adventure_b'>): Promise<[CanonicalSave, CanonicalSave]> {
    const profiles = await client.query('select id,suspended_at from public.profiles where id in ($1,$2)', [row.player_a, row.player_b]);
    if (profiles.rows.length !== 2 || profiles.rows.some(p => p.suspended_at)) throw new DomainError('TRAINER_NOT_READY', 'Both trainers must be available.', 409);
    const saved = await client.query('select id,owner_id,version,revision,flash from private.adventures where id in ($1,$2) order by id for update', [row.adventure_a, row.adventure_b]);
    const find = (id: string, owner: string): CanonicalSave => {
      const save = saved.rows.find(item => item.id === id && item.owner_id === owner);
      if (!save?.flash) throw new DomainError('SAVE_REQUIRED', 'Both trainers need saved adventures.', 409);
      return { id, ownerId: owner, version: gameVersion(save.version), revision: Number(save.revision), flash: new Uint8Array(save.flash) };
    };
    const a = find(row.adventure_a, row.player_a), b = find(row.adventure_b, row.player_b);
    const sessions = await client.query(`select owner_id,adventure_id,status,lease_expires_at from private.game_sessions
      where owner_id in ($1,$2) and status<>'closed' order by id for update`, [row.player_a, row.player_b]);
    if (sessions.rows.length !== 2 || sessions.rows.some(session => session.status !== 'lobby'
      || session.lease_expires_at.getTime() <= Date.now()
      || session.adventure_id !== (session.owner_id === row.player_a ? a.id : b.id)))
      throw new DomainError('TRAINER_NOT_READY', 'Both trainers must be present in the lobby with these adventures.', 409);
    return [a, b];
  }

  async list(owner: string): Promise<TradeView[]> {
    const result = await this.database.pool.query<Row>(`${select} where (t.player_a=$1 or t.player_b=$1)
      and t.status in ('offered','committing') and t.expires_at>now() order by t.created_at desc limit 32`, [owner]);
    return result.rows.map(row => view(row, owner));
  }
  async get(owner: string, id: string): Promise<TradeView> {
    return this.database.transaction(async client => view(await this.row(client, id, owner, false), owner));
  }
  async invite(owner: string, peer: string): Promise<TradeView> {
    peer = uuid(peer);
    if (peer === owner) throw new DomainError('INVALID_TRADE', 'Choose another trainer.');
    return this.database.transaction(async client => {
      // Serialize pair creation and per-trainer invitation limits. Existing
      // invitation reads do not lock trades after taking profile locks.
      const profiles = await client.query('select id from public.profiles where id in ($1,$2) order by id for update', [owner, peer]);
      if (profiles.rows.length !== 2) throw new DomainError('TRAINER_NOT_FOUND', 'That trainer was not found.', 404);
      const existing = await client.query<Row>(`${select} where ((t.player_a=$1 and t.player_b=$2) or (t.player_a=$2 and t.player_b=$1))
        and t.status in ('offered','committing') and t.expires_at>now() order by t.created_at desc limit 1`, [owner, peer]);
      if (existing.rows[0]) return view(existing.rows[0], owner);
      const pending = await client.query(`select player_a,player_b from private.trades where status='offered'
        and expires_at>now() and (player_a in ($1,$2) or player_b in ($1,$2))`, [owner, peer]);
      if ([owner, peer].some(id => pending.rows.filter(r => r.player_a === id || r.player_b === id).length >= 16))
        throw new DomainError('TOO_MANY_INVITATIONS', 'Finish or decline an existing invitation first.', 429);
      const active = await client.query('select owner_id,adventure_id from private.game_sessions where owner_id in ($1,$2) and status=\'lobby\'', [owner, peer]);
      const a = active.rows.find(r => r.owner_id === owner), b = active.rows.find(r => r.owner_id === peer);
      if (!a || !b) throw new DomainError('TRAINER_NOT_READY', 'Both trainers must be in the lobby.', 409);
      await this.saves(client, { player_a: owner, player_b: peer, adventure_a: a.adventure_id, adventure_b: b.adventure_id });
      const inserted = await client.query('insert into private.trades(player_a,player_b,adventure_a,adventure_b) values($1,$2,$3,$4) returning id', [owner, peer, a.adventure_id, b.adventure_id]);
      return view(await this.row(client, inserted.rows[0].id, owner), owner);
    });
  }

  async offer(owner: string, id: string, expected: number, selected: TradeOffer): Promise<TradeView> {
    if (!selected || !Number.isInteger(selected.partySlot) || selected.partySlot < 0 || selected.partySlot > 5
      || typeof selected.pokemonDigest !== 'string' || !/^[a-f0-9]{64}$/.test(selected.pokemonDigest))
      throw new DomainError('INVALID_TRADE', 'Choose a Pokemon from your current party.');
    revision(selected.saveRevision);
    return this.database.transaction(async client => {
      const row = await this.row(client, id, owner); this.writable(row, expected);
      const saves = await this.saves(client, row), side = row.player_a === owner ? 0 : 1, save = saves[side];
      if (save.revision !== selected.saveRevision) throw new DomainError('SAVE_CHANGED', 'Your party changed. Reopen the lobby.', 409);
      const party = await this.inspection.lobbyParty(save.version, 0, save.flash);
      const mon = party.find(p => p.slot === selected.partySlot && p.digest === selected.pokemonDigest);
      if (!mon) throw new DomainError('POKEMON_CHANGED', 'That Pokemon is no longer in the selected party slot.', 409);
      const pokemon: TradePokemon = mon.isEgg ? { nickname: 'Egg', speciesName: null, level: null, isEgg: true, hp: null, maxHp: null, heldItem: null }
        : { nickname: mon.nickname, speciesName: mon.speciesName, level: mon.level, isEgg: false, hp: mon.hp, maxHp: mon.maxHp, heldItem: mon.heldItem };
      const offer = { partySlot: mon.slot, pokemonDigest: mon.digest, saveRevision: save.revision, pokemon };
      // The column choice is a server-owned constant, never request text.
      const column = side === 0 ? 'offer_a' : 'offer_b';
      await client.query(`update private.trades set ${column}=$2,offer_revision=offer_revision+1,
        confirmed_a=false,confirmed_b=false where id=$1`, [row.id, offer]);
      return view(await this.row(client, id, owner), owner);
    });
  }

  async confirm(owner: string, id: string, expected: number): Promise<TradeView> {
    return this.database.transaction(async client => {
      const row = await this.row(client, id, owner); this.writable(row, expected);
      const [a, b] = await this.saves(client, row);
      if (!row.offer_a || !row.offer_b) throw new DomainError('OFFERS_REQUIRED', 'Both trainers must choose a Pokemon first.', 409);
      if (row.offer_a.saveRevision !== a.revision || row.offer_b.saveRevision !== b.revision)
        throw new DomainError('SAVE_CHANGED', 'A party changed. Both trainers must review new offers.', 409);
      // Re-read both selected identities, then call the original game rules.
      for (const [save, offer] of [[a, row.offer_a], [b, row.offer_b]] as const) {
        const party = await this.inspection.lobbyParty(save.version, 0, save.flash);
        if (!party.some(mon => mon.slot === offer.partySlot && mon.digest === offer.pokemonDigest))
          throw new DomainError('POKEMON_CHANGED', 'An offered Pokemon changed. Review both offers again.', 409);
      }
      const checks = await this.inspection.tradeChecks(a, b, row.offer_a.partySlot, row.offer_b.partySlot);
      if (checks.a !== 0 || checks.b !== 0) {
        const own = owner === row.player_a ? checks.a : checks.b;
        throw new DomainError('TRADE_NOT_ALLOWED', own === 1 ? 'Keep another usable Pokemon in your party.'
          : own !== 0 ? 'The original game does not allow your selected Pokemon to be traded.'
            : 'Your partner needs to choose a Pokemon the original game allows them to trade.', 409);
      }
      await client.query(`update private.trades set ${row.player_a === owner ? 'confirmed_a' : 'confirmed_b'}=true where id=$1`, [id]);
      return view(await this.row(client, id, owner), owner);
    });
  }
  async cancel(owner: string, id: string, expected: number): Promise<TradeView> {
    return this.database.transaction(async client => {
      const row = await this.row(client, id, owner); revision(expected);
      if (row.status === 'cancelled' || row.status === 'expired') return view(row, owner);
      if (row.status !== 'offered') throw new DomainError('TRADE_BUSY', 'This trade has already started.', 409);
      // Declining an unstarted trade is always safe, even if its offer just
      // changed. A partner cannot prevent cancellation by cycling selections.
      await client.query("update private.trades set status='cancelled',confirmed_a=false,confirmed_b=false where id=$1", [row.id]);
      return view(await this.row(client, id, owner), owner);
    });
  }
}
