import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import type { InputRun } from '../packages/protocol/index.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types',
    ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
}
const directory = resolve(process.argv[2] ?? 'build/game-source/firered');
const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.wasmSha256);
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
// Original C symbols are inspected only by this experimental test harness.
// Every gameplay mutation below is a recorded button input through the ABI.
type Core = Record<string, any> & { memory: WebAssembly.Memory };
type Replay = { seed: number; sourceCommit: string; runs: InputRun[]; expectedFrames: number;
  variants?: string[]; expectedParty?: { species: number; level: number } };
let immutableReference: Uint8Array | undefined;
function immutable(core: Core): Uint8Array {
  const pointer = core.kanto_immutable_ptr(), size = core.kanto_immutable_size();
  assert(size > 1024 * 1024 && pointer >= 1048576 && pointer + size <= core.__data_end.value);
  return new Uint8Array(core.memory.buffer, pointer, size);
}
function checkImmutable(core: Core, stage: string): void {
  const actual = immutable(core);
  assert(immutableReference);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== immutableReference[i])
      assert.fail(`${stage}: immutable byte changed at 0x${(core.kanto_immutable_ptr() + i).toString(16)} (${immutableReference[i]} -> ${actual[i]})`);
  }
}
const replayPath = process.env.KANTO_ENGINE_REPLAY ?? (manifest.version === 'leafgreen'
  ? 'tests/replays/leafgreen-starter-rival-save.json' : 'tests/replays/starter-rival-save.json');
const replay = JSON.parse(await readFile(resolve(replayPath), 'utf8')) as Replay;
assert.equal(replay.sourceCommit, manifest.upstreamCommit);
assert(replay.variants?.includes(manifest.version), 'Replay targets another game version.');

async function fresh(save?: Uint8Array): Promise<Core> {
  const core = (await WebAssembly.instantiate(module, {})).exports as Core;
  if (!immutableReference) immutableReference = immutable(core).slice();
  checkImmutable(core, 'fresh initializer');
  assert.equal(core.kanto_flash_size(), 128 * 1024);
  const flash = new Uint8Array(core.memory.buffer, core.kanto_flash_ptr(), core.kanto_flash_size());
  flash.fill(0xff);
  if (save) { assert.equal(save.length, flash.length); flash.set(save); }
  assert.equal(core.kanto_boot(replay.seed, save ? 1 : 0), 0);
  assert.equal(core.kanto_after_restore(), 0);
  checkImmutable(core, 'boot');
  return core;
}
function play(core: Core, replay: Replay): void {
  const start = core.kanto_frame();
  for (const run of replay.runs) {
    assert(Number.isInteger(run.buttons) && run.buttons >= 0 && run.buttons <= 1023);
    assert(Number.isInteger(run.frames) && run.frames >= 1 && run.frames <= 60);
    const frame = core.kanto_frame();
    assert.equal(core.kanto_step(run.buttons, run.frames), 0);
    assert.equal(core.kanto_frame(), frame + run.frames);
  }
  assert.equal(core.kanto_frame(), start + replay.expectedFrames);
  checkImmutable(core, 'gameplay');
}
function status(core: Core) {
  const memory = new DataView(core.memory.buffer);
  const save = memory.getUint32(core.gSaveBlock1Ptr.value, true);
  return { partyCount: memory.getUint8(core.gPlayerPartyCount.value),
    mapGroup: memory.getUint8(save + 4), mapNumber: memory.getUint8(save + 5),
    scene: core.VarGet(0x4055), questLog: memory.getUint8(core.gQuestLogState.value),
    fileStatus: memory.getUint16(core.gSaveFileStatus.value, true),
    attemptStatus: memory.getUint16(core.gSaveAttemptStatus.value, true) };
}
function party(core: Core) {
  // Field numbers are from the pinned include/constants/pokemon.h.
  const mon = core.gPlayerParty.value;
  return { species: core.GetMonData2(mon, 11), level: core.GetMonData2(mon, 56),
    hp: core.GetMonData2(mon, 57), maxHp: core.GetMonData2(mon, 58),
    personality: core.GetMonData2(mon, 0) >>> 0, trainerId: core.GetMonData2(mon, 1) >>> 0,
    checksum: core.GetMonData2(mon, 9) };
}
function digest(core: Core) {
  const pointer = core.kanto_state_ptr(), size = core.kanto_state_size();
  return createHash('sha256').update(manifest.id)
    .update(new Uint8Array(core.memory.buffer, pointer, size)).digest('hex');
}

const core = await fresh();
console.log(`Running ${replay.expectedFrames} recorded ${manifest.version} adventure frames...`);
play(core, replay);
const savedStatus = status(core);
console.log('Recorded route end:', savedStatus);
await writeFile(resolve(directory, 'gameplay-attempt.checkpoint'), new Uint8Array(core.memory.buffer));
await writeFile(resolve(directory, 'gameplay-attempt.rgba'), new Uint8Array(core.memory.buffer,
  core.kanto_framebuffer_ptr(), core.kanto_framebuffer_size()));
assert.equal(savedStatus.attemptStatus, 1, 'Original save menu did not succeed.');
assert.equal(savedStatus.partyCount, 1);
assert.equal(savedStatus.mapGroup, 4);
assert.equal(savedStatus.mapNumber, 3);
assert.equal(savedStatus.scene, 4, 'First rival battle did not complete.');
const beforeInspection = digest(core);
const savedParty = party(core);
assert.equal(digest(core), beforeInspection, 'Inspecting a valid Pokemon changed its canonical state.');
assert.equal(savedParty.species, replay.expectedParty?.species);
assert.equal(savedParty.level, replay.expectedParty?.level);
assert.equal(savedParty.hp, savedParty.maxHp);
const checkpoint = new Uint8Array(core.memory.buffer).slice();
const flash = new Uint8Array(core.memory.buffer, core.kanto_flash_ptr(), core.kanto_flash_size()).slice();
console.log('Starter, rival battle and original-menu save passed. Checking checkpoint replay and Continue...');
assert(flash.some(byte => byte !== 0xff), 'Flash remains erased after saving.');
const a = await WasmEngine.create(bytes, manifest, replay.seed);
const b = await WasmEngine.create(bytes, manifest, replay.seed);
try {
  a.restore(checkpoint); b.restore(checkpoint);
  assert.equal(a.digest(), beforeInspection);
  assert.equal(a.digest(), b.digest());
  a.advance([{ buttons: 0, frames: 30 }]); b.advance([{ buttons: 0, frames: 30 }]);
  assert.notEqual(a.digest(), beforeInspection, 'Canonical state omitted advancing simulation state.');
  assert.equal(a.digest(), b.digest());
} finally { a.close(); b.close(); }
const loaded = await fresh(flash);
const continuation = JSON.parse(await readFile(resolve('tests/replays/continue.json'), 'utf8')) as Replay;
play(loaded, continuation);
const loadedStatus = status(loaded);
assert.equal(loadedStatus.fileStatus, 1, 'Original game rejected its saved sectors.');
assert.equal(loadedStatus.partyCount, 1);
assert.equal(loadedStatus.mapGroup, savedStatus.mapGroup);
assert.equal(loadedStatus.mapNumber, savedStatus.mapNumber);
assert.equal(loadedStatus.scene, savedStatus.scene);
assert(loadedStatus.questLog < 2, 'Continue did not finish its quest-log recap.');
assert.deepEqual(party(loaded), savedParty);
console.log('Continue restored the saved party. Checking the original reset chord...');
const frameBeforeReset = loaded.kanto_frame();
assert.equal(loaded.kanto_step(0x0f, 1), 0); // A+B+Select+Start, through original ReadKeys.
assert.equal(loaded.kanto_frame(), frameBeforeReset + 1);
assert.equal(loaded.kanto_after_restore(), 0);
assert.deepEqual(new Uint8Array(loaded.memory.buffer, loaded.kanto_flash_ptr(), loaded.kanto_flash_size()), flash);
play(loaded, continuation);
assert.equal(status(loaded).fileStatus, 1);
assert.equal(status(loaded).mapNumber, savedStatus.mapNumber);
assert.deepEqual(party(loaded), savedParty);
await writeFile(resolve(directory, 'gameplay.sav'), flash);
await writeFile(resolve(directory, 'gameplay.checkpoint'), checkpoint);
const report = { artifactId: manifest.id, frames: replay.expectedFrames, savedParty,
  originalMenuSave: true, freshInstanceContinue: true, originalSaveChecksumsAccepted: true,
  checkpointReplay: true, warmResetPreservesFlash: true, warmResetContinue: true,
  immutableAssetsUnchanged: true, canonicalStateBytes: core.kanto_state_size(),
  flashSha256: createHash('sha256').update(flash).digest('hex'),
  independentGbaReadback: false, completeAdventureQualified: false, publicReleaseQualified: false };
await writeFile(resolve(directory, 'gameplay-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
