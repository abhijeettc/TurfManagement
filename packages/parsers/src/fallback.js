// Template-miss fallback.
//
// Marketplaces reword their notifications without warning. When no template
// matches we hand the raw text to Claude rather than dropping the booking — and
// every fallback extraction is logged so it can be promoted into a real
// template. Haiku, per the product doc: this runs on a few payloads a day per
// venue and the unit economics have to survive it.
//
// Schema enforcement is a strict tool, not a "reply with JSON" prompt. A tool
// call whose arguments validate is either a complete booking or an error — it is
// never a plausible-looking half-row that quietly poisons the ledger.

import { PLATFORMS } from '@turfsync/core/canonical.js';
import { rupeesToPaise } from '@turfsync/core/money.js';

const MODEL = process.env.PARSER_FALLBACK_MODEL || 'claude-haiku-4-5';

const RECORD_BOOKING = {
  name: 'record_booking',
  description:
    'Record the single booking described by the message. Call this exactly once. ' +
    'Use null for any field the message does not state — never guess a value.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      platform: {
        type: 'string',
        enum: PLATFORMS,
        description: 'Which marketplace sent this message.',
      },
      external_booking_id: {
        type: ['string', 'null'],
        description: "The platform's own booking or order reference, e.g. PLY-4471902.",
      },
      court_label: {
        type: 'string',
        description:
          "The court or ground name exactly as the platform writes it, e.g. 'Turf A', 'Ground 1'. Do not normalise it.",
      },
      date: {
        type: 'string',
        description:
          'Calendar date of play as YYYY-MM-DD. This is the date the slot STARTS on, even if it runs past midnight.',
      },
      start_time: { type: 'string', description: 'Slot start as HH:MM, 24-hour.' },
      end_time: {
        type: 'string',
        description: 'Slot end as HH:MM, 24-hour. For a slot ending after midnight use the clock time, e.g. 01:00.',
      },
      customer_name: { type: ['string', 'null'] },
      customer_phone: { type: ['string', 'null'], description: 'Digits as written.' },
      gross_rupees: {
        type: ['number', 'null'],
        description: 'Total the customer paid, in rupees. Null if the message does not state an amount.',
      },
      commission_rupees: {
        type: ['number', 'null'],
        description: "The platform's commission or fee, in rupees. Null if not stated.",
      },
      cancelled: {
        type: 'boolean',
        description: 'True if this message reports a cancellation or refund rather than a new booking.',
      },
    },
    required: [
      'platform',
      'external_booking_id',
      'court_label',
      'date',
      'start_time',
      'end_time',
      'customer_name',
      'customer_phone',
      'gross_rupees',
      'commission_rupees',
      'cancelled',
    ],
  },
};

const SYSTEM = [
  'You read booking notifications and confirmation emails from Indian sports-turf',
  'marketplaces (Playo, KheloMore, Hudle, District) and extract the booking.',
  '',
  'Rules:',
  '- Times are India Standard Time. Convert 12-hour clock times to 24-hour.',
  '- A slot may cross midnight (23:30 to 01:00). Report end_time as the clock time,',
  '  and keep date as the day the slot STARTS.',
  '- Report the court label verbatim. Mapping it to a physical pitch happens later.',
  '- If the message does not state something, use null. A missing amount is normal',
  '  in a push notification and must not be invented.',
].join('\n');

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk').then((m) => new m.default());
  }
  return clientPromise;
}

export class FallbackUnavailable extends Error {}

/**
 * @returns a parsed-booking object in the same shape the templates produce,
 *          or throws. Never returns a partially-populated guess.
 */
export async function fallbackParse(raw, { platformHint, channel } = {}) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new FallbackUnavailable('no Anthropic credentials configured');
  }

  const Anthropic = await import('@anthropic-ai/sdk');
  const client = await getClient();

  const hint = platformHint ? `\n\nThis arrived from the ${platformHint} ${channel || 'message'}.` : '';

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: [RECORD_BOOKING],
      tool_choice: { type: 'tool', name: 'record_booking' },
      messages: [{ role: 'user', content: `${raw}${hint}` }],
    });
  } catch (error) {
    if (error instanceof Anthropic.default.RateLimitError) {
      throw new Error('fallback parser rate limited — payload kept for retry');
    }
    if (error instanceof Anthropic.default.AuthenticationError) {
      throw new FallbackUnavailable('Anthropic credentials rejected');
    }
    if (error instanceof Anthropic.default.APIError) {
      throw new Error(`fallback parser API error ${error.status}: ${error.message}`);
    }
    throw error;
  }

  const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'record_booking');
  if (!call) throw new Error('fallback parser returned no booking');

  const a = call.input;
  return {
    platform: a.platform,
    externalBookingId: a.external_booking_id || null,
    courtLabel: a.court_label,
    date: a.date,
    startHhmm: a.start_time,
    endHhmm: a.end_time,
    customerName: a.customer_name || null,
    customerPhone: a.customer_phone || null,
    grossPaise: rupeesToPaise(a.gross_rupees),
    commissionPaise: rupeesToPaise(a.commission_rupees),
    cancelled: Boolean(a.cancelled),
  };
}
