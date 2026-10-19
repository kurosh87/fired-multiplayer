import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattleSession, type BattleChoice, type TrustedBattleAdapter } from '../packages/battles/session.ts';

function setup() {
  let now = 0; let resolutions = 0;
  const adapter: TrustedBattleAdapter = {
    legalChoices: () => [{ kind: 'move', slot: 0 }],
    async resolve() { resolutions++; return { events: [{ kind: 'turn', data: { complete: true }, audience: 'both' },
      { kind: 'private', data: { side: 'a' }, audience: 'a' }] }; },
  };
  const battle = new BattleSession({ a: 'alice', b: 'bob' }, adapter, () => now);
  return { battle, adapter, elapse: (milliseconds: number) => { now += milliseconds; }, resolutions: () => resolutions };
}
const move: BattleChoice = { kind: 'move', slot: 0 };

test('neither pending choice is revealed or resolved until both players commit', async () => {
  const { battle, resolutions } = setup();
  await battle.submit('alice', 0, 'alice-0', move);
  assert.equal(resolutions(), 0);
  assert.equal(battle.state('bob').submitted, false);
  assert.deepEqual(battle.state('bob').events, []);
  await battle.submit('bob', 0, 'bob-0', move);
  assert.equal(resolutions(), 1);
  assert.equal(battle.state('alice').turn, 1);
  assert.equal(battle.state('alice').events.length, 2);
  assert.equal(battle.state('bob').events.length, 1);
});

test('battle retries are idempotent; illegal actions and outsiders are rejected', async () => {
  const { battle, resolutions } = setup();
  await battle.submit('alice', 0, 'alice-0', move);
  await battle.submit('alice', 0, 'alice-0', move);
  await assert.rejects(battle.submit('alice', 0, 'alice-0', { kind: 'move', slot: 1 }), { code: 'ACTION_CONFLICT' });
  await assert.rejects(battle.submit('eve', 0, 'eve-0', move), { code: 'BATTLE_NOT_FOUND' });
  await assert.rejects(battle.submit('bob', 0, 'bob-0', { ...move, damage: 999 } as BattleChoice), { code: 'ILLEGAL_BATTLE_ACTION' });
  await battle.submit('bob', 0, 'bob-0', move);
  await battle.submit('bob', 0, 'bob-0', move);
  assert.equal(resolutions(), 1);
});

test('reconnect within sixty seconds preserves a battle; expiry forfeits it', () => {
  const { battle, elapse } = setup();
  battle.disconnect('alice'); elapse(59000); battle.checkTimeouts();
  assert.equal(battle.state('alice').result, undefined);
  battle.reconnect('alice'); elapse(500); battle.checkTimeouts();
  assert.equal(battle.state('alice').result, undefined);
  battle.disconnect('alice'); elapse(60000); battle.checkTimeouts();
  assert.deepEqual(battle.state('bob').result, { winner: 'b', reason: 'disconnect' });
});

test('a trainer who submits before the turn deadline wins against a timeout', async () => {
  const { battle, elapse } = setup();
  await battle.submit('alice', 0, 'alice-0', move);
  elapse(90000); battle.checkTimeouts();
  assert.deepEqual(battle.state('alice').result, { winner: 'a', reason: 'timeout' });
});

test('an uncertain battle engine failure cannot produce a fabricated winner', async () => {
  const { battle, adapter } = setup();
  adapter.resolve = async () => { throw new Error('Worker failed'); };
  await battle.submit('alice', 0, 'alice-0', move);
  await assert.rejects(battle.submit('bob', 0, 'bob-0', move), { code: 'BATTLE_RECOVERY_REQUIRED' });
  assert.deepEqual(battle.state('alice').result, { winner: null, reason: 'engine_error' });
});
