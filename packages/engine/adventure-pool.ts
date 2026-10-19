import {PrivateWorkerPool,type PrivateWorkerLease} from './private-worker-pool.ts';
import type {EngineManifest} from './runtime.ts';
import type {InputRun} from '../protocol/index.ts';
import type {LobbyPokemon} from '../trading/prepare-lobby.ts';

export type AdventureArtifact={bytes:Uint8Array;manifest:EngineManifest};
export type CompressedGameState={checkpoint:Uint8Array;frame:number;digest:string;flash:Uint8Array};
export type RawGameState={snapshot:Uint8Array;frame:number;digest:string;flash:Uint8Array};
export type GameMetadata={frame:number;digest:string};
export class AdventurePool{
  private pool:PrivateWorkerPool;
  readonly size:number;
  constructor(size?:number){this.pool=new PrivateWorkerPool({url:new URL('./adventure-worker.ts',import.meta.url),name:'adventure',prefix:'ADVENTURE',size});this.size=this.pool.size;}
  async create(artifact:AdventureArtifact,seed:number,flash?:Uint8Array,checkpoint?:Uint8Array):Promise<AdventureEngine>{
    const lease=this.pool.acquire();
    try{
      await lease.install(artifact.manifest.wasmSha256,artifact);
      const metadata=await lease.call<GameMetadata>('create',{hash:artifact.manifest.wasmSha256,seed,flash,checkpoint});
      return new AdventureEngine(lease,artifact.manifest,metadata);
    }catch(error){await lease.close();throw error;}
  }
  terminate(engine:AdventureEngine):Promise<void>{return this.pool.terminate(engine.lease);}
  close():Promise<void>{return this.pool.close();}
}

/** Authoritative frame/digest metadata updates only after a worker reply.
 * Gameplay, canonical hashes and snapshot encoding stay inside the worker. */
export class AdventureEngine{
  readonly lease:PrivateWorkerLease;
  readonly manifest:EngineManifest;
  protected metadata:GameMetadata;
  constructor(lease:PrivateWorkerLease,manifest:EngineManifest,metadata:GameMetadata){this.lease=lease;this.manifest=manifest;this.metadata=metadata;}
  get frame():number{this.lease.assertOpen();return this.metadata.frame;}
  digest():string{this.lease.assertOpen();return this.metadata.digest;}
  async advance(runs:readonly InputRun[],started?:()=>void):Promise<void>{
    this.metadata=await this.lease.call<GameMetadata>('advance',{runs,signalStarted:Boolean(started)},started);
  }
  capture():Promise<RawGameState>{return this.lease.call('capture',{raw:true});}
  captureCheckpoint():Promise<CompressedGameState>{return this.lease.call('capture');}
  prepareLobby():Promise<CompressedGameState&{party:LobbyPokemon[]}>{return this.lease.call('lobby');}
  async snapshot():Promise<Uint8Array>{return (await this.capture()).snapshot;}
  async flash():Promise<Uint8Array>{return (await this.capture()).flash;}
  close():Promise<void>{return this.lease.close();}
}
