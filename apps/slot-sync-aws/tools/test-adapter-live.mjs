/**
 * Runs ONE real platform adapter — not MockAdapter — against the real
 * internet, from your own machine, with a visible (non-headless) browser so
 * you can watch every step. This is the codegen/verification tool
 * docs/enable-live-blocking.md §3 refers to as "write a one-off script if
 * you want this scripted."
 *
 * AWS-side calls (fetching credentials, saving the session) still go to
 * LocalStack, not real AWS — no need to deploy anything just to test one
 * adapter. The browser itself necessarily hits the real platform; there's no
 * way around that when the whole point is testing real automation.
 *
 * Usage:
 *   npm run local:up                                              # once
 *   node tools/set-local-secret.mjs turfsync/local/hudle '{"email":"...","password":"..."}'
 *   node tools/test-adapter-live.mjs hudle "Football Court 1" 2026-10-15 19:00 20:00
 *
 * Runs isLoggedIn -> login (if needed) -> getSlotState. Pass --block to also
 * block the slot, re-check state, then unblock it and re-check again — only
 * do this against a slot you know is genuinely free and have told the owner
 * you're testing, since blockSlot is a real write to their real calendar.
 */
import { applyLocalEnv } from './localEnv.mjs';
applyLocalEnv();

import { chromium } from 'playwright';
import { getAdapter } from '../src/lib/adapters/registry.mjs';

const [, , platform, courtName, date, startTime, endTime, ...rest] = process.argv;
const shouldBlock = rest.includes('--block');

if (!platform || !courtName || !date || !startTime || !endTime) {
  console.error('Usage: node tools/test-adapter-live.mjs <platform> "<courtName>" <date> <startTime> <endTime> [--block]');
  console.error('Example: node tools/test-adapter-live.mjs hudle "Football Court 1" 2026-10-15 19:00 20:00');
  process.exit(1);
}

const slot = { courtName, date, startTime, endTime };
const adapter = getAdapter(platform, { mock: false });

console.log(`Testing the REAL "${platform}" adapter against slot:`, slot);
console.log(shouldBlock ? '(will block, verify, then unblock)' : '(read-only — pass --block to actually block/unblock)');

const browser = await chromium.launch({ headless: false, slowMo: 250 });
const page = await (await browser.newContext({ timezoneId: 'Asia/Kolkata', locale: 'en-IN' })).newPage();

try {
  console.log('\n-- isLoggedIn --');
  const loggedIn = await adapter.isLoggedIn(page);
  console.log(loggedIn);

  if (!loggedIn) {
    console.log('\n-- login --');
    await adapter.login(page);
    console.log('done');
  }

  console.log('\n-- getSlotState --');
  const state = await adapter.getSlotState(page, slot);
  console.log(state);

  if (shouldBlock) {
    console.log('\n-- blockSlot --');
    await adapter.blockSlot(page, slot);
    const afterBlock = await adapter.getSlotState(page, slot);
    console.log(`getSlotState after block: ${afterBlock}`, afterBlock === 'blocked' ? '✓' : '✗ did not verify');

    console.log('\n-- unblockSlot --');
    await adapter.unblockSlot(page, slot);
    const afterUnblock = await adapter.getSlotState(page, slot);
    console.log(`getSlotState after unblock: ${afterUnblock}`, afterUnblock === 'free' ? '✓' : '✗ did not verify');
  }

  console.log('\nDone. Browser stays open for you to inspect — close it manually when ready.');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (err.code === 'ADAPTER_NEEDS_CODEGEN') {
    console.error(`This adapter's "${err.method}" hasn't been filled in yet — see src/lib/adapters/${platform}.mjs.`);
  }
  console.log('Browser stays open so you can see the state it was in when this failed.');
  process.exitCode = 1;
}
