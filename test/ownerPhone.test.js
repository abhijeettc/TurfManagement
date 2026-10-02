import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pool, close } from '@turfsync/db';
import { hashPassword } from '../apps/api/src/auth/passwords.js';
import { resolveOwnerPhone, notifyOwner } from '../apps/api/src/ownerPhone.js';
import { connectForTests, SKIP } from './helpers.js';

const live = await connectForTests();
const skip = live ? false : SKIP;

let venueWithPhone, venueNoPhone, venueTwoOwners;

before(async () => {
  if (!live) return;
  await pool.query('truncate venues, accounts cascade');

  const mkAccount = async (email, phone) =>
    (await pool.query(
      `insert into accounts (email, password_hash, phone) values ($1,$2,$3) returning *`,
      [email, await hashPassword('correct horse battery'), phone],
    )).rows[0];

  const mkVenue = async (name) =>
    (await pool.query(`insert into venues (name, city) values ($1,'Ahmedabad') returning *`, [name])).rows[0];

  const link = (account, venue, role, createdAt = 'now()') =>
    pool.query(
      `insert into account_venues (account_id, venue_id, role, created_at) values ($1,$2,$3,${createdAt})`,
      [account.id, venue.id, role],
    );

  const withPhone = await mkAccount('owner-with-phone@a.in', '+919812345678');
  venueWithPhone = await mkVenue('Has Phone');
  await link(withPhone, venueWithPhone, 'owner');

  const noPhone = await mkAccount('owner-no-phone@a.in', null);
  venueNoPhone = await mkVenue('No Phone');
  await link(noPhone, venueNoPhone, 'owner');

  const earlierOwner = await mkAccount('earlier-owner@a.in', '+919000000001');
  const laterOwner = await mkAccount('later-owner@a.in', '+919000000002');
  venueTwoOwners = await mkVenue('Two Owners');
  await link(earlierOwner, venueTwoOwners, 'owner', "now() - interval '1 day'");
  await link(laterOwner, venueTwoOwners, 'owner');
});

after(async () => { await close(); });

test('resolves the owner phone from account_venues + accounts', { skip }, async () => {
  const phone = await resolveOwnerPhone(pool, venueWithPhone.id);
  assert.equal(phone, '+919812345678');
});

test('returns null when no owner has a phone on file', { skip }, async () => {
  const phone = await resolveOwnerPhone(pool, venueNoPhone.id);
  assert.equal(phone, null);
});

test('prefers the earliest-linked owner when several have phones', { skip }, async () => {
  const phone = await resolveOwnerPhone(pool, venueTwoOwners.id);
  assert.equal(phone, '+919000000001');
});

test('returns null for an unknown venue rather than throwing', { skip }, async () => {
  const phone = await resolveOwnerPhone(pool, '00000000-0000-0000-0000-000000000000');
  assert.equal(phone, null);
});

test('notifyOwner sends to the resolved phone', { skip }, async () => {
  const logged = mock.method(console, 'log', () => {});
  try {
    const result = await notifyOwner(pool, venueWithPhone.id, 'device_silent', { label: 'Tablet', minutes: 20 });
    assert.equal(result.delivered, false); // console provider in tests
    assert.equal(logged.mock.callCount(), 1);
    assert.match(logged.mock.calls[0].arguments[0], /\+919812345678/);
  } finally {
    logged.mock.restore();
  }
});

test('notifyOwner logs and skips, without throwing, when nobody has a phone on file', { skip }, async () => {
  const warned = mock.method(console, 'warn', () => {});
  const logged = mock.method(console, 'log', () => {});
  try {
    const result = await notifyOwner(pool, venueNoPhone.id, 'device_silent', { label: 'Tablet', minutes: 20 });
    assert.deepEqual(result, { delivered: false, provider: 'skipped-no-phone' });
    assert.equal(warned.mock.callCount(), 1);
    assert.equal(logged.mock.callCount(), 0); // never reached sendWhatsApp's console log
  } finally {
    warned.mock.restore();
    logged.mock.restore();
  }
});
