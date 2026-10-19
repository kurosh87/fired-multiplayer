import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AtomicTrading, type ConfirmedTrade, type TradeReceipt, type TradeRepository, type TrustedTradeAdapter } from '../packages/trading/atomic-trade.ts';
import { DomainError } from '../packages/protocol/index.ts';
import { FLASH_BYTES } from '../packages/engine/runtime.ts';

function setup() {
  const trade: ConfirmedTrade = { id: 'trade-1', offerRevision: 3, confirmedA: true, confirmedB: true, expiresAt: 10000,
    saveA: { id: 'save-a', ownerId: 'alice', version: 'firered', revision: 1, flash: new Uint8Array(FLASH_BYTES).fill(1) },
    saveB: { id: 'save-b', ownerId: 'bob', version: 'leafgreen', revision: 2, flash: new Uint8Array(FLASH_BYTES).fill(2) },
    offerA: { partySlot: 0, pokemonDigest: 'a'.repeat(64), saveRevision: 1 },
    offerB: { partySlot: 0, pokemonDigest: 'b'.repeat(64), saveRevision: 2 } };
  let receipt: TradeReceipt | undefined; let commits = 0; let releases = 0;
  const repository: TradeRepository = {
    async receipt() { return receipt; },
    async reserve(_id, owner) { if (owner !== 'alice' && owner !== 'bob') throw new DomainError('TRADE_NOT_FOUND','Not found',404); return trade; },
    async commit(_trade, result) {
      commits++;
      trade.saveA.flash = result.flashA; trade.saveB.flash = result.flashB;
      receipt = { tradeId: trade.id, revisionA: 2, revisionB: 3, result: result.result }; return receipt;
    },
    async release() { releases++; },
  };
  // Contract test adapter, not a Pokémon save editor. Production remains disabled
  // until the original game's trading/evolution/checksum adapter exists.
  const adapter: TrustedTradeAdapter = { async swap(value) { return { flashA: value.saveB.flash.slice(), flashB: value.saveA.flash.slice(), result: { testContract: true } }; } };
  return { trade, repository, adapter, service: new AtomicTrading(repository,adapter,() => 0), commits: () => commits, releases: () => releases };
}

test('a confirmed trade returns the existing receipt on retries without transferring twice', async () => {
  const { service, trade, commits } = setup();
  const result = await service.complete(trade.id, 'alice', 3);
  assert.deepEqual(await service.complete(trade.id, 'bob', 3), result);
  assert.equal(commits(), 1);
  assert.equal(trade.saveA.flash[0], 2); assert.equal(trade.saveB.flash[0], 1);
  await assert.rejects(service.complete(trade.id, 'eve', 3), { code: 'TRADE_NOT_FOUND' });
});

test('changed offers or missing confirmation cannot commit a trade', async () => {
  const { service, trade, commits, releases } = setup();
  trade.confirmedB = false;
  await assert.rejects(service.complete(trade.id,'alice',3), { code: 'TRADE_CHANGED' });
  trade.confirmedB = true;
  await assert.rejects(service.complete(trade.id,'alice',2), { code: 'TRADE_CHANGED' });
  assert.equal(commits(), 0); assert.equal(releases(), 2);
});

test('expired offers and malformed engine output leave both saves untouched', async () => {
  const { service, trade, adapter, commits, releases } = setup();
  trade.expiresAt = -1;
  await assert.rejects(service.complete(trade.id,'alice',3), { code: 'TRADE_EXPIRED' });
  trade.expiresAt = 10000;
  adapter.swap = async () => ({ flashA: new Uint8Array(1), flashB: new Uint8Array(1), result: {} });
  await assert.rejects(service.complete(trade.id,'alice',3), { code: 'ENGINE_ABI_ERROR' });
  assert.equal(trade.saveA.flash[0], 1); assert.equal(trade.saveB.flash[0], 2);
  assert.equal(commits(), 0); assert.equal(releases(), 2);
});

test('trade engine failure never commits either speculative save', async () => {
  const { service, trade, adapter, commits, releases } = setup();
  adapter.swap = async () => { throw new Error('Trade worker disconnected'); };
  await assert.rejects(service.complete(trade.id,'alice',3), /Trade worker disconnected/);
  assert.equal(commits(), 0); assert.equal(releases(), 1);
});
