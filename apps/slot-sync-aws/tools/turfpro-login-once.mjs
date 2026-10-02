/**
 * One-time (about weekly) TurfPro owner sign-in done BY A PERSON.
 *
 * TurfPro's owner login is captcha + password + emailed OTP. The slot-sync
 * worker does not try to pass those; instead you sign in here in a visible
 * browser — type the captcha and the OTP yourself — and this saves the
 * resulting session (TurfPro's cookie lasts 7 days) the same way the worker
 * does, so runBlockJob reuses it via loadSession/isLoggedIn.
 *
 * Usage:
 *   npm run local:up
 *   TURFPRO_URL=http://localhost:3000 node tools/turfpro-login-once.mjs
 * Re-run when the worker logs "turfpro login needs a captcha + email OTP".
 */
import { applyLocalEnv } from './localEnv.mjs';
applyLocalEnv();

import { chromium } from 'playwright';
import { CONTEXT_OPTIONS } from '../src/lib/adapters/turfpro.mjs';
import { saveSession } from '../src/lib/session.mjs';

const base = (process.env.TURFPRO_URL || 'http://localhost:3000').replace(/\/+$/, '');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ timezoneId: CONTEXT_OPTIONS.timezoneId, locale: CONTEXT_OPTIONS.locale });
const page = await context.newPage();

try {
  await page.goto(`${base}/admin/login`);
  console.log('Sign in in the browser window: email, password, captcha, then the OTP. Waiting up to 5 minutes…');
  await page.waitForURL((url) => url.pathname.startsWith('/admin') && !/\/admin\/login/i.test(url.pathname), { timeout: 5 * 60_000 });
  await saveSession('turfpro', await context.storageState());
  console.log('Saved the turfpro session. The worker will reuse it until the cookie expires (7 days).');
} finally {
  await browser.close();
}
