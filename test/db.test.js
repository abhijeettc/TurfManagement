import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, close, tx, trySavepoint, SQLSTATE, DATABASE_URL } from '@turfsync/db';
import { slotFromCalendarDate, toRange, businessDateOf } from '@turfsync/core';
import { ingestPayload } from '../apps/api/src/ingest/pipeline.js';
import { expectEcho } from '../apps/api/src/ingest/echo.js';
import { connectForTests, SKIP } from './helpers.js';

// These need Postgres. `npm run db:up` first; without it they skip rather than
// fail, so `npm test` stays useful on a laptop with nothing running.
//
// They run against their own database (see .env.test) because they truncate
// between runs — pointed at the dev database they would silently delete the
// venue you were looking at.
const live = await connectForTests();
const skip = live ? false : SKIP;

// `court` is the only court with platform mappings, so the pipeline tests land
// there. The constraint tests get their own courts — otherwise the rows they
// leave behind collide with the pipeline's slots and every later assertion is
// really testing test-ordering.
let venue, court, otherCourt, cCourt;
const DATE = '2026-09-02';

before(async () => {
  if (!live) return;
  await pool.query('truncate venues cascade');
  venue = (await pool.query(
    `insert into venues (name, city) values ('Test Arena','Ahmedabad') returning *`,
  )).rows[0];
  court = (await pool.query(
    `insert into courts (venue_id, name, sport, position) values ($1,'Court 1','Box cricket',1) returning *`,
    [venue.id],
  )).rows[0];
  otherCourt = (await pool.query(
    `insert into courts (venue_id, name, sport, position) values ($1,'Court 2','Football 7s',2) returning *`,
    [venue.id],
  )).rows[0];
  cCourt = (await pool.query(
    `insert into courts (venue_id, name, sport, position) values ($1,'Court 3','Pickleball',3) returning *`,
    [venue.id],
  )).rows[0];

  for (const [platform, bps, label] of [
    ['playo', 1400, 'Turf A'], ['khelomore', 1500, 'Ground 1'],
    ['hudle', 1200, '5-a-side Main'], ['district', 1800, 'Football Court 1'],
  ]) {
    await pool.query(
      `insert into platform_accounts (venue_id, platform, commission_bps) values ($1,$2,$3)`,
      [venue.id, platform, bps],
    );
    await pool.query(
      `insert into court_mappings (court_id, platform, external_label, external_court_id, verified_at)
       values ($1,$2,$3,$3, now())`,
      [court.id, platform, label],
    );
  }
});

after(async () => { await close(); });

async function insertBooking(courtId, start, end, platform = 'playo', status = 'confirmed', date = DATE) {
  const { startMs, endMs } = slotFromCalendarDate(date, start, end);
  return pool.query(
    `insert into bookings (venue_id, court_id, platform, slot, business_date, status, dedupe_key, source_channel)
     values ($1,$2,$3,$4::tstzrange,$5,$6,$7,'manual') returning id`,
    [venue.id, courtId, platform, toRange(startMs, endMs), businessDateOf(startMs, 6), status,
     `t:${platform}:${courtId}:${start}:${Math.random()}`],
  );
}

// ---------------------------------------------------------------------------
// The week-one experiment from the build plan. Twenty minutes of work that
// validates the single primitive the whole product rests on.
// ---------------------------------------------------------------------------

test('the exclusion constraint rejects an overlap across midnight', { skip }, async () => {
  // 2 Sep 23:00 → 3 Sep 01:00. The clash is a slot booked on the 3rd that
  // reaches back into the night before — the case a naive per-day calendar
  // model cannot even express, let alone refuse.
  await insertBooking(cCourt.id, '23:00', '01:00');
  await assert.rejects(
    () => insertBooking(cCourt.id, '00:30', '01:30', 'hudle', 'confirmed', '2026-09-03'),
    (e) => e.code === SQLSTATE.EXCLUSION_VIOLATION,
    'a 3 Sep 00:30 booking overlapping a 2 Sep 23:00–01:00 slot must be refused',
  );
});

test('00:30 on the same calendar date is the night before, and does not clash', { skip }, async () => {
  // The mirror of the test above, and the reason business_date exists: these
  // two slots are 22.5 hours apart despite sharing a calendar date.
  const r = await insertBooking(cCourt.id, '00:30', '01:30', 'khelomore');
  assert.ok(r.rows[0].id);
});

test('the same cross-midnight slot on a different court is fine', { skip }, async () => {
  const r = await insertBooking(otherCourt.id, '23:00', '01:00');
  assert.ok(r.rows[0].id, 'one physical pitch per constraint, not one per venue');
});

test('back-to-back slots do not overlap — the range is half-open', { skip }, async () => {
  await insertBooking(cCourt.id, '18:00', '19:00', 'hudle');
  const r = await insertBooking(cCourt.id, '19:00', '20:00', 'khelomore');
  assert.ok(r.rows[0].id, '19:00 must be free the instant the 18:00 slot ends');
});

test('a cancelled booking releases its slot', { skip }, async () => {
  await insertBooking(cCourt.id, '15:00', '16:00', 'playo', 'cancelled');
  const r = await insertBooking(cCourt.id, '15:00', '16:00', 'district');
  assert.ok(r.rows[0].id, 'the partial index only covers confirmed rows');
});

test('a conflicted row sits outside the constraint so it can be recorded', { skip }, async () => {
  await insertBooking(cCourt.id, '12:00', '13:00', 'playo');
  const r = await insertBooking(cCourt.id, '12:00', '13:00', 'district', 'conflicted');
  assert.ok(r.rows[0].id, 'the losing side of a conflict must still be storable');
});

test('a savepoint keeps the transaction alive after 23P01', { skip }, async () => {
  await insertBooking(cCourt.id, '09:00', '10:00');
  const outcome = await tx(async (client) => {
    const caught = await trySavepoint(
      client,
      'sp',
      () => client.query(
        `insert into bookings (venue_id, court_id, platform, slot, business_date, status, dedupe_key, source_channel)
         values ($1,$2,'hudle',$3::tstzrange,$4,'confirmed','x','manual')`,
        [venue.id, cCourt.id, toRange(...Object.values(slotFromCalendarDate(DATE, '09:30', '10:30'))), DATE],
      ),
      SQLSTATE.EXCLUSION_VIOLATION,
      () => 'conflict',
    );
    // The transaction must still be usable — this is the whole point.
    const { rows } = await client.query('select 1 as ok');
    return { caught, stillAlive: rows[0].ok === 1 };
  });
  assert.equal(outcome.caught, 'conflict');
  assert.equal(outcome.stillAlive, true);
});

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

test('a notification becomes a booking on the board', { skip }, async () => {
  const result = await ingestPayload({
    venueId: venue.id,
    rawText: 'New Booking Confirmed\nTurf A · Wed, 02 Sep\n07:00 PM - 08:00 PM\nRohit Menon · 9912345651\nBooking ID: PLY-9000001',
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:00:00Z'),
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.businessDate, '2026-09-02');
  assert.equal(result.parseStatus, 'template');
});

test('the confirmation email enriches the booking rather than duplicating it', { skip }, async () => {
  const email = await ingestPayload({
    venueId: venue.id,
    rawText:
      'Playo Partner — Booking Confirmation\nCourt: Turf A\nDate: 02 Sep 2026\nSlot: 07:00 PM - 08:00 PM\n' +
      'Customer: Rohit Menon (9912345651)\nBooking ID: PLY-9000001\nBooking Amount: Rs. 1,100.00\n' +
      'Playo Commission (14%): Rs. 154.00',
    channel: 'email',
    receivedAt: Date.parse('2026-09-02T12:01:00Z'),
  });
  assert.equal(email.outcome, 'enriched', 'the two channels join on the dedupe key');

  const { rows } = await pool.query('select * from bookings where id = $1', [email.bookingId]);
  assert.equal(rows[0].gross_paise, 110000, 'notifications carry speed, email carries the money');
  assert.equal(rows[0].commission_paise, 15400);
  assert.equal(rows[0].net_paise, 94600);
});

test('a second platform selling the same slot opens a conflict, not a 500', { skip }, async () => {
  const result = await ingestPayload({
    venueId: venue.id,
    rawText: "Hi! You have a new booking for your venue\n\nMeera Nair is scheduled to play Cricket Nets at Pickle & Pitch Club - Football Court 1 on 02 Sep 2026 07:00 PM - 08:00 PM.\n\nBooking ID: DS9000002\n\nOpen the District Play Partner app for full details.",
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:02:00Z'),
  });
  assert.equal(result.outcome, 'conflict');
  assert.ok(result.conflictId);

  const { rows } = await pool.query('select * from conflicts where id = $1', [result.conflictId]);
  assert.equal(rows[0].booking_ids.length, 2, 'both claimants are recorded');
});

test('our own block coming back as a notification is suppressed, not ingested', { skip }, async () => {
  // Finding 1: without this the pipeline blocks the other platforms in response
  // to its own write, one of which is where the booking started.
  const { startMs, endMs } = slotFromCalendarDate(DATE, '21:00', '22:00');
  await tx((client) =>
    expectEcho(client, {
      venueId: venue.id, platform: 'hudle', externalCourtId: '5-a-side Main', startMs, endMs,
    }),
  );

  const result = await ingestPayload({
    venueId: venue.id,
    rawText: "Hi Pickle And Pitch Club, new booking for your venue.\n\nBlocked Echo is scheduled to play Cricket Nets (5-a-side Main) at Pickle and Pitch Club | Hinjewadi Phase 2 on 02 Sep 2026 9:00 PM - 10:00 PM.\n\nBooking ID: HUD9000003\n\nOpen the Hudle Partner app for full details.",
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:03:00Z'),
  });
  assert.equal(result.outcome, 'echo_suppressed');

  const { rows } = await pool.query(
    `select count(*)::int as n from bookings where external_booking_id = 'HDL-9000003'`,
  );
  assert.equal(rows[0].n, 0, 'no booking may be created from our own write');
});

test('an echo expectation is consumed once, so a real booking after it still lands', { skip }, async () => {
  const result = await ingestPayload({
    venueId: venue.id,
    rawText: "Hi Pickle And Pitch Club, new booking for your venue.\n\nReal Customer is scheduled to play Cricket Nets (5-a-side Main) at Pickle and Pitch Club | Hinjewadi Phase 2 on 02 Sep 2026 10:00 PM - 11:00 PM.\n\nBooking ID: HUD9000004\n\nOpen the Hudle Partner app for full details.",
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:04:00Z'),
  });
  assert.equal(result.outcome, 'created');
});

test('an unreadable payload is logged, not lost and not retried forever', { skip }, async () => {
  const result = await ingestPayload({
    venueId: venue.id,
    rawText: 'Playo has a new offer for you! 20% off your next booking.',
    channel: 'notification',
  });
  assert.equal(result.outcome, 'parse_failed');

  const { rows } = await pool.query('select * from notification_logs where id = $1', [result.logId]);
  assert.equal(rows[0].parse_status, 'failed');
  assert.ok(rows[0].raw_text.includes('20% off'), 'the raw payload survives for the fixture corpus');
});

test('a booking on a court we have not mapped is flagged, never guessed at', { skip }, async () => {
  const result = await ingestPayload({
    venueId: venue.id,
    rawText: 'New Booking Confirmed\nTurf Z · Wed, 02 Sep\n08:00 PM - 09:00 PM\nGhost Player · 9912345000\nBooking ID: PLY-9000005',
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:05:00Z'),
  });
  assert.equal(result.outcome, 'unmapped_court');
});

test('a cancellation releases the slot for resale', { skip }, async () => {
  await ingestPayload({
    venueId: venue.id,
    rawText: 'New Booking Confirmed\nTurf A · Wed, 02 Sep\n04:00 PM - 05:00 PM\nEarly Bird · 9912345111\nBooking ID: PLY-9000006',
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:06:00Z'),
  });

  const cancelled = await ingestPayload({
    venueId: venue.id,
    rawText: 'Booking Cancelled\nTurf A · Wed, 02 Sep\n04:00 PM - 05:00 PM\nEarly Bird · 9912345111\nBooking ID: PLY-9000006',
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:07:00Z'),
  });
  assert.equal(cancelled.outcome, 'cancelled');

  // And the slot is genuinely free again — a different platform can sell it.
  const resold = await ingestPayload({
    venueId: venue.id,
    rawText: "New Booking Alert\nA new booking has been received at Pickle And Pitch Club.\nCustomer: New Customer\nGame Day: 02 Sep 2026\nSlot: 04:00 PM - 05:00 PM\nProperty: Ground 1\nAmount Paid: 637.0\nReview booking details here: http://rml.fm/tG1xgp. Prepare accordingly!\nTeam KheloMore",
    channel: 'notification',
    receivedAt: Date.parse('2026-09-02T12:08:00Z'),
  });
  assert.equal(resold.outcome, 'created', 'a cancelled slot must be resellable');
});
