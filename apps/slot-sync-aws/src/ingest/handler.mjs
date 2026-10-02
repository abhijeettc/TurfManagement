import { getSecretJson } from '../lib/secrets.mjs';
import { ingestPayload } from '../lib/ingestCore.mjs';

/**
 * Lambda Function URL handler for BOTH paths the existing Android spike app
 * already calls — a Function URL has no built-in router, so this dispatches
 * on the request path itself, matching apps/api/src/routes/ingest.js exactly:
 *
 *   POST /ingest/notification  { items: [{text, platform?, postedAt}, ...] }
 *   POST /devices/heartbeat    { label, batteryPct, notificationAccess, queuedOffline }
 *
 * Matching this contract means pointing the tablet's DeviceConfig.apiUrl at
 * this Lambda's Function URL instead of the Fastify app needs zero app-code
 * changes. The app only checks the HTTP status code (200-299), never the
 * response body, so the JSON shapes returned here don't need to match
 * byte-for-byte — only the paths, the auth header, and 2xx-on-success do.
 */
export async function handler(event) {
  const authed = await checkDeviceToken(event.headers ?? {});
  if (!authed) return respond(401, { error: 'invalid device token' });

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'invalid JSON body' });
  }

  const path = event.rawPath ?? event.requestContext?.http?.path ?? '';

  if (path.endsWith('/devices/heartbeat')) {
    return handleHeartbeat();
  }
  return handleNotificationBatch(body);
}

async function handleNotificationBatch(body) {
  // Same shape the Android listener actually posts (NotificationListener.kt's
  // postBatch): {"items": [{"text": "...", "postedAt": "..."}, ...]}. A
  // single unreadable item must never reject the others beside it.
  const items = Array.isArray(body?.items)
    ? body.items
    : [{ text: body?.text, platform: body?.platform, postedAt: body?.postedAt }];

  const results = [];
  for (const item of items) {
    if (!item?.text) {
      results.push({ outcome: 'rejected', error: 'missing text' });
      continue;
    }
    try {
      results.push(await ingestPayload({ rawText: item.text, channel: 'notification', platformHint: item.platform ?? null }));
    } catch (error) {
      results.push({ outcome: 'error', error: error.message });
    }
  }

  return respond(202, { accepted: results.length, results });
}

/**
 * The tablet's silent-listener watchdog (the doc's "tablet_silent" alert,
 * apps/api's device_heartbeats table + watchdog.js) is NOT wired up here yet
 * — this just authenticates and acknowledges, so the phone-side setup flow
 * and its 5-minute heartbeat loop have somewhere to post that returns 2xx.
 * Recording last-seen and alerting on a 12h gap is a follow-up, not done.
 */
async function handleHeartbeat() {
  return respond(204, null);
}

async function checkDeviceToken(headers) {
  const token = headers['x-device-token'] ?? headers['X-Device-Token'];
  if (!token) return false;
  const secret = await getSecretJson(process.env.DEVICE_TOKEN_SECRET_ID);
  return token === secret.token;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: body === null ? '' : JSON.stringify(body),
  };
}
