import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, close } from '@turfsync/db';
import { slotFromCalendarDate, toRange, businessDateOf } from '@turfsync/core';
import { connectForTests, SKIP } from './helpers.js';

import { MockAdapter, NotImplementedAdapter, getAdapter, resetMockAdapters } from '../apps/api/src/blocking/adapter.js';
import { encryptSession, decryptSession } from '../apps/api/src/blocking/crypto.js';
import {
  canTransition, isTerminal, nextAfterFailure, afterVerified,
  afterKillSwitch, afterSuperseded, BACKOFF_MS, MAX_ATTEMPTS,
} from '../apps/api/src/blocking/stateMachine.js';
import { diffCalendar, reconcileVenuePlatform } from '../apps/api/src/blocking/reconcile.js';
import { priorityFor, enqueueBlock, enqueueUnblock, closeQueue, withVenueLock } from '../apps/api/src/blocking/queue.js';
import { pingRedis, closeRedis } from '../apps/api/src/blocking/redis.js';
import { startBlockWorker, completeBlockTask, completeUnblockTask, escalateOverdueTasks } from '../apps/api/src/blocking/worker.js';
import { ingestPayload } from '../apps/api/src/ingest/pipeline.js';

process.env.SESSION_ENCRYPTION_KEY ||= 'test-only-key-not-for-anything-real';

const dbLive = await connectForTests();
const redisLive = dbLive ? await pingRedis() : false;
const skipDb = dbLive ? false : SKIP;
const skipRedis = redisLive ? false : 'needs Redis — run `npm run db:up` (it starts Redis too)';
const skipFull = dbLive && redisLive ? false : (dbLive ? skipRedis : SKIP);

after(async () => {
  await closeQueue();
  await closeRedis();
  await close();
});

// ---------------------------------------------------------------------------
// The state machine — pure functions, no infrastructure at all. This is the
// part of Phase 3 that has nothing to do with any specific platform.
// ---------------------------------------------------------------------------

test('the legal transition graph matches the build plan diagram', () => {
  assert.ok(canTransition('queued', 'leased'));
  assert.ok(canTransition('leased', 'submitted'));
  assert.ok(canTransition('submitted', 'verified'));
  assert.ok(canTransition('leased', 'retrying'));
  assert.ok(canTransition('retrying', 'leased'));
  assert.ok(canTransition('leased', 'failed'));

  // A cancellation can withdraw a job from any pre-terminal state...
  assert.ok(canTransition('queued', 'superseded'));
  assert.ok(canTransition('leased', 'superseded'));
  assert.ok(canTransition('retrying', 'superseded'));
  // ...and can still undo one that already verified — the plan's own words:
  // "withdrawn rather than completed and immediately undone."
  assert.ok(canTransition('verified', 'superseded'));

  // But never backwards out of a genuine terminal state.
  assert.ok(!canTransition('failed', 'queued'));
  assert.ok(!canTransition('verified', 'queued'));
});

test('verified, failed and superseded are terminal; queued and retrying are not', () => {
  assert.ok(isTerminal('failed'));
  assert.ok(isTerminal('superseded'));
  assert.ok(!isTerminal('queued'));
  assert.ok(!isTerminal('leased'));
  assert.ok(!isTerminal('retrying'));
  // verified is terminal in the forward sense (nothing else happens on its
  // own) even though a cancellation can still reach into it.
  assert.ok(isTerminal('verified'));
});

test('the backoff schedule is 5s, 30s, 3m, then terminal', () => {
  assert.deepEqual(BACKOFF_MS, [5_000, 30_000, 180_000]);
  assert.equal(MAX_ATTEMPTS, 3);

  const a1 = nextAfterFailure(0, 'timeout');
  assert.equal(a1.state, 'retrying');
  assert.equal(a1.delayMs, 5_000);
  assert.equal(a1.terminal, false);

  const a2 = nextAfterFailure(1, 'timeout');
  assert.equal(a2.delayMs, 30_000);

  const a3 = nextAfterFailure(2, 'timeout');
  assert.equal(a3.delayMs, 180_000);

  const a4 = nextAfterFailure(3, 'timeout');
  assert.equal(a4.state, 'failed');
  assert.equal(a4.terminal, true);
  assert.equal(a4.delayMs, null);
});

test('a kill switch produces a terminal failure, not a retry', () => {
  const outcome = afterKillSwitch('auto-block disabled for this venue');
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.terminal, true);
  assert.match(outcome.error, /alert-only mode/);
});

test('verified and superseded outcomes are what they say', () => {
  assert.equal(afterVerified().state, 'verified');
  assert.equal(afterSuperseded().state, 'superseded');
});

// ---------------------------------------------------------------------------
// Session encryption — also pure, no infrastructure.
// ---------------------------------------------------------------------------

test('a session round-trips through encryption intact', () => {
  const original = { cookies: [{ name: 'sid', value: 'abc123' }], capturedAt: Date.now() };
  const { blob, keyVersion } = encryptSession(original);
  assert.ok(Buffer.isBuffer(blob));
  const recovered = decryptSession(blob, keyVersion);
  assert.deepEqual(recovered, original);
});

test('two encryptions of the same session produce different blobs', () => {
  // Distinct IVs. Identical ciphertext for identical plaintext would leak
  // that two venues (or the same venue twice) hold the same session data.
  const { blob: a } = encryptSession({ same: 'data' });
  const { blob: b } = encryptSession({ same: 'data' });
  assert.notEqual(a.toString('hex'), b.toString('hex'));
});

test('a tampered blob fails to decrypt rather than returning garbage', () => {
  const { blob, keyVersion } = encryptSession({ real: 'session' });
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext
  assert.throws(() => decryptSession(tampered, keyVersion));
});

test('encryption refuses to run with no key configured', () => {
  const saved = process.env.SESSION_ENCRYPTION_KEY;
  delete process.env.SESSION_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptSession({ x: 1 }), /SESSION_ENCRYPTION_KEY is not set/);
  } finally {
    process.env.SESSION_ENCRYPTION_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

test('a platform with no real adapter fails loudly, not silently', async () => {
  const adapter = new NotImplementedAdapter('playo');
  await assert.rejects(() => adapter.login(), /No adapter is implemented for "playo"/);
  await assert.rejects(() => adapter.blockSlot({}), (e) => e.code === 'ADAPTER_NOT_IMPLEMENTED');
});

test('MockAdapter blocks, verifies, and unblocks a slot', async () => {
  const adapter = new MockAdapter('khelomore');
  const args = { externalCourtId: 'Ground 1', startMs: 1_000, endMs: 2_000 };

  assert.equal(await adapter.verifySlotBlocked(args), false);
  await adapter.blockSlot(args);
  assert.equal(await adapter.verifySlotBlocked(args), true);
  await adapter.unblockSlot(args);
  assert.equal(await adapter.verifySlotBlocked(args), false);
});

test('MockAdapter readCalendar only returns ranges overlapping the query window', async () => {
  const adapter = new MockAdapter('hudle');
  await adapter.blockSlot({ externalCourtId: 'Court A', startMs: 10_000, endMs: 20_000 });
  const inWindow = await adapter.readCalendar({ externalCourtId: 'Court A', fromMs: 0, toMs: 15_000 });
  assert.equal(inWindow.length, 1);
  const outOfWindow = await adapter.readCalendar({ externalCourtId: 'Court A', fromMs: 30_000, toMs: 40_000 });
  assert.equal(outOfWindow.length, 0);
});

test('getAdapter(mock:true) returns a MockAdapter; without it, NotImplemented', () => {
  assert.ok(getAdapter('playo', { mock: true }) instanceof MockAdapter);
  assert.ok(getAdapter('playo') instanceof NotImplementedAdapter);
});

// ---------------------------------------------------------------------------
// Reconciliation diff — pure function
// ---------------------------------------------------------------------------

test('a booking we hold that the platform shows free is a missing_block', () => {
  const drift = diffCalendar(
    [{ courtId: 'c1', bookingId: 'b1', startMs: 1000, endMs: 2000 }],
    [],
  );
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'missing_block');
  assert.equal(drift[0].bookingId, 'b1');
});

test('a range the platform blocks that we have no booking for is unexpected_block', () => {
  const drift = diffCalendar([], [{ courtId: 'c1', startMs: 1000, endMs: 2000 }]);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'unexpected_block');
});

test('a booking that matches a remote range is not drift', () => {
  const drift = diffCalendar(
    [{ courtId: 'c1', bookingId: 'b1', startMs: 1000, endMs: 2000 }],
    [{ courtId: 'c1', startMs: 1000, endMs: 2000 }],
  );
  assert.equal(drift.length, 0);
});

test('drift on one court does not leak into another', () => {
  const drift = diffCalendar(
    [{ courtId: 'c1', bookingId: 'b1', startMs: 1000, endMs: 2000 }],
    [{ courtId: 'c2', startMs: 1000, endMs: 2000 }],
  );
  // Neither side explains the other — both are drift.
  assert.equal(drift.length, 2);
});

// ---------------------------------------------------------------------------
// The queue — priority and the venue lock. Needs Redis; skips cleanly without it.
// ---------------------------------------------------------------------------

test('priority is minutes until the slot, clamped at zero', { skip: skipRedis }, () => {
  const now = Date.now();
  assert.equal(priorityFor(now + 60_000, now), 1);
  assert.equal(priorityFor(now + 30_000, now), 1); // rounds
  assert.equal(priorityFor(now - 60_000, now), 0); // never negative
});

test('a booking enqueued sooner gets a lower priority number', { skip: skipRedis }, () => {
  const now = Date.now();
  const soon = priorityFor(now + 10 * 60_000, now);
  const later = priorityFor(now + 3 * 3_600_000, now);
  assert.ok(soon < later, 'BullMQ runs the lower number first — sooner must be lower');
});

test('every job-id shape BullMQ will ever see is actually accepted by it', { skip: skipRedis }, async () => {
  // BullMQ rejects a custom jobId with colons unless it splits into exactly
  // three parts. The base block id satisfied that by luck; the retry and
  // unblock shapes did not, so both threw the first time they ran. Enqueue
  // one of each for real — validation happens inside .add().
  // A fresh id per run, so `.add()` genuinely re-validates every time. A fixed
  // id would sit in the completed set for the removeOnComplete window and the
  // next run would silently no-op on it — passing without checking anything.
  const id = randomUUID();
  const startMs = Date.now() + 3_600_000;

  await enqueueBlock({ bookingId: id, targetPlatform: 'khelomore', startMs });
  await enqueueBlock({ bookingId: id, targetPlatform: 'khelomore', startMs, attempt: 1, delayMs: 60_000 });
  await enqueueUnblock({ bookingId: id, targetPlatform: 'khelomore' });

  // Deliberately not cleaned up. These reference a booking that does not
  // exist, so the worker loads no context and skips them harmlessly, and
  // removeOnComplete ages them out. Trying to remove them instead races the
  // worker, which locks a job the moment it picks it up.
});

test('the venue lock serialises concurrent callers', { skip: skipRedis }, async () => {
  const order = [];
  const venueId = `test-venue-${Date.now()}`;

  const run = (label) =>
    withVenueLock(venueId, async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, 100));
      order.push(`${label}:end`);
    });

  await Promise.all([run('a'), run('b')]);

  // Whichever ran first must fully finish before the other starts — no
  // interleaving, which is the entire point of "concurrency 1 per venue".
  const firstEnd = order.indexOf('a:end') < order.indexOf('b:end') ? 'a' : 'b';
  const otherStart = order.indexOf(`${firstEnd === 'a' ? 'b' : 'a'}:start`);
  const firstEndIdx = order.indexOf(`${firstEnd}:end`);
  assert.ok(otherStart > firstEndIdx, `expected serial execution, got: ${order.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The worker, end to end, against MockAdapter. This is the part that proves
// the queue + state machine + echo suppression actually cohere — without ever
// having reverse-engineered a real platform.
// ---------------------------------------------------------------------------

let venue, courtA, worker;
const DATE = '2026-09-02';

before(async () => {
  if (!dbLive) return;
  await pool.query('truncate venues cascade');
  resetMockAdapters(); // every mock platform's calendar starts empty for this file's run

  venue = (await pool.query(
    `insert into venues (name, city, auto_block_enabled) values ('Block Test Arena','Ahmedabad', true) returning *`,
  )).rows[0];
  courtA = (await pool.query(
    `insert into courts (venue_id, name, sport, position) values ($1,'Court 1','Football',1) returning *`,
    [venue.id],
  )).rows[0];

  for (const [platform, label] of [['playo', 'Turf A'], ['khelomore', 'Ground 1']]) {
    await pool.query(
      `insert into platform_accounts (venue_id, platform, status) values ($1,$2,'active')`,
      [venue.id, platform],
    );
    await pool.query(
      `insert into court_mappings (court_id, platform, external_label, external_court_id, verified_at)
       values ($1,$2,$3,$3, now())`,
      [courtA.id, platform, label],
    );
  }

  // One worker for every test in this file, not one per test — BullMQ workers
  // hold a live Redis connection and starting a fresh one per test leaked a
  // connection each time (multiple workers left competing on the same queue),
  // which is what made the very first run of this suite hang on exit.
  if (redisLive) worker = startBlockWorker({ concurrency: 2 });
});

after(async () => {
  if (worker) await worker.close();
});

async function insertBooking(platform, start, end, externalBookingId = null, date = DATE) {
  const { startMs, endMs } = slotFromCalendarDate(date, start, end);
  const row = (await pool.query(
    `insert into bookings (venue_id, court_id, platform, external_booking_id, slot, business_date, status, dedupe_key, source_channel)
     values ($1,$2,$3,$4,$5::tstzrange,$6,'confirmed',$7,'manual') returning *`,
    [venue.id, courtA.id, platform, externalBookingId, toRange(startMs, endMs), businessDateOf(startMs, 6), `t:${platform}:${Math.random()}`],
  )).rows[0];
  return { row, startMs, endMs };
}

async function waitForState(bookingId, targetPlatform, state, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { rows } = await pool.query(
      `select state, last_error from block_jobs where booking_id = $1 and target_platform = $2`,
      [bookingId, targetPlatform],
    );
    if (rows[0]?.state === state) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  const { rows } = await pool.query(
    `select state, last_error from block_jobs where booking_id = $1 and target_platform = $2`,
    [bookingId, targetPlatform],
  );
  throw new Error(`timed out waiting for state=${state}, last seen: ${JSON.stringify(rows[0])}`);
}

test('a booking on Playo creates an assisted block task on KheloMore, which a human then confirms', { skip: skipFull }, async () => {
  const { row } = await insertBooking('playo', '18:00', '19:00');
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );
  await enqueueBlock({ bookingId: row.id, targetPlatform: 'khelomore', startMs: Date.parse(`${DATE}T18:00:00Z`) });

  // The worker creates a task and stops — it never calls a platform adapter.
  const submitted = await waitForState(row.id, 'khelomore', 'submitted');
  assert.ok(submitted, 'expected the job to reach submitted (task visible to staff) on its own');
  const { rows: dueRows } = await pool.query(`select due_by from block_jobs where booking_id = $1`, [row.id]);
  assert.ok(dueRows[0].due_by, 'a submitted task must carry an SLA deadline');

  // A human blocks it in the KheloMore app themselves, then taps Done — this
  // is what the sync-tasks API calls.
  const jobId = (await pool.query(`select id from block_jobs where booking_id = $1`, [row.id])).rows[0].id;
  const completed = await completeBlockTask({ jobId, venueId: venue.id, completedBy: 'Test Staff' });
  assert.equal(completed.state, 'verified');

  const { rows: receipts } = await pool.query(
    `select * from block_receipts where block_job_id = $1`,
    [jobId],
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].verification_method, 'staff_confirmed');
});

test('completing a task that is not awaiting confirmation is rejected, not silently accepted', { skip: skipFull }, async () => {
  const { row } = await insertBooking('playo', '17:00', '18:00');
  const startMs = Date.parse(`${DATE}T17:00:00Z`);
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );
  await enqueueBlock({ bookingId: row.id, targetPlatform: 'khelomore', startMs });
  await waitForState(row.id, 'khelomore', 'submitted');
  const jobId = (await pool.query(`select id from block_jobs where booking_id = $1`, [row.id])).rows[0].id;

  await completeBlockTask({ jobId, venueId: venue.id });
  // Already verified — completing it again must be refused, not treated as a
  // harmless no-op (that would hide a staff member double-tapping Done on a
  // task that was reassigned or already handled by someone else).
  await assert.rejects(
    () => completeBlockTask({ jobId, venueId: venue.id }),
    (e) => e.statusCode === 409,
  );
});

test('an overdue task is escalated once, not on every sweep', { skip: skipFull }, async () => {
  const { row } = await insertBooking('playo', '23:00', '23:59');
  const startMs = Date.parse(`${DATE}T23:00:00Z`);
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );
  await enqueueBlock({ bookingId: row.id, targetPlatform: 'khelomore', startMs });
  await waitForState(row.id, 'khelomore', 'submitted');

  // Force it overdue rather than waiting out the real 3-minute SLA.
  await pool.query(`update block_jobs set due_by = now() - interval '1 minute' where booking_id = $1`, [row.id]);

  const first = await escalateOverdueTasks();
  assert.ok(first.blocksEscalated >= 1);
  const { rows } = await pool.query(`select escalated_at from block_jobs where booking_id = $1`, [row.id]);
  assert.ok(rows[0].escalated_at, 'expected escalated_at to be stamped');

  const second = await escalateOverdueTasks();
  const { rows: after } = await pool.query(`select escalated_at from block_jobs where booking_id = $1`, [row.id]);
  assert.equal(after[0].escalated_at.getTime(), rows[0].escalated_at.getTime(), 'a second sweep must not re-escalate the same task');
});

test('the echo the block task produces is suppressed, not ingested as a new booking', { skip: skipFull }, async () => {
  const { row } = await insertBooking('playo', '20:00', '21:00');
  const startMs = Date.parse(`${DATE}T20:00:00Z`);
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );
  await enqueueBlock({ bookingId: row.id, targetPlatform: 'khelomore', startMs });
  // The echo expectation is written the moment the task is created — before
  // any human has actually gone and blocked it — because it must be in place
  // before the real notification the human's action produces can arrive.
  await waitForState(row.id, 'khelomore', 'submitted');

  const echo = await ingestPayload({
    venueId: venue.id,
    rawText: "New Booking Alert\nA new booking has been received at Pickle And Pitch Club.\nCustomer: Should Not Exist\nGame Day: 02 Sep 2026\nSlot: 08:00 PM - 09:00 PM\nProperty: Ground 1\nAmount Paid: 637.0\nReview booking details here: http://rml.fm/tG1xgp. Prepare accordingly!\nTeam KheloMore",
    channel: 'notification',
  });
  assert.equal(echo.outcome, 'echo_suppressed');
});

test('a platform kill switch produces a terminal failure with no adapter call', { skip: skipFull }, async () => {
  await pool.query(`update platform_accounts set status = 'paused' where venue_id = $1 and platform = 'khelomore'`, [venue.id]);
  const { row } = await insertBooking('playo', '22:00', '23:00');
  const startMs = Date.parse(`${DATE}T22:00:00Z`);
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );
  await enqueueBlock({ bookingId: row.id, targetPlatform: 'khelomore', startMs });

  const final = await waitForState(row.id, 'khelomore', 'failed');
  assert.match(final.last_error, /alert-only mode/);

  await pool.query(`update platform_accounts set status = 'active' where venue_id = $1 and platform = 'khelomore'`, [venue.id]);
});

test('cancelling a still-queued job supersedes it outright — no adapter call', { skip: skipDb }, async () => {
  // Deliberately no worker running here: the point is that a job which never
  // got to execute is withdrawn by the pipeline itself, not by anything the
  // worker does.
  const { row } = await insertBooking('playo', '13:00', '14:00', 'PLY-QUEUEDTEST-1');
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );

  const cancelled = await ingestPayload({
    venueId: venue.id,
    rawText:
      'Booking Cancelled\nTurf A · Wed, 02 Sep\n01:00 PM - 02:00 PM\nSomeone · 9812340002\n' +
      'Booking ID: PLY-QUEUEDTEST-1',
    channel: 'notification',
  });
  assert.equal(cancelled.outcome, 'cancelled');

  const { rows } = await pool.query(
    `select state from block_jobs where booking_id = $1 and target_platform = 'khelomore'`,
    [row.id],
  );
  assert.equal(rows[0].state, 'superseded');
});

test('cancelling a verified booking opens an unblock task, which a human then confirms', { skip: skipFull }, async () => {
  const { row } = await insertBooking('playo', '15:00', '16:00', 'PLY-VERIFIEDTEST-1');
  const startMs = Date.parse(`${DATE}T15:00:00Z`);
  await pool.query(
    `insert into block_jobs (booking_id, target_platform, state, priority) values ($1,'khelomore','queued',0)`,
    [row.id],
  );
  await enqueueBlock({ bookingId: row.id, targetPlatform: 'khelomore', startMs });
  await waitForState(row.id, 'khelomore', 'submitted');
  const jobId = (await pool.query(`select id from block_jobs where booking_id = $1`, [row.id])).rows[0].id;
  await completeBlockTask({ jobId, venueId: venue.id });

  // Cancel through the real pipeline path — the same finishCancellation()
  // that runs in production, including its enqueueUnblock after commit.
  const cancelled = await ingestPayload({
    venueId: venue.id,
    rawText:
      'Booking Cancelled\nTurf A · Wed, 02 Sep\n03:00 PM - 04:00 PM\nSomeone · 9812340003\n' +
      'Booking ID: PLY-VERIFIEDTEST-1',
    channel: 'notification',
  });
  assert.equal(cancelled.outcome, 'cancelled');

  // The worker opens an unblock task — the job stays 'verified' (the slot IS
  // still blocked on KheloMore until a human actually releases it there) but
  // now carries an open unblock request.
  const started = Date.now();
  let unblockRequestedAt = null;
  while (Date.now() - started < 8_000 && !unblockRequestedAt) {
    const { rows } = await pool.query(`select unblock_requested_at, state from block_jobs where id = $1`, [jobId]);
    unblockRequestedAt = rows[0]?.unblock_requested_at;
    if (!unblockRequestedAt) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(unblockRequestedAt, 'expected an unblock task to open');

  const completed = await completeUnblockTask({ jobId, venueId: venue.id, completedBy: 'Test Staff' });
  assert.equal(completed.state, 'superseded');
});

test('reconciliation flags a booking the mock platform has forgotten', { skip: skipDb }, async () => {
  // reconcileVenuePlatform's own window is `now - 2h` to `now + windowDays` —
  // real wall-clock time, not the fictional DATE the rest of this file's
  // bookings use. Going through slotFromCalendarDate here would mean
  // converting an IST wall-clock guess back to an absolute instant just to
  // land near "now" — simpler and unambiguous to build the range from
  // Date.now() directly and skip that round trip entirely.
  const startMs = Date.now() + 3_600_000;
  const endMs = startMs + 3_600_000;
  const row = (await pool.query(
    `insert into bookings (venue_id, court_id, platform, slot, business_date, status, dedupe_key, source_channel)
     values ($1,$2,'playo',$3::tstzrange,$4,'confirmed',$5,'manual') returning *`,
    [venue.id, courtA.id, toRange(startMs, endMs), businessDateOf(startMs, 6), `t:recon:${Math.random()}`],
  )).rows[0];

  // No block_jobs row and no adapter call at all — this booking exists in our
  // ledger but nothing ever told KheloMore's calendar about it. That is
  // exactly the drift nightly reconciliation exists to catch. Doesn't need
  // the queue or Redis at all — reconciliation only ever reads Postgres and
  // calls the (mock) adapter directly.
  const report = await reconcileVenuePlatform({ venueId: venue.id, platform: 'khelomore', mock: true, windowDays: 1 });
  const flagged = report.drift.find((d) => d.bookingId === row.id);
  assert.ok(flagged, 'expected the unblocked booking to show up as missing_block drift');
  assert.equal(flagged.kind, 'missing_block');
});
