import { sendWhatsApp } from './notify.js';

/**
 * The venue owner's WhatsApp number, read from the account holding the
 * 'owner' role on account_venues — not a stored venue column, because the
 * phone belongs to whoever signed up, not the venue itself. Returns null
 * rather than a placeholder when nobody has one on file yet (e.g. accounts
 * created before signup collected a phone number).
 */
export async function resolveOwnerPhone(executor, venueId) {
  const { rows } = await executor.query(
    `select a.phone
       from account_venues av
       join accounts a on a.id = av.account_id
      where av.venue_id = $1 and av.role = 'owner' and a.phone is not null
      order by av.created_at asc
      limit 1`,
    [venueId],
  );
  return rows[0]?.phone ?? null;
}

/**
 * Resolve the owner's phone and send, or log and skip if none is on file.
 * Every WhatsApp call site used to address a hardcoded placeholder number —
 * skipping with a log line is the honest failure mode once that's gone;
 * inventing a fake recipient would hide the gap instead of surfacing it.
 */
export async function notifyOwner(executor, venueId, template, vars, log = console) {
  const phone = await resolveOwnerPhone(executor, venueId);
  if (!phone) {
    log.warn?.({ venueId, template }, 'no owner phone on file — skipping WhatsApp send');
    return { delivered: false, provider: 'skipped-no-phone' };
  }
  return sendWhatsApp(phone, template, vars);
}
