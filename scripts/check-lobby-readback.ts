import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OriginalTradeCore } from '../packages/trading/original-core.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0)
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types', ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);

const version = process.argv[2] ?? 'firered';
assert(['firered', 'leafgreen'].includes(version));
const directory = resolve(process.argv[3]??resolve('build/game-source',version));
const report = JSON.parse(await readFile(resolve(directory, 'lobby-report.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8'));
assert.equal(manifest.version,version);
assert.equal(report.artifactId, manifest.id);
const flash = new Uint8Array(await readFile(resolve(directory, 'lobby.sav')));
assert.equal(createHash('sha256').update(flash).digest('hex'), report.flashSha256);
const referenceDir = resolve('build/reference', `${version}-lobby-save`);
const reference = JSON.parse(await readFile(resolve(referenceDir, 'report.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve('engine/upstream.lock.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve('build/baseline', `${version}.json`), 'utf8'));
assert(baseline.matchesOriginal); assert.equal(baseline.sourceCommit, lock.firered.commit);
assert.equal(reference.romSha1, baseline.sha1);
assert.equal(reference.referenceCommit, lock.mgbaReference.commit);
assert.equal(reference.restoredFlashSha256, report.flashSha256);
const last = reference.points.at(-1);
assert.equal(last.callback, 'CB2_UpdatePartyMenu'); assert(last.questLog < 2);
assert.equal(last.saveStatus, 1); assert.equal(last.partyCount, report.party.length);
assert.equal(last.level, report.party[0].level); assert.equal(last.hp, report.party[0].hp); assert.equal(last.isBadEgg, 0);
const loaded = await OriginalTradeCore.create(new Uint8Array(await readFile(resolve(directory, 'candidate.wasm'))), manifest, 42, flash);
try {
  const party = await readFile(resolve(referenceDir, 'party.bin'));
  for (const mon of loaded.party()) assert.equal(Buffer.compare(loaded.monBytes(mon.slot), party.subarray(mon.slot * 100, (mon.slot + 1) * 100)), 0);
} finally { loaded.close(); }
await writeFile(resolve(directory, 'lobby-report.json'), JSON.stringify({ ...report, independentGbaReadback: true,
  independentSaveProof: { romSha1: reference.romSha1, referenceCommit: reference.referenceCommit, partyBytesIdentical: true } }, null, 2) + '\n');
console.log(JSON.stringify({ artifactId: manifest.id, originalGameAcceptedLobbySave: true, partyBytesIdentical: true }));
