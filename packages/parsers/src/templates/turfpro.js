import { parseDateish, parseTimeRange, parseAmountPaise, first, looksCancelled } from '../util.js';

export const platform = 'turfpro';
export const version = 'turfpro/whatsapp-2026-10-02';

const PHONE = [/\b((?:\+?91[- ]?)?[6-9]\d{9})\b/];

/**
 * TurfPro booking alert, as a WhatsApp message to the venue owner. Same layout
 * as the other WhatsApp Business alerts (labelled lines), branded TurfPro:
 *
 *   TurfPro
 *   New Booking Alert
 *   A new booking has been received at <venue>.
 *   👤 Customer: <name>
 *   📅 Game Day: 17 Oct '26
 *   ⏰ Slot: 07:00 PM - 08:00 PM
 *   🏓 Property: <ground name>
 *   💰 Amount Paid: 637.0
 *   Team TurfPro
 *
 * Invented from the requested test template, not captured from a real TurfPro
 * message — treat the format as unconfirmed until one is.
 */
export function notification(raw, refMs) {
  if (!/turfpro/i.test(raw)) return null;

  // Read each field from its own labelled line rather than scanning the whole
  // message — the venue name and the shortlink both contain digits that a
  // whole-message scan could mistake for a date or a time.
  const range = parseTimeRange(first(raw, [/\bSlot[:\s]*(.+)$/im]) ?? '');
  const date = parseDateish(first(raw, [/\bGame Day[:\s]*(.+)$/im]) ?? '', refMs);
  const courtLabel = first(raw, [/\bProperty[:\s]*(.+)$/im]);
  if (!range || !date || !courtLabel) return null;

  return {
    platform,
    externalBookingId: null,
    courtLabel,
    date,
    startHhmm: range.start,
    endHhmm: range.end,
    customerName: first(raw, [/\bCustomer[:\s]*(.+)$/im]),
    customerPhone: first(raw, PHONE),
    grossPaise: parseAmountPaise(first(raw, [/\bAmount Paid[:\s]*(.+)$/im])),
    commissionPaise: null,
    cancelled: looksCancelled(raw),
  };
}

// No email() export. TurfPro's per-booking channel is WhatsApp; we have
// never seen a TurfPro booking email, and guessing at one is what produced
// the fiction this file replaced.
