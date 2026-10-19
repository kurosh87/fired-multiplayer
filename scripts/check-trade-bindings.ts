import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EngineRegistry } from '../packages/engine/registry.ts';
import type { EngineManifest } from '../packages/engine/runtime.ts';
import type { CanonicalSave } from '../packages/trading/atomic-trade.ts';
import type { GameVersion } from '../packages/protocol/index.ts';
import {originalGameDirectory} from '../tests/original-game-provider.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0)
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types', ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
const artifacts = new Map<GameVersion, { bytes: Uint8Array; manifest: EngineManifest }>();
for (const version of ['firered', 'leafgreen'] as const) {
  const directory = resolve(originalGameDirectory(version));
  artifacts.set(version, { bytes: new Uint8Array(await readFile(resolve(directory, 'candidate.wasm'))),
    manifest: JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) });
}
// Explicit qualification-only artifact provider. No capability is changed and
// no candidate is installed in the application registry. The real registry
// binding still executes the original C loaders, metadata and eligibility.
const registry = new EngineRegistry();
registry.artifact = version => artifacts.get(version)!.bytes;
registry.manifest = version => artifacts.get(version)!.manifest;
async function cartridge(version: GameVersion, path: string, owner: string): Promise<CanonicalSave> {
  return { id: `${owner}-${version}`, ownerId: owner, version, revision: 1,
    flash: new Uint8Array(await readFile(resolve(originalGameDirectory(version),path))) };
}
const results = [];
for (const [aVersion, bVersion] of [['firered','firered'], ['leafgreen','leafgreen'], ['firered','leafgreen']] as const) {
  const a = await cartridge(aVersion, 'exchange-checks/ordinary-a.sav', 'a');
  const b = await cartridge(bVersion, 'exchange-checks/ordinary-b.sav', 'b');
  const originalA = a.flash.slice(), originalB = b.flash.slice();
  const partyA = await registry.lobbyParty(a.version, 0, a.flash);
  const partyB = await registry.lobbyParty(b.version, 0, b.flash);
  assert.equal(partyA.length, 2); assert.equal(partyB.length, 2);
  assert.equal(partyA[0]!.speciesName, 'PIDGEY');
  assert.equal(partyB[1]!.speciesName, 'BULBASAUR');
  assert.match(partyA[0]!.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await registry.tradeChecks(a, b, 0, 1), { a: 0, b: 0 });
  assert.deepEqual(a.flash, originalA); assert.deepEqual(b.flash, originalB);
  const singleA = await cartridge(aVersion, 'gameplay.sav', 'a');
  const singleB = await cartridge(bVersion, 'gameplay.sav', 'b');
  assert.deepEqual(await registry.tradeChecks(singleA, singleB, 0, 0), { a: 1, b: 1 });
  results.push({ a: artifacts.get(aVersion)!.manifest.id, b: artifacts.get(bVersion)!.manifest.id,
    metadataFromOriginalC: true, originalEligibility: true, lastPokemonRejected: true, sourceSavesUnchanged: true });
}
await writeFile(resolve('build/trade-bindings-report.json'), JSON.stringify({ fixtureCartridges: true,
  cases: results, publicReleaseQualified: false }, null, 2) + '\n');
console.log(JSON.stringify({ originalCBindingCases: results.length, lastPokemonRejected: true, publicReleaseQualified: false }));
