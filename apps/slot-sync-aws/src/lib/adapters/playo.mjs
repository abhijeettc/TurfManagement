/**
 * Playo partner-panel adapter.
 *
 * STATUS: no partner panel URL confirmed at all. `docs/partner-outreach/playo.md`
 * found only `playo.co/partner-with-us`, a business-development signup flow,
 * not a slot-management login. Playo's public terms also require "express
 * written consent from TechMash" for automated access — noted here for the
 * record, not enforced by this file (see apps/slot-sync-aws/README.md on why
 * this system doesn't gate on that the way apps/api's does).
 *
 * To make this real: find the actual partner-panel URL (ask Playo support, or
 * inspect network requests from the Playo partner mobile app,
 * com.techmash.playobooking), then follow the same codegen process as
 * hudle.mjs.
 */

const PANEL_URL = null; // unconfirmed — see docs/partner-outreach/playo.md
const CREDENTIALS_SECRET_ID_ENV = 'PLAYO_CREDENTIALS_SECRET_ID';

export const id = 'playo';

function needsCodegen(method) {
  throw Object.assign(
    new Error(
      `playo adapter's "${method}" has no panel URL or recorded selectors yet. ` +
        `Find the real partner-panel URL first (docs/partner-outreach/playo.md), ` +
        `then run "npx playwright codegen <url>" and fill in ${method}() in ` +
        `src/lib/adapters/playo.mjs.`,
    ),
    { code: 'ADAPTER_NEEDS_CODEGEN', platform: 'playo', method },
  );
}

export async function login(page) {
  // TODO(codegen): fetch creds via getSecretJson(process.env[CREDENTIALS_SECRET_ID_ENV]) once PANEL_URL is known.
  needsCodegen('login');
}

export async function isLoggedIn(page) {
  needsCodegen('isLoggedIn');
}

export async function getSlotState(page, slot) {
  needsCodegen('getSlotState');
}

export async function blockSlot(page, slot) {
  needsCodegen('blockSlot');
}

export async function unblockSlot(page, slot) {
  needsCodegen('unblockSlot');
}

export async function healthCheck(page) {
  needsCodegen('healthCheck');
}
