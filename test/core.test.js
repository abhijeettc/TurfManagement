import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slotFromCalendarDate, slotFromBusinessDate, businessDateOf, localHhmm,
  localDateStr, durationMinutes, dedupeKey, commissionPaise, formatINR,
  formatINRCompact, normalizePhone, maskPhone,
} from '@turfsync/core';

test('a slot that crosses midnight is one contiguous range, not a negative one', () => {
  const { startMs, endMs } = slotFromCalendarDate('2026-09-02', '23:30', '01:00');
  assert.equal(durationMinutes(startMs, endMs), 90);
  assert.equal(localHhmm(startMs), '23:30');
  assert.equal(localHhmm(endMs), '01:00');
  assert.equal(localDateStr(startMs), '2026-09-02');
  assert.equal(localDateStr(endMs), '2026-09-03');
});

test('01:30 on Thursday morning is Wednesday night business', () => {
  const { startMs } = slotFromCalendarDate('2026-09-03', '01:30', '02:30');
  assert.equal(businessDateOf(startMs, 6), '2026-09-02');
});

test('19:00 belongs to its own calendar day', () => {
  const { startMs } = slotFromCalendarDate('2026-09-02', '19:00', '20:00');
  assert.equal(businessDateOf(startMs, 6), '2026-09-02');
});

test('a business date plus an after-midnight time resolves to the next calendar day', () => {
  const { startMs } = slotFromBusinessDate('2026-09-02', '01:00', '02:00');
  assert.equal(localDateStr(startMs), '2026-09-03');
  assert.equal(businessDateOf(startMs, 6), '2026-09-02');
});

test('the same slot on two courts produces two different keys', () => {
  const a = dedupeKey({ platform: 'playo', courtId: 'court-1', businessDate: '2026-09-02', startIso: 'x' });
  const b = dedupeKey({ platform: 'playo', courtId: 'court-2', businessDate: '2026-09-02', startIso: 'x' });
  assert.notEqual(a, b);
});

test('a resold slot does not collide with the cancelled booking it replaced', () => {
  // Finding 2: the spec's key is identical for both, so the upsert silently
  // overwrites the cancellation.
  const base = { platform: 'playo', externalCourtId: 'Turf A', businessDate: '2026-09-02', startIso: '2026-09-02T13:30:00Z' };
  assert.notEqual(dedupeKey({ ...base, rebookSeq: 0 }), dedupeKey({ ...base, rebookSeq: 1 }));
});

test("a platform's own booking id wins over the slot hash", () => {
  const key = dedupeKey({ externalBookingId: 'PLY-4471902', platform: 'playo', businessDate: '2026-09-02', startIso: 'x' });
  assert.equal(key, 'ext:playo:PLY-4471902');
});

test('the notification and the confirmation email for one booking share a key', () => {
  const fromNotification = dedupeKey({ externalBookingId: 'KM-8841207', platform: 'khelomore', businessDate: '2026-09-02', startIso: 'a' });
  const fromEmail = dedupeKey({ externalBookingId: 'KM-8841207', platform: 'khelomore', businessDate: '2026-09-02', startIso: 'b' });
  assert.equal(fromNotification, fromEmail);
});

test('commission is basis points, rounded to the paise', () => {
  assert.equal(commissionPaise(150000, 1500), 22500);   // ₹1,500 at 15% = ₹225
  assert.equal(commissionPaise(110000, 1400), 15400);   // ₹1,100 at 14% = ₹154
  assert.equal(commissionPaise(100000, 1450), 14500);   // a negotiated 14.5%
  assert.equal(commissionPaise(150000, 0), 0);
});

test('money formats with Indian digit grouping', () => {
  assert.equal(formatINR(150000), '₹1,500');
  assert.equal(formatINR(12_40_000_00), '₹12,40,000');
  assert.equal(formatINRCompact(12_40_000_00), '₹12.4L');
  assert.equal(formatINR(null), '—');
});

test('phone numbers normalise to E.164 and mask for display', () => {
  assert.equal(normalizePhone('9812345420'), '+919812345420');
  assert.equal(normalizePhone('+91 98123 45420'), '+919812345420');
  assert.equal(normalizePhone('09812345420'), '+919812345420');
  assert.equal(maskPhone('+919812345420'), '+91 98••• ••420');
});
