import { parseDateish, parseTimeRange, first, looksCancelled } from '../util.js';

export const platform = 'hudle';
export const version = 'hudle/whatsapp-2026-09-27';

// HUD + 10 digits: HUD3785535674. Not the HDL-220914 shape this template
// used to guess at.
const BOOKING_ID = [/\bBooking\s*ID[:\s]*(HUD\d{6,})/i, /\bBooking\s*ID[:\s]*([A-Z0-9]{4,})/i];
const PHONE = [/\b((?:\+?91[- ]?)?[6-9]\d{9})\b/];

/**
 * Hudle notifies by WhatsApp Business message, not by a partner-app push.
 * Captured from Pickle & Pitch Club on 27 Sep 2026:
 *
 *   Hi Pickle And Pitch Club, new booking for your venue. 🎉
 *
 *   Goutham is scheduled to play Cricket Nets (Cricket Bowling Ma...) at
 *   Pickle and Pitch Club | Hinjewadi Phase 2 on Sep 25, 2026
 *   10:00 PM - 10:30 PM.
 *
 *   Booking ID: HUD3785535674
 *
 *   Open the Hudle Partner app for full details.
 *
 * Nearly the same sentence as District's, but the court sits in parentheses
 * after the activity rather than after the venue — and the date is written
 * month-first ("Sep 25, 2026") where District writes it day-first.
 *
 * UNRESOLVED: the captured court reads `Cricket Bowling Ma...` — genuinely
 * truncated. It is not yet known whether Hudle truncates it in the message
 * itself or whether that was WhatsApp shortening it for display. If the
 * message really does carry a truncated label, court mapping for Hudle needs
 * prefix matching rather than exact matching. Worth settling with one more
 * capture, opened rather than screenshotted.
 */
export function notification(raw, refMs) {
  if (!/hudle/i.test(raw)) return null;

  // "<name> is scheduled to play <activity> (<court>) at <venue> | …"
  const courtLabel = first(raw, [/\bto play\s+[^(\n]*\(([^)]+)\)/i]);
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

// No email() export — Hudle's per-booking channel is WhatsApp. Its
// "Email Bookings Report" is a bulk report, a different and uncaptured format.
