// Run with: node --test src/lib/stepperProgress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loiHalves, qualificationFill } from './stepperProgress.js';

test('Qualification line fills by accepted requirements: 0/4, 1/4, 2/4, 3/4, 4/4', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => qualificationFill(n, 4)), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(qualificationFill(0, 0), null, 'no config: no fill');
});

test('LOI → Payment Record line: one half per verified item, in any order', () => {
  assert.deepEqual(loiHalves({ loiVerified: false, siteVerified: false }), { left: false, right: false, ratio: 0 });
  assert.deepEqual(loiHalves({ loiVerified: true, siteVerified: false }), { left: true, right: false, ratio: 0.5 });
  assert.deepEqual(loiHalves({ loiVerified: false, siteVerified: true }), { left: false, right: true, ratio: 0.5 });
  assert.deepEqual(loiHalves({ loiVerified: true, siteVerified: true }), { left: true, right: true, ratio: 1 });
});
