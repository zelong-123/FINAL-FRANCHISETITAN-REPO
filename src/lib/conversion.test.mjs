// Run with: node --test src/lib/conversion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPercent, conversionRatePercent, formatPercent, kpiConversionRate } from './conversion.js';

test('normal ratios', () => {
  assert.equal(conversionRatePercent(3, 3), 100);
  assert.equal(conversionRatePercent(1, 3), 33.33);
  assert.equal(conversionRatePercent(2, 3), 66.67);
  assert.equal(conversionRatePercent(0, 3), 0);
});

test('zero or invalid denominator gives 0, never NaN/Infinity', () => {
  assert.equal(conversionRatePercent(0, 0), 0);
  assert.equal(conversionRatePercent(5, 0), 0);
  assert.equal(conversionRatePercent(1, -2), 0);
  assert.equal(conversionRatePercent(undefined, undefined), 0);
  assert.equal(conversionRatePercent('x', 3), 0);
});

test('guard clamps impossible inputs into [0, 100]', () => {
  assert.equal(conversionRatePercent(10, 3), 100);
  assert.equal(conversionRatePercent(-1, 3), 0);
  assert.equal(clampPercent(333.33), 100);
  assert.equal(clampPercent(-4), 0);
  assert.equal(clampPercent(NaN), 0);
  assert.equal(clampPercent(Infinity), 0);
});

test('formatting: at most 2 decimals, 100% not 100.00%', () => {
  assert.equal(formatPercent(100), '100%');
  assert.equal(formatPercent(66.666), '66.67%');
  assert.equal(formatPercent(33.33), '33.33%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(333.33), '100%');
});

test('KPI payload prefers numerator/denominator, falls back to clamped percent', () => {
  assert.equal(kpiConversionRate({ conversion_converted: 1, conversion_total: 3, conversion_rate_percent: 999 }), 33.33);
  assert.equal(kpiConversionRate({ conversion_converted: 0, conversion_total: 0 }), 0);
  assert.equal(kpiConversionRate({ conversion_rate_percent: 333.33 }), 100);
  assert.equal(kpiConversionRate(null), 0);
});
