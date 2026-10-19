import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import type {Socket} from 'node:net';
import {cpus,homedir,platform,arch} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import WebSocket,{WebSocketServer} from 'ws';
import {BattleConsolePool,type BattleConsole} from '../packages/battles/console-pool.ts';
import {BattleScreenEncoder,BattleScreenDecoder} from '../packages/battles/screen.ts';
import {FRAME_MILLISECONDS} from '../packages/protocol/index.ts';
import {battleWorkload} from './battle-workload.ts';
import {WorkerResourceSampler} from './worker-resource-sampler.ts';
import {privateWorkerTransport} from '../packages/engine/private-worker-transport.ts';

const guard=join(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)throw new Error('Use the shared build guard.');
const transport=privateWorkerTransport(),evidenceTag=process.env.KANTO_BENCH_EVIDENCE_TAG;
if(evidenceTag)assert(/^[a-z0-9-]{1,40}$/.test(evidenceTag));
const reportPath=`build/${evidenceTag?evidenceTag+'-':''}battle-benchmark.json`;
assert(!existsSync(reportPath),'Preserve retained benchmark evidence; choose a fresh KANTO_BENCH_EVIDENCE_TAG.');
const counts=(process.env.KANTO_BATTLE_BENCH_CONCURRENCY??'1,2').split(',').map(Number);
assert(counts.length<=4&&counts.every(count=>Number.isInteger(count)&&count>=1&&count<=8));
const workload=await battleWorkload();
const timing=(values:number[])=>{
  const sorted=values.slice().sort((a,b)=>a-b),at=(p:number)=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??0;
  return {samples:sorted.length,totalMs:values.reduce((a,b)=>a+b,0),p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:sorted.at(-1)??0};
};
const hash=(bytes:Uint8Array|Uint8ClampedArray)=>createHash('sha256').update(bytes).digest('hex');
type Viewer={socket:WebSocket;client:WebSocket;tcp:Socket;baseline:number;encoder:BattleScreenEncoder;decoder:BattleScreenDecoder;
  sent:number;received:number;codecBytes:number;lastHash:string};
const sourceSha256=Object.fromEntries(await Promise.all(['scripts/benchmark-battles.ts','scripts/battle-workload.ts',
  'packages/battles/console-pool.ts','packages/battles/console-worker.ts','packages/battles/original-pair.ts',
  'packages/battles/screen.ts','packages/engine/private-worker-pool.ts','packages/engine/private-worker-transport.ts','packages/engine/private-worker-process.ts','packages/engine/runtime.ts','scripts/worker-resource-sampler.ts','package-lock.json'].map(async path=>[path,hash(await readFile(path))])));
const results=[];
for(const count of counts){
  const resourceSampler=new WorkerResourceSampler();
  const pool=new BattleConsolePool(count),http=createServer(),server=new WebSocketServer({server:http,
    maxPayload:160*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,
      zlibDeflateOptions:{level:3},concurrencyLimit:4}});
  const accepted=new Map<string,{socket:WebSocket;tcp:Socket}>(),viewers:Viewer[]=[],pairs:BattleConsole[]=[];
  server.on('connection',(socket,request)=>accepted.set(request.url!,{socket,tcp:request.socket}));
  const advanceMs:number[]=[],progressMs:number[]=[],checkpointMs:number[]=[],screenMs:number[]=[],sendMs:number[]=[];
  let peakRss=process.memoryUsage().rss;
  try{
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));const address=http.address();assert(address&&typeof address!=='string');
    const beforeBoot=process.memoryUsage(),bootStart=performance.now();
    pairs.push(...await Promise.all(Array.from({length:count},()=>pool.create(workload.artifacts,workload.saves))));
    const bootMs=performance.now()-bootStart,afterBoot=process.memoryUsage();
    const initialPoints=await Promise.all(pairs.map(pair=>pair.checkpoint()));
    const workerBefore=await Promise.all(pairs.map(pair=>pair.metrics()));
    for(const metrics of workerBefore)assert(metrics.environmentKeys.every(key=>key==='NODE_OPTIONS'));
    for(let index=0;index<count*2;index++){
      const path=`/${index}`,client=new WebSocket(`ws://127.0.0.1:${address.port}${path}`,{perMessageDeflate:true,maxPayload:160*1024});
      await new Promise<void>((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
      const connection=accepted.get(path)!;assert(connection.socket.extensions.includes('permessage-deflate'));
      const viewer:Viewer={...connection,client,baseline:connection.tcp.bytesWritten,encoder:new BattleScreenEncoder(),decoder:new BattleScreenDecoder(),
        sent:0,received:0,codecBytes:0,lastHash:''};
      client.on('message',(raw,isBinary)=>{assert(isBinary);viewer.decoder.apply(new Uint8Array(raw as Buffer));viewer.received++;});viewers.push(viewer);
    }
    await resourceSampler.start();
    const cpuBefore=process.cpuUsage(),mainCpuBefore=process.threadCpuUsage?.(),lag=monitorEventLoopDelay({resolution:10});lag.enable();
    const started=performance.now(),points=initialPoints.slice(),pointFrames=Array(count).fill(0),pointDigests:string[][]=[];
    const simulate=async(pair:BattleConsole,index:number)=>{
      let cursor=0,pending=0,held:[number,number]=[0,0],lastScreen=-4,lastCheckpoint=0,latestDigests:[string,string]|undefined;
      const progress=async()=>{if(!pending)return;const start=performance.now();latestDigests=(await pair.progress()).digests;progressMs.push(performance.now()-start);pending=0;};
      while(cursor<workload.inputs.length){
        const buttons=workload.inputs[cursor]!;
        if(buttons[0]!==held[0]||buttons[1]!==held[1]){await progress();held=buttons;}
        let frames=1;
        while(frames<Math.min(4,15-pending)&&cursor+frames<workload.inputs.length){
          const next=workload.inputs[cursor+frames]!;if(next[0]!==buttons[0]||next[1]!==buttons[1])break;frames++;
        }
        let start=performance.now();const decisions=await pair.advance(buttons,frames);advanceMs.push(performance.now()-start);
        assert.equal(decisions.length,frames);cursor+=frames;pending+=frames;
        if(pending===15||pair.done)await progress();
        if(pair.frame-lastCheckpoint>=600){
          await progress();pointDigests[index]=latestDigests!;
          start=performance.now();points[index]=await pair.checkpoint();checkpointMs.push(performance.now()-start);pointFrames[index]=pair.frame;lastCheckpoint=pair.frame;
        }
        if(pair.frame-lastScreen>=4||pair.done){
          start=performance.now();const screens=await pair.screens(['a','b']);screenMs.push(performance.now()-start);lastScreen=pair.frame;
          for(const [side,pixels] of screens.entries()){
            const viewer=viewers[index*2+side]!,packet=viewer.encoder.encode(pixels,pair.frame);
            if(packet){
              viewer.sent++;viewer.codecBytes+=packet.byteLength;viewer.lastHash=hash(pixels);start=performance.now();
              await new Promise<void>((resolve,reject)=>viewer.socket.send(packet,{binary:true},error=>error?reject(error):resolve()));sendMs.push(performance.now()-start);
            }
          }
        }
        peakRss=Math.max(peakRss,process.memoryUsage().rss);
      }
      assert(pair.done);assert.deepEqual((await pair.progress()).digests,workload.report.finalDigests);
    };
    await Promise.all(pairs.map(simulate));
    const elapsedMs=performance.now()-started,processCpu=process.cpuUsage(cpuBefore),mainCpu=mainCpuBefore?process.threadCpuUsage(mainCpuBefore):null;
    const workerAfter=await Promise.all(pairs.map(pair=>pair.metrics()));lag.disable();
    const resources=await resourceSampler.stop();
    const networkDeadline=Date.now()+5000;
    while(viewers.some(viewer=>viewer.received!==viewer.sent)&&Date.now()<networkDeadline)await new Promise(resolve=>setTimeout(resolve,5));
    for(const viewer of viewers){assert.equal(viewer.received,viewer.sent);assert.equal(hash(viewer.decoder.pixels),viewer.lastHash);}
    const tcpBytes=viewers.reduce((sum,viewer)=>sum+viewer.tcp.bytesWritten-viewer.baseline,0),codecBytes=viewers.reduce((sum,viewer)=>sum+viewer.codecBytes,0);
    const restoreMs:number[]=[];
    for(const [index,pair] of pairs.entries()){
      await pair.close();const start=performance.now(),restored=await pool.restore(workload.artifacts,pointFrames[index],points[index]!);
      restoreMs.push(performance.now()-start);assert.deepEqual((await restored.progress()).digests,pointDigests[index]);await restored.close();
    }
    const simulatedSeconds=workload.inputs.length*FRAME_MILLISECONDS/1000,totalCpuSeconds=(resources.cpuMicroseconds.user+resources.cpuMicroseconds.system)/1e6;
    results.push({concurrentMatches:count,players:count*2,framesPerMatch:workload.inputs.length,simulatedSecondsPerMatch:simulatedSeconds,
      bootMs,elapsedMs,simulatedTimeOverWallTime:simulatedSeconds*1000/elapsedMs,
      apiProcessCpuMicroseconds:processCpu,mainThreadCpuMicroseconds:mainCpu,resources,
      workerCpuMicroseconds:workerAfter.map((metrics,index)=>metrics.threadCpu&&workerBefore[index]!.threadCpu?{
        user:metrics.threadCpu.user-workerBefore[index]!.threadCpu!.user,system:metrics.threadCpu.system-workerBefore[index]!.threadCpu!.system}:null),
      memory:{beforeBoot,afterBoot,peakApiProcessRssBytes:peakRss,workersAfter:workerAfter.map(metrics=>metrics.memory)},
      advance:timing(advanceMs),progress:timing(progressMs),checkpoint:timing(checkpointMs),screen:timing(screenMs),send:timing(sendMs),restore:timing(restoreMs),
      compressedCheckpointBytes:points.map(points=>points.map(point=>point.byteLength)),
      websocket:{compression:'permessage-deflate, level 3, no context takeover',codecBytes,tcpBytes,screenPackets:viewers.map(viewer=>viewer.sent),
        roundTripPixelParity:true,includesHandshake:false,includesTlsOrIpOverhead:false,
        bytesPerSimulatedPlayerSecond:tcpBytes/(simulatedSeconds*count*2),diagnosticMbpsFor1000Players:tcpBytes/(simulatedSeconds*count*2)*1000*8/1e6},
      eventLoopDelayMs:{p50:lag.percentile(50)/1e6,p95:lag.percentile(95)/1e6,p99:lag.percentile(99)/1e6,max:lag.max/1e6},
      diagnosticTotalCoresFor1000Players:totalCpuSeconds/(simulatedSeconds*count*2)*1000,
      cpuIncludesLocalViewerAndInflate:true,databaseAndAuthMeasured:false,sourceQualifiedFinalDigests:true});
    console.log(JSON.stringify({battleBenchmarkMatches:count,transport,elapsedMs,tcpBytes,totalCpuSeconds,peakTotalRss:resources.peakSampledTotalRssBytes}));
  }finally{
    for(const viewer of viewers){viewer.client.terminate();viewer.socket.terminate();}
    await resourceSampler.close();await pool.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve()));
  }
}
for(const [path,expected] of Object.entries(sourceSha256))assert.equal(hash(await readFile(path)),expected,`Source changed during benchmark: ${path}`);
await writeFile(reportPath,JSON.stringify({schemaVersion:2,transport,measuredAt:new Date().toISOString(),artifacts:workload.report.artifacts,sourceSha256,
  hardware:{model:cpus()[0]?.model,logicalCpus:cpus().length,platform:platform(),arch:arch(),node:process.version},
  originalCRecordedWorkload:true,testInputPolicy:true,results,capacity1000Qualified:false,hostingEstimate:false,publicReleaseQualified:false},null,2)+'\n');
