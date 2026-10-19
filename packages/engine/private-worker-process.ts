import { startPrivateWorker,ownPrivateBytes } from './private-worker-transport.ts';

if(typeof process.send!=='function'||!process.connected)throw new Error('Private process supervisor requires its parent IPC channel.');
const entry=new URL(process.argv[2]??'');
if(entry.protocol!=='file:')throw new Error('Private worker entry must be a local module.');
// This event loop never executes C/WASM. It can exit the whole child process
// on parent loss even while its game thread is stuck in synchronous work.
const worker=startPrivateWorker(entry,'process-core','thread',true);
process.on('disconnect',()=>process.exit(0));
process.on('message',value=>{try{worker.postMessage(ownPrivateBytes(value));}catch{process.exit(1);}});
worker.on('message',value=>{
  if(!process.connected)return;
  process.send!(value,error=>{if(error)process.exit(1);});
});
worker.on('error',()=>process.exit(1));
worker.on('exit',code=>process.exit(code));
