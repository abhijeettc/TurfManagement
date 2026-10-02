import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, close } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, '..', 'migrations');

// Any constant works; it just has to be the same in every process.
const MIGRATION_LOCK = 4919283746;

export async function migrate({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  // Two processes migrating at once — exactly what `node --test` does on a
  // fresh clone, where each test file opens its own pool — race on creating the
  // table and on applying the same file. The advisory lock serialises them; the
  // second one wakes up to find there is nothing left to do.
  const lock = await pool.connect();
  await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);

  try {
    await pool.query(`
      create table if not exists schema_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await pool.query('select name from schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('COMMIT');
        log(`  applied ${file}`);
        ran += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${error.message}`);
      } finally {
        client.release();
      }
    }

    log(ran ? `migrations: ${ran} applied` : 'migrations: already up to date');
    return ran;
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    lock.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(close)
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
