import { getAdapter } from './adapters/registry.mjs';
import { expectEcho } from './echoExpectations.mjs';
import { saveSession, loadSession, saveProofScreenshot } from './session.mjs';
import { sendAlert } from './alerts.mjs';
import { audit } from './audit.mjs';

/**
 * The doc's "Slot state on the target platform" table, executed for real.
 * Mirrors the ORDERING apps/api/src/blocking/worker.js established —
 * write the echo expectation before the action that will trigger a real
 * platform notification, verify by re-reading the slot rather than trusting
 * the write succeeded — but this system performs the block itself instead of
 * handing a human a task.
 */
export async function runBlockJob({ page, venueSlug, platform, slot, eventKey, alertTo }) {
  const adapter = getAdapter(platform);
  const where = `${slot.courtName} · ${slot.date} ${slot.startTime}-${slot.endTime}`;
  const why = `for booking ${eventKey}`;

  const session = await loadSession(platform);
  if (session) await page.context().addCookies(session.cookies ?? []);
  if (await adapter.isLoggedIn(page)) {
    await audit(platform, 'session_reused', { detail: `Reused the saved browser session ${why}` });
  } else {
    await audit(platform, 'login_attempt', { detail: `Signing in ${why}` });
    try {
      await adapter.login(page);
    } catch (err) {
      await audit(platform, 'login_failed', { outcome: 'failed', detail: err.message });
      throw err;
    }
    await audit(platform, 'login_ok', { detail: 'Signed in' });
    const storageState = await page.context().storageState();
    await saveSession(platform, storageState);
  }

  const state = await adapter.getSlotState(page, slot);
  await audit(platform, 'read_slots', { detail: `Read ${where}: ${state} ${why}` });
  const slotLabel = `${slot.startTime}-${slot.endTime}`;

  if (state === 'blocked') {
    return { outcome: 'skipped_already_blocked' };
  }

  if (state === 'booked') {
    await sendAlert(alertTo, 'already_booked', { court: slot.courtName, slot: slotLabel, platforms: [platform] });
    return { outcome: 'already_booked' };
  }

  // state === 'free' — write the echo expectation BEFORE the action that will
  // trigger it, per finding 1's ordering.
  await expectEcho({
    venueSlug,
    platform,
    externalCourtId: slot.courtName,
    startMs: Date.parse(`${slot.date}T${slot.startTime}:00+05:30`),
    endMs: Date.parse(`${slot.date}T${slot.endTime}:00+05:30`),
  });

  try {
    await adapter.blockSlot(page, slot);
  } catch (err) {
    await audit(platform, 'block_slot', { outcome: 'failed', detail: `${where}: ${err.message}` });
    throw err;
  }

  const verified = (await adapter.getSlotState(page, slot)) === 'blocked';
  await audit(platform, 'block_slot', {
    outcome: verified ? 'ok' : 'failed',
    detail: `Blocked ${where} ${why}` + (verified ? ' (verified)' : ' — did not verify'),
  });
  if (!verified) {
    throw new Error(`blockSlot on ${platform} did not verify — the slot grid still does not show it blocked`);
  }

  const screenshot = await page.screenshot();
  await saveProofScreenshot(eventKey, platform, screenshot);

  return { outcome: 'blocked' };
}
