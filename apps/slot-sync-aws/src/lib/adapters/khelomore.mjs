/**
 * KheloMore partner-panel adapter.
 *
 * STATUS: no partner panel URL confirmed. `docs/partner-outreach/khelomore.md`
 * found `khelomore.com/partnerships`, which targets coaching/tournament/event
 * partners, not venue slot management, and its terms page could not even be
 * retrieved (JS-rendered) to check for an automation clause. The partner app
 * package (`com.khelomore.pnp.vendor`, from `apps/android-spike`'s
 * PlatformApps.kt) is the best lead for finding the real panel — inspect its
 * network traffic to find what web login (if any) backs it.
 */

const PANEL_URL = null; // unconfirmed — see docs/partner-outreach/khelomore.md
const CREDENTIALS_SECRET_ID_ENV = 'KHELOMORE_CREDENTIALS_SECRET_ID';

export const id = 'khelomore';

function needsCodegen(method) {
  throw Object.assign(
    new Error(
      `khelomore adapter's "${method}" has no panel URL or recorded selectors yet. ` +
        `Find the real partner-panel URL first (docs/partner-outreach/khelomore.md), ` +
        `then run "npx playwright codegen <url>" and fill in ${method}() in ` +
        `src/lib/adapters/khelomore.mjs.`,
    ),
    { code: 'ADAPTER_NEEDS_CODEGEN', platform: 'khelomore', method },
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
