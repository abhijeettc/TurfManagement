import { fromRange, localHhmm, formatINR, PLATFORM_LABELS, PLATFORM_UI_KEY, maskPhone } from '@turfsync/core';
import { pool, tx } from '@turfsync/db';
import { resolveVenue } from '../venue.js';
import { emitBoardChange } from '../bus.js';

const DATE_FMT = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
});

export default async function conflictRoutes(app) {
  app.get('/api/conflicts', async (request) => {
    const { venue } = await resolveVenue(request, 'conflict:read');

    const [open, resolved] = await Promise.all([
      pool.query(
        `select c.*, ct.name as court_name,
                (select json_agg(json_build_object(
                    'id', b.id, 'platform', b.platform, 'name', b.customer_name,
                    'phone', b.customer_phone, 'gross', b.gross_paise,
                    'created', b.created_at, 'status', b.status,
                    'jobs', (select count(*) from block_jobs j
                              join block_receipts r on r.block_job_id = j.id
                             where j.booking_id = b.id))
                    order by b.created_at)
                   from bookings b where b.id = any(c.booking_ids)) as sides
           from conflicts c
           join courts ct on ct.id = c.court_id
          where c.venue_id = $1 and c.resolved_at is null
          order by c.detected_at desc`,
        [venue.id],
      ),
      pool.query(
        `select c.*, ct.name as court_name,
                (select string_agg(initcap(b.platform::text), ' vs ' order by b.created_at)
                   from bookings b where b.id = any(c.booking_ids)) as platforms
           from conflicts c
           join courts ct on ct.id = c.court_id
          where c.venue_id = $1 and c.resolved_at is not null
          order by c.resolved_at desc limit 10`,
        [venue.id],
      ),
    ]);

    return {
      open: await Promise.all(open.rows.map((c) => shapeConflict(c, venue))),
      resolved: resolved.rows.map((c) => {
        const { startMs } = fromRange(c.slot);
        return {
          id: c.id,
          when: DATE_FMT.format(new Date(c.resolved_at)),
          slot: `${c.court_name} · ${localHhmm(startMs)}`,
          platforms: c.platforms,
          cause: c.cause,
          resolution: c.resolution,
          costLabel: formatINR(c.cost_paise ?? 0),
        };
      }),
    };
  });

  /**
   * Resolve a conflict: one booking is kept, the other is offered an
   * alternative slot or refunded.
   *
   * Keeping the audit trail is the point. A conflict that was resolved by
   * refunding ₹1,750 is a number the owner will want back when they are
   * arguing with a platform about who caused it.
   */
  app.post('/api/conflicts/:id/resolve', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'conflict:resolve');
    const { keepBookingId, resolution, refundRupees, offer } = request.body ?? {};
    if (!keepBookingId) return reply.code(400).send({ error: 'keepBookingId is required' });

    const result = await tx(async (client) => {
      const { rows } = await client.query(
        `select * from conflicts where id = $1 and venue_id = $2 and resolved_at is null`,
        [request.params.id, venue.id],
      );
      const conflict = rows[0];
      if (!conflict) return null;

      const losers = conflict.booking_ids.filter((id) => id !== keepBookingId);

      // The kept booking becomes the live one; the constraint now accepts it
      // because every other claimant on the slot has been stood down.
      await client.query(
        `update bookings set status = 'cancelled', cancelled_at = now(), updated_at = now()
          where id = any($1)`,
        [losers],
      );
      await client.query(
        `update bookings set status = 'confirmed', updated_at = now() where id = $1`,
        [keepBookingId],
      );

      const cost = refundRupees ? Math.round(Number(refundRupees) * 100) : 0;
      await client.query(
        `update conflicts set resolved_at = now(), resolution = $2, cost_paise = $3 where id = $1`,
        [conflict.id, resolution ?? 'kept one booking, released the other', cost],
      );

      return { conflict, losers, businessDate: conflict.business_date };
    });

    if (!result) return reply.code(404).send({ error: 'conflict not found or already resolved' });

    emitBoardChange(venue.id, { type: 'conflict_resolved', businessDate: result.businessDate });
    return {
      resolved: true,
      released: result.losers.length,
      offer: offer ?? null,
      note: 'The released slot is back on sale. Phase 3 will unblock it on the other platforms automatically.',
    };
  });
}

async function shapeConflict(c, venue) {
  const { startMs, endMs } = fromRange(c.slot);
  const sides = c.sides ?? [];

  // History with this venue is the single most useful tiebreaker an owner has:
  // a fourteen-time regular and a first-timer are not the same loss.
  const histories = await Promise.all(
    sides.map((s) =>
      s.phone
        ? pool
            .query(
              `select count(*)::int as n from bookings
                where venue_id = $1 and customer_phone = $2 and status <> 'cancelled'`,
              [venue.id, s.phone],
            )
            .then((r) => r.rows[0].n)
        : Promise.resolve(0),
    ),
  );

  const ordered = sides
    .map((s, i) => ({ ...s, history: histories[i] }))
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

  return {
    id: c.id,
    court: c.court_name,
    slotLabel: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
    dateLabel: DATE_FMT.format(new Date(startMs)),
    detectedAt: c.detected_at,
    detectedLabel: localHhmm(Date.parse(c.detected_at)),
    minutesAgo: Math.max(0, Math.round((Date.now() - Date.parse(c.detected_at)) / 60000)),
    cause: c.cause,
    sides: ordered.map((s, i) => ({
      bookingId: s.id,
      platform: s.platform,
      platformLabel: PLATFORM_LABELS[s.platform],
      uiKey: PLATFORM_UI_KEY[s.platform],
      name: s.name,
      phoneMasked: maskPhone(s.phone),
      bookedLabel: `${localHhmm(Date.parse(s.created))}, ${DATE_FMT.format(new Date(s.created))}`,
      paidLabel: s.gross != null ? `${formatINR(s.gross)} online` : '—',
      historyLabel: s.history > 1 ? `${s.history} · regular` : `${s.history} · first time`,
      blockedLabel: s.jobs > 0 ? `${s.jobs} of 3 platforms` : '— slipped through',
      // Booked first wins by default. It is the only rule that is defensible to
      // both customers, and the owner can always override it.
      recommended: i === 0,
    })),
  };
}
