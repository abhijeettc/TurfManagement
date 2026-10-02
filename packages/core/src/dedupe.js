import { createHash } from 'node:crypto';

/**
 * Idempotency key.
 *
 * Finding 2 in the build plan: the spec's `sha256(platform + court + date +
 * start_time)` collides when a slot is cancelled and resold. Same platform,
 * same court, same slot, different customer — identical key, so the upsert
 * overwrites the cancelled row. The cancellation disappears from the ledger and
 * the Phase 3 unblock never fires.
 *
 * So, in order of preference:
 *
 *   1. The platform's own booking id, when the payload carries one. Stable
 *      across the notification and the confirmation email, which is what lets
 *      the two channels enrich a single row rather than racing to create two.
 *   2. Otherwise the slot hash, suffixed with a rebook sequence. The sequence is
 *      resolved at persist time by counting how many rows already exist for that
 *      exact slot, so a resale becomes #1 rather than colliding with #0.
 */
export function dedupeKey({
  externalBookingId,
  platform,
  externalCourtId,
  courtId,
  businessDate,
  startIso,
  rebookSeq = 0,
}) {
  if (externalBookingId) {
    return `ext:${platform}:${String(externalBookingId).trim()}`;
  }

  const basis = [platform, externalCourtId || courtId, businessDate, startIso].join('|');
  const hash = createHash('sha256').update(basis).digest('hex').slice(0, 32);
  return `slot:${hash}#${rebookSeq}`;
}

/** True when this key was derived from a real platform booking id. */
export function isStableKey(key) {
  return typeof key === 'string' && key.startsWith('ext:');
}
