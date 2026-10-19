import { createHash } from 'node:crypto';
import { DomainError, FRAME_MILLISECONDS, inputBatch, type InputBatch, type VerificationAck } from '../protocol/index.ts';
import type {CompressedGameState,RawGameState} from '../engine/adventure-pool.ts';

type Awaitable<T>=T|Promise<T>;
export interface VerificationEngine{
  readonly frame:number;
  advance(runs:InputBatch['runs']):Awaitable<void>;
  digest():Awaitable<string>;
  snapshot():Awaitable<Uint8Array>;
  flash():Awaitable<Uint8Array>;
  capture?():Promise<RawGameState>;
  captureCheckpoint?():Promise<CompressedGameState>;
  close():Awaitable<void>;
}

export type JournalEntry = { batch: InputBatch; fingerprint: string; acknowledgement: VerificationAck };
export interface InputJournal {
  find(sessionId: string, sequence: number): Promise<JournalEntry | undefined>;
  append(sessionId: string, fence: number, entry: JournalEntry): Promise<void>;
}

export class SessionVerifier {
  private engine: VerificationEngine;
  private journal: InputJournal;
  private sessionId: string;
  private fence: number;
  private nextSequence: number;
  private clock: () => number;
  private budgetClock: number;
  private budgetFrames: number;
  private poisoned = false;
  private paused = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: { engine: VerificationEngine; journal: InputJournal; sessionId: string; fence: number; nextSequence?: number; clock?: () => number }) {
    this.engine = options.engine;
    this.journal = options.journal;
    this.sessionId = options.sessionId;
    this.fence = options.fence;
    this.nextSequence = options.nextSequence ?? 0;
    // The initial jitter allowance belongs to the first durable input batch.
    // Reconnects and lobby round trips must not mint another 15 free frames.
    this.budgetFrames = this.nextSequence === 0 ? 15 : 0;
    this.clock = options.clock ?? Date.now;
    this.budgetClock = this.clock();
  }

  accept(value: unknown): Promise<VerificationAck> {
    if (this.paused) return Promise.reject(new DomainError('SESSION_PAUSED', 'Resume the adventure before sending inputs.', 409));
    const task = this.tail.then(() => this.verify(value));
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async settle():Promise<void>{
    this.paused = true;
    await this.tail;
    if (this.poisoned) throw new DomainError('SESSION_RECOVERY_REQUIRED', 'Reconnect to restore verified progress.', 409);
  }
  async pause(): Promise<RawGameState&{sequence:number}> {
    await this.settle();
    try{
      const state=this.engine.capture?await this.engine.capture():{snapshot:await this.engine.snapshot(),frame:this.engine.frame,
        digest:await this.engine.digest(),flash:await this.engine.flash()};
      return {...state,sequence:this.nextSequence};
    }catch(error){await this.close();throw error;}
  }
  async pauseCheckpoint():Promise<CompressedGameState&{sequence:number}>{
    await this.settle();
    try{
      if(!this.engine.captureCheckpoint)throw new DomainError('ENGINE_ABI_ERROR','This verifier cannot create a compressed checkpoint.',503);
      return {...await this.engine.captureCheckpoint(),sequence:this.nextSequence};
    }catch(error){await this.close();throw error;}
  }
  async pauseMetadata():Promise<{frame:number;sequence:number;digest:string}>{
    await this.settle();
    try{return {frame:this.engine.frame,sequence:this.nextSequence,digest:await this.engine.digest()};}
    catch(error){await this.close();throw error;}
  }

  resume(): void {
    if (this.poisoned) throw new DomainError('SESSION_RECOVERY_REQUIRED', 'Reconnect to restore verified progress.', 409);
    if (!this.paused) return;
    // Pausing cannot mint a new jitter allowance or bank offline play time.
    this.budgetClock = this.clock();
    this.paused = false;
  }

  private async verify(value: unknown): Promise<VerificationAck> {
    if (this.poisoned) throw new DomainError('SESSION_RECOVERY_REQUIRED', 'Reconnect to restore verified progress.', 409);
    const batch = inputBatch(value);
    if (batch.sessionId !== this.sessionId) throw new DomainError('SESSION_MISMATCH', 'This input belongs to another session.', 403);
    const fingerprint = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const existing = await this.journal.find(this.sessionId, batch.sequence);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DomainError('INPUT_CONFLICT', 'An input sequence cannot be rewritten.', 409);
      return existing.acknowledgement;
    }
    if (batch.sequence !== this.nextSequence || batch.startFrame !== this.engine.frame) throw new DomainError('INPUT_OUT_OF_ORDER', 'Resume from the last verified frame.', 409);
    const frames = batch.runs.reduce((sum, run) => sum + run.frames, 0);
    const now = this.clock();
    const availableFrames = Math.min(75, this.budgetFrames + Math.max(0, now - this.budgetClock) / FRAME_MILLISECONDS);
    if (frames > Math.floor(availableFrames)) throw new DomainError('INPUT_TOO_FAST', 'Progress cannot advance faster than the game clock.', 429);
    try {
      this.budgetFrames = availableFrames - frames;
      this.budgetClock = now;
      await this.engine.advance(batch.runs);
      const acknowledgement: VerificationAck = {
        type: 'verified', protocol: 1, operationId: batch.operationId,
        sequence: batch.sequence, frame: this.engine.frame, digest: await this.engine.digest(),
      };
      // No acknowledgement can leave this method until the durable append commits.
      await this.journal.append(this.sessionId, this.fence, { batch, fingerprint, acknowledgement });
      this.nextSequence++;
      return acknowledgement;
    } catch (error) {
      // Never reuse speculative state after an uncertain persistence outcome.
      // The owner must reinstantiate and replay the committed journal.
      this.poisoned = true;
      await this.engine.close();
      throw error;
    }
  }

  async close():Promise<void>{this.poisoned=true;await this.engine.close();}
}
