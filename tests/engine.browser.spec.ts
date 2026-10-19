import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WasmEngine, type EngineManifest } from '../packages/engine/runtime.ts';
import { createCheckpointBaseline, encodeCheckpoint, decodeCheckpoint } from '../packages/engine/checkpoint.ts';
import type { InputBatch } from '../packages/protocol/index.ts';

test('original game runs in the browser worker with server replay parity', async ({ page }, info) => {
  const directory = resolve(process.env.KANTO_ENGINE_CANDIDATE ?? 'build/game-source/firered');
  const bytes = new Uint8Array(await readFile(resolve(directory, 'candidate.wasm')));
  const manifest = JSON.parse(await readFile(resolve(directory, 'candidate.json'), 'utf8')) as EngineManifest;
  const evidenceTag=process.env.KANTO_ENGINE_EVIDENCE_TAG;
  if(evidenceTag)expect(evidenceTag).toMatch(/^[a-z0-9-]{1,32}$/);
  const exchange = process.env.KANTO_ENGINE_EXCHANGE;
  const tradeMode=process.env.KANTO_ENGINE_TRADE_MODE==='1';
  const audioMode=process.env.KANTO_ENGINE_AUDIO==='1';
  if(tradeMode) expect(exchange,'Trade mode requires an exchange replay.').toBeTruthy();
  const lobby = process.env.KANTO_ENGINE_LOBBY;
  // A continuation starts at an already qualified checkpoint and carries the
  // complete new input segment, including its own restoration milestones.
  const continuation = process.env.KANTO_ENGINE_CONTINUATION;
  expect([exchange,lobby,continuation].filter(Boolean).length).toBeLessThanOrEqual(1);
  const scenario = exchange ?? lobby ?? continuation;
  const replay = JSON.parse(await readFile(resolve(scenario ? `${scenario}-inputs.json` : process.env.KANTO_ENGINE_REPLAY ?? 'tests/replays/new-game.json'), 'utf8')) as {
    seed: number; sourceCommit: string; expectedFrames: number; runs: { buttons: number; frames: number }[];
    artifactId?: string; startDigest?: string; expectedDigest?: string; flashSha256?: string;
    milestones?: { frame: number; name: string; restore?: boolean }[];
  };
  const engine = await WasmEngine.create(bytes, manifest, replay.seed);
  const baseline = await createCheckpointBaseline(await WebAssembly.compile(bytes));
  if (scenario) {
    expect(replay.artifactId).toBe(manifest.id);
    engine.restore(decodeCheckpoint(new Uint8Array(gunzipSync(await readFile(resolve(`${scenario}-start.checkpoint.gz`)))), baseline, manifest.wasmSha256));
    expect(engine.digest()).toBe(replay.startDigest);
  }
  let checkpoint = encodeCheckpoint(engine.snapshot(), baseline, manifest.wasmSha256);
  const bootDigest = engine.digest();
  let metadata = Buffer.from(JSON.stringify({ manifest, digest: bootDigest, seed: replay.seed, sequence: 0 }));
  const server = createServer((request, response) => {
    const body = request.url === '/core' ? bytes : request.url === '/checkpoint' ? checkpoint : metadata;
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type':
      request.url === '/meta' ? 'application/json' : 'application/octet-stream' });
    response.end(body);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const errors: string[] = [];
  let batches = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('reportEngineBatch', ({ batch, digest }: { batch: InputBatch; digest: string }) => {
    try {
      expect(batch.startFrame).toBe(engine.frame);
      expect(batch.sequence).toBe(batches);
      engine.advance(batch.runs);
      expect(engine.digest()).toBe(digest);
      batches++;
    } catch (error) { errors.push(String(error)); }
  });
  try {
    await page.goto('/');
    await page.context().grantPermissions(['local-network-access'],{origin:new URL(page.url()).origin});
    await page.setContent('<style>body{margin:0;background:#161b1a;display:grid;place-items:center;height:100vh}canvas{width:min(960px,100vw);image-rendering:pixelated}</style><canvas width="240" height="160"></canvas>');
    await page.evaluate(async ({origin,tradeMode,audioMode}) => {
      const [bytes, checkpoint, metadata] = await Promise.all([
        fetch(`${origin}/core`).then(r => r.arrayBuffer()),
        fetch(`${origin}/checkpoint`).then(r => r.arrayBuffer()),
        fetch(`${origin}/meta`).then(r => r.json()),
      ]);
      let worker = new Worker('/src/game.worker.ts', { type: 'module' });
      const canvas = document.querySelector('canvas')!;
      const context = canvas.getContext('2d')!;
      let frame = 0;
      const audioStats={packets:0,samples:0,nonSilent:0};
      (window as any).audioStats=audioStats;
      let fatal: string | undefined;
      let pending: { type: string; frame?: number; resolve: () => void; reject: (error: Error) => void } | undefined;
      const receive = ({ data }: MessageEvent) => {
        if(data.type==='booted'&&audioMode)worker.postMessage({type:'audio',enabled:true});
        if(data.type==='audio'){
          const samples=new Float32Array(data.samples);
          if(!audioMode||!samples.length||samples.length>5608||samples.length%1402!==0||!samples.every(value=>Number.isFinite(value)&&Math.abs(value)<=1)
            ||Math.abs(data.rate-41868.97789929369)>0.001||data.mixerRate!==41869)fatal='Invalid browser audio packet.';
          audioStats.packets++;audioStats.samples+=samples.length;if(samples.some(value=>value!==0))audioStats.nonSilent++;
        }
        if (data.type === 'frame') {
          frame = data.frame;
          context.putImageData(new ImageData(new Uint8ClampedArray(data.pixels), 240, 160), 0, 0);
        }
        if (data.type === 'batch') void (window as any).reportEngineBatch(data);
        if (data.type === 'error') { fatal = data.message; pending?.reject(new Error(fatal)); pending = undefined; }
        if (pending && pending.type === data.type && (pending.frame === undefined || frame >= pending.frame)) {
          pending.resolve(); pending = undefined;
        }
      };
      worker.onmessage = receive;
      const wait = (type: string, action: () => void, target?: number) => new Promise<void>((resolve, reject) => {
        if (fatal) { reject(new Error(fatal)); return; }
        pending = { type, frame: target, resolve, reject }; action();
      });
      await wait('booted', () => worker.postMessage({ type: 'boot', bytes, checkpoint,
        manifest: metadata.manifest, sessionId: 'local-engine-contract', seed: metadata.seed,
        sequence: metadata.sequence, digest: metadata.digest, ...(tradeMode?{mode:'trade'}:{}) }, [bytes, checkpoint]));
      worker.postMessage({ type: 'resume' });
      (window as any).engineLab = {
        async run(buttons: number, count: number) {
          for (let remaining = count; remaining > 0;) {
            const frames = Math.min(4, remaining);
            await wait('frame', () => worker.postMessage({ type: 'tick', buttons, frames }), frame + frames);
            remaining -= frames;
          }
          return frame;
        },
        async pause() { await wait('paused', () => worker.postMessage({ type: 'pause' })); return frame; },
        async attemptAfterDone() {
          worker.postMessage({type:'resume'});worker.postMessage({type:'tick',buttons:1,frames:4});
          await wait('paused',()=>worker.postMessage({type:'pause'}));return frame;
        },
        async restore() {
          const [bytes, checkpoint, metadata] = await Promise.all([
            fetch(`${origin}/core`).then(r => r.arrayBuffer()),
            fetch(`${origin}/checkpoint`).then(r => r.arrayBuffer()),
            fetch(`${origin}/meta`).then(r => r.json()),
          ]);
          worker.terminate();
          worker = new Worker('/src/game.worker.ts', { type: 'module' });
          worker.onmessage = receive;
          await wait('booted', () => worker.postMessage({ type: 'boot', bytes, checkpoint,
            manifest: metadata.manifest, sessionId: 'local-engine-contract', seed: metadata.seed,
            sequence: metadata.sequence, digest: metadata.digest, ...(tradeMode?{mode:'trade'}:{}) }, [bytes, checkpoint]));
          worker.postMessage({ type: 'resume' });
          return frame;
        },
      };
    }, {origin,tradeMode,audioMode});
    const run = (buttons: number, frames: number) => page.evaluate(
      ({ buttons, frames }) => (window as any).engineLab.run(buttons, frames), { buttons, frames });
    expect(replay.sourceCommit).toBe(manifest.upstreamCommit);
    let browserCheckpointRestore = false;
    const milestones: {frame:number;name:string;restore?:boolean}[] = lobby ? [{ frame: engine.frame + 30, name: 'lobby-return' }, { frame: replay.expectedFrames, name: 'lobby-complete' }]
      : exchange ? [{ frame: 600, name: 'trade-movie' },
      ...(replay.expectedFrames > 3416 ? [{ frame: 3400, name: 'move-menu' }] : []),
      { frame: replay.expectedFrames, name: 'trade-complete' }]
      : replay.milestones?.slice() ?? [{ frame: 900, name: 'intro' }, { frame: 1201, name: 'title' },
        { frame: 3385, name: 'oak' }, { frame: replay.expectedFrames, name: 'bedroom' }];
    for (const input of replay.runs) {
      const frame = await run(input.buttons, input.frames);
      if (milestones[0] && frame >= milestones[0].frame) {
        const milestone = milestones.shift()!;
        await page.screenshot({ path: `test-output/screenshots/${manifest.version}${evidenceTag?'-'+evidenceTag:''}-${info.project.name}-${milestone.name}.png` });
        if (milestone.restore === true || milestone.name === 'bedroom' || milestone.name === 'move-menu' || milestone.name === 'lobby-return') {
          const pausedFrame = await page.evaluate(() => (window as any).engineLab.pause());
          await expect.poll(() => engine.frame).toBe(pausedFrame);
          const digest = engine.digest();
          checkpoint = encodeCheckpoint(engine.snapshot(), baseline, manifest.wasmSha256);
          metadata = Buffer.from(JSON.stringify({ manifest, digest, seed: replay.seed, sequence: batches }));
          expect(await page.evaluate(() => (window as any).engineLab.restore())).toBe(pausedFrame);
          browserCheckpointRestore = true;
        }
      }
    }
    const frame = await page.evaluate(() => (window as any).engineLab.pause());
    expect(frame).toBe(replay.expectedFrames);
    if(audioMode){const stats=await page.evaluate(()=>(window as any).audioStats);expect(stats.packets).toBeGreaterThan(100);expect(stats.nonSilent).toBeGreaterThan(100);}
    if(tradeMode) expect(await page.evaluate(()=>(window as any).engineLab.attemptAfterDone())).toBe(frame);
    expect(milestones).toEqual([]);
    const colors = await page.evaluate(() => {
      const pixels = document.querySelector('canvas')!.getContext('2d')!.getImageData(0, 0, 240, 160).data;
      return new Set(new Uint32Array(pixels.buffer)).size;
    });
    expect(colors).toBeGreaterThan(16);
    await expect.poll(() => engine.frame).toBe(frame);
    if(replay.expectedDigest)expect(engine.digest()).toBe(replay.expectedDigest);
    expect(batches).toBeGreaterThan(lobby ? 4 : exchange ? 100 : 400);
    expect(errors).toEqual([]);
    expect(browserCheckpointRestore).toBe(true);
    if (scenario) {
      expect(engine.digest()).toBe(replay.expectedDigest);
      expect(engine.bindExtension<{ kanto_exchange_phase(): number }>('kanto_exchange_abi_version', 1, ['kanto_exchange_phase']).kanto_exchange_phase()).toBe(exchange ? 3 : 0);
      expect(Buffer.compare(Buffer.from(engine.flash()), await readFile(resolve(`${scenario}.sav`)))).toBe(0);
    }
    const proofPrefix = scenario ? `${resolve(scenario)}-worker-${info.project.name}`
      : resolve(directory, evidenceTag ? `route-${evidenceTag}-${info.project.name}` : 'route');
    if (scenario) await writeFile(`${proofPrefix}.checkpoint.gz`, gzipSync(encodeCheckpoint(engine.snapshot(), baseline, manifest.wasmSha256)));
    else await writeFile(`${proofPrefix}.checkpoint`, engine.snapshot());
    await writeFile(`${proofPrefix}-checkpoint.json`, JSON.stringify({ artifactId: manifest.id,
      frame, digest: engine.digest(), scenario: scenario ? basename(scenario) : basename(process.env.KANTO_ENGINE_REPLAY ?? 'new-game.json', '.json'), browserParity: true,
      browserCheckpointRestore, tradeMode, automaticStop:tradeMode, checkpointTransportBytes: checkpoint.byteLength,
      ...(audioMode?{audioPackets:await page.evaluate(()=>(window as any).audioStats)}:{}),
      independentGbaReference: false, publicQualified: false }, null, 2) + '\n');
    await info.attach('engine-parity.json', { body: JSON.stringify({ artifactId: manifest.id, frame,
      batches, actualWorkerParity: true, browserCheckpointRestore,
      checkpointTransportBytes: checkpoint.byteLength, independentGbaReference: false, publicQualified: false }),
      contentType: 'application/json' });
  } finally {
    engine.close();
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
});
