#!/usr/bin/env node
/*
 * Phase 0 recon report.
 *
 *   node tools/recon.js
 *
 * Answers the questions the Phase 0 gate actually asks, from the real fixture
 * corpus rather than from memory:
 *
 *   - Which platforms have we captured, on which channel?
 *   - Does each platform's notification carry a booking id? A court? A time?
 *   - Does each platform's email carry the amount and the commission?
 *   - Are at least three of four platforms reachable?
 *
 * The last one is the gate. The middle two decide whether Phase 2's ±2%
 * reconciliation target is reachable at all — a platform whose email omits the
 * commission cannot be reconciled from our side, and we would rather know that
 * in week one than in week nine.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'packages', 'parsers', 'fixtures');

const PLATFORMS = [
  ['playo', 'Playo'],
  ['khelomore', 'KheloMore'],
  ['hudle', 'Hudle'],
  ['district', 'District'],
];

// The fields that decide what each channel is good for.
const FIELDS = [
  ['externalBookingId', 'booking id'],
  ['courtLabel', 'court'],
  ['date', 'date'],
  ['startHhmm', 'time'],
  ['customerName', 'customer'],
  ['grossPaise', 'amount'],
  ['commissionPaise', 'commission'],
];

const real = JSON.parse(await readFile(path.join(FIX, 'real.json'), 'utf8'));
const invented = JSON.parse(await readFile(path.join(FIX, 'invented.json'), 'utf8'));

const bar = (s = '─') => s.repeat(72);
const yes = '  yes';
const no = '   no';
const unk = '    ?';

console.log('');
console.log(bar('═'));
console.log('  TurfSync · Phase 0 recon report');
console.log(bar('═'));

console.log(`\n  real payloads captured : ${real.cases.length}`);
console.log(`  invented placeholders  : ${invented.cases.length}  (not evidence of anything)`);

if (real.cases.length === 0) {
  console.log(`\n${bar()}`);
  console.log('  Nothing captured yet. Phase 0 has not started.');
  console.log(bar());
  console.log(`
  To capture a payload:

    1. Install all four partner apps on the test device.
    2. Make one real booking per platform on a friendly owner's venue.
       Refund it immediately.
    3. Copy the push notification text and the confirmation email verbatim.
    4. node tools/capture.js --file payload.txt

  Until this file has real payloads in it, the templates are guesses and
  parser accuracy is unknown — not high.
`);
  process.exit(0);
}

// ---- the 4×3 channel matrix -------------------------------------------------

console.log(`\n${bar()}`);
console.log('  CHANNEL MATRIX — what reaches us, per platform');
console.log(bar());
console.log(`\n  ${'platform'.padEnd(12)} ${'notification'.padStart(13)} ${'email'.padStart(8)} ${'reachable'.padStart(11)}`);
console.log(`  ${'─'.repeat(12)} ${'─'.repeat(13)} ${'─'.repeat(8)} ${'─'.repeat(11)}`);

let reachable = 0;
for (const [key, label] of PLATFORMS) {
  const notif = real.cases.filter((c) => c.platform === key && c.channel === 'notification').length;
  const mail = real.cases.filter((c) => c.platform === key && c.channel === 'email').length;
  const ok = notif > 0 || mail > 0;
  if (ok) reachable += 1;
  console.log(
    `  ${label.padEnd(12)} ${String(notif || '—').padStart(13)} ${String(mail || '—').padStart(8)} ${(ok ? 'yes' : 'NOT YET').padStart(11)}`,
  );
}

// ---- field coverage ---------------------------------------------------------

console.log(`\n${bar()}`);
console.log('  FIELD COVERAGE — what each channel actually carries');
console.log(bar());

for (const channel of ['notification', 'email']) {
  const rows = real.cases.filter((c) => c.channel === channel);
  if (!rows.length) continue;

  console.log(`\n  ${channel.toUpperCase()}`);
  console.log(`  ${'platform'.padEnd(12)}${FIELDS.map(([, l]) => l.padStart(11)).join('')}`);
  console.log(`  ${'─'.repeat(12)}${FIELDS.map(() => ' '.repeat(2) + '─'.repeat(9)).join('')}`);

  for (const [key, label] of PLATFORMS) {
    const cases = rows.filter((c) => c.platform === key);
    if (!cases.length) {
      console.log(`  ${label.padEnd(12)}${FIELDS.map(() => unk.padStart(11)).join('')}`);
      continue;
    }
    const cells = FIELDS.map(([field]) => {
      const present = cases.some((c) => c.expect?.[field] != null);
      return (present ? yes : no).padStart(11);
    });
    console.log(`  ${label.padEnd(12)}${cells.join('')}`);
  }
}

// ---- consequences -----------------------------------------------------------

console.log(`\n${bar()}`);
console.log('  WHAT THIS MEANS');
console.log(bar());
console.log('');

const emailCases = real.cases.filter((c) => c.channel === 'email');
const moneyless = PLATFORMS.filter(([key]) => {
  const cases = emailCases.filter((c) => c.platform === key);
  return cases.length > 0 && !cases.some((c) => c.expect?.grossPaise != null);
});
const noEmail = PLATFORMS.filter(([key]) => !emailCases.some((c) => c.platform === key));

console.log(`  Reachable platforms: ${reachable} of 4  ${reachable >= 3 ? '— gate met' : '— gate NOT met (need 3)'}`);

if (noEmail.length) {
  console.log(`\n  No email captured yet for: ${noEmail.map(([, l]) => l).join(', ')}`);
  console.log('  Until captured, Phase 2 reconciliation for these is unproven — a push');
  console.log('  notification rarely carries the commission.');
}
if (moneyless.length) {
  console.log(`\n  Email carries NO amount for: ${moneyless.map(([, l]) => l).join(', ')}`);
  console.log('  These cannot be reconciled from our side. Either the owner exports a');
  console.log('  settlement report, or the ±2% Phase 2 target excludes them. Decide now.');
}

const unparsed = real.cases.filter((c) => !c.expect || Object.keys(c.expect).length <= 1);
if (unparsed.length) {
  console.log(`\n  ${unparsed.length} captured payload(s) no template can read yet:`);
  unparsed.forEach((c) => console.log(`     ${c.id}`));
  console.log('  Fill in `expect` by hand in real.json, then make the template match.');
}

console.log(`\n${bar('═')}\n`);
