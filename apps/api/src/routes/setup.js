import { randomBytes } from 'node:crypto';
import { pool, tx } from '@turfsync/db';
import { resolveVenue } from '../venue.js';
import { tokenHash } from '../auth/guard.js';
import { PLATFORM_LABELS, PLATFORM_UI_KEY, PLATFORMS } from '@turfsync/core';

const MARKETPLACES = PLATFORMS.filter((p) => p !== 'direct');

export default async function setupRoutes(app) {
  app.get('/api/setup', async (request) => {
    const { venue } = await resolveVenue(request, 'setup:read');

    const [courts, mappings, recentLogs, heartbeat, accounts, logStats] = await Promise.all([
      pool.query(`select id, name, sport from courts where venue_id = $1 order by position, name`, [venue.id]),
      pool.query(
        `select m.* from court_mappings m join courts c on c.id = m.court_id where c.venue_id = $1`,
        [venue.id],
      ),
      pool.query(
        `select id, platform, source_channel, parse_status, parse_error,
                template_version, booking_id, received_at, latency_ms,
                left(raw_text, 500) as raw_text
           from notification_logs
          where venue_id = $1
          order by received_at desc
          limit 50`,
        [venue.id],
      ),
      pool.query(`select * from device_heartbeats where venue_id = $1 order by received_at desc limit 1`, [venue.id]),
      pool.query(`select * from platform_accounts where venue_id = $1`, [venue.id]),
      // How many of today's bookings were seen on BOTH channels. Counting raw
      // messages instead of bookings lets a platform report "4 of 2 matched" —
      // the number has to be per booking to mean anything.
      pool.query(
        `select platform,
                count(distinct booking_id)
                  filter (where booking_id is not null)::int                 as bookings,
                count(distinct booking_id)
                  filter (where source_channel = 'email'
                            and booking_id is not null)::int                 as with_email,
                count(*) filter (where parse_status = 'failed')::int         as failures,
                max(received_at)                                             as last_seen
           from notification_logs
          where venue_id = $1 and received_at > now() - interval '24 hours'
          group by platform`,
        [venue.id],
      ),
    ]);

    const byCourt = new Map();
    for (const m of mappings.rows) {
      if (!byCourt.has(m.court_id)) byCourt.set(m.court_id, new Map());
      byCourt.get(m.court_id).set(m.platform, m);
    }
    const stats = new Map(logStats.rows.map((r) => [r.platform, r]));
    const accountMap = new Map(accounts.rows.map((a) => [a.platform, a]));

    return {
      courts: courts.rows.map((c) => {
        const mapped = byCourt.get(c.id) ?? new Map();
        const chips = MARKETPLACES.map((p) => {
          const m = mapped.get(p);
          return m
            ? { platform: p, label: PLATFORM_LABELS[p], uiKey: PLATFORM_UI_KEY[p], external: m.external_label, mapped: true }
            : { platform: p, label: PLATFORM_LABELS[p], uiKey: PLATFORM_UI_KEY[p], external: null, mapped: false };
        });
        const allVerified = [...mapped.values()].length === MARKETPLACES.length
          && [...mapped.values()].every((m) => m.verified_at);
        const verifiedAt = [...mapped.values()].map((m) => m.verified_at).filter(Boolean).sort()[0];

        return {
          id: c.id,
          name: c.name,
          sport: c.sport,
          chips,
          // A mapping is not trusted until a live test block has landed on it
          // and been read back. Getting this wrong blocks the wrong pitch.
          status: allVerified
            ? { kind: 'ok', label: `Test block verified ${fmtDate(verifiedAt)}` }
            : { kind: 'warn', label: 'Run a test block' },
        };
      }),
      device: heartbeat.rows[0]
        ? {
            heartbeatLabel: ago(heartbeat.rows[0].received_at),
            batteryPct: heartbeat.rows[0].battery_pct,
            notificationAccess: heartbeat.rows[0].notification_access,
            queuedOffline: heartbeat.rows[0].queued_offline,
            apps: MARKETPLACES.map((p) => {
              const s = stats.get(p);
              const a = accountMap.get(p);
              const expiring = a?.session_expires_at
                ? Math.round((Date.parse(a.session_expires_at) - Date.now()) / 86_400_000)
                : null;
              return {
                platform: p,
                label: PLATFORM_LABELS[p],
                uiKey: PLATFORM_UI_KEY[p],
                lastLabel: s?.last_seen ? ago(s.last_seen) : 'no messages today',
                today: s?.bookings ?? 0,
                matchedLabel: s ? `${s.with_email} of ${s.bookings} matched` : '—',
                status:
                  expiring != null && expiring <= 3
                    ? { kind: 'warn', label: `Session expires in ${expiring} day${expiring === 1 ? '' : 's'}` }
                    : s?.failures
                      ? { kind: 'warn', label: `${s.failures} unreadable` }
                      : { kind: 'ok', label: 'Healthy' },
              };
            }),
          }
        : null,
      logs: recentLogs.rows,
    };
  });

  /**
   * Onboarding: create a court.
   *
   * A venue with no courts has nothing to draw, which is why signup sends a new
   * account here rather than to an empty board.
   */
  app.post('/api/courts', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'setup:write');
    const { name, sport } = request.body ?? {};
    if (!name) return reply.code(400).send({ error: 'The court needs a name.' });

    const { rows: existing } = await pool.query(
      'select count(*)::int as n from courts where venue_id = $1',
      [venue.id],
    );

    try {
      const { rows } = await pool.query(
        `insert into courts (venue_id, name, sport, position)
         values ($1,$2,$3,$4) returning *`,
        [venue.id, name, sport || 'Turf', existing[0].n + 1],
      );
      return reply.code(201).send({ court: rows[0] });
    } catch (error) {
      if (error.code === '23505') {
        return reply.code(409).send({ error: 'You already have a court with that name.' });
      }
      throw error;
    }
  });

  app.delete('/api/courts/:id', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'setup:write');
    const { rowCount } = await pool.query(
      'delete from courts where id = $1 and venue_id = $2',
      [request.params.id, venue.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'No such court.' });
    return reply.code(204).send();
  });

  /**
   * Onboarding: tell us what each platform calls this court.
   *
   * Deliberately NOT verified on save. A mapping is only trusted once a live
   * test block has landed on it and been read back — getting this wrong blocks
   * the wrong pitch, so verified_at stays null until Phase 3 proves it.
   */
  app.put('/api/courts/:id/mappings', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'setup:write');
    const mappings = request.body?.mappings ?? {};

    const { rows: courts } = await pool.query(
      'select id from courts where id = $1 and venue_id = $2',
      [request.params.id, venue.id],
    );
    if (!courts[0]) return reply.code(404).send({ error: 'No such court.' });

    await tx(async (client) => {
      for (const [platform, label] of Object.entries(mappings)) {
        if (!label) {
          await client.query(
            'delete from court_mappings where court_id = $1 and platform = $2',
            [request.params.id, platform],
          );
          continue;
        }
        await client.query(
          `insert into court_mappings (court_id, platform, external_label, external_court_id)
           values ($1,$2,$3,$3)
           on conflict (court_id, platform)
           do update set external_label = excluded.external_label,
                         external_court_id = excluded.external_court_id,
                         -- A relabelled court is an unproven court again.
                         verified_at = null`,
          [request.params.id, platform, label],
        );
        // A platform the venue actually lists on is one we should be watching.
        await client.query(
          `update platform_accounts set status = 'active'
            where venue_id = $1 and platform = $2`,
          [venue.id, platform],
        );
      }
    });

    return { ok: true };
  });

  /**
   * Pair a counter tablet.
   *
   * Returns the token exactly once — only its hash is stored, so it cannot be
   * shown again. In the product this is what the QR code on the onboarding
   * screen encodes; losing it means issuing a new one, which is the correct
   * tradeoff for a credential that grants write access to a venue's board.
   */
  app.post('/api/devices', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'device:pair');

    const token = randomBytes(32).toString('base64url');
    const { rows } = await pool.query(
      `insert into device_tokens (venue_id, label, token_hash, paired_at)
       values ($1, $2, $3, now()) returning id, label, created_at`,
      [venue.id, request.body?.label || 'Counter tablet', tokenHash(token)],
    );

    return reply.code(201).send({
      device: rows[0],
      token,
      note: 'Shown once. Store it on the tablet now — it cannot be retrieved again.',
    });
  });

  app.get('/api/devices', async (request) => {
    const { venue } = await resolveVenue(request, 'setup:read');
    const { rows } = await pool.query(
      `select id, label, created_at, paired_at, last_used_at
         from device_tokens where venue_id = $1 and revoked_at is null
        order by created_at`,
      [venue.id],
    );
    return { devices: rows };
  });

  app.delete('/api/devices/:id', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'device:pair');
    const { rowCount } = await pool.query(
      `update device_tokens set revoked_at = now()
        where id = $1 and venue_id = $2 and revoked_at is null`,
      [request.params.id, venue.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'No such device.' });
    return reply.code(204).send();
  });
}

function ago(ts) {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function fmtDate(ts) {
  return ts
    ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(ts))
    : '';
}
