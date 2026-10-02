/**
 * TurfPro venue-owner panel adapter — the one live platform for now.
 *
 * Drives the TurfPro admin UI (C:\Users\parth\TurfPro, Next.js) the way an
 * owner would: /admin/login -> /admin/grounds -> the ground's page -> pick the
 * date -> select the slot -> "Block (n)". Selectors come from that app's own
 * source (src/app/admin/login, src/app/admin/grounds/[id]/page.tsx):
 *   - login:  #email, #password, submit button
 *   - ground: link whose text is the ground name
 *   - date:   input[type="date"]
 *   - slot:   <button title="07:00 PM - 08:00 PM (AVAILABLE|BOOKED|BLOCKED|PENDING)">
 *   - action: buttons "Block (n)" / "Unblock (n)"
 *
 * TURFPRO_URL is the panel's base URL. The login is the one the owner saved
 * under Setup → App logins, sealed so only this worker can open it (see
 * credentialVault.mjs); it is opened for each login and never kept.
 *
 * The slot titles are formatted in the BROWSER's timezone, so the browser
 * context must run in Asia/Kolkata (see newTurfproContext) — a Lambda is UTC.
 *
 * TurfPro's bot detector (src/lib/bot-detector.ts) scores headless/webdriver
 * clients and clients with no interaction telemetry. To keep this worker's own
 * traffic from showing up as CRITICAL, the adapter presents a normal desktop
 * Chrome fingerprint (CONTEXT_OPTIONS, LAUNCH_ARGS, looksHuman) and drives the
 * page with human-paced pointer and keyboard input. Browsers must be launched
 * with LAUNCH_ARGS and contexts created with CONTEXT_OPTIONS.
 */
import { getLogin } from '../credentialVault.mjs';

const BASE_URL = () => (process.env.TURFPRO_URL || 'http://turfpro.local').replace(/\/+$/, '');
const TIMEOUT_MS = 15_000;

export const id = 'turfpro';

/** Browser context options this adapter needs (slot titles are in local time). */
export const CONTEXT_OPTIONS = {
  timezoneId: 'Asia/Kolkata',
  locale: 'en-IN',
  // Playwright's default headless UA says "HeadlessChrome", which the detector scores as UA_AUTOMATION.
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 768 },
  extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
};

/** Chromium flag that stops Blink from setting navigator.webdriver; pass to chromium.launch({ args }). */
export const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];

const rand = (min, max) => min + Math.random() * (max - min);
const pause = (page, min = 250, max = 700) => page.waitForTimeout(rand(min, max));

const patchedContexts = new WeakSet();

/** Make the page's client-side fingerprint look like an ordinary desktop Chrome (once per context). */
async function looksHuman(page) {
  const ctx = page.context();
  if (patchedContexts.has(ctx)) return;
  patchedContexts.add(ctx);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
}

/** Wander the pointer and scroll a little so the page records real interaction events. */
async function idleLikeAHuman(page) {
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(rand(100, 1100), rand(100, 600), { steps: Math.round(rand(8, 20)) });
    await pause(page, 120, 350);
  }
  await page.mouse.wheel(0, rand(40, 160));
  await pause(page);
}

/** Click the way a person does: move to the element first, hover, then press. */
async function humanClick(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
  const box = await locator.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * rand(0.3, 0.7), box.y + box.height * rand(0.3, 0.7), { steps: Math.round(rand(10, 25)) });
    await pause(page, 80, 250);
  }
  await locator.click({ timeout: TIMEOUT_MS, delay: rand(40, 120) });
}

/** Type key by key with uneven delays instead of setting the value in one go. */
async function humanType(page, locator, text) {
  await humanClick(page, locator);
  await locator.pressSequentially(text, { delay: rand(55, 140) });
  await pause(page, 200, 500);
}

async function credentials() {
  const { username, password } = await getLogin('turfpro');
  return { email: username, password };
}

const onLoginPage = (page) => /\/admin\/login/i.test(new URL(page.url()).pathname);

export async function isLoggedIn(page) {
  await looksHuman(page);
  await page.goto(`${BASE_URL()}/admin`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  // An unauthenticated visit is bounced to the login page (possibly after a
  // client-side redirect), so give that a moment before deciding.
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
  return !onLoginPage(page) && /\/admin/i.test(new URL(page.url()).pathname);
}

export async function login(page) {
  const { email, password } = await credentials();
  await looksHuman(page);
  await page.goto(`${BASE_URL()}/admin/login`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  // The owner login is captcha + password + emailed OTP. Those exist to prove a
  // person is signing in, so the worker does not try to pass them: a human signs
  // in once (tools/turfpro-login-once.mjs) and the worker reuses that session.
  if (await page.locator('#captcha-answer').isVisible().catch(() => false)) {
    throw new Error('turfpro login needs a captcha + email OTP — run `node tools/turfpro-login-once.mjs` to sign in by hand and refresh the saved session');
  }
  await pause(page, 1500, 2800); // the detector flags submits within ~1.2s of page load
  await idleLikeAHuman(page);
  await humanType(page, page.locator('#email'), email);
  await humanType(page, page.locator('#password'), password);
  await humanClick(page, page.locator('button[type="submit"]'));
  await page.waitForURL((url) => !/\/admin\/login/i.test(url.pathname), { timeout: TIMEOUT_MS }).catch(() => {});
  if (onLoginPage(page)) {
    const msg = (await page.locator('[role="alert"], .text-destructive, [data-state="open"]').first().innerText().catch(() => '')) || 'no error shown';
    throw new Error(`turfpro login did not leave /admin/login (${msg.trim().slice(0, 120)}) — wrong credentials or the bot detector rejected this client`);
  }
}

/** '19:00' -> '07:00 PM' (dayjs 'hh:mm A', as the panel renders it). */
function panelTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

async function openSlotGrid(page, slot) {
  await page.goto(`${BASE_URL()}/admin/grounds`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  const groundLink = page.getByRole('link', { name: slot.courtName, exact: true }).first();
  await groundLink.waitFor({ state: 'visible', timeout: TIMEOUT_MS }).catch(() => {
    throw new Error(`no ground named "${slot.courtName}" on /admin/grounds — check the court mapping`);
  });
  await idleLikeAHuman(page);
  await humanClick(page, groundLink);
  await page.getByText('Slot Management').waitFor({ timeout: TIMEOUT_MS });
  await pause(page, 600, 1400);

  const dateInput = page.locator('input[type="date"]').first(); // the day picker; later ones are the range form
  await dateInput.fill(slot.date, { timeout: TIMEOUT_MS });
  // Either slot buttons or the empty-state text appear once the day has loaded.
  await page
    .locator('button[title*="("], :text("No slots available for this date.")')
    .first()
    .waitFor({ timeout: TIMEOUT_MS });
}

function slotButton(page, slot) {
  const range = `${panelTime(slot.startTime)} - ${panelTime(slot.endTime)}`;
  return page.locator(`button[title^="${range} ("]`).first();
}

async function stateOf(button) {
  const title = (await button.getAttribute('title')) ?? '';
  const status = /\((\w+)/.exec(title)?.[1];
  if (status === 'BLOCKED') return 'blocked';
  if (status === 'AVAILABLE') return 'free';
  return 'booked'; // BOOKED, PENDING (payment in flight) — never touch
}

/** The slot button's title carries its status; wait for the panel to reflect the change. */
async function waitForStatus(page, slot, status) {
  const range = `${panelTime(slot.startTime)} - ${panelTime(slot.endTime)}`;
  await page.locator(`button[title^="${range} (${status}"]`).first().waitFor({ timeout: TIMEOUT_MS });
}

export async function getSlotState(page, slot) {
  await openSlotGrid(page, slot);
  const button = slotButton(page, slot);
  if (!(await button.count())) {
    throw new Error(`no slot ${slot.startTime}-${slot.endTime} on ${slot.date} for "${slot.courtName}" (outside operating hours, or the day has no slots)`);
  }
  return stateOf(button);
}

export async function blockSlot(page, slot) {
  // getSlotState left the grid open on the right ground and date.
  const button = slotButton(page, slot);
  const state = await stateOf(button);
  if (state === 'blocked') return; // idempotent
  if (state === 'booked') throw new Error('slot is booked or pending in TurfPro — refusing to block');

  await humanClick(page, button);
  await pause(page);
  await page.getByLabel('Block reason').fill('TurfSync: booked on another platform').catch(() => {});
  await humanClick(page, page.getByRole('button', { name: /^Block \(\d+\)$/ }));
  await waitForStatus(page, slot, 'BLOCKED');
}

export async function unblockSlot(page, slot) {
  await openSlotGrid(page, slot);
  const button = slotButton(page, slot);
  if ((await stateOf(button)) !== 'blocked') return;
  await humanClick(page, button);
  await pause(page);
  await humanClick(page, page.getByRole('button', { name: /^Unblock \(\d+\)$/ }));
  await waitForStatus(page, slot, 'AVAILABLE');
}

export async function healthCheck(page) {
  if (!(await isLoggedIn(page))) await login(page);
  await page.goto(`${BASE_URL()}/admin/grounds`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.locator('a[href^="/admin/grounds/"]').first().waitFor({ timeout: TIMEOUT_MS });
}
