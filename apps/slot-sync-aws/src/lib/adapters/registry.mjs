import * as turfpro from './turfpro.mjs';
import { MockAdapter } from './mock.mjs';

// TurfPro is the only block TARGET for now. hudle.mjs / playo.mjs /
// khelomore.mjs stay in the repo untouched but are deliberately not
// registered, so no job can drive those platforms: a queued job for one fails
// with ADAPTER_UNKNOWN. Their WhatsApp messages are still READ (parsers) as
// booking sources. Re-enable by importing and adding them here.
const ADAPTERS = { turfpro };

/**
 * @param {string} platform
 * @param {{mock?: boolean}} [opts]
 * @returns {import('./types.mjs').PlatformAdapter}
 */
export function getAdapter(platform, { mock = process.env.ADAPTER_MOCK === '1' } = {}) {
  if (mock) return new MockAdapter(platform);

  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw Object.assign(new Error(`no adapter registered for "${platform}"`), {
      code: 'ADAPTER_UNKNOWN',
      platform,
    });
  }
  return adapter;
}
