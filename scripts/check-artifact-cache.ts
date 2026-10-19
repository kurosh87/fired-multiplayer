import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {chromium} from '@playwright/test';
import {createApp} from '../apps/server/src/app.ts';
import {gameArtifactUrl} from '../packages/engine/artifact-url.ts';
import {artifactCacheFixture} from '../tests/artifact-cache-fixture.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const tag=process.env.KANTO_ARTIFACT_CACHE_EVIDENCE_TAG;assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag),'Choose a fresh cache evidence tag.');
const reportPath=`build/${tag}-report.json`;assert(!existsSync(reportPath),'Preserve cache evidence.');
const original=process.env.KANTO_CACHE_ORIGINAL_GAME==='1',version=process.env.KANTO_CACHE_VERSION??'firered';
assert(version==='firered'||version==='leafgreen');
const registry=original?await originalGameProvider(false,true):artifactCacheFixture().registry;
const manifest=registry.manifest(version),asset=gameArtifactUrl(version,manifest.wasmSha256),counts:Record<string,number>={};
const sources=['scripts/check-artifact-cache.ts','apps/web/src/lib/game-artifact.ts','tests/artifact-cache-fixture.ts','tests/fixture-engine.ts','tests/original-game-provider.ts','apps/server/src/app.ts','packages/engine/artifact-url.ts'];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const pins=Object.fromEntries(await Promise.all(sources.map(async path=>[path,hash(await readFile(path))])));
const app=await createApp({origin:'http://fixture.invalid',engineDirectory:'unused-fixture',publicRelease:false},{registry});
app.addHook('onRequest',async request=>{counts[request.url]=(counts[request.url]??0)+1;});
app.get('/cache-qualification',async(_request,reply)=>reply.type('text/html').send('<!doctype html><title>Private cache qualification</title>'));
const loader=stripTypeScriptTypes(await readFile('apps/web/src/lib/game-artifact.ts','utf8'))
  .replace('../../../../packages/engine/artifact-url.ts','/cache-artifact-url.js');
app.get('/cache-loader.js',async(_request,reply)=>reply.type('text/javascript').send(loader));
app.get('/cache-artifact-url.js',async(_request,reply)=>reply.type('text/javascript').send(stripTypeScriptTypes(await readFile('packages/engine/artifact-url.ts','utf8'))));
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
  const base=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const page=await browser.newPage();await page.goto(`${base}/cache-qualification`);
  // No request routing or service worker: Chromium's normal HTTP cache is active.
  const observations=await page.evaluate(async paths=>{
    const results=[];
    for(const path of paths)for(let attempt=0;attempt<2;attempt++){
      const response=await fetch(path),bytes=await response.arrayBuffer();
      const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
      results.push({path,attempt,status:response.status,cacheControl:response.headers.get('cache-control'),bytes:bytes.byteLength,sha256:sha});
    }
    const timing=performance.getEntriesByType('resource').filter(e=>e.name.endsWith(paths[0]!)).map(e=>{
      const resource=e as PerformanceResourceTiming;return {transferSize:resource.transferSize,encodedBodySize:resource.encodedBodySize};
    });
    return {results,timing};
  },[asset,`/api/engines/${version}/manifest`,`/api/engines/${version}/artifact`,gameArtifactUrl(version,'0'.repeat(64)),'/api/profile']);
  for(const path of [`/api/engines/${version}/manifest`,`/api/engines/${version}/artifact`,gameArtifactUrl(version,'0'.repeat(64)),'/api/profile'])assert.equal(counts[path],2,path);
  const cached=observations.results.filter(r=>r.path===asset);assert(cached.every(r=>r.status===200&&r.sha256===manifest.wasmSha256));
  assert.equal(observations.timing.length,2);assert(observations.timing[0]!.transferSize>0);
  const rawHttpRequests=counts[asset]!;
  const applicationCache=await page.evaluate(async({asset,sha256})=>{
    const loaderUrl='/cache-loader.js';
    const {downloadGameArtifact,GAME_ARTIFACT_CACHE}=await import(loaderUrl);
    const store=await caches.open(GAME_ARTIFACT_CACHE);await store.delete(location.origin+asset);
    const result=[];
    for(let i=0;i<2;i++){
      performance.clearResourceTimings();
      const bytes=await downloadGameArtifact(location.origin,asset,sha256,new AbortController().signal);
      result.push({bytes:bytes.byteLength,networkFetches:performance.getEntriesByType('resource').filter(e=>e.name.endsWith(asset)).length});
    }
    await store.put(location.origin+asset,new Response(new Uint8Array([1,2,3])));
    const healed=await downloadGameArtifact(location.origin,asset,sha256,new AbortController().signal);
    const poisonedResponseRecovered=healed.byteLength===result[0]!.bytes;
    for(let i=1;i<=5;i++)await store.put(location.origin+asset.replace(sha256,String(i).repeat(64)),new Response(new Uint8Array([i])));
    await store.delete(location.origin+asset);
    await downloadGameArtifact(location.origin,asset,sha256,new AbortController().signal);
    const storedKeys=(await store.keys()).map(key=>key.url);
    const descriptor=Object.getOwnPropertyDescriptor(window,'caches');
    let storageFailureFallsBack=false;
    try{
      Object.defineProperty(window,'caches',{configurable:true,get(){throw new DOMException('fixture storage unavailable','SecurityError');}});
      const uncached=await downloadGameArtifact(location.origin,asset,sha256,new AbortController().signal);
      storageFailureFallsBack=uncached.byteLength===healed.byteLength;
    }finally{
      if(descriptor)Object.defineProperty(window,'caches',descriptor);else Reflect.deleteProperty(window,'caches');
    }
    return {result,poisonedResponseRecovered,storageFailureFallsBack,storedKeys};
  },{asset,sha256:manifest.wasmSha256});
  assert.equal(applicationCache.result[1]!.networkFetches,0);assert(applicationCache.poisonedResponseRecovered);
  assert.equal(applicationCache.result[0]!.bytes,registry.artifact(version).byteLength);
  assert.equal(applicationCache.storedKeys.length,4);assert(applicationCache.storageFailureFallsBack);
  for(const [path,digest] of Object.entries(pins))assert.equal(hash(await readFile(path)),digest);
  await writeFile(reportPath,JSON.stringify({sourceSha256:pins,arithmeticFixture:!original,originalGameBytes:original,version,artifactId:manifest.id,realChromiumHttpCache:true,
    requestInterceptionUsed:false,serviceWorkerUsed:false,rawHttpGameBackendRequests:rawHttpRequests,applicationCache,
    applicationSecondDownloadNetworkFetches:0,otherEndpointsRequestedTwice:true,
    cachedGameSha256:manifest.wasmSha256,observations,hostedCdnQualified:false,physicalDevicesQualified:false,
    publicReleaseQualified:false},null,2)+'\n');
  console.log(JSON.stringify({artifactCache:true,rawHttpRequests,applicationSecondDownloadNetworkFetches:0,report:reportPath}));
}finally{await browser?.close();await app.close();}
