// Run with: node --test src/lib/stockView.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastCountLabel, sortWorstFirst, stockStatusOf, toMilli, varianceText } from './stockView.js';

test('status rule matches the API: out, critical, low, ok (at the level counts as that level)', () => {
  assert.equal(stockStatusOf(0, 5, 2), 'out');
  assert.equal(stockStatusOf(2, 5, 2), 'critical');
  assert.equal(stockStatusOf(5, 5, 2), 'low');
  assert.equal(stockStatusOf(5.01, 5, 2), 'ok');
});

test('worst status first, then name', () => {
  const rows = [{ name: 'B', status: 'ok' }, { name: 'A', status: 'low' }, { name: 'C', status: 'out' }, { name: 'A2', status: 'critical' }, { name: 'A', status: 'ok' }];
  assert.deepEqual(sortWorstFirst(rows).map((r) => `${r.status}:${r.name}`), ['out:C', 'critical:A2', 'low:A', 'ok:A', 'ok:B']);
});

test('last count label in Manila days', () => {
  const now = new Date('2026-11-15T13:10:00Z'); // 9:10 PM in Manila
  assert.equal(lastCountLabel(null, now), 'Never');
  assert.match(lastCountLabel('2026-11-15T13:10:00Z', now), /^Today, 9:10\sPM$/);
  assert.equal(lastCountLabel('2026-11-14T02:00:00Z', now), 'Yesterday');
  assert.equal(lastCountLabel('2026-11-12T02:00:00Z', now), '3 days ago');
});

test('variance text and milli conversion', () => {
  assert.deepEqual(varianceText('', 1, 'L'), { text: '—', tone: 'none' });
  assert.deepEqual(varianceText('9.5', 11.08, 'L'), { text: '-1.58 L', tone: 'down' });
  assert.deepEqual(varianceText('83', 83, 'pcs'), { text: 'No change', tone: 'zero' });
  assert.deepEqual(varianceText('12', 10, 'kg'), { text: '+2 kg', tone: 'up' });
  assert.equal(toMilli('1.234'), 1234);
  assert.equal(toMilli('0.1'), 100);
});
