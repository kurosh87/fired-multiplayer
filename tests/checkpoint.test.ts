import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCheckpoint, decodeCheckpoint, maxCheckpointBytes } from '../packages/engine/checkpoint.ts';

const hash = 'ab'.repeat(32);
const baseline = Uint8Array.from({ length: 65536 }, (_, i) => (i * 13 + 7) % 256);

test('checkpoint reconstructs every byte, including unaligned buffers and the last page', () => {
  const memory = Uint8Array.from(baseline);
  memory[0] = memory[0]! ^ 255; memory[8197] = memory[8197]! ^ 32;
  memory[memory.length - 1] = memory[memory.length - 1]! ^ 7;
  const original = Uint8Array.from(memory), originalBase = Uint8Array.from(baseline);
  const packed = encodeCheckpoint(memory, baseline, hash);
  assert(packed.length < memory.length);
  assert.deepEqual(decodeCheckpoint(packed, baseline, hash), memory);
  const unaligned = new Uint8Array(packed.length + 1); unaligned.set(packed, 1);
  assert.deepEqual(decodeCheckpoint(unaligned.subarray(1), baseline, hash), memory);
  const unalignedMemory = new Uint8Array(memory.length + 1); unalignedMemory.set(memory, 1);
  assert.deepEqual(encodeCheckpoint(unalignedMemory.subarray(1), baseline, hash), packed);
  assert.deepEqual(memory, original); assert.deepEqual(baseline, originalBase);
  assert.deepEqual(decodeCheckpoint(encodeCheckpoint(baseline, baseline, hash), baseline, hash), baseline);
  const allChanged = Uint8Array.from(baseline, value => value ^ 255);
  const maximum = encodeCheckpoint(allChanged, baseline, hash);
  assert.equal(maximum.length, maxCheckpointBytes(baseline.length));
  assert.deepEqual(decodeCheckpoint(maximum, baseline, hash), allChanged);
});

test('checkpoint rejects wrong artifacts, corrupt layouts, duplicate pages and truncated data', () => {
  const memory = Uint8Array.from(baseline); memory[0] = memory[0]! ^ 1; memory[4096] = memory[4096]! ^ 1;
  const valid = encodeCheckpoint(memory, baseline, hash);
  assert.throws(() => decodeCheckpoint(valid, baseline, 'cd'.repeat(32)), /artifact/);
  assert.throws(() => decodeCheckpoint(valid.subarray(0, valid.length - 1), baseline, hash), /count/);
  assert.throws(() => decodeCheckpoint(new Uint8Array(1), baseline, hash), /format/);
  for (const [offset, value] of [[8, 4096], [12, 2048], [14, 1], [48, 999999], [52, 99], [4152, 0]]) {
    const corrupt = Uint8Array.from(valid);
    const view = new DataView(corrupt.buffer);
    if (offset === 12 || offset === 14) view.setUint16(offset!, value!, true);
    else view.setUint32(offset!, value!, true);
    assert.throws(() => decodeCheckpoint(corrupt, baseline, hash));
  }
  assert.throws(() => encodeCheckpoint(memory.subarray(1), baseline, hash), /size/);
  assert.throws(() => encodeCheckpoint(memory, baseline.subarray(4096), hash), /baseline/);
  assert.throws(() => maxCheckpointBytes(1024 ** 3), /size/);
});

test('legacy full-memory checkpoints require an explicit trusted-storage compatibility option', () => {
  assert.throws(() => decodeCheckpoint(baseline, baseline, hash), /format/);
  const restored = decodeCheckpoint(baseline, baseline, hash, { allowLegacy: true });
  assert.deepEqual(restored, baseline); assert.notEqual(restored, baseline);
  assert.throws(() => decodeCheckpoint(baseline.subarray(1), baseline, hash, { allowLegacy: true }));
});
