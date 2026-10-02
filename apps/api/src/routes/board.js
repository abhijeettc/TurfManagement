import {
  fromRange, localHhmm, localDateStr, businessDateOf, durationMinutes,
  formatINR, PLATFORM_LABELS, PLATFORM_UI_KEY, PLATFORMS, maskPhone,
} from '@turfsync/core';
import { resolveVenue } from '../venue.js';

// The evening board. Indian turf trades from late afternoon to the small hours,
// so the axis runs 16:00 to 02:00 — ten hours, forty fifteen-minute columns,
// with the day boundary sitting inside the grid rather than at its edge.
const AXIS_START_MIN = 16 * 60;
const AXIS_END_MIN = 26 * 60;
const COL_MIN = 15;
const COLS = (AXIS_END_MIN - AXIS_START_MIN) / COL_MIN;

/** Minutes past the axis start for an instant, given the board's business date. */
function minutesFromAxis(ms, businessDate, rolloverHour) {
  const dayStart = Date.parse(`${businessDate}T00:00:00.000Z`) - 330 * 60_000;
  let mins = Math.round((ms - dayStart) / 60_000);
  // A slot that starts after midnight reads as 25:00, not 01:00.
  if (mins < rolloverHour * 60) mins += 1440;
  return mins - AXIS_START_MIN;
}

function place(startMs, endMs, businessDate, rolloverHour) {
  const from = minutesFromAxis(startMs, businessDate, rolloverHour);
  const span = Math.max(1, Math.round((endMs - startMs) / 60_000 / COL_MIN));
  const col = Math.round(from / COL_MIN) + 1;
  return { col, span, onAxis: col >= 1 && col + span - 1 <= COLS };
}

export default async function boardRoutes(app) {
  app.get('/api/board', async (request) => {
    const { venue, client } = await resolveVenue(request, 'board:read');
    const rollover = venue.day_rollover_hour;
    const businessDate = request.query.date || businessDateOf(Date.now(), rollover);
    // ?platforms=playo,turfpro — show only bookings that came from those apps.
    // Unknown names are dropped rather than trusted; an empty list means "all".
    const wanted = String(request.query.platforms ?? '').split(',').map((s) => s.trim()).filter((p) => PLATFORMS.includes(p));
    const platformFilter = wanted.length ? wanted : null;

    const [courts, bookings, blocks, conflicts, mappings, accounts, heartbeat, avoided] =
      await Promise.all([
        client.query(
          `select id, name, sport, position from courts where venue_id = $1 order by position, name`,
          [venue.id],
        ),
        client.query(
          `select b.*,
                  (select json_agg(json_build_object(
                      'platform', j.target_platform,
                      'state', j.state,
                      'verified', (r.id is not null)))
                     from block_jobs j
                     left join block_receipts r on r.block_job_id = j.id
                    where j.booking_id = b.id) as jobs
             from bookings b
            where b.venue_id = $1 and b.business_date = $2
              and b.status in ('confirmed','conflicted')
              and ($3::text[] is null or b.platform::text = any($3::text[]))
            order by lower(b.slot)`,
          [venue.id, businessDate, platformFilter],
        ),
        client.query(
          `select id, court_id, slot, reason from court_blocks
            where venue_id = $1 and business_date = $2`,
          [venue.id, businessDate],
        ),
        client.query(
          `select c.id, c.court_id, c.slot, c.booking_ids, c.resolved_at,
                  (select json_agg(json_build_object(
                     'platform', b.platform, 'name', b.customer_name,
                     'gross', b.gross_paise) order by b.created_at)
                     from bookings b where b.id = any(c.booking_ids)) as sides
             from conflicts c
            where c.venue_id = $1 and c.business_date = $2 and c.resolved_at is null`,
          [venue.id, businessDate],
        ),
        client.query(
          `select m.platform, m.court_id, m.verified_at
             from court_mappings m join courts c on c.id = m.court_id
            where c.venue_id = $1`,
          [venue.id],
        ),
        client.query(
          `select platform, commission_bps, last_event_at, status, session_expires_at
             from platform_accounts where venue_id = $1 order by platform`,
          [venue.id],
        ),
        client.query(
          `select * from device_heartbeats where venue_id = $1
            order by received_at desc limit 1`,
          [venue.id],
        ),
        // North star: block actions the owner did not have to perform by hand.
        client.query(
          `select count(*)::int as n
             from block_jobs j join bookings b on b.id = j.booking_id
            where b.venue_id = $1 and j.state = 'verified'
              and j.completed_at > now() - interval '7 days'`,
          [venue.id],
        ),
      ]);

    const mappedPlatforms = new Map();
    for (const m of mappings.rows) {
      if (!mappedPlatforms.has(m.court_id)) mappedPlatforms.set(m.court_id, []);
      mappedPlatforms.get(m.court_id).push(m.platform);
    }

    // A slot in dispute is drawn once, as a conflict — not as a normal block
    // with a second one hidden underneath it.
    const inConflict = new Set(conflicts.rows.flatMap((c) => c.booking_ids ?? []));

    const perCourt = new Map(courts.rows.map((c) => [c.id, { slots: 0, minutes: 0 }]));

    const blockList = [];
    let gross = 0, commission = 0, net = 0, count = 0;

    for (const b of bookings.rows) {
      const { startMs, endMs } = fromRange(b.slot);
      if (b.status === 'conflicted' || inConflict.has(b.id)) continue;

      // Count first, draw second. The grid only spans the traded evening, but a
      // booking outside it is still a booking: leaving it out of the day's
      // totals would quietly under-report the takings.
      const stats = perCourt.get(b.court_id);
      if (stats) {
        stats.slots += 1;
        stats.minutes += durationMinutes(startMs, endMs);
      }

      count += 1;
      gross += b.gross_paise ?? 0;
      commission += b.commission_paise ?? 0;
      net += b.net_paise ?? (b.gross_paise ?? 0) - (b.commission_paise ?? 0);

      const pos = place(startMs, endMs, businessDate, rollover);
      if (!pos.onAxis) continue;

      // Targets are every other platform this court is listed on.
      const targets = (mappedPlatforms.get(b.court_id) ?? []).filter((p) => p !== b.platform);
      const jobs = new Map((b.jobs ?? []).map((j) => [j.platform, j]));
      const pips = targets.map((p) => {
        const job = jobs.get(p);
        if (!job) return { platform: p, uiKey: PLATFORM_UI_KEY[p], state: 'pending' };
        if (job.verified) return { platform: p, uiKey: PLATFORM_UI_KEY[p], state: 'verified' };
        if (job.state === 'failed') return { platform: p, uiKey: PLATFORM_UI_KEY[p], state: 'fail' };
        return { platform: p, uiKey: PLATFORM_UI_KEY[p], state: 'pending' };
      });

      const verified = pips.filter((p) => p.state === 'verified').length;
      const crossesMidnight = localDateStr(endMs) !== localDateStr(startMs);

      blockList.push({
        id: b.id,
        courtId: b.court_id,
        platform: b.platform,
        platformLabel: b.platform === 'direct'
          ? `Direct · ${b.payment_mode === 'cash' ? 'cash' : b.payment_mode === 'whatsapp' ? 'WhatsApp' : 'counter'}`
          : PLATFORM_LABELS[b.platform],
        uiKey: PLATFORM_UI_KEY[b.platform],
        customer: b.customer_name,
        col: pos.col,
        span: pos.span,
        startLabel: localHhmm(startMs),
        endLabel: localHhmm(endMs),
        crossesMidnight,
        amountLabel: b.gross_paise != null ? formatINR(b.gross_paise) : null,
        pips,
        verified,
        targetCount: pips.length,
        // The UI's existing "syncing" state. In Phase 1 nothing writes back, so
        // a freshly ingested booking honestly shows as not-yet-blocked.
        syncing: pips.length > 0 && verified < pips.length,
      });
    }

    const conflictList = conflicts.rows
      .map((c) => {
        const { startMs, endMs } = fromRange(c.slot);
        const pos = place(startMs, endMs, businessDate, rollover);
        return pos.onAxis
          ? {
              id: c.id,
              courtId: c.court_id,
              col: pos.col,
              span: pos.span,
              startLabel: localHhmm(startMs),
              endLabel: localHhmm(endMs),
              sides: (c.sides ?? []).map((s) => ({
                platform: s.platform,
                uiKey: PLATFORM_UI_KEY[s.platform],
                name: s.name,
              })),
            }
          : null;
      })
      .filter(Boolean);

    const maintenanceList = blocks.rows
      .map((m) => {
        const { startMs, endMs } = fromRange(m.slot);
        const pos = place(startMs, endMs, businessDate, rollover);
        return pos.onAxis ? { id: m.id, courtId: m.court_id, col: pos.col, span: pos.span, reason: m.reason } : null;
      })
      .filter(Boolean);

    // Occupancy across the traded window, all courts.
    const axisMinutes = AXIS_END_MIN - AXIS_START_MIN;
    const bookedMinutes = [...perCourt.values()].reduce((a, s) => a + s.minutes, 0);
    const capacity = courts.rows.length * axisMinutes;

    const nowMins = minutesFromAxis(Date.now(), businessDate, rollover);
    const nowOnAxis = nowMins >= 0 && nowMins <= axisMinutes;

    return {
      venue: {
        id: venue.id,
        name: venue.name,
        locality: venue.locality,
        city: venue.city,
        plan: venue.plan,
        courtCount: courts.rows.length,
      },
      businessDate,
      filter: { platforms: platformFilter ?? [] },
      axis: { startMin: AXIS_START_MIN, cols: COLS, colMinutes: COL_MIN },
      now: nowOnAxis
        ? { offsetCols: Number((nowMins / COL_MIN).toFixed(3)), label: localHhmm(Date.now()) }
        : null,
      tiles: {
        bookings: count,
        grossLabel: formatINR(gross),
        netLabel: formatINR(net),
        commissionLabel: formatINR(commission),
        occupancyPct: capacity ? Math.round((bookedMinutes / capacity) * 100) : 0,
        blocksAvoided: avoided.rows[0].n,
        hoursSaved: Math.round((avoided.rows[0].n * 2.5) / 60),
      },
      channels: accounts.rows.map((a) => ({
        platform: a.platform,
        label: PLATFORM_LABELS[a.platform],
        uiKey: PLATFORM_UI_KEY[a.platform],
        lastEventAt: a.last_event_at,
        status: a.status,
        sessionExpiresAt: a.session_expires_at,
      })),
      device: heartbeat.rows[0]
        ? {
            label: heartbeat.rows[0].device_label,
            batteryPct: heartbeat.rows[0].battery_pct,
            notificationAccess: heartbeat.rows[0].notification_access,
            queuedOffline: heartbeat.rows[0].queued_offline,
            receivedAt: heartbeat.rows[0].received_at,
            appLastSeen: heartbeat.rows[0].app_last_seen,
          }
        : null,
      courts: courts.rows.map((c) => {
        const s = perCourt.get(c.id);
        return {
          id: c.id,
          name: c.name,
          sport: c.sport,
          slots: s.slots,
          utilPct: Math.round((s.minutes / axisMinutes) * 100),
        };
      }),
      blocks: blockList,
      conflicts: conflictList,
      maintenance: maintenanceList,
    };
  });

  // Detail drawer: the booking plus its sync fan-out, reconstructed from the
  // notification log and the block receipts.
  app.get('/api/bookings/:id', async (request, reply) => {
    const { client } = await resolveVenue(request, 'board:read');
    const { rows } = await client.query(
      `select b.*, c.name as court_name, c.sport,
              a.commission_bps
         from bookings b
         join courts c on c.id = b.court_id
         left join platform_accounts a on a.venue_id = b.venue_id and a.platform = b.platform
        where b.id = $1`,
      [request.params.id],
    );
    const b = rows[0];
    if (!b) return reply.code(404).send({ error: 'booking not found' });

    const { startMs, endMs } = fromRange(b.slot);

    const [logs, jobs] = await Promise.all([
      client.query(
        `select source_channel, parse_status, template_version, received_at, latency_ms
           from notification_logs where booking_id = $1 order by received_at`,
        [b.id],
      ),
      client.query(
        `select j.target_platform, j.state, j.attempts, j.completed_at, j.last_error,
                r.latency_ms, r.verification_method, r.id as receipt_id
           from block_jobs j
           left join block_receipts r on r.block_job_id = j.id
          where j.booking_id = $1
          order by r.latency_ms nulls last, j.target_platform`,
        [b.id],
      ),
    ]);

    const fan = [];
    const source = logs.rows[0];
    fan.push({
      kind: 'src',
      title: b.platform === 'direct'
        ? `Entered at the counter${b.staff_name ? ` · ${b.staff_name}` : ''}`
        : `${PLATFORM_LABELS[b.platform]} ${source?.source_channel === 'email' ? 'confirmation email' : 'notification'}`,
      detail: source
        ? `${localHhmm(Date.parse(source.received_at))} · ${source.parse_status === 'fallback' ? 'read by Claude fallback' : source.template_version ?? 'manual entry'}`
        : 'manual entry',
      latency: '—',
    });
    for (const log of logs.rows.slice(1)) {
      fan.push({
        kind: 'ok',
        title: log.source_channel === 'email' ? 'Confirmation email matched — amounts filled in' : 'Second source matched',
        detail: `${localHhmm(Date.parse(log.received_at))} · joined on the dedupe key`,
        latency: '—',
      });
    }
    for (const j of jobs.rows) {
      const label = PLATFORM_LABELS[j.target_platform];
      if (j.receipt_id) {
        fan.push({
          kind: 'ok',
          title: `${label} blocked`,
          detail: `receipt ${String(j.receipt_id).slice(0, 4)}·${j.verification_method}`,
          latency: j.latency_ms != null ? `${(j.latency_ms / 1000).toFixed(1)}s` : '—',
        });
      } else if (j.state === 'failed') {
        fan.push({ kind: 'fail', title: `${label} failed`, detail: j.last_error ?? 'no response', latency: '—' });
      } else {
        fan.push({
          kind: 'wait',
          title: `${label} — ${j.state}`,
          detail: j.attempts ? `attempt ${j.attempts} of 3` : 'queued',
          latency: '—',
        });
      }
    }
    if (!jobs.rows.length) {
      fan.push({
        kind: 'wait',
        title: 'Not blocked on other platforms',
        detail: 'This venue is on read-only. Turn on auto-block in Setup.',
        latency: '—',
      });
    }

    const bps = b.commission_bps ?? 0;
    return {
      id: b.id,
      platform: b.platform,
      platformLabel: PLATFORM_LABELS[b.platform],
      uiKey: PLATFORM_UI_KEY[b.platform],
      customer: b.customer_name,
      phoneMasked: maskPhone(b.customer_phone),
      ref: b.external_booking_id ?? `TS-${b.id.slice(0, 8).toUpperCase()}`,
      court: b.court_name,
      slotLabel: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
      businessDate: b.business_date,
      sourceLabel: b.source_channel === 'notification' ? 'Counter tablet'
        : b.source_channel === 'email' ? 'Confirmation email'
        : b.source_channel === 'manual' ? `Entered at counter${b.staff_name ? ` · ${b.staff_name}` : ''}`
        : 'Session worker',
      paymentLabel: b.payment_mode === 'cash' ? `Cash${b.staff_name ? ` · collected by ${b.staff_name}` : ''}`
        : b.payment_mode === 'whatsapp' ? 'UPI to venue' : 'Paid online',
      grossLabel: formatINR(b.gross_paise),
      commissionLabel: b.commission_paise ? `−${formatINR(b.commission_paise)}` : '₹0',
      netLabel: formatINR(b.net_paise ?? b.gross_paise),
      rateLabel: bps ? `Commission · ${bps / 100}%` : 'Commission',
      fan,
    };
  });
}
