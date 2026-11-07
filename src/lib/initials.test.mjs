// Run with: node --test src/lib/initials.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialsOf } from './initials.js';

test('uses first letter of the first two words', () => {
  assert.equal(initialsOf('Leigh Hannah Amora'), 'LH');
  assert.equal(initialsOf('Reje Cuaresma'), 'RC');
  assert.equal(initialsOf('jasper jades'), 'JJ');
});

test('single-word name gives one letter', () => {
  assert.equal(initialsOf('Cher'), 'C');
});

test('empty or placeholder gives ?', () => {
  assert.equal(initialsOf(''), '?');
  assert.equal(initialsOf(undefined), '?');
  assert.equal(initialsOf('\u2014'), '?');
});

test('extra whitespace is ignored', () => {
  assert.equal(initialsOf('  Leigh   Hannah  Amora '), 'LH');
});

// Regression: two people on the same day. Each avatar must derive from its own name.
test('two people on the same day each get their own initials', () => {
  const day = [
    { person: 'Leigh Hannah Amora', title: 'Product Tasting' },
    { person: 'Earl Agustin', title: 'Orientation' },
  ];
  assert.deepEqual(day.map((item) => initialsOf(item.person)), ['LH', 'EA']);
});
