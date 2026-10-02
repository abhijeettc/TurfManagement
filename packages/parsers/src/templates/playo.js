import { parseDateish, parseTimeRange, parseAmountPaise, first, looksCancelled } from '../util.js';

export const platform = 'playo';

// Bump the version whenever the regexes change. It is stored on every
// notification_log row, so "which template read this?" is answerable months later.
export const version = 'playo/2026-09-01';

const BOOKING_ID = [/\bBooking\s*ID[:\s]*([A-Z]{3}-\d{4,})/i, /\b(PLY-\d{4,})\b/];
const NAME = [/^([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)+)\s*[·(]/m, /\bCustomer[:\s]*([^(\n]+)/i];
const PHONE = [/\b((?:\+?91[- ]?)?[6-9]\d{9})\b/];

/**
 * Playo puts the court and the date on one line, separated by a middot:
 *
 *     Pickle 1 + 2 · Sat, 02 Sep
 *     Meena Iyer · 9812349999
 *
 * Both lines have that shape, so the court cannot be found by position or by a
 * character class — "Pickle 1 + 2" and "5-a-side (B)" are real court names, and
 * anything permissive enough to match them also matches a customer's name.
 *
 * What actually distinguishes the court line is that the text after the middot
 * is a date. Use that.
 */
function courtFromNotification(raw, refMs) {
  for (const line of String(raw).split('\n')) {
    const at = line.indexOf('·');
    if (at === -1) continue;
    const left = line.slice(0, at).trim();
    const right = line.slice(at + 1).trim();
    if (left && parseDateish(right, refMs)) return left;
  }
  return null;
}

/**
 * Playo's partner-app push. Carries who and when, never the money — which is
 * why the email channel is mandatory rather than a fallback.
 *
 *   New Booking Confirmed
 *   Turf A · Sat, 02 Sep
 *   07:00 PM - 08:00 PM
 *   Rohit Menon · 9912345651
 *   Booking ID: PLY-4471902
 */
export function notification(raw, refMs) {
  if (!/playo|PLY-/i.test(raw)) return null;
  const range = parseTimeRange(raw);
  const date = parseDateish(raw, refMs);
  const courtLabel = courtFromNotification(raw, refMs);
  if (!range || !date || !courtLabel) return null;

  return {
    platform,
    externalBookingId: first(raw, BOOKING_ID),
    courtLabel,
    date,
    startHhmm: range.start,
    endHhmm: range.end,
    customerName: first(raw, NAME),
    customerPhone: first(raw, PHONE),
    grossPaise: null,
    commissionPaise: null,
    cancelled: looksCancelled(raw),
  };
}

/**
 * The confirmation email. Same booking, plus the two numbers the ledger needs.
 */
export function email(raw, refMs) {
  if (!/playo/i.test(raw)) return null;
  const range = parseTimeRange(first(raw, [/\bSlot[:\s]*(.+)$/im]) ?? raw);
  const date = parseDateish(first(raw, [/\bDate[:\s]*(.+)$/im]) ?? raw, refMs);
  const courtLabel = first(raw, [/\bCourt[:\s]*(.+)$/im]);
  if (!range || !date || !courtLabel) return null;

  return {
    platform,
    externalBookingId: first(raw, BOOKING_ID),
    courtLabel,
    date,
    startHhmm: range.start,
    endHhmm: range.end,
    customerName: first(raw, [/\bCustomer[:\s]*([^(\n]+)/i]),
    customerPhone: first(raw, PHONE),
    grossPaise: parseAmountPaise(first(raw, [/\bBooking Amount[:\s]*(.+)$/im])),
    commissionPaise: parseAmountPaise(first(raw, [/\bCommission[^:]*[:\s]*(.+)$/im])),
    cancelled: looksCancelled(raw),
  };
}
