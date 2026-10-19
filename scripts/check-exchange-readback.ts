import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { OriginalTradeCore } from '../packages/trading/original-core.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0)
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types', ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
const arguments_ = process.argv.slice(2).filter(value => value !== '--reuse-reference');
const reuseReference = process.argv.includes('--reuse-reference');
const directory = resolve(arguments_[0] ?? 'build/game-source/firered');
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8'));
const peer = arguments_[1];
assert(!peer || ['firered', 'leafgreen'].includes(peer));
const reportFile = resolve(directory, peer ? `exchange-${peer}-report.json` : 'exchange-report.json');
const report = JSON.parse(await readFile(reportFile, 'utf8'));
assert.equal(report.artifactId, manifest.id);
assert.equal(report.completeMatrix, true);
const lock = JSON.parse(await readFile(resolve('engine/upstream.lock.json'), 'utf8'));
const output = resolve(directory, 'exchange-checks', ...(peer ? [peer] : []));
const proofs = [];
const artifacts = new Map<string, { manifest: any; bytes: Uint8Array }>();
for (const entry of report.cases) for (const side of ['a', 'b']) {
  if (process.env.KANTO_EXCHANGE_CASE && process.env.KANTO_EXCHANGE_CASE !== entry.name) continue;
  const version = side === 'a' ? report.version : report.peerVersion;
  const name = `${entry.name}-${side}`;
  const save = resolve(output, `${name}.sav`);
  const flashHash = createHash('sha256').update(await readFile(save)).digest('hex');
  assert.equal(flashHash, entry[side === 'a' ? 'flashSha256A' : 'flashSha256B']);
  const referenceDir = resolve('build/reference', `${report.version}-exchange`, ...(peer ? [peer] : []), name);
  let reused = false;
  if (reuseReference && existsSync(resolve(referenceDir, 'report.json'))) {
    const prior = JSON.parse(await readFile(resolve(referenceDir, 'report.json'), 'utf8'));
    reused = prior.restoredFlashSha256 === flashHash;
  }
  console.log(`${reused ? 'Checking retained original-game reference' : `Original ${version} readback`}: ${name}`);
  if (!reused) {
    const reference = spawnSync('python3', ['-B', 'scripts/run-reference.py', '--version', version,
      '--replay', 'tests/replays/continue-party.json', '--save', relative(process.cwd(), save),
      '--output', relative(process.cwd(), referenceDir)], { encoding: 'utf8' });
    if (reference.status !== 0) throw new Error(reference.stderr || reference.stdout || 'Independent game readback failed.');
  }
  const result = JSON.parse(await readFile(resolve(referenceDir, 'report.json'), 'utf8'));
  const baseline = JSON.parse(await readFile(resolve('build/baseline', `${version}.json`), 'utf8'));
  assert.equal(baseline.matchesOriginal, true);
  assert.equal(baseline.sourceCommit, lock.firered.commit);
  assert.equal(result.romSha1, baseline.sha1);
  assert.equal(result.referenceCommit, lock.mgbaReference.commit);
  assert.equal(result.restoredFlashSha256, flashHash);
  const last = result.points.at(-1);
  assert.equal(last.callback, 'CB2_UpdatePartyMenu', `${name}: ${JSON.stringify(last)}`);
  assert.equal(last.saveStatus, 1); assert.equal(last.partyCount, 2);
  assert.equal(last.isBadEgg, 0); assert(last.questLog < 2);
  const party = await readFile(resolve(referenceDir, 'party.bin'));
  const expectedParty = await readFile(resolve(output, `${name}-party.bin`));
  assert.equal(expectedParty.length, 200);
  assert.equal(Buffer.compare(party.subarray(0, 200), expectedParty), 0,
    `${name}: the original game changed or rejected a Pokemon.`);
  const block = await readFile(resolve(referenceDir, 'saveblock1.bin'));
  const block2 = await readFile(resolve(referenceDir, 'saveblock2.bin'));
  assert.equal(block.length, 0x3d68);
  assert.equal(block2.length, 0xf24);
  const metadata = Buffer.concat([block.subarray(0x2cd0, 0x2cd0 + 16 * 36),
    block.subarray(0x309c, 0x309c + 11), block.subarray(0x5f8, 0x5f8 + 52), block.subarray(0x3a18, 0x3a18 + 52),
    block2.subarray(0x18, 0x18 + 0x78)]);
  const expectedMetadata = await readFile(resolve(output, `${name}-metadata.bin`));
  // The first retained metadata fixture covered SaveBlock1 only. Newer
  // fixtures also capture the complete Pokedex structure in SaveBlock2.
  assert([691, 811].includes(expectedMetadata.length));
  assert.equal(Buffer.compare(metadata.subarray(0, expectedMetadata.length), expectedMetadata), 0,
    `${name}: original mail, ribbons or Pokedex flags differ.`);
  const artifactDirectory=version===manifest.version?directory:resolve(arguments_[2]??`build/game-source/${version}`);
  if (!artifacts.has(version)) artifacts.set(version, {
    manifest: JSON.parse(await readFile(resolve(artifactDirectory,'candidate.json'),'utf8')),
    bytes: new Uint8Array(await readFile(resolve(artifactDirectory,'candidate.wasm'))),
  });
  const artifact = artifacts.get(version)!;
  assert.equal(artifact.manifest.id, side === 'a' ? report.artifactId : report.peerArtifactId);
  const loaded = await OriginalTradeCore.create(artifact.bytes, artifact.manifest, 42, new Uint8Array(await readFile(save)));
  try {
    const c = loaded.engine.bindExtension<Record<string, any>>('kanto_exchange_abi_version', 1, ['GetSetPokedexFlag', 'SpeciesToNationalPokedexNum']);
    const pointer = new DataView(c.memory.buffer).getUint32(c.gSaveBlock2Ptr.value, true);
    assert.equal(Buffer.compare(block2.subarray(0x18, 0x90), Buffer.from(c.memory.buffer, pointer + 0x18, 0x78)), 0,
      `${name}: the original game's Pokedex differs from the original-C cartridge reload.`);
    for (const mon of loaded.party().filter(mon => !mon.isEgg)) {
      const national = c.SpeciesToNationalPokedexNum(mon.species);
      // Only the received Pokemon must be newly registered. Qualification
      // fixtures construct the unselected Pokemon without catching it.
      if (mon.slot === (side === 'a' ? 0 : 1)) {
        assert.equal(c.GetSetPokedexFlag(national, 0), 1, 'Received Pokemon was not seen.');
        assert.equal(c.GetSetPokedexFlag(national, 1), 1, 'Received Pokemon was not caught.');
      }
    }
  } finally { loaded.close(); }
  proofs.push({ name, version, flashSha256: flashHash, originalRomSha1: result.romSha1, referenceRunReused: reused,
    referenceCommit: result.referenceCommit, partyBytesIdentical: true, mailRibbonsAndSeenFlagsIdentical: true });
}
assert(proofs.length > 0);
if (!process.env.KANTO_EXCHANGE_CASE) {
  assert.equal(proofs.length, 16);
  await writeFile(reportFile, JSON.stringify({ ...report, independentGbaReadback: true, independentSaveProofs: proofs }, null, 2) + '\n');
}
console.log(JSON.stringify({ checkedSaves: proofs.length, originalGameAccepted: true, publicReleaseQualified: false }));
