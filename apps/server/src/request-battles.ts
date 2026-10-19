import { randomBytes } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Database } from './database.ts';
import { BattleRepository } from './battle-repository.ts';
import { BattleRunStore, type BattleProgress } from './battle-run-store.ts';
import { RequestBattleStore, type RequestBattleClaim, type RequestClockReader } from './request-battle-store.ts';
import { DomainError } from '../../../packages/protocol/index.ts';
import type { EngineRegistry } from '../../../packages/engine/registry.ts';
import { BattleConsolePool,type BattleRequestConsole } from '../../../packages/battles/console-pool.ts';
import type { BattleArtifact } from '../../../packages/battles/original-pair.ts';
import { BattleScreenEncoder, BattleScreenDecoder } from '../../../packages/battles/screen.ts';
import { encodeBattleResponse, requestBattleInput, type RequestBattleBootstrap, type RequestBattleConnection, type RequestBattleMetadata } from '../../../packages/battles/request-protocol.ts';
import { spendRequestClock } from '../../../packages/battles/request-clock.ts';

const compress = promisify(gzip), decompress = promisify(gunzip);
export type RequestBattleOptions = { clock?: RequestClockReader; entropy?: () => number; workerFactory?: () => BattleRequestConsole; deadlineMs?: number };

/** No live console survives a request. Warm code may be cached by the host,
 * but every acknowledged state is fully recoverable from its SQL transaction. */
export class RequestBattles {
  readonly repository: BattleRepository;
  readonly store: RequestBattleStore;
  private database: Database;
  private registry: EngineRegistry;
  private options: RequestBattleOptions;
  constructor(database: Database, registry: EngineRegistry, options: RequestBattleOptions = {}) {
    this.database = database; this.registry = registry; this.options = options;
    this.store = new RequestBattleStore(database, options.clock);
    this.repository = new BattleRepository(database, saves => { for (const save of saves) registry.manifest(save.version); });
    if (options.deadlineMs !== undefined && (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1000 || options.deadlineMs > 10000)) throw new Error('Invalid request computation deadline.');
  }
  async requireTrainer(owner: string): Promise<void> {
    if (!await this.database.profile(owner)) throw new DomainError('ACCOUNT_PROFILE_REQUIRED','Reserve your trainer name before playing online.',409);
  }
  private artifacts(versions: Parameters<EngineRegistry['manifest']>[0][], ids: [string,string], seed: number): [BattleArtifact,BattleArtifact] {
    return versions.map((version, side) => {
      const manifest = this.registry.manifest(version);
      if (manifest.id !== ids[side]) throw new DomainError('BATTLE_ENGINE_PINNED','This battle requires its original artifacts.',503);
      return { manifest, bytes: this.registry.artifact(version), seed };
    }) as [BattleArtifact,BattleArtifact];
  }
  async get(owner: string, id: string): Promise<RequestBattleBootstrap> {
    return { protocol: 1, battle: await this.repository.get(owner,id), ...await this.store.counters(owner,id) };
  }
  async open(owner: string, id: string, connectionId: string, expectedEpoch:number): Promise<RequestBattleConnection> {
    const controller=await this.store.open(owner,id,connectionId,expectedEpoch);
    return {...await this.get(owner,id),controller};
  }
  async accept(owner: string, id: string): Promise<RequestBattleBootstrap> {
    const view = await this.repository.get(owner,id), versions = [view.playerA.version,view.playerB.version];
    const ids = versions.map(version=>this.registry.manifest(version).id) as [string,string];
    const reserved = await this.repository.reserve(owner,id,ids,this.options.entropy?.() ?? randomBytes(4).readUInt32LE());
    try { return await this.get(owner,id); } catch (error) { if (!(error instanceof DomainError) || error.code !== 'BATTLE_RUN_NOT_FOUND') throw error; }
    const pool = this.options.workerFactory?.() ?? new BattleConsolePool(1);
    const timeout = setTimeout(()=>void pool.abort(),this.options.deadlineMs ?? 8000).unref();
    try {
      const pair = await pool.create(this.artifacts(versions,reserved.artifacts,reserved.seed),[reserved.saveA.flash,reserved.saveB.flash]);
      const points = await pair.checkpoint(), screens = await pair.screens(['a','b']);
      const caches = await Promise.all(screens.map(pixels=>compress(new BattleScreenEncoder().encode(pixels,0)!,{level:1}))) as [Buffer,Buffer];
      await new BattleRunStore(this.database).initialize(reserved,points);
      await this.store.attach(owner,id,caches);
      return await this.get(owner,id);
    } catch(error) { await this.repository.releaseStarting(id).catch(()=>{}); throw error; }
    finally { clearTimeout(timeout); await pool.close(); }
  }
  async step(owner: string, id: string, value: unknown): Promise<Buffer> {
    const input = requestBattleInput(value), claimed = await this.store.claim(owner,id,input);
    if ('receipt' in claimed) return claimed.receipt;
    const claim = claimed.claim, pool = this.options.workerFactory?.() ?? new BattleConsolePool(1);
    const timeout = setTimeout(()=>void pool.abort(),this.options.deadlineMs ?? 8000).unref();
    try { return await this.computeAndCommit(claim,pool); }
    catch (error) { await this.store.release(claim).catch(()=>{}); throw error; }
    finally { clearTimeout(timeout); await pool.close(); }
  }
  private async computeAndCommit(claim: RequestBattleClaim, pool: BattleRequestConsole): Promise<Buffer> {
    const run = claim.run, frame = Number(run.frame), caches: [Buffer,Buffer] = [claim.state.screen_a,claim.state.screen_b];
    const encoders = [new BattleScreenEncoder(),new BattleScreenEncoder()], packets: Uint8Array[][] = [[],[]];
    // Cached pictures are compressed personal keyframes, not memory snapshots.
    const initial = await Promise.all(caches.map(cache=>decompress(cache,{maxOutputLength:153624})));
    for (const [side, packet] of initial.entries()) {
      const decoder = new BattleScreenDecoder(); decoder.apply(packet);
      if (decoder.frame !== frame) throw new DomainError('BATTLE_SCREEN_INVALID','The saved battle picture has the wrong frame.',503);
      packets[side]!.push(encoders[side]!.encode(new Uint8Array(decoder.pixels),frame)!);
    }
    let end = frame, decision = claim.decision, result = claim.terminal, engineResult = run.engine_result ?? undefined;
    let points: [Buffer,Buffer] | undefined, buttons: [number,number] = [run.buttons_a,run.buttons_b];
    const entries: BattleProgress[] = [];
    if (claim.frames) {
      if (Number(run.checkpoint_frame ?? 0) !== frame || Number(run.checkpoint_sequence ?? 0) !== Number(run.next_sequence))
        throw new DomainError('BATTLE_CHECKPOINT_INVALID','The request-driven battle requires its complete checkpoint.',503);
      const pair = await pool.restore(this.artifacts([run.version_a,run.version_b],[run.artifact_a,run.artifact_b],Number(run.seed)),frame,
        run.checkpoint_a ? [run.checkpoint_a,run.checkpoint_b!] : [run.initial_checkpoint_a,run.initial_checkpoint_b]);
      const restored = await pair.screens(['a','b']);
      for (const [side,pixels] of restored.entries()) {
        const decoder = new BattleScreenDecoder(); decoder.apply(initial[side]!);
        if (!Buffer.from(decoder.pixels).equals(Buffer.from(pixels))) throw new DomainError('BATTLE_CHECKPOINT_INVALID','The restored battle picture differs from its checkpoint.',503);
      }
      await pair.progress();
      while (end < frame + claim.frames && !pair.done) {
        const own = (['a','b'] as const).map(side=>claim.inputs.find(input=>input.side===side && input.start<=end && input.end>end));
        // Lack of a button packet is neutral input. A peer cannot freeze the
        // shared clock or another trainer's valid selection by withholding it.
        buttons = [own[0]?.buttons??0,own[1]?.buttons??0];
        const count = Math.min(4-(end%4),frame+claim.frames-end,(own[0]?.end??frame+claim.frames)-end,(own[1]?.end??frame+claim.frames)-end), start = end;
        for (const current of await pair.advance(buttons,count)) {
          decision = current.kind === decision.kind ? {...decision,mask:current.mask} : {
            kind:current.kind,mask:current.mask,epoch:decision.epoch+(current.kind===null?0:1),
            deadline:current.kind===null?null:Number(claim.nowUs/1000n)+90_000 };
          end++;
        }
        if (end <= start) throw new DomainError('BATTLE_ENGINE_FAILED','The battle did not advance its admitted frames.',503);
        const progress = await pair.progress();
        entries.push({sequence:Number(run.next_sequence)+entries.length,startFrame:start,ticks:end-start,buttons:[...buttons],...progress,state:{...decision},result:pair.result()});
        if (end%4===0 || end===frame+claim.frames || pair.done) {
          const screens = await pair.screens(['a','b']);
          for (const [side,pixels] of screens.entries()) { const packet=encoders[side]!.encode(pixels,end); if(packet)packets[side]!.push(packet); }
        }
      }
      engineResult = pair.result(); result = engineResult ?? result; points = await pair.checkpoint();
      const finalScreens = await pair.screens(['a','b']);
      const saved = await Promise.all(finalScreens.map(pixels=>compress(new BattleScreenEncoder().encode(pixels,end)!,{level:1})));
      caches[0]=saved[0]!;caches[1]=saved[1]!;
    }
    claim.inputThrough=[Math.max(end,claim.inputThrough[0]),Math.max(end,claim.inputThrough[1])];
    const metadata: RequestBattleMetadata = { protocol:1,battleId:run.battle_id,operationId:claim.request.operationId,sequence:claim.request.sequence,controller:claim.request.controller,
      nextSequence:claim.request.sequence+1,side:claim.side,frame:end,inputThrough:claim.inputThrough[claim.side==='a'?0:1],result };
    const response = await compress(encodeBattleResponse(metadata,packets[claim.side==='a'?0:1]!),{level:3});
    await this.store.commit(claim,{frame:end,points,caches,decision,entries,buttons,clock:spendRequestClock(claim.clock,end-frame),engineResult,result,response});
    return response;
  }
}
