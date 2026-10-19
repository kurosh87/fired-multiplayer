import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DomainError, inputBatch, type GameVersion, type VerificationAck } from '../../../packages/protocol/index.ts';
import type { EngineRegistry } from '../../../packages/engine/registry.ts';
import type { EngineManifest } from '../../../packages/engine/runtime.ts';
import {gameArtifactUrl} from '../../../packages/engine/artifact-url.ts';
import type {AdventureArtifact} from '../../../packages/engine/adventure-pool.ts';
import {TradeWorkerPool,type TradeEngine} from '../../../packages/trading/worker-pool.ts';
import { type TradeReceipt } from '../../../packages/trading/atomic-trade.ts';
import { SessionVerifier } from '../../../packages/verification/verifier.ts';
import { PostgresTrades } from './trade-repository.ts';
import { TradeSceneStore } from './trade-scene-store.ts';
import type { TradeOffers } from './trade-offers.ts';

type Live = { owner: string; tradeId: string; core: TradeEngine; verifier: SessionVerifier;
  fence: number; version: GameVersion; seed: number; manifest: EngineManifest };
export type TradeSceneBootstrap = { id: string; adventureId:string; tradeId: string; protocol: 1; mode: 'trade';
  manifest: EngineManifest; seed: number; frame: number; nextSequence: number; digest: string;
  done: boolean; checkpointUrl: string; artifactUrl: string };

/** Interactive original-C scenes. Client inputs are journaled against private
 * staged memory; clients can never supply cartridges or choose completion. */
export class TradeScenes {
  private registry: EngineRegistry;
  private repository: PostgresTrades;
  private store: TradeSceneStore;
  private offers: TradeOffers;
  private clock: () => number;
  private pool:TradeWorkerPool;
  private ownsPool:boolean;
  private closing=false;
  private live = new Map<string, Live>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(registry: EngineRegistry, repository: PostgresTrades, store: TradeSceneStore, offers: TradeOffers, clock: () => number = Date.now,pool?:TradeWorkerPool|number) {
    this.registry = registry; this.repository = repository; this.store = store; this.offers = offers;
    this.clock = clock;this.pool=pool instanceof TradeWorkerPool?pool:new TradeWorkerPool(pool);this.ownsPool=!(pool instanceof TradeWorkerPool);
  }
  private async exclusive<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(body); this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }

  async begin(owner: string, tradeId: string, revision: number): Promise<TradeSceneBootstrap | TradeReceipt> {
    if(this.closing)throw new DomainError('SERVER_RESTARTING','The trade service is restarting.',503);
    return this.exclusive(`begin:${tradeId}`, async () => {
      if(this.closing)throw new DomainError('SERVER_RESTARTING','The trade service is restarting.',503);
      const view = await this.offers.get(owner, tradeId);
      if (view.status === 'committed') return (await this.repository.receipt(tradeId))!;
      const trade = view.status === 'committing' ? await this.repository.reserved(tradeId, owner, revision)
        : await this.repository.reserve(tradeId, owner, revision);
      // Never release a reservation after an uncertain initialization write:
      // retrying reads the already persisted pair instead of replacing it.
      let writing = false;
      try {
        try { await this.store.row(owner,tradeId); writing = true; return await this.open(owner,tradeId); }
        catch (error) { if (!(error instanceof DomainError) || error.code !== 'TRADE_SCENE_NOT_FOUND') throw error; }
        const seedA = randomBytes(4).readUInt32LE(), seedB = randomBytes(4).readUInt32LE();
        const [pointA,pointB]=await this.pool.prepare(
          [trade.saveA,trade.saveB].map(save=>({bytes:this.registry.artifact(save.version),manifest:this.registry.manifest(save.version)})) as [AdventureArtifact,AdventureArtifact],
          [trade.saveA.flash,trade.saveB.flash],[trade.offerA.partySlot,trade.offerB.partySlot],
          [trade.offerA.pokemonDigest,trade.offerB.pokemonDigest],[seedA,seedB]);
        writing = true;
        await this.store.initialize(trade, [
          { id: randomUUID(), ownerId: trade.saveA.ownerId, adventureId: trade.saveA.id, side: 'a',
            artifactId: this.registry.manifest(trade.saveA.version).id, seed: seedA, checkpoint: pointA },
          { id: randomUUID(), ownerId: trade.saveB.ownerId, adventureId: trade.saveB.id, side: 'b',
            artifactId: this.registry.manifest(trade.saveB.version).id, seed: seedB, checkpoint: pointB },
        ]);
      } catch (error) { if (!writing) await this.repository.release(tradeId); throw error; }
      return this.open(owner,tradeId);
    });
  }

  async open(owner: string, tradeId: string): Promise<TradeSceneBootstrap> {
    if(this.closing)throw new DomainError('SERVER_RESTARTING','The trade service is restarting.',503);
    return this.exclusive(`owner:${owner}`, async () => {
      if(this.closing)throw new DomainError('SERVER_RESTARTING','The trade service is restarting.',503);
      const local = [...this.live.entries()].find(([, entry]) => entry.owner === owner);
      if (local && local[1].tradeId !== tradeId) throw new DomainError('TRADE_BUSY', 'Finish the current trade scene first.', 409);
      if (local) {
        try { await this.checkpoint(owner,tradeId,local[1].fence); }
        catch (error) { if (!(error instanceof DomainError) || !['SESSION_RECOVERY_REQUIRED','TRADE_SCENE_LEASE_LOST','TRADE_WORKER_LOST','TRADE_SCENE_NOT_FOUND','SESSION_REPLACED'].includes(error.code)) throw error; }
        await this.retire(local[0],local[1]);
      }
      const row = await this.store.claim(owner,tradeId,local?.[1].fence);
      let core: TradeEngine | undefined;
      try {
        const manifest = this.registry.manifest(row.version);
        if (manifest.id !== row.artifact_id) throw new DomainError('ENGINE_VERSION_PINNED', 'This trade requires its original engine artifact.', 503);
        core=await this.pool.restore({bytes:this.registry.artifact(row.version),manifest},Number(row.seed),row.checkpoint??row.initial_checkpoint);
        let sequence = row.checkpoint ? Number(row.checkpoint_sequence) : 0;
        if (core.engine.frame !== (row.checkpoint ? Number(row.checkpoint_frame) : 0))
          throw new DomainError('CHECKPOINT_CORRUPT', 'The trade checkpoint has the wrong frame.', 503);
        for (const entry of await this.store.entries(row.id,sequence)) {
          if (entry.batch.sessionId !== row.id || entry.batch.sequence !== sequence || entry.batch.startFrame !== core.engine.frame
            || createHash('sha256').update(JSON.stringify(inputBatch(entry.batch))).digest('hex') !== entry.fingerprint || core.phase !== 2)
            throw new DomainError('JOURNAL_CORRUPT', 'The trade input journal is incomplete.', 503);
          await core.engine.advance(inputBatch(entry.batch).runs);
          if (core.engine.digest() !== entry.acknowledgement.digest || core.engine.frame !== entry.acknowledgement.frame)
            throw new DomainError('JOURNAL_DIVERGED', 'The restored trade differs from verified inputs.', 503);
          sequence++;
        }
        if (sequence !== Number(row.next_sequence) || core.engine.frame !== Number(row.frame)
          || (row.status === 'done' ? core.phase !== 3 || !Buffer.from(core.completedFlash()).equals(row.result_flash!) : core.phase !== 2))
          throw new DomainError('JOURNAL_CORRUPT', 'The trade is missing verified progress.', 503);
        const restored = core;
        const journal = { find: this.store.find.bind(this.store), append: async (id: string, fence: number, entry: Parameters<TradeSceneStore['append']>[2]) => {
          if (![2,3].includes(restored.phase)) throw new DomainError('TRADE_ENGINE_FAILED', 'The original trade scene could not finish.', 503);
          await this.store.append(id,fence,entry,restored.phase === 3 ? restored.completedFlash() : undefined);
        } };
        const verifier = new SessionVerifier({ engine: core.engine, journal, sessionId: row.id, fence: Number(row.fence), nextSequence: sequence, clock:this.clock });
        if(this.closing)throw new DomainError('SERVER_RESTARTING','The trade service is restarting.',503);
        this.live.set(row.id, { owner,tradeId,core,verifier,fence:Number(row.fence),version:row.version,seed:Number(row.seed),manifest });
        const state=await verifier.pauseMetadata();
        return { id:row.id, adventureId:row.adventure_id, tradeId, protocol:1, mode:'trade', manifest,seed:Number(row.seed),frame:state.frame,
          nextSequence:sequence,digest:state.digest,done:core.phase===3,
          checkpointUrl:`/api/trades/${tradeId}/scene/checkpoint`,artifactUrl:gameArtifactUrl(row.version,manifest.wasmSha256) };
      }catch(error){this.live.delete(row.id);await core?.close();await this.store.expireLease(row.id,Number(row.fence));throw error;}
    });
  }

  private owned(owner: string, tradeId: string, fence?: number): [string,Live] {
    const found = [...this.live.entries()].find(([,entry]) => entry.owner === owner && entry.tradeId === tradeId);
    if (!found) throw new DomainError('TRADE_SCENE_NOT_FOUND', 'Resume your trade scene first.', 404);
    if (fence !== undefined && found[1].fence !== fence) throw new DomainError('SESSION_REPLACED', 'This trade resumed on another connection.', 409);
    return found;
  }
  connection(owner: string, tradeId: string): { id: string; fence: number } {
    const [id,entry] = this.owned(owner,tradeId); return { id,fence:entry.fence };
  }
  isDone(owner:string,tradeId:string,fence:number):boolean{
    // A partner can commit and retire both runtimes after this input's ACK.
    // The caller's finish poll will then read the durable receipt.
    if(![...this.live.values()].some(entry=>entry.owner===owner&&entry.tradeId===tradeId))return false;
    return this.owned(owner,tradeId,fence)[1].core.phase===3;
  }
  resume(owner: string, tradeId: string, fence: number): void { this.owned(owner,tradeId,fence)[1].verifier.resume(); }
  async accept(owner: string, tradeId: string, value: unknown, fence: number): Promise<VerificationAck> {
    const [id,entry] = this.owned(owner,tradeId,fence);
    if (entry.core.phase === 3) {
      const batch = inputBatch(value), existing = await this.store.find(id,batch.sequence);
      if (batch.sessionId === id && existing?.fingerprint === createHash('sha256').update(JSON.stringify(batch)).digest('hex')) return existing.acknowledgement;
      throw new DomainError('TRADE_SCENE_DONE', 'Your scene has finished. Waiting for your partner.', 409);
    }
    return entry.verifier.accept(value);
  }
  async checkpoint(owner: string, tradeId: string, fence?: number): Promise<{ bytes: Buffer; frame: number; sequence: number; done: boolean }> {
    const [id] = this.owned(owner,tradeId,fence);
    return this.exclusive(`scene:${id}`,async()=>{
      const [currentId,entry]=this.owned(owner,tradeId,fence);
      if(currentId!==id)throw new DomainError('SESSION_REPLACED','This trade resumed on another connection.',409);
      return this.capture(id,entry);
    });
  }
  // Hold the scene lock across persistence as well as worker reads. Closing a
  // worker while the checkpoint write awaits PostgreSQL invalidates its lease.
  private async capture(id:string,entry:Live):Promise<{bytes:Buffer;frame:number;sequence:number;done:boolean}>{
    const state=await entry.verifier.pauseCheckpoint();
    const bytes=Buffer.from(state.checkpoint);
    // Completed input/result pairs are immutable and already journaled. A
    // waiting player needs no live lease to download the final checkpoint.
    if (entry.core.phase!==3) await this.store.checkpoint(id,entry.fence,{ bytes,frame:state.frame,sequence:state.sequence });
    return { bytes,frame:state.frame,sequence:state.sequence,done:entry.core.phase===3 };
  }
  private async release(id:string,entry:Live,expireLease=false):Promise<void>{
    if(this.live.get(id)!==entry)return;
    this.live.delete(id);
    try{await entry.verifier.close();}
    finally{if(expireLease)await this.store.expireLease(id,entry.fence);}
  }
  private async retire(id:string,entry:Live):Promise<void>{
    await this.exclusive(`scene:${id}`,()=>this.release(id,entry));
  }
  private async retireTrade(tradeId:string):Promise<void>{
    for(const [id,entry] of [...this.live])if(entry.tradeId===tradeId)await this.retire(id,entry);
  }
  async finish(owner: string, tradeId: string): Promise<{ done: boolean; receipt?: TradeReceipt }> {
    return this.exclusive(`finish:${tradeId}`,async()=> {
    const view = await this.offers.get(owner,tradeId);
    const prior = await this.repository.receipt(tradeId);
    if (prior) { await this.retireTrade(tradeId);return { done:true,receipt:prior }; }
    if (view.status==='cancelled' || view.status==='expired')
      throw new DomainError('TRADE_CANCELLED','This trade ended without changing either adventure. Return to the lobby.',409);
    const completed = await this.store.completed(tradeId);
    if (completed.length !== 2) return { done:false };
    let trade;
    try { trade = await this.repository.reserved(tradeId,owner,view.offerRevision); }
    catch (error) {
      const raced=await this.repository.receipt(tradeId);
      if (raced) { await this.retireTrade(tradeId);return { done:true,receipt:raced }; }
      throw error;
    }
    const a = completed.find(scene => scene.side==='a' && scene.ownerId===trade.saveA.ownerId && scene.adventureId===trade.saveA.id);
    const b = completed.find(scene => scene.side==='b' && scene.ownerId===trade.saveB.ownerId && scene.adventureId===trade.saveB.id);
    if (!a || !b) throw new DomainError('INVALID_TRADE_SCENE', 'The staged saves do not match this trade.', 503);
    const receipt = await this.repository.commit(trade,{ flashA:a.flash,flashB:b.flash,result:{ originalCScenes:true,offerRevision:trade.offerRevision } });
    await this.retireTrade(tradeId);
    return { done:true,receipt };
    });
  }
  async disconnect(owner: string, tradeId: string, fence: number): Promise<void> {
    const [id,entry] = this.owned(owner,tradeId,fence);
    await this.exclusive(`scene:${id}`,async()=>{
      if(this.live.get(id)!==entry)return;
      try { await this.capture(id,entry); }
      finally { await this.release(id,entry,true); }
    });
  }
  async cancel(owner: string, tradeId: string): Promise<void> {
    const view = await this.offers.get(owner,tradeId);
    if (view.status==='committing') await this.repository.release(tradeId);
    else if (view.status==='offered') await this.offers.cancel(owner,tradeId,view.offerRevision);
    else if (view.status==='committed') throw new DomainError('TRADE_COMMITTED', 'This trade has already finished.', 409);
    await this.retireTrade(tradeId);
  }
  async expire(): Promise<void> {
    for (const tradeId of await this.store.expired()) {
      await this.repository.release(tradeId);
      await this.retireTrade(tradeId);
    }
  }
  async close():Promise<void>{
    this.closing=true;let failure:unknown;
    // Let already-started opens/begins settle before taking the runtime list.
    // Queued opens recheck closing, so shutdown cannot acquire another worker.
    await Promise.allSettled([...this.locks.values()]);
    for(const [id,entry] of [...this.live]){
      try{await this.exclusive(`scene:${id}`,async()=>{
        if(this.live.get(id)!==entry)return;
        try{await entry.verifier.pauseMetadata();}catch{/* The committed journal survives an unavailable worker. */}
        finally{await this.release(id,entry,true);}
      });}catch(error){failure??=error;}
    }
    try{if(this.ownsPool)await this.pool.close();}catch(error){failure??=error;}
    if(failure)throw failure;
  }
}
