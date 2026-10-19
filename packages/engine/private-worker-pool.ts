import {AsyncResource} from 'node:async_hooks';
import {channel} from 'node:diagnostics_channel';
import {availableParallelism} from 'node:os';
import {DomainError} from '../protocol/index.ts';
import {startPrivateWorker,privateWorkerTransport,type PrivateWorkerHandle,type PrivateWorkerTransport} from './private-worker-transport.ts';

type Pending={resolve(value:any):void;reject(error:unknown):void;timer:ReturnType<typeof setTimeout>;resource:AsyncResource;started?:()=>void};
type Slot={worker?:PrivateWorkerHandle;retiring?:Promise<void>;owner?:PrivateWorkerLease;installed:Set<string>;pending:Map<number,Pending>};
export type WorkerPoolOptions={url:URL;name:string;prefix:string;size?:number;transport?:PrivateWorkerTransport};
export type PrivateWorkerResources={pid:number;transport:PrivateWorkerTransport;processCpu:NodeJS.CpuUsage;memory:NodeJS.MemoryUsage};
export const PRIVATE_WORKER_POOL_CHANNEL='kanto.private-worker-pools';
export type PrivateWorkerPoolEvent={event:'opened'|'closed';pool:PrivateWorkerPool};
const lifecycle=channel(PRIVATE_WORKER_POOL_CHANNEL);

/** Private, bounded CPU workers. Leases own runtimes until close. Process mode
 * adds an address-space boundary; host RSS and permission limits remain external. */
export class PrivateWorkerPool{
  readonly size:number;
  readonly transport:PrivateWorkerTransport;
  private options:WorkerPoolOptions;
  private slots:Slot[]=[];
  private next=0;
  private closed=false;
  constructor(options:WorkerPoolOptions){
    this.options=options;this.size=options.size??Math.max(1,Math.min(4,availableParallelism()-2));
    this.transport=privateWorkerTransport(options.transport);
    if(!Number.isInteger(this.size)||this.size<1||this.size>32)throw new Error('Private worker count must be between 1 and 32.');
    lifecycle.publish({event:'opened',pool:this} satisfies PrivateWorkerPoolEvent);
  }
  private lost():DomainError{return new DomainError(`${this.options.prefix}_WORKER_LOST`,'Reconnect to restore verified progress.',503);}
  private fail(slot:Slot,worker:PrivateWorkerHandle):void{
    if(slot.worker!==worker)return;slot.worker=undefined;slot.installed.clear();slot.owner?.invalidate();slot.owner=undefined;
    for(const pending of slot.pending.values()){
      clearTimeout(pending.timer);pending.resource.runInAsyncScope(pending.reject,null,this.lost());pending.resource.emitDestroy();
    }
    slot.pending.clear();
    const retiring=worker.terminate().then(()=>{});slot.retiring=retiring;
    void retiring.then(()=>{if(slot.retiring===retiring)slot.retiring=undefined;},()=>{});
  }
  private start(slot:Slot):void{
    slot.installed.clear();
    const worker=startPrivateWorker(this.options.url,this.options.name,this.transport);
    slot.worker=worker;
    worker.on('message',message=>{
      if(slot.worker!==worker)return;const pending=slot.pending.get(message.id);if(!pending)return;
      if(message.running){pending.started?.();return;}
      slot.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.ok)pending.resource.runInAsyncScope(pending.resolve,null,message.data);
      else pending.resource.runInAsyncScope(pending.reject,null,new DomainError(message.error.code,message.error.message,message.error.status));
      pending.resource.emitDestroy();
    });
    worker.on('error',()=>this.fail(slot,worker));worker.on('exit',()=>this.fail(slot,worker));
  }
  private call<T>(slot:Slot,operation:string,body:Record<string,unknown>={},started?:()=>void):Promise<T>{
    const worker=slot.worker;if(!worker||this.closed)return Promise.reject(this.lost());
    if(slot.pending.size>=32)return Promise.reject(new DomainError(`${this.options.prefix}_WORKER_BUSY`,'Too many pending game operations.',503));
    const id=++this.next;
    return new Promise<T>((resolve,reject)=>{
      const resource=new AsyncResource(`kanto-${this.options.name}-operation`),timer=setTimeout(()=>this.fail(slot,worker),15_000).unref();
      slot.pending.set(id,{resolve,reject,timer,resource,started});
      try{worker.postMessage({id,operation,...body});}
      catch(error){slot.pending.delete(id);clearTimeout(timer);resource.emitDestroy();reject(error);}
    });
  }
  acquire():PrivateWorkerLease{
    if(this.closed)throw this.lost();let slot=this.slots.find(slot=>!slot.owner&&!slot.retiring);
    if(!slot){
      if(this.slots.length>=this.size)throw new DomainError(`${this.options.prefix}_CAPACITY`,'Game workers are busy. Try again shortly.',503);
      slot={installed:new Set(),pending:new Map()};this.slots.push(slot);
    }
    if(!slot.worker)this.start(slot);
    const lease=new PrivateWorkerLease(this,slot,()=>this.lost());slot.owner=lease;return lease;
  }
  async operation<T>(lease:PrivateWorkerLease,slot:Slot,operation:string,body:Record<string,unknown>,started?:()=>void):Promise<T>{
    if(slot.owner!==lease)throw this.lost();return this.call<T>(slot,operation,body,started);
  }
  async release(lease:PrivateWorkerLease,slot:Slot):Promise<void>{
    if(slot.owner!==lease)return;
    try{if(slot.worker)await this.call(slot,'close');}
    catch{if(slot.worker)this.fail(slot,slot.worker);}
    finally{if(slot.owner===lease)slot.owner=undefined;}
  }
  async terminate(lease:PrivateWorkerLease):Promise<void>{
    const slot=this.slots.find(slot=>slot.owner===lease);
    if(slot?.worker){const worker=slot.worker;this.fail(slot,worker);await worker.terminate();}
  }
  /** Trusted in-process diagnostics only. Reads idle workers too, without
   * acquiring or releasing their game leases. No public route uses this. */
  async resources():Promise<{name:string;transport:PrivateWorkerTransport;workers:(PrivateWorkerResources&{slot:number})[]}>{
    if(this.closed)throw this.lost();
    const workers=await Promise.all(this.slots.map(async(slot,index)=>{
      const worker=slot.worker;if(!worker)return null;
      const result=await this.call<PrivateWorkerResources>(slot,'metrics');
      if(slot.worker!==worker)throw this.lost();
      return {slot:index,pid:result.pid,transport:result.transport,processCpu:result.processCpu,memory:result.memory};
    }));
    return {name:this.options.name,transport:this.transport,workers:workers.filter(value=>value!==null)};
  }
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;
    try{await Promise.all(this.slots.map(async slot=>{const worker=slot.worker;if(worker)this.fail(slot,worker);await slot.retiring;}));}
    finally{lifecycle.publish({event:'closed',pool:this} satisfies PrivateWorkerPoolEvent);}
  }
}

export class PrivateWorkerLease{
  private pool:PrivateWorkerPool;
  private slot:Slot;
  private lost:()=>DomainError;
  private failed=false;
  private closing:Promise<void>|undefined;
  constructor(pool:PrivateWorkerPool,slot:Slot,lost:()=>DomainError){this.pool=pool;this.slot=slot;this.lost=lost;}
  invalidate():void{this.failed=true;}
  assertOpen():void{if(this.failed||this.closing)throw this.lost();}
  async install(key:string,artifact:unknown):Promise<void>{
    this.assertOpen();if(this.slot.installed.has(key))return;
    await this.call('install',{artifact});this.assertOpen();this.slot.installed.add(key);
  }
  call<T>(operation:string,body:Record<string,unknown>={},started?:()=>void):Promise<T>{
    this.assertOpen();return this.pool.operation(this,this.slot,operation,body,started);
  }
  close():Promise<void>{this.closing??=this.pool.release(this,this.slot);return this.closing;}
}
