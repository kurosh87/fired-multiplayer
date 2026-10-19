export type TradePokemon = { nickname: string; speciesName: string | null; level: number | null;
  isEgg: boolean; hp: number | null; maxHp: number | null; heldItem: number | null };
export type PublicTradeOffer = { partySlot: number; pokemonDigest: string; saveRevision: number; pokemon: TradePokemon | null };
export type TradeView = { id: string; side: 'a'|'b'; status: 'offered'|'committing'|'committed'|'cancelled'|'expired';
  offerRevision: number; expiresAt: number; playerA: { id: string; handle: string }; playerB: { id: string; handle: string };
  offerA: PublicTradeOffer | null; offerB: PublicTradeOffer | null; confirmedA: boolean; confirmedB: boolean };
