import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import { FRAME_MILLISECONDS, type InputRun } from '../packages/protocol/index.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types',
    ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
}
const compress = promisify(gzip);
const directory = resolve(process.argv[2] ?? 'build/game-source/firered');
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
const replayPath = process.env.KANTO_ENGINE_REPLAY ?? (manifest.version === 'leafgreen'
  ? 'tests/replays/leafgreen-starter-rival-save.json' : 'tests/replays/starter-rival-save.json');
type Replay = { seed: number; sourceCommit: string; variants: string[]; expectedFrames: number;
  runs: InputRun[]; milestones: { frame: number; name: string }[] };
const replayText = await readFile(resolve(replayPath), 'utf8');
const replay = JSON.parse(replayText) as Replay;
assert.equal(replay.sourceCommit, manifest.upstreamCommit);
assert(replay.variants.includes(manifest.version));
assert.equal(replay.runs.reduce((sum, run) => sum + run.frames, 0), replay.expectedFrames);
const qualification = JSON.parse(await readFile(resolve(directory, 'gameplay-report.json'), 'utf8'));
assert.equal(qualification.artifactId, manifest.id, 'Run engine:check-gameplay for this artifact first.');
assert.equal(qualification.frames, replay.expectedFrames);
const milestones = replay.milestones.slice();
assert(milestones.length && milestones.at(-1)?.frame === replay.expectedFrames);
assert(milestones.every((point, index) => Number.isInteger(point.frame)
  && point.frame > (milestones[index - 1]?.frame ?? 0) && point.frame <= replay.expectedFrames));

function timing(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { samples: sorted.length, totalMs: values.reduce((a, b) => a + b, 0),
    p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1) ?? 0 };
}
const baselineStarted = performance.now();
const baseline = await createCheckpointBaseline(await WebAssembly.compile(bytes));
const baselineInitializationMs = performance.now() - baselineStarted;
const beforeMemory = process.memoryUsage();
const engine = await WasmEngine.create(bytes, manifest, replay.seed);
const afterBootMemory = process.memoryUsage();
const phases: Record<string, unknown>[] = [];
const checkpointMetrics: Record<string, unknown>[] = [];
let pending: InputRun[] = [];
let pendingFrames = 0;
let recordedFrame = 0;
let phaseStart = 0;
let phaseSteps: number[] = [];
let phaseDigests: number[] = [];
const allSteps: number[] = [], allDigests: number[] = [];
let linearMemoryBytes = 0;
let advanceCpuMicroseconds = 0, digestCpuMicroseconds = 0;
function flush() {
  if (!pendingFrames) return;
  let cpu = process.cpuUsage();
  let started = performance.now();
  engine.advance(pending);
  const stepMs = performance.now() - started;
  let spent = process.cpuUsage(cpu);
  advanceCpuMicroseconds += spent.user + spent.system;
  cpu = process.cpuUsage(); started = performance.now();
  engine.digest();
  const digestMs = performance.now() - started;
  spent = process.cpuUsage(cpu);
  digestCpuMicroseconds += spent.user + spent.system;
  phaseSteps.push(stepMs); allSteps.push(stepMs);
  phaseDigests.push(digestMs); allDigests.push(digestMs);
  pending = []; pendingFrames = 0;
}
async function checkpoint(name: string) {
  let started = performance.now();
  const snapshot = engine.snapshot();
  const copyMs = performance.now() - started;
  linearMemoryBytes = snapshot.byteLength;
  started = performance.now();
  const compressed = await compress(snapshot, { level: 1 });
  const gzipMs = performance.now() - started;
  started = performance.now();
  const packed = encodeCheckpoint(snapshot, baseline, manifest.wasmSha256);
  const encodeMs = performance.now() - started;
  started = performance.now();
  const packedCompressed = await compress(packed, { level: 1 });
  const packedGzipMs = performance.now() - started;
  started = performance.now();
  const decoded = decodeCheckpoint(packed, baseline, manifest.wasmSha256);
  const decodeMs = performance.now() - started;
  assert.deepEqual(decoded, snapshot, 'Packed checkpoint lost game memory.');
  checkpointMetrics.push({ name, frame: engine.frame, bytes: snapshot.byteLength,
    gzipBytes: compressed.byteLength, copyMs, gzipMs, packedBytes: packed.byteLength,
    packedGzipBytes: packedCompressed.byteLength, encodeMs, packedGzipMs, decodeMs,
    completeMemoryRoundTrip: true });
}
console.log(`Benchmarking ${replay.expectedFrames} ${manifest.version} gameplay frames with 16-frame verification batches...`);
try {
  const started = performance.now();
  for (const run of replay.runs) {
    assert(Number.isInteger(run.buttons) && run.buttons >= 0 && run.buttons <= 1023);
    assert(Number.isInteger(run.frames) && run.frames >= 1 && run.frames <= 60);
    let remaining = run.frames;
    while (remaining) {
      const next = milestones[0]!;
      const frames = Math.min(remaining, 16 - pendingFrames, next.frame - recordedFrame);
      assert(frames > 0);
      pending.push({ buttons: run.buttons, frames });
      pendingFrames += frames; recordedFrame += frames; remaining -= frames;
      if (pendingFrames === 16 || recordedFrame === next.frame) flush();
      if (recordedFrame === next.frame) {
        assert.equal(engine.frame, next.frame);
        phases.push({ through: next.name, startFrame: phaseStart, endFrame: next.frame,
          advance: timing(phaseSteps), digest: timing(phaseDigests) });
        if (next.frame >= 7571) await checkpoint(next.name);
        phaseStart = next.frame; phaseSteps = []; phaseDigests = [];
        milestones.shift();
      }
    }
  }
  const wallMs = performance.now() - started;
  assert.equal(engine.frame, replay.expectedFrames);
  assert.equal(milestones.length, 0);
  const finalDigest = engine.digest();
  // Tie the measured route to the independently checked gameplay run. This
  // excludes idle boot, invented state, and stale checkpoints from the result.
  const expected = await WasmEngine.create(bytes, manifest, replay.seed);
  try {
    expected.restore(new Uint8Array(await readFile(resolve(directory, 'gameplay.checkpoint'))));
    assert.equal(expected.frame, engine.frame);
    assert.equal(expected.digest(), finalDigest, 'Measured gameplay differs from the checked route.');
  } finally { expected.close(); }
  const advance = timing(allSteps), digest = timing(allDigests);
  const simulatedMs = replay.expectedFrames * FRAME_MILLISECONDS;
  const report = { artifactId: manifest.id, version: manifest.version, replay: replayPath,
    replaySha256: createHash('sha256').update(replayText).digest('hex'),
    machine: { platform: platform(), arch: arch(), cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length, node: process.versions.node },
    frames: engine.frame, finalDigest, batchFrames: 16, simulatedMs, wallMs,
    advance, digest, phases, checkpoints: checkpointMetrics,
    cpuMs: { advance: advanceCpuMicroseconds / 1000, digest: digestCpuMicroseconds / 1000 },
    memory: { linearMemoryBytes, artifactBaselineBytes: baseline.byteLength, baselineInitializationMs,
      rssIncreaseAtBoot: afterBootMemory.rss - beforeMemory.rss,
      arrayBufferIncreaseAtBoot: afterBootMemory.arrayBuffers - beforeMemory.arrayBuffers },
    linearExtrapolation: {
      sessions: 1000,
      cpuCoresForAdvanceAndDigest: (advanceCpuMicroseconds + digestCpuMicroseconds) / simulatedMs,
      linearMemoryGiB: linearMemoryBytes * 1000 / 1024 ** 3,
    },
    loadQualification: false, publicReleaseQualified: false,
    limitations: 'One sequential session on this development machine. Extrapolation excludes database, journal writes, sockets, concurrent scheduling, checkpoint CPU and deployment overhead. Not a 1,000-player load test or a hosting quote.' };
  await writeFile(resolve(directory, 'gameplay-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ artifactId: report.artifactId, frames: report.frames, wallMs,
    advance, digest, checkpoints: checkpointMetrics, linearExtrapolation: report.linearExtrapolation,
    loadQualification: false, limitations: report.limitations }, null, 2));
} finally { engine.close(); }
