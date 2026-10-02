import * as playo from './templates/playo.js';
import * as khelomore from './templates/khelomore.js';
import * as hudle from './templates/hudle.js';
import * as district from './templates/district.js';
import * as turfpro from './templates/turfpro.js';
import { fallbackParse, FallbackUnavailable } from './fallback.js';
import { assertParsedBooking } from '@turfsync/core/canonical.js';

const TEMPLATES = [turfpro, playo, khelomore, hudle, district];

export class ParseFailure extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'ParseFailure';
    this.raw = raw;
  }
}

/**
 * Parse one raw payload into the canonical parsed-booking shape.
 *
 * Order matters: templates first (fast, free, deterministic), Claude only when
 * every template declines. A template that matches is always preferred, even
 * when the fallback is available — the fallback exists to keep a venue running
 * through a wording change, not to be the primary parser.
 *
 * @returns {{ parsed, parseStatus, templateVersion }}
 */
export async function parse(raw, { channel = 'notification', platformHint = null, now = Date.now() } = {}) {
  if (!raw || !String(raw).trim()) throw new ParseFailure('empty payload', raw);

  const candidates = platformHint
    ? [TEMPLATES.find((t) => t.platform === platformHint), ...TEMPLATES].filter(Boolean)
    : TEMPLATES;

  for (const template of candidates) {
    const fn = channel === 'email' ? template.email : template.notification;
    if (!fn) continue;
    let hit;
    try {
      hit = fn(raw, now);
    } catch {
      continue; // a template throwing is a template miss, never a request failure
    }
    if (hit) {
      return {
        parsed: assertParsedBooking(hit),
        parseStatus: 'template',
        templateVersion: template.version,
      };
    }
  }

  try {
    const parsed = await fallbackParse(raw, { platformHint, channel });
    return {
      parsed: assertParsedBooking(parsed),
      parseStatus: 'fallback',
      templateVersion: null,
    };
  } catch (error) {
    if (error instanceof FallbackUnavailable) {
      throw new ParseFailure(`no template matched and fallback unavailable (${error.message})`, raw);
    }
    throw new ParseFailure(`no template matched; fallback failed: ${error.message}`, raw);
  }
}

/** Template-only parse. Used by the fixture suite, which must never call out. */
export function parseWithTemplates(raw, { channel = 'notification', now = Date.now() } = {}) {
  for (const template of TEMPLATES) {
    const fn = channel === 'email' ? template.email : template.notification;
    if (!fn) continue;
    let hit;
    try {
      hit = fn(raw, now);
    } catch {
      continue;
    }
    if (hit) return { parsed: assertParsedBooking(hit), templateVersion: template.version };
  }
  return null;
}

export { TEMPLATES };
