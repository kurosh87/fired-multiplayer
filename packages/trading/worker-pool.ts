import {PrivateWorkerPool,type PrivateWorkerLease} from '../engine/private-worker-pool.ts';
import {AdventureEngine,type AdventureArtifact,type GameMetadata} from '../engine/adventure-pool.ts';
import type {InputRun,GameVersion} from '../protocol/index.ts';
import {DomainError} from '../protocol/index.ts';
import type {EngineRegistry} from '../engine/registry.ts';
import type {LobbyPokemon} from './prepare-lobby.ts';
import type {CanonicalSave} from './atomic-trade.ts';

type TradeMetadata=GameMetadata&{phase:number;resultFlash?:Uint8Array};
export interface GameInspection{
  lobbyParty(version:GameVersion,seed:number,flash:Uint8Array):Promise<LobbyPokemon[]>;
  tradeChecks(a:CanonicalSave,b:CanonicalSave,slotA:number,slotB:number):Promise<{a:number;b:number}>;
}
export class TradeWorkerPool{
  private pool:PrivateWorkerPool;
  constructor(size?:number,inspection=false){this.pool=new PrivateWorkerPool({url:new URL('../engine/adventure-worker.ts',import.meta.url),
    name:inspection?'inspection':'trade',prefix:inspection?'INSPECTION':'TRADE',size});}
  private async acquire(artifacts:AdventureArtifact[]):Promise<PrivateWorkerLease>{
    const lease=this.pool.acquire();
    try{for(const artifact of artifacts)await lease.install(artifact.manifest.wasmSha256,artifact);return lease;}
    catch(error){await lease.close();throw error;}
  }
  async restore(artifact:AdventureArtifact,seed:number,checkpoint:Uint8Array):Promise<TradeEngine>{
    const lease=await this.acquire([artifact]);
    try{return new TradeEngine(lease,artifact.manifest,await lease.call<TradeMetadata>('tradeRestore',{hash:artifact.manifest.wasmSha256,seed,checkpoint}));}
    catch(error){await lease.close();throw error;}
  }
  async prepare(artifacts:[AdventureArtifact,AdventureArtifact],saves:[Uint8Array,Uint8Array],slots:[number,number],
    digests:[string,string],seeds:[number,number]):Promise<[Buffer,Buffer]>{
    const lease=await this.acquire(artifacts);
    try{
      const points=await lease.call<[Uint8Array,Uint8Array]>('tradePrepare',{artifacts:artifacts.map(artifact=>({hash:artifact.manifest.wasmSha256})),saves,slots,digests,seeds});
      return points.map(point=>Buffer.from(point)) as [Buffer,Buffer];
    }finally{await lease.close();}
  }
  async inspect(artifact:AdventureArtifact,seed:number,flash:Uint8Array):Promise<LobbyPokemon[]>{
    const lease=await this.acquire([artifact]);
    try{return await lease.call('inspect',{hash:artifact.manifest.wasmSha256,seed,flash});}finally{await lease.close();}
  }
  async checks(artifacts:[AdventureArtifact,AdventureArtifact],saves:[Uint8Array,Uint8Array],slots:[number,number]):Promise<{a:number;b:number}>{
    const lease=await this.acquire(artifacts);
    try{return await lease.call('tradeChecks',{artifacts:artifacts.map(artifact=>({hash:artifact.manifest.wasmSha256})),saves,slots});}finally{await lease.close();}
  }
  terminate(engine:TradeEngine):Promise<void>{return this.pool.terminate(engine.lease);}
  close():Promise<void>{return this.pool.close();}
}
export class TradeEngine extends AdventureEngine{
  get engine():this{return this;}
  get phase():number{this.lease.assertOpen();return (this.metadata as TradeMetadata).phase;}
  completedFlash():Uint8Array{
    this.lease.assertOpen();const state=this.metadata as TradeMetadata;
    if(state.phase!==3||state.resultFlash?.byteLength!==128*1024)throw new DomainError('TRADE_ENGINE_FAILED','The original scene has no completed cartridge.',503);
    return state.resultFlash;
  }
  override async advance(runs:readonly InputRun[],started?:()=>void):Promise<void>{
    this.metadata=await this.lease.call<TradeMetadata>('advance',{runs,signalStarted:Boolean(started)},started);
  }
}
export class WorkerGameInspection implements GameInspection{
  private registry:EngineRegistry;
  private pool:TradeWorkerPool;
  constructor(registry:EngineRegistry,size?:number){this.registry=registry;this.pool=new TradeWorkerPool(size,true);}
  private artifact(version:GameVersion):AdventureArtifact{return {bytes:this.registry.artifact(version),manifest:this.registry.manifest(version)};}
  lobbyParty(version:GameVersion,seed:number,flash:Uint8Array):Promise<LobbyPokemon[]>{return this.pool.inspect(this.artifact(version),seed,flash);}
  tradeChecks(a:CanonicalSave,b:CanonicalSave,slotA:number,slotB:number):Promise<{a:number;b:number}>{
    return this.pool.checks([this.artifact(a.version),this.artifact(b.version)],[a.flash,b.flash],[slotA,slotB]);
  }
  close():Promise<void>{return this.pool.close();}
}
