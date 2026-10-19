import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { OriginalTradeCore } from '../packages/trading/original-core.ts';
import type { EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint } from '../packages/engine/checkpoint.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types',
    ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
}
const directory = resolve(process.argv[2] ?? 'build/game-source/firered');
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
const originalSave = new Uint8Array(await readFile(resolve(directory, 'gameplay.sav')));
const originalSaveReport = JSON.parse(await readFile(resolve(directory, 'gameplay-report.json'), 'utf8'));
assert.equal(createHash('sha256').update(originalSave).digest('hex'), originalSaveReport.flashSha256);
assert.equal(originalSaveReport.originalMenuSave, true);
assert.equal(originalSaveReport.artifactId, manifest.id, 'Replay the adventure with this candidate before qualifying trades.');
const peerDirectory = resolve(process.argv[3] ?? directory);
const peerManifest = JSON.parse(await readFile(resolve(peerDirectory, 'candidate.json'), 'utf8')) as EngineManifest;
const peerBytes = new Uint8Array(await readFile(resolve(peerDirectory, 'candidate.wasm')));
const peerSave = new Uint8Array(await readFile(resolve(peerDirectory, 'gameplay.sav')));
const peerSaveReport = JSON.parse(await readFile(resolve(peerDirectory, 'gameplay-report.json'), 'utf8'));
assert.equal(createHash('sha256').update(peerSave).digest('hex'), peerSaveReport.flashSha256);
assert.equal(peerSaveReport.originalMenuSave, true);
assert.equal(peerSaveReport.artifactId, peerManifest.id, 'Replay the peer adventure with its current candidate first.');
const crossVersion = manifest.version !== peerManifest.version;
const output = resolve(directory, 'exchange-checks', ...(crossVersion ? [peerManifest.version] : []));
await mkdir(output, { recursive: true });
const baselines = new Map<string, Promise<Uint8Array>>();
function baseline(scene: OriginalTradeCore) {
  const id = scene.engine.manifest.id;
  if (!baselines.has(id)) baselines.set(id, WebAssembly.compile(id === manifest.id ? bytes : peerBytes).then(createCheckpointBaseline));
  return baselines.get(id)!;
}

// Fixture construction is deliberately restricted to this qualification tool.
// Pokemon and saves are created by original C routines, not JS save editing.
// These fixtures do not prove adventure provenance and are never user saves.
type Debug = Record<string, any> & { memory: WebAssembly.Memory };
const headers = new Map<string, string>();
async function constant(file: string, name: string): Promise<number> {
  if (!headers.has(file)) headers.set(file, await readFile(resolve('vendor/pokefirered-native/include/constants', file), 'utf8'));
  const match = new RegExp(`^#define\\s+${name}\\s+(0x[\\da-fA-F]+|\\d+)\\b`, 'm').exec(headers.get(file)!);
  assert(match, `Missing pinned game constant ${name}.`);
  return Number(match[1]);
}
const item = Object.fromEntries(await Promise.all(['KINGS_ROCK', 'METAL_COAT', 'EVERSTONE', 'ORANGE_MAIL'].map(async name =>
  [name, await constant('items.h', `ITEM_${name}`)] as const)));
function debug(scene: OriginalTradeCore): Debug {
  return scene.engine.bindExtension<Debug>('kanto_exchange_abi_version', 1,
    ['CreateMon', 'CreateEgg', 'SetMonData', 'GetMonData2', 'EnableNationalPokedex', 'GiveMailToMon',
      'TrySavingData', 'GetGameStat', 'GetSetPokedexFlag', 'SetTrainerId']);
}
function set(scene: OriginalTradeCore, slot: number, field: number, value: number) {
  const c = debug(scene), scratch = c.__heap_base.value;
  new DataView(c.memory.buffer).setUint32(scratch, value, true);
  c.SetMonData(c.gPlayerParty.value + slot * c.kanto_exchange_mon_size(), field, scratch);
}
async function fixture(seed: number, species = 16, level = 5, options: { national?: boolean; heldItem?: number; egg?: boolean; mail?: boolean } = {}, peer = false) {
  const scene = await OriginalTradeCore.create(peer ? peerBytes : bytes, peer ? peerManifest : manifest, seed, peer ? peerSave : originalSave);
  try {
    const c = debug(scene), base = c.gPlayerParty.value;
    // Distinct fixture trainers, encoded by the original routine. The saved
    // adventure is only a structural input; these are not real user saves.
    const save2 = new DataView(c.memory.buffer).getUint32(c.gSaveBlock2Ptr.value, true);
    c.SetTrainerId(seed * 104729, save2 + 0x0a);
    c.CreateMon(base, 1, 6, 15, 1, seed * 10, 0, 0);
    if (options.egg) c.CreateEgg(base + 100, species, 0);
    else c.CreateMon(base + 100, species, level, 15, 1, seed * 10 + 1, 0, 0);
    new DataView(c.memory.buffer).setUint8(c.gPlayerPartyCount.value, 2);
    set(scene, 0, 32, 190); set(scene, 1, 32, options.egg ? 37 : 210);
    if (options.national) c.EnableNationalPokedex();
    if (options.heldItem) set(scene, 1, 12, options.heldItem);
    if (options.mail) {
      const index = c.GiveMailToMon(base + 100, item.ORANGE_MAIL);
      assert(index >= 0 && index < 6);
      // Original SaveBlock1 layout at the pinned wasm32/GBA ABI: mail at
      // 0x2cd0, 36-byte entries. Only seed a fixture message; transfer is C.
      const memory = new DataView(c.memory.buffer);
      const save = memory.getUint32(c.gSaveBlock1Ptr.value, true);
      memory.setUint16(save + 0x2cd0 + index * 36, 0x0201, true);
      memory.setUint8(save + 0x309c, 7); // Fixture gift ribbon, original location.
      set(scene, 1, 67, 1); // Champion ribbon: original SetMonData encryption.
    }
    assert.equal(c.TrySavingData(0), 1);
    return scene.engine.flash();
  } finally { scene.close(); }
}
function connect(a: OriginalTradeCore, b: OriginalTradeCore) {
  const packetA = a.packet(), packetB = b.packet();
  assert.equal(packetA.length, packetB.length);
  a.receive(packetB); b.receive(packetA);
}
function sameBytes(actual: Uint8Array, expected: Uint8Array, message: string) {
  assert.equal(Buffer.compare(actual, expected), 0, message);
}
async function finish(scene: OriginalTradeCore, name: string, sceneSeed: number) {
  const inputs: { buttons: number; frames: number }[] = [];
  const startDigest = scene.engine.digest();
  await writeFile(resolve(output, `${name}-start.checkpoint.gz`), gzipSync(encodeCheckpoint(
    scene.engine.snapshot(), await baseline(scene), scene.engine.manifest.wasmSha256)));
  let lastTrace = '';
  while (scene.phase === 2 && scene.engine.frame < 12000) {
    const buttons = scene.engine.frame % 61 === 0 ? 1 : 0;
    // This is a test's explicit button policy. Production must obtain actual
    // player input for original evolution/move-learning decisions.
    scene.engine.advance([{ buttons, frames: 1 }]);
    if (process.env.KANTO_EXCHANGE_TRACE && name.endsWith('-a')) {
      const c = debug(scene), v = new DataView(c.memory.buffer);
      const tasks = Array.from({ length: 16 }, (_, i) => c.gTasks.value + i * 40)
        .filter(p => v.getUint8(p + 4)).map(p => [c.__indirect_function_table.get(v.getUint32(p, true)).name,
          v.getInt16(p + 8, true), v.getInt16(p + 8 + 12 * 2, true)]);
      const trace = JSON.stringify([c.__indirect_function_table.get(v.getUint32(c.gMain.value + 4, true)).name, tasks]);
      if (trace !== lastTrace && scene.engine.frame > 1700) console.log(scene.engine.frame, trace);
      lastTrace = trace;
    }
    const previous = inputs.at(-1);
    if (previous?.buttons === buttons && previous.frames < 60) previous.frames++;
    else inputs.push({ buttons, frames: 1 });
  }
  const c = debug(scene);
  if (scene.phase !== 3) {
    await writeFile(resolve(output, `${name}-failed.rgba`), new Uint8Array(c.memory.buffer, c.kanto_framebuffer_ptr(), c.kanto_framebuffer_size()));
    await writeFile(resolve(output, `${name}-failed.checkpoint.gz`), gzipSync(scene.engine.snapshot()));
    const index = new DataView(c.memory.buffer).getUint32(c.gMain.value + 4, true);
    const callback = c.__indirect_function_table.get(index);
    console.log({ name, callbackIndex: index, callback: Object.entries(c).filter(([, value]) => value === callback).map(([key]) => key) });
  }
  assert.equal(scene.phase, 3, `${name}: original trade scene did not finish at frame ${scene.engine.frame}.`);
  await writeFile(resolve(output, `${name}.rgba`), new Uint8Array(c.memory.buffer, c.kanto_framebuffer_ptr(), c.kanto_framebuffer_size()));
  await writeFile(resolve(output, `${name}.sav`), scene.engine.flash());
  await writeFile(resolve(output, `${name}-inputs.json`), JSON.stringify({ artifactId: scene.engine.manifest.id,
    sourceCommit: scene.engine.manifest.upstreamCommit, seed: sceneSeed, runs: inputs, startDigest,
    expectedDigest: scene.engine.digest(), flashSha256: createHash('sha256').update(scene.engine.flash()).digest('hex'),
    expectedFrames: scene.engine.frame, originalButtons: true, fixtureOnly: true }, null, 2) + '\n');
}
const results: Record<string, unknown>[] = [];
let seed = 100;
async function trade(name: string, species: number, level: number,
  options: { national?: boolean; heldItem?: number; egg?: boolean; mail?: boolean } = {}, evolved = species) {
  if (process.env.KANTO_EXCHANGE_CASE && process.env.KANTO_EXCHANGE_CASE !== name) return;
  const flashA = await fixture(++seed, 16, 5, { national: options.national });
  const flashB = await fixture(++seed, species, level, options, true);
  const beforeFlashA = flashA.slice(), beforeFlashB = flashB.slice();
  const a = await OriginalTradeCore.create(bytes, manifest, seed, flashA);
  const b = await OriginalTradeCore.create(peerBytes, peerManifest, seed + 1, flashB);
  try {
    connect(a, b);
    assert.equal(a.eligibility(0, 1), 0); assert.equal(b.eligibility(1, 0), 0);
    const beforeA = a.party(), beforeB = b.party();
    assert.notEqual(beforeA[0]!.trainerId, beforeB[1]!.trainerId, 'Qualification must use distinct original trainers.');
    const remainingA = a.monBytes(1), remainingB = b.monBytes(0);
    a.start(0, 1); b.start(1, 0);
    console.log(`${name}: running both original trade scenes...`);
    await finish(a, `${name}-a`, seed); await finish(b, `${name}-b`, seed + 1);
    const afterA = a.party(), afterB = b.party();
    assert.equal(afterA[0]!.species, evolved); assert.equal(afterB[1]!.species, beforeA[0]!.species);
    assert.equal(afterA[0]!.personality, beforeB[1]!.personality);
    assert.equal(afterB[1]!.personality, beforeA[0]!.personality);
    assert.equal(afterA[0]!.trainerId, beforeB[1]!.trainerId);
    assert.equal(afterA[0]!.friendship, options.egg ? 37 : 70);
    assert.equal(afterB[1]!.friendship, 70);
    assert.equal(afterA[0]!.isEgg, Boolean(options.egg));
    assert.equal(afterA[0]!.badEgg, false); assert.equal(afterB[1]!.badEgg, false);
    sameBytes(a.monBytes(1), remainingA, 'Unselected Pokemon A changed.');
    sameBytes(b.monBytes(0), remainingB, 'Unselected Pokemon B changed.');
    sameBytes(flashA, beforeFlashA, 'Source cartridge A was mutated.');
    sameBytes(flashB, beforeFlashB, 'Source cartridge B was mutated.');
    if (options.heldItem === item.KINGS_ROCK || (options.heldItem === item.METAL_COAT && evolved !== species))
      assert.equal(afterA[0]!.heldItem, 0, 'Original trade evolution did not consume its held item.');
    if (options.heldItem === item.EVERSTONE || (options.heldItem === item.METAL_COAT && evolved === species))
      assert.equal(afterA[0]!.heldItem, options.heldItem);
    if (name === 'learn-move') {
      const perishSong = await constant('moves.h', 'MOVE_PERISH_SONG');
      assert(!beforeB[1]!.moves.includes(perishSong));
      assert(afterA[0]!.moves.includes(perishSong), 'Original move-learning prompt did not apply the selected move.');
    }
    if (options.mail) {
      const c = debug(a), memory = new DataView(c.memory.buffer);
      const index = c.GetMonData2(c.gPlayerParty.value, 64);
      assert(index >= 0 && index < 6);
      const save = memory.getUint32(c.gSaveBlock1Ptr.value, true);
      assert.equal(memory.getUint16(save + 0x2cd0 + index * 36, true), 0x0201);
      assert.equal(memory.getUint8(save + 0x309c), 7);
    }
    assert.throws(() => a.packet(), { code: 'TRADE_PHASE_CHANGED' });
    for (const [side, scene] of [['a', a], ['b', b]] as const) {
      const reloaded = await OriginalTradeCore.create(side === 'a' ? bytes : peerBytes, side === 'a' ? manifest : peerManifest, 42, scene.engine.flash());
      try { sameBytes(reloaded.monBytes(0), scene.monBytes(0), 'Original save reload changed Pokemon 0.');
        sameBytes(reloaded.monBytes(1), scene.monBytes(1), 'Original save reload changed Pokemon 1.');
      } finally { reloaded.close(); }
      await writeFile(resolve(output, `${name}-${side}-party.bin`), Buffer.concat([scene.monBytes(0), scene.monBytes(1)]));
      const c = debug(scene), v = new DataView(c.memory.buffer);
      const save = v.getUint32(c.gSaveBlock1Ptr.value, true);
      await writeFile(resolve(output, `${name}-${side}-metadata.bin`), Buffer.concat([
        new Uint8Array(c.memory.buffer, save + 0x2cd0, 16 * 36),
        new Uint8Array(c.memory.buffer, save + 0x309c, 11),
        new Uint8Array(c.memory.buffer, save + 0x5f8, 52),
        new Uint8Array(c.memory.buffer, save + 0x3a18, 52),
        new Uint8Array(c.memory.buffer, v.getUint32(c.gSaveBlock2Ptr.value, true) + 0x18, 0x78),
      ]));
    }
    results.push({ name, framesA: a.engine.frame, framesB: b.engine.frame,
      receivedA: afterA[0], receivedB: afterB[1], originalScene: true, originalSaveReload: true,
      flashSha256A: createHash('sha256').update(a.engine.flash()).digest('hex'),
      flashSha256B: createHash('sha256').update(b.engine.flash()).digest('hex') });
  } finally { a.close(); b.close(); }
}

// Reject the game's last-mon / last-usable-mon cases, malformed peers and slots.
const singleA = await OriginalTradeCore.create(bytes, manifest, 1, originalSave);
const singleB = await OriginalTradeCore.create(bytes, manifest, 2, originalSave);
try { connect(singleA, singleB); assert.equal(singleA.eligibility(0, 0), 1);
  assert.throws(() => singleA.start(0, 0), { code: 'TRADE_NOT_ALLOWED' });
  assert.throws(() => singleA.monBytes(6), { code: 'INVALID_TRADE_SLOT' });
} finally { singleA.close(); singleB.close(); }
const two = await fixture(++seed);
const gatedA = await OriginalTradeCore.create(bytes, manifest, 1, two);
const gatedB = await OriginalTradeCore.create(bytes, manifest, 2, two);
try { connect(gatedA, gatedB); set(gatedA, 1, 57, 0); assert.equal(gatedA.eligibility(0, 1), 1);
  const corrupt = gatedB.packet(); corrupt[0] = 0;
  gatedA.receive(corrupt); assert(gatedA.eligibility(0, 1) < 0);
  const checksum = gatedB.packet(); checksum[40 + 28]! ^= 1; // Packet header + first original BoxPokemon checksum.
  gatedA.receive(checksum); assert(gatedA.eligibility(0, 1) < 0);
  assert.throws(() => gatedA.receive(new Uint8Array(0)), { code: 'INVALID_TRADE_PARTNER' });
} finally { gatedA.close(); gatedB.close(); }
await trade('ordinary', 16, 5);
await trade('mail-ribbons', 16, 5, { mail: true });
await trade('machamp', 67, 28, {}, 68);
await trade('everstone', 64, 28, { heldItem: item.EVERSTONE });
await trade('national-blocked', 123, 28, { heldItem: item.METAL_COAT });
await trade('national-enabled', 123, 28, { national: true, heldItem: item.METAL_COAT }, 212);
await trade('learn-move', 61, 35, { national: true, heldItem: item.KINGS_ROCK }, 186);
await trade('egg', 147, 5, { national: true, egg: true });
const report = { artifactId: manifest.id, version: manifest.version, peerArtifactId: peerManifest.id, peerVersion: peerManifest.version,
  sourceFlashSha256: createHash('sha256').update(originalSave).digest('hex'),
  peerSourceFlashSha256: createHash('sha256').update(peerSave).digest('hex'),
  fixtureConstruction: 'Original CreateMon/CreateEgg/SetMonData/TrySavingData, qualification only; no adventure-provenance claim.',
  lastMonRejected: true, lastUsableMonRejected: true, malformedPeerRejected: true, invalidPokemonChecksumRejected: true,
  distinctTrainerIdentities: true,
  cases: results, completeMatrix: results.length === 8, publicReleaseQualified: false, crossVersionQualified: crossVersion && results.length === 8,
  independentGbaReadback: false };
const reportName = ['exchange', ...(crossVersion ? [peerManifest.version] : []),
  ...(process.env.KANTO_EXCHANGE_CASE ? [process.env.KANTO_EXCHANGE_CASE] : []), 'report.json'].join('-');
await writeFile(resolve(directory, reportName), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ artifactId: manifest.id, cases: results.map(result => result.name),
  originalScenesAndReload: true, publicReleaseQualified: false }, null, 2));
