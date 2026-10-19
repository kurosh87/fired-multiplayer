import { createHash } from 'node:crypto';
import { DomainError, type GameVersion } from '../protocol/index.ts';
import { FLASH_BYTES } from '../engine/runtime.ts';

export type CanonicalSave = { id: string; ownerId: string; version: GameVersion; revision: number; flash: Uint8Array };
export type TradeOffer = { partySlot: number; pokemonDigest: string; saveRevision: number };
export type ConfirmedTrade = {
  id: string; offerRevision: number; confirmedA: boolean; confirmedB: boolean;
  expiresAt: number; saveA: CanonicalSave; saveB: CanonicalSave;
  offerA: TradeOffer; offerB: TradeOffer;
};
export type TradeReceipt = { tradeId: string; revisionA: number; revisionB: number; result: Record<string, unknown> };
export interface TrustedTradeAdapter {
  // The implementation must use game code to check party eligibility, Pokémon
  // identity, checksums/encryption, Pokédex updates and trade evolution.
  swap(trade: ConfirmedTrade): Promise<{ flashA: Uint8Array; flashB: Uint8Array; result: Record<string, unknown> }>;
}
export interface TradeRepository {
  receipt(tradeId: string): Promise<TradeReceipt | undefined>;
  reserve(tradeId: string, ownerId: string, offerRevision: number): Promise<ConfirmedTrade>;
  commit(trade: ConfirmedTrade, updates: { flashA: Uint8Array; flashB: Uint8Array; result: Record<string, unknown> }): Promise<TradeReceipt>;
  release(tradeId: string): Promise<void>;
}

export function pokemonDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export class AtomicTrading {
  private repository: TradeRepository;
  private adapter: TrustedTradeAdapter;
  private clock: () => number;

  constructor(repository: TradeRepository, adapter: TrustedTradeAdapter, clock: () => number = Date.now) {
    this.repository = repository; this.adapter = adapter; this.clock = clock;
  }

  async complete(tradeId: string, ownerId: string, offerRevision: number): Promise<TradeReceipt> {
    // reserve() must authorize the caller even when a receipt already exists.
    const trade = await this.repository.reserve(tradeId, ownerId, offerRevision);
    try {
      const receipt = await this.repository.receipt(tradeId);
      if (receipt) return receipt;
      if (trade.saveA.ownerId !== ownerId && trade.saveB.ownerId !== ownerId) throw new DomainError('FORBIDDEN', 'This trade belongs to other trainers.', 403);
      if (!trade.confirmedA || !trade.confirmedB || trade.offerRevision !== offerRevision) throw new DomainError('TRADE_CHANGED', 'Both players must confirm the current offer.', 409);
      if (trade.expiresAt <= this.clock()) throw new DomainError('TRADE_EXPIRED', 'This trade offer expired.', 409);
      if (trade.saveA.ownerId === trade.saveB.ownerId || trade.saveA.id === trade.saveB.id) throw new DomainError('INVALID_TRADE', 'Choose another trainer to trade with.');
      const updates = await this.adapter.swap(trade);
      if (updates.flashA.byteLength !== FLASH_BYTES || updates.flashB.byteLength !== FLASH_BYTES) throw new DomainError('ENGINE_ABI_ERROR', 'The trade engine returned invalid saves.', 503);
      return await this.repository.commit(trade, updates);
    } catch (error) { await this.repository.release(tradeId); throw error; }
  }
}
