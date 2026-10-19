import { threadId } from 'node:worker_threads';
import { privateWorkerPort } from '../packages/engine/private-worker-transport.ts';

const port=privateWorkerPort();let value=0,tail=Promise.resolve();
port.on('message',message=>{
  tail=tail.then(async()=>{
    if(message.operation==='hang'){port.postMessage({id:message.id,running:true});while(true){/* Explicit synchronous fault fixture. */}}
    let data:unknown=null;
    if(message.operation==='state')data={pid:process.pid,threadId,transport:port.kind,value,environmentKeys:Object.keys(process.env).sort()};
    else if(message.operation==='metrics')data={pid:process.pid,transport:port.kind,processCpu:process.cpuUsage(),memory:process.memoryUsage()};
    else if(message.operation==='add'){value+=message.amount;data=value;}
    else if(message.operation==='views')data={left:Uint8Array.from([1,2,3,4]),right:Uint8Array.from([9,8,7,6])};
    else if(message.operation==='sharedViews'){
      const bytes=new Uint8Array(32).fill(99);bytes.set([1,2,3,4],2);bytes.set([9,8,7,6],20);data={left:bytes.subarray(2,6),right:bytes.subarray(20,24)};
    }else if(message.operation==='install'){if(message.artifact?.delay)await new Promise(resolve=>setTimeout(resolve,message.artifact.delay));}
    else if(message.operation==='close')value=0;
    port.postMessage({id:message.id,ok:true,data});
  });
});
