/**
 * Hudle partner-panel adapter.
 *
 * STATUS: no selectors recorded yet. `docs/partner-outreach/hudle.md`
 * confirms `partner.hudle.in` isn't even confirmed to be the right panel for
 * this purpose (only a venue-signup page, `hudle.in/list-your-sports-venue`,
 * has been checked) — and nobody here has logged into it and watched a
 * block-slot request happen. The doc's own claim that login needs "no OTP" is
 * marked there as owner-reported, not verified against the real panel.
 *
 * Passive recon (1 Oct 2026, GET only, no login) found two things worth
 * knowing before you start:
 *   - No Cloudflare Bot Management / DataDome / PerimeterX / Akamai headers
 *     or scripts on the shell page — some evidence against enterprise bot
 *     detection, though a server-side check on the actual login POST
 *     wouldn't show up in a passive GET either way.
 *   - partner.hudle.in is a FLUTTER WEB APP (`<title>Hudle Partner App</title>`,
 *     loaded via flutter.js/main.dart.js), not a normal server-rendered page.
 *     Flutter typically paints its whole UI onto a <canvas> with no real DOM
 *     elements, which means page.getByRole()/getByText() below may find
 *     nothing at all, and `playwright codegen` may only be able to record
 *     fragile pixel-coordinate clicks. This is a real feasibility question
 *     independent of ToS/bot-detection — running codegen against it is what
 *     actually answers it; if semantics aren't exposed, look into forcing
 *     Flutter's accessibility/semantics DOM tree (it exists specifically so
 *     screen readers and, incidentally, tools like this can see real
 *     elements instead of canvas pixels) before concluding this can't be
 *     automated reliably.
 *
 * To make this real:
 *   1. npx playwright codegen https://partner.hudle.in
 *   2. Log in, block one slot, unblock it — codegen records every selector
 *      (or shows you immediately whether there's nothing to record).
 *   3. Replace the bodies below with the recorded steps, swapping the
 *      hard-coded court/date/time codegen recorded for the `slot` argument.
 *   4. Prefer page.getByRole(...)/getByText(...) over CSS classes.
 *   5. Call getSlotState before and after every action in blockSlot/unblockSlot.
 */

const PANEL_URL = 'https://partner.hudle.in'; // unconfirmed — see docs/partner-outreach/hudle.md
const CREDENTIALS_SECRET_ID_ENV = 'HUDLE_CREDENTIALS_SECRET_ID';

export const id = 'hudle';

function needsCodegen(method) {
  throw Object.assign(
    new Error(
      `hudle adapter's "${method}" has no recorded selectors yet. Run ` +
        `"npx playwright codegen ${PANEL_URL}" against a real logged-in session, ` +
        `then fill in ${method}() in src/lib/adapters/hudle.mjs.`,
    ),
    { code: 'ADAPTER_NEEDS_CODEGEN', platform: 'hudle', method },
  );
}

export async function login(page) {
  await page.goto(PANEL_URL);
  // TODO(codegen): fetch creds via getSecretJson(process.env[CREDENTIALS_SECRET_ID_ENV])
  // ({ email, password }), then fill the email field, password field, submit button.
  needsCodegen('login');
}

export async function isLoggedIn(page) {
  // TODO(codegen): a selector only visible once authenticated (e.g. the venue-name header).
  needsCodegen('isLoggedIn');
}

export async function getSlotState(page, slot) {
  // TODO(codegen): navigate to the slot grid for slot.date; read the cell for
  // slot.courtName / slot.startTime and map its visual state to 'free' | 'booked' | 'blocked'.
  needsCodegen('getSlotState');
}

export async function blockSlot(page, slot) {
  // TODO(codegen): the "Block" action recorded against a real slot cell.
  needsCodegen('blockSlot');
}

export async function unblockSlot(page, slot) {
  // TODO(codegen): the "Unblock"/"Release" action.
  needsCodegen('unblockSlot');
}

export async function healthCheck(page) {
  await page.goto(PANEL_URL);
  needsCodegen('healthCheck');
}
