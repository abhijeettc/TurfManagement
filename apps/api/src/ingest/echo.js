/**
 * Echo suppression — finding 1 in the build plan.
 *
 * When Phase 3 blocks 19:00 on Hudle, Hudle's partner app fires a notification.
 * The counter tablet's listener reads it and POSTs it here. Without this check
 * the pipeline ingests our own write as a fresh external booking, enqueues
 * blocks on the other three platforms, and one of those is where the booking
 * originated — a loop that grows with every hop.
 *
 * Phase 1 writes no expectations, because nothing blocks yet. The check still
 * runs on every ingest from day one so that turning write-back on cannot
 * accidentally ship without it.
 */

/**
 * Claim a matching expectation. Consuming it here means a second, genuine
 * booking for the same slot minutes later is NOT swallowed.
 *
 * @returns the consumed expectation, or null when this payload is external.
 */
export async function claimEcho(client, { venueId, platform, externalCourtId, startMs, endMs }) {
  const { rows } = await client.query(
    `update echo_expectations
        set consumed_at = now()
      where id = (
        select id from echo_expectations
         where venue_id = $1
           and platform = $2
           and consumed_at is null
           and expires_at > now()
           and slot && tstzrange($4::timestamptz, $5::timestamptz)
           and (external_court_id is null or $3::text is null or external_court_id = $3)
         order by created_at
         limit 1
         for update skip locked
      )
      returning id, slot, created_at`,
    [venueId, platform, externalCourtId ?? null, new Date(startMs), new Date(endMs)],
  );
  return rows[0] ?? null;
}

/** Phase 3 calls this immediately before every outbound block or unblock. */
export async function expectEcho(client, { venueId, platform, externalCourtId, startMs, endMs, ttlMinutes = 15 }) {
  const { rows } = await client.query(
    `insert into echo_expectations
       (venue_id, platform, external_court_id, slot, expires_at)
     values ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz),
             now() + make_interval(mins => $6))
     returning id`,
    [venueId, platform, externalCourtId ?? null, new Date(startMs), new Date(endMs), ttlMinutes],
  );
  return rows[0];
}
