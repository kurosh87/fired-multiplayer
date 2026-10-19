import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineRegistry } from '../packages/engine/registry.ts';
import { fixtureArtifact } from './fixture-engine.ts';

test('missing game artifacts never produce invented playable adventures', async () => {
  const registry = new EngineRegistry();
  await registry.load(join(tmpdir(), 'kanto-no-artifacts'), false);
  assert.ok(registry.status().every(item => !item.available));
  assert.throws(() => registry.manifest('firered'), { code: 'ENGINE_UNAVAILABLE' });
});

test('public mode refuses an experimental WASM artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kanto-registry-'));
  try {
    const { bytes, manifest } = fixtureArtifact();
    await writeFile(join(directory, 'firered.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'firered.wasm'), bytes);
    const registry = new EngineRegistry();
    await registry.load(directory, true);
    assert.equal(registry.status().find(item => item.version === 'firered')!.available, false);
    assert.match(registry.status()[0]!.reason, /verified/);
    await registry.load(directory, false);
    assert.equal(registry.status().find(item => item.version === 'firered')!.available, true);
    const engine = await registry.create('firered', 123);
    const recovered = await registry.create('firered', 999);
    try {
      engine.advance([{ buttons: 16, frames: 15 }]);
      const digest = engine.digest(), snapshot = engine.snapshot();
      const packed = registry.encodeCheckpoint('firered', snapshot);
      assert(packed.byteLength < snapshot.byteLength);
      assert(packed.byteLength <= registry.checkpointLimit('firered'));
      const decoded = registry.decodeCheckpoint('firered', packed);
      assert.deepEqual(decoded, snapshot);
      assert.deepEqual(registry.decodeCheckpoint('firered', snapshot), snapshot);
      recovered.restore(decoded);
      assert.equal(recovered.digest(), digest);
      assert.equal(recovered.frame, engine.frame);
      assert.deepEqual(recovered.flash(), engine.flash());
    } finally { engine.close(); recovered.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
