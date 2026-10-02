import { parseDateish, parseTimeRange, first, looksCancelled } from '../util.js';

export const platform = 'district';
export const version = 'district/whatsapp-2026-09-27';

// Bare alphanumeric, no prefix: MM8LPS, 32TPQZ. Nothing like the DST-7712xxxx
// shape this template used to guess at.
const BOOKING_ID = [/\bBooking\s*ID[:\s]*([A-Z0-9]{4,})/i];
const PHONE = [/\b((?:\+?91[- ]?)?[6-9]\d{9})\b/];

/**
 * District notifies by WhatsApp Business message, not by a partner-app push.
 * Captured from Pickle & Pitch Club on 27 Sep 2026:
 *
 *   Hi! You have a new booking for your venue 🎉
 *
 *   Siddhant Barve is scheduled to play Cricket Nets at Pickle & Pitch Club -
 *   Pitch 1|Synthetic Ball Cricket Bowling Machine (Practice net) on
 *   27 Sep 2026 10:30 AM - 11:30 AM.
 *
 *   Booking ID: MM8LPS
 *
 *   Open the District Play Partner app for full details.
 *
 * The message carries no amount at all, so District reconciliation cannot come
 * from this channel — it has to come from the app's own
 * "Payout summary → Download booking & payout data" export.
 *
 * Note the court label: `Pitch 1|Synthetic Ball Cricket Bowling Machine
 * (Practice net)` — 58 characters with a pipe and parentheses in it. Court
 * mapping has to survive labels like this, not the tidy "Turf A" placeholders.
 */
export function notification(raw, refMs) {
  if (!/district/i.test(raw)) return null;

  // "<name> is scheduled to play <activity> at <venue> - <court> on <date> …"
  // The `s` flag matters: the sentence wraps across lines in the real message.
  const courtLabel = first(raw, [/\bat\s+.+?\s+-\s+(.+?)\s+on\s+\d/is]);
  const range = parseTimeRange(raw);
  const date = parseDateish(raw, refMs);
  if (!range || !date || !courtLabel) return null;

  return {
    platform,
    externalBookingId: first(raw, BOOKING_ID),
    courtLabel: courtLabel.replace(/\s+/g, ' ').trim(),
    date,
    startHhmm: range.start,
    endHhmm: range.end,
    customerName: first(raw, [/^\s*(.+?)\s+is scheduled to play\b/im]),
    customerPhone: first(raw, PHONE),
    grossPaise: null,
    commissionPaise: null,
    cancelled: looksCancelled(raw),
  };
}

// No email() export — District's per-booking channel is WhatsApp. The bulk
// payout export is a separate, still-uncaptured format.
