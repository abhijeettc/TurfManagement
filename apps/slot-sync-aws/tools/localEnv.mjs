/**
 * Fixed resource names + env for the LocalStack-backed local test harness
 * (docker-compose.yml + bootstrap-local.mjs + local-run.mjs). Not used by a
 * real deploy — infra/lib/slot-sync-stack.mjs names things per-venueSlug and
 * targets real AWS, not this.
 */
export const LOCAL_ENV = {
  AWS_ENDPOINT_URL: 'http://127.0.0.1:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: 'ap-south-1',

  VENUE_SLUG: 'local',
  ENABLED_PLATFORMS: 'turfpro',
  // A TurfPro-branded WhatsApp alert should still block the slot in TurfPro.
  SELF_BLOCK_PLATFORMS: 'turfpro',
  ALERT_PHONE: '+910000000000',
  ADAPTER_MOCK: '1',
  WHATSAPP_PROVIDER: 'console',

  SLOT_SYNC_EVENTS_TABLE: 'slot-sync-local-events',
  COURT_MAPPING_TABLE: 'slot-sync-local-court-mapping',
  ECHO_EXPECTATIONS_TABLE: 'slot-sync-local-echo-expectations',
  SESSIONS_BUCKET: 'turfsync-local-private',
  SESSION_KMS_KEY_ID: 'alias/slot-sync-local',
  // .fifo suffix is mandatory for a FIFO queue — matches
  // infra/lib/slot-sync-stack.mjs, which grants the "never two sessions on
  // one platform at once" guarantee via MessageGroupId (see ingestCore.mjs).
  BLOCK_QUEUE_NAME: 'slot-sync-local-block-jobs.fifo',
  BLOCK_DLQ_NAME: 'slot-sync-local-block-jobs-dlq.fifo',
  // LocalStack's default test account id — its queue URLs are deterministic,
  // so this doesn't need a round trip through the create-queue response.
  BLOCK_QUEUE_URL: 'http://127.0.0.1:4566/000000000000/slot-sync-local-block-jobs.fifo',
  BLOCK_DLQ_URL: 'http://127.0.0.1:4566/000000000000/slot-sync-local-block-jobs-dlq.fifo',
  DEVICE_TOKEN_SECRET_ID: 'turfsync/local/device-token',
  DEVICE_TOKEN: 'local-dev-token',

  // Read by src/lib/adapters/{hudle,playo,khelomore}.mjs's login() once
  // filled in — see tools/set-local-secret.mjs to populate these in
  // LocalStack, and tools/test-adapter-live.mjs to exercise them.
  // turfpro.local only resolves for OTHER devices (mDNS); on this machine use loopback.
  TURFPRO_URL: 'http://127.0.0.1',
  HUDLE_CREDENTIALS_SECRET_ID: 'turfsync/local/hudle',
  PLAYO_CREDENTIALS_SECRET_ID: 'turfsync/local/playo',
  KHELOMORE_CREDENTIALS_SECRET_ID: 'turfsync/local/khelomore',
};

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Written by tools/local-setup.mjs: the dashboard venue this worker acts for,
 * the device token the bridge uses to record bookings on the dashboard, and
 * the worker token the dashboard's /internal routes require. Gitignored.
 */
export const BRIDGE_FILE = path.resolve(here, '../../../.local-bridge.json');

export function readBridge() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Applies LOCAL_ENV to process.env — call before importing any src/ module. */
export function applyLocalEnv() {
  Object.assign(process.env, LOCAL_ENV);
  const bridge = readBridge();
  if (bridge) {
    process.env.TURFSYNC_VENUE_ID = bridge.venueId;
    process.env.WORKER_TOKEN = bridge.workerToken;
  }
  process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://127.0.0.1:3001';
  // The worker's own private key. The dashboard process is never given this path.
  process.env.WORKER_PRIVATE_KEY_FILE = path.resolve(here, '../.keys/worker-private.pem');
}
