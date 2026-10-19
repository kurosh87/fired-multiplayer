import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { prepareLobbySave } from '../packages/trading/prepare-lobby.ts';
import { createCheckpointBaseline, encodeCheckpoint } from '../packages/engine/checkpoint.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0)
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types', ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
const directory = resolve(process.argv[2] ?? 'build/game-source/firered');
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
const replay = JSON.parse(await readFile(resolve('tests/replays', manifest.version === 'firered'
  ? 'starter-rival-save.json' : 'leafgreen-starter-rival-save.json'), 'utf8'));
const engine = await WasmEngine.create(bytes, manifest, replay.seed);
try {
  const save = (snapshot: Uint8Array) => prepareLobbySave(bytes, manifest, replay.seed, snapshot);
  await assert.rejects(save(engine.snapshot()), { code: 'LOBBY_UNSAFE_LOCATION' });
  const battle = replay.milestones.find((point: any) => point.name === 'rival-battle').frame;
  const field = replay.milestones.find((point: any) => point.name === 'after-rival').frame;
  let offset = 0, battleChecked = false;
  for (const input of replay.runs) {
    let remaining = Math.min(input.frames, field - offset);
    while (remaining > 0) {
      const count = Math.min(remaining, offset < battle ? battle - offset : remaining);
      engine.advance([{ buttons: input.buttons, frames: count }]); offset += count; remaining -= count;
      if (offset === battle && !battleChecked) {
        await assert.rejects(save(engine.snapshot()), { code: 'LOBBY_UNSAFE_LOCATION' }); battleChecked = true;
      }
    }
    if (offset === field) break;
  }
  assert.equal(engine.frame, field); assert(battleChecked);
  assert(engine.flash().every(byte => byte === 0xff), 'This scenario must precede any manual save.');
  const before = engine.snapshot();
  const staged = await save(before);
  assert.equal(Buffer.compare(before, engine.snapshot()), 0, 'Lobby preparation mutated the live verified adventure.');
  assert.equal(staged.frame, field); assert.equal(staged.party.length, 1);
  assert.equal(staged.party[0]!.species, 1);
  assert(!staged.flash.every(byte => byte === 0xff));
  const resumed = await WasmEngine.create(bytes, manifest, replay.seed);
  const replica = await WasmEngine.create(bytes, manifest, replay.seed);
  try {
    resumed.restore(staged.snapshot); replica.restore(staged.snapshot);
    assert.equal(resumed.digest(), staged.digest);
    const runs = [{ buttons: 0, frames: 60 }, { buttons: 0, frames: 60 }];
    resumed.advance(runs); replica.advance(runs);
    assert.equal(resumed.digest(), replica.digest());
    assert.equal(Buffer.compare(resumed.flash(), staged.flash), 0);
    const c = resumed.bindExtension<Record<string, any>>('kanto_lobby_save_abi_version', 1, ['GetGameStat']);
    assert.equal(c.GetGameStat(0), 1, 'The original save statistic was not preserved in the runtime.');
    assert.equal(new DataView(c.memory.buffer).getUint8(c.gDifferentSaveFile.value), 0);
    const baseline = await createCheckpointBaseline(await WebAssembly.compile(bytes));
    await writeFile(resolve(directory, 'lobby-start.checkpoint.gz'), gzipSync(encodeCheckpoint(staged.snapshot, baseline, manifest.wasmSha256)));
    await writeFile(resolve(directory, 'lobby-inputs.json'), JSON.stringify({ artifactId: manifest.id,
      sourceCommit: manifest.upstreamCommit, seed: replay.seed, startDigest: staged.digest,
      runs, expectedFrames: resumed.frame, expectedDigest: resumed.digest() }, null, 2) + '\n');
  } finally { resumed.close(); replica.close(); }
  // Guard fixtures on another clone; the replay did not visit Safari Zone or
  // start a second adventure over an existing cartridge.
  const guarded = await WasmEngine.create(bytes, manifest, replay.seed);
  try {
    guarded.restore(before);
    const c = guarded.bindExtension<Record<string, any>>('kanto_lobby_save_abi_version', 1, ['SetSafariZoneFlag']);
    c.SetSafariZoneFlag();
    await assert.rejects(save(guarded.snapshot()), { code: 'LOBBY_UNSAFE_LOCATION' });
    guarded.restore(before);
    const memory = new DataView(c.memory.buffer);
    memory.setUint8(c.gDifferentSaveFile.value, 1);
    memory.setUint16(c.gSaveFileStatus.value, 1, true);
    await assert.rejects(save(guarded.snapshot()), { code: 'LOBBY_SAVE_CONFIRMATION_REQUIRED' });
  } finally { guarded.close(); }
  // Real menu input must reject entry while field controls are locked.
  engine.advance([{ buttons: 8, frames: 1 }, { buttons: 0, frames: 24 }]);
  await assert.rejects(save(engine.snapshot()), { code: 'LOBBY_UNSAFE_LOCATION' });
  await writeFile(resolve(directory, 'lobby.sav'), staged.flash);
  const report = { artifactId: manifest.id, version: manifest.version, frame: field,
    originalButtonsOnly: true, noPriorManualSave: true, titleRejected: true, battleRejected: true,
    menuRejected: true, liveRuntimeUnchanged: true, originalSaveStatistic: 1,
    guardFixtures: { safariSaveMenuRejected: true, pendingOverwriteRejected: true, fixtureOnly: true },
    runtimeRecovery: true, party: staged.party,
    flashSha256: createHash('sha256').update(staged.flash).digest('hex'),
    independentGbaReadback: false, publicReleaseQualified: false };
  await writeFile(resolve(directory, 'lobby-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { engine.close(); }
