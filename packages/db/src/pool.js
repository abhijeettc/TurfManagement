import pg from 'pg';

// Load .env if one exists. Node 20.6+ ships this; no dotenv dependency.
// Skipped when DATABASE_URL is already set, so an explicitly chosen database —
// the test one, most importantly — is never silently overridden by .env.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env — rely on the real environment */
  }
}

// Postgres returns bigint as a string to avoid silent precision loss. Every
// bigint in this schema is paise, which is safely inside Number range for any
// realistic venue, so parse them back to numbers at the boundary.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// sum() over a bigint returns NUMERIC, which pg also hands back as a string.
// Without this, `total += row.sum` silently concatenates instead of adding and
// the money view reports figures in the crores.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
// Keep DATE as the plain 'YYYY-MM-DD' string it is; a JS Date here would drag
// the server's local timezone into business_date, which is exactly the bug the
// business_date column exists to prevent.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://turfsync:turfsync@localhost:5434/turfsync';

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a savepoint. If it raises the given SQLSTATE, roll back to the
 * savepoint — leaving the surrounding transaction alive and usable — and run
 * `onCode` instead.
 *
 * This is what turns an exclusion-constraint violation from a 500 into a
 * conflict record. Without the savepoint the whole transaction is poisoned and
 * the booking that most needs to reach the owner is the one we drop.
 */
export async function trySavepoint(client, name, fn, code, onCode) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    if (error.code === code) return onCode(error);
    throw error;
  }
}

export const SQLSTATE = {
  EXCLUSION_VIOLATION: '23P01',
  UNIQUE_VIOLATION: '23505',
};

export async function close() {
  await pool.end();
}
