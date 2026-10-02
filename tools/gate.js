#!/usr/bin/env node
/*
 * Phase 0 exit gate.
 *
 *   node tools/gate.js
 *
 * Scores the gate from the interview and fixture data rather than from a
 * feeling after two weeks of talking to enthusiastic people. Every criterion is
 * from the build plan, unchanged:
 *
 *   - >=10 of 15 owners report >=3 double-bookings/month AND >=60 min/day syncing
 *   - >=3 of 4 platforms reachable by notification or email
 *   - 5 design partners signed
 *   - the fixture corpus contains only real payloads
 *
 * It is allowed to say no. That is the whole reason it exists.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

async function load(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const interviews = (await load(path.join(here, '..', 'docs', 'phase-0', 'interviews.json'), { interviews: [] })).interviews;
const real = (await load(path.join(here, '..', 'packages', 'parsers', 'fixtures', 'real.json'), { cases: [] })).cases;

const bar = (s = '─') => s.repeat(72);
const mark = (ok) => (ok ? 'PASS' : 'not yet');

// ---- criteria ---------------------------------------------------------------

const qualifying = interviews.filter(
  (i) => (i.doubleBookingsPerMonth ?? 0) >= 3 && (i.minutesPerDay ?? 0) >= 60,
);
const painOk = qualifying.length >= 10 && interviews.length >= 15;

const platforms = new Set(real.map((c) => c.platform));
const reachOk = platforms.size >= 3;

const partners = interviews.filter((i) => i.designPartner);
const partnersOk = partners.length >= 5;

const corpusOk = real.length > 0;

const passed = painOk && reachOk && partnersOk && corpusOk;

// ---- report -----------------------------------------------------------------

console.log(`\n${bar('═')}`);
console.log('  TurfSync · Phase 0 exit gate');
console.log(bar('═'));

console.log(`\n  ${'criterion'.padEnd(44)} ${'status'.padStart(9)}`);
console.log(`  ${'─'.repeat(44)} ${'─'.repeat(9)}`);
console.log(`  ${`Interviews completed (need 15)`.padEnd(44)} ${String(interviews.length).padStart(9)}`);
console.log(`  ${`  meeting >=3 double-bookings + >=60 min/day`.padEnd(44)} ${String(qualifying.length).padStart(9)}`);
console.log(`  ${`  of which >=10 required`.padEnd(44)} ${mark(painOk).padStart(9)}`);
console.log(`  ${`Platforms reachable (need 3 of 4)`.padEnd(44)} ${`${platforms.size} · ${mark(reachOk)}`.padStart(9)}`);
console.log(`  ${`Design partners signed (need 5)`.padEnd(44)} ${`${partners.length} · ${mark(partnersOk)}`.padStart(9)}`);
console.log(`  ${`Real payloads captured (need >0)`.padEnd(44)} ${`${real.length} · ${mark(corpusOk)}`.padStart(9)}`);

// ---- what the interviews say ------------------------------------------------

if (interviews.length) {
  const nums = (key) => interviews.map((i) => i[key]).filter((n) => typeof n === 'number');
  const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const show = (label, arr, unit = '') => {
    const m = median(arr);
    console.log(`  ${label.padEnd(44)} ${(m == null ? '—' : `${m}${unit}`).padStart(9)}`);
  };

  console.log(`\n${bar()}`);
  console.log('  WHAT THE OWNERS SAID  (medians)');
  console.log(bar());
  console.log('');
  show('Apps listed on', nums('platformCount'));
  show('Bookings per day', nums('bookingsPerDay'));
  show('Seconds to block everywhere', nums('medianBlockSeconds'), 's');
  show('Minutes per day syncing (derived)', nums('minutesPerDay'), ' min');
  show('Double-bookings per month', nums('doubleBookingsPerMonth'));
  show('Unresold cancelled slots per month', nums('unresoldPerMonth'));
  show('Would pay per month', nums('willingToPay'), ' rupees');

  const kills = interviews.filter((i) => i.killSignal);
  const noSoftware = interviews.filter((i) => !i.currentSoftware).length;
  const friction = interviews.filter((i) => i.partnerFriction).length;
  const cantAnswer = interviews.filter((i) => i.couldAnswerSaturday === false).length;
  const dedicated = interviews.filter((i) => i.counterDevice === 'dedicated').length;

  console.log('');
  console.log(`  ${'Could NOT say what last Sat 8pm netted'.padEnd(44)} ${`${cantAnswer}/${interviews.length}`.padStart(9)}`);
  console.log(`  ${'Partner split is a friction point'.padEnd(44)} ${`${friction}/${interviews.length}`.padStart(9)}`);
  console.log(`  ${'Using no software today'.padEnd(44)} ${`${noSoftware}/${interviews.length}`.padStart(9)}`);
  console.log(`  ${'Has a dedicated counter device'.padEnd(44)} ${`${dedicated}/${interviews.length}`.padStart(9)}`);
  console.log(`  ${'Said a kill-signal phrase'.padEnd(44)} ${`${kills.length}/${interviews.length}`.padStart(9)}`);

  // ---- the pivot signal -----------------------------------------------------
  if (interviews.length >= 8 && kills.length > interviews.length / 2) {
    console.log(`\n${bar()}`);
    console.log('  KILL SIGNAL');
    console.log(bar());
    console.log(`
  More than half of the owners so far said the sync pain is not acute —
  "I only list on one app", "my staff handles it", "double-booking twice a year".

  This is the pivot the plan anticipated: reconciliation-first. That pain is
  universal, the same ingestion work serves it, and nothing built so far is
  wasted. ${cantAnswer} of ${interviews.length} could not say what one peak slot earned them.

  Do not push through this. Re-read section 6 of the build plan.`);
  }

  if (friction >= interviews.length / 2 && interviews.length >= 8) {
    console.log(`\n  Note: partner-split friction is running at ${friction}/${interviews.length}.`);
    console.log('  The plan flagged this as possibly a headline feature rather than a');
    console.log('  Phase 2 detail. At this rate, it is.');
  }
}

// ---- verdict ----------------------------------------------------------------

console.log(`\n${bar('═')}`);
if (passed) {
  console.log('  GATE PASSED — begin Phase 1 remainder.');
  console.log(bar('═'));
  console.log(`
  Next, in order:
    1. Re-verify every template against the real corpus  (node tools/recon.js)
    2. Build the Android companion
    3. Authentication and deployment
`);
} else {
  console.log('  GATE NOT MET — Phase 0 is not finished.');
  console.log(bar('═'));
  console.log('');
  if (interviews.length < 15) console.log(`  · ${15 - interviews.length} more interviews needed`);
  if (interviews.length >= 15 && !painOk) console.log(`  · only ${qualifying.length} of 15 owners meet the pain threshold (need 10)`);
  if (!reachOk) console.log(`  · only ${platforms.size} of 4 platforms captured (need 3) — run the recon checklist`);
  if (!partnersOk) console.log(`  · ${5 - partners.length} more design partners needed`);
  if (!corpusOk) console.log('  · no real payloads captured — the parsers are still guesses');
  console.log('');
}
console.log('');
