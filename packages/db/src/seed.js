import { randomBytes, createHash, scryptSync } from 'node:crypto';
import { pool, close } from './pool.js';
import {
  slotFromCalendarDate, businessDateOf, toRange, addDays,
  dedupeKey, commissionPaise, normalizePhone,
} from '@turfsync/core';

// Example data for a fictional venue. It reproduces the design prototype's
// evening exactly, so `npm run dev` opens on the board you signed off — and it
// carries a month of history behind it so the money view computes real totals
// rather than displaying constants.

const VENUE = { name: 'Kickoff Arena', locality: 'Bopal', city: 'Ahmedabad', plan: 'pro' };

// Demo logins. Three roles, because the interesting thing about the access
// layer is what each role CANNOT see: staff never sees the money, a partner
// never sees the board.
const LOGINS = [
  { email: 'owner@kickoffarena.in',   password: 'turfsync123', name: 'Jignesh Patel', phone: '+919812345678', role: 'owner' },
  { email: 'counter@kickoffarena.in', password: 'turfsync123', name: 'Priya (counter)', role: 'staff' },
  { email: 'ruchi@kickoffarena.in',   password: 'turfsync123', name: 'Ruchi Mehta', role: 'partner' },
];

// Same scrypt parameters as apps/api/src/auth/passwords.js. Duplicated rather
// than imported because the seed must not depend on the API package.
const N = 32768;
const MAXMEM = 64 * 1024 * 1024;
function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 64, { N, maxmem: MAXMEM });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const COURTS = [
  { name: 'Court 1', sport: 'Box cricket · 5-a-side', position: 1 },
  { name: 'Court 2', sport: 'Football 7s', position: 2 },
  { name: 'Court 3', sport: 'Pickleball ×2', position: 3 },
];

const ACCOUNTS = [
  { platform: 'playo', bps: 1400, cycle: 'Weekly · Tue', expiresInDays: 21 },
  { platform: 'khelomore', bps: 1500, cycle: 'Fortnightly', expiresInDays: 30 },
  { platform: 'hudle', bps: 1200, cycle: 'Weekly · Fri', expiresInDays: 14 },
  { platform: 'district', bps: 1800, cycle: 'Monthly · 7th', expiresInDays: 2 },
  { platform: 'direct', bps: 0, cycle: 'Immediate', expiresInDays: null },
];

// Every platform names the same pitch differently. Court 3 is deliberately
// unmapped on Hudle — an unfinished mapping is the normal state of a venue in
// its first week, and the board should say so rather than pretend.
const MAPPINGS = {
  'Court 1': { playo: 'Turf A', khelomore: 'Ground 1', hudle: '5-a-side Main', district: 'Football Court 1' },
  'Court 2': { playo: 'Turf B', khelomore: 'Ground 2', hudle: '7s Turf', district: 'Football Court 2' },
  'Court 3': { playo: 'Pickle 1 + 2', khelomore: 'Pickleball', district: 'Pickleball Court' },
};

// Tonight, as drawn in the prototype. `sync` is how many of the target
// platforms have a verified block receipt.
const TONIGHT = [
  { court: 'Court 1', platform: 'playo',     start: '16:00', end: '17:00', name: 'Rohit Menon',     phone: '9912345651', gross: 110000, ref: 'PLY-4471902', sync: 'all' },
  { court: 'Court 1', platform: 'direct',    start: '17:00', end: '18:30', name: 'Kiran Shah',      phone: '9412345077', gross: 165000, pay: 'cash', staff: 'Ramesh', sync: 'all' },
  { court: 'Court 1', platform: 'hudle',     start: '18:30', end: '19:30', name: 'Aakash Pillai',   phone: '9812345144', gross: 140000, ref: 'HDL-220914', sync: 'all' },
  { court: 'Court 1', platform: 'khelomore', start: '19:30', end: '20:30', name: 'Sana Qureshi',    phone: '9812345420', gross: 150000, ref: 'KM-8841207', sync: 'partial' },
  { court: 'Court 1', platform: 'district',  start: '22:00', end: '23:30', name: 'Yusuf Ansari',    phone: '9012345806', gross: 210000, ref: 'DST-77120934', sync: 'all', channel: 'email' },
  { court: 'Court 1', platform: 'playo',     start: '23:30', end: '01:00', name: 'Nikhil Bose',     phone: '9712345512', gross: 240000, ref: 'PLY-4472880', sync: 'all' },

  { court: 'Court 2', platform: 'district',  start: '16:30', end: '17:30', name: 'Tanvi Deshmukh',  phone: '7612345330', gross: 120000, ref: 'DST-77120611', sync: 'all' },
  { court: 'Court 2', platform: 'playo',     start: '18:00', end: '19:00', name: 'Harpreet Gill',   phone: '9812345289', gross: 130000, ref: 'PLY-4471455', sync: 'all' },
  { court: 'Court 2', platform: 'khelomore', start: '19:00', end: '20:00', name: 'Imran Shaikh',    phone: '9912345734', gross: 145000, ref: 'KM-8840912', sync: 'all' },
  { court: 'Court 2', platform: 'hudle',     start: '20:00', end: '21:30', name: 'Ritu Varma',      phone: '8812345019', gross: 200000, ref: 'HDL-221007', sync: 'all' },
  { court: 'Court 2', platform: 'direct',    start: '21:30', end: '22:30', name: 'Sameer Joshi',    phone: '9312345455', gross: 150000, pay: 'whatsapp', staff: 'Priya', sync: 'all' },
  { court: 'Court 2', platform: 'khelomore', start: '23:00', end: '00:30', name: 'Alok Nanda',      phone: '7012345168', gross: 220000, ref: 'KM-8841390', sync: 'all' },

  { court: 'Court 3', platform: 'playo',     start: '17:00', end: '18:00', name: 'Divya Rathi',     phone: '9612345802', gross: 70000,  ref: 'PLY-4471033', sync: 'all' },
  { court: 'Court 3', platform: 'hudle',     start: '18:00', end: '19:00', name: 'Faraz Khan',      phone: '8212345573', gross: 80000,  ref: 'HDL-220841', sync: 'all' },
  { court: 'Court 3', platform: 'playo',     start: '19:00', end: '20:00', name: 'Anjali Prabhu',   phone: '7812345940', gross: 80000,  ref: 'PLY-4472104', sync: 'all' },
  { court: 'Court 3', platform: 'district',  start: '20:30', end: '21:30', name: 'Vikram Sethi',    phone: '9512345226', gross: 90000,  ref: 'DST-77121188', sync: 'all' },
  { court: 'Court 3', platform: 'direct',    start: '22:00', end: '23:00', name: 'Neha Bhatt',      phone: '9912345381', gross: 80000,  pay: 'cash', staff: 'Priya', sync: 'all' },
];

// The open conflict: Playo sold Court 1 at 21:00 at 18:41, District sold the
// same slot at 19:52, eight seconds after our block job was queued.
const CONFLICT = {
  court: 'Court 1', start: '21:00', end: '22:00',
  first:  { platform: 'playo',    name: 'Devendra Rao', phone: '9812345318', gross: 160000, ref: 'PLY-4472551', bookedAtHour: 18.68, blocked: 3 },
  second: { platform: 'district', name: 'Meera Nair',   phone: '9112345207', gross: 175000, ref: 'DST-77121402', bookedAtHour: 19.87, blocked: 0 },
};

const PARTNERS = [
  { name: 'Jignesh Patel', role: 'managing partner', share: 40 },
  { name: 'Ruchi Mehta', role: null, share: 35 },
  { name: 'Sameer Vora', role: null, share: 25 },
];

// Deterministic PRNG so a reseed produces the same month every time.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function seed() {
  const rollover = 6;
  const today = businessDateOf(Date.now(), rollover);

  // Accounts are not referenced BY venues, so truncating venues alone leaves
  // them behind and the second seed collides on the email unique index.
  await pool.query('truncate venues, accounts cascade');

  const inboundSecret = randomBytes(24).toString('base64url');
  const venue = await one(
    `insert into venues (name, locality, city, plan, inbound_secret)
     values ($1,$2,$3,$4,$5) returning *`,
    [VENUE.name, VENUE.locality, VENUE.city, VENUE.plan, inboundSecret],
  );

  for (const login of LOGINS) {
    const account = await one(
      `insert into accounts (email, password_hash, name, phone) values ($1,$2,$3,$4) returning *`,
      [login.email, hashPassword(login.password), login.name, login.phone ?? null],
    );
    await pool.query(
      `insert into account_venues (account_id, venue_id, role) values ($1,$2,$3)`,
      [account.id, venue.id, login.role],
    );
    login.accountId = account.id;
  }

  // One paired counter tablet, so the simulator and the Android spike have a
  // token to present.
  const deviceToken = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into device_tokens (venue_id, label, token_hash, paired_at)
     values ($1,'Counter tablet',$2, now())`,
    [venue.id, createHash('sha256').update(deviceToken).digest('hex')],
  );

  const courts = {};
  for (const c of COURTS) {
    courts[c.name] = await one(
      `insert into courts (venue_id, name, sport, position) values ($1,$2,$3,$4) returning *`,
      [venue.id, c.name, c.sport, c.position],
    );
  }

  const bps = {};
  for (const a of ACCOUNTS) {
    bps[a.platform] = a.bps;
    await pool.query(
      `insert into platform_accounts (venue_id, platform, commission_bps, payout_cycle, last_event_at, session_expires_at)
       values ($1,$2,$3,$4, now() - make_interval(mins => $5), $6)`,
      [
        venue.id, a.platform, a.bps, a.cycle,
        { playo: 2, khelomore: 0, hudle: 6, district: 18, direct: 40 }[a.platform] ?? 10,
        a.expiresInDays ? new Date(Date.now() + a.expiresInDays * 86400000) : null,
      ],
    );
  }

  for (const [courtName, byPlatform] of Object.entries(MAPPINGS)) {
    for (const [platform, label] of Object.entries(byPlatform)) {
      await pool.query(
        `insert into court_mappings (court_id, platform, external_label, external_court_id, verified_at)
         values ($1,$2,$3,$3,$4)`,
        [
          courts[courtName].id, platform, label,
          // Court 3's mappings are not yet proven by a test block.
          courtName === 'Court 3' ? null : new Date(Date.now() - 5 * 86400000),
        ],
      );
    }
  }

  // ---- tonight -----------------------------------------------------------
  let created = 0;
  let minutesAgo = 380; // spread the evening's messages back across the day
  for (const b of TONIGHT) {
    minutesAgo -= 18;
    const court = courts[b.court];
    const { startMs, endMs } = slotFromCalendarDate(today, b.start, b.end);
    const commission = commissionPaise(b.gross, bps[b.platform]);
    const channel = b.channel ?? (b.platform === 'direct' ? 'manual' : 'notification');

    const booking = await one(
      `insert into bookings (
          venue_id, court_id, platform, external_booking_id, slot, business_date, status,
          gross_paise, commission_paise, net_paise, customer_name, customer_phone,
          payment_mode, staff_name, source_channel, dedupe_key)
       values ($1,$2,$3,$4,$5::tstzrange,$6,'confirmed',$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning *`,
      [
        venue.id, court.id, b.platform, b.ref ?? null, toRange(startMs, endMs), today,
        b.gross, commission, b.gross - commission, b.name, normalizePhone(b.phone),
        b.pay ?? 'online', b.staff ?? null, channel,
        dedupeKey({
          externalBookingId: b.ref, platform: b.platform, externalCourtId: b.court,
          businessDate: today, startIso: new Date(startMs).toISOString(),
        }),
      ],
    );
    created += 1;

    // Messages arrive in the past, relative to whenever the seed is run — a
    // notification timestamped in the future reads as "-14051s ago" on Setup.
    await pool.query(
      `insert into notification_logs
         (venue_id, platform, source_channel, raw_text, parse_status, template_version, booking_id,
          received_at, latency_ms)
       values ($1,$2,$3,$4,'template',$5,$6, now() - make_interval(mins => $7), $8)`,
      [
        venue.id, b.platform, channel,
        `[seeded] ${b.platform} ${b.ref ?? 'counter entry'} ${b.start}-${b.end} ${b.name}`,
        `${b.platform}/2026-09-01`, booking.id, minutesAgo,
        800 + Math.round(Math.random() * 900),
      ],
    );

    // The confirmation email that follows every marketplace booking. Both
    // channels are mandatory in Phase 1, so both belong in the seed — and the
    // Setup tab's match rate is meaningless without them.
    if (b.platform !== 'direct') {
      await pool.query(
        `insert into notification_logs
           (venue_id, platform, source_channel, raw_text, parse_status, template_version, booking_id,
            received_at, latency_ms)
         values ($1,$2,'email',$3,'template',$4,$5, now() - make_interval(mins => $6), $7)`,
        [
          venue.id, b.platform,
          `[seeded] ${b.platform} confirmation email ${b.ref} amount ${b.gross / 100}`,
          `${b.platform}/2026-09-01`, booking.id, Math.max(1, minutesAgo - 2),
          1400 + Math.round(Math.random() * 2000),
        ],
      );
    }

    await seedBlockJobs(venue.id, court.id, booking.id, b.platform, b.sync);
  }

  // ---- the open conflict --------------------------------------------------
  const cc = courts[CONFLICT.court];
  const { startMs, endMs } = slotFromCalendarDate(today, CONFLICT.start, CONFLICT.end);
  const ids = [];

  for (const [which, side] of [['first', CONFLICT.first], ['second', CONFLICT.second]]) {
    const commission = commissionPaise(side.gross, bps[side.platform]);
    // Relative to now, not to a fixed clock hour: the conflict must always read
    // as having been detected in the past, whenever the seed happens to run.
    const bookedAt = new Date(Date.now() - (which === 'first' ? 71 : 8) * 60_000);
    const row = await one(
      `insert into bookings (
          venue_id, court_id, platform, external_booking_id, slot, business_date, status,
          gross_paise, commission_paise, net_paise, customer_name, customer_phone,
          payment_mode, source_channel, dedupe_key, created_at)
       values ($1,$2,$3,$4,$5::tstzrange,$6,$7,$8,$9,$10,$11,$12,'online','notification',$13,$14)
       returning *`,
      [
        venue.id, cc.id, side.platform, side.ref, toRange(startMs, endMs), today,
        // Only the first booking is confirmed; the second is 'conflicted', which
        // sits outside the partial exclusion index — exactly the path the ingest
        // pipeline takes when the constraint fires.
        which === 'first' ? 'confirmed' : 'conflicted',
        side.gross, commission, side.gross - commission, side.name, normalizePhone(side.phone),
        dedupeKey({
          externalBookingId: side.ref, platform: side.platform, externalCourtId: CONFLICT.court,
          businessDate: today, startIso: new Date(startMs).toISOString(),
        }),
        bookedAt,
      ],
    );
    ids.push(row.id);
    if (side.blocked) await seedBlockJobs(venue.id, cc.id, row.id, side.platform, 'all');
    created += 1;
  }

  await pool.query(
    `insert into conflicts (venue_id, court_id, slot, business_date, booking_ids, detected_at, cause)
     values ($1,$2,$3::tstzrange,$4,$5,$6,$7)`,
    [
      venue.id, cc.id, toRange(startMs, endMs), today, ids,
      new Date(Date.now() - 8 * 60_000),
      'The District booking landed 8 seconds after our block job was queued. Playo, KheloMore and Hudle verified as blocked; the District block was still in flight when their customer paid.',
    ],
  );

  // ---- maintenance --------------------------------------------------------
  const maint = slotFromCalendarDate(today, '16:00', '17:00');
  await pool.query(
    `insert into court_blocks (venue_id, court_id, slot, business_date, reason)
     values ($1,$2,$3::tstzrange,$4,$5)`,
    [venue.id, courts['Court 3'].id, toRange(maint.startMs, maint.endMs), today, 'Net replacement · blocked everywhere'],
  );

  // ---- two conflicts already resolved this week ---------------------------
  for (const r of [
    { daysAgo: 2, court: 'Court 2', start: '20:00', cause: 'Hudle session expired — block never sent', resolution: 'Moved to Court 3, customer accepted', cost: 0 },
    { daysAgo: 4, court: 'Court 1', start: '19:00', cause: 'Staff booked a walk-in without checking the board', resolution: 'Refunded the walk-in in cash', cost: 140000 },
  ]) {
    const d = addDays(today, -r.daysAgo);
    const s = slotFromCalendarDate(d, r.start, '21:00');
    await pool.query(
      `insert into conflicts (venue_id, court_id, slot, business_date, booking_ids, detected_at, resolved_at, resolution, cost_paise, cause)
       values ($1,$2,$3::tstzrange,$4,'{}',now() - make_interval(days => $5), now() - make_interval(days => $5), $6,$7,$8)`,
      [venue.id, courts[r.court].id, toRange(s.startMs, s.endMs), d, r.daysAgo, r.resolution, r.cost, r.cause],
    );
  }

  // ---- device heartbeat ---------------------------------------------------
  await pool.query(
    `insert into device_heartbeats (venue_id, device_label, battery_pct, notification_access, queued_offline, app_last_seen, received_at)
     values ($1,'Counter tablet',64,true,0,$2, now() - interval '40 seconds')`,
    [
      venue.id,
      {
        playo: new Date(Date.now() - 120_000).toISOString(),
        khelomore: new Date(Date.now() - 5_000).toISOString(),
        hudle: new Date(Date.now() - 360_000).toISOString(),
        district: new Date(Date.now() - 1_080_000).toISOString(),
      },
    ],
  );

  for (const p of PARTNERS) {
    const login = LOGINS.find((l) => l.name === p.name);
    await pool.query(
      `insert into partners (venue_id, name, role, share_type, share_value, account_id)
       values ($1,$2,$3,'percentage',$4,$5)`,
      [venue.id, p.name, p.role, p.share, login?.accountId ?? null],
    );
  }

  const history = await seedHistory(venue.id, courts, bps, today);

  console.log(`seeded ${VENUE.name}`);
  console.log(`  tonight (${today}): ${created} bookings, 1 open conflict, 1 maintenance block`);
  console.log(`  history: ${history.count} bookings across ${history.month}`);
  console.log('');
  console.log('  sign in at http://localhost:3000');
  for (const l of LOGINS) {
    console.log(`    ${l.role.padEnd(8)} ${l.email.padEnd(26)} ${l.password}`);
  }
  console.log('');
  console.log(`  device token   ${deviceToken}`);
  console.log(`  inbound secret ${inboundSecret}`);
  console.log('  (export DEVICE_TOKEN=<device token> for tools/simulate.js)');
}

/**
 * Block jobs and receipts for a booking. Phase 1's pipeline writes none of
 * these — a read-only venue produces no block jobs by construction — so these
 * exist to render a venue that has completed the Phase 3 rollout.
 */
async function seedBlockJobs(venueId, courtId, bookingId, sourcePlatform, mode) {
  if (!mode) return;
  const { rows: targets } = await pool.query(
    `select platform from court_mappings where court_id = $1 and platform <> $2 and platform <> 'direct'`,
    [courtId, sourcePlatform],
  );

  let latency = 4200;
  for (const [i, t] of targets.entries()) {
    // 'partial' leaves the last target still in flight — the board's syncing state.
    const pending = mode === 'partial' && i === targets.length - 1;
    const job = await one(
      `insert into block_jobs (booking_id, target_platform, state, attempts, completed_at)
       values ($1,$2,$3,$4,$5) returning *`,
      [bookingId, t.platform, pending ? 'retrying' : 'verified', pending ? 2 : 1, pending ? null : new Date()],
    );
    if (!pending) {
      await pool.query(
        `insert into block_receipts (block_job_id, latency_ms, verification_method, raw_response)
         values ($1,$2,'refetch',$3)`,
        [job.id, latency, { ok: true, slot: 'blocked' }],
      );
    }
    latency += 3400 + Math.round(Math.random() * 2600);
  }
}

/**
 * A month of completed business, so the money view aggregates real rows.
 * Volumes follow the product doc's mid-size venue: ~750 bookings a month.
 */
async function seedHistory(venueId, courts, bps, today) {
  // The previous whole calendar month — the one an owner reconciles against a
  // bank statement. Counting back a fixed number of days lands in the wrong
  // month whenever today is early in this one.
  const [ty, tm] = today.split('-').map(Number);
  const month = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const mix = [
    ['playo', 248], ['khelomore', 171], ['hudle', 129], ['district', 112], ['direct', 82],
  ];
  const pool_ = [];
  for (const [platform, n] of mix) for (let i = 0; i < n; i += 1) pool_.push(platform);

  const rand = rng(20260902);
  // Fisher-Yates with the seeded PRNG, so the month is stable across reseeds.
  for (let i = pool_.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [pool_[i], pool_[j]] = [pool_[j], pool_[i]];
  }

  const courtList = Object.values(courts);
  const starts = ['16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00'];
  // Peak hours fill first — 20:00 and 21:00 are effectively always sold.
  const weights = [0.34, 0.52, 0.71, 0.88, 0.96, 0.94, 0.81, 0.58];

  const values = [];
  let idx = 0;
  for (let d = 1; d <= daysInMonth && idx < pool_.length; d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    for (const court of courtList) {
      for (const [h, start] of starts.entries()) {
        if (idx >= pool_.length) break;
        if (rand() > weights[h]) continue;

        const platform = pool_[idx++];
        const endHour = Number(start.slice(0, 2)) + 1;
        const end = `${String(endHour % 24).padStart(2, '0')}:00`;
        const { startMs, endMs } = slotFromCalendarDate(date, start, end);

        // Peak slots price higher; pickleball prices lower than turf.
        const base = court.name === 'Court 3' ? 800 : 1300;
        const peak = weights[h] > 0.85 ? 1.35 : weights[h] > 0.65 ? 1.1 : 0.85;
        const gross = Math.round((base * peak) / 50) * 50 * 100;
        const commission = commissionPaise(gross, bps[platform]);

        values.push([
          venueId, court.id, platform, toRange(startMs, endMs), date,
          gross, commission, gross - commission,
          platform === 'direct' ? 'cash' : 'online',
          platform === 'direct' ? 'manual' : 'notification',
          `hist:${date}:${court.id}:${start}`,
        ]);
      }
    }
  }

  // One multi-row insert; 700-odd round trips would make `npm run seed` a chore.
  const chunks = [];
  const params = [];
  values.forEach((v, i) => {
    const b = i * 11;
    chunks.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4}::tstzrange,$${b + 5},'confirmed',$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`);
    params.push(...v);
  });

  if (chunks.length) {
    await pool.query(
      `insert into bookings (venue_id, court_id, platform, slot, business_date, status,
         gross_paise, commission_paise, net_paise, payment_mode, source_channel, dedupe_key)
       values ${chunks.join(',')}
       on conflict do nothing`,
      params,
    );
  }

  // Settlements: three cycles closed and paid, Hudle still owed, District short.
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const { rows: nets } = await pool.query(
    `select platform, coalesce(sum(net_paise),0) as net from bookings
      where venue_id = $1 and business_date >= $2 and business_date <= $3 and platform <> 'direct'
      group by platform`,
    [venueId, `${month}-01`, monthEnd],
  );

  for (const n of nets) {
    const received =
      n.platform === 'hudle' ? null
      : n.platform === 'district' ? n.net - 134000
      : n.net;
    await pool.query(
      `insert into settlements (venue_id, platform, period_start, period_end, expected_paise, received_paise, received_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        venueId, n.platform, `${month}-01`, monthEnd, n.net, received,
        received == null ? null : new Date(Date.now() - 3 * 86400000),
      ],
    );
  }

  return { count: values.length, month };
}

async function one(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

seed()
  .then(close)
  .catch(async (error) => {
    console.error(error);
    await close();
    process.exit(1);
  });
