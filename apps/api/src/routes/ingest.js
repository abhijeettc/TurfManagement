import { ingestPayload } from '../ingest/pipeline.js';
import { resolveVenue } from '../venue.js';
import { requireDevice, requireInboundSecret } from '../auth/guard.js';
import { pool, tx } from '@turfsync/db';
import {
  slotFromCalendarDate, businessDateOf, toRange, dedupeKey,
  commissionPaise, normalizePhone, rupeesToPaise,
} from '@turfsync/core';
import { emitBoardChange } from '../bus.js';

export default async function ingestRoutes(app) {
  /**
   * Channel 1 — the Android companion's notification listener.
   *
   * Accepts a batch, because the app queues offline and flushes when the tablet
   * gets its connection back. Every item is processed independently: one
   * unreadable payload must never reject the nineteen good ones beside it.
   */
  app.post('/ingest/notification', async (request, reply) => {
    // The token decides the venue. The client never names it, so a paired
    // tablet cannot post into another venue's board.
    const { venue } = await requireDevice(request);
    const items = Array.isArray(request.body?.items)
      ? request.body.items
      : [{ text: request.body?.text, platform: request.body?.platform, postedAt: request.body?.postedAt }];

    const results = [];
    for (const item of items) {
      if (!item?.text) {
        results.push({ outcome: 'rejected', error: 'missing text' });
        continue;
      }
      try {
        results.push(
          await ingestPayload({
            venueId: venue.id,
            rawText: item.text,
            channel: 'notification',
            platformHint: item.platform ?? null,
            receivedAt: item.postedAt ? Date.parse(item.postedAt) : Date.now(),
          }),
        );
      } catch (error) {
        request.log.error({ err: error }, 'ingest failed');
        results.push({ outcome: 'error', error: error.message });
      }
    }

    // 202: accepted and durably logged. The device deletes its queued copy on
    // this, so it must not be returned before the raw payload is committed.
    return reply.code(202).send({ accepted: results.length, results });
  });

  /**
   * Channel 2 — inbound email (Postmark/Mailgun webhook shape).
   *
   * Not a backup channel. Notifications carry speed; email carries the money,
   * and Phase 2's ±2% reconciliation target depends on it.
   */
  app.post('/ingest/email', async (request, reply) => {
    const body = request.body ?? {};
    const text = body.TextBody || body['body-plain'] || body.text || body.raw;
    if (!text) return reply.code(400).send({ error: 'no message body' });

    // Routed per venue by the address they forward to: venue-{id}@in.turfsync.in
    const to = body.To || body.recipient || body.to || '';
    const match = /venue-([0-9a-f-]{36})@/i.exec(to);
    if (!match) return reply.code(400).send({ error: 'No venue in the recipient address.' });
    // Each venue has its own inbound secret; the address alone is guessable.
    const venue = await requireInboundSecret(request, match[1]);

    const subject = body.Subject || body.subject || '';
    const result = await ingestPayload({
      venueId: venue.id,
      rawText: `${subject}\n${text}`,
      channel: 'email',
      receivedAt: Date.now(),
    });
    return reply.code(202).send(result);
  });

  /**
   * Counter entry — walk-ins and WhatsApp bookings.
   *
   * Bypasses the parser (there is nothing to parse) but takes exactly the same
   * persist path, including the exclusion constraint. Staff double-booking the
   * pitch by hand is a real failure mode and gets caught identically.
   */
  app.post('/ingest/manual', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'booking:create');
    const b = request.body ?? {};

    for (const field of ['courtId', 'date', 'start', 'end']) {
      if (!b[field]) return reply.code(400).send({ error: `${field} is required` });
    }

    const { startMs, endMs } = slotFromCalendarDate(b.date, b.start, b.end);
    const businessDate = businessDateOf(startMs, venue.day_rollover_hour);
    const gross = b.amountRupees != null ? rupeesToPaise(b.amountRupees) : null;

    const result = await tx(async (client) => {
      const seq = await client
        .query(
          `select count(*)::int as n from bookings
            where court_id = $1 and slot = tstzrange($2::timestamptz, $3::timestamptz)`,
          [b.courtId, new Date(startMs), new Date(endMs)],
        )
        .then((r) => r.rows[0].n);

      const key = dedupeKey({
        platform: 'direct',
        courtId: b.courtId,
        businessDate,
        startIso: new Date(startMs).toISOString(),
        rebookSeq: seq,
      });

      const { rows } = await client.query(
        `insert into bookings (
            venue_id, court_id, platform, slot, business_date, status,
            gross_paise, commission_paise, net_paise, customer_name, customer_phone,
            payment_mode, staff_name, source_channel, dedupe_key, rebook_seq)
         values ($1,$2,'direct',$3::tstzrange,$4,'confirmed',$5,0,$5,$6,$7,$8,$9,'manual',$10,$11)
         returning id`,
        [
          venue.id, b.courtId, toRange(startMs, endMs), businessDate, gross,
          b.customerName ?? null, normalizePhone(b.customerPhone), b.paymentMode ?? 'cash',
          b.staffName ?? null, key, seq,
        ],
      );
      return rows[0];
    }).catch((error) => {
      if (error.code === '23P01') {
        const conflict = new Error('That slot is already booked on this court.');
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    });

    emitBoardChange(venue.id, { type: 'booking', businessDate, bookingId: result.id });
    return reply.code(201).send({ id: result.id, businessDate });
  });

  /**
   * Finding 5 — a silent listener looks exactly like a quiet evening.
   * The tablet reports every five minutes whether it is alive, charged, and
   * still holding notification access.
   */
  app.post('/devices/heartbeat', async (request, reply) => {
    const { venue } = await requireDevice(request);
    const b = request.body ?? {};
    await pool.query(
      `insert into device_heartbeats
         (venue_id, device_label, battery_pct, notification_access, queued_offline, app_last_seen)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        venue.id,
        b.label ?? 'Counter tablet',
        b.batteryPct ?? null,
        Boolean(b.notificationAccess),
        b.queuedOffline ?? 0,
        b.appLastSeen ?? {},
      ],
    );
    return reply.code(204).send();
  });
}
