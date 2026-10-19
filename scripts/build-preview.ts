import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { previewCandidate } from './preview-candidate.ts';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint } from '../packages/engine/checkpoint.ts';

// An explicit static preview build. No application credentials, registry,
// user checkpoints, saves, API code or vendor tree enter the publish folder.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.KANTO_PREVIEW_OUTPUT??'build/netlify-preview');
if(!output.startsWith(resolve(root,'build')+'/'))throw new Error('Preview output must stay inside the project build directory.');
if(existsSync(output))throw new Error('Preserve retained preview output; choose a fresh KANTO_PREVIEW_OUTPUT.');
const bootstraps: { version: string; metadata: object; bytes: Uint8Array; checkpoint: Uint8Array; artifactName: string; checkpointName: string }[] = [];
for (const version of ['firered', 'leafgreen'] as const) {
  const directory = resolve(root, `build/game-source/${version}/${previewCandidate()}`);
  const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
  const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
  if (manifest.version !== version || manifest.abi !== 1 || manifest.status !== 'experimental'
    || createHash('sha256').update(bytes).digest('hex') !== manifest.wasmSha256)
    throw new Error(`Rebuild the matching experimental ${version} candidate before publishing the preview.`);
  const baseline = await createCheckpointBaseline(await WebAssembly.compile(bytes));
  const seed = randomBytes(4).readUInt32LE();
  const engine = await WasmEngine.create(bytes, manifest, seed);
  try {
    const digest = engine.digest();
    const checkpoint = encodeCheckpoint(engine.snapshot(), baseline, manifest.wasmSha256);
    const artifactName = `${manifest.wasmSha256}.wasm`;
    const checkpointName = `${createHash('sha256').update(checkpoint).digest('hex')}.checkpoint`;
    const prefix = `/preview-data/${version}/`;
    bootstraps.push({version, bytes, checkpoint, artifactName, checkpointName,
      metadata: { manifest, seed, digest, artifactUrl: prefix + artifactName, checkpointUrl: prefix + checkpointName } });
  } finally { engine.close(); }
}
await build({ configFile: false, root: resolve(root, 'apps/web'), publicDir: false, envDir: false, plugins: [react(), tailwindcss()],
  define: { __KANTO_STATIC_PREVIEW__: 'true', __KANTO_NETLIFY_ACCOUNTS__: process.env.KANTO_NETLIFY_ACCOUNTS === '1' ? 'true' : 'false' },
  build: { outDir: output, emptyOutDir: false, sourcemap: false,
    rollupOptions: { input: resolve(root, 'apps/web/engine-preview.html') } } });
let html = await readFile(resolve(output, 'engine-preview.html'), 'utf8');
html = html.replace('Kanto Online · Local engine preview', 'Kanto Online · Browser preview')
  .replace('Local development preview', 'Browser gameplay preview')
  .replace('Experimental local play.', 'Experimental browser play.');
await writeFile(resolve(output, 'index.html'), html);
await writeFile(resolve(output, 'engine-preview.html'), html);
for (const boot of bootstraps) {
  const directory = resolve(output, 'preview-data', boot.version);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, boot.artifactName), boot.bytes);
  await writeFile(resolve(directory, boot.checkpointName), boot.checkpoint);
  await writeFile(resolve(directory, 'boot.json'), JSON.stringify(boot.metadata));
}
await writeFile(resolve(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log(`Browser preview ready: ${output}. Account saves ${process.env.KANTO_NETLIFY_ACCOUNTS === '1' ? 'require the companion Netlify Function' : 'are disabled'}; multiplayer requires the persistent game server.`);
