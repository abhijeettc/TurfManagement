#!/usr/bin/env node
/*
 * Stands in for the Android companion until the Kotlin app exists.
 *
 * The counter tablet's only job is to POST notification text and a heartbeat.
 * This does exactly that against a running API, so the whole ingest path —
 * parse, map, dedupe, persist, conflict-detect, fan out to the board — can be
 * exercised end to end without a device in the room.
 *
 *   node tools/simulate.js booking            one random booking, right now
 *   node tools/simulate.js conflict           two platforms sell the same slot
 *   node tools/simulate.js cancel <ref>       cancel a booking by its platform ref
 *   node tools/simulate.js drift              a payload no template can read
 *   node tools/simulate.js heartbeat          a device check-in
 *   node tools/simulate.js evening            a burst — watch the board repaint
 */

const API = process.env.TURFSYNC_API || 'http://localhost:3000';
// Device tokens are per-venue now, issued at pairing and stored hashed. The
// seed prints one; export it, or paste it here.
const TOKEN = process.env.DEVICE_TOKEN || '';

if (!TOKEN) {
  console.error();
  console.error(`No DEVICE_TOKEN set.`);
  console.error();
  console.error(`Device tokens are per-venue and issued when a tablet is paired.`);
  console.error("`npm run seed` prints one for the demo venue:");
  console.error();
  console.error(`  export DEVICE_TOKEN=<token>     (bash)`);
  console.error(String.fromCharCode(36) + "env:DEVICE_TOKEN=\"<token>\"     (PowerShell)");
  console.error();
  console.error(`Or issue a new one as the owner: POST /api/devices`);
  console.error();
  process.exit(1);
}

const NAMES = [
  'Rahul Iyer', 'Priya Menon', 'Arjun Nair', 'Sneha Kulkarni', 'Vikas Rana',
  'Fatima Sheikh', 'Karan Malhotra', 'Deepa Rao', 'Manish Tiwari', 'Zoya Khan',
];

const COURTS = {
  playo: ['Turf A', 'Turf B', 'Pickle 1 + 2'],
  khelomore: ['Ground 1', 'Ground 2', 'Pickleball'],
  hudle: ['5-a-side Main', '7s Turf'],
  district: ['Football Court 1', 'Football Court 2', 'Pickleball Court'],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pad = (n) => String(n).padStart(2, '0');
const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;
// Each platform's real reference prefix. These are not cosmetic: the templates
// use them to recognise a payload, so "PLA-" instead of "PLY-" is a parse miss.
const PREFIX = { playo: 'PLY', khelomore: 'KM', hudle: 'HDL', district: 'DST' };
const ref = (p) => `${PREFIX[p]}-${Math.floor(1000000 + Math.random() * 8999999)}`;

/** Today's business date in IST, rolling over at 06:00. */
function businessDate() {
  const ist = new Date(Date.now() + 330 * 60000 - 6 * 3600000);
  return ist.toISOString().slice(0, 10);
}

function to12h(h) {
  const suffix = h % 24 < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${pad(hh)}:00 ${suffix}`;
}

function dayLabel(date) {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

function compose(platform, { court, hour, name, ref: bookingRef, date, cancelled }) {
  const start = to12h(hour);
  const end = to12h(hour + 1);
  const d = dayLabel(date);
  const dmy = `${d.slice(0, 2)}-${pad(new Date(`${date}T00:00:00Z`).getUTCMonth() + 1)}-${date.slice(0, 4)}`;

  switch (platform) {
    case 'playo':
      return `${cancelled ? 'Booking Cancelled' : 'New Booking Confirmed'}\n${court} · ${d}\n${start} - ${end}\n${name} · ${phone()}\nBooking ID: ${bookingRef}`;
    case 'khelomore':
      return `KheloMore: ${cancelled ? 'Booking cancelled' : 'New booking'} on ${court}, ${d}, ${start}-${end} by ${name} (${phone()}). Ref ${bookingRef}`;
    case 'hudle':
      return `Booking #${bookingRef} ${cancelled ? 'cancelled' : 'confirmed'} | ${court} | ${dmy} | ${start} to ${end} | ${name}`;
    case 'district':
      return `District Partner: ${court} ${cancelled ? 'booking cancelled' : 'booked'} for ${d}, ${start} - ${end}. Guest: ${name}. Order ${bookingRef}`;
    default:
      throw new Error(`unknown platform ${platform}`);
  }
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN, ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return parsed;
}

function send(text, platform) {
  return post('/ingest/notification', { items: [{ text, platform }] });
}

function report(text, result) {
  const r = Array.isArray(result?.results) ? result.results[0] : result;
  console.log(`\n→ ${text.split('\n')[0]}`);
  console.log(`   ${r?.outcome ?? 'sent'}${r?.latencyMs ? ` in ${r.latencyMs}ms` : ''}${r?.error ? ` — ${r.error}` : ''}`);
}

const COMMANDS = {
  async booking() {
    const platform = pick(Object.keys(COURTS));
    const text = compose(platform, {
      court: pick(COURTS[platform]),
      hour: 16 + Math.floor(Math.random() * 8),
      name: pick(NAMES),
      ref: ref(platform),
      date: businessDate(),
    });
    report(text, await send(text, platform));
  },

  async conflict() {
    // Two platforms sell the same pitch at the same hour, twelve seconds apart.
    const hour = 16 + Math.floor(Math.random() * 8);
    const date = businessDate();
    const first = compose('playo', { court: 'Turf B', hour, name: pick(NAMES), ref: ref('playo'), date });
    report(first, await send(first, 'playo'));

    const second = compose('district', {
      court: 'Football Court 2', hour, name: pick(NAMES), ref: ref('district'), date,
    });
    report(second, await send(second, 'district'));
    console.log('\n   Open the Alerts tab — the constraint caught it and opened a conflict.');
  },

  async cancel(bookingRef) {
    if (!bookingRef) throw new Error('usage: node tools/simulate.js cancel <PLY-1234567>');
    const platform = { PLY: 'playo', KM: 'khelomore', HDL: 'hudle', DST: 'district' }[bookingRef.split('-')[0]]
      ?? 'playo';
    const text = compose(platform, {
      court: pick(COURTS[platform]), hour: 19, name: pick(NAMES),
      ref: bookingRef, date: businessDate(), cancelled: true,
    });
    report(text, await send(text, platform));
  },

  async drift() {
    // What a silent copy change looks like from the pipeline's side.
    const text = 'PLAYO :: BKG#5591203 :: TurfA :: 02Sep :: 1900-2000 :: RohitM';
    report(text, await send(text, 'playo'));
    console.log('\n   Logged to notification_logs with parse_status=failed.');
    console.log('   With ANTHROPIC_API_KEY set, Haiku reads it instead and the row is saved.');
  },

  async heartbeat() {
    await post('/devices/heartbeat', {
      label: 'Counter tablet',
      batteryPct: 40 + Math.floor(Math.random() * 60),
      notificationAccess: true,
      queuedOffline: 0,
      appLastSeen: {
        playo: new Date().toISOString(),
        khelomore: new Date(Date.now() - 60000).toISOString(),
        hudle: new Date(Date.now() - 300000).toISOString(),
        district: new Date(Date.now() - 900000).toISOString(),
      },
    });
    console.log('\n→ heartbeat accepted');
  },

  async evening() {
    console.log('Sending a burst. Keep the board open — it repaints over the WebSocket.\n');
    for (let i = 0; i < 6; i += 1) {
      await COMMANDS.booking();
      await new Promise((r) => setTimeout(r, 1200));
    }
  },
};

const [command = 'booking', ...args] = process.argv.slice(2);
const run = COMMANDS[command];

if (!run) {
  console.error(`unknown command "${command}". One of: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

run(...args).catch((error) => {
  console.error(`\nfailed: ${error.message}`);
  console.error(`is the API running? ${API}`);
  process.exit(1);
});
