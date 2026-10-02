import { Worker } from 'bullmq';
import { pool } from '@turfsync/db';
import { fromRange, localHhmm, PLATFORM_LABELS } from '@turfsync/core';
import { redisConnection } from './redis.js';
import { QUEUE_NAME, withVenueLock } from './queue.js';
import { expectEcho } from '../ingest/echo.js';
import { notifyOwner } from '../ownerPhone.js';
import { emitBoardChange } from '../bus.js';
import { afterVerified, afterKillSwitch, afterSuperseded } from './stateMachine.js';

/** How long a human gets before the first nudge. Matches the build plan's
 * assisted-task SLA (06 §6.1: 3 min to staff, then escalate). */
const TASK_SLA_MS = 3 * 60_000;

/**
 * Starts the block-job worker. A separate process from the API in production
 * (`node apps/api/src/worker-entry.js`) — the build plan's "isolated blast
 * radius" — though what it isolates now is a stuck Redis connection or a
 * flood of tasks, not a platform automation. TurfSync never logs into Playo,
 * Hudle or KheloMore itself: every block or unblock this worker "does" is a
 * tracked task for a human to carry out in that platform's own app. See
 * 06-Multi-Platform-Channel-Sync.md §8 for why — Playo requires written
 * consent for automated dashboard access and Hudle bans it outright for a
 * competing product, which TurfSync is. `adapter.js` still defines the
 * interface an official-API or consented integration would implement later;
 * nothing in this file calls it.
 */
export function startBlockWorker({ concurrency = 5 } = {}) {
  return new Worker(
    QUEUE_NAME,
    async (job) => {
      const { bookingId, targetPlatform, kind } = job.data;
      if (kind === 'block') return handleBlock(bookingId, targetPlatform);
      if (kind === 'unblock') return handleUnblock(bookingId, targetPlatform);
      throw new Error(`unknown job kind: ${kind}`);
    },
    { connection: redisConnection(), concurrency },
  );
}

// ---------------------------------------------------------------- block

async function handleBlock(bookingId, targetPlatform) {
  const ctx = await loadContext(bookingId, targetPlatform);
  if (!ctx) return { skipped: 'no matching block_jobs row — likely superseded and cleaned up' };
  const { job, booking, venue, court } = ctx;

  if (job.state === 'superseded' || job.state === 'submitted' || job.state === 'verified' || job.state === 'failed') {
    return { skipped: `job already at or past task-creation (${job.state})` };
  }

  // The pipeline only enqueues a block for a platform the court is actually
  // mapped to, but the mapping could be deleted between enqueue and
  // execution — never present a task with nothing to map to.
  if (!court.externalCourtId) {
    return terminalFail(job, venue, targetPlatform, booking, court, {
      state: 'failed',
      error: `${court.name} has no ${targetPlatform} mapping — cannot block a slot with nothing to map to`,
    });
  }

  // Kill switches: per-venue and per-platform, checked with no deploy needed.
  if (!venue.auto_block_enabled) {
    return terminalFail(job, venue, targetPlatform, booking, court, afterKillSwitch('assisted blocking is off for this venue'));
  }
  if (ctx.account?.status !== 'active') {
    return terminalFail(job, venue, targetPlatform, booking, court, afterKillSwitch(`${targetPlatform} is paused for this venue`));
  }

  await setState(job.id, 'leased', { leased_until: new Date(Date.now() + 30_000) });

  const { startMs, endMs } = fromRange(booking.slot);
  const slotLabel = `${localHhmm(startMs)}–${localHhmm(endMs)}`;

  await withVenueLock(venue.id, async () => {
    // Written before the task is surfaced, per finding 1 — the human who
    // does this task is about to trigger a real notification from
    // `targetPlatform`'s own app, and that must not be read back as a fresh
    // booking.
    await expectEcho(pool, {
      venueId: venue.id,
      platform: targetPlatform,
      externalCourtId: court.externalCourtId,
      startMs,
      endMs,
    });

    await setState(job.id, 'submitted', { due_by: new Date(Date.now() + TASK_SLA_MS) });
    emitBoardChange(venue.id, { type: 'block_task_created', businessDate: booking.business_date, bookingId });
  });

  await notifyOwner(pool, venue.id, 'block_task', {
    platform: PLATFORM_LABELS[targetPlatform],
    court: court.name,
    slot: slotLabel,
  });

  return { taskCreated: true };
}

/**
 * A human taps "Done" after blocking the slot in the partner app themselves.
 * Called from the API, not the queue — there is no automated step left to
 * wait for.
 */
export async function completeBlockTask({ jobId, venueId, completedBy }) {
  const { rows } = await pool.query(
    `select j.*, b.venue_id from block_jobs j join bookings b on b.id = j.booking_id where j.id = $1`,
    [jobId],
  );
  const job = rows[0];
  if (!job || job.venue_id !== venueId) return null;
  if (job.state !== 'submitted') {
    throw Object.assign(new Error(`this task is ${job.state}, not awaiting confirmation`), { statusCode: 409 });
  }

  const latencyMs = Date.now() - Date.parse(job.enqueued_at);
  await pool.query(
    `insert into block_receipts (block_job_id, verified_at, latency_ms, verification_method)
     values ($1, now(), $2, 'staff_confirmed')`,
    [job.id, latencyMs],
  );
  const outcome = afterVerified();
  await setState(job.id, outcome.state, { completed_at: new Date(), completed_by: completedBy ?? null });
  emitBoardChange(venueId, { type: 'block_verified', bookingId: job.booking_id });

  return { id: job.id, state: outcome.state };
}

async function terminalFail(job, venue, targetPlatform, booking, court, outcome) {
  await setState(job.id, outcome.state, { last_error: outcome.error, completed_at: new Date() });
  await notifyOwner(pool, venue.id, 'block_failed', {
    platform: PLATFORM_LABELS[targetPlatform],
    court: court.name,
    attempts: 0,
    error: outcome.error,
  });
  return { failed: true, error: outcome.error };
}

// ---------------------------------------------------------------- unblock

async function handleUnblock(bookingId, targetPlatform) {
  const ctx = await loadContext(bookingId, targetPlatform);
  if (!ctx) return { skipped: 'no matching block_jobs row' };
  const { job, booking, venue, court } = ctx;

  // Only a verified block has anything to undo. A job cancelled before it ran
  // was already marked superseded directly by the pipeline — see pipeline.js.
  if (job.state !== 'verified') {
    return { skipped: `nothing to unblock — job is ${job.state}, not verified` };
  }
  if (job.unblock_requested_at) {
    return { skipped: 'unblock task already open, waiting on staff' };
  }
  if (!court.externalCourtId) {
    // The mapping existed when we blocked; it cannot be un-blocked without it.
    // This is exactly the alert-the-owner case — the slot is stuck blocked
    // elsewhere and someone has to release it by hand.
    await notifyOwner(pool, venue.id, 'block_failed', {
      platform: PLATFORM_LABELS[targetPlatform],
      court: court.name,
      attempts: job.attempts,
      error: `the ${targetPlatform} mapping was removed — please release this slot by hand`,
    });
    return { failed: true, error: 'mapping removed' };
  }

  const { startMs, endMs } = fromRange(booking.slot);
  const slotLabel = `${localHhmm(startMs)}–${localHhmm(endMs)}`;

  await withVenueLock(venue.id, async () => {
    // Releasing a slot in the partner app can fire its own notification too —
    // same echo risk as blocking it.
    await expectEcho(pool, {
      venueId: venue.id,
      platform: targetPlatform,
      externalCourtId: court.externalCourtId,
      startMs,
      endMs,
    });
    await pool.query(
      `update block_jobs set unblock_requested_at = now(), unblock_due_by = now() + interval '3 minutes' where id = $1`,
      [job.id],
    );
    emitBoardChange(venue.id, { type: 'unblock_task_created', businessDate: booking.business_date, bookingId });
  });

  await notifyOwner(pool, venue.id, 'unblock_task', {
    platform: PLATFORM_LABELS[targetPlatform],
    court: court.name,
    slot: slotLabel,
  });

  return { taskCreated: true };
}

/** A human taps "Done" after releasing the slot in the partner app themselves. */
export async function completeUnblockTask({ jobId, venueId, completedBy }) {
  const { rows } = await pool.query(
    `select j.*, b.venue_id from block_jobs j join bookings b on b.id = j.booking_id where j.id = $1`,
    [jobId],
  );
  const job = rows[0];
  if (!job || job.venue_id !== venueId) return null;
  if (job.state !== 'verified' || !job.unblock_requested_at) {
    throw Object.assign(new Error('there is no open unblock task for this job'), { statusCode: 409 });
  }

  const outcome = afterSuperseded();
  await setState(job.id, outcome.state, { completed_at: new Date(), completed_by: completedBy ?? null });
  emitBoardChange(venueId, { type: 'block_released', bookingId: job.booking_id });

  return { id: job.id, state: outcome.state };
}

// ---------------------------------------------------------------- escalation

/**
 * Nudges staff, then the owner, when an assisted task sits unconfirmed past
 * its SLA. Run on an interval from worker-entry.js — see the build plan's
 * 3-minute / 10-minute escalation ladder (06 §6.1). Pure DB reads plus
 * `notifyOwner`; no adapter, no Redis.
 */
export async function escalateOverdueTasks() {
  const { rows: overdueBlocks } = await pool.query(
    `select j.id, j.target_platform, j.due_by, b.slot, b.business_date, b.venue_id, v.name as venue_name, c.name as court_name
       from block_jobs j
       join bookings b on b.id = j.booking_id
       join venues v on v.id = b.venue_id
       join courts c on c.id = b.court_id
      where j.state = 'submitted' and j.due_by < now() and j.escalated_at is null`,
  );
  for (const row of overdueBlocks) {
    const { startMs, endMs } = fromRange(row.slot);
    await notifyOwner(pool, row.venue_id, 'block_task_overdue', {
      platform: PLATFORM_LABELS[row.target_platform],
      court: row.court_name,
      slot: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
      minutes: Math.round((Date.now() - Date.parse(row.due_by)) / 60_000) + 3,
    });
    await pool.query(`update block_jobs set escalated_at = now() where id = $1`, [row.id]);
  }

  const { rows: overdueUnblocks } = await pool.query(
    `select j.id, j.target_platform, j.unblock_due_by, b.slot, b.venue_id, c.name as court_name
       from block_jobs j
       join bookings b on b.id = j.booking_id
       join courts c on c.id = b.court_id
      where j.unblock_requested_at is not null and j.unblock_due_by < now() and j.unblock_escalated_at is null`,
  );
  for (const row of overdueUnblocks) {
    const { startMs, endMs } = fromRange(row.slot);
    await notifyOwner(pool, row.venue_id, 'unblock_task_overdue', {
      platform: PLATFORM_LABELS[row.target_platform],
      court: row.court_name,
      slot: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
      minutes: Math.round((Date.now() - Date.parse(row.unblock_due_by)) / 60_000) + 3,
    });
    await pool.query(`update block_jobs set unblock_escalated_at = now() where id = $1`, [row.id]);
  }

  return { blocksEscalated: overdueBlocks.length, unblocksEscalated: overdueUnblocks.length };
}

// ---------------------------------------------------------------- shared

async function loadContext(bookingId, targetPlatform) {
  const { rows } = await pool.query(
    `select
        j.id, j.state, j.attempts, j.unblock_requested_at,
        b.id as booking_id, b.slot, b.business_date, b.venue_id,
        v.auto_block_enabled, v.name as venue_name,
        c.id as court_id, c.name as court_name,
        m.external_court_id,
        pa.status as account_status
       from block_jobs j
       join bookings b on b.id = j.booking_id
       join venues v on v.id = b.venue_id
       join courts c on c.id = b.court_id
       left join court_mappings m on m.court_id = c.id and m.platform = j.target_platform
       left join platform_accounts pa on pa.venue_id = v.id and pa.platform = j.target_platform
      where j.booking_id = $1 and j.target_platform = $2`,
    [bookingId, targetPlatform],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    job: { id: row.id, state: row.state, attempts: row.attempts, unblock_requested_at: row.unblock_requested_at },
    booking: { id: row.booking_id, slot: row.slot, business_date: row.business_date },
    venue: { id: row.venue_id, name: row.venue_name, auto_block_enabled: row.auto_block_enabled },
    court: { id: row.court_id, name: row.court_name, externalCourtId: row.external_court_id },
    account: row.account_status ? { status: row.account_status } : null,
  };
}

// NOTE: this does not call canTransition() from stateMachine.js to validate
// the move — every call site above only ever requests a transition the code
// path already guarantees is legal. If this file grows more call sites,
// guard each new one explicitly; canTransition() exists and is tested
// precisely so that check is cheap to add.
async function setState(jobId, state, extra = {}) {
  const fields = ['state = $2', ...Object.keys(extra).map((k, i) => `${k} = $${i + 3}`)];
  await pool.query(
    `update block_jobs set ${fields.join(', ')} where id = $1`,
    [jobId, state, ...Object.values(extra)],
  );
}
