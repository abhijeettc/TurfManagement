import pg from 'pg';
import { DATABASE_URL } from './pool.js';

// `docker compose up -d` returns before Postgres is accepting connections.
const DEADLINE_MS = 60_000;

const started = Date.now();
let lastError;

while (Date.now() - started < DEADLINE_MS) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    await client.query('select 1');
    await client.end();
    console.log(`database ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    await client.end().catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.error(`database not ready after ${DEADLINE_MS / 1000}s: ${lastError?.message}`);
process.exit(1);
