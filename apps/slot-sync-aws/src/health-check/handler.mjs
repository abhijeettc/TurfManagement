import { chromium } from 'playwright';
import { getAdapter } from '../lib/adapters/registry.mjs';
import { sendAlert } from '../lib/alerts.mjs';
import { CONTEXT_OPTIONS, LAUNCH_ARGS } from '../lib/adapters/turfpro.mjs';

/** EventBridge-triggered, daily 06:00 IST. Login + open the slot grid, nothing more. */
export async function handler() {
  const enabledPlatforms = (process.env.ENABLED_PLATFORMS ?? '').split(',').filter(Boolean);
  const alertPhone = process.env.ALERT_PHONE;

  const results = {};
  for (const platform of enabledPlatforms) {
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--single-process', '--disable-dev-shm-usage', ...LAUNCH_ARGS],
    });
    try {
      const adapter = getAdapter(platform);
      const page = await (await browser.newContext(CONTEXT_OPTIONS)).newPage();
      await adapter.healthCheck(page);
      results[platform] = 'ok';
    } catch (err) {
      results[platform] = `error: ${err.message}`;
      await sendAlert(alertPhone, 'health_check_failed', { platform, error: err.message });
    } finally {
      await browser.close();
    }
  }
  return results;
}
