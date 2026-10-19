import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EngineManifest } from '../packages/engine/runtime.ts';
import type { InputRun } from '../packages/protocol/index.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types',
    ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
}
const directory = resolve(process.argv[2] ?? 'build/game-source/firered');
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
const bytes = await readFile(resolve(directory, 'candidate.wasm'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.wasmSha256);
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const replay = JSON.parse(await readFile(resolve('tests/replays/new-game.json'), 'utf8')) as {
  sourceCommit: string; seed: number; runs: InputRun[];
};
assert.equal(replay.sourceCommit, manifest.upstreamCommit);
type Core = Record<string, any> & { memory: WebAssembly.Memory };
async function fresh(seed: number): Promise<Core> {
  const core = (await WebAssembly.instantiate(module, {})).exports as Core;
  new Uint8Array(core.memory.buffer, core.kanto_flash_ptr(), core.kanto_flash_size()).fill(0xff);
  assert.equal(core.kanto_boot(seed, 0), 0);
  return core;
}
function play(core: Core, start: number, end: number) {
  let frame = 0;
  const before = core.kanto_frame();
  for (const run of replay.runs) {
    const frames = Math.max(0, Math.min(frame + run.frames, end) - Math.max(frame, start));
    if (frames) assert.equal(core.kanto_step(run.buttons, frames), 0);
    frame += run.frames;
    if (frame >= end) break;
  }
  assert.equal(core.kanto_frame(), before + end - start);
}
function digest(core: Core) {
  const pointer = core.kanto_state_ptr(), size = core.kanto_state_size();
  return createHash('sha256').update(manifest.id)
    .update(new Uint8Array(core.memory.buffer, pointer, size)).digest('hex');
}
const a = await fresh(replay.seed);
const otherSeed = replay.seed ^ 0x10000;
const b = await fresh(otherSeed);
play(a, 0, 1201); play(b, 0, 1201);
const atTitle = a.KantoPlatformEntropyRead();
assert.notEqual(atTitle, b.KantoPlatformEntropyRead(), 'Upper server seed bits were lost at the title screen.');
const checkpoint = new Uint8Array(a.memory.buffer).slice();
const restored = await fresh(replay.seed);
new Uint8Array(restored.memory.buffer).set(checkpoint);
assert.equal(restored.kanto_after_restore(), 0);
assert.equal(digest(restored), digest(a));
play(a, 1201, 2000); play(b, 1201, 2000); play(restored, 1201, 2000);
const id = a.GetGeneratedTrainerIdLower();
const otherId = b.GetGeneratedTrainerIdLower();
assert.equal(id, a.KantoPlatformEntropyRead(), 'Original title-screen PRNG seeding did not run.');
assert.notEqual(id, 0);
assert.notEqual(id, otherId, 'Distinct trusted seeds produced the old constant title seed.');
assert.equal(restored.GetGeneratedTrainerIdLower(), id);
assert.equal(digest(restored), digest(a));
// A deterministic pause does not create clock ticks. A later title-screen
// input does: use the same checkpoint and actual original-game button route.
new Uint8Array(restored.memory.buffer).set(checkpoint);
assert.equal(restored.kanto_after_restore(), 0);
assert.equal(restored.kanto_step(0, 15), 0);
play(restored, 1201, 2000);
const delayedId = restored.GetGeneratedTrainerIdLower();
assert.notEqual(delayedId, id, 'Title-screen input timing did not affect the virtual entropy counter.');
// Reset restores the same trusted origin instead of replacing it with zero.
const beforeReset = a.kanto_frame();
assert.equal(a.kanto_step(0x0f, 1), 0);
assert.equal(a.kanto_frame(), beforeReset + 1);
play(a, 0, 2000);
assert.equal(a.GetGeneratedTrainerIdLower(), id);
const report = { artifactId: manifest.id, seed: replay.seed, otherSeed, titleCounter: atTitle,
  trainerIdLower: id, otherTrainerIdLower: otherId, delayedTrainerIdLower: delayedId,
  upperSeedBitsSurvive: true, simulatedTimingAffectsSeed: true,
  checkpointReplay: true, warmResetPreservesSeed: true,
  cycleExactTimerEmulation: false, publicReleaseQualified: false };
await writeFile(resolve(directory, 'entropy-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
