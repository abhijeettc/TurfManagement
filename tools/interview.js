#!/usr/bin/env node
/*
 * Record one owner interview.
 *
 *   node tools/interview.js
 *
 * Walks the numbers from docs/phase-0/interview-script.md and appends to
 * docs/phase-0/interviews.json. Only the quantities live here — the qualitative
 * notes belong in your own notebook, and the good ones belong in the pitch.
 *
 * The point of recording them structurally is that `node tools/gate.js` can
 * then tell you whether Phase 0 passed, instead of you deciding from a feeling
 * after two weeks of talking to enthusiastic people.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', 'docs', 'phase-0');
const FILE = path.join(DIR, 'interviews.json');

// Two input modes, because they behave differently in ways that matter.
//
// Interactive (a real interview at a counter) reads a line at a time. Piped
// input cannot: readline emits 'close' as soon as the stream ends, which can
// beat the questions to the buffered lines and silently record a row of nulls.
// So when stdin is not a TTY, drain it up front and answer from the queue.
const interactive = process.stdin.isTTY;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

let queued = [];
if (!interactive) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  queued = chunks.join('').split('\n');
}

let closed = false;
const onClose = interactive
  ? new Promise((resolve) => rl.once('close', () => { closed = true; resolve(null); }))
  : null;

async function ask(question, { type = 'text', fallback = null } = {}) {
  let raw;
  if (interactive) {
    // Ctrl-D closes stdin. Without this race the next question never settles
    // and the tool hangs with a half-recorded interview — at a counter,
    // mid-conversation, which is the worst possible place for it.
    if (closed) return fallback;
    raw = await Promise.race([rl.question(`  ${question} `), onClose]);
  } else {
    if (!queued.length) return fallback;
    raw = queued.shift();
    console.log(`  ${question} ${raw}`);
  }
  if (raw == null) return fallback;
  const answer = raw.trim();
  if (!answer) return fallback;
  if (type === 'number') {
    const n = Number(answer.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : fallback;
  }
  if (type === 'bool') return /^y/i.test(answer);
  return answer;
}

console.log('\n  Owner interview — numbers only. Blank to skip any line.\n');

const venue = await ask('Venue name (or a code):');
const city = await ask('City / locality:');

console.log('\n  — Setup —');
const platformCount = await ask('How many apps are they listed on?', { type: 'number' });
const courts = await ask('How many courts?', { type: 'number' });
const bookingsPerDay = await ask('Bookings per day (their estimate):', { type: 'number' });

console.log('\n  — Observed, with a stopwatch —');
const observed = [];
for (let i = 1; i <= 5; i += 1) {
  const secs = await ask(`Booking ${i}: seconds to block everywhere (blank to stop):`, { type: 'number' });
  if (secs == null) break;
  observed.push(secs);
}
const medianSecs = observed.length
  ? [...observed].sort((a, b) => a - b)[Math.floor(observed.length / 2)]
  : null;

console.log('\n  — Double-bookings —');
const doubleBookingsPerMonth = await ask('Double-bookings per month:', { type: 'number' });
const lastDoubleBookingCost = await ask('Cost of the last one, in rupees:', { type: 'number' });

console.log('\n  — Cancellations —');
const unresoldPerMonth = await ask('Cancelled slots per month never reopened elsewhere:', { type: 'number' });

console.log('\n  — Money —');
const knowsCommission = await ask('Do they know each platform\'s commission? (y/n)', { type: 'bool' });
const checksPayouts = await ask('Do they check payouts against what they were owed? (y/n)', { type: 'bool' });
const couldAnswerSaturday = await ask('Could they say what last Sat 8pm netted? (y/n)', { type: 'bool' });

console.log('\n  — Partners —');
const partnerCount = await ask('Number of partners in the venue:', { type: 'number' });
const partnerFriction = await ask('Is the split a source of friction? (y/n)', { type: 'bool' });

console.log('\n  — Software —');
const currentSoftware = await ask('Software used today (blank = none):');
const currentSpend = await ask('Monthly spend on it, rupees:', { type: 'number' });

console.log('\n  — The ask —');
const willingToPay = await ask('What would they pay per month? (their number first):', { type: 'number' });
const designPartner = await ask('Would they be a design partner? (y/n)', { type: 'bool' });

console.log('\n  — Device —');
const counterDevice = await ask('Counter device: dedicated / shared / personal / none:');
const devicePluggedIn = await ask('Is it kept plugged in? (y/n)', { type: 'bool' });

const killSignal = await ask('\n  Did they say any kill-signal phrase? (y/n)', { type: 'bool' });
const notes = await ask('One line worth remembering:');

if (rl && !closed) rl.close();

// Minutes a day is the number the gate turns on, and it is the one number an
// owner cannot estimate reliably. Derive it: observed median × their own count.
const minutesPerDay =
  medianSecs != null && bookingsPerDay != null
    ? Math.round((medianSecs * bookingsPerDay) / 60)
    : null;

await mkdir(DIR, { recursive: true });

let corpus;
try {
  corpus = JSON.parse(await readFile(FILE, 'utf8'));
} catch {
  corpus = {
    _comment: [
      'Phase 0 owner interviews. Numbers only; qualitative notes live elsewhere.',
      'Added with: node tools/interview.js    Scored with: node tools/gate.js',
      '',
      'minutesPerDay is DERIVED — observed median seconds per booking multiplied',
      'by their own daily booking count. Never take a self-reported figure for it.',
    ],
    interviews: [],
  };
}

corpus.interviews.push({
  venue,
  city,
  date: new Date().toISOString().slice(0, 10),
  platformCount,
  courts,
  bookingsPerDay,
  observedBlockSeconds: observed,
  medianBlockSeconds: medianSecs,
  minutesPerDay,
  doubleBookingsPerMonth,
  lastDoubleBookingCost,
  unresoldPerMonth,
  knowsCommission,
  checksPayouts,
  couldAnswerSaturday,
  partnerCount,
  partnerFriction,
  currentSoftware: currentSoftware || null,
  currentSpend,
  willingToPay,
  designPartner,
  counterDevice,
  devicePluggedIn,
  killSignal,
  notes,
});

await writeFile(FILE, JSON.stringify(corpus, null, 2) + '\n');

console.log(`\n  saved — ${corpus.interviews.length} of 15 interviews recorded`);
if (minutesPerDay != null) {
  console.log(`  derived: ${medianSecs}s median × ${bookingsPerDay} bookings = ~${minutesPerDay} min/day`);
} else {
  console.log('  no timed observations — this interview cannot count toward the gate');
}
console.log('\n  next: node tools/gate.js\n');
