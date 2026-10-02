import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../src/lib/adapters/registry.mjs';
import { MockAdapter } from '../src/lib/adapters/mock.mjs';

const fakePage = { goto: async () => {} };

test('getAdapter({mock: true}) returns a MockAdapter', () => {
  const adapter = getAdapter('turfpro', { mock: true });
  assert.ok(adapter instanceof MockAdapter);
});

test('MockAdapter blocks and reports state without touching a real platform', async () => {
  const adapter = getAdapter('turfpro', { mock: true });
  const slot = { courtName: 'Turf A', date: '2026-10-02', startTime: '19:00', endTime: '20:00' };

  assert.equal(await adapter.getSlotState(fakePage, slot), 'free');
  await adapter.blockSlot(fakePage, slot);
  assert.equal(await adapter.getSlotState(fakePage, slot), 'blocked');
  await adapter.unblockSlot(fakePage, slot);
  assert.equal(await adapter.getSlotState(fakePage, slot), 'free');
});

test('turfpro is the only registered live adapter and implements the full interface', () => {
  const adapter = getAdapter('turfpro', { mock: false });
  assert.equal(adapter.id, 'turfpro');
  for (const method of ['login', 'isLoggedIn', 'getSlotState', 'blockSlot', 'unblockSlot', 'healthCheck']) {
    assert.equal(typeof adapter[method], 'function', `turfpro.${method}`);
  }
});

test('hudle, playo and khelomore are disabled: no job can drive them', () => {
  for (const platform of ['hudle', 'playo', 'khelomore', 'district']) {
    assert.throws(() => getAdapter(platform, { mock: false }), (err) => err.code === 'ADAPTER_UNKNOWN', platform);
  }
});
