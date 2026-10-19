import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateWorkerPool } from '../packages/engine/private-worker-pool.ts';
import { privateWorkerTransport } from '../packages/engine/private-worker-transport.ts';

test('worker transport configuration refuses unknown backends',()=>{
  assert.equal(privateWorkerTransport('thread'),'thread');assert.equal(privateWorkerTransport('process'),'process');
  assert.throws(()=>privateWorkerTransport('fork'),/GAME_WORKER_TRANSPORT/);
});

for(const transport of ['thread','process'] as const)test(`${transport} pool bounds admission, isolates state and recovers an executing worker`,async()=>{
  const prior=process.env.KANTO_TEST_WORKER_SECRET;process.env.KANTO_TEST_WORKER_SECRET='fixture-only-secret';
  const pool=new PrivateWorkerPool({url:new URL('./private-worker-fixture.ts',import.meta.url),name:'test',prefix:'FIXTURE',size:2,transport});
  try{
    const lease=pool.acquire(),peer=pool.acquire();assert.throws(()=>pool.acquire(),{code:'FIXTURE_CAPACITY'});
    const state=await lease.call<any>('state');assert.equal(state.transport,transport);
    assert(state.environmentKeys.every((key:string)=>key==='NODE_OPTIONS'),'An execution worker inherited application credentials.');
    if(transport==='process')assert.notEqual(state.pid,process.pid);else assert.equal(state.pid,process.pid);
    assert.equal(await lease.call('add',{amount:7}),7);assert.equal((await peer.call<any>('state')).value,0);
    const views=await lease.call<any>(transport==='process'?'sharedViews':'views');
    for(const view of [views.left,views.right]){assert(view instanceof Uint8Array);assert.equal(view.byteOffset,0);assert.equal(view.byteLength,4);assert.equal(view.buffer.byteLength,4);}
    assert.deepEqual([...views.left],[1,2,3,4]);assert.deepEqual([...views.right],[9,8,7,6]);assert.notEqual(views.left.buffer,views.right.buffer);
    let started!:()=>void;const running=new Promise<void>(resolve=>{started=resolve;});
    const inflight=lease.call('hang',{},started),rejected=assert.rejects(inflight,{code:'FIXTURE_WORKER_LOST'});
    await running;
    const queued=Array.from({length:31},()=>lease.call('state')),drained=Promise.allSettled(queued);
    await assert.rejects(lease.call('state'),{code:'FIXTURE_WORKER_BUSY'});
    const terminated=pool.terminate(lease);assert.throws(()=>pool.acquire(),{code:'FIXTURE_CAPACITY'});
    await terminated;await rejected;
    for(const outcome of await drained){assert.equal(outcome.status,'rejected');if(outcome.status==='rejected')assert.equal(outcome.reason.code,'FIXTURE_WORKER_LOST');}
    assert.throws(()=>lease.call('state'),{code:'FIXTURE_WORKER_LOST'});assert.equal((await peer.call<any>('state')).value,0);
    const replacement=pool.acquire(),fresh=await replacement.call<any>('state');assert.equal(fresh.value,0);
    assert.notDeepEqual([fresh.pid,fresh.threadId],[state.pid,state.threadId]);
    await replacement.call('add',{amount:10});await replacement.close();
    const reused=pool.acquire(),clean=await reused.call<any>('state');assert.deepEqual([clean.pid,clean.threadId],[fresh.pid,fresh.threadId]);assert.equal(clean.value,0);
    await reused.close();await peer.close();
  }finally{await pool.close();if(prior===undefined)delete process.env.KANTO_TEST_WORKER_SECRET;else process.env.KANTO_TEST_WORKER_SECRET=prior;}
});

test('closing a lease during installation cannot mark its replacement artifact cache',async()=>{
  const pool=new PrivateWorkerPool({url:new URL('./private-worker-fixture.ts',import.meta.url),name:'cache-race',prefix:'FIXTURE',size:1,transport:'process'});
  try{
    const lease=pool.acquire(),install=lease.install('fixture-artifact',{delay:50});const rejected=assert.rejects(install,{code:'FIXTURE_WORKER_LOST'});
    await lease.close();await rejected;
    const next=pool.acquire();await next.install('fixture-artifact',{});assert.equal((await next.call<any>('state')).value,0);await next.close();
  }finally{await pool.close();}
});

test('parent loss terminates the child process even while its game thread is hung',async()=>{
  const parent=fork(new URL('./private-worker-parent-fixture.ts',import.meta.url),[],{serialization:'advanced',execArgv:['--experimental-strip-types'],
    env:process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{},stdio:['ignore','ignore','ignore','ipc']});
  let workerPid:number|undefined;
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
  try{
    const [ready]=await once(parent,'message',{signal:AbortSignal.timeout(10000)});workerPid=ready.workerPid;
    assert(Number.isInteger(workerPid)&&workerPid!>0);assert.equal(ready.parentPid,parent.pid);assert.notEqual(workerPid,parent.pid);assert.notEqual(workerPid,process.pid);
    const ended=once(parent,'close');parent.kill('SIGKILL');await ended;
    const deadline=Date.now()+5000;while(alive(workerPid!)&&Date.now()<deadline)await delay(25);
    assert.equal(alive(workerPid!),false,'A hung game process outlived its API parent.');
  }finally{
    if(parent.exitCode===null&&parent.signalCode===null){const ended=once(parent,'close');parent.kill('SIGKILL');await ended;}
    if(workerPid&&alive(workerPid))process.kill(workerPid,'SIGKILL');
  }
});
