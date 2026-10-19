import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createServer, type Plugin } from 'vite';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint } from '../packages/engine/checkpoint.ts';
import {originalGameDirectory} from '../tests/original-game-provider.ts';
import { gameVersion, type GameVersion } from '../packages/protocol/index.ts';

// Explicit localhost development tool. It never installs candidates in the
// application registry, uses account credentials, or enables public play.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? 5174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Supply a port between 1024 and 65535.');
type Artifact = { bytes: Uint8Array; manifest: EngineManifest; baseline: Uint8Array };
const artifacts = new Map<GameVersion, Promise<Artifact>>();
const bootstraps = new Map<string, { artifact: Artifact; checkpoint: Buffer; expires: number }>();
async function artifact(version: GameVersion): Promise<Artifact> {
  let found = artifacts.get(version);
  if (!found) {
    found = (async () => {
      const directory = resolve(root,process.env.KANTO_AUDIO_PREVIEW==='1'?`build/game-source/${version}/audio-16`:originalGameDirectory(version));
      const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
      const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
      if (manifest.version !== version || manifest.abi !== 1
        || createHash('sha256').update(bytes).digest('hex') !== manifest.wasmSha256)
        throw new Error('Rebuild the matching candidate and manifest before previewing.');
      const module = await WebAssembly.compile(bytes);
      const baseline = await createCheckpointBaseline(module);
      return { bytes, manifest, baseline };
    })();
    artifacts.set(version, found);
    found.catch(() => { artifacts.delete(version); });
  }
  return found;
}
const preview: Plugin = {
  name: 'kanto-local-engine-preview',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/') { response.writeHead(302, { Location: '/engine-preview.html' }); response.end(); return; }
      if (!url.pathname.startsWith('/__engine-preview/')) { next(); return; }
      response.setHeader('Cache-Control', 'no-store');
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? '')
        || (request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin))
        || request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403); response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      void (async () => {
        const match = /^\/__engine-preview\/(firered|leafgreen)\/(boot|artifact|checkpoint)$/.exec(url.pathname);
        if (!match) { response.writeHead(404); response.end(); return; }
        const version = gameVersion(match[1]);
        const action = match[2];
        if (action === 'boot') {
          const loaded = await artifact(version);
          const seed = randomBytes(4).readUInt32LE();
          const engine = await WasmEngine.create(loaded.bytes, loaded.manifest, seed);
          try {
            const digest = engine.digest();
            const checkpoint = gzipSync(encodeCheckpoint(engine.snapshot(), loaded.baseline, loaded.manifest.wasmSha256), { level: 1 });
            const id = randomUUID();
            for (const [key, value] of bootstraps) if (value.expires <= Date.now()) bootstraps.delete(key);
            while (bootstraps.size >= 8) bootstraps.delete(bootstraps.keys().next().value!);
            bootstraps.set(id, { artifact: loaded, checkpoint, expires: Date.now() + 60_000 });
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ manifest: loaded.manifest, seed, digest,
              artifactUrl: `/__engine-preview/${version}/artifact?id=${id}`,
              checkpointUrl: `/__engine-preview/${version}/checkpoint?id=${id}` }));
          } finally { engine.close(); }
        } else {
          const boot = bootstraps.get(url.searchParams.get('id') ?? '');
          if (!boot || boot.expires <= Date.now() || boot.artifact.manifest.version !== version) {
            response.writeHead(410); response.end('Restart the local preview.'); return;
          }
          if (action === 'artifact') {
            response.setHeader('Content-Type', 'application/wasm'); response.end(boot.artifact.bytes);
          } else {
            response.setHeader('Content-Type', 'application/octet-stream');
            response.setHeader('Content-Encoding', 'gzip'); response.end(boot.checkpoint);
          }
        }
      })().catch(error => {
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'The candidate could not start.' }));
      });
    });
  },
};
const server = await createServer({ root: resolve(root, 'apps/web'), plugins: [preview],
  server: { host: '127.0.0.1', port, strictPort: true, open: false } });
await server.listen();
console.log(`Local engine preview: http://127.0.0.1:${port}/engine-preview.html`);
console.log('Experimental candidates; progress lasts only until reload. Accounts and multiplayer use the separate application.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true; await server.close(); process.exit(0);
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
