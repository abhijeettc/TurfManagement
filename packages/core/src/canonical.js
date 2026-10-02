// The canonical booking. Every source — four marketplaces, two channels each,
// plus counter entry — normalizes to exactly this shape before anything else in
// the system sees it.

export const PLATFORMS = ['playo', 'khelomore', 'hudle', 'district', 'direct', 'turfpro'];
export const SOURCE_CHANNELS = ['notification', 'email', 'worker', 'manual'];

export const PLATFORM_LABELS = {
  playo: 'Playo',
  khelomore: 'KheloMore',
  hudle: 'Hudle',
  district: 'District',
  direct: 'Direct',
  turfpro: 'TurfPro',
};

/** Display key the board UI uses for its platform colours. */
export const PLATFORM_UI_KEY = {
  playo: 'playo',
  khelomore: 'khelo',
  hudle: 'hudle',
  district: 'district',
  direct: 'direct',
  turfpro: 'turfpro',
};

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.statusCode = 400;
  }
}
export { ValidationError };

function req(obj, field) {
  const v = obj[field];
  if (v == null || v === '') throw new ValidationError(`${field} is required`, field);
  return v;
}

/**
 * Validate a parsed payload before it becomes a canonical booking. Deliberately
 * strict: a payload we cannot fully understand goes to the parse-failure log
 * where someone looks at it, rather than into the ledger as a half-row.
 */
export function assertParsedBooking(p) {
  const platform = req(p, 'platform');
  if (!PLATFORMS.includes(platform)) {
    throw new ValidationError(`unknown platform: ${platform}`, 'platform');
  }
  req(p, 'courtLabel');
  req(p, 'date');
  req(p, 'startHhmm');
  req(p, 'endHhmm');

  // `date` is the CALENDAR date of play as the platform stated it. business_date
  // is derived later, from the start instant — never taken from the payload.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) {
    throw new ValidationError(`date must be YYYY-MM-DD, got ${p.date}`, 'date');
  }
  if (p.grossPaise != null && !Number.isInteger(p.grossPaise)) {
    throw new ValidationError('grossPaise must be an integer number of paise', 'grossPaise');
  }
  return p;
}

/** Loose E.164-ish normalisation for Indian mobile numbers. */
export function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

/** What the board shows instead of a full number. */
export function maskPhone(e164) {
  if (!e164) return null;
  const d = e164.replace(/\D/g, '').slice(-10);
  if (d.length < 10) return e164;
  return `+91 ${d.slice(0, 2)}••• ••${d.slice(-3)}`;
}
