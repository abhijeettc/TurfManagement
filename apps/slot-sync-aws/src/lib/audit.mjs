/**
 * Records, in the dashboard's activity log, each time the worker uses a saved
 * login and what it did with it. Logs the ACTION and its context (which
 * ground, slot and booking) — never the login itself.
 *
 * Best effort by design: a failing audit write must not stop a slot being
 * blocked, so errors are swallowed after a console note.
 */
const DASHBOARD_URL = () => (process.env.DASHBOARD_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');

export async function audit(platform, action, { outcome = 'ok', detail = null } = {}) {
  const venueId = process.env.TURFSYNC_VENUE_ID;
  if (!venueId) return;
  try {
    await fetch(`${DASHBOARD_URL()}/internal/credential-activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-token': process.env.WORKER_TOKEN ?? '' },
      body: JSON.stringify({ venueId, platform, action, outcome, detail }),
    });
  } catch (err) {
    console.warn(`[audit] could not record ${platform}/${action}: ${err.message}`);
  }
}
