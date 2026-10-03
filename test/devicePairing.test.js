import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { pool, close } from '@turfsync/db';
import { connectForTests, SKIP } from './helpers.js';
import { createSession, COOKIE } from '../apps/api/src/auth/sessions.js';
import { hashPassword } from '../apps/api/src/auth/passwords.js';
import { tokenHash } from '../apps/api/src/auth/guard.js';
import setupRoutes from '../apps/api/src/routes/setup.js';

process.env.SESSION_ENCRYPTION_KEY ||= 'test-only-key-not-for-anything-real';

const live = await connectForTests();
const skip = live ? false : SKIP;

/**
 * The six-digit pairing exchange. The interesting cases are all the refusals:
 * a token handed to the wrong tablet is a venue's write credential, so "it
 * works" is the least of what needs proving here.
 */
let app;
let venue, ownerCookie;

const EMAIL = 'owner@pairing-test.in';

async function cleanup() {
  await pool.query(`delete from accounts where email = $1`, [EMAIL]);
  await pool.query(`delete from venues where name = 'Pairing Test Arena'`);
}

before(async () => {
  if (!live) return;
  await cleanup(); // a previous aborted run must not wedge this one
  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(setupRoutes);
  await app.ready();

  venue = (await pool.query(
    `insert into venues (name, city) values ('Pairing Test Arena','Ahmedabad') returning *`,
  )).rows[0];

  const account = (await pool.query(
    `insert into accounts (email, password_hash, name) values ($1,$2,'Owner') returning *`,
    [EMAIL, await hashPassword('correct horse battery')],
  )).rows[0];
  await pool.query(
    `insert into account_venues (account_id, venue_id, role) values ($1,$2,'owner')`,
    [account.id, venue.id],
  );
  ownerCookie = `${COOKIE}=${(await createSession(account.id)).token}`;
});

after(async () => {
  if (!live) return;
  if (app) await app.close();
  await cleanup();
  await close();
});

const issue = () =>
  app.inject({
    method: 'POST',
    url: '/api/devices/pairing-code',
    headers: { cookie: ownerCookie },
    payload: { label: 'Counter tablet' },
  });

const claim = (code) =>
  app.inject({ method: 'POST', url: '/devices/claim', payload: { code } });

test('issuing a code requires a signed-in owner', { skip }, async () => {
  const res = await app.inject({ method: 'POST', url: '/api/devices/pairing-code', payload: {} });
  assert.equal(res.statusCode, 401);
});

test('a code is eight digits and trades for a working device token', { skip }, async () => {
  const issued = await issue();
  assert.equal(issued.statusCode, 201);
  const { code } = issued.json();
  assert.match(code, /^\d{8}$/);

  const res = await claim(code);
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.venueName, 'Pairing Test Arena');
  assert.ok(body.token);

  // The token is real: it exists, unrevoked, against this venue and no other.
  const { rows } = await pool.query(
    `select venue_id, label from device_tokens where token_hash = $1 and revoked_at is null`,
    [tokenHash(body.token)],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].venue_id, venue.id);
  assert.equal(rows[0].label, 'Counter tablet');
});

test('a code works exactly once', { skip }, async () => {
  const { code } = (await issue()).json();
  assert.equal((await claim(code)).statusCode, 201);

  const second = await claim(code);
  assert.equal(second.statusCode, 400);
  assert.match(second.json().error, /already been used/);
});

test('an expired code is refused', { skip }, async () => {
  const { code } = (await issue()).json();
  await pool.query(
    `update device_pairings set expires_at = now() - interval '1 second' where code_hash = $1`,
    [tokenHash(code)],
  );

  const res = await claim(code);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /expired/);
});

test('a malformed code is rejected without minting anything', { skip }, async () => {
  const before = (await pool.query(`select count(*)::int as n from device_tokens where venue_id = $1`, [venue.id])).rows[0].n;
  for (const bad of ['', '1234567', '123456789', 'abcdefgh', '12 34 56 7a']) {
    const res = await claim(bad);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  const after = (await pool.query(`select count(*)::int as n from device_tokens where venue_id = $1`, [venue.id])).rows[0].n;
  assert.equal(after, before);
});

test('spaces in a typed code are tolerated', { skip }, async () => {
  const { code } = (await issue()).json();
  const spaced = `${code.slice(0, 4)} ${code.slice(4)}`;
  assert.equal((await claim(spaced)).statusCode, 201);
});

/**
 * Guard against a tempting but wrong "fix": counting wrong guesses against the
 * code. A miss matches no row, so there is nothing to count it against, and
 * anything that appeared to work would in fact be counting against *other*
 * venues' live codes — letting one attacker lock out every pairing in flight.
 * Wrong guesses must therefore leave live codes completely untouched.
 */
test('wrong guesses do not disturb a live code', { skip }, async () => {
  const { code } = (await issue()).json();

  for (let i = 0; i < 8; i += 1) {
    const wrong = String((Number(code) + i + 1) % 100_000_000).padStart(8, '0');
    const res = await claim(wrong);
    assert.equal(res.statusCode, 400);
  }

  // The real code still works: no collateral damage from the misses.
  assert.equal((await claim(code)).statusCode, 201);
});

test('an unknown code never reveals whether it was wrong or expired', { skip }, async () => {
  const res = await claim('00000000');
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /not valid/);
});
