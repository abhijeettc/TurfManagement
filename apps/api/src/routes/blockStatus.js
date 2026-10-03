import { pool } from '@turfsync/db';
import { fromRange, localHhmm, localDateStr, PLATFORM_LABELS } from '@turfsync/core';
import { resolveVenue } from '../venue.js';
import { requireDevice } from '../auth/guard.js';
import { completeBlockTask } from '../blocking/worker.js';
import { notifyOwner } from '../ownerPhone.js';

/**
 * The tablet-facing bridge for TurfPro's in-app browser automation
 * (android-spike's NotificationListener/TurfProRunner), served directly from
 * this dashboard instead of from apps/slot-sync-aws's local-only bridge
 * (tools/local-server.mjs, port 8787 — see that file's own comment for why it
 * exists as a separate thing in local dev).
 *
 * Reuses the same `block_jobs` rows and the same `completeBlockTask` the
 * staff-facing `/api/sync-tasks` route uses — this is the identical assisted
 * pipeline, just consumed by the tablet's own browser instead of by a human
 * tapping a web page. Only TurfPro ever reaches this: Playo/Hudle/KheloMore
 * stay on `/api/sync-tasks`, per blocking/worker.js's top comment on why.
 *
 * Two callers, two auth modes:
 *   - the tablet (no session, only its device token) — `requireDevice`
 *   - the dashboard's own Blocking tab (a signed-in owner/staff session) — `resolveVenue`
 * `GET /status.json` accepts either, since both read it. The browser-report
 * POSTs are tablet-only; `/status/resolve` is dashboard-only, mirroring
 * `/api/sync-tasks/:id/complete`.
 */

// In-memory only, like the rate limiter — a tablet rediscovers "needs login"
// within one poll cycle (10s) if this is lost to a restart, so persistence
// buys nothing worth a migration.
const loginNeeded = new Set();

async function callerVenue(request) {
  if (request.headers['x-device-token']) {
    const { venue } = await requireDevice(request);
    return venue;
  }
  const { venue } = await resolveVenue(request, 'sync:read');
  return venue;
}

async function loadTurfproCourt(venueId, jobId) {
  const { rows } = await pool.query(
    `select j.id, j.state, b.slot, c.name as court_name
       from block_jobs j
       join bookings b on b.id = j.booking_id
       join courts c on c.id = b.court_id
      where j.id = $1 and b.venue_id = $2 and j.target_platform = 'turfpro'`,
    [jobId, venueId],
  );
  return rows[0] ?? null;
}

export default async function blockStatusRoutes(app) {
  app.get('/status.json', async (request) => {
    const venue = await callerVenue(request);

    const { rows: open } = await pool.query(
      `select j.id, b.slot, c.name as court_name
         from block_jobs j
         join bookings b on b.id = j.booking_id
         join courts c on c.id = b.court_id
        where b.venue_id = $1 and j.target_platform = 'turfpro' and j.state = 'submitted'
        order by j.priority, j.enqueued_at`,
      [venue.id],
    );

    const tasks = open.map((r) => {
      const { startMs, endMs } = fromRange(r.slot);
      return {
        id: r.id,
        action: 'block',
        kind: 'awaiting_browser',
        platform: 'turfpro',
        label: PLATFORM_LABELS.turfpro,
        court: r.court_name,
        date: localDateStr(startMs),
        from: localHhmm(startMs),
        to: localHhmm(endMs),
        slot: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
        loginNeeded: loginNeeded.has(r.id),
        detail: null,
      };
    });

    // One summary card, matching apps/web/public/app.js's appCard() shape —
    // Playo/Hudle/KheloMore/District never reach this route, so they are
    // reported switched off here regardless of their real platform_accounts
    // status; their own tasks still show correctly under the Alerts tab.
    const { rows: accountRows } = await pool.query(
      `select status from platform_accounts where venue_id = $1 and platform = 'turfpro'`,
      [venue.id],
    );
    const enabled = accountRows[0]?.status === 'active' && venue.auto_block_enabled;

    const [{ rows: verifiedCount }, { rows: failedCount }, { rows: recentRows }] = await Promise.all([
      pool.query(
        `select count(*)::int as n from block_jobs j join bookings b on b.id = j.booking_id
          where b.venue_id = $1 and j.target_platform = 'turfpro' and j.state = 'verified'`,
        [venue.id],
      ),
      pool.query(
        `select count(*)::int as n from block_jobs j join bookings b on b.id = j.booking_id
          where b.venue_id = $1 and j.target_platform = 'turfpro' and j.state = 'failed'`,
        [venue.id],
      ),
      pool.query(
        `select j.state, j.completed_at, j.enqueued_at, b.slot, c.name as court_name
           from block_jobs j
           join bookings b on b.id = j.booking_id
           join courts c on c.id = b.court_id
          where b.venue_id = $1 and j.target_platform = 'turfpro' and j.state in ('verified','failed')
          order by coalesce(j.completed_at, j.enqueued_at) desc
          limit 10`,
        [venue.id],
      ),
    ]);

    const recent = recentRows.map((r) => {
      const { startMs, endMs } = fromRange(r.slot);
      return {
        at: r.completed_at ?? r.enqueued_at,
        ground: r.court_name,
        date: localDateStr(startMs),
        slot: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
        outcome: r.state === 'verified' ? 'blocked' : 'failed',
      };
    });

    return {
      tasks,
      apps: [
        {
          key: 'turfpro',
          label: PLATFORM_LABELS.turfpro,
          enabled,
          counts: { blocked: verifiedCount[0].n, alreadyBlocked: 0, doubleBooked: 0, failed: failedCount[0].n },
          recent,
        },
      ],
    };
  });

  app.post('/status/browser-done', async (request, reply) => {
    const { venue } = await requireDevice(request);
    const id = request.body?.id;
    const job = id && (await loadTurfproCourt(venue.id, id));
    if (!job) return reply.code(404).send({ ok: false });

    loginNeeded.delete(id);
    await completeBlockTask({ jobId: id, venueId: venue.id, completedBy: 'tablet' }).catch((e) => {
      if (e.statusCode !== 409) throw e; // already completed — fine, the tablet may retry its own report
    });
    return { ok: true };
  });

  app.post('/status/browser-login-needed', async (request, reply) => {
    const { venue } = await requireDevice(request);
    const id = request.body?.id;
    const job = id && (await loadTurfproCourt(venue.id, id));
    if (!job) return reply.code(404).send({ ok: false });

    loginNeeded.add(id);
    return { ok: true };
  });

  app.post('/status/browser-failed', async (request, reply) => {
    const { venue } = await requireDevice(request);
    const { id, detail } = request.body ?? {};
    const job = id && (await loadTurfproCourt(venue.id, id));
    if (!job || job.state !== 'submitted') return reply.code(404).send({ ok: false });

    loginNeeded.delete(id);
    await pool.query(
      `update block_jobs set state = 'failed', last_error = $2, completed_at = now() where id = $1`,
      [id, detail ? String(detail).slice(0, 500) : 'the tablet could not complete this block'],
    );
    await notifyOwner(pool, venue.id, 'block_failed', {
      platform: PLATFORM_LABELS.turfpro,
      court: job.court_name,
      attempts: 0,
      error: detail ?? 'the tablet could not complete this block',
    });
    return { ok: true };
  });

  /** The dashboard's "Mark done" on a Blocking-tab card — a human finished it by hand. */
  app.post('/status/resolve', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'sync:complete');
    const completedBy = request.account?.name ?? null;
    const id = request.body?.id;

    const result = await completeBlockTask({ jobId: id, venueId: venue.id, completedBy }).catch((e) => {
      if (e.statusCode === 409) return null;
      throw e;
    });
    if (!result) return reply.code(404).send({ ok: false });
    return { ok: true };
  });
}
