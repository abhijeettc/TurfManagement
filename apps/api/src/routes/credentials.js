import { timingSafeEqual } from 'node:crypto';
import { pool } from '@turfsync/db';
import { PLATFORMS, PLATFORM_LABELS, PLATFORM_UI_KEY } from '@turfsync/core';
import { resolveVenue } from '../venue.js';
import { sealLogin } from '../credentials/seal.js';

/** Apps a login can be saved for — every marketplace, not walk-in "direct". */
// TurfPro first: it is the app being blocked on; the rest follow in platform order.
const APPS = ['turfpro', ...PLATFORMS.filter((p) => p !== 'direct' && p !== 'turfpro')];

const MAX_LEN = 200;

function workerAuthorised(request) {
  const expected = process.env.WORKER_TOKEN;
  const got = request.headers['x-worker-token'];
  if (!expected || typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function logActivity(venueId, platform, action, { outcome = 'ok', detail = null, actor = 'worker' } = {}) {
  await pool.query(
    `insert into credential_activity (venue_id, platform, action, outcome, detail, actor)
     values ($1,$2,$3,$4,$5,$6)`,
    [venueId, platform, action, outcome, detail, actor],
  );
}

export default async function credentialRoutes(app) {
  // ------------------------------------------------------------ owner-facing
  //
  // Nothing below ever returns a username or password — not even masked
  // characters of one. The login is sealed with the worker's public key on the
  // way in and this API has no way to open it again (see credentials/seal.js).

  /** Which apps have a saved login, and how each has been used. */
  app.get('/api/credentials', async (request) => {
    const { venue } = await resolveVenue(request, 'setup:read');

    const [saved, usage] = await Promise.all([
      pool.query(`select platform, key_id, updated_at from platform_credentials where venue_id = $1`, [venue.id]),
      pool.query(
        `select platform,
                count(*) filter (where action = 'login_attempt')::int  as logins,
                count(*) filter (where action = 'login_ok')::int       as logins_ok,
                count(*) filter (where action = 'login_failed')::int   as logins_failed,
                count(*) filter (where action = 'session_reused')::int as reused,
                count(*) filter (where action = 'block_slot')::int     as blocks,
                count(*) filter (where action = 'unblock_slot')::int   as unblocks,
                count(*) filter (where action = 'read_slots')::int     as reads,
                max(at) filter (where actor = 'worker')                as last_used
           from credential_activity where venue_id = $1 group by platform`,
        [venue.id],
      ),
    ]);
    const savedBy = new Map(saved.rows.map((r) => [r.platform, r]));
    const usageBy = new Map(usage.rows.map((r) => [r.platform, r]));

    return {
      apps: APPS.map((platform) => {
        const s = savedBy.get(platform);
        const u = usageBy.get(platform);
        return {
          platform,
          label: PLATFORM_LABELS[platform],
          uiKey: PLATFORM_UI_KEY[platform],
          saved: Boolean(s),
          updatedAt: s?.updated_at ?? null,
          keyId: s?.key_id ?? null,
          usage: {
            logins: u?.logins ?? 0,
            loginsOk: u?.logins_ok ?? 0,
            loginsFailed: u?.logins_failed ?? 0,
            sessionsReused: u?.reused ?? 0,
            blocks: u?.blocks ?? 0,
            unblocks: u?.unblocks ?? 0,
            reads: u?.reads ?? 0,
            lastUsed: u?.last_used ?? null,
          },
        };
      }),
    };
  });

  /** Save (or replace) the login for one app. Write-only. */
  app.put('/api/credentials/:platform', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'setup:write');
    const account = request.account;
    const { platform } = request.params;
    if (!APPS.includes(platform)) return reply.code(404).send({ error: 'Unknown app.' });

    const username = String(request.body?.username ?? '').trim();
    const password = String(request.body?.password ?? '');
    if (!username || !password) return reply.code(400).send({ error: 'Enter both the username and the password.' });
    if (username.length > MAX_LEN || password.length > MAX_LEN) return reply.code(400).send({ error: 'That is too long to be a login.' });

    const { sealed, keyId } = sealLogin({ venueId: venue.id, platform, username, password });
    await pool.query(
      `insert into platform_credentials (venue_id, platform, sealed, key_id, updated_by)
       values ($1,$2,$3,$4,$5)
       on conflict (venue_id, platform)
       do update set sealed = excluded.sealed, key_id = excluded.key_id,
                     updated_by = excluded.updated_by, updated_at = now()`,
      [venue.id, platform, sealed, keyId, account?.id ?? null],
    );
    await logActivity(venue.id, platform, 'credential_saved', { actor: account?.email ?? 'owner', detail: 'Login saved (sealed — not readable by the dashboard)' });
    return { ok: true, saved: true };
  });

  app.delete('/api/credentials/:platform', async (request, reply) => {
    const { venue } = await resolveVenue(request, 'setup:write');
    const account = request.account;
    const { platform } = request.params;
    if (!APPS.includes(platform)) return reply.code(404).send({ error: 'Unknown app.' });
    const { rowCount } = await pool.query(`delete from platform_credentials where venue_id = $1 and platform = $2`, [venue.id, platform]);
    if (!rowCount) return reply.code(404).send({ error: 'No saved login for that app.' });
    await logActivity(venue.id, platform, 'credential_removed', { actor: account?.email ?? 'owner', detail: 'Login removed' });
    return reply.code(204).send();
  });

  /** What the blocking worker has done with the saved logins, newest first. */
  app.get('/api/credentials/activity', async (request) => {
    const { venue } = await resolveVenue(request, 'setup:read');
    const platform = request.query.platform;
    const limit = Math.min(Number(request.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `select id, platform, action, outcome, detail, actor, at
         from credential_activity
        where venue_id = $1 and ($2::text is null or platform::text = $2)
        order by at desc limit $3`,
      [venue.id, platform ?? null, limit],
    );
    return { activity: rows.map((r) => ({ ...r, label: PLATFORM_LABELS[r.platform], uiKey: PLATFORM_UI_KEY[r.platform] })) };
  });

  // ------------------------------------------------------------ worker only
  //
  // Reached by the blocking worker directly on this server's own port, never
  // through the tablet-facing address (the local proxy refuses /internal/*).
  // The worker token is separate from every user session.

  /** The sealed envelope — ciphertext only; the worker opens it with its private key. */
  app.get('/internal/credentials/:venueId/:platform', async (request, reply) => {
    if (!workerAuthorised(request)) return reply.code(401).send({ error: 'not authorised' });
    const { venueId, platform } = request.params;
    const { rows } = await pool.query(
      `select sealed, key_id from platform_credentials where venue_id = $1 and platform = $2`,
      [venueId, platform],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'no saved login for this app' });
    return { sealed: rows[0].sealed, keyId: rows[0].key_id };
  });

  app.post('/internal/credential-activity', async (request, reply) => {
    if (!workerAuthorised(request)) return reply.code(401).send({ error: 'not authorised' });
    const { venueId, platform, action, outcome, detail } = request.body ?? {};
    if (!venueId || !APPS.includes(platform) || !action) return reply.code(400).send({ error: 'venueId, platform and action are required' });
    await logActivity(venueId, platform, String(action).slice(0, 40), { outcome: String(outcome ?? 'ok').slice(0, 20), detail: detail ? String(detail).slice(0, 300) : null });
    return reply.code(204).send();
  });
}
