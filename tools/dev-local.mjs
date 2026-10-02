/**
 * Starts the dashboard API for the local TurfPro setup: on :3001 (port 3000 is
 * the TurfPro app itself) with the worker token the blocking worker uses for
 * the dashboard's /internal routes.
 *
 * The dashboard is deliberately NOT given the worker's private key — it only
 * ever sees the public half, so it cannot open a saved login.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { workerToken } = JSON.parse(readFileSync(path.join(ROOT, '.local-bridge.json'), 'utf8'));
  if (workerToken) process.env.WORKER_TOKEN = workerToken;
} catch {
  console.warn('No .local-bridge.json yet — run `node tools/local-setup.mjs reset` first. /internal routes will refuse the worker.');
}
process.env.PORT = process.env.PORT || '3001';
process.env.WORKER_PUBLIC_KEY_FILE = path.join(ROOT, 'apps/slot-sync-aws/.keys/worker-public.pem');

await import('../apps/api/src/server.js');
