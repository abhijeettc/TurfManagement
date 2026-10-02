import { pool } from '@turfsync/db';
import { resolveVenue } from '../venue.js';
import {
  fromRange, formatINR, formatINRCompact, bpsToPercentLabel,
  PLATFORM_LABELS, PLATFORM_UI_KEY,
} from '@turfsync/core';

const AXIS_START_HOUR = 16;
const AXIS_HOURS = 10; // 16:00 → 02:00, the traded window

export default async function moneyRoutes(app) {
  app.get('/api/money', async (request) => {
    const { venue } = await resolveVenue(request, 'money:read');
    // Default to the last complete month. Payout cycles close on a period, and
    // reconciliation is about periods that have closed — a half-finished month
    // has nothing to reconcile against.
    const month = request.query.month || previousMonth();
    const from = `${month}-01`;
    const to = nextMonth(month);

    const [byPlatform, accounts, settlements, partners, courts, slots] = await Promise.all([
      pool.query(
        `select platform,
                count(*)::int                       as bookings,
                coalesce(sum(gross_paise),0)        as gross,
                coalesce(sum(commission_paise),0)   as commission,
                coalesce(sum(net_paise),0)          as net
           from bookings
          where venue_id = $1 and status = 'confirmed'
            and business_date >= $2 and business_date < $3
          group by platform order by platform`,
        [venue.id, from, to],
      ),
      pool.query(
        `select platform, commission_bps, payout_cycle from platform_accounts where venue_id = $1`,
        [venue.id],
      ),
      pool.query(
        `select platform, expected_paise, received_paise, received_at, period_end
           from settlements
          where venue_id = $1 and period_start >= $2 and period_start < $3`,
        [venue.id, from, to],
      ),
      pool.query(`select * from partners where venue_id = $1 order by share_value desc`, [venue.id]),
      pool.query(`select count(*)::int as n from courts where venue_id = $1`, [venue.id]),
      pool.query(
        `select slot, business_date from bookings
          where venue_id = $1 and status = 'confirmed'
            and business_date >= $2 and business_date < $3`,
        [venue.id, from, to],
      ),
    ]);

    const acc = new Map(accounts.rows.map((a) => [a.platform, a]));
    const settle = new Map(settlements.rows.map((s) => [s.platform, s]));

    let gross = 0, commission = 0, net = 0, bookings = 0, awaiting = 0, variance = 0;

    const rows = byPlatform.rows.map((r) => {
      gross += r.gross; commission += r.commission; net += r.net; bookings += r.bookings;
      const s = settle.get(r.platform);
      const a = acc.get(r.platform);

      let status = { kind: 'idle', label: 'Collected at counter' };
      if (r.platform !== 'direct') {
        if (!s || s.received_paise == null) {
          awaiting += r.net;
          const due = s ? daysUntil(s.period_end) : null;
          status = {
            kind: due != null && due < 0 ? 'crit' : 'warn',
            label:
              due == null ? `Awaiting · ${formatINR(r.net)}`
              : due < 0 ? `Overdue ${-due}d · ${formatINR(r.net)}`
              : `Due ${due} day${due === 1 ? '' : 's'} · ${formatINR(r.net)}`,
          };
        } else if (s.received_paise < s.expected_paise) {
          const short = s.expected_paise - s.received_paise;
          variance -= short;
          status = { kind: 'crit', label: `Short by ${formatINR(short)}` };
        } else {
          status = { kind: 'ok', label: 'Received · on time' };
        }
      }

      return {
        platform: r.platform,
        label: r.platform === 'direct' ? 'Direct · cash & UPI' : PLATFORM_LABELS[r.platform],
        uiKey: PLATFORM_UI_KEY[r.platform],
        bookings: r.bookings,
        grossLabel: formatINR(r.gross),
        rateLabel: r.platform === 'direct' ? '—' : bpsToPercentLabel(a?.commission_bps ?? 0),
        commissionLabel: formatINR(r.commission),
        netLabel: formatINR(r.net),
        payoutCycle: a?.payout_cycle ?? 'Immediate',
        status,
      };
    });

    // Occupancy by hour of the traded window, computed from the slots
    // themselves so a 90-minute booking contributes to both hours it touches.
    const days = new Set(slots.rows.map((s) => s.business_date)).size || 1;
    const courtCount = courts.rows[0].n || 1;
    const buckets = new Array(AXIS_HOURS).fill(0);

    for (const s of slots.rows) {
      const { startMs, endMs } = fromRange(s.slot);
      const dayStart = Date.parse(`${s.business_date}T00:00:00.000Z`) - 330 * 60_000;
      let from_ = Math.round((startMs - dayStart) / 60_000);
      let to_ = Math.round((endMs - dayStart) / 60_000);
      if (from_ < 6 * 60) { from_ += 1440; to_ += 1440; }
      for (let h = 0; h < AXIS_HOURS; h += 1) {
        const hourStart = (AXIS_START_HOUR + h) * 60;
        const overlap = Math.min(to_, hourStart + 60) - Math.max(from_, hourStart);
        if (overlap > 0) buckets[h] += overlap;
      }
    }

    const capacityPerHour = days * courtCount * 60;
    const occupancy = buckets.map((mins, h) => ({
      hour: (AXIS_START_HOUR + h) % 24,
      hourLabel: String((AXIS_START_HOUR + h) % 24).padStart(2, '0'),
      pct: Math.min(100, Math.round((mins / capacityPerHour) * 100)),
    }));
    const peak = Math.max(...occupancy.map((o) => o.pct));

    return {
      month,
      tiles: {
        grossLabel: formatINRCompact(gross),
        bookings,
        commissionLabel: formatINRCompact(commission),
        blendedRateLabel: gross ? `${((commission / gross) * 100).toFixed(1)}% blended` : '—',
        netLabel: formatINRCompact(net),
        awaitingLabel: formatINRCompact(awaiting),
        openCycles: rows.filter((r) => r.status.kind === 'warn').length,
        varianceLabel: variance ? formatINR(variance) : '₹0',
      },
      rows,
      totals: {
        bookings,
        grossLabel: formatINR(gross),
        rateLabel: gross ? `${((commission / gross) * 100).toFixed(1)}%` : '—',
        commissionLabel: formatINR(commission),
        netLabel: formatINR(net),
      },
      occupancy: occupancy.map((o) => ({ ...o, peak: o.pct === peak })),
      partners: partners.rows.map((p) => ({
        name: p.name,
        role: p.role,
        shareLabel: p.share_type === 'percentage' ? `${Number(p.share_value)}%${p.role ? ` · ${p.role}` : ''}` : formatINR(p.share_value * 100),
        amountLabel: formatINR(Math.round((net * Number(p.share_value)) / 100)),
      })),
    };
  });
}

function previousMonth() {
  const now = new Date(Date.now() + 330 * 60_000); // IST
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based, so this is already "last month" 1-based
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Signed: negative means the payout window has already closed unpaid. */
function daysUntil(date) {
  if (!date) return null;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.now()) / 86_400_000);
}
