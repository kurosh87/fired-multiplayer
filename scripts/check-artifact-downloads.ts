import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {get} from 'node:http';
import {createApp} from '../apps/server/src/app.ts';
import {gameArtifactUrl} from '../packages/engine/artifact-url.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use scripts/run-local.py.');
const tag=process.env.KANTO_DOWNLOAD_EVIDENCE_TAG;assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag),'Choose a fresh evidence tag.');
const output=`build/${tag}-report.json`;assert(!existsSync(output),'Preserve prior download evidence.');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const paths=['scripts/check-artifact-downloads.ts','tests/original-game-provider.ts',
  ...(await readdir('apps/server/src')).filter(n=>n.endsWith('.ts')).map(n=>`apps/server/src/${n}`),
  ...(await readdir('packages',{recursive:true})).filter(n=>n.endsWith('.ts')).map(n=>`packages/${n}`)];
const sourceSha256=Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])));
const registry=await originalGameProvider(false,true),cases:unknown[]=[];
const app=await createApp({origin:'http://fixture.invalid',engineDirectory:'unused-private-provider',publicRelease:false},{registry});
let observed:{path:string;count:number;buffers:Set<ArrayBufferLike>}|undefined;
app.addHook('onSend',async(request,_reply,payload)=>{
  if(observed&&request.url===observed.path){
    assert(Buffer.isBuffer(payload),'Update the payload-memory observer if the delivery mechanism changes.');
    observed.count++;observed.buffers.add(payload.buffer);
  }
  return payload;
});
try{
  const base=await app.listen({host:'127.0.0.1',port:0});
  for(const version of ['firered','leafgreen'] as const){
    const manifest=registry.manifest(version),bytes=registry.artifact(version),before=hash(bytes);
    for(const path of [gameArtifactUrl(version,manifest.wasmSha256),`/api/engines/${version}/artifact`]){
      const observation={path,count:0,buffers:new Set<ArrayBufferLike>()};observed=observation;
      await Promise.all(Array.from({length:8},async()=>{
        const response=await fetch(base+path);assert.equal(response.status,200);
        const body=new Uint8Array(await response.arrayBuffer());assert.equal(body.byteLength,bytes.byteLength);
        assert.equal(hash(body),manifest.wasmSha256);
      }));
      observed=undefined;assert.equal(observation.count,8);assert.equal(observation.buffers.size,1);
      const backingBytes=[...observation.buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0);
      assert(backingBytes<=bytes.byteLength+65536);
      cases.push({version,path,artifactId:manifest.id,artifactBytes:bytes.byteLength,concurrentDownloads:8,
        responsesVerified:8,uniqueResponseBackingBuffers:observation.buffers.size,responseBackingBytes:backingBytes,
        metricScope:'onSend Buffer backing allocations, not total process RSS or physical RAM'});
    }
    await new Promise<void>((resolve,reject)=>{
      let interrupted=false;
      const request=get(base+gameArtifactUrl(version,manifest.wasmSha256),response=>{
        response.once('data',()=>{interrupted=true;request.destroy();resolve();});
        response.on('error',error=>{if(!interrupted)reject(error);});
      });
      request.on('error',error=>{if(!interrupted)reject(error);});
      request.setTimeout(5000,()=>request.destroy(new Error('Aborted-download fixture timed out.')));
    });
    assert.equal((await fetch(base+'/healthz')).status,200);
    const after=await fetch(base+gameArtifactUrl(version,manifest.wasmSha256));
    assert.equal(hash(new Uint8Array(await after.arrayBuffer())),before);assert.equal(hash(bytes),before);
  }
  for(const [p,digest] of Object.entries(sourceSha256))assert.equal(hash(await readFile(p)),digest);
  await writeFile(output,JSON.stringify({sourceSha256,cases,realHttp:true,originalGameBytes:true,
    abortedPeerDoesNotCorruptArtifact:true,healthAfterAbort:true,totalRssMeasured:false,
    linuxKernelQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
  console.log(JSON.stringify({sharedArtifactDownloads:true,cases:cases.length,wireDigestsMatched:true,output}));
}finally{await app.close();}
