import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseWithTemplates } from '@turfsync/parsers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'packages', 'parsers', 'fixtures');

const invented = JSON.parse(await readFile(path.join(FIX, 'invented.json'), 'utf8'));
const real = JSON.parse(await readFile(path.join(FIX, 'real.json'), 'utf8'));

// Reference instant, so year inference on dates like "Sat, 02 Sep" is stable.
const NOW = Date.parse('2026-09-02T12:00:00Z');

function checkCase(c) {
  const hit = parseWithTemplates(c.raw, { channel: c.channel, now: NOW });
  assert.ok(hit, `no template matched ${c.id}`);
  for (const [field, expected] of Object.entries(c.expect)) {
    assert.deepEqual(
      hit.parsed[field],
      expected,
      `${c.id}: ${field} was ${JSON.stringify(hit.parsed[field])}, expected ${JSON.stringify(expected)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Real payloads. These are the only ones that say anything about whether the
// parsers work.
// ---------------------------------------------------------------------------

test('every REAL captured payload is read correctly', { skip: real.cases.length ? false : 'no real payloads captured yet — run Phase 0 recon' }, async (t) => {
  for (const c of real.cases) {
    await t.test(c.id, () => checkCase(c));
  }
});

test('the Phase 1 capture gate is claimable', { skip: real.cases.length ? false : 'no real payloads captured yet — run Phase 0 recon' }, () => {
  const hits = real.cases.filter((c) => parseWithTemplates(c.raw, { channel: c.channel, now: NOW }));
  const rate = hits.length / real.cases.length;
  assert.ok(
    rate >= 0.95,
    `template hit rate on REAL payloads is ${(rate * 100).toFixed(0)}%, below the 95% gate. ` +
      'Below this the Haiku fallback is carrying production traffic and the unit economics stop working.',
  );
});

// ---------------------------------------------------------------------------
// Invented payloads. These are regression cover for the parsing machinery — the
// tolerant date/time scanning, the cross-midnight handling, the court-label
// edge cases. They are NOT evidence that any template matches reality, and the
// gate assertion above deliberately ignores them.
// ---------------------------------------------------------------------------

test('invented payloads still parse (regression cover only)', async (t) => {
  for (const c of invented.cases) {
    await t.test(c.id, () => checkCase(c));
  }
});

test('a payload from no known platform is a miss, not a wrong match', () => {
  assert.equal(parseWithTemplates('Your Swiggy order is on the way', { now: NOW }), null);
});

test('an empty payload is a miss', () => {
  assert.equal(parseWithTemplates('', { now: NOW }), null);
});

// ---------------------------------------------------------------------------
// The corpus itself
// ---------------------------------------------------------------------------

test('no real payload carries an unredacted phone number', () => {
  // The corpus is committed. A capture that slipped through redaction is a
  // customer's number in git history, which is not recoverable by deleting it.
  for (const c of real.cases) {
    const digits = c.raw.match(/\b[6-9]\d{9}\b/g) ?? [];
    for (const d of digits) {
      assert.ok(
        d.startsWith('98') || /^9[0-9]{9}$/.test(d),
        `${c.id} contains what looks like a real phone number: ${d}`,
      );
    }
  }
});

test('Phase 0 recon status is reported honestly', () => {
  // Not a pass/fail on the recon — a standing reminder in the test output that
  // parser accuracy is unknown until the corpus has real payloads in it.
  const reachable = new Set(real.cases.map((c) => c.platform)).size;
  if (real.cases.length === 0) {
    console.log('\n    ⚠  0 real payloads captured. Parser accuracy is UNKNOWN, not high.');
    console.log('       The Phase 1 capture gate cannot be claimed. Run: node tools/recon.js\n');
  } else {
    console.log(`\n    ${real.cases.length} real payloads across ${reachable} of 4 platforms.\n`);
  }
  assert.ok(true);
});
