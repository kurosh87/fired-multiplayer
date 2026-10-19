import { PrivateWorkerPool } from '../packages/engine/private-worker-pool.ts';

const pool=new PrivateWorkerPool({url:new URL('./private-worker-fixture.ts',import.meta.url),name:'parent-loss-fixture',prefix:'FIXTURE',size:1,transport:'process'});
const lease=pool.acquire(),state=await lease.call<{pid:number}>('state');
void lease.call('hang',{},()=>process.send?.({workerPid:state.pid,parentPid:process.pid})).catch(()=>{});
process.on('disconnect',()=>process.exit(0));
