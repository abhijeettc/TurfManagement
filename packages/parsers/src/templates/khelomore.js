import { parseDateish, parseTimeRange, parseAmountPaise, first, looksCancelled } from '../util.js';

export const platform = 'khelomore';
export const version = 'khelomore/whatsapp-2026-09-27';

const PHONE = [/\b((?:\+?91[- ]?)?[6-9]\d{9})\b/];

/**
 * KheloMore does not fire a partner-app push. It sends the owner a WhatsApp
 * Business message, which the Android listener sees under `com.whatsapp` with
 * the sender name as the title. Captured from Pickle & Pitch Club on
 * 27 Sep 2026:
 *
 *   New Booking Alert
 *   A new booking has been received at Pickle And Pitch Club.
 *   👤 Customer: Harsh
 *   📅 Game Day: 27 Sep '26
 *   ⏰ Slot: 07:00 PM - 08:00 PM
 *   🏓 Property: Synthetic Ball
 *   💰 Amount Paid: 637.0
 *   Review booking details here: http://rml.fm/tG1xgp. Prepare accordingly!
 *   Team KheloMore
 *
 * Two things about this format matter downstream:
 *
 *   - There is NO booking reference. The shortlink code is not one, and
 *     nothing else in the message identifies the booking. So the dedupe key
 *     falls back to the slot hash plus rebook_seq for every KheloMore
 *     booking — the exact path finding 2 exists for, on a real platform.
 *
 *   - It is the only one of the three WhatsApp platforms that states the
 *     amount, and it states it bare ("637.0"), with no ₹ or Rs. marker.
 */
export function notification(raw, refMs) {
  // Not just /khelomore/i: see turfpro.js's notification() for why a bare
  // keyword anywhere in the body is not safe between these two templates
  // specifically — their layouts are otherwise identical. The signature
  // line is the actual distinguishing feature.
  if (!/^Team KheloMore\s*$/im.test(raw)) return null;

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

// No email() export. KheloMore's per-booking channel is WhatsApp; we have
// never seen a KheloMore booking email, and guessing at one is what produced
// the fiction this file replaced.
