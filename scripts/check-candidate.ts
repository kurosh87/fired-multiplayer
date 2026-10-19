import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types',
    ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
}

// Experimental boot/recovery probe. This does not promote or publish a core,
// and shared self-replay is not an independent GBA correctness reference.
const directory = resolve(process.argv[2] ?? 'build/game-source/firered');
const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const core = (await WebAssembly.instantiate(module, {})).exports as Record<string, any>;
const diagnostic = () => new TextDecoder().decode(new Uint8Array(core.memory.buffer,
  core.kanto_diagnostic_ptr(), core.kanto_diagnostic_size())).split('\0')[0];
let stage = 'boot';
try {
  new Uint8Array(core.memory.buffer, core.kanto_flash_ptr(), core.kanto_flash_size()).fill(0xff);
  assert.equal(core.kanto_boot(12345, 0), 0);
  assert.equal(core.kanto_after_restore(), 0);
  console.log(`Booted ${manifest.id}: ${diagnostic()}`);
  const checkpoints: { frame: number; colors: number; imageSha256: string }[] = [];
  for (let frame = 1; frame <= 900; frame++) {
    stage = `frame ${frame}`;
    assert.equal(core.kanto_step(0, 1), 0);
    assert.equal(core.kanto_frame(), frame);
    if (frame % 150 === 0) {
      const pixels = new Uint8Array(core.memory.buffer, core.kanto_framebuffer_ptr(), core.kanto_framebuffer_size());
      const colors = new Set(new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4)).size;
      checkpoints.push({ frame, colors, imageSha256: createHash('sha256').update(pixels).digest('hex') });
      await writeFile(resolve(directory, `frame-${frame}.rgba`), pixels);
      console.log(`Frame ${frame}: ${colors} colors`);
    }
  }
  assert(checkpoints.some(point => point.colors > 16), 'Boot never rendered a detailed game frame.');
  stage = 'canonical checkpoint replay';
  const a = await WasmEngine.create(bytes, manifest, 12345);
  const b = await WasmEngine.create(bytes, manifest, 12345);
  for (let i = 0; i < 10; i++) a.advance([{ buttons: 0, frames: 60 }]);
  b.restore(a.snapshot());
  assert.equal(a.digest(), b.digest());
  for (let i = 0; i < 10; i++) {
    a.advance([{ buttons: i % 2, frames: 30 }]);
    b.advance([{ buttons: i % 2, frames: 30 }]);
    assert.equal(a.digest(), b.digest());
  }
  const before = a.digest();
  a.restore(a.snapshot());
  assert.equal(a.digest(), before);
  a.close(); b.close();
  await writeFile(resolve(directory, 'boot-report.json'), JSON.stringify({ artifactId: manifest.id,
    frames: 900, checkpoints, checkpointReplay: true, independentReference: false,
    browserParity: false, gameplayQualified: false, publicReleaseQualified: false }, null, 2) + '\n');
  console.log('Real game boot and headless checkpoint replay passed; gameplay qualification remains pending.');
} catch (error) {
  console.error(`Candidate failed during ${stage}. Last C diagnostic: ${diagnostic()}`);
  throw error;
}
