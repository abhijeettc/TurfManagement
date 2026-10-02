import { getSecretJson } from './secrets.mjs';

/**
 * Mirrors apps/api/src/notify.js's provider/template pattern — a straight
 * copy of the idea, not an import, since apps/api/src isn't a workspace
 * package. `console` (the default) logs every alert instead of sending it;
 * `gupshup` sends for real through Gupshup's WhatsApp Business API, reusing
 * the same Meta-template-per-key requirement notify.js documents.
 */
function currentProvider() {
  return process.env.WHATSAPP_PROVIDER || 'console';
}

const TEMPLATES = {
  block_succeeded: ({ court, slot, platforms }) => `${slot} · ${court} booked — blocked on ${platforms.join(', ')}`,

  block_failed: ({ court, slot, platform, error }) =>
    `⚠ Could not block ${court} at ${slot} on ${platform}.\n${error}\nPlease block it there yourself.`,

  already_booked: ({ court, slot, platforms }) =>
    `🚨 Double booking: ${court} at ${slot} is sold on both ${platforms.join(' and ')}. Resolve manually.`,

  parse_failure: ({ platform, raw }) =>
    `TurfSync Slot Sync could not read a ${platform} message:\n${String(raw).slice(0, 300)}`,

  health_check_failed: ({ platform, error }) => `Daily health check failed for ${platform}: ${error}`,

  tablet_silent: () => `TurfSync Slot Sync: the tablet has not reported in for 12h during opening hours. Check it.`,
};

const TEMPLATE_PARAM_ORDER = {
  block_succeeded: ['court', 'slot', 'platforms'],
  block_failed: ['court', 'slot', 'platform', 'error'],
  already_booked: ['court', 'slot', 'platforms'],
  parse_failure: ['platform', 'raw'],
  health_check_failed: ['platform', 'error'],
  tablet_silent: [],
};

function stringifyParam(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.join(' and ');
  return String(value);
}

export async function sendAlert(to, template, vars) {
  const build = TEMPLATES[template];
  if (!build) throw new Error(`unknown alert template: ${template}`);
  const body = build(vars);

  const provider = currentProvider();

  if (provider === 'console') {
    console.log(`\n--- whatsapp -> ${to} [${template}]\n${body}\n---`);
    return { delivered: false, provider: 'console' };
  }

  if (provider === 'gupshup') {
    return sendViaGupshup(to, template, vars);
  }

  throw new Error(`WhatsApp provider "${provider}" not implemented`);
}

async function sendViaGupshup(to, template, vars) {
  const creds = await getSecretJson(process.env.GUPSHUP_SECRET_ID);
  const templateId = creds.templateIds?.[template];
  if (!templateId) {
    throw new Error(`no Gupshup template id configured for "${template}" in the gupshup secret`);
  }

  const params = (TEMPLATE_PARAM_ORDER[template] ?? []).map((key) => stringifyParam(vars[key]));

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: creds.sourceNumber,
    destination: String(to).replace(/^\+/, ''),
    'src.name': creds.appName,
    template: JSON.stringify({ id: templateId, params }),
  });

  const res = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: { apikey: creds.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Gupshup send failed (${res.status}): ${raw ? JSON.stringify(raw) : res.statusText}`);
  }

  return { delivered: true, provider: 'gupshup', raw };
}
