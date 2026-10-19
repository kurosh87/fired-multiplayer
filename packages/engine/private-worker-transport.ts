import { Worker,parentPort,workerData } from 'node:worker_threads';
import { fork,type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type PrivateWorkerTransport='thread'|'process';
export interface PrivateWorkerHandle{
  on(event:'message'|'error'|'exit',listener:(value:any)=>void):this;
  postMessage(value:unknown,transfer?:ArrayBuffer[]):void;
  terminate():Promise<number>;
}

export function privateWorkerTransport(value=process.env.GAME_WORKER_TRANSPORT??'thread'):PrivateWorkerTransport{
  if(value!=='thread'&&value!=='process')throw new Error('GAME_WORKER_TRANSPORT must be thread or process.');
  return value;
}

/** Advanced IPC can deserialize typed views backed by an envelope containing
 * other views. Give every byte payload its own exact buffer, including private
 * battle screens, matching the thread transport's ownership contract. */
export function ownPrivateBytes(value:any):any{
  if(value instanceof Uint8Array)return Uint8Array.from(value);
  if(value instanceof ArrayBuffer)return value.slice(0);
  if(Array.isArray(value))return value.map(ownPrivateBytes);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,ownPrivateBytes(item)]));
  return value;
}

class ProcessWorker extends EventEmitter implements PrivateWorkerHandle{
  private child:ChildProcess;
  private stopped=false;
  private termination:Promise<number>|undefined;
  constructor(url:URL,env:NodeJS.ProcessEnv){
    super();
    this.child=fork(new URL('./private-worker-process.ts',import.meta.url),[url.href],{env,serialization:'advanced',execArgv:['--experimental-strip-types','--max-old-space-size=128','--max-semi-space-size=32','--stack-size=4096'],
      stdio:['ignore','ignore','pipe','ipc']});
    this.child.stderr?.resume();
    this.child.on('message',value=>this.emit('message',ownPrivateBytes(value)));
    this.child.on('error',error=>this.emit('error',error));
    this.child.on('disconnect',()=>{if(!this.stopped)this.emit('error',new Error('Private worker IPC disconnected.'));});
    this.child.on('exit',code=>{this.stopped=true;this.emit('exit',code??1);});
    this.child.on('close',()=>{this.stopped=true;});
  }
  postMessage(value:unknown):void{
    if(!this.child.connected)throw new Error('Private worker IPC is closed.');
    this.child.send(value as object,error=>{if(error&&!this.stopped)this.emit('error',error);});
  }
  terminate():Promise<number>{
    this.termination??=new Promise(resolve=>{
      if(this.stopped){resolve(this.child.exitCode??1);return;}
      this.child.once('close',code=>resolve(code??1));
      this.child.kill('SIGKILL');
    });
    return this.termination;
  }
}

export function startPrivateWorker(url:URL,name:string,transport:PrivateWorkerTransport,processBoundary=false):PrivateWorkerHandle{
  // Preserve the managed preload. No inherited --env-file, application
  // credentials, database URL, provider token or unrelated environment values.
  const env=process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{};
  return transport==='process'?new ProcessWorker(url,env):new Worker(url,{env,execArgv:['--experimental-strip-types'],
    resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32,stackSizeMb:4},name:`kanto-${name}`,workerData:{processBoundary}});
}

export function privateWorkerPort():{kind:PrivateWorkerTransport;on(event:'message',listener:(value:any)=>void):void;postMessage(value:unknown,transfer?:ArrayBuffer[]):void}{
  const port=parentPort;
  if(!port)throw new Error('A private game requires a managed worker channel.');
  return {kind:workerData?.processBoundary===true?'process':'thread',on:(_event,listener)=>{port.on('message',listener);},postMessage:(value,transfer=[])=>port.postMessage(value,transfer)};
}
