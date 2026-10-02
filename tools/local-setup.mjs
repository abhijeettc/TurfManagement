/**
 * Clean-slate local setup for the TurfSync dashboard + TurfPro blocker.
 *
 *   node tools/local-setup.mjs reset   # STOP the dashboard first. Wipes the dashboard database.
 *   node tools/dev-local.mjs           # start the dashboard on :3001 (separate terminal)
 *   node tools/local-setup.mjs venue   # creates one EMPTY venue, its two grounds, pairs the tablet
 *
 * `reset` drops every table in the dashboard database (no demo data is
 * seeded), re-applies the migrations, and writes a fresh worker token to
 * .local-bridge.json. `venue` then goes through the real signup / court /
 * mapping / pairing endpoints — the same ones the UI uses — and records the
 * venue id and the tablet's device token in .local-bridge.json (gitignored)
 * for the blocking worker and the message bridge.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, '.local-bridge.json');
const API = process.env.DASHBOARD_URL || 'http://127.0.0.1:3001';

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@turfsync.local';
const VENUE = { name: 'TurfPro Venue', city: 'Bengaluru', locality: 'HSR Layout' };

// Each ground, the name TurfPro uses for it, and the labels other apps' WhatsApp
// messages use for it (placeholders until real ones are captured).
const GROUNDS = [
  { name: 'City Football Turf', sport: 'Football', labels: { turfpro: 'City Football Turf', khelomore: 'Synthetic Ball' } },
  { name: 'Raj Cricket & Football Arena', sport: 'Cricket & Football', labels: { turfpro: 'Raj Cricket & Football Arena', khelomore: 'Raj Arena', playo: 'Turf A' } },
];

const readBridge = () => { try { return JSON.parse(readFileSync(BRIDGE, 'utf8')); } catch { return {}; } };
const writeBridge = (o) => writeFileSync(BRIDGE, JSON.stringify(o, null, 2), { mode: 0o600 });

async function reset() {
  const { pool, close } = await import('../packages/db/src/pool.js');
  const { migrate } = await import('../packages/db/src/migrate.js');
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  await migrate({ quiet: true });
  await close();
  writeBridge({ workerToken: randomBytes(32).toString('base64url') });
  console.log('Dashboard database wiped and migrated. No demo data.\nNext: node tools/dev-local.mjs, then node tools/local-setup.mjs venue');
}

async function venue() {
  const password = process.env.OWNER_PASSWORD || randomBytes(9).toString('base64url');
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${json.error ?? ''}`);
    return json;
  };

  const signup = await call('POST', '/auth/signup', {
    email: OWNER_EMAIL, password, name: 'Owner', venueName: VENUE.name, city: VENUE.city, locality: VENUE.locality,
  });
  for (const g of GROUNDS) {
    const { court } = await call('POST', '/api/courts', { name: g.name, sport: g.sport });
    await call('PUT', `/api/courts/${court.id}/mappings`, { mappings: g.labels });
  }
  const { token } = await call('POST', '/api/devices', { label: 'Counter tablet' });

  writeBridge({ ...readBridge(), venueId: signup.venue.id, deviceToken: token });
  console.log(`\nVenue "${VENUE.name}" created with ${GROUNDS.length} grounds. Tablet paired.\n`);
  console.log(`  Dashboard login:  ${OWNER_EMAIL}\n  Password:         ${password}\n`);
  console.log('Next: sign in on the tablet and save the TurfPro login under Setup → App logins.');
}

const phase = process.argv[2];
if (phase === 'reset') await reset();
else if (phase === 'venue') await venue();
else { console.error('usage: node tools/local-setup.mjs reset|venue'); process.exit(1); }
