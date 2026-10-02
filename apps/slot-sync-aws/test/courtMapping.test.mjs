import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otherTargets } from '../src/lib/courtMapping.mjs';

test('otherTargets excludes the source platform and platforms with no court name', () => {
  const mapping = {
    canonicalCourt: 'turf-a',
    hudle: 'Football Court 1',
    playo: 'Turf A',
    khelomore: '', // not actually mapped there
    enabledPlatforms: ['hudle', 'playo', 'khelomore'],
  };

  const targets = otherTargets(mapping, 'hudle');

  assert.deepEqual(
    targets.map((t) => t.platform).sort(),
    ['playo'],
  );
  assert.equal(targets[0].courtName, 'Turf A');
});

test('otherTargets returns nothing when only the source platform is enabled', () => {
  const mapping = {
    canonicalCourt: 'turf-a',
    hudle: 'Football Court 1',
    enabledPlatforms: ['hudle'],
  };

  assert.deepEqual(otherTargets(mapping, 'hudle'), []);
});
