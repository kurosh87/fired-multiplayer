import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EngineRegistry } from '../packages/engine/registry.ts';
import { gameVersion } from '../packages/protocol/index.ts';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  const result = spawnSync(guard, ['--',process.execPath,'--experimental-strip-types', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

type Replay = { seed: number; artifactId: string; scenario: string; runs: { buttons: number; frames: number; expectedDigest?: string }[] };
const version = gameVersion(process.argv[2]);
const path = process.argv[3];
if (!path) throw new Error('Usage: node --experimental-strip-types scripts/verify-engine.ts firered replay.json');
const replay = JSON.parse(await readFile(path, 'utf8')) as Replay;
const registry = new EngineRegistry();
await registry.load(resolve('engine/artifacts'), false);
if (registry.manifest(version).id !== replay.artifactId) throw new Error('Replay is pinned to a different artifact.');
if (!replay.runs.length || !replay.runs.some(run => run.expectedDigest)) throw new Error('Replay needs independently recorded reference checkpoints.');
const browserEquivalent = await registry.create(version, replay.seed);
const server = await registry.create(version, replay.seed);
let checkpoints = 0;
try {
  for (const run of replay.runs) {
    browserEquivalent.advance([run]); server.advance([run]);
    if (browserEquivalent.digest() !== server.digest()) throw new Error(`Determinism failed at frame ${server.frame}.`);
    if (run.expectedDigest && run.expectedDigest !== server.digest()) throw new Error(`Reference mismatch at frame ${server.frame}.`);
    if (run.expectedDigest) checkpoints++;
    const saved = server.snapshot();
    const digest = server.digest();
    server.restore(saved);
    if (digest !== server.digest()) throw new Error('Checkpoint round-trip changed simulation state.');
  }
  process.stdout.write(`${JSON.stringify({ artifactId: replay.artifactId, scenario: replay.scenario,
    frames: server.frame, checkpoints, headlessParity: true, browserParity: 'requires real-browser replay', publicQualified: false }, null, 2)}\n`);
} finally { browserEquivalent.close(); server.close(); }
