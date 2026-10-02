import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';

export const QUEUE_NAME = 'block-jobs';

/**
 * Job ids use `__`, not `:`.
 *
 * BullMQ rejects a custom jobId containing colons unless it splits into
 * exactly three parts — a back-compat carve-out for old repeatable jobs:
 *
 *   if (jobId.includes(':') && jobId.split(':').length !== 3) throw ...
 *
 * `block:<uuid>:<platform>` happens to satisfy that by accident, so the
 * straightforward case worked while every retry (`…:retry:1`) and every
 * unblock (`…:<timestamp>`) threw. Avoiding the character entirely removes
 * a trap that only shows up on the paths that run least often.
 */
const SEP = '__';

let queue;
export function blockQueue() {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  return queue;
}

export async function closeQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

/**
 * Priority by slot proximity — tonight's 19:00 blocks before next Tuesday's.
 * BullMQ treats a LOWER number as higher priority, so this is minutes until
 * the slot starts, clamped so a slot already underway (or in the past, on a
 * retry) still gets the most urgent priority rather than a negative number
 * BullMQ would reject.
 */
export function priorityFor(startMs, now = Date.now()) {
  const minutesUntil = Math.round((startMs - now) / 60_000);
  return Math.max(0, Math.min(minutesUntil, 100_000));
}

/**
 * Enqueue the forward action: make this booking's slot unavailable on
 * `targetPlatform`.
 *
 * The FIRST enqueue for a booking uses a fixed jobId matching block_jobs' own
 * unique(booking_id, target_platform) — deliberately, so the pipeline's
 * create path and the worker's crash-recovery sweep can both call this for
 * the same row without scheduling the work twice.
 *
 * A RETRY (`attempt` set) must NOT reuse that id. BullMQ treats jobId as a
 * dedup key for the life of the job's record in Redis — including while it
 * sits in the `removeOnComplete`/`removeOnFail` retention window after
 * finishing — so re-adding the same id after the processor already returned
 * once is a silent no-op, not a new run. Every retry gets its own suffixed
 * id instead.
 */
export async function enqueueBlock({ bookingId, targetPlatform, startMs, delayMs, attempt }) {
  return blockQueue().add(
    'block',
    { bookingId, targetPlatform, kind: 'block' },
    {
      jobId: attempt
        ? ['block', bookingId, targetPlatform, 'retry', attempt].join(SEP)
        : ['block', bookingId, targetPlatform].join(SEP),
      priority: priorityFor(startMs),
      delay: delayMs || undefined,
      // Retries are managed at the block_jobs / state-machine level, with our
      // own non-uniform 5s/30s/3m backoff — not BullMQ's own retry semantics.
      attempts: 1,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    },
  );
}

/** The reverse action: a cancellation undoing a block that already verified. */
export async function enqueueUnblock({ bookingId, targetPlatform, delayMs }) {
  return blockQueue().add(
    'unblock',
    { bookingId, targetPlatform, kind: 'unblock' },
    {
      // Suffixed with time: unlike a block, an unblock can legitimately be
      // requeued after a failed attempt without colliding on the same jobId.
      jobId: ['unblock', bookingId, targetPlatform, Date.now()].join(SEP),
      priority: 0,
      delay: delayMs || undefined,
      attempts: 1,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    },
  );
}

/**
 * A venue's own operations must never race each other — the build plan's
 * "concurrency 1 per venue". Open-source BullMQ has no native per-tenant
 * concurrency group, so this is a short-lived Redis lock the worker holds for
 * the duration of one adapter call. A job that cannot acquire it waits briefly
 * and retries the lock within the same execution, rather than being re-queued
 * — simpler, and it keeps one venue's jobs processing in slot-priority order
 * instead of interleaving with whoever grabbed the lock first.
 */
export async function withVenueLock(venueId, fn, { retries = 20, retryDelayMs = 250, ttlMs = 15_000 } = {}) {
  const key = `lock:venue:${venueId}`;
  const redis = redisConnection();
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;

  let acquired = false;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    acquired = (await redis.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
    if (acquired) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (!acquired) throw new Error(`could not acquire venue lock for ${venueId} after ${retries} attempts`);

  try {
    return await fn();
  } finally {
    // Only release the lock if we still hold it — a Lua script makes the
    // check-and-delete atomic, so we never release a lock another process
    // acquired after ours expired.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      key,
      token,
    );
  }
}
