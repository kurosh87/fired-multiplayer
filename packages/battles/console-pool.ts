import {PrivateWorkerPool,type PrivateWorkerLease} from '../engine/private-worker-pool.ts';
import type {BattleArtifact} from './original-pair.ts';
import type {BattleResult,Side} from './session.ts';
import type {PrivateWorkerTransport} from '../engine/private-worker-transport.ts';

export type BattleDecision={kind:'turn'|'switch'|null;mask:number};
export type BattleWorkerMetrics={pid:number;transport:'thread'|'process';processCpu:NodeJS.CpuUsage;threadCpu:{user:number;system:number}|null;memory:NodeJS.MemoryUsage;environmentKeys:string[]};
type Metadata={frame:number;result:BattleResult|null};
export type BattleRequestConsole=Pick<BattleConsolePool,'create'|'restore'|'close'|'abort'>;

/** One private original pair per admitted worker lease. Database leases and
 * authentication stay in BattleSessions on the API side. */
export class BattleConsolePool{
  readonly size:number;
  private pool:PrivateWorkerPool;
  constructor(size?:number,options:{url?:URL;transport?:PrivateWorkerTransport}={}){
    this.pool=new PrivateWorkerPool({url:options.url??new URL('./console-worker.ts',import.meta.url),name:'battle',prefix:'BATTLE',size,transport:options.transport});this.size=this.pool.size;
  }
  private async allocate(artifacts:[BattleArtifact,BattleArtifact],operation:'create'|'restore',body:Record<string,unknown>,owned?:(console:BattleConsole)=>void):Promise<BattleConsole>{
    const lease=this.pool.acquire(),console=new BattleConsole(lease);
    try{
      owned?.(console);
      for(const artifact of artifacts)await lease.install(artifact.manifest.wasmSha256,{bytes:artifact.bytes,manifest:artifact.manifest});
      console.update(await lease.call<Metadata>(operation,{artifacts:artifacts.map(artifact=>({hash:artifact.manifest.wasmSha256,seed:artifact.seed})),...body}));
      return console;
    }catch(error){await console.close();throw error;}
  }
  create(artifacts:[BattleArtifact,BattleArtifact],saves:[Uint8Array,Uint8Array]):Promise<BattleConsole>{return this.allocate(artifacts,'create',{saves});}
  restore(artifacts:[BattleArtifact,BattleArtifact],frame:number,points:[Uint8Array,Uint8Array]):Promise<BattleConsole>{return this.allocate(artifacts,'restore',{frame,points});}
  terminate(console:BattleConsole):Promise<void>{return this.pool.terminate(console.lease);}
  /** One request owns at most one console pair. Closing it clears all player
   * state in C but preserves the worker's immutable artifact/baseline cache.
   * Abort terminates only this scope's lease, including an in-flight restore;
   * an old scope can never terminate a later request's worker. */
  scope():BattleRequestConsole{
    let owned:BattleConsole|undefined,started=false,closed=false;
    const allocate=(artifacts:[BattleArtifact,BattleArtifact],operation:'create'|'restore',body:Record<string,unknown>)=>{
      if(started||closed)throw new Error('A battle request owns one console pair.');
      started=true;return this.allocate(artifacts,operation,body,console=>{owned=console;});
    };
    return {
      create:(artifacts,saves)=>allocate(artifacts,'create',{saves}),
      restore:(artifacts,frame,points)=>allocate(artifacts,'restore',{frame,points}),
      close:async()=>{closed=true;await owned?.close();},
      abort:async()=>{closed=true;if(owned)await this.terminate(owned);await owned?.close();},
    };
  }
  abort():Promise<void>{return this.close();}
  close():Promise<void>{return this.pool.close();}
}

export class BattleConsole{
  readonly lease:PrivateWorkerLease;
  private metadata:Metadata={frame:0,result:null};
  constructor(lease:PrivateWorkerLease){this.lease=lease;}
  update(value:Metadata):void{this.metadata=value;}
  private open():void{this.lease.assertOpen();}
  get frame():number{this.open();return this.metadata.frame;}
  get done():boolean{this.open();return this.metadata.result!==null;}
  result():BattleResult|undefined{this.open();return this.metadata.result??undefined;}
  async advance(buttons:[number,number],frames:number,started?:()=>void):Promise<BattleDecision[]>{
    this.open();const result=await this.lease.call<Metadata&{decisions:BattleDecision[]}>('advance',{buttons,frames,signalStarted:Boolean(started)},started);
    this.update(result);return result.decisions;
  }
  async progress():Promise<{digests:[string,string];transportDigest:string}>{this.open();return this.lease.call('progress');}
  async checkpoint():Promise<[Buffer,Buffer]>{
    this.open();const points=await this.lease.call<[Uint8Array,Uint8Array]>('checkpoint');return points.map(point=>Buffer.from(point)) as [Buffer,Buffer];
  }
  async screens(sides:Side[]):Promise<Uint8Array[]>{this.open();return this.lease.call('screens',{sides});}
  async metrics():Promise<BattleWorkerMetrics>{this.open();return this.lease.call('metrics');}
  close():Promise<void>{return this.lease.close();}
}
