import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const version = process.argv[2] ?? 'firered';
if (!['firered', 'leafgreen'].includes(version)) throw new Error('Choose firered or leafgreen.');
const directory = resolve(process.argv[3]??resolve('build/game-source',version));
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8'));
assert.equal(manifest.version,version);
const gameplay = JSON.parse(await readFile(resolve(directory, 'gameplay-report.json'), 'utf8'));
const flash = await readFile(resolve(directory, 'gameplay.sav'));
const reference = JSON.parse(await readFile(resolve('build/reference', `${version}-save-readback`, 'report.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve('engine/upstream.lock.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve('build/baseline', `${version}.json`), 'utf8'));
assert.equal(gameplay.artifactId, manifest.id);
assert.equal(createHash('sha256').update(await readFile(resolve(directory, 'candidate.wasm'))).digest('hex'), manifest.wasmSha256);
assert.equal(flash.length, 128 * 1024);
assert.equal(createHash('sha256').update(flash).digest('hex'), gameplay.flashSha256);
assert.equal(reference.restoredFlashSha256, gameplay.flashSha256, 'Original GBA readback used a different save.');
assert.equal(baseline.sourceCommit, lock.firered.commit);
assert.equal(baseline.matchesOriginal, true);
assert.equal(reference.romSha1, baseline.sha1);
assert.equal(reference.referenceCommit, lock.mgbaReference.commit);
const last = reference.points.at(-1);
assert(last, 'Missing the original-game readback checkpoint.');
assert.equal(last.callback, 'CB2_UpdatePartyMenu', 'Open the original Pokemon menu to exercise its data/checksum checks.');
assert.equal(last.saveStatus, 1);
assert.equal(last.partyCount, 1);
assert.equal(last.level, gameplay.savedParty.level);
assert.equal(last.hp, gameplay.savedParty.hp);
assert.equal(last.isBadEgg, 0, 'Original game rejected the encrypted Pokemon data.');
assert(last.questLog < 2, 'Original quest-log playback has not returned to the saved scene.');
assert.equal(last.mapGroup, 4);
assert.equal(last.mapNumber, 3);
const proof = { originalRomSha1: reference.romSha1, referenceCommit: reference.referenceCommit,
  flashSha256: gameplay.flashSha256, originalPartyMenu: true, originalPokemonChecksumAccepted: true };
await writeFile(resolve(directory, 'gameplay-report.json'), JSON.stringify({ ...gameplay,
  independentGbaReadback: true, independentSaveProof: proof }, null, 2) + '\n');
console.log(JSON.stringify({ artifactId: manifest.id, independentGbaReadback: true,
  proof, publicReleaseQualified: false }, null, 2));
