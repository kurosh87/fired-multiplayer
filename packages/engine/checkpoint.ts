/* Browser/server codec for trusted checkpoints. Every memory byte survives;
 * this changes transport/storage only, never canonical state or save format.
 * The baseline is a seed-0, erased-flash boot followed by state serialization,
 * from the exact same integrity-checked artifact. It is shared per artifact.
 * This format does not authenticate client-supplied snapshots. */
const MAGIC = new Uint8Array([75, 67, 80, 65, 71, 69, 48, 49]); // KCPAGE01
const PAGE_BYTES = 4096;
const HEADER_BYTES = 52;
const ENTRY_BYTES = 4 + PAGE_BYTES;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

type CheckpointCore = {
  memory: WebAssembly.Memory;
  kanto_abi_version(): number;
  kanto_flash_ptr(): number; kanto_flash_size(): number;
  kanto_boot(seed: number, hasSave: number): number;
  kanto_state_ptr(): number; kanto_state_size(): number;
};

/* Call only on a fresh instance, before any other WASM calls. Using the same
 * call sequence on both hosts also makes unused ABI-stack bytes identical.
 * The returned view belongs to that instance; callers must leave a cached
 * baseline untouched. Browser restoration can replace its instance's memory
 * after decodeCheckpoint has produced the complete reconstructed copy. */
export function initializeCheckpointBaseline(core: CheckpointCore): Uint8Array {
  if (!(core.memory instanceof WebAssembly.Memory) || core.kanto_abi_version() !== 1)
    throw new Error('Incompatible checkpoint core.');
  checkMemory(new Uint8Array(core.memory.buffer));
  const pointer = core.kanto_flash_ptr(), size = core.kanto_flash_size();
  if (!Number.isInteger(pointer) || pointer < 0 || size !== 128 * 1024 || pointer + size > core.memory.buffer.byteLength)
    throw new Error('Invalid checkpoint flash region.');
  new Uint8Array(core.memory.buffer, pointer, size).fill(0xff);
  if (core.kanto_boot(0, 0) !== 0) throw new Error('Checkpoint baseline boot failed.');
  const statePointer = core.kanto_state_ptr(), stateSize = core.kanto_state_size();
  if (!Number.isInteger(statePointer) || !Number.isInteger(stateSize) || statePointer < 0 || stateSize < 1
    || statePointer + stateSize > core.memory.buffer.byteLength) throw new Error('Invalid checkpoint state region.');
  return new Uint8Array(core.memory.buffer);
}

export async function createCheckpointBaseline(module: WebAssembly.Module): Promise<Uint8Array> {
  if (WebAssembly.Module.imports(module).length) throw new Error('Unsupported checkpoint core imports.');
  const core = (await WebAssembly.instantiate(module, {})).exports as unknown as CheckpointCore;
  return initializeCheckpointBaseline(core);
}

function checkMemory(bytes: Uint8Array): void {
  if (bytes.byteLength < PAGE_BYTES || bytes.byteLength > MAX_MEMORY_BYTES || bytes.byteLength % PAGE_BYTES)
    throw new Error('Invalid checkpoint memory size.');
}
function hashBytes(hash: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid checkpoint artifact hash.');
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16));
}
function words(bytes: Uint8Array): Uint32Array {
  const aligned = bytes.byteOffset % 4 ? Uint8Array.from(bytes) : bytes;
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}
export function maxCheckpointBytes(memoryBytes: number): number {
  if (!Number.isInteger(memoryBytes) || memoryBytes < PAGE_BYTES || memoryBytes > MAX_MEMORY_BYTES || memoryBytes % PAGE_BYTES)
    throw new Error('Invalid checkpoint memory size.');
  return HEADER_BYTES + memoryBytes / PAGE_BYTES * ENTRY_BYTES;
}

export function encodeCheckpoint(memory: Uint8Array, baseline: Uint8Array, wasmSha256: string): Uint8Array {
  checkMemory(memory); checkMemory(baseline);
  if (memory.byteLength !== baseline.byteLength) throw new Error('Incompatible checkpoint baseline.');
  const hash = hashBytes(wasmSha256);
  const currentWords = words(memory), baseWords = words(baseline);
  const wordsPerPage = PAGE_BYTES / 4;
  const changed: number[] = [];
  for (let page = 0; page < memory.byteLength / PAGE_BYTES; page++) {
    const start = page * wordsPerPage;
    for (let i = start; i < start + wordsPerPage; i++) {
      if (currentWords[i] !== baseWords[i]) { changed.push(page); break; }
    }
  }
  const result = new Uint8Array(HEADER_BYTES + changed.length * ENTRY_BYTES);
  result.set(MAGIC); result.set(hash, 16);
  const view = new DataView(result.buffer);
  view.setUint32(8, memory.byteLength, true);
  view.setUint16(12, PAGE_BYTES, true);
  view.setUint16(14, 0, true);
  view.setUint32(48, changed.length, true);
  for (let entry = 0; entry < changed.length; entry++) {
    const page = changed[entry]!;
    const offset = HEADER_BYTES + entry * ENTRY_BYTES;
    view.setUint32(offset, page, true);
    const target = new Uint32Array(result.buffer, offset + 4, wordsPerPage);
    for (let i = 0; i < wordsPerPage; i++) target[i] = currentWords[page * wordsPerPage + i]! ^ baseWords[page * wordsPerPage + i]!;
  }
  return result;
}

export function decodeCheckpoint(payload: Uint8Array, baseline: Uint8Array, wasmSha256: string,
  options: { allowLegacy?: boolean } = {}): Uint8Array {
  checkMemory(baseline);
  const hash = hashBytes(wasmSha256);
  const packed = MAGIC.every((byte, index) => payload[index] === byte);
  if (!packed) {
    if (options.allowLegacy && payload.byteLength === baseline.byteLength) return Uint8Array.from(payload);
    throw new Error('Unsupported checkpoint format.');
  }
  if (payload.byteLength < HEADER_BYTES || payload.byteLength > maxCheckpointBytes(baseline.byteLength))
    throw new Error('Invalid checkpoint length.');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint32(8, true) !== baseline.byteLength || view.getUint16(12, true) !== PAGE_BYTES
    || view.getUint16(14, true) !== 0 || !hash.every((byte, i) => payload[16 + i] === byte))
    throw new Error('Incompatible checkpoint artifact or layout.');
  const count = view.getUint32(48, true);
  if (count > baseline.byteLength / PAGE_BYTES || payload.byteLength !== HEADER_BYTES + count * ENTRY_BYTES)
    throw new Error('Invalid checkpoint page count.');
  let previous = -1;
  for (let entry = 0; entry < count; entry++) {
    const page = view.getUint32(HEADER_BYTES + entry * ENTRY_BYTES, true);
    if (page <= previous || page >= baseline.byteLength / PAGE_BYTES) throw new Error('Invalid checkpoint page order.');
    previous = page;
  }
  const result = Uint8Array.from(baseline);
  const resultWords = words(result), payloadWords = words(payload);
  const wordsPerPage = PAGE_BYTES / 4;
  for (let entry = 0; entry < count; entry++) {
    const offset = HEADER_BYTES + entry * ENTRY_BYTES;
    const page = view.getUint32(offset, true);
    for (let i = 0; i < wordsPerPage; i++) resultWords[page * wordsPerPage + i]! ^= payloadWords[(offset + 4) / 4 + i]!;
  }
  return result;
}
