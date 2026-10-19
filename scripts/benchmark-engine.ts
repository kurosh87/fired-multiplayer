import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { EngineRegistry } from '../packages/engine/registry.ts';
import { FRAME_MILLISECONDS, gameVersion } from '../packages/protocol/index.ts';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  const result = spawnSync(guard, ['--',process.execPath,'--experimental-strip-types', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
const version = gameVersion(process.argv[2] ?? 'firered');
const frames = Number(process.argv[3] ?? 6000);
if (!Number.isInteger(frames) || frames < 60 || frames > 600000) throw new Error('Frame count must be between 60 and 600000.');
const registry = new EngineRegistry();
await registry.load(resolve('engine/artifacts'), false);
const beforeMemory = process.memoryUsage();
const engine = await registry.create(version, 123456);
const started = performance.now();
const beforeCpu = process.cpuUsage();
let remaining = frames;
while (remaining) { const batch = Math.min(60, remaining); engine.advance([{ buttons: 0, frames: batch }]); remaining -= batch; }
const elapsedMilliseconds = performance.now() - started;
const cpu = process.cpuUsage(beforeCpu);
const afterMemory = process.memoryUsage();
process.stdout.write(`${JSON.stringify({ artifactId: engine.manifest.id, scenario: 'idle-boot-only', frames,
  elapsedMilliseconds, simulatedFramesPerSecond: frames / elapsedMilliseconds * 1000,
  cpuMilliseconds: (cpu.user + cpu.system) / 1000,
  rssIncreaseBytes: afterMemory.rss - beforeMemory.rss,
  arrayBufferIncreaseBytes: afterMemory.arrayBuffers - beforeMemory.arrayBuffers,
  gameFramesPerSecond: 1000 / FRAME_MILLISECONDS,
  loadQualification: false,
  note: 'Idle boot is a smoke benchmark only. Use overworld, battle, journal, checkpoint, and mixed 1,000-player workloads before pricing.' },null,2)}\n`);
engine.close();
