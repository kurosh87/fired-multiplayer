import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../apps/server/src/app.ts';
import {gameArtifactUrl} from '../packages/engine/artifact-url.ts';
import {downloadGameArtifact,prefetchGameArtifact} from '../apps/web/src/lib/game-artifact.ts';
import {artifactCacheFixture} from './artifact-cache-fixture.ts';

test('only a matching content-addressed game is immutable; manifests, legacy URLs, errors and private endpoints are not cached',async()=>{
  const fixture=artifactCacheFixture();
  const app=await createApp({origin:'http://fixture.invalid',engineDirectory:'unused-fixture',publicRelease:false},{registry:fixture.registry});
  try{
    const url=gameArtifactUrl('firered',fixture.manifest.wasmSha256);
    const asset=await app.inject(url);assert.equal(asset.statusCode,200);
    assert.equal(asset.headers['cache-control'],'public, max-age=31536000, immutable');
    assert.equal(asset.headers['content-type'],'application/wasm');assert.deepEqual(asset.rawPayload,Buffer.from(fixture.bytes));
    const legacy=await app.inject('/api/engines/firered/artifact');assert.deepEqual(legacy.rawPayload,Buffer.from(fixture.bytes));
    const discovery=await app.inject('/api/engines/firered/manifest');
    assert.equal(discovery.statusCode,200);assert.deepEqual(discovery.json(),{manifest:fixture.manifest,artifactUrl:url});
    for(const path of ['/api/engines/firered/manifest','/api/engines/firered/artifact',
      gameArtifactUrl('firered','0'.repeat(64)),gameArtifactUrl('leafgreen',fixture.manifest.wasmSha256),
      '/api/engines/firered/not-a-hash.wasm','/api/sessions/private-id/checkpoint','/api/profile']){
      const response=await app.inject(path);assert.equal(response.headers['cache-control'],'no-store',path);
    }
    assert.equal((await app.inject(gameArtifactUrl('firered','0'.repeat(64)))).statusCode,404);
  }finally{await app.close();}
});

test('prefetch verifies bytes and retries a corrupt cached response once with reload semantics',async t=>{
  const fixture=artifactCacheFixture(),path=gameArtifactUrl('firered',fixture.manifest.wasmSha256),calls:{url:string;init?:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const url=String(input);calls.push({url,init});
    if(url.endsWith('/manifest'))return Response.json({manifest:fixture.manifest,artifactUrl:path});
    return new Response(Uint8Array.from(calls.length===2?[1,2,3]:fixture.bytes).buffer);
  });
  const signal=new AbortController().signal;
  const result=await prefetchGameArtifact('http://fixture.invalid','firered',signal);
  assert.deepEqual(new Uint8Array(result.bytes),fixture.bytes);assert.equal(result.sha256,fixture.manifest.wasmSha256);
  assert.deepEqual(calls.map(c=>c.url),['http://fixture.invalid/api/engines/firered/manifest',`http://fixture.invalid${path}`,`http://fixture.invalid${path}`]);
  assert.equal(calls[1]!.init?.cache,undefined);assert.equal(calls[2]!.init?.cache,'reload');
  assert(calls.every(call=>call.init?.signal===signal&&!call.init.headers));
});

test('invalid discovery cannot redirect the browser download or claim that a different edition is valid',async t=>{
  const fixture=artifactCacheFixture(),path=gameArtifactUrl('firered',fixture.manifest.wasmSha256);
  let discovery:unknown,calls=0;
  t.mock.method(globalThis,'fetch',async(input:Parameters<typeof fetch>[0])=>{
    calls++;assert(String(input).endsWith('/manifest'));return Response.json(discovery);
  });
  for(discovery of [null,{}, {manifest:{...fixture.manifest,version:'leafgreen'},artifactUrl:path},
    {manifest:{...fixture.manifest,wasmSha256:'bad'},artifactUrl:path},
    {manifest:fixture.manifest,artifactUrl:'https://unrelated.invalid/game.wasm'}]){
    await assert.rejects(prefetchGameArtifact('http://fixture.invalid','firered',new AbortController().signal),/unavailable/);
  }
  assert.equal(calls,5);
});

test('integrity failure is bounded and aborts propagate without retrying failed network requests',async t=>{
  const fixture=artifactCacheFixture();let calls=0;
  const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(new Uint8Array([1,2,3]).buffer);});
  await assert.rejects(downloadGameArtifact('http://fixture.invalid','/game',fixture.manifest.wasmSha256,new AbortController().signal),/could not be verified/);
  assert.equal(calls,2);
  mock.mock.mockImplementation(async(_input:Parameters<typeof fetch>[0],init?:RequestInit)=>{calls++;init?.signal?.throwIfAborted();throw new Error('network fixture');});
  const abort=new AbortController();abort.abort();
  await assert.rejects(downloadGameArtifact('http://fixture.invalid','/game',fixture.manifest.wasmSha256,abort.signal),{name:'AbortError'});
  assert.equal(calls,2,'An already aborted download must not issue a network request.');
});

test('solo preview restarts reuse hash-verified Cache Storage and repair a corrupt entry',async t=>{
  const fixture=artifactCacheFixture(),path=`/preview-data/firered/${fixture.manifest.wasmSha256}.wasm`,stored=new Map<string,Response>();
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'caches');
  const cache={match:async(key:string)=>stored.get(key)?.clone(),put:async(key:string,value:Response)=>{stored.set(key,value);},
    delete:async(key:string)=>stored.delete(key),keys:async()=>[...stored.keys()].map(key=>new Request(key))};
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async()=>cache}});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'caches',descriptor);else Reflect.deleteProperty(globalThis,'caches');});
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(Uint8Array.from(fixture.bytes).buffer);});
  const load=()=>downloadGameArtifact('http://fixture.invalid',path,fixture.manifest.wasmSha256,new AbortController().signal);
  assert.deepEqual(new Uint8Array(await load()),fixture.bytes);assert.deepEqual(new Uint8Array(await load()),fixture.bytes);assert.equal(calls,1);
  stored.set('http://fixture.invalid'+path,new Response(new Uint8Array([1,2]).buffer));
  assert.deepEqual(new Uint8Array(await load()),fixture.bytes);assert.equal(calls,2);
});
