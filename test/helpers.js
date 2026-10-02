import { pool, DATABASE_URL } from '@turfsync/db';
import { migrate } from '../packages/db/src/migrate.js';

/**
 * Bring up the test database, tolerating the fact that `node --test` runs each
 * file in its own process and they all start at once.
 *
 * Two races have to be survived on a fresh clone:
 *   - both processes see "database does not exist" and both try to create it.
 *     One wins; the loser gets 42P04 and must carry on rather than give up.
 *   - both then migrate. That one is handled by an advisory lock in migrate().
 *
 * Getting this wrong is quiet in the worst way: the loser sets live=false and
 * its whole file reports as skipped, which reads like "no database" rather than
 * "a bug in the test harness".
 *
 * @returns false when Postgres genuinely is not running, so tests can skip.
 */
export async function connectForTests() {
  try {
    await ensureDatabase();
    await pool.query('select 1');
    await migrate({ quiet: true });
    return true;
  } catch (error) {
    if (process.env.TEST_DB_DEBUG) console.error('test db unavailable:', error);
    return false;
  }
}

async function ensureDatabase() {
  try {
    await pool.query('select 1');
    return;
  } catch (error) {
    if (error.code !== '3D000') throw error; // not "database does not exist"
  }

  const { default: pg } = await import('pg');
  const url = new URL(DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  let createError = null;
  try {
    await admin.query(`create database "${name}"`);
  } catch (error) {
    // Two processes creating the same database at the same moment can fail as
    // 42P04 (duplicate_database) OR as 23505 — a unique violation on
    // pg_database_datname_index, when the race is tight enough that the
    // duplicate-name check loses to the index. Rather than enumerate codes,
    // hold the error and let the connection below decide: if the database is
    // reachable now, somebody created it and that is all we wanted.
    createError = error;
  } finally {
    await admin.end();
  }

  if (createError) {
    try {
      await pool.query('select 1');
    } catch {
      throw createError;
    }
  }
}

export const SKIP = 'needs Postgres — run `npm run db:up`';
