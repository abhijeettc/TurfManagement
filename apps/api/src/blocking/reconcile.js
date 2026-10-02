import { pool } from '@turfsync/db';
import { fromRange } from '@turfsync/core';
import { getAdapter } from './adapter.js';

/**
 * Compare what we believe is blocked against what a platform's own calendar
 * reports. Pure function — no Postgres, no adapter — so the two drift kinds
 * (a booking we hold that the platform shows free; a range the platform shows
 * blocked that we have no booking for) are testable with plain arrays.
 *
 * @param {Array<{courtId: string, startMs: number, endMs: number, bookingId: string}>} ourBookings
 * @param {Array<{courtId: string, startMs: number, endMs: number}>} remoteRanges
 */
export function diffCalendar(ourBookings, remoteRanges) {
  const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;

  const drift = [];

  for (const booking of ourBookings) {
    const covered = remoteRanges.some(
      (r) => r.courtId === booking.courtId && overlaps(r, booking),
    );
    if (!covered) {
      drift.push({
        kind: 'missing_block',
        courtId: booking.courtId,
        bookingId: booking.bookingId,
        startMs: booking.startMs,
        endMs: booking.endMs,
      });
    }
  }

  for (const remote of remoteRanges) {
    const explained = ourBookings.some(
      (b) => b.courtId === remote.courtId && overlaps(b, remote),
    );
    if (!explained) {
      drift.push({
        kind: 'unexpected_block',
        courtId: remote.courtId,
        startMs: remote.startMs,
        endMs: remote.endMs,
      });
    }
  }

  return drift;
}

/**
 * The nightly run for one venue/platform pair: read our confirmed bookings on
 * every court mapped to this platform, read the platform's own calendar for
 * the same window, diff them, and record the result.
 *
 * This is the safety net — the thing that catches a booking the listener
 * missed, or a block that silently fell off a platform's calendar overnight.
 *
 * NOT called automatically by anything in production right now. It depends on
 * `adapter.readCalendar()`, which — same as `blockSlot`/`unblockSlot` — is an
 * automated read of a partner dashboard, and 06-Multi-Platform-Channel-Sync.md
 * §8 rules that out for v1 without the platform's written consent. The
 * function and its tests stay: it is exactly what a future official-API or
 * consented adapter would plug into, unchanged. Until then, doc 06 §6.1's
 * "daily channel drift check" — staff manually confirm the next few days
 * match on each partner app — is the safe substitute, and is not yet built.
 */
export async function reconcileVenuePlatform({ venueId, platform, windowDays = 3, mock = false }) {
  const startedAt = Date.now();
  const fromMs = Date.now() - 2 * 3_600_000; // small look-back for anything just missed
  const toMs = Date.now() + windowDays * 86_400_000;

  const { rows: runRows } = await pool.query(
    `insert into reconciliation_runs (venue_id, platform, started_at) values ($1,$2,now()) returning id`,
    [venueId, platform],
  );
  const runId = runRows[0].id;

  try {
    const { rows: mappings } = await pool.query(
      `select c.id as court_id, m.external_court_id
         from court_mappings m
         join courts c on c.id = m.court_id
        where c.venue_id = $1 and m.platform = $2 and m.external_court_id is not null`,
      [venueId, platform],
    );

    // Deliberately NOT filtered to bookings that originated on this platform.
    // Every confirmed booking on a court mapped to `platform` should show as
    // blocked on that platform's own calendar — whether the platform sold it
    // itself, or we blocked it there on behalf of a booking from somewhere
    // else. Filtering by origin would miss exactly the drift write-back is
    // meant to catch: our own block silently falling off their calendar.
    if (!mappings.length) {
      await pool.query(
        `update reconciliation_runs set finished_at = now(), bookings_checked = 0 where id = $1`,
        [runId],
      );
      return { runId, bookingsChecked: 0, drift: [], durationMs: Date.now() - startedAt };
    }

    const courtIds = mappings.map((m) => m.court_id);
    const { rows: bookingRows } = await pool.query(
      `select b.id as booking_id, b.court_id, b.slot
         from bookings b
        where b.venue_id = $1 and b.court_id = any($2::uuid[]) and b.status = 'confirmed'
          and lower(b.slot) < $4::timestamptz and upper(b.slot) > $3::timestamptz`,
      [venueId, courtIds, new Date(fromMs), new Date(toMs)],
    );

    const ourBookings = bookingRows.map((b) => {
      const { startMs, endMs } = fromRange(b.slot);
      return { courtId: b.court_id, bookingId: b.booking_id, startMs, endMs };
    });

    const adapter = getAdapter(platform, { mock });
    const remoteRanges = [];
    for (const m of mappings) {
      const ranges = await adapter.readCalendar({ externalCourtId: m.external_court_id, fromMs, toMs });
      for (const r of ranges) remoteRanges.push({ courtId: m.court_id, startMs: r.startMs, endMs: r.endMs });
    }

    const drift = diffCalendar(ourBookings, remoteRanges);

    await pool.query(
      `update reconciliation_runs
          set finished_at = now(), bookings_checked = $2, drift = $3
        where id = $1`,
      [runId, ourBookings.length, JSON.stringify(drift)],
    );

    return { runId, bookingsChecked: ourBookings.length, drift, durationMs: Date.now() - startedAt };
  } catch (error) {
    await pool.query(
      `update reconciliation_runs set finished_at = now(), error = $2 where id = $1`,
      [runId, error.message],
    );
    throw error;
  }
}

/** Runs every mapped platform for every auto-block-enabled venue. Meant to be
 * called once a night by a scheduler in the worker process. */
export async function reconcileAllVenues({ mock = false } = {}) {
  const { rows } = await pool.query(
    `select distinct v.id as venue_id, m.platform
       from venues v
       join courts c on c.venue_id = v.id
       join court_mappings m on m.court_id = c.id
      where v.auto_block_enabled = true and m.external_court_id is not null`,
  );

  const results = [];
  for (const row of rows) {
    try {
      results.push(await reconcileVenuePlatform({ venueId: row.venue_id, platform: row.platform, mock }));
    } catch (error) {
      results.push({ venueId: row.venue_id, platform: row.platform, error: error.message });
    }
  }
  return results;
}
