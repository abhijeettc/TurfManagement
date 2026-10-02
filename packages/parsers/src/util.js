// Shared scraping helpers for the platform templates.
//
// Every marketplace writes dates and times slightly differently, and each of
// them changes the wording occasionally without warning. Keep the tolerant
// parsing here, in one place, so a template stays a short readable regex.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * Dates seen in the wild:
 *   "02 Sep 2026"   "2 September 2026"   "Sat, 02 Sep"   "02/09/2026"   "2026-09-02"
 *
 * When the year is missing — and it usually is, because a booking is always
 * within a few weeks — resolve it against `refMs` and pick the nearest
 * occurrence, so a 28 Dec booking read on 2 Jan lands in the right year.
 */
export function parseDateish(raw, refMs = Date.now()) {
  const s = String(raw).trim();

  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = /(\d{1,2})\s*[/-]\s*(\d{1,2})\s*[/-]\s*(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`; // DD/MM/YYYY — Indian order

  // Scan every candidate rather than trusting the first. "Football Court 1
  // booked for 02 Sep" matches "1 booked" before it reaches the real date, and
  // a first-match-wins parser silently drops the booking.
  // The year is optional, and deliberately fussy about what counts as one.
  // A two-digit year must carry its apostrophe — KheloMore writes "27 Sep '26"
  // — because a bare two-digit number after a month is indistinguishable from
  // a time. Playo's "Turf A · Sat, 02 Sep\n07:00 PM" reads as the year 2007
  // the moment you accept bare digits, so the year also has to sit on the
  // same line: [ \t] rather than \s.
  const candidates = [
    ...[...s.matchAll(/(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:[ \t]+('?\d{4}|'\d{2})\b)?/g)].map((x) => [x[1], x[2], x[3]]),
    ...[...s.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?[ \t]+('?\d{4}|'\d{2})\b)?/g)].map((x) => [x[2], x[1], x[3]]),
  ];

  for (const [dayRaw, monthRaw, yearRaw] of candidates) {
    const day = Number(dayRaw);
    const month = MONTHS[monthRaw.slice(0, 4).toLowerCase()] ?? MONTHS[monthRaw.slice(0, 3).toLowerCase()];
    if (!month || day < 1 || day > 31) continue;

    if (yearRaw) {
      const year = yearRaw.startsWith("'") ? 2000 + Number(yearRaw.slice(1)) : Number(yearRaw);
      return `${year}-${pad(month)}-${pad(day)}`;
    }

    // No year, which is the norm — a booking is always within a few weeks, so
    // resolve to the nearest occurrence. 28 Dec read on 2 Jan lands last year.
    const refYear = new Date(refMs).getUTCFullYear();
    let best = null;
    for (const y of [refYear - 1, refYear, refYear + 1]) {
      const ms = Date.UTC(y, month - 1, day);
      if (best === null || Math.abs(ms - refMs) < Math.abs(best.ms - refMs)) best = { ms, y };
    }
    return `${best.y}-${pad(month)}-${pad(day)}`;
  }

  return null;
}

/**
 * Times seen in the wild:
 *   "07:00 PM"   "7 PM"   "19:00"   "7:30pm"
 */
export function parseTimeish(raw) {
  const s = String(raw).trim();

  let m = /(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?/.exec(s);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    return `${pad(h)}:${m[2] ?? '00'}`;
  }

  m = /(\d{1,2}):(\d{2})/.exec(s);
  if (m && Number(m[1]) <= 23) return `${pad(Number(m[1]))}:${m[2]}`;

  return null;
}

/** "Rs. 1,500.00" / "₹1,500" / "INR 1500" -> paise. */
export function parseAmountPaise(raw) {
  if (raw == null) return null;
  const m = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(String(raw));
  const num = m ? m[1] : /^[\d,]+(?:\.\d{1,2})?$/.test(String(raw).trim()) ? String(raw).trim() : null;
  if (num == null) return null;
  const n = Number(num.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Pull the first capture group of the first pattern that matches. */
export function first(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return (m[1] ?? m[0]).trim();
  }
  return null;
}

const RANGE_RE = /(\d{1,2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:[AaPp]\.?[Mm]\.?)?)/g;

/**
 * A "07:00 PM - 08:30 PM" / "19:00 to 20:30" range.
 *
 * Scans every candidate: Hudle writes the date as "02-09-2026", which matches
 * the range shape ("02" to "09") before the real slot appears further along the
 * line. Take the first pair that parses as two actual times.
 */
export function parseTimeRange(text) {
  for (const m of String(text).matchAll(RANGE_RE)) {
    const start = parseTimeish(m[1]);
    const end = parseTimeish(m[2]);
    if (start && end) return { start, end };
  }
  return null;
}

/** Marketplaces cancel with wildly different wording; catch the common shapes. */
export function looksCancelled(text) {
  return /\b(cancel(?:led|lation)?|refund(?:ed)?|booking removed)\b/i.test(text);
}
