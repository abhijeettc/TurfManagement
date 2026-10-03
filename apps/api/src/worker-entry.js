/**
 * The block-job worker, as its own process.
 *
 * Separate from the API on purpose — the build plan's "isolated blast
 * radius": a stuck Redis hiccup here must never be able to take the board
 * down with it. In production this runs on its own VPS.
 *
 *   node apps/api/src/worker-entry.js
 *
 * This worker never logs into Playo, Hudle or KheloMore. Every block or
 * unblock it produces is an assisted task — a WhatsApp nudge plus a board
 * entry telling a human to do it in the partner's own app — never an
 * automated write to a partner dashboard. See blocking/worker.js's own
 * top comment and 06-Multi-Platform-Channel-Sync.md §8 for why: that kind
 * of automation is against Playo's and Hudle's terms without a written
 * agreement neither has been asked for yet, and risks the venue's listing
 * being suspended on the platform it targets.
 */
import { pool, close as closeDb } from '@turfsync/db';
import { pingRedis, closeRedis } from './blocking/redis.js';
import { startBlockWorker, escalateOverdueTasks } from './blocking/worker.js';
import { closeQueue } from './blocking/queue.js';
import { sweepOrphanedJobs } from './blocking/embedded.js';

async function main() {
  if (!(await pingRedis())) {
    console.error(`Redis is not reachable. Start it with \`npm run db:up\` (it starts Redis too) and try again.`);
    process.exit(1);
  }

  await pool.query('select 1'); // fail fast if Postgres is not up either

  await sweepOrphanedJobs();
  const sweepTimer = setInterval(() => sweepOrphanedJobs().catch((e) => console.error('[sweep] failed:', e.message)), 60_000);
  sweepTimer.unref();

  const worker = startBlockWorker({ concurrency: 5 });
  worker.on('completed', (job, result) => {
    console.log(`[worker] ${job.data.kind} ${job.data.bookingId}/${job.data.targetPlatform} →`, result);
  });
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} threw unexpectedly:`, err.message);
  });

  console.log('Block worker running (assisted tasks only — no platform is ever logged into automatically).');

  // Nudges staff, then the owner, when an assisted task sits unconfirmed past
  // its SLA. See blocking/worker.js#escalateOverdueTasks.
  const escalateTimer = setInterval(() => {
    escalateOverdueTasks().catch((error) => console.error('[escalate] sweep failed:', error.message));
  }, 60_000);
  escalateTimer.unref();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      clearInterval(escalateTimer);
      clearInterval(sweepTimer);
      await worker.close();
      await closeQueue();
      await closeRedis();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
