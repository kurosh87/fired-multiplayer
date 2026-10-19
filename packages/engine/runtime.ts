import { createHash } from 'node:crypto';
import { BUTTON_MASK, DomainError, type GameVersion, type InputRun } from '../protocol/index.ts';

export const ENGINE_ABI = 1;
export const FLASH_BYTES = 128 * 1024;

export type EngineManifest = {
  id: string;
  version: GameVersion;
  revision: 1;
  abi: 1;
  wasmSha256: string;
  upstreamCommit: string;
  status: 'experimental' | 'verified';
  capabilities: { adventure: boolean; battle: boolean; trade: boolean; audio: boolean };
};

export interface GameEngine {
  readonly manifest: EngineManifest;
  readonly frame: number;
  advance(runs: readonly InputRun[]): void;
  digest(): string;
  flash(): Uint8Array;
  snapshot(): Uint8Array;
  restore(snapshot: Uint8Array): void;
  close(): void;
}

type WasmExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  kanto_abi_version: () => number;
  kanto_boot: (seed: number, hasSave: number) => number;
  kanto_step: (buttons: number, frames: number) => number;
  kanto_frame: () => number;
  kanto_state_ptr: () => number;
  kanto_state_size: () => number;
  kanto_flash_ptr: () => number;
  kanto_flash_size: () => number;
  kanto_after_restore: () => number;
  kanto_render_frame: () => number;
  kanto_framebuffer_ptr: () => number;
  kanto_framebuffer_size: () => number;
};

const REQUIRED_EXPORTS = [
  'kanto_abi_version', 'kanto_boot', 'kanto_step', 'kanto_frame',
  'kanto_state_ptr', 'kanto_state_size', 'kanto_flash_ptr',
  'kanto_flash_size', 'kanto_after_restore',
  'kanto_render_frame', 'kanto_framebuffer_ptr', 'kanto_framebuffer_size',
] as const;

function boundedBytes(memory: WebAssembly.Memory, pointer: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 1
    || pointer + length > memory.buffer.byteLength) {
    throw new DomainError('ENGINE_ABI_ERROR', 'The game exported an invalid memory region.', 503);
  }
  return new Uint8Array(memory.buffer, pointer, length);
}

export class WasmEngine implements GameEngine {
  readonly manifest: EngineManifest;
  private exports: WasmExports;
  private closed = false;

  private constructor(manifest: EngineManifest, instance: WebAssembly.Instance) {
    this.manifest = manifest;
    this.exports = instance.exports as WasmExports;
  }

  static async create(bytes: Uint8Array, manifest: EngineManifest, seed: number, save?: Uint8Array): Promise<WasmEngine> {
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.wasmSha256) {
      throw new DomainError('ENGINE_HASH_MISMATCH', 'The game artifact failed its integrity check.', 503);
    }
    const module = await WebAssembly.compile(Uint8Array.from(bytes));
    // All simulation-affecting BIOS/platform behavior belongs in the shared C core.
    // A missing import is an error, never an implicit no-op.
    if (WebAssembly.Module.imports(module).length !== 0) {
      throw new DomainError('UNSUPPORTED_ENGINE_IMPORT', 'The game artifact contains unresolved platform imports.', 503);
    }
    const instance = await WebAssembly.instantiate(module, {});
    if (!(instance.exports.memory instanceof WebAssembly.Memory)
      || REQUIRED_EXPORTS.some(name => typeof instance.exports[name] !== 'function')) {
      throw new DomainError('ENGINE_ABI_ERROR', 'The game artifact does not implement the Kanto ABI.', 503);
    }
    const engine = new WasmEngine(manifest, instance);
    if (engine.exports.kanto_abi_version() !== ENGINE_ABI || manifest.abi !== ENGINE_ABI) {
      throw new DomainError('ENGINE_ABI_ERROR', 'Unsupported game ABI.', 503);
    }
    if (engine.exports.kanto_flash_size() !== FLASH_BYTES) throw new DomainError('ENGINE_ABI_ERROR', 'Invalid flash size.', 503);
    if (engine.exports.kanto_framebuffer_size() !== 240 * 160 * 4) throw new DomainError('ENGINE_ABI_ERROR', 'Invalid framebuffer size.', 503);
    boundedBytes(engine.exports.memory, engine.exports.kanto_framebuffer_ptr(), engine.exports.kanto_framebuffer_size());
    const flash = engine.flashView();
    flash.fill(0xff);
    if (save) {
      if (save.byteLength !== FLASH_BYTES) throw new DomainError('INVALID_SAVE', 'Invalid canonical save size.', 503);
      flash.set(save);
    }
    if (engine.exports.kanto_boot(seed >>> 0, save ? 1 : 0) !== 0) throw new DomainError('ENGINE_BOOT_FAILED', 'The game could not start.', 503);
    return engine;
  }

  private ensureOpen(): void {
    if (this.closed) throw new DomainError('ENGINE_CLOSED', 'The game session needs to reconnect.', 409);
  }

  get frame(): number { this.ensureOpen(); return this.exports.kanto_frame() >>> 0; }

  /** Bind a reviewed C extension in trusted server code. Export names and
   * arguments must never be selected by an incoming client request. */
  bindExtension<T extends object>(abiExport: string, version: number, functions: readonly string[]): T {
    this.ensureOpen();
    const abi = this.exports[abiExport];
    if (typeof abi !== 'function' || abi() !== version
      || functions.some(name => typeof this.exports[name] !== 'function'))
      throw new DomainError('ENGINE_ABI_ERROR', 'The game does not implement the required extension.', 503);
    return this.exports as unknown as T;
  }

  advance(runs: readonly InputRun[]): void {
    this.ensureOpen();
    for (const run of runs) {
      if (!Number.isInteger(run.buttons) || run.buttons < 0 || run.buttons > BUTTON_MASK
        || !Number.isInteger(run.frames) || run.frames < 1 || run.frames > 60) throw new DomainError('INVALID_INPUT', 'Invalid engine input.');
      if (this.exports.kanto_step(run.buttons, run.frames) !== 0) throw new DomainError('ENGINE_STEP_FAILED', 'The game could not advance.', 503);
    }
  }

  digest(): string {
    this.ensureOpen();
    const state = boundedBytes(this.exports.memory, this.exports.kanto_state_ptr(), this.exports.kanto_state_size());
    return createHash('sha256').update(this.manifest.id).update(state).digest('hex');
  }

  private flashView(): Uint8Array {
    return boundedBytes(this.exports.memory, this.exports.kanto_flash_ptr(), this.exports.kanto_flash_size());
  }

  flash(): Uint8Array { this.ensureOpen(); return this.flashView().slice(); }

  snapshot(): Uint8Array<ArrayBuffer> {
    this.ensureOpen();
    // Snapshot includes all linear memory; the ABI requires all mutable simulation
    // state to live there and calls must finish at frame boundaries.
    return new Uint8Array(this.exports.memory.buffer).slice();
  }

  restore(snapshot: Uint8Array): void {
    this.ensureOpen();
    if (snapshot.byteLength !== this.exports.memory.buffer.byteLength) throw new DomainError('INVALID_CHECKPOINT', 'Incompatible checkpoint.', 503);
    new Uint8Array(this.exports.memory.buffer).set(snapshot);
    if (this.exports.kanto_after_restore() !== 0) throw new DomainError('INVALID_CHECKPOINT', 'The game rejected its checkpoint.', 503);
  }

  close(): void { this.closed = true; }
}
