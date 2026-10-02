import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeKey } from '../src/lib/dedupe.mjs';

// claimEvent() itself needs a real DynamoDB endpoint (no local mock here — see
// test/adapters.registry.test.mjs and courtMapping.test.mjs for what's
// exercised without AWS). This just confirms the re-export from
// @turfsync/core/dedupe.js — already covered fully in that package's own
// tests — is wired correctly for this app's imports.

test('dedupeKey prefers the external booking id when present', () => {
  const key = dedupeKey({ externalBookingId: 'HUDLE-123', platform: 'hudle' });
  assert.equal(key, 'ext:hudle:HUDLE-123');
});

test('dedupeKey falls back to a slot hash when there is no external id', () => {
  const key = dedupeKey({
    platform: 'playo',
    externalCourtId: 'Turf A',
    businessDate: '2026-10-02',
    startIso: '2026-10-02T13:30:00.000Z',
  });
  assert.match(key, /^slot:[0-9a-f]{32}#0$/);
});
