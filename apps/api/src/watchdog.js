import { pool } from '@turfsync/db';
import { notifyOwner } from './ownerPhone.js';

/**
 * Finding 5 — a silent listener looks exactly like a quiet evening.
 *
 * An empty board is indistinguishable from a slow night, and the owner finds
 * out when two teams walk onto the same pitch. Two alarms:
 *
 *   1. No heartbeat for 20 minutes while the venue is open.
 *   2. A platform that normally produces bookings has gone quiet through peak.
 *
 * Capture rate is meaningless without liveness — which is why this runs even
 * when everything looks fine.
 */
const CHECK_INTERVAL_MS = 5 * 60_000;
const SILENT_AFTER_MIN = 20;

const alerted = new Map();

export function startWatchdog(log) {
  const timer = setInterval(() => check(log).catch((e) => log.error({ err: e }, 'watchdog failed')), CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function check(log = console) {
  const { rows: venues } = await pool.query(
    `select id, name, opens_at, closes_at from venues where status = 'active'`,
  );

  for (const venue of venues) {
    if (!isOpen(venue)) continue;

    const { rows } = await pool.query(
      `select device_label, received_at from device_heartbeats
        where venue_id = $1 order by received_at desc limit 1`,
      [venue.id],
    );

    const last = rows[0];
    const minutes = last ? Math.round((Date.now() - Date.parse(last.received_at)) / 60_000) : Infinity;

    if (minutes >= SILENT_AFTER_MIN) {
      // One alert per silence, not one every five minutes.
      if (alerted.get(venue.id)) continue;
      alerted.set(venue.id, true);
      log.warn?.({ venue: venue.name, minutes }, 'counter device silent');
      await notifyOwner(pool, venue.id, 'device_silent', {
        label: last?.device_label ?? 'The counter tablet',
        minutes: Number.isFinite(minutes) ? minutes : SILENT_AFTER_MIN,
      });
    } else {
      alerted.delete(venue.id);
    }
  }
}

function isOpen(venue) {
  // IST wall clock; venue.closes_at past midnight means the window wraps.
  const nowMin = Number(new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 13)) * 60
    + Number(new Date(Date.now() + 330 * 60_000).toISOString().slice(14, 16));
  const open = toMin(venue.opens_at);
  const close = toMin(venue.closes_at);
  return close > open ? nowMin >= open && nowMin < close : nowMin >= open || nowMin < close;
}

function toMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}
