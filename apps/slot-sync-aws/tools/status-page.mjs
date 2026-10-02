/**
 * The status page the tablet app opens (the server's `/`): what the blocking
 * system did with each WhatsApp message. In memory, mirrored to a temp file so
 * a server restart does not wipe the history. Local-test tooling, not part of
 * the deployed stack — a deployed system would read DynamoDB instead.
 *
 * Two lists, deliberately not stitched together:
 *   messages — every booking message the tablet sent, and what ingest did with it
 *   blocks   — every block attempt the worker made on TurfPro, and the outcome
 * Alerts are the subset of both that needs a human.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWithTemplates } from '@turfsync/parsers';

const FILE = path.join(os.tmpdir(), 'turfsync-status.json');
const MAX = 200;

let state = { messages: [], blocks: [] };
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  /* first run */
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch {
    /* history is a convenience; never fail a request over it */
  }
}

const push = (list, entry) => {
  list.unshift({ id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...entry });
  list.length = Math.min(list.length, MAX);
  save();
};

/** One entry per item in an /ingest/notification batch. `results` lines up with `items`. */
export function recordMessages(items, results) {
  items.forEach((item, i) => {
    let parsed = null;
    try {
      parsed = parseWithTemplates(item.text ?? '', { channel: 'notification' }).parsed;
    } catch {
      /* unreadable — the outcome below says so */
    }
    const r = results?.[i] ?? {};
    push(state.messages, {
      source: parsed?.platform ?? 'unknown',
      customer: parsed?.customerName ?? null,
      ground: parsed?.courtLabel ?? r.courtLabel ?? null,
      date: parsed?.date ?? null,
      slot: parsed ? `${parsed.startHhmm}-${parsed.endHhmm}` : null,
      outcome: r.outcome ?? 'error',
      detail: r.error ?? null,
      preview: parsed ? null : String(item.text ?? '').slice(0, 120),
    });
  });
}

/** One entry per block attempt (a failed attempt is retried by the queue, so a job can appear more than once). */
export function recordBlock(job, outcome, error = null) {
  push(state.blocks, {
    ground: job.slot.courtName,
    date: job.slot.date,
    slot: `${job.slot.startTime}-${job.slot.endTime}`,
    from: job.slot.startTime,
    to: job.slot.endTime,
    target: job.targetPlatform,
    outcome,
    detail: error,
  });
}

/**
 * 'awaiting_browser' blocks are finished by the owner's own browser (the tablet
 * opens TurfPro's /turfsync/block page, already logged in). That page pings
 * these two when it is done or finds the owner signed out.
 */
export function completeBrowserBlock(id) {
  const hit = state.blocks.find((b) => b.id === id && b.outcome === 'awaiting_browser');
  if (!hit) return false;
  hit.outcome = 'blocked';
  hit.detail = 'Blocked from the owner’s browser';
  delete hit.loginNeeded;
  save();
  return true;
}

/** The tablet could not block it for a reason a person has to deal with (shown under Blocking and Alerts). */
export function failBrowserBlock(id, outcome, detail) {
  const hit = state.blocks.find((b) => b.id === id && b.outcome === 'awaiting_browser');
  if (!hit) return false;
  hit.outcome = outcome === 'already_booked' ? 'already_booked' : 'failed';
  hit.detail = String(detail ?? '').slice(0, 200) || null;
  delete hit.loginNeeded;
  save();
  return true;
}

export function noteLoginNeeded(id) {
  const hit = state.blocks.find((b) => b.id === id && b.outcome === 'awaiting_browser');
  if (!hit) return false;
  hit.loginNeeded = true;
  save();
  return true;
}

/** Apps the blocking system knows about. Only TurfPro is switched on for this test. */
const APPS = [
  { key: 'turfpro', label: 'TurfPro', enabled: true },
  { key: 'playo', label: 'Playo', enabled: false },
  { key: 'hudle', label: 'Hudle', enabled: false },
  { key: 'khelomore', label: 'KheloMore', enabled: false },
  { key: 'district', label: 'District', enabled: false },
];

/** A human has dealt with this one (opened the app and fixed it by hand). */
export function resolveEntry(id) {
  const hit = state.blocks.find((b) => b.id === id);
  if (!hit) return false;
  hit.resolved = true;
  save();
  return true;
}

/**
 * Block problems still needing a human. A job can fail, be retried, and then
 * succeed, so only the LATEST attempt per slot counts.
 */
function openTasks() {
  const latest = new Map();
  for (const b of state.blocks) {
    const key = [b.target, b.ground, b.date, b.slot].join('|');
    if (!latest.has(key)) latest.set(key, b); // blocks are newest-first
  }
  return [...latest.values()]
    .filter((b) => (b.outcome === 'failed' || b.outcome === 'already_booked' || b.outcome === 'awaiting_browser') && !b.resolved)
    .map((b) => ({
      id: b.id,
      platform: b.target,
      label: APPS.find((a) => a.key === b.target)?.label ?? b.target,
      court: b.ground,
      slot: `${b.date} ${b.slot}`,
      date: b.date,
      from: b.from ?? b.slot?.split('-')[0],
      to: b.to ?? b.slot?.split('-')[1],
      action: 'block',
      kind: b.outcome,
      loginNeeded: Boolean(b.loginNeeded),
      detail: b.detail,
      at: b.at,
    }));
}

export function statusJson() {
  const alerts = [
    ...state.blocks
      .filter((b) => b.outcome === 'awaiting_browser' && b.loginNeeded)
      .map((b) => ({
        at: b.at,
        kind: 'TurfPro login needed',
        text: `Sign in to TurfPro in TurfSync (Open TurfPro) — ${b.ground} · ${b.date} ${b.slot} will then block by itself`,
      })),
    ...state.blocks
      .filter((b) => (b.outcome === 'already_booked' || b.outcome === 'failed') && !b.resolved)
      .map((b) => ({
        at: b.at,
        kind: b.outcome === 'already_booked' ? 'Double booking' : 'Block failed',
        text: `${b.ground} · ${b.date} ${b.slot}` + (b.detail ? ` — ${b.detail}` : ''),
      })),
    ...state.messages
      .filter((m) => m.outcome === 'parse_failed' || m.outcome === 'unmapped_court' || m.outcome === 'error')
      .map((m) => ({
        at: m.at,
        kind: m.outcome === 'unmapped_court' ? 'Unknown ground' : 'Unreadable message',
        text: m.outcome === 'unmapped_court' ? `"${m.ground}" is not mapped to a TurfPro ground` : (m.detail ?? m.preview ?? ''),
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const apps = APPS.map((app) => {
    const blocks = state.blocks.filter((b) => b.target === app.key);
    return {
      ...app,
      counts: {
        blocked: blocks.filter((b) => b.outcome === 'blocked').length,
        alreadyBlocked: blocks.filter((b) => b.outcome === 'skipped_already_blocked').length,
        doubleBooked: blocks.filter((b) => b.outcome === 'already_booked').length,
        failed: blocks.filter((b) => b.outcome === 'failed').length,
      },
      recent: blocks.slice(0, 25),
    };
  });
  return { ...state, alerts, apps, tasks: openTasks() };
}

export function statusHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TurfSync status</title>
<style>
  :root { --bg:#f4f5f2; --card:#fff; --ink:#14201a; --mute:#6b766f; --line:#e1e5df; --green:#15573d; --red:#b3261e; --amber:#a15c00; --blue:#1b4f9c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111713; --card:#1a221d; --ink:#e8eee9; --mute:#93a097; --line:#2a342d; --green:#5ac08c; --red:#f2857d; --amber:#e8b04a; --blue:#8fb4f0; } }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.4 system-ui,sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 16px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
  h1 { font-size:20px; margin:0; } .sub { color:var(--mute); font-size:13px; }
  .btn { display:inline-block; background:var(--green); color:#fff; text-decoration:none; padding:10px 16px; border-radius:8px; font-weight:600; }
  @media (prefers-color-scheme: dark) { .btn { color:#0c1510; } }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:14px; overflow:hidden; }
  h2 { font-size:14px; margin:0; padding:12px 14px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; }
  table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--line); font-size:14px; vertical-align:top; }
  th { color:var(--mute); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; } tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; padding:2px 9px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
  .ok { color:var(--green); } .bad { color:var(--red); } .warn { color:var(--amber); } .info { color:var(--blue); }
  .empty { padding:18px 14px; color:var(--mute); } .alert { padding:10px 14px; border-bottom:1px solid var(--line); } .alert:last-child { border-bottom:0; }
  .wrap { overflow-x:auto; }
</style></head><body><main>
<header>
  <div><h1>TurfSync — TurfPro blocking</h1><div class="sub" id="meta">Loading…</div></div>
  <a class="btn" href="/index.html">Open TurfSync dashboard</a>
</header>
<section><h2>Alerts <span class="sub" id="ac"></span></h2><div id="alerts"></div></section>
<section><h2>Blocks on TurfPro</h2><div class="wrap"><table><thead><tr><th>When</th><th>Ground</th><th>Date</th><th>Slot</th><th>Result</th></tr></thead><tbody id="blocks"></tbody></table></div></section>
<section><h2>WhatsApp messages received</h2><div class="wrap"><table><thead><tr><th>When</th><th>From</th><th>Ground</th><th>Date</th><th>Slot</th><th>What happened</th></tr></thead><tbody id="messages"></tbody></table></div></section>
</main>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', second:'2-digit' });
const BLOCK = { awaiting_browser:['Waiting for tap in TurfPro','warn'], blocked:['Blocked','ok'], skipped_already_blocked:['Already blocked','info'], already_booked:['Double booking','bad'], failed:['Failed — retrying','bad'] };
const MSG = { queued:['Block queued','ok'], duplicate:['Duplicate — ignored','info'], echo_suppressed:['Our own block — ignored','info'], cancelled_noop:['Cancellation — noted only','warn'], unmapped_court:['Unknown ground','bad'], parse_failed:['Could not read','bad'], error:['Error','bad'] };
const pill = (map, k) => { const [t, c] = map[k] ?? [k, 'warn']; return '<span class="pill ' + c + '">' + esc(t) + '</span>'; };
async function load() {
  try {
    const d = await (await fetch('/status.json', { cache:'no-store' })).json();
    document.getElementById('meta').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN') + ' · refreshes every 5 s';
    document.getElementById('ac').textContent = d.alerts.length ? d.alerts.length + ' need attention' : '';
    document.getElementById('alerts').innerHTML = d.alerts.length
      ? d.alerts.slice(0, 10).map((a) => '<div class="alert"><span class="pill bad">' + esc(a.kind) + '</span> ' + esc(a.text) + ' <span class="sub">' + when(a.at) + '</span></div>').join('')
      : '<div class="empty">No alerts. Nothing needs your attention.</div>';
    document.getElementById('blocks').innerHTML = d.blocks.length
      ? d.blocks.map((b) => '<tr><td>' + when(b.at) + '</td><td>' + esc(b.ground) + '</td><td>' + esc(b.date) + '</td><td>' + esc(b.slot) + '</td><td>' + pill(BLOCK, b.outcome) + (b.detail ? '<div class="sub">' + esc(b.detail) + '</div>' : '') + '</td></tr>').join('')
      : '<tr><td colspan="5" class="empty">No blocks yet. Send a booking message to this tablet\\'s WhatsApp.</td></tr>';
    document.getElementById('messages').innerHTML = d.messages.length
      ? d.messages.map((m) => '<tr><td>' + when(m.at) + '</td><td>' + esc(m.source) + (m.customer ? '<div class="sub">' + esc(m.customer) + '</div>' : '') + '</td><td>' + esc(m.ground ?? '—') + '</td><td>' + esc(m.date ?? '—') + '</td><td>' + esc(m.slot ?? '—') + '</td><td>' + pill(MSG, m.outcome) + (m.detail ? '<div class="sub">' + esc(m.detail) + '</div>' : (m.preview ? '<div class="sub">' + esc(m.preview) + '</div>' : '')) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="empty">No messages received yet.</td></tr>';
  } catch (e) { document.getElementById('meta').textContent = 'Cannot reach the server — retrying…'; }
}
load(); setInterval(load, 5000);
</script></body></html>`;
}
