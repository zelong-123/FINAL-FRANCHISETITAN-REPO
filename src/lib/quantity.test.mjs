import test from 'node:test';
import assert from 'node:assert/strict';
import { formatQuantity } from './quantity.js';

test('large grams and millilitres read as kg and L', () => {
  assert.equal(formatQuantity(187782.86, 'g'), '187.78 kg');
  assert.equal(formatQuantity(43908.57, 'ml'), '43.91 L');
});

test('pieces stay pieces, with a thousands separator and up to 2 decimals', () => {
  assert.equal(formatQuantity(450, 'pcs'), '450 pcs');
  assert.equal(formatQuantity(1250.5, 'pcs'), '1,250.5 pcs');
  assert.equal(formatQuantity(353316.567, 'bottle'), '353,316.57 bottle');
});

test('a reference value keeps one material in one unit', () => {
  assert.equal(formatQuantity(800, 'g'), '800 g');
  assert.equal(formatQuantity(800, 'g', 1000), '0.8 kg');
  assert.equal(formatQuantity(0, 'ml', 5000), '0 L');
});

test('default levels per unit match the server table', async () => {
  const { defaultLevelsFor } = await import('./quantity.js');
  assert.deepEqual(defaultLevelsFor('g'), { low: 5000, critical: 1000 });
  assert.deepEqual(defaultLevelsFor('L'), { low: 5, critical: 1 });
  assert.deepEqual(defaultLevelsFor('pcs'), { low: 50, critical: 10 });
});
