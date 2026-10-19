import { WasmEngine, type EngineManifest } from '../engine/runtime.ts';
import { DomainError } from '../protocol/index.ts';
import { OriginalTradeCore, type PartyMon } from './original-core.ts';
import { pokemonDigest } from './atomic-trade.ts';

export type LobbyPokemon = PartyMon & { digest: string };
export type PreparedLobby = { snapshot: Uint8Array; flash: Uint8Array; party: LobbyPokemon[]; frame: number; digest: string };

export async function inspectLobbyParty(bytes: Uint8Array, manifest: EngineManifest, seed: number, flash: Uint8Array): Promise<LobbyPokemon[]> {
  const inspector = await OriginalTradeCore.create(bytes, manifest, seed, flash);
  try { return inspector.party().map(mon => ({ ...mon, digest: pokemonDigest(inspector.monBytes(mon.slot)) })); }
  finally { inspector.close(); }
}

/** Server-only transformation of a verified checkpoint, never an uploaded
 * client save. The returned runtime/cartridge must be committed together. */
export async function prepareLobbySave(bytes: Uint8Array, manifest: EngineManifest, seed: number,
  verifiedSnapshot: Uint8Array): Promise<PreparedLobby> {
  const clone = await WasmEngine.create(bytes, manifest, seed);
  try {
    clone.restore(verifiedSnapshot);
    const c = clone.bindExtension<{ kanto_lobby_save(): number }>('kanto_lobby_save_abi_version', 1, ['kanto_lobby_save']);
    const result = c.kanto_lobby_save();
    if (result === -1) throw new DomainError('LOBBY_UNSAFE_LOCATION', 'Stand still in the field and close menus before entering the lobby.', 409);
    if (result === -2) throw new DomainError('PARTY_REQUIRED', 'Get your first Pokemon before entering the lobby.', 409);
    if (result === -4) throw new DomainError('LOBBY_SAVE_CONFIRMATION_REQUIRED', 'Save in the game menu to confirm replacing your previous adventure before entering the lobby.', 409);
    if (result !== 0) throw new DomainError('LOBBY_SAVE_FAILED', 'The original game could not save your adventure.', 503);
    const flash = clone.flash();
    // A fresh original loader validates encrypted party data and the cartridge
    // just emitted by the save routine. UI metadata carries opaque identities.
    const party = await inspectLobbyParty(bytes, manifest, seed, flash);
    const digest = clone.digest();
    return { snapshot: clone.snapshot(), flash, party, frame: clone.frame, digest };
  } finally { clone.close(); }
}
