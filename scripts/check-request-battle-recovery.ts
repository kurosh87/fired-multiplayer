import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { BattleConsolePool } from '../packages/battles/console-pool.ts';
import { BattleScreenEncoder, BattleScreenDecoder } from '../packages/battles/screen.ts';
import { battleWorkload } from './battle-workload.ts';
import type { BattleResult } from '../packages/battles/session.ts';

// Compute/recovery experiment only. It does not expose an HTTP handler, accept
// public controls, implement durable admission clocks or qualify Netlify load.
const guard = resolve(homedir(), '.local/bin/mini-build-guard');
if (existsSync(guard)) assert.equal(spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status, 0, 'Use scripts/run-local.py.');
const output = process.argv[2];
assert(output && /^build\/[a-z0-9-]+$/.test(output) && !existsSync(output), 'Choose a fresh evidence directory.');
await mkdir(output, { mode: 0o700 });
const hash = (bytes: Uint8Array | Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = Object.fromEntries(await Promise.all(['scripts/check-request-battle-recovery.ts', 'scripts/battle-workload.ts',
  'packages/battles/console-pool.ts', 'packages/battles/console-worker.ts', 'packages/battles/original-pair.ts',
  'packages/battles/original-core.ts', 'packages/battles/screen.ts', 'packages/engine/checkpoint.ts',
  'packages/engine/runtime.ts', 'packages/engine/private-worker-pool.ts', 'packages/engine/private-worker-transport.ts',
  'package-lock.json'].map(async path => [path, hash(await readFile(path))])));
const workload = await battleWorkload(), saveHashes = workload.saves.map(hash);
const requestFrames = 60, segments: Record<string, unknown>[] = [];
let points: [Buffer, Buffer] | undefined, digests: [string, string] | undefined, frame = 0;
let result: BattleResult | undefined;
const started = performance.now();
try {
  while (frame < workload.inputs.length) {
    // A newly terminated/recreated worker compiles its artifacts and rebuilds
    // baselines each time. No warm worker cache survives a segment boundary.
    const pool = new BattleConsolePool(1), begin = performance.now();
    try {
      const pair = points ? await pool.restore(workload.artifacts, frame, points) : await pool.create(workload.artifacts, workload.saves);
      const restoreMs = performance.now() - begin, startFrame = frame;
      if (digests) assert.deepEqual((await pair.progress()).digests, digests);
      const endFrame = Math.min(workload.inputs.length, frame + requestFrames);
      const encoders = [new BattleScreenEncoder(), new BattleScreenEncoder()];
      const decoders = [new BattleScreenDecoder(), new BattleScreenDecoder()];
      const packets: Buffer[][] = [[], []];
      let simulateMs = 0, screenMs = 0;
      while (frame < endFrame) {
        const buttons = workload.inputs[frame]!; let count = 1;
        while (count < 4 && frame + count < endFrame) {
          const next = workload.inputs[frame + count]!;
          if (next[0] !== buttons[0] || next[1] !== buttons[1]) break;
          count++;
        }
        let before = performance.now(); const decisions = await pair.advance(buttons, count); simulateMs += performance.now() - before;
        assert.equal(decisions.length, count); frame += count; assert.equal(pair.frame, frame);
        // A viewer receives only its own pixels. Neither checkpoint memory nor
        // either console's input/decision buffers belong in a response.
        if (frame % 4 === 0 || frame === endFrame) {
          before = performance.now(); const screens = await pair.screens(['a', 'b']);
          for (const [side, pixels] of screens.entries()) {
            const packet = encoders[side]!.encode(pixels, frame);
            if (packet) { decoders[side]!.apply(packet); packets[side]!.push(Buffer.from(packet)); }
            assert.equal(hash(decoders[side]!.pixels), hash(pixels));
          }
          screenMs += performance.now() - before;
        }
      }
      const before = performance.now(); points = await pair.checkpoint(); digests = (await pair.progress()).digests;
      const checkpointMs = performance.now() - before;
      result = pair.result();
      segments.push({ startFrame, endFrame: frame, restoreMs, simulateMs, screenMs, checkpointMs,
        compressedCheckpointBytes: points.map(point => point.length),
        screenCodecBytes: packets.map(items => items.reduce((sum, packet) => sum + packet.length, 0)),
        estimatedGzipScreenBytes: packets.map(items => gzipSync(Buffer.concat(items), { level: 3 }).length),
        computeMsBeforeTeardown: performance.now() - begin });
    } finally { await pool.close(); }
    if (segments.length % 30 === 0) console.log(JSON.stringify({ segments: segments.length, frame, totalFrames: workload.inputs.length }));
  }
  assert.deepEqual(digests, workload.report.finalDigests);
  assert.deepEqual(workload.report.final.map((side: { outcome: number }) => side.outcome), [1, 2]);
  assert.deepEqual(result, { winner: 'a', reason: 'finished' });
  assert.deepEqual(workload.saves.map(hash), saveHashes);
  await writeFile(resolve(output, 'private-final-a.checkpoint.gz'), points![0]);
  await writeFile(resolve(output, 'private-final-b.checkpoint.gz'), points![1]);
  const timing = (key: string) => {
    const values = segments.map(item => Number(item[key])).sort((a, b) => a - b);
    return { samples: values.length, p50Ms: values[Math.ceil(values.length * .5) - 1], p95Ms: values[Math.ceil(values.length * .95) - 1], maxMs: values.at(-1) };
  };
  const report = { checkedAt: new Date().toISOString(), sourceSha256, requestFrames, totalFrames: frame,
    freshWorkerSegments: segments.length, elapsedMs: performance.now() - started, restore: timing('restoreMs'),
    computeBeforeTeardown: timing('computeMsBeforeTeardown'), result, artifacts: workload.artifacts.map(item => ({ id: item.manifest.id, sha256: item.manifest.wasmSha256 })),
    finalDigests: digests, recordedOriginalMatchParity: true, checkpointParityAtEveryRestore: true,
    bothPrivateScreenDecodersMatch: true, originalCartridgesUnchanged: true, segments,
    scope: 'Local single-match compute/recovery experiment with recorded original-C fixtures. Each 60-frame segment uses a fresh worker. No hosted function, HTTP/database latency, client timing, input admission, audio, concurrency or capacity qualification.' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, freshWorkerSegments: segments.length, frames: frame, restore: report.restore, compute: report.computeBeforeTeardown, parity: true }));
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ error: String(error), frame, segments, sourceSha256 }, null, 2) + '\n');
  throw error;
}
