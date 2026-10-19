import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
if (existsSync(guard) && spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status !== 0) {
  process.exit(spawnSync(guard, ['--', process.execPath, '--experimental-strip-types',
    ...process.argv.slice(1)], { stdio: 'inherit' }).status ?? 1);
}
const version = process.argv[2] ?? 'firered';
if (!['firered', 'leafgreen'].includes(version)) throw new Error('Choose firered or leafgreen.');
const directory = resolve('build/game-source', version);
const bytes = await readFile(resolve(directory, 'candidate.wasm'));
const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.wasmSha256);
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const core = (await WebAssembly.instantiate(module, {})).exports as Record<string, any>;
const reference = JSON.parse(await readFile(resolve('build/reference', version, 'report.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve('build/baseline', `${version}.json`), 'utf8'));
assert.equal(reference.romSha1, baseline.sha1);
assert.equal(baseline.matchesOriginal, true);
const replay = JSON.parse(await readFile(resolve('tests/replays/new-game.json'), 'utf8')) as {
  seed: number; runs: { buttons: number; frames: number }[];
};
new Uint8Array(core.memory.buffer, core.kanto_flash_ptr(), core.kanto_flash_size()).fill(0xff);
assert.equal(core.kanto_boot(replay.seed, 0), 0);
const points: Record<string, unknown>[] = [];
const rgb555 = (pixels: Uint8Array, i: number) => (pixels[i]! >> 3)
  | ((pixels[i + 1]! >> 3) << 5) | ((pixels[i + 2]! >> 3) << 10);
for (const run of replay.runs) {
  for (let remaining = run.frames; remaining > 0;) {
    const start = core.kanto_frame();
    const next = reference.points.find((point: { frame: number }) => point.frame > start)?.frame ?? Infinity;
    const count = Math.min(remaining, next - start);
    assert.equal(core.kanto_step(run.buttons, count), 0);
    remaining -= count;
    const frame = core.kanto_frame();
    const point = reference.points.find((point: { frame: number }) => point.frame === frame);
    if (point) {
      const actual = new Uint8Array(core.memory.buffer, core.kanto_framebuffer_ptr(), core.kanto_framebuffer_size());
      const expected = new Uint8Array(await readFile(resolve('build/reference', version, `frame-${frame}.rgba`)));
      assert.equal(expected.length, actual.length);
      let differentPixels = 0;
      for (let i = 0; i < actual.length; i += 4) if (rgb555(actual, i) !== rgb555(expected, i)) differentPixels++;
      await writeFile(resolve(directory, `reference-frame-${frame}.rgba`), actual);
      points.push({ frame, originalCallback: point.callback, differentPixels,
        equalPixels: 240 * 160 - differentPixels, exact: differentPixels === 0 });
    }
  }
}
const report = { artifactId: manifest.id, originalRomSha1: baseline.sha1, referenceCommit: reference.referenceCommit,
  points, allCapturedFramesExact: points.every(point => point.exact), publicReleaseQualified: false };
await writeFile(resolve(directory, 'reference-comparison.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.allCapturedFramesExact) process.exitCode = 1;
