import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { pool, close, DATABASE_URL } from '@turfsync/db';
import { hashPassword, verifyPassword } from '../apps/api/src/auth/passwords.js';
import { createSession, resolveSession, revokeSession, purgeExpired } from '../apps/api/src/auth/sessions.js';
import { requireVenue, requireDevice, venuesFor, CAN, tokenHash } from '../apps/api/src/auth/guard.js';
import { connectForTests, SKIP } from './helpers.js';

const live = await connectForTests();
const skip = live ? false : SKIP;

// Two venues with different owners. Almost every test here is really asking the
// same question: can venue A's people reach venue B's data.
let alice, bob, staff, partner, venueA, venueB, deviceA;

before(async () => {
  if (!live) return;
  await pool.query('truncate venues, accounts cascade');

  const mkAccount = async (email, name) =>
    (await pool.query(
      `insert into accounts (email, password_hash, name) values ($1,$2,$3) returning *`,
      [email, await hashPassword('correct horse battery'), name],
    )).rows[0];

  const mkVenue = async (name) =>
    (await pool.query(`insert into venues (name, city) values ($1,'Ahmedabad') returning *`, [name])).rows[0];

  alice = await mkAccount('alice@a.in', 'Alice');
  bob = await mkAccount('bob@b.in', 'Bob');
  staff = await mkAccount('staff@a.in', 'Counter');
  partner = await mkAccount('partner@a.in', 'Partner');

  venueA = await mkVenue('Venue A');
  venueB = await mkVenue('Venue B');

  const link = (account, venue, role) =>
    pool.query(`insert into account_venues (account_id, venue_id, role) values ($1,$2,$3)`, [account.id, venue.id, role]);

  await link(alice, venueA, 'owner');
  await link(staff, venueA, 'staff');
  await link(partner, venueA, 'partner');
  await link(bob, venueB, 'owner');

  deviceA = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into device_tokens (venue_id, token_hash, paired_at) values ($1,$2,now())`,
    [venueA.id, createHash('sha256').update(deviceA).digest('hex')],
  );
});

after(async () => { await close(); });

/** Minimal stand-in for a Fastify request. */
const req = (account, extra = {}) => ({ account, query: {}, params: {}, body: {}, headers: {}, ...extra });

// ---------------------------------------------------------------- passwords

test('a password round-trips and a wrong one is refused', { skip }, async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batteri', hash), false);
});

test('the same password hashes differently every time', { skip }, async () => {
  // Distinct salts. Identical hashes would tell an attacker with the dump which
  // accounts share a password.
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse battery', b), true);
});

test('a short password is refused', { skip }, async () => {
  await assert.rejects(() => hashPassword('short'), /at least 8/);
});

test('a malformed stored hash is a rejection, not a crash', { skip }, async () => {
  assert.equal(await verifyPassword('anything', 'garbage'), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', null), false);
});

// ---------------------------------------------------------------- sessions

test('a session resolves to its account, and the raw token is never stored', { skip }, async () => {
  const { token } = await createSession(alice.id);
  const found = await resolveSession(token);
  assert.equal(found.id, alice.id);

  const { rows } = await pool.query('select token_hash from sessions where account_id = $1', [alice.id]);
  assert.ok(rows.length);
  for (const row of rows) {
    assert.notEqual(row.token_hash, token, 'the raw token must never be in the table');
  }
});

test('logout revokes server-side, not just in the browser', { skip }, async () => {
  const { token } = await createSession(alice.id);
  assert.ok(await resolveSession(token));
  await revokeSession(token);
  // A client that keeps the cookie must still be refused.
  assert.equal(await resolveSession(token), null);
});

test('an expired session does not resolve, and gets purged', { skip }, async () => {
  const { token } = await createSession(alice.id);
  await pool.query(
    `update sessions set expires_at = now() - interval '1 day'
      where token_hash = $1`,
    [createHash('sha256').update(token).digest('hex')],
  );
  assert.equal(await resolveSession(token), null);
  assert.ok((await purgeExpired()) >= 1);
});

test('a garbage token resolves to nothing', { skip }, async () => {
  assert.equal(await resolveSession('not-a-token'), null);
  assert.equal(await resolveSession(''), null);
  assert.equal(await resolveSession(undefined), null);
});

// ---------------------------------------------------------------- tenancy

test('an owner reaches their own venue', { skip }, async () => {
  const { venue, role } = await requireVenue(req(alice), 'board:read');
  assert.equal(venue.id, venueA.id);
  assert.equal(role, 'owner');
});

test("an owner cannot reach another owner's venue", { skip }, async () => {
  // The whole point of the phase. Before this, resolveVenue() returned
  // whichever venue was first in the table.
  await assert.rejects(
    () => requireVenue(req(alice, { query: { venue: venueB.id } }), 'board:read'),
    (e) => e.statusCode === 403,
  );
});

test('a venue that does not exist and one you cannot see look identical', { skip }, async () => {
  // Distinguishing them would let anyone enumerate real venue ids.
  const missing = await requireVenue(req(alice, { query: { venue: '00000000-0000-0000-0000-000000000000' } }))
    .then(() => null, (e) => e.message);
  const forbidden = await requireVenue(req(alice, { query: { venue: venueB.id } }))
    .then(() => null, (e) => e.message);
  assert.equal(missing, forbidden);
});

test('a venue id in the body cannot override membership either', { skip }, async () => {
  await assert.rejects(
    () => requireVenue(req(alice, { body: { venueId: venueB.id } }), 'booking:create'),
    (e) => e.statusCode === 403,
  );
});

// ---------------------------------------------------------------- roles

test('staff runs the counter but never sees the money', { skip }, async () => {
  await requireVenue(req(staff), 'board:read');
  await requireVenue(req(staff), 'booking:create');
  await requireVenue(req(staff), 'conflict:resolve');

  for (const permission of ['money:read', 'setup:read', 'setup:write', 'device:pair']) {
    await assert.rejects(
      () => requireVenue(req(staff), permission),
      (e) => e.statusCode === 403,
      `staff must not hold ${permission}`,
    );
  }
});

test('a partner sees the money and nothing else', { skip }, async () => {
  await requireVenue(req(partner), 'money:read');

  for (const permission of ['board:read', 'booking:create', 'conflict:read', 'setup:read']) {
    await assert.rejects(
      () => requireVenue(req(partner), permission),
      (e) => e.statusCode === 403,
      `a partner must not hold ${permission}`,
    );
  }
});

test('every permission in CAN is reachable by at least one role', { skip }, () => {
  // A permission no role holds is dead code that will read as a mystery 403.
  for (const [permission, roles] of Object.entries(CAN)) {
    assert.ok(roles.length > 0, `${permission} is held by nobody`);
    for (const role of roles) {
      assert.ok(['owner', 'staff', 'partner'].includes(role), `${permission} names unknown role ${role}`);
    }
  }
});

test('an unknown permission is a programming error, not a silent allow', { skip }, async () => {
  await assert.rejects(() => requireVenue(req(alice), 'nonsense:read'), /unknown permission/);
});

test('venuesFor lists only what the account holds', { skip }, async () => {
  assert.deepEqual((await venuesFor(alice.id)).map((v) => v.id), [venueA.id]);
  assert.deepEqual((await venuesFor(bob.id)).map((v) => v.id), [venueB.id]);
});

// ---------------------------------------------------------------- devices

test('a device token identifies its venue without the client naming it', { skip }, async () => {
  const request = { headers: { 'x-device-token': deviceA } };
  const { venue } = await requireDevice(request);
  assert.equal(venue.id, venueA.id);
});

test('an unknown or revoked device token is refused', { skip }, async () => {
  await assert.rejects(
    () => requireDevice({ headers: { 'x-device-token': 'nope' } }),
    (e) => e.statusCode === 401,
  );
  await assert.rejects(
    () => requireDevice({ headers: {} }),
    (e) => e.statusCode === 401,
  );

  const revoked = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into device_tokens (venue_id, token_hash, revoked_at) values ($1,$2,now())`,
    [venueA.id, tokenHash(revoked)],
  );
  await assert.rejects(
    () => requireDevice({ headers: { 'x-device-token': revoked } }),
    (e) => e.statusCode === 401,
  );
});

test('device tokens are stored hashed', { skip }, async () => {
  const { rows } = await pool.query('select token_hash from device_tokens where venue_id = $1', [venueA.id]);
  for (const row of rows) {
    assert.notEqual(row.token_hash, deviceA);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  }
});
