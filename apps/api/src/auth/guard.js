import { createHash } from 'node:crypto';
import { pool } from '@turfsync/db';
import { COOKIE, resolveSession } from './sessions.js';

/**
 * Who may do what.
 *
 * The roles are drawn from how a turf actually runs, not from a generic
 * admin/user split:
 *
 *   owner    — everything. Usually one or two people.
 *   staff    — the counter. Needs the board and the ability to take a walk-in
 *              at 9pm with a queue forming. Has no business seeing the venue's
 *              margins or repointing a court mapping.
 *   partner  — a co-owner who put money in and wants to verify the numbers.
 *              Read-only, and only the money. This is the role that exists
 *              because partner distrust is a real pain point.
 */
export const CAN = {
  'board:read':      ['owner', 'staff'],
  'booking:create':  ['owner', 'staff'],
  'booking:cancel':  ['owner', 'staff'],
  'conflict:read':   ['owner', 'staff'],
  'conflict:resolve':['owner', 'staff'],
  'sync:read':       ['owner', 'staff'],
  'sync:complete':   ['owner', 'staff'],
  'money:read':      ['owner', 'partner'],
  'setup:read':      ['owner'],
  'setup:write':     ['owner'],
  'device:pair':     ['owner'],
};

function unauthorized(message = 'Sign in to continue.') {
  return Object.assign(new Error(message), { statusCode: 401 });
}
function forbidden(message = 'Your account does not have access to that.') {
  return Object.assign(new Error(message), { statusCode: 403 });
}

/** Attach `request.account`, or 401. */
export async function requireAuth(request) {
  const token = request.cookies?.[COOKIE];
  const account = await resolveSession(token);
  if (!account) throw unauthorized();
  request.account = account;
  return account;
}

/**
 * Resolve the venue a request is about, and prove the caller may touch it.
 *
 * This is the whole point of the phase. Every query in the codebase already
 * filters by venue_id; what changes is that the id now comes from a verified
 * membership rather than from a query parameter anyone could type.
 */
export async function requireVenue(request, permission) {
  const account = request.account ?? (await requireAuth(request));

  const wanted =
    request.params?.venueId ??
    request.query?.venue ??
    request.body?.venueId ??
    null;

  const { rows } = wanted
    ? await pool.query(
        `select v.*, av.role
           from venues v
           join account_venues av on av.venue_id = v.id
          where av.account_id = $1 and v.id = $2`,
        [account.id, wanted],
      )
    : await pool.query(
        `select v.*, av.role
           from venues v
           join account_venues av on av.venue_id = v.id
          where av.account_id = $1 and v.status = 'active'
          order by av.role = 'owner' desc, v.created_at
          limit 1`,
        [account.id],
      );

  const venue = rows[0];

  // Deliberately the same error whether the venue does not exist or the caller
  // simply has no membership on it. Distinguishing the two would let anyone
  // enumerate which venue ids are real.
  if (!venue) throw forbidden('No such venue, or your account has no access to it.');

  if (permission) {
    const allowed = CAN[permission];
    if (!allowed) throw new Error(`unknown permission: ${permission}`);
    if (!allowed.includes(venue.role)) {
      throw forbidden(`A ${venue.role} account cannot do that.`);
    }
  }

  request.venue = venue;
  request.role = venue.role;
  return { venue, client: pool, role: venue.role };
}

/** Every venue this account can see, for the venue switcher. */
export async function venuesFor(accountId) {
  const { rows } = await pool.query(
    `select v.id, v.name, v.locality, v.city, v.plan, av.role
       from venues v
       join account_venues av on av.venue_id = v.id
      where av.account_id = $1 and v.status = 'active'
      order by av.role = 'owner' desc, v.name`,
    [accountId],
  );
  return rows;
}

// ---------------------------------------------------------------- devices

const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

/**
 * Machine-to-machine auth for the counter tablet.
 *
 * A shared DEVICE_TOKEN could not say which venue a notification belonged to,
 * and let any paired device post into any venue's board. Each device now holds
 * a token issued for exactly one venue, and the token itself decides the venue
 * — the client never gets to name it.
 */
export async function requireDevice(request) {
  const presented = request.headers['x-device-token'];
  if (!presented) throw unauthorized('Missing device token.');

  const { rows } = await pool.query(
    `update device_tokens
        set last_used_at = now()
      where token_hash = $1 and revoked_at is null
      returning venue_id, label`,
    [tokenHash(presented)],
  );

  const device = rows[0];
  if (!device) throw unauthorized('Unrecognised or revoked device token.');

  const { rows: venues } = await pool.query('select * from venues where id = $1', [device.venue_id]);
  if (!venues[0]) throw unauthorized('That device is paired to a venue that no longer exists.');

  request.device = device;
  request.venue = venues[0];
  return { venue: venues[0], device };
}

/** Same shape, for the inbound-email webhook. */
export async function requireInboundSecret(request, venueId) {
  const presented = request.headers['x-inbound-token'];
  const { rows } = await pool.query('select * from venues where id = $1', [venueId]);
  const venue = rows[0];
  if (!venue) throw unauthorized('Unknown venue address.');
  if (!venue.inbound_secret || venue.inbound_secret !== presented) {
    throw unauthorized('Bad inbound token.');
  }
  return venue;
}

export { tokenHash };
