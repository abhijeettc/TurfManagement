import { pool } from '@turfsync/db';
import { fromRange, localHhmm, PLATFORM_LABELS } from '@turfsync/core';
import { resolveVenue } from '../venue.js';
import { completeBlockTask, completeUnblockTask } from '../blocking/worker.js';

/**
 * Assisted sync tasks — "block this on Hudle," "release this on KheloMore" —
 * the staff-facing side of the pivot away from automated dashboard writes.
 * See blocking/worker.js's top comment for why there is no adapter call
 * anywhere behind this route.
 */
export default async function syncRoutes(app) {
  app.get('/api/sync-tasks', async (request) => {
    const { venue } = await resolveVenue(request, 'sync:read');

    const { rows } = await pool.query(
      `select j.id, j.target_platform, j.state, j.due_by, j.escalated_at,
              j.unblock_requested_at, j.unblock_due_by,
              b.slot, b.business_date, c.name as court_name
         from block_jobs j
         join bookings b on b.id = j.booking_id
         join courts c on c.id = b.court_id
        where b.venue_id = $1
          and (j.state = 'submitted' or (j.state = 'verified' and j.unblock_requested_at is not null))
        order by coalesce(j.unblock_due_by, j.due_by) nulls last`,
      [venue.id],
    );

    return {
      tasks: rows.map((r) => {
        const { startMs, endMs } = fromRange(r.slot);
        const isUnblock = r.state === 'verified' && r.unblock_requested_at;
        return {
          id: r.id,
          action: isUnblock ? 'unblock' : 'block',
          platform: r.target_platform,
          label: PLATFORM_LABELS[r.target_platform],
          court: r.court_name,
          slot: `${localHhmm(startMs)}–${localHhmm(endMs)}`,
          businessDate: r.business_date,
          dueBy: isUnblock ? r.unblock_due_by : r.due_by,
          overdue: isUnblock
            ? Boolean(r.unblock_due_by && new Date(r.unblock_due_by) < new Date())
            : Boolean(r.due_by && new Date(r.due_by) < new Date()),
        };
      }),
    };
  });

  app.post('/api/sync-tasks/:id/complete', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'sync:complete');
    const completedBy = request.account?.name ?? null;

    // A task is either an open block or an open unblock — never both — so try
    // the one that matches what's actually pending and report clearly if
    // neither does, rather than guessing which the caller meant.
    const block = await completeBlockTask({ jobId: request.params.id, venueId: venue.id, completedBy }).catch((e) => {
      if (e.statusCode === 409) return null;
      throw e;
    });
    if (block) return { task: block };

    const unblock = await completeUnblockTask({ jobId: request.params.id, venueId: venue.id, completedBy }).catch((e) => {
      if (e.statusCode === 409) return null;
      throw e;
    });
    if (unblock) return { task: unblock };

    return reply.code(404).send({ error: 'No open sync task with that id for this venue.' });
  });
}
