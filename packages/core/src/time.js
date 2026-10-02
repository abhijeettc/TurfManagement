// Slot arithmetic.
//
// India Standard Time is a fixed UTC+05:30 with no daylight saving, so all of
// this is integer minute maths on epoch milliseconds — no timezone library, no
// ambiguous or skipped wall-clock times. `venue.timezone` is still stored per
// venue; the day we onboard a venue outside IST, only this file changes.

export const IST_OFFSET_MIN = 330;
const MIN = 60_000;
const DAY_MIN = 1440;

/** 'HH:MM' -> minutes past local midnight. */
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`bad time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`bad time: ${hhmm}`);
  return h * 60 + min;
}

/** Minutes past local midnight -> 'HH:MM', wrapping past 24h. */
export function minutesToHhmm(mins) {
  const m = ((mins % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' -> epoch ms of local midnight in the given offset. */
export function localMidnightUtc(dateStr, offsetMin = IST_OFFSET_MIN) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr).trim());
  if (!m) throw new Error(`bad date: ${dateStr}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offsetMin * MIN;
}

/** epoch ms -> 'YYYY-MM-DD' as read on a local wall clock. */
export function localDateStr(ms, offsetMin = IST_OFFSET_MIN) {
  return new Date(ms + offsetMin * MIN).toISOString().slice(0, 10);
}

/** epoch ms -> 'HH:MM' as read on a local wall clock. */
export function localHhmm(ms, offsetMin = IST_OFFSET_MIN) {
  return new Date(ms + offsetMin * MIN).toISOString().slice(11, 16);
}

export function addDays(dateStr, n) {
  const base = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
  );
  return new Date(base + n * DAY_MIN * MIN).toISOString().slice(0, 10);
}

/**
 * The operating day a slot belongs to. A 01:30 start on Sunday is Saturday
 * night's business, so we shift back by the venue's rollover hour before
 * reading off the date.
 *
 * This is computed here and stored, never as a GENERATED column: `at time zone`
 * is STABLE, not IMMUTABLE, and Postgres rejects it in a generated expression.
 */
export function businessDateOf(startMs, rolloverHour = 6, offsetMin = IST_OFFSET_MIN) {
  return localDateStr(startMs - rolloverHour * 60 * MIN, offsetMin);
}

/**
 * Build an absolute [start, end) instant pair from a business date and two wall
 * clock times.
 *
 * Two things make this the trickiest twenty lines in the codebase:
 *   - A start before the rollover hour belongs to the NEXT calendar day.
 *     Business day 2 Sep, 01:00 start => 3 Sep 01:00 local.
 *   - An end at or before the start crosses midnight, so it lands a day later.
 *     23:30 -> 01:00 is a 90-minute booking, not a negative one.
 */
export function slotFromBusinessDate(businessDate, startHhmm, endHhmm, opts = {}) {
  const { rolloverHour = 6, offsetMin = IST_OFFSET_MIN } = opts;
  const startMin = hhmmToMinutes(startHhmm);
  let endMin = hhmmToMinutes(endHhmm);
  if (endMin <= startMin) endMin += DAY_MIN;

  const calendarDate = startMin < rolloverHour * 60 ? addDays(businessDate, 1) : businessDate;
  const base = localMidnightUtc(calendarDate, offsetMin);

  return { startMs: base + startMin * MIN, endMs: base + endMin * MIN };
}

/**
 * Build a slot from the CALENDAR date of play — which is what every marketplace
 * actually puts in a notification ("Sat, 02 Sep · 11:30 PM - 1:00 AM"). The
 * business date is derived afterwards from the resulting start instant, so a
 * 23:30 start stays on 2 Sep and a 00:30 start rolls back to the night before.
 */
export function slotFromCalendarDate(calendarDate, startHhmm, endHhmm, opts = {}) {
  const { offsetMin = IST_OFFSET_MIN } = opts;
  const startMin = hhmmToMinutes(startHhmm);
  let endMin = hhmmToMinutes(endHhmm);
  if (endMin <= startMin) endMin += DAY_MIN;

  const base = localMidnightUtc(calendarDate, offsetMin);
  return { startMs: base + startMin * MIN, endMs: base + endMin * MIN };
}

/**
 * The same, from an absolute start instant plus a duration — what a parser
 * usually has when a payload carries a real timestamp.
 */
export function slotFromStart(startMs, durationMin) {
  if (!(durationMin > 0)) throw new Error(`bad duration: ${durationMin}`);
  return { startMs, endMs: startMs + durationMin * MIN };
}

/** Postgres tstzrange literal, half-open. */
export function toRange(startMs, endMs) {
  return `[${new Date(startMs).toISOString()},${new Date(endMs).toISOString()})`;
}

/** Parse a tstzrange coming back from Postgres into epoch ms. */
export function fromRange(range) {
  const m = /^\[?"?([^",]+)"?,"?([^",)]+)"?\)?$/.exec(String(range).trim());
  if (!m) throw new Error(`unparseable range: ${range}`);
  return { startMs: Date.parse(m[1]), endMs: Date.parse(m[2]) };
}

export function durationMinutes(startMs, endMs) {
  return Math.round((endMs - startMs) / MIN);
}
