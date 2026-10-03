import { fromRange } from '@turfsync/core';
import { pool } from '@turfsync/db';
import { pingRedis } from './redis.js';
import { startBlockWorker, escalateOverdueTasks } from './worker.js';
import { enqueueBlock } from './queue.js';

/**
 * The block worker, running inside the API process instead of as its own
 * service.
 *
 * worker-entry.js remains the better deployment and the one its own top
 * comment describes: a stuck Redis there cannot take the board down with it.
 * This exists because Render has no free instance type for `type: worker`, so
 * the blueprint's turfsync-block-worker never gets created on a free plan —
 * block_jobs rows then sit at 'queued' forever with attempts = 0, which is
 * exactly the state this venue's 9 TurfPro blocks were found in.
 *
 * Set EMBEDDED_BLOCK_WORKER=0 to turn this off — do that if a real worker
 * service is ever added. Running both is safe (BullMQ hands each job to one
 * consumer) but there is no reason to pay for the overlap.
 */
const SWEEP_INTERVAL_MS = 60_000;
const ESCALATE_INTERVAL_MS = 60_000;

/**
 * A process can crash between committing a booking (with its block_jobs rows)
 * and telling Redis about them — pipeline.js enqueues only after the Postgres
 * transaction returns. This sweep is what makes that gap survivable: any row
 * still `queued` a safe margin after it was written has no matching Redis job
 * and gets one now, rather than sitting on the board forever as "syncing".
 *
 * Shared with worker-entry.js so the standalone and embedded paths cannot
 * drift apart.
 */
export async function sweepOrphanedJobs(log = console) {
  const { rows } = await pool.query(
    `select j.booking_id, j.target_platform, b.slot
       from block_jobs j
       join bookings b on b.id = j.booking_id
      where j.state = 'queued' and j.enqueued_at < now() - interval '30 seconds'`,
  );
  for (const row of rows) {
    const { startMs } = fromRange(row.slot);
    await enqueueBlock({ bookingId: row.booking_id, targetPlatform: row.target_platform, startMs });
  }
  if (rows.length) {
    log.info?.(`[blocks] re-enqueued ${rows.length} orphaned block job(s) left 'queued'`);
  }
  return rows.length;
}

/** @returns a stop function; always safe to call. */
export async function startEmbeddedBlockWorker(log = console) {
  if (process.env.EMBEDDED_BLOCK_WORKER === '0') {
    log.info?.('[blocks] embedded worker off (EMBEDDED_BLOCK_WORKER=0)');
    return async () => {};
  }

  // Diagnostic only — the worker starts either way. ioredis reconnects on its
  // own, and the sweep below drains whatever accumulated while it was away, so
  // refusing to start here would turn a blip into a permanent outage. Worth one
  // clear line at boot regardless: a wrong REDIS_URL otherwise shows up only as
  // an endless reconnect loop with nothing saying why.
  if (!(await pingRedis())) {
    log.error?.('[blocks] Redis unreachable at startup — check REDIS_URL. Blocks stay queued in Postgres until it answers.');
  }

  // A malformed REDIS_URL makes ioredis throw synchronously here. Nothing about
  // the block queue is worth refusing to serve the board over, so this is the
  // one place that swallows: the jobs stay durable in Postgres and the next
  // deploy with a correct URL sweeps them up.
  let worker;
  try {
    worker = startBlockWorker({ concurrency: 5 });
  } catch (error) {
    log.error?.(`[blocks] could not start embedded worker: ${error.message}. Board continues; blocks stay queued.`);
    return async () => {};
  }

  worker.on('completed', (job, result) => {
    log.info?.(`[blocks] ${job.data.kind} ${job.data.bookingId}/${job.data.targetPlatform} → ${JSON.stringify(result)}`);
  });
  worker.on('failed', (job, err) => {
    log.error?.(`[blocks] job ${job?.id} threw unexpectedly: ${err.message}`);
  });

  await sweepOrphanedJobs(log).catch((e) => log.error?.(`[blocks] startup sweep failed: ${e.message}`));

  const sweepTimer = setInterval(
    () => sweepOrphanedJobs(log).catch((e) => log.error?.(`[blocks] sweep failed: ${e.message}`)),
    SWEEP_INTERVAL_MS,
  );
  sweepTimer.unref();

  // Nudges staff, then the owner, when an assisted task sits unconfirmed past
  // its SLA. See blocking/worker.js#escalateOverdueTasks.
  const escalateTimer = setInterval(
    () => escalateOverdueTasks().catch((e) => log.error?.(`[blocks] escalate sweep failed: ${e.message}`)),
    ESCALATE_INTERVAL_MS,
  );
  escalateTimer.unref();

  log.info?.('[blocks] embedded block worker running (assisted tasks only — no platform is logged into automatically)');

  return async () => {
    clearInterval(sweepTimer);
    clearInterval(escalateTimer);
    await worker.close();
  };
}
