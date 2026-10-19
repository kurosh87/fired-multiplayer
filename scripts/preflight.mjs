import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const disk = statfsSync(root);
const freeGiB = disk.bavail * disk.bsize / 2 ** 30;
const locate = name => {
  const result = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'kanto-preflight', name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};
const home = process.env.HOME ?? '';
const guard = resolve(home, '.local/bin/mini-build-guard');
const artifacts = ['firered','leafgreen'].map(version => ({ version,
  manifest: existsSync(resolve(root, 'engine/artifacts', `${version}.json`)),
  wasm: existsSync(resolve(root, 'engine/artifacts', `${version}.wasm`)),
}));
const report = {
  node: process.version, freeGiB: Number(freeGiB.toFixed(3)),
  resourcePolicy: existsSync(guard) ? { guard, minimumFreeGiB: 30, diskPermitsBuild: freeGiB >= 30 } : null,
  tools: Object.fromEntries(['clang','wasm-ld','arm-none-eabi-gcc','arm-none-eabi-as','make','supabase','psql'].map(name => [name,locate(name)])),
  dependenciesInstalled: existsSync(resolve(root, 'node_modules')),
  lockfilePresent: existsSync(resolve(root, 'package-lock.json')),
  upstreamSourcesPresent: existsSync(resolve(root, 'vendor/pokefirered/.kanto-source.json')),
  upstream: JSON.parse(readFileSync(resolve(root,'engine/upstream.lock.json'),'utf8')).firered,
  artifacts,
  accountConfiguration: Object.fromEntries(['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DATABASE_URL'].map(name => [name,Boolean(process.env[name])])),
  publicReleaseQualified: false,
};
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
if (!artifacts.every(item => item.manifest && item.wasm)) process.exitCode = 1;
