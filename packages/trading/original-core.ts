import { WasmEngine, type EngineManifest } from '../engine/runtime.ts';
import { DomainError } from '../protocol/index.ts';
import { decodeGameName } from '../engine/game-text.ts';

type ExchangeExports = {
  memory: WebAssembly.Memory;
  kanto_exchange_open(): number;
  kanto_exchange_phase(): number;
  kanto_exchange_packet_ptr(): number; kanto_exchange_packet_size(): number;
  kanto_exchange_receive_ptr(): number;
  kanto_exchange_mon_ptr(slot: number): number; kanto_exchange_mon_size(): number;
  kanto_exchange_mon_text_ptr(slot: number, kind: number): number; kanto_exchange_mon_text_size(): number;
  kanto_exchange_party_count(): number; kanto_exchange_mon_field(slot: number, key: number): number;
  kanto_exchange_check(slot: number, peerSlot: number): number;
  kanto_exchange_start(slot: number, peerSlot: number): number;
};
const FUNCTIONS = ['kanto_exchange_open', 'kanto_exchange_phase', 'kanto_exchange_packet_ptr',
  'kanto_exchange_packet_size', 'kanto_exchange_receive_ptr', 'kanto_exchange_mon_ptr',
  'kanto_exchange_mon_size', 'kanto_exchange_mon_text_ptr', 'kanto_exchange_mon_text_size', 'kanto_exchange_party_count', 'kanto_exchange_mon_field',
  'kanto_exchange_check', 'kanto_exchange_start'] as const;
export type PartyMon = { slot: number; personality: number; trainerId: number; species: number;
  nickname: string; speciesName: string;
  level: number; hp: number; maxHp: number; heldItem: number; friendship: number;
  isEgg: boolean; checksum: number; badEgg: boolean; moves: number[]; pp: number[] };

/** Low-level binding for the original C trade scene. It consumes only canonical
 * server saves. It does not mark artifacts qualified or enable public routes.
 * Original rules, mail/ribbons, Pokedex, evolution and move learning run in C. */
export class OriginalTradeCore {
  readonly engine: WasmEngine;
  private core: ExchangeExports;

  private constructor(engine: WasmEngine, core: ExchangeExports) { this.engine = engine; this.core = core; }
  static async create(bytes: Uint8Array, manifest: EngineManifest, seed: number, flash: Uint8Array): Promise<OriginalTradeCore> {
    const engine = await WasmEngine.create(bytes, manifest, seed, flash);
    try {
      const core = engine.bindExtension<ExchangeExports>('kanto_exchange_abi_version', 1, FUNCTIONS);
      if (core.kanto_exchange_open() !== 0) throw new DomainError('INVALID_TRADE_SAVE', 'The original game rejected this cartridge or party.', 409);
      return new OriginalTradeCore(engine, core);
    } catch (error) { engine.close(); throw error; }
  }
  static async restore(bytes: Uint8Array, manifest: EngineManifest, seed: number, checkpoint: Uint8Array): Promise<OriginalTradeCore> {
    const engine = await WasmEngine.create(bytes, manifest, seed);
    try {
      engine.restore(checkpoint);
      const core = engine.bindExtension<ExchangeExports>('kanto_exchange_abi_version', 1, FUNCTIONS);
      if (![2, 3].includes(core.kanto_exchange_phase()))
        throw new DomainError('TRADE_CHECKPOINT_INVALID', 'The saved trade scene cannot be resumed.', 503);
      return new OriginalTradeCore(engine, core);
    } catch (error) { engine.close(); throw error; }
  }
  private bytes(pointer: number, size: number): Uint8Array {
    void this.engine.frame; // Reject access after closing the instance.
    if (!Number.isInteger(pointer) || pointer <= 0 || !Number.isInteger(size) || size < 1
      || size > 65536 || pointer + size > this.core.memory.buffer.byteLength)
      throw new DomainError('ENGINE_ABI_ERROR', 'The game exported an invalid exchange region.', 503);
    return new Uint8Array(this.core.memory.buffer, pointer, size);
  }
  private slot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot > 5)
      throw new DomainError('INVALID_TRADE_SLOT', 'Choose a Pokemon in your party.');
  }
  get phase(): number { void this.engine.frame; return this.core.kanto_exchange_phase(); }
  packet(): Uint8Array {
    if (this.phase !== 1) throw new DomainError('TRADE_PHASE_CHANGED', 'The trade scene has already started.', 409);
    return this.bytes(this.core.kanto_exchange_packet_ptr(), this.core.kanto_exchange_packet_size()).slice();
  }
  receive(packet: Uint8Array): void {
    if (this.phase !== 1 || packet.byteLength !== this.core.kanto_exchange_packet_size())
      throw new DomainError('INVALID_TRADE_PARTNER', 'Incompatible trade partner data.', 409);
    this.packet(); // Construct this side's original link metadata before checking its peer.
    this.bytes(this.core.kanto_exchange_receive_ptr(), packet.byteLength).set(packet);
  }
  monBytes(slot: number): Uint8Array {
    this.slot(slot);
    return this.bytes(this.core.kanto_exchange_mon_ptr(slot), this.core.kanto_exchange_mon_size()).slice();
  }
  party(): PartyMon[] {
    void this.engine.frame;
    const count = this.core.kanto_exchange_party_count();
    if (!Number.isInteger(count) || count < 1 || count > 6) throw new DomainError('ENGINE_ABI_ERROR', 'Invalid game party.', 503);
    return Array.from({ length: count }, (_, slot) => {
      const field = (key: number) => this.core.kanto_exchange_mon_field(slot, key) >>> 0;
      const text = (kind: number) => decodeGameName(this.bytes(this.core.kanto_exchange_mon_text_ptr(slot, kind), this.core.kanto_exchange_mon_text_size()));
      return { slot, personality: field(0), trainerId: field(1), species: field(2), level: field(3),
        nickname: text(0), speciesName: text(1),
        hp: field(4), maxHp: field(5), heldItem: field(6), friendship: field(7),
        isEgg: Boolean(field(8)), checksum: field(9), badEgg: Boolean(field(10)),
        moves: [11,12,13,14].map(field), pp: [15,16,17,18].map(field) };
    });
  }
  eligibility(slot: number, peerSlot: number): number {
    this.slot(slot); this.slot(peerSlot); void this.engine.frame;
    return this.core.kanto_exchange_check(slot, peerSlot);
  }
  start(slot: number, peerSlot: number): void {
    this.slot(slot); this.slot(peerSlot); void this.engine.frame;
    const result = this.core.kanto_exchange_start(slot, peerSlot);
    if (result !== 0) throw new DomainError('TRADE_NOT_ALLOWED', `The original game rejected this offer (code ${result}).`, 409);
  }
  close(): void { this.engine.close(); }
}
