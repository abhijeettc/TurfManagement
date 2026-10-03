// WhatsApp adapter.
//
// Phase 1 sends booking alerts, parse-failure alerts and device-health alerts.
// `WHATSAPP_PROVIDER=console` (the default) logs every message with the
// exact template and variables it would send. `WHATSAPP_PROVIDER=gupshup`
// sends it for real, through Gupshup's WhatsApp Business API. Adding another
// BSP (e.g. AiSensy) later is one more branch in sendWhatsApp — nothing
// above this file changes, since every call site already just awaits
// sendWhatsApp(to, template, vars).
//
// WhatsApp requires business-initiated messages to use a template that Meta
// has pre-approved, not arbitrary text — the strings TEMPLATES builds below
// are what the console fallback shows and what fills a template's variable
// slots, not raw message bodies the API will accept as-is. Each key in
// TEMPLATES must have a matching approved template registered in the
// Gupshup dashboard before WHATSAPP_PROVIDER=gupshup can be turned on; its
// id goes in GUPSHUP_TEMPLATE_IDS (see .env.example).

// Read per call, not cached at module load: lets tests flip
// WHATSAPP_PROVIDER between cases without reloading the module, and means a
// process that loads .env before this module still sees the real value.
function currentProvider() {
  return process.env.WHATSAPP_PROVIDER || 'console';
}

function currentTemplateIds() {
  return parseTemplateIds(process.env.GUPSHUP_TEMPLATE_IDS);
}

function parseTemplateIds(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('GUPSHUP_TEMPLATE_IDS must be valid JSON, e.g. {"booking_alert":"abcd-1234"}');
  }
}

const TEMPLATES = {
  booking_alert: ({ platform, customer, court, slot, amount }) =>
    `New booking · ${platform}\n${customer || 'Guest'} · ${court}\n${slot}${amount ? ` · ${amount}` : ''}`,

  conflict_alert: ({ court, slot, platforms }) =>
    `⚠ Double booking on ${court} at ${slot}.\nBoth ${platforms.join(' and ')} sold this slot. Open TurfSync to resolve.`,

  parse_failure: ({ platform, count }) =>
    `TurfSync could not read ${count} ${platform} message${count === 1 ? '' : 's'}. Those bookings may be missing from your board — we are on it.`,

  device_silent: ({ label, minutes }) =>
    `${label} has not reported in for ${minutes} minutes. Your board may be missing bookings. Check the tablet is on, charged, and connected.`,

  block_failed: ({ platform, court, attempts, error }) =>
    `⚠ Could not block ${court} on ${platform}${attempts ? ` after ${attempts} tries` : ''}.\n${error}\nPlease block it there yourself — the other platforms are unaffected.`,

  // Assisted blocking (see blocking/worker.js): TurfSync never logs into a
  // partner dashboard itself, so every block or unblock is a task for a human
  // to do in that platform's own app.
  block_task: ({ platform, court, slot }) =>
    `📋 Block needed on ${platform}\n${court} · ${slot}\nOpen the ${platform} app and block this slot, then mark it done in TurfSync.`,

  block_task_overdue: ({ platform, court, slot, minutes }) =>
    `⏰ Still not blocked on ${platform} after ${minutes} min.\n${court} · ${slot}\nThis slot could get sold twice — please block it now.`,

  unblock_task: ({ platform, court, slot }) =>
    `📋 Unblock needed on ${platform}\n${court} · ${slot}\nThe booking that needed this was cancelled. Release it in the ${platform} app, then mark it done in TurfSync.`,

  unblock_task_overdue: ({ platform, court, slot, minutes }) =>
    `⏰ Still not released on ${platform} after ${minutes} min.\n${court} · ${slot}\nThat slot is sitting unsold elsewhere — please release it.`,
};

// The order Meta template placeholders ({{1}}, {{2}}, ...) are filled in.
// Must match the order each template was registered with in the Gupshup
// dashboard — WhatsApp templates take positional params, not named ones.
const TEMPLATE_PARAM_ORDER = {
  booking_alert: ['platform', 'customer', 'court', 'slot', 'amount'],
  conflict_alert: ['court', 'slot', 'platforms'],
  parse_failure: ['platform', 'count'],
  device_silent: ['label', 'minutes'],
  block_failed: ['platform', 'court', 'attempts', 'error'],
  block_task: ['platform', 'court', 'slot'],
  block_task_overdue: ['platform', 'court', 'slot', 'minutes'],
  unblock_task: ['platform', 'court', 'slot'],
  unblock_task_overdue: ['platform', 'court', 'slot', 'minutes'],
};

export async function sendWhatsApp(to, template, vars) {
  const build = TEMPLATES[template];
  if (!build) throw new Error(`unknown WhatsApp template: ${template}`);
  const body = build(vars);

  const provider = currentProvider();

  if (provider === 'console') {
    console.log(`\n─── whatsapp → ${to} [${template}]\n${body}\n───`);
    return { delivered: false, provider: 'console' };
  }

  if (provider === 'gupshup') {
    return sendViaGupshup(to, template, vars);
  }

  throw new Error(`WhatsApp provider "${provider}" not implemented`);
}

// WhatsApp template params must be non-empty strings; a missing optional
// value (e.g. booking_alert's amount when a booking has no price yet) has to
// become something Meta will accept, not undefined.
function stringifyParam(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.join(' and ');
  return String(value);
}

async function sendViaGupshup(to, template, vars) {
  const templateId = currentTemplateIds()[template];
  if (!templateId) {
    throw new Error(
      `no Gupshup template id configured for "${template}" — register it in the Gupshup ` +
        `dashboard and add its id to GUPSHUP_TEMPLATE_IDS`,
    );
  }

  const apiKey = process.env.GUPSHUP_API_KEY;
  const source = process.env.GUPSHUP_SOURCE_NUMBER;
  const appName = process.env.GUPSHUP_APP_NAME;
  if (!apiKey || !source || !appName) {
    throw new Error(
      'GUPSHUP_API_KEY, GUPSHUP_SOURCE_NUMBER and GUPSHUP_APP_NAME must all be set for WHATSAPP_PROVIDER=gupshup',
    );
  }

  const params = (TEMPLATE_PARAM_ORDER[template] ?? []).map((key) => stringifyParam(vars[key]));

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source,
    destination: to.replace(/^\+/, ''),
    'src.name': appName,
    template: JSON.stringify({ id: templateId, params }),
  });

  // No timeout here left every caller (ingest, the block worker, the
  // watchdog) hostage to Gupshup's own latency — a slow or unreachable API
  // could hang a booking's whole request indefinitely. 8s matches the
  // Android app's own HTTP timeouts.
  const res = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8_000),
  });

  const raw = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Gupshup send failed (${res.status}): ${raw ? JSON.stringify(raw) : res.statusText}`);
  }

  return { delivered: true, provider: 'gupshup', raw };
}
