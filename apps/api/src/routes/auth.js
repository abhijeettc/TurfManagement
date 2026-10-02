import { randomBytes } from 'node:crypto';
import { pool, tx } from '@turfsync/db';
import { normalizePhone } from '@turfsync/core';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { createSession, revokeSession, cookieOptions, COOKIE } from '../auth/sessions.js';
import { requireAuth, venuesFor } from '../auth/guard.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function bad(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export default async function authRoutes(app) {
  /**
   * Sign up, and become the owner of a new venue in the same transaction.
   *
   * An account with no venue is a dead end — there is no screen in the product
   * that means anything without one — so signup creates both. The courts and
   * the platform mappings come next, in the onboarding wizard.
   */
  app.post('/auth/signup', async (request, reply) => {
    const { email, password, name, phone, venueName, city, locality } = request.body ?? {};

    if (!EMAIL.test(String(email ?? ''))) throw bad('Enter a valid email address.');
    if (!venueName) throw bad('Your venue needs a name.');
    if (!city) throw bad('Which city is the venue in?');

    const normalised = String(email).trim().toLowerCase();
    const hash = await hashPassword(password);

    const account = await tx(async (client) => {
      const existing = await client.query('select 1 from accounts where email = $1', [normalised]);
      if (existing.rowCount) {
        throw Object.assign(new Error('An account with that email already exists.'), { statusCode: 409 });
      }

      const { rows: accounts } = await client.query(
        `insert into accounts (email, password_hash, name, phone) values ($1,$2,$3,$4) returning *`,
        [normalised, hash, name ?? null, normalizePhone(phone)],
      );
      const acct = accounts[0];

      const { rows: venues } = await client.query(
        `insert into venues (name, locality, city, inbound_secret)
         values ($1,$2,$3,$4) returning *`,
        [venueName, locality ?? null, city, randomBytes(24).toString('base64url')],
      );

      await client.query(
        `insert into account_venues (account_id, venue_id, role) values ($1,$2,'owner')`,
        [acct.id, venues[0].id],
      );

      // Every marketplace a venue might list on, at a placeholder rate. The
      // owner corrects these during onboarding; having the rows exist means the
      // commission engine and the channel strip work from the first booking.
      for (const platform of ['turfpro', 'playo', 'khelomore', 'hudle', 'district', 'direct']) {
        await client.query(
          `insert into platform_accounts (venue_id, platform, commission_bps, status)
           values ($1,$2,$3,'inactive')`,
          [venues[0].id, platform, platform === 'direct' ? 0 : 1500],
        );
      }

      return { acct, venue: venues[0] };
    });

    const { token } = await createSession(account.acct.id, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    reply.setCookie(COOKIE, token, cookieOptions());
    return reply.code(201).send({
      account: { id: account.acct.id, email: account.acct.email, name: account.acct.name },
      venue: { id: account.venue.id, name: account.venue.name },
      next: 'onboarding',
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body ?? {};
    const normalised = String(email ?? '').trim().toLowerCase();

    const { rows } = await pool.query('select * from accounts where email = $1', [normalised]);
    const account = rows[0];

    // Run the verification even when there is no such account, so a missing
    // email and a wrong password take the same time and return the same words.
    const ok = await verifyPassword(
      String(password ?? ''),
      account?.password_hash ?? '$scrypt$32768$AAAA$AAAA',
    );

    if (!account || !ok || account.status !== 'active') {
      return reply.code(401).send({ error: 'That email and password do not match.' });
    }

    const { token } = await createSession(account.id, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    });

    reply.setCookie(COOKIE, token, cookieOptions());
    return { account: { id: account.id, email: account.email, name: account.name } };
  });

  app.post('/auth/logout', async (request, reply) => {
    await revokeSession(request.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  /** Who am I, and which venues can I see? The board calls this on load. */
  app.get('/auth/me', async (request) => {
    const account = await requireAuth(request);
    const venues = await venuesFor(account.id);

    // A venue with no courts has nothing to draw, so the board would be an
    // empty grid. Send them to the wizard until there is at least one court —
    // otherwise reloading after signup drops them somewhere that looks broken.
    let courts = 0;
    if (venues.length) {
      const { rows } = await pool.query(
        'select count(*)::int as n from courts where venue_id = $1',
        [venues[0].id],
      );
      courts = rows[0].n;
    }

    return {
      account: { id: account.id, email: account.email, name: account.name },
      venues,
      next: venues.length && courts > 0 ? 'board' : 'onboarding',
    };
  });
}
