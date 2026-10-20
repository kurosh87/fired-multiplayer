import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const output = resolve('build/battle-test');
if (existsSync(output)) await rename(output, resolve(`build/battle-test-retained-${Date.now()}`));
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['apps/web/src/battle-test.tsx'],
  outdir: output,
  entryNames: 'battle-test',
  assetNames: 'assets/[name]-[hash]',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  loader: { '.css': 'css', '.woff2': 'file', '.woff': 'file', '.png': 'file', '.jpg': 'file', '.svg': 'file' },
  define: {
    'import.meta.env.VITE_ACCOUNT_PROVIDER': JSON.stringify('better-auth'),
    'import.meta.env.VITE_BATTLE_TRANSPORT': JSON.stringify('http'),
    'import.meta.env.VITE_API_URL': JSON.stringify('')
  },
  logLevel: 'info'
});
await copyFile('apps/web/battle-test.html', resolve(output, 'index.html'));
assert(existsSync(resolve(output, 'battle-test.js')), 'The battle test page did not build.');
assert(existsSync(resolve(output, 'index.html')), 'The battle test HTML is missing.');
console.log(JSON.stringify({ output, testOnly: true }));
