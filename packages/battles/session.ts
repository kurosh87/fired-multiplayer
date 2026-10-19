import { assertRecord, DomainError } from '../protocol/index.ts';

export type Side = 'a' | 'b';
export type BattleChoice = { kind: 'move'; slot: number } | { kind: 'switch'; slot: number };
export type BattleEvent = { kind: string; data: Record<string, unknown>; audience: 'a'|'b'|'both' };
export type BattleResult = { winner: Side | null; reason: 'finished'|'forfeit'|'disconnect'|'timeout'|'engine_error' };
export interface TrustedBattleAdapter {
  legalChoices(side: Side): readonly BattleChoice[];
  resolve(a: BattleChoice, b: BattleChoice): Promise<{ events: BattleEvent[]; winner?: Side | null }>;
}

export class BattleSession {
  private players: { a: string; b: string };
  private engine: TrustedBattleAdapter;
  private clock: () => number;
  private deadline: number;
  private pending: Partial<Record<Side, { operationId: string; choice: BattleChoice }>> = {};
  private disconnected: Partial<Record<Side, number>> = {};
  private receipts = new Map<string, { ownerId: string; turn: number; choice: string }>();
  private tail: Promise<unknown> = Promise.resolve();
  private turnNumber = 0;
  private outcome: BattleResult | undefined;
  private events: BattleEvent[] = [];

  constructor(players: { a: string; b: string }, engine: TrustedBattleAdapter, clock: () => number = Date.now) {
    if (players.a === players.b) throw new DomainError('INVALID_BATTLE', 'Choose another trainer.');
    this.players = players; this.engine = engine; this.clock = clock; this.deadline = clock() + 90000;
  }

  private side(ownerId: string): Side {
    if (this.players.a === ownerId) return 'a';
    if (this.players.b === ownerId) return 'b';
    throw new DomainError('BATTLE_NOT_FOUND', 'The battle was not found.', 404);
  }

  state(ownerId: string) {
    const side = this.side(ownerId);
    return { turn: this.turnNumber, deadline: this.deadline, submitted: Boolean(this.pending[side]),
      result: this.outcome, events: structuredClone(this.events.filter(event => event.audience === side || event.audience === 'both')) };
  }

  submit(ownerId: string, turn: number, operationId: string, choice: BattleChoice): Promise<void> {
    const task = this.tail.then(async () => {
      const side = this.side(ownerId);
      this.checkTimeouts();
      assertRecord(choice);
      if (Object.keys(choice).some(key => key !== 'kind' && key !== 'slot')
        || !['move','switch'].includes(choice.kind) || !Number.isInteger(choice.slot)
        || choice.slot < 0 || choice.slot > (choice.kind === 'move' ? 3 : 5)
        || !Number.isSafeInteger(turn) || turn < 0
        || typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 100) throw new DomainError('ILLEGAL_BATTLE_ACTION', 'Invalid battle action.');
      const encoded = JSON.stringify({ kind: choice.kind, slot: choice.slot });
      const previous = this.receipts.get(operationId);
      if (previous) {
        if (previous.ownerId !== ownerId || previous.turn !== turn || previous.choice !== encoded) throw new DomainError('ACTION_CONFLICT', 'An action cannot be rewritten.', 409);
        return;
      }
      if (this.outcome) throw new DomainError('BATTLE_FINISHED', 'The battle has already finished.', 409);
      if (turn !== this.turnNumber || this.pending[side]) throw new DomainError('TURN_CHANGED', 'Wait for the next battle decision.', 409);
      if (!this.engine.legalChoices(side).some(legal => legal.kind === choice.kind && legal.slot === choice.slot)) throw new DomainError('ILLEGAL_BATTLE_ACTION', 'That action is not available.');
      this.pending[side] = { operationId, choice };
      this.receipts.set(operationId, { ownerId, turn, choice: encoded });
      if (this.pending.a && this.pending.b) {
        try {
          const resolved = await this.engine.resolve(this.pending.a.choice, this.pending.b.choice);
          this.events = resolved.events;
          this.pending = {}; this.turnNumber++; this.deadline = this.clock() + 90000;
          if (!this.outcome && resolved.winner !== undefined) this.outcome = { winner: resolved.winner, reason: 'finished' };
        } catch {
          this.outcome = { winner: null, reason: 'engine_error' };
          throw new DomainError('BATTLE_RECOVERY_REQUIRED', 'The battle engine stopped. No adventure progress was changed.', 503);
        }
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  disconnect(ownerId: string): void { this.disconnected[this.side(ownerId)] = this.clock(); }
  reconnect(ownerId: string): void { delete this.disconnected[this.side(ownerId)]; }
  forfeit(ownerId: string): void {
    if (!this.outcome) this.outcome = { winner: this.side(ownerId) === 'a' ? 'b' : 'a', reason: 'forfeit' };
  }
  checkTimeouts(): void {
    if (this.outcome) return;
    const expired = (['a','b'] as const).filter(side => this.disconnected[side] !== undefined && this.clock() - this.disconnected[side]! >= 60000);
    if (expired.length) this.outcome = { winner: expired.length === 2 ? null : expired[0] === 'a' ? 'b' : 'a', reason: 'disconnect' };
    else if (this.clock() >= this.deadline) this.outcome = { winner: this.pending.a ? 'a' : this.pending.b ? 'b' : null, reason: 'timeout' };
  }
}
