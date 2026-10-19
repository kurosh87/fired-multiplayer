import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLASH_BYTES, WasmEngine } from '../packages/engine/runtime.ts';
import { fixtureArtifact } from './fixture-engine.ts';

test('the shared WASM runtime advances deterministically and restores complete state', async () => {
  const { bytes, manifest } = fixtureArtifact();
  const browser = await WasmEngine.create(bytes, manifest, 123);
  const server = await WasmEngine.create(bytes, manifest, 123);
  const runs = [{ buttons: 16, frames: 12 }, { buttons: 1, frames: 3 }];
  browser.advance(runs); server.advance(runs);
  assert.equal(browser.frame, 15);
  assert.equal(browser.digest(), server.digest());
  const snapshot = server.snapshot();
  const hash = server.digest();
  server.advance([{ buttons: 2, frames: 3 }]);
  assert.notEqual(hash, server.digest());
  server.restore(snapshot);
  assert.equal(server.digest(), hash);
  assert.equal(server.frame, 15);
  assert.equal(server.flash().byteLength, FLASH_BYTES);
  browser.close(); server.close();
});

test('runtime rejects corrupted artifacts and invalid canonical saves', async () => {
  const { bytes, manifest } = fixtureArtifact();
  await assert.rejects(WasmEngine.create(bytes, { ...manifest, wasmSha256: '0'.repeat(64) }, 0), { code: 'ENGINE_HASH_MISMATCH' });
  await assert.rejects(WasmEngine.create(bytes, manifest, 0, new Uint8Array(10)), { code: 'INVALID_SAVE' });
});

test('runtime rejects invalid button masks and use after close', async () => {
  const { bytes, manifest } = fixtureArtifact();
  const engine = await WasmEngine.create(bytes, manifest, 0);
  assert.throws(() => engine.advance([{ buttons: 1024, frames: 1 }]), { code: 'INVALID_INPUT' });
  engine.close();
  assert.throws(() => engine.digest(), { code: 'ENGINE_CLOSED' });
});
