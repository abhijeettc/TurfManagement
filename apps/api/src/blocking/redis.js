import Redis from 'ioredis';

// Port 6380, not the default 6379 — this machine already runs another
// project's Redis on 6379 (the same reason Postgres sits on 5434 instead of
// the default 5432 or the neighbouring project's 5433).
export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

let connection;

/** One shared connection. BullMQ requires maxRetriesPerRequest: null on any
 * connection it manages, or it throws at construction time. */
export function redisConnection() {
  if (!connection) {
    connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }
  return connection;
}

export async function closeRedis() {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}

/** Used by tests and the worker's startup check to fail fast with a clear
 * message instead of hanging on a Redis that was never started. */
export async function pingRedis(timeoutMs = 1500) {
  try {
    await Promise.race([
      redisConnection().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}
