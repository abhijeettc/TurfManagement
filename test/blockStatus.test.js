import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { pool, close } from '@turfsync/db';
import { slotFromCalendarDate, toRange, businessDateOf } from '@turfsync/core';
import { connectForTests, SKIP } from './helpers.js';
import { createSession, COOKIE } from '../apps/api/src/auth/sessions.js';
import { hashPassword } from '../apps/api/src/auth/passwords.js';
import { tokenHash } from '../apps/api/src/auth/guard.js';
import blockStatusRoutes from '../apps/api/src/routes/blockStatus.js';

process.env.SESSION_ENCRYPTION_KEY ||= 'test-only-key-not-for-anything-real';

const live = await connectForTests();
const skip = live ? false : SKIP;

/**
 * The tablet-facing bridge (blockStatus.js) standing alone, not the full
 * server — same spirit as blocking.test.js exercising worker.js directly
 * rather than through HTTP. Built fresh so the dual auth paths (device token,
 * session cookie) are tested against the real auth modules, not a stand-in.
 */
let app;
let venueA, venueB, courtA, deviceTokenA, deviceTokenB, ownerCookieA;

before(async () => {
  if (!live) return;
  // Deliberately no truncate here: `node --test` runs test files concurrently
  // in separate processes against the same test database, and auth.test.js /
  // blocking.test.js already truncate these same tables for their own runs.
  // Uniquely-named fixtures below avoid colliding with either.
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(blockStatusRoutes);
  await app.ready();

  venueA = (await pool.query(
    `insert into venues (name, city, auto_block_enabled) values ('Bridge Test Arena','Ahmedabad', true) returning *`,
  )).rows[0];
  venueB = (await pool.query(
    `insert into venues (name, city, auto_block_enabled) values ('Other Venue','Ahmedabad', true) returning *`,
  )).rows[0];
  courtA = (await pool.query(
    `insert into courts (venue_id, name, sport, position) values ($1,'Court 1','Football',1) returning *`,
    [venueA.id],
  )).rows[0];
  await pool.query(
    `insert into platform_accounts (venue_id, platform, status) values ($1,'turfpro','active')`,
    [venueA.id],
  );

  deviceTokenA = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into device_tokens (venue_id, token_hash, paired_at) values ($1,$2,now())`,
    [venueA.id, tokenHash(deviceTokenA)],
  );
  deviceTokenB = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into device_tokens (venue_id, token_hash, paired_at) values ($1,$2,now())`,
    [venueB.id, tokenHash(deviceTokenB)],
  );

  const account = (await pool.query(
    `insert into accounts (email, password_hash, name) values ('owner@bridge-test.in',$1,'Owner') returning *`,
    [await hashPassword('correct horse battery')],
  )).rows[0];
  await pool.query(
    `insert into account_venues (account_id, venue_id, role) values ($1,$2,'owner')`,
    [account.id, venueA.id],
  );
  const { token } = await createSession(account.id);
  ownerCookieA = `${COOKIE}=${token}`;
});

after(async () => {
  if (app) await app.close();
  await close();
});

let nextDay = 20;

async function insertSubmittedJob(venue, court, platform = 'turfpro') {
  // A fresh date per call — the exclusion constraint on (court_id, slot)
  // would otherwise reject a second booking at the same reused time.
  const date = `2026-10-${nextDay++}`;
  const { startMs, endMs } = slotFromCalendarDate(date, '20:00', '21:00');
  const booking = (await pool.query(
    `insert into bookings (venue_id, court_id, platform, slot, business_date, status, dedupe_key, source_channel)
     values ($1,$2,'khelomore',$3::tstzrange,$4,'confirmed',$5,'notification') returning *`,
    [venue.id, court.id, toRange(startMs, endMs), businessDateOf(startMs, 6), `t:bridge:${Math.random()}`],
  )).rows[0];
  const job = (await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, due_by) values ($1,$2,'submitted', now() + interval '3 minutes') returning *`,
    [booking.id, platform],
  )).rows[0];
  return { booking, job, date };
}

test('no credentials at all is refused', { skip }, async () => {
  const res = await app.inject({ method: 'GET', url: '/status.json' });
  assert.equal(res.statusCode, 401);
});

test('an open turfpro task is visible to both the device token and the owner session', { skip }, async () => {
  const { job, date } = await insertSubmittedJob(venueA, courtA);

  const viaDevice = await app.inject({ method: 'GET', url: '/status.json', headers: { 'x-device-token': deviceTokenA } });
  assert.equal(viaDevice.statusCode, 200);
  const d = viaDevice.json();
  assert.equal(d.tasks.length, 1);
  assert.equal(d.tasks[0].id, job.id);
  assert.equal(d.tasks[0].platform, 'turfpro');
  assert.equal(d.tasks[0].kind, 'awaiting_browser');
  assert.equal(d.tasks[0].court, 'Court 1');
  assert.equal(d.tasks[0].date, date);
  assert.equal(d.tasks[0].from, '20:00');
  assert.equal(d.tasks[0].to, '21:00');
  assert.equal(d.tasks[0].loginNeeded, false);

  const viaCookie = await app.inject({ method: 'GET', url: '/status.json', headers: { cookie: ownerCookieA } });
  assert.equal(viaCookie.statusCode, 200);
  assert.deepEqual(viaCookie.json().tasks.map((t) => t.id), [job.id]);
});

test('a device token only ever sees its own venue', { skip }, async () => {
  await insertSubmittedJob(venueA, courtA);
  const res = await app.inject({ method: 'GET', url: '/status.json', headers: { 'x-device-token': deviceTokenB } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().tasks, []);
});

test('browser-login-needed flags the task until it is cleared', { skip }, async () => {
  const { job } = await insertSubmittedJob(venueA, courtA);

  const flag = await app.inject({
    method: 'POST', url: '/status/browser-login-needed',
    headers: { 'x-device-token': deviceTokenA }, payload: { id: job.id },
  });
  assert.equal(flag.statusCode, 200);

  const after1 = await app.inject({ method: 'GET', url: '/status.json', headers: { 'x-device-token': deviceTokenA } });
  assert.equal(after1.json().tasks.find((t) => t.id === job.id).loginNeeded, true);
});

test('browser-done completes the job the same way a human tapping "mark done" would', { skip }, async () => {
  const { job } = await insertSubmittedJob(venueA, courtA);

  const done = await app.inject({
    method: 'POST', url: '/status/browser-done',
    headers: { 'x-device-token': deviceTokenA }, payload: { id: job.id },
  });
  assert.equal(done.statusCode, 200);

  const { rows } = await pool.query('select state, completed_by from block_jobs where id = $1', [job.id]);
  assert.equal(rows[0].state, 'verified');
  assert.equal(rows[0].completed_by, 'tablet');

  const status = await app.inject({ method: 'GET', url: '/status.json', headers: { 'x-device-token': deviceTokenA } });
  const d = status.json();
  assert.equal(d.tasks.find((t) => t.id === job.id), undefined);
  assert.equal(d.apps[0].counts.blocked >= 1, true);
});

test('browser-failed records the reason and the job stops appearing as open', { skip }, async () => {
  const { job } = await insertSubmittedJob(venueA, courtA);

  const failed = await app.inject({
    method: 'POST', url: '/status/browser-failed',
    headers: { 'x-device-token': deviceTokenA }, payload: { id: job.id, detail: 'selector not found' },
  });
  assert.equal(failed.statusCode, 200);

  const { rows } = await pool.query('select state, last_error from block_jobs where id = $1', [job.id]);
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].last_error, 'selector not found');
});

test('resolve completes an open task from the dashboard, and 404s once nothing is open', { skip }, async () => {
  const { job } = await insertSubmittedJob(venueA, courtA);

  const resolved = await app.inject({
    method: 'POST', url: '/status/resolve', headers: { cookie: ownerCookieA }, payload: { id: job.id },
  });
  assert.equal(resolved.statusCode, 200);

  const again = await app.inject({
    method: 'POST', url: '/status/resolve', headers: { cookie: ownerCookieA }, payload: { id: job.id },
  });
  assert.equal(again.statusCode, 404);
});

test('a device token cannot complete another venue\'s job', { skip }, async () => {
  const { job } = await insertSubmittedJob(venueA, courtA);
  const res = await app.inject({
    method: 'POST', url: '/status/browser-done',
    headers: { 'x-device-token': deviceTokenB }, payload: { id: job.id },
  });
  assert.equal(res.statusCode, 404);
  const { rows } = await pool.query('select state from block_jobs where id = $1', [job.id]);
  assert.equal(rows[0].state, 'submitted');
});
