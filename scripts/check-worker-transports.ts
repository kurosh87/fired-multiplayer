import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrivateWorkerPool } from '../packages/engine/private-worker-pool.ts';
import { WasmEngine } from '../packages/engine/runtime.ts';
import { originalGameProvider } from '../tests/original-game-provider.ts';

const guard=resolve(process.env.HOME??'','.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)throw new Error('Use the shared build guard.');
const output='build/process-transport-smoke.json';assert(!existsSync(output),'Preserve retained transport evidence.');
const registry=await originalGameProvider(),cases=[];
for(const transport of ['thread','process'] as const)for(const version of ['firered','leafgreen'] as const){
  const manifest=registry.manifest(version),artifact={bytes:registry.artifact(version),manifest};
  const pool=new PrivateWorkerPool({url:new URL('../packages/engine/adventure-worker.ts',import.meta.url),name:'transport-smoke',prefix:'ADVENTURE',size:1,transport});
  const reference=await WasmEngine.create(artifact.bytes,manifest,12345);
  let lease=pool.acquire();
  try{
    await lease.install(manifest.wasmSha256,artifact);assert.equal((await lease.call<any>('create',{hash:manifest.wasmSha256,seed:12345})).digest,reference.digest());
    for(let batch=0;batch<20;batch++){
      const runs=[{buttons:batch===15?8:0,frames:60}];reference.advance(runs);
      const metadata=await lease.call<any>('advance',{runs});assert.equal(metadata.frame,reference.frame);assert.equal(metadata.digest,reference.digest());
    }
    const execution=await lease.call<any>('metrics');assert.equal(execution.transport,transport);
    if(transport==='process')assert.notEqual(execution.pid,process.pid);else assert.equal(execution.pid,process.pid);
    assert(execution.environmentKeys.every((key:string)=>key==='NODE_OPTIONS'));
    const point=await lease.call<any>('capture');
    for(const bytes of [point.checkpoint,point.flash]){assert(bytes instanceof Uint8Array);assert.equal(bytes.byteOffset,0);assert.equal(bytes.buffer.byteLength,bytes.byteLength);}
    assert.deepEqual(point.flash,reference.flash());await lease.close();lease=pool.acquire();
    await lease.install(manifest.wasmSha256,artifact);
    const restored=await lease.call<any>('create',{hash:manifest.wasmSha256,seed:12345,checkpoint:point.checkpoint});assert.equal(restored.frame,reference.frame);assert.equal(restored.digest,reference.digest());
    cases.push({transport,version,artifactId:manifest.id,frames:reference.frame,pid:execution.pid,apiPid:process.pid,
      inlineOriginalDigestsMatch:true,exactOwnedCheckpointAndFlashBuffers:true,compressedCheckpointRestore:true,environmentStripped:true,
      observedRssBytes:execution.memory.rss,rssScope:transport==='process'?'private child process':'shared API process; not per-worker RSS'});
  }finally{reference.close();await lease.close();await pool.close();}
}
await writeFile(output,JSON.stringify({cases,originalC:true,capacityBenchmark:false,containerLimitsQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
console.log(JSON.stringify({output,originalCTransportCases:cases.length}));
