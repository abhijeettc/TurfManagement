// Money is paise. Always an integer, never a float, never a string that has
// been through a locale round-trip. Rupees exist only at the edges: parsing in,
// formatting out.

export function rupeesToPaise(rupees) {
  if (rupees == null) return null;
  const n = typeof rupees === 'string' ? Number(rupees.replace(/[^\d.]/g, '')) : Number(rupees);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function paiseToRupees(paise) {
  return paise == null ? null : paise / 100;
}

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 150000 -> "₹1,500" (Indian digit grouping). */
export function formatINR(paise) {
  if (paise == null) return '—';
  const sign = paise < 0 ? '−' : '';
  return `${sign}₹${INR.format(Math.round(Math.abs(paise) / 100))}`;
}

/** Lakh-scale figures for the summary tiles: 1240000_00 -> "₹12.4L". */
export function formatINRCompact(paise) {
  if (paise == null) return '—';
  const sign = paise < 0 ? '−' : '';
  const rupees = Math.abs(paise) / 100;
  if (rupees >= 10_000_000) return `${sign}₹${(rupees / 10_000_000).toFixed(2)}Cr`;
  if (rupees >= 100_000) return `${sign}₹${(rupees / 100_000).toFixed(1)}L`;
  return `${sign}₹${INR.format(Math.round(rupees))}`;
}

/**
 * Commission in basis points, so a negotiated 14.5% is expressible without
 * floats leaking into the ledger. Rounds half-up to the paise.
 */
export function commissionPaise(grossPaise, bps) {
  if (grossPaise == null || !bps) return 0;
  return Math.round((grossPaise * bps) / 10_000);
}

export function bpsToPercentLabel(bps) {
  if (!bps) return '—';
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}
