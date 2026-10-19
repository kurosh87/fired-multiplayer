import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = resolve(process.env.HOME ?? '', '.local/bin/mini-build-guard');
const npm = process.env.npm_execpath;
if (existsSync(guard)) {
  const owned = spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status === 0;
  if (!owned) {
    const result = spawnSync(guard, ['--', process.execPath, fileURLToPath(import.meta.url)], { cwd: root, stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }
}
const result = npm
  ? spawnSync(process.execPath, [npm, 'install', '--ignore-scripts'], { cwd: root, stdio: 'inherit' })
  : spawnSync('npm', ['install', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
