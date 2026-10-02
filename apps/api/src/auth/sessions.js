import { randomBytes, createHash } from 'node:crypto';
import { pool } from '@turfsync/db';

export const COOKIE = 'turfsync_session';

// A turf owner checks the board every evening; making them log in weekly would
// get the password written on a sticky note next to the tablet.
const TTL_DAYS = 30;
// Rolling window: a session in daily use never expires out from under someone.
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const hash = (token) => createHash('sha256').update(token).digest('hex');

export async function createSession(accountId, { userAgent, ip } = {}) {
  // 32 bytes of entropy. Only the hash is stored, so a database dump does not
  // hand over live sessions.
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TTL_DAYS * 86_400_000);

  await pool.query(
    `insert into sessions (account_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5)`,
    [accountId, hash(token), expires, userAgent ?? null, ip ?? null],
  );

  await pool.query('update accounts set last_login_at = now() where id = $1', [accountId]);
  return { token, expires };
}

/** @returns the account behind a session token, or null. */
export async function resolveSession(token) {
  if (!token) return null;

  const { rows } = await pool.query(
    `select s.id as session_id, s.last_seen_at, s.expires_at,
            a.id, a.email, a.name, a.status
       from sessions s
       join accounts a on a.id = s.account_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hash(token)],
  );

  const row = rows[0];
  if (!row || row.status !== 'active') return null;

  // Only touch the row once a day. Writing on every request would turn a read
  // path into a write path for no benefit.
  if (Date.now() - Date.parse(row.last_seen_at) > REFRESH_AFTER_MS) {
    await pool.query(
      `update sessions
          set last_seen_at = now(), expires_at = now() + make_interval(days => $2)
        where id = $1`,
      [row.session_id, TTL_DAYS],
    );
  }

  return { id: row.id, email: row.email, name: row.name, sessionId: row.session_id };
}

export async function revokeSession(token) {
  if (!token) return;
  await pool.query('delete from sessions where token_hash = $1', [hash(token)]);
}

export async function revokeAllForAccount(accountId) {
  await pool.query('delete from sessions where account_id = $1', [accountId]);
}

/** Expired rows are dead weight; the index on expires_at makes this cheap. */
export async function purgeExpired() {
  const { rowCount } = await pool.query('delete from sessions where expires_at < now()');
  return rowCount;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // The board is served over plain HTTP in development; anywhere else this
    // cookie must not travel in the clear.
    secure: process.env.NODE_ENV === 'production',
    maxAge: TTL_DAYS * 86_400,
  };
}
