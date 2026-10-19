import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { chromium, expect } from '@playwright/test';

const guard = resolve(homedir(), '.local/bin/mini-build-guard');
if (existsSync(guard)) assert.equal(spawnSync(guard, ['--is-owned'], { stdio: 'ignore' }).status, 0, 'Use scripts/run-local.py.');
const output = process.argv[2];
assert(output && /^build\/[a-z0-9-]+$/.test(output) && !existsSync(output), 'Choose a fresh build output.');
await mkdir(output);
const bundle = resolve(output, 'web');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((request, response) => {
  void (async () => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    if (pathname === '/api/cloud/auth/get-session') {
      response.setHeader('Content-Type', 'application/json'); response.end('null'); return;
    }
    if (pathname === '/api/status') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ protocol: 1, accountsConfigured: true, publicReleaseReady: false,
        engines: ['firered', 'leafgreen'].map(version => ({ version, available: false, reason: 'Bundle check only' })),
        multiplayer: { lobby: false, battles: false, trading: false }, capacity: { target: 1000, qualified: false } })); return;
    }
    if (pathname !== '/' && !/^\/assets\/[\w.-]+$/.test(pathname)) { response.writeHead(404); response.end(); return; }
    const file = resolve(bundle, pathname === '/' ? 'index.html' : pathname.slice(1));
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store'); response.end(await readFile(file));
  })().catch(() => { response.writeHead(404); response.end(); });
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await build({ root: resolve('apps/web'), configFile: resolve('apps/web/vite.config.ts'),
    define: { 'import.meta.env.VITE_ACCOUNT_PROVIDER': JSON.stringify('better-auth'), 'import.meta.env.VITE_API_URL': JSON.stringify(origin) },
    build: { outDir: bundle, emptyOutDir: false, sourcemap: false, manifest: true } });
  type Chunk = { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean };
  const manifest: Record<string, Chunk> = JSON.parse(await readFile(resolve(bundle, '.vite/manifest.json'), 'utf8'));
  const entry = Object.entries(manifest).find(([, chunk]) => chunk.isEntry); assert(entry);
  const initial = new Set<string>();
  function visit(name: string) { if (initial.has(name)) return; initial.add(name); for (const item of manifest[name]!.imports ?? []) visit(item); }
  visit(entry[0]);
  const deferred = ['src/game.tsx', 'src/lobby.tsx', 'src/battle.tsx'].map(name => {
    assert(manifest[name], `${name} must be a separate chunk`); assert(!initial.has(name));
    return { name, file: manifest[name]!.file };
  });
  const assets = await Promise.all([...initial].map(async name => {
    const file = manifest[name]!.file, bytes = await readFile(resolve(bundle, file));
    return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  browser = await chromium.launch({ executablePath: process.env.KANTO_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const results = [];
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
    const context = await browser.newContext({ viewport, isMobile: name === 'mobile', hasTouch: name === 'mobile' });
    const page = await context.newPage(), errors: string[] = [], requested = new Set<string>();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requested.add(new URL(request.url()).pathname.slice(1)));
    let release: (() => void) | undefined, failed = false;
    const held = new Promise<void>(done => { release = done; });
    const lobby = deferred.find(item => item.name === 'src/lobby.tsx')!;
    await page.route(origin + '/' + lobby.file, async route => {
      if (!failed) { failed = true; await held; await route.abort('failed'); } else await route.continue();
    });
    try {
      await page.goto(origin); await expect(page.getByRole('heading', { name: 'FireRed', exact: true })).toBeVisible();
      assert(deferred.every(item => !requested.has(item.file)), 'Initial page must not download play screens');
      await page.getByRole('button', { name: 'Online lobby', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Opening online lobby');
      assert(requested.has(lobby.file)); release!();
      await expect(page.getByRole('alert')).toContainText('Check your connection');
      assert(deferred.filter(item => item !== lobby).every(item => !requested.has(item.file)));
      await page.screenshot({ path: resolve(output, `${name}-chunk-recovery.png`), fullPage: true });
      await page.getByRole('button', { name: 'Reload page', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'FireRed', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Online lobby', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'The online lobby is being built' })).toBeVisible();
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
      results.push({ viewport: name, initialPlayScreensNotRequested: true, loadingStatusVisible: true,
        failedDownloadShowsRecovery: true, reloadAndRetryPassed: true, noBrowserErrors: true, noHorizontalOverflow: true });
    } catch (error) {
      await writeFile(resolve(output, `${name}-failure.json`), JSON.stringify({ error: String(error), errors, text: await page.locator('body').innerText() }, null, 2));
      throw error;
    } finally { release!(); await context.close(); }
  }
  const report = { checkedAt: new Date().toISOString(), initialJavaScript: assets, deferredScreens: deferred,
    initialBytes: assets.reduce((sum, item) => sum + item.bytes, 0), initialGzipBytes: assets.reduce((sum, item) => sum + item.gzipBytes, 0), results,
    scope: 'Built main UI with unauthenticated account/status fixtures. No hosted gameplay or device FPS claim.' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser?.close(); await new Promise<void>(done => server.close(() => done())); }
