import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionVerifier, type InputJournal, type JournalEntry } from '../packages/verification/verifier.ts';
import { WasmEngine } from '../packages/engine/runtime.ts';
import { fixtureArtifact } from './fixture-engine.ts';
import { inputBatch, trainerHandle, type InputBatch } from '../packages/protocol/index.ts';

class Journal implements InputJournal {
  entries = new Map<number, JournalEntry>();
  fail = false;
  async find(_session: string, sequence: number) { return this.entries.get(sequence); }
  async append(_session: string, _fence: number, entry: JournalEntry) {
    if (this.fail) throw new Error('Storage unavailable');
    this.entries.set(entry.batch.sequence, structuredClone(entry));
  }
}
const batch = (overrides: Partial<InputBatch> = {}): InputBatch => ({
  type: 'input', protocol: 1, operationId: 'operation-0', sessionId: 'session-a',
  sequence: 0, startFrame: 0, runs: [{ buttons: 16, frames: 10 }], ...overrides,
});

test('recovery cannot mint another startup allowance', async () => {
  const { bytes, manifest } = fixtureArtifact();
  const journal = new Journal();
  const first = await WasmEngine.create(bytes, manifest, 1);
  const verifier = new SessionVerifier({ engine: first, journal, sessionId: 'session-a', fence: 1, clock: () => 0 });
  await verifier.accept(batch({ runs: [{ buttons: 0, frames: 15 }] }));
  const point = await verifier.pause(); verifier.close();
  const restored = await WasmEngine.create(bytes, manifest, 1);
  restored.restore(point.snapshot);
  let now = 0;
  const recovered = new SessionVerifier({ engine: restored, journal, sessionId: 'session-a', fence: 2, nextSequence: 1, clock: () => now });
  const next = batch({ sequence: 1, startFrame: 15, operationId: 'recovered-input', runs: [{ buttons: 0, frames: 1 }] });
  try {
    await assert.rejects(recovered.accept(next), { code: 'INPUT_TOO_FAST' });
    assert.equal(restored.frame, 15);
    now = 20;
    assert.equal((await recovered.accept(next)).frame, 16);
  } finally { recovered.close(); }
});
async function setup() {
  const { bytes, manifest } = fixtureArtifact();
  const engine = await WasmEngine.create(bytes, manifest, 1);
  const journal = new Journal();
  let now = 0;
  const verifier = new SessionVerifier({ engine, journal, sessionId: 'session-a', fence: 1, clock: () => now });
  return { engine, journal, verifier, elapse: (ms: number) => { now += ms; } };
}

test('acks follow durable writes; retries return the same ack without replaying inputs', async () => {
  const { engine, verifier, journal } = await setup();
  const acknowledgement = await verifier.accept(batch());
  assert.equal(journal.entries.size, 1);
  assert.equal(acknowledgement.frame, 10);
  assert.deepEqual(await verifier.accept(batch()), acknowledgement);
  assert.equal(engine.frame, 10);
});

test('a committed input sequence cannot be rewritten', async () => {
  const { verifier } = await setup();
  await verifier.accept(batch());
  await assert.rejects(verifier.accept(batch({ runs: [{ buttons: 1, frames: 10 }] })), { code: 'INPUT_CONFLICT' });
});

test('concurrent batches execute in sequence rather than racing the engine', async () => {
  const { verifier, engine, elapse } = await setup();
  elapse(1000);
  await Promise.all([verifier.accept(batch()), verifier.accept(batch({ sequence: 1, startFrame: 10, operationId: 'operation-1' }))]);
  assert.equal(engine.frame, 20);
});

test('out of order, foreign and accelerated inputs are rejected without mutating state', async () => {
  const { verifier, engine } = await setup();
  await assert.rejects(verifier.accept(batch({ sequence: 1 })), { code: 'INPUT_OUT_OF_ORDER' });
  await assert.rejects(verifier.accept(batch({ sessionId: 'foreign' })), { code: 'SESSION_MISMATCH' });
  await assert.rejects(verifier.accept(batch({ runs: [{ buttons: 0, frames: 60 }] })), { code: 'INPUT_TOO_FAST' });
  assert.equal(engine.frame, 0);
});

test('persistence failure never acknowledges speculative progress or reuses poisoned state', async () => {
  const { verifier, journal } = await setup();
  journal.fail = true;
  await assert.rejects(verifier.accept(batch()), /Storage unavailable/);
  assert.equal(journal.entries.size, 0);
  await assert.rejects(verifier.accept(batch()), { code: 'SESSION_RECOVERY_REQUIRED' });
});

test('protocol refuses arbitrary game state and malformed input', () => {
  assert.throws(() => inputBatch({ ...batch(), pokemon: { level: 100 } }), { code: 'INVALID_MESSAGE' });
  assert.throws(() => inputBatch(batch({ runs: [{ buttons: -1, frames: 1 }] })), { code: 'INVALID_INPUT' });
  assert.throws(() => inputBatch(batch({ runs: [{ buttons: 0, frames: Infinity }] })), { code: 'INVALID_INPUT' });
  assert.throws(() => inputBatch(batch({ runs: [{ buttons: 0, frames: 61 }] })), { code: 'INVALID_INPUT' });
  assert.equal(trainerHandle('Ash_01').canonical, 'ash_01');
  assert.throws(() => trainerHandle(' ash '), { code: 'INVALID_HANDLE' });
});

test('pause and resume cannot mint extra fast-forward credit', async () => {
  const { verifier, engine } = await setup();
  await verifier.accept(batch({ runs: [{ buttons: 0, frames: 15 }] }));
  await verifier.pause(); verifier.resume();
  await assert.rejects(verifier.accept(batch({ sequence: 1, startFrame: 15,
    operationId: 'operation-1', runs: [{ buttons: 0, frames: 1 }] })), { code: 'INPUT_TOO_FAST' });
  assert.equal(engine.frame, 15);
});

test('semantically identical retries do not depend on JSON property order', async () => {
  const { verifier } = await setup();
  const acknowledgement = await verifier.accept(batch());
  const reordered = { runs: [{ frames: 10, buttons: 16 }], startFrame: 0, sequence: 0,
    sessionId: 'session-a', operationId: 'operation-0', protocol: 1, type: 'input' };
  assert.deepEqual(await verifier.accept(reordered), acknowledgement);
});
