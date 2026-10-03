import { parse, ParseFailure } from '@turfsync/parsers';
import { tx, trySavepoint, SQLSTATE } from '@turfsync/db';
import {
  slotFromCalendarDate,
  businessDateOf,
  toRange,
  localHhmm,
  dedupeKey,
  commissionPaise as computeCommission,
  normalizePhone,
  formatINR,
  PLATFORM_LABELS,
} from '@turfsync/core';
import { claimEcho } from './echo.js';
import { emitBoardChange } from '../bus.js';
import { notifyOwner } from '../ownerPhone.js';
import { enqueueBlock, enqueueUnblock } from '../blocking/queue.js';

/**
 * A WhatsApp provider being slow, misconfigured or down must never be the
 * reason a real booking fails to save — this call sits inside the same
 * transaction as the insert, and an uncaught throw here rolls that back too.
 * Logged and swallowed: the booking is the thing that matters; the alert is
 * best-effort.
 */
async function safeNotify(client, venueId, template, vars) {
  try {
    await notifyOwner(client, venueId, template, vars);
  } catch (error) {
    console.error(`notifyOwner(${template}) failed — booking proceeds regardless:`, error.message);
  }
}

const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * See the comment at this function's call site for why a timeout is needed at
 * all. Only a failed *block* enqueue is recovered automatically — its row is
 * still 'queued' in Postgres for worker-entry.js's sweep to pick up. A failed
 * *unblock* enqueue has no equivalent sweep (it is re-notifying Redis about a
 * job already past 'queued'), so it is logged loudly rather than claimed to
 * self-heal.
 */
async function safeEnqueue(fn, kind) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ENQUEUE_TIMEOUT_MS)),
    ]);
  } catch (error) {
    const recovery = kind === 'block' ? "the job stays 'queued' for the worker's own sweep to pick up" : 'this unblock was NOT retried automatically — it needs a manual check';
    console.error(`enqueue${kind === 'block' ? 'Block' : 'Unblock'}() failed — ${recovery}:`, error.message);
  }
}

/**
 * ingest → echo check → parse → map → persist → conflict check → enqueue
 * blocks → notify
 *
 * Step 7 (enqueue blocks) only produces work when the venue has
 * `auto_block_enabled` — false by default, and not flippable except by
 * someone deliberately turning it on after the venue's read-only period. A
 * venue that hasn't earned write-back still produces zero block jobs, exactly
 * as before.
 *
 * The Redis enqueue itself happens strictly AFTER the Postgres transaction
 * commits (see the bottom of this function) — never inside it. Telling a
 * worker to act on a booking that a rolled-back transaction later undoes
 * would be a wrong block on a booking that never really happened.
 */
export async function ingestPayload({
  venueId,
  rawText,
  channel = 'notification',
  platformHint = null,
  receivedAt = Date.now(),
}) {
  const started = Date.now();
  // Populated inside the transaction below, drained only after it commits.
  const pendingBlockJobs = [];
  const pendingUnblockJobs = [];

  const result = await tx(async (client) => {
    // ---- 1. raw first, always -------------------------------------------
    // Persisted before anything can throw. A payload we failed to parse is
    // worth more than one we never recorded: it is tomorrow's fixture.
    const logId = await insertLog(client, {
      venueId,
      platform: platformHint,
      channel,
      rawText,
      parseStatus: 'failed',
      parseError: 'pipeline did not complete',
    });

    // ---- 3. parse (echo check needs a slot, so parse precedes it) -------
    let parsed, parseStatus, templateVersion;
    try {
      ({ parsed, parseStatus, templateVersion } = await parse(rawText, {
        channel,
        platformHint,
        now: receivedAt,
      }));
    } catch (error) {
      const message = error instanceof ParseFailure ? error.message : `unexpected: ${error.message}`;
      await client.query(
        `update notification_logs set parse_status = 'failed', parse_error = $2, latency_ms = $3 where id = $1`,
        [logId, message, Date.now() - started],
      );
      // Not an API error: the companion app must not retry a payload we simply
      // cannot read. It is logged, alerted on, and turned into a template.
      return { outcome: 'parse_failed', logId, error: message };
    }

    const venue = await getVenue(client, venueId);
    const { startMs, endMs } = slotFromCalendarDate(parsed.date, parsed.startHhmm, parsed.endHhmm);
    const businessDate = businessDateOf(startMs, venue.day_rollover_hour);

    // ---- 2. echo check ---------------------------------------------------
    const echo = await claimEcho(client, {
      venueId,
      platform: parsed.platform,
      externalCourtId: parsed.courtLabel,
      startMs,
      endMs,
    });
    if (echo) {
      await client.query(
        `update notification_logs
            set parse_status = 'echo_suppressed', parse_error = null, parsed_json = $2, latency_ms = $3
          where id = $1`,
        [logId, parsed, Date.now() - started],
      );
      return { outcome: 'echo_suppressed', logId };
    }

    // ---- 4. map the platform's court label to a physical pitch ----------
    const court = await mapCourt(client, venueId, parsed.platform, parsed.courtLabel);
    if (!court) {
      const message = `no court mapping for ${parsed.platform} "${parsed.courtLabel}"`;
      await client.query(
        `update notification_logs set parse_status = 'failed', parse_error = $2, parsed_json = $3, latency_ms = $4 where id = $1`,
        [logId, message, parsed, Date.now() - started],
      );
      return { outcome: 'unmapped_court', logId, error: message };
    }

    // Cancellations take the reverse path: mark the row dead so the slot is
    // resellable, and stand down or reverse whatever blocking was in flight.
    if (parsed.cancelled) {
      return finishCancellation(client, {
        venueId, parsed, court, businessDate, startMs, endMs, logId, started, venue,
        pendingUnblockJobs,
      });
    }

    // ---- 5. money --------------------------------------------------------
    const account = await getAccount(client, venueId, parsed.platform);
    const grossPaise = parsed.grossPaise ?? null;
    // A commission stated in the confirmation email is authoritative; the rate
    // card is only a fallback, because negotiated rates drift from list rates.
    const commission =
      parsed.commissionPaise ?? (grossPaise != null ? computeCommission(grossPaise, account?.commission_bps ?? 0) : null);
    const netPaise = grossPaise != null && commission != null ? grossPaise - commission : null;

    // ---- dedupe key (finding 2) -----------------------------------------
    const rebookSeq = parsed.externalBookingId
      ? 0
      : await nextRebookSeq(client, court.id, startMs, endMs);

    const key = dedupeKey({
      externalBookingId: parsed.externalBookingId,
      platform: parsed.platform,
      externalCourtId: parsed.courtLabel,
      businessDate,
      startIso: new Date(startMs).toISOString(),
      rebookSeq,
    });

    const row = {
      venueId,
      courtId: court.id,
      platform: parsed.platform,
      externalBookingId: parsed.externalBookingId,
      range: toRange(startMs, endMs),
      businessDate,
      grossPaise,
      commission,
      netPaise,
      customerName: parsed.customerName,
      customerPhone: normalizePhone(parsed.customerPhone),
      paymentMode: parsed.paymentMode ?? (parsed.platform === 'direct' ? null : 'online'),
      staffName: parsed.staffName ?? null,
      channel,
      key,
      rebookSeq,
    };

    // ---- 6. persist, and treat 23P01 as a conflict (finding 3) ----------
    const result = await trySavepoint(
      client,
      'ins_booking',
      () => upsertBooking(client, row),
      SQLSTATE.EXCLUSION_VIOLATION,
      () => recordConflict(client, row, parsed),
    );

    await client.query(
      `update notification_logs
          set parse_status = $2, parse_error = null, parsed_json = $3, template_version = $4,
              booking_id = $5, platform = $6, latency_ms = $7
        where id = $1`,
      [logId, parseStatus, parsed, templateVersion, result.booking.id, parsed.platform, Date.now() - started],
    );

    await client.query(
      `update platform_accounts set last_event_at = now() where venue_id = $1 and platform = $2`,
      [venueId, parsed.platform],
    );

    // ---- 9. notify -------------------------------------------------------
    const slotLabel = `${localHhmm(startMs)}–${localHhmm(endMs)}`;

    if (result.outcome === 'conflict') {
      emitBoardChange(venueId, { type: 'conflict', businessDate, conflictId: result.conflictId });
      await safeNotify(client, venueId, 'conflict_alert', {
        court: court.name,
        slot: slotLabel,
        platforms: result.platforms.map((p) => PLATFORM_LABELS[p]),
      });
    } else if (result.outcome === 'created') {
      emitBoardChange(venueId, { type: 'booking', businessDate, bookingId: result.booking.id });
      await safeNotify(client, venueId, 'booking_alert', {
        platform: PLATFORM_LABELS[parsed.platform],
        customer: parsed.customerName,
        court: court.name,
        slot: slotLabel,
        amount: grossPaise != null ? formatINR(grossPaise) : null,
      });

      // ---- 7. enqueue blocks — inert unless this venue has earned write-back
      if (venue.auto_block_enabled) {
        const targets = await otherMappedPlatforms(client, court.id, parsed.platform);
        for (const targetPlatform of targets) {
          await client.query(
            `insert into block_jobs (booking_id, target_platform, state, priority)
             values ($1, $2, 'queued', $3)
             on conflict (booking_id, target_platform) do nothing`,
            [result.booking.id, targetPlatform, Math.max(0, Math.round((startMs - Date.now()) / 60_000))],
          );
          pendingBlockJobs.push({ bookingId: result.booking.id, targetPlatform, startMs });
        }
      }
    } else {
      // An enrichment — the email arriving after the notification. The board
      // updates; the owner does not get a second buzz for the same booking.
      emitBoardChange(venueId, { type: 'booking', businessDate, bookingId: result.booking.id });
    }

    return {
      outcome: result.outcome,
      bookingId: result.booking.id,
      conflictId: result.conflictId ?? null,
      businessDate,
      latencyMs: Date.now() - started,
      parseStatus,
    };
  });

  // Only now — the transaction is durably committed — do we tell Redis about
  // any of it. A process crash (or, as below, a Redis that is unreachable)
  // between these two lines leaves `queued` rows in Postgres with no matching
  // Redis job; the worker's startup sweep picks those up (see
  // worker-entry.js), so nothing is silently lost.
  //
  // The BullMQ connection is deliberately configured with
  // maxRetriesPerRequest: null (required for the worker's own connection —
  // see blocking/redis.js), which means a command against an unreachable
  // Redis retries forever rather than rejecting. Without a timeout here, a
  // misconfigured REDIS_URL would hang every booking's ingest request
  // indefinitely instead of just leaving its block job for the sweep to pick
  // up — exactly the kind of "booking is the thing that matters" trade this
  // file already makes for notifyOwner.
  for (const job of pendingBlockJobs) await safeEnqueue(() => enqueueBlock(job), 'block');
  for (const job of pendingUnblockJobs) await safeEnqueue(() => enqueueUnblock(job), 'unblock');

  return result;
}

// ---------------------------------------------------------------- helpers

async function insertLog(client, { venueId, platform, channel, rawText, parseStatus, parseError }) {
  const { rows } = await client.query(
    `insert into notification_logs (venue_id, platform, source_channel, raw_text, parse_status, parse_error)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [venueId, platform, channel, rawText, parseStatus, parseError],
  );
  return rows[0].id;
}

async function getVenue(client, venueId) {
  const { rows } = await client.query(
    `select v.*, coalesce(
        (select p.name from partners p where p.venue_id = v.id order by p.share_value desc limit 1),
        'owner') as owner_name
       from venues v where v.id = $1`,
    [venueId],
  );
  if (!rows[0]) throw Object.assign(new Error('unknown venue'), { statusCode: 404 });
  return rows[0];
}

async function getAccount(client, venueId, platform) {
  const { rows } = await client.query(
    `select * from platform_accounts where venue_id = $1 and platform = $2`,
    [venueId, platform],
  );
  return rows[0] ?? null;
}

/**
 * Court labels differ on every platform — Playo's "Turf A" is KheloMore's
 * "Ground 1". Matching is case- and whitespace-insensitive because the labels
 * are typed by hand during onboarding.
 */
async function mapCourt(client, venueId, platform, label) {
  const { rows } = await client.query(
    `select c.id, c.name, c.sport
       from court_mappings m
       join courts c on c.id = m.court_id
      where c.venue_id = $1
        and m.platform = $2
        and lower(btrim(m.external_label)) = lower(btrim($3))
      limit 1`,
    [venueId, platform, label],
  );
  return rows[0] ?? null;
}

/**
 * Every platform besides the source one that this court is actually mapped
 * to. `direct` is never a block target — it is not a marketplace with a
 * calendar to write to.
 */
async function otherMappedPlatforms(client, courtId, sourcePlatform) {
  const { rows } = await client.query(
    `select platform from court_mappings
      where court_id = $1 and platform <> $2 and platform <> 'direct'
        and external_court_id is not null`,
    [courtId, sourcePlatform],
  );
  return rows.map((r) => r.platform);
}

/**
 * How many bookings have already lived in this exact slot on this court. A
 * cancelled-then-resold slot gets seq 1, so its key cannot collide with the
 * cancelled row's seq 0.
 */
async function nextRebookSeq(client, courtId, startMs, endMs) {
  const { rows } = await client.query(
    `select count(*)::int as n
       from bookings
      where court_id = $1
        and slot = tstzrange($2::timestamptz, $3::timestamptz)`,
    [courtId, new Date(startMs), new Date(endMs)],
  );
  return rows[0].n;
}

async function upsertBooking(client, r) {
  const { rows } = await client.query(
    `insert into bookings (
        venue_id, court_id, platform, external_booking_id, slot, business_date,
        status, gross_paise, commission_paise, net_paise, customer_name,
        customer_phone, payment_mode, staff_name, source_channel, dedupe_key, rebook_seq)
     values ($1,$2,$3,$4,$5::tstzrange,$6,'confirmed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (venue_id, platform, dedupe_key) do update set
        -- The email carries money the notification lacked: fill gaps, never
        -- overwrite a value we already trust with a null.
        gross_paise      = coalesce(excluded.gross_paise, bookings.gross_paise),
        commission_paise = coalesce(excluded.commission_paise, bookings.commission_paise),
        net_paise        = coalesce(excluded.net_paise, bookings.net_paise),
        customer_name    = coalesce(bookings.customer_name, excluded.customer_name),
        customer_phone   = coalesce(bookings.customer_phone, excluded.customer_phone),
        external_booking_id = coalesce(bookings.external_booking_id, excluded.external_booking_id),
        payment_mode     = coalesce(excluded.payment_mode, bookings.payment_mode),
        updated_at       = now()
     returning *, (xmax = 0) as inserted`,
    [
      r.venueId, r.courtId, r.platform, r.externalBookingId, r.range, r.businessDate,
      r.grossPaise, r.commission, r.netPaise, r.customerName, r.customerPhone,
      r.paymentMode, r.staffName, r.channel, r.key, r.rebookSeq,
    ],
  );
  const booking = rows[0];
  return { outcome: booking.inserted ? 'created' : 'enriched', booking };
}

/**
 * The exclusion constraint fired: this slot is already sold on this court by
 * someone else. Record the booking outside the partial index so it is visible
 * on the board, and open a conflict holding both sides.
 */
async function recordConflict(client, r, parsed) {
  const { rows: existing } = await client.query(
    `select id, platform, customer_name, gross_paise, created_at
       from bookings
      where court_id = $1
        and status = 'confirmed'
        and slot && $2::tstzrange
      order by created_at`,
    [r.courtId, r.range],
  );

  const { rows } = await client.query(
    `insert into bookings (
        venue_id, court_id, platform, external_booking_id, slot, business_date,
        status, gross_paise, commission_paise, net_paise, customer_name,
        customer_phone, payment_mode, source_channel, dedupe_key, rebook_seq)
     values ($1,$2,$3,$4,$5::tstzrange,$6,'conflicted',$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (venue_id, platform, dedupe_key) do update set updated_at = now()
     returning *`,
    [
      r.venueId, r.courtId, r.platform, r.externalBookingId, r.range, r.businessDate,
      r.grossPaise, r.commission, r.netPaise, r.customerName, r.customerPhone,
      r.paymentMode, r.channel, r.key, r.rebookSeq,
    ],
  );
  const booking = rows[0];

  const first = existing[0];
  const cause = first
    ? `${parsed.platform} sold this slot at ${new Date().toISOString().slice(11, 16)} UTC; ` +
      `${first.platform} already held it from ${new Date(first.created_at).toISOString().slice(11, 16)} UTC.`
    : 'overlapping slot detected';

  const { rows: conflictRows } = await client.query(
    `insert into conflicts (venue_id, court_id, slot, business_date, booking_ids, cause)
     values ($1,$2,$3::tstzrange,$4,$5,$6) returning id`,
    [r.venueId, r.courtId, r.range, r.businessDate, [...existing.map((e) => e.id), booking.id], cause],
  );

  return {
    outcome: 'conflict',
    booking,
    conflictId: conflictRows[0].id,
    platforms: [...new Set([...existing.map((e) => e.platform), r.platform])],
  };
}

async function finishCancellation(client, ctx) {
  const { venueId, parsed, court, businessDate, startMs, endMs, logId, started, pendingUnblockJobs } = ctx;

  const { rows } = await client.query(
    `update bookings
        set status = 'cancelled', cancelled_at = now(), updated_at = now()
      where venue_id = $1
        and platform = $2
        and status <> 'cancelled'
        and ($3::text is null or external_booking_id = $3)
        and court_id = $4
        and slot && tstzrange($5::timestamptz, $6::timestamptz)
      returning id`,
    [venueId, parsed.platform, parsed.externalBookingId ?? null, court.id, new Date(startMs), new Date(endMs)],
  );

  const bookingId = rows[0]?.id ?? null;

  // Stand down or reverse whatever blocking was in flight for this booking.
  // A job that never got to run is withdrawn outright ('superseded' here and
  // now — no adapter call needed, since nothing was ever blocked). One that
  // already verified stays 'verified' until an unblock job actually reverses
  // it — only the worker can make that call — enqueued after this transaction
  // commits. Per the plan's own description: "the job is withdrawn rather than
  // completed and immediately undone."
  if (bookingId) {
    await client.query(
      `update block_jobs set state = 'superseded'
        where booking_id = $1 and state in ('queued','leased','retrying')`,
      [bookingId],
    );

    const { rows: verifiedJobs } = await client.query(
      `select target_platform from block_jobs where booking_id = $1 and state = 'verified'`,
      [bookingId],
    );
    for (const job of verifiedJobs) {
      pendingUnblockJobs.push({ bookingId, targetPlatform: job.target_platform });
    }
  }

  await client.query(
    `update notification_logs
        set parse_status = 'template', parse_error = null, parsed_json = $2,
            booking_id = $3, platform = $4, latency_ms = $5
      where id = $1`,
    [logId, parsed, bookingId, parsed.platform, Date.now() - started],
  );

  emitBoardChange(venueId, { type: 'cancellation', businessDate, bookingId });

  return {
    outcome: bookingId ? 'cancelled' : 'cancellation_no_match',
    bookingId,
    businessDate,
    latencyMs: Date.now() - started,
  };
}
