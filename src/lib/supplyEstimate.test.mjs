import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateNotice } from './supplyEstimate.js';

const line = (suggested, over = false, unit = 'L') => ({ suggested_quantity: suggested, over_bulk: over, unit });

test('a zero suggestion reads as no additional quantity recommended', () => {
  const notice = estimateNotice(line(0, true));
  assert.equal(notice.tone, 'warning');
  assert.equal(notice.text, 'No additional quantity recommended');
  assert.match(notice.detail, /7-day requirement/);
  assert.match(notice.detail, /justification/);
});

test('a zero suggestion without the bulk flag says nothing', () => {
  assert.equal(estimateNotice(line(0, false)), null);
});

test('a missing suggestion is unavailable, never "already covered"', () => {
  for (const value of [null, undefined, '']) {
    const notice = estimateNotice(line(value));
    assert.equal(notice.tone, 'neutral');
    assert.equal(notice.text, 'Estimate unavailable');
    assert.match(notice.detail, /No 7-day estimate/);
    assert.doesNotMatch(`${notice.text} ${notice.detail}`, /already covers/i);
  }
});

test('a positive suggestion above the threshold keeps the percentage wording', () => {
  assert.equal(estimateNotice(line(4, true)).text, 'More than 50% above the suggestion');
  assert.equal(estimateNotice(line(4, true), 40).text, 'More than 40% above the suggestion');
  assert.equal(estimateNotice(line(4, true)).detail, 'Suggested 4 L for 1 week.');
});

test('a suggestion within the threshold and an empty line say nothing', () => {
  assert.equal(estimateNotice(line(4, false)), null);
  assert.equal(estimateNotice(undefined), null);
});
