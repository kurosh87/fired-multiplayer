import assert from 'node:assert/strict';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';
import {performance} from 'node:perf_hooks';
import {PRIVATE_WORKER_POOL_CHANNEL,type PrivateWorkerPool,type PrivateWorkerPoolEvent,type PrivateWorkerResources} from '../packages/engine/private-worker-pool.ts';

type PoolResources=Awaited<ReturnType<PrivateWorkerPool['resources']>>;
export type ResourceSample={apiPid:number;completedAtMs:number;collectionMs:number;pools:PoolResources[];processes:PrivateWorkerResources[]};
const valid=(value:number)=>Number.isSafeInteger(value)&&value>=0;

/** Thread workers report the API's whole-process RSS/CPU. Keep that PID once;
 * child-process workers each contribute a separate whole-process reading. */
export function uniqueProcessResources(api:PrivateWorkerResources,pools:PoolResources[]):PrivateWorkerResources[]{
  const records=new Map<number,PrivateWorkerResources>([[api.pid,api]]);
  for(const pool of pools)for(const worker of pool.workers){
    assert.equal(worker.transport,pool.transport);
    if(pool.transport==='thread')assert.equal(worker.pid,api.pid);
    else assert.notEqual(worker.pid,api.pid);
    if(worker.pid!==api.pid)records.set(worker.pid,{pid:worker.pid,transport:worker.transport,processCpu:worker.processCpu,memory:worker.memory});
  }
  for(const record of records.values()){
    assert(Number.isSafeInteger(record.pid)&&record.pid>0);
    assert(valid(record.memory.rss)&&valid(record.processCpu.user)&&valid(record.processCpu.system));
  }
  return [...records.values()].sort((a,b)=>a.pid-b.pid);
}

export function summarizeWorkerResources(samples:ResourceSample[],intervalMs:number){
  assert(samples.length>=2);
  const first=samples[0]!,last=samples.at(-1)!,pids=first.processes.map(p=>p.pid);
  const slots=(sample:ResourceSample)=>sample.pools.map(pool=>({name:pool.name,transport:pool.transport,slots:pool.workers.map(worker=>worker.slot)}));
  for(const sample of samples){
    assert.equal(sample.apiPid,first.apiPid);
    assert.deepEqual(sample.processes.map(p=>p.pid),pids,'Process membership changed during measurement; warm every pool first and preserve this failed run.');
    assert.deepEqual(slots(sample),slots(first),'Worker membership changed during measurement; warm every pool first.');
  }
  const perProcess=pids.map((pid,index)=>{
    const start=first.processes[index]!,end=last.processes[index]!;
    const cpu={user:end.processCpu.user-start.processCpu.user,system:end.processCpu.system-start.processCpu.system};
    assert(valid(cpu.user)&&valid(cpu.system),'Process CPU counters decreased.');
    return {pid,role:pid===first.apiPid?'api':'worker',cpuMicroseconds:cpu,peakSampledRssBytes:Math.max(...samples.map(sample=>sample.processes[index]!.memory.rss))};
  });
  const cpuMicroseconds=perProcess.reduce((sum,p)=>({user:sum.user+p.cpuMicroseconds.user,system:sum.system+p.cpuMicroseconds.system}),{user:0,system:0});
  return {apiPid:first.apiPid,intervalMs,sampleCount:samples.length,elapsedMs:last.completedAtMs-first.completedAtMs,
    maxSampleCollectionMs:Math.max(...samples.map(sample=>sample.collectionMs)),distinctProcessCount:pids.length,
    cpuMicroseconds,perProcess,
    peakSampledTotalRssBytes:Math.max(...samples.map(sample=>sample.processes.reduce((sum,p)=>sum+p.memory.rss,0))),
    method:'API plus one whole-process reading per distinct private worker PID; thread RSS/CPU deduplicated',
    includesSamplingOverhead:true,includesStartupCpu:false,postgresIncluded:false,physicalMemoryDeduplicated:false,
    membershipStable:true,samples};
}

/** Subscribe before creating pools. Diagnostics stay inside this trusted Node
 * process; the benchmark never adds a network endpoint or acquires a lease. */
export class WorkerResourceSampler{
  private pools=new Set<PrivateWorkerPool>();
  private samples:ResourceSample[]=[];
  private timer:ReturnType<typeof setInterval>|undefined;
  private pending:Promise<void>|undefined;
  private failure:unknown;
  private onEvent=(message:unknown)=>{
    const event=message as PrivateWorkerPoolEvent;
    if(event.event==='opened')this.pools.add(event.pool);else this.pools.delete(event.pool);
  };
  constructor(privateIntervalMs=250){
    assert(Number.isInteger(privateIntervalMs)&&privateIntervalMs>=100&&privateIntervalMs<=1000);
    this.intervalMs=privateIntervalMs;subscribe(PRIVATE_WORKER_POOL_CHANNEL,this.onEvent);
  }
  readonly intervalMs:number;
  private async capture():Promise<void>{
    const start=performance.now(),pools=await Promise.all([...this.pools].map(pool=>pool.resources()));
    const processes=uniqueProcessResources({pid:process.pid,transport:'thread',processCpu:process.cpuUsage(),memory:process.memoryUsage()},pools);
    this.samples.push({apiPid:process.pid,completedAtMs:performance.now(),collectionMs:performance.now()-start,pools,processes});
  }
  async start():Promise<void>{
    assert.equal(this.samples.length,0);assert.equal(this.timer,undefined);
    await this.capture();
    this.timer=setInterval(()=>{
      if(this.pending||this.failure)return;
      this.pending=this.capture().catch(error=>{this.failure=error;}).finally(()=>{this.pending=undefined;});
    },this.intervalMs);
  }
  async stop(){
    clearInterval(this.timer);this.timer=undefined;await this.pending;
    if(this.failure)throw this.failure;
    await this.capture();return summarizeWorkerResources(this.samples,this.intervalMs);
  }
  async close():Promise<void>{
    clearInterval(this.timer);this.timer=undefined;unsubscribe(PRIVATE_WORKER_POOL_CHANNEL,this.onEvent);
    await this.pending;this.pools.clear();
  }
}
