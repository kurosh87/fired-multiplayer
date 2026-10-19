import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {PrivateWorkerPool,type PrivateWorkerResources} from '../packages/engine/private-worker-pool.ts';
import {WorkerResourceSampler,uniqueProcessResources,summarizeWorkerResources,type ResourceSample} from '../scripts/worker-resource-sampler.ts';

const record=(pid:number,rss:number,cpu:number,transport:'thread'|'process'='thread'):PrivateWorkerResources=>({
  pid,transport,processCpu:{user:cpu,system:0},memory:{rss,heapTotal:0,heapUsed:0,external:0,arrayBuffers:0}});
test('resource accounting deduplicates thread totals and sums distinct child processes',()=>{
  const api=record(1,100,10);
  const all=uniqueProcessResources(api,[{name:'adventure',transport:'thread',workers:[{...record(1,90,8),slot:0},{...record(1,95,9),slot:1}]},
    {name:'battle',transport:'process',workers:[{...record(2,50,5,'process'),slot:0}]}]);
  assert.deepEqual(all,[api,record(2,50,5,'process')]);
  const sample=(completedAtMs:number,processes:PrivateWorkerResources[]):ResourceSample=>({apiPid:1,completedAtMs,collectionMs:1,pools:[],processes});
  const samples=[sample(0,all),sample(10,[record(1,80,20),record(2,70,12,'process')]),sample(20,[record(1,90,30),record(2,30,15,'process')])];
  const result=summarizeWorkerResources(samples,250);
  assert.equal(result.peakSampledTotalRssBytes,150); // Not the sum of separate peaks (170).
  assert.equal(result.cpuMicroseconds.user,30);assert.equal(result.distinctProcessCount,2);
  assert.throws(()=>summarizeWorkerResources([samples[0]!,sample(20,[record(1,90,30)])],250),/Process membership/);
  assert.throws(()=>summarizeWorkerResources([samples[0]!,sample(20,[record(1,90,2),record(2,30,15,'process')])],250),/CPU counters decreased/);
});

for(const transport of ['thread','process'] as const)test(`${transport} sampler includes leased and idle workers without changing game state`,async()=>{
  const sampler=new WorkerResourceSampler(100);
  const pool=new PrivateWorkerPool({url:new URL('./private-worker-fixture.ts',import.meta.url),name:'resource-fixture',prefix:'FIXTURE',size:2,transport});
  try{
    const first=pool.acquire(),second=pool.acquire();await first.call('add',{amount:9});await second.call('state');
    await sampler.start();await second.close();await delay(230);
    const summary=await sampler.stop();
    assert(summary.sampleCount>=3);assert.equal(summary.distinctProcessCount,transport==='thread'?1:3);
    assert(summary.samples.every(sample=>sample.pools[0]?.workers.length===2));
    assert(summary.peakSampledTotalRssBytes>0);assert(summary.cpuMicroseconds.user+summary.cpuMicroseconds.system>0);
    assert.equal((await first.call<any>('state')).value,9);await first.close();
  }finally{await sampler.close();await pool.close();}
  await assert.rejects(pool.resources(),{code:'FIXTURE_WORKER_LOST'});
});
