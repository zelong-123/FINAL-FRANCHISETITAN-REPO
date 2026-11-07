// Run with: node --test src/lib/scheduleSessions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMinutes, brandCheck, isBeforeScheduledDay, manilaIso, minutesBetween, sessionPayload, splitManila } from './scheduleSessions.js';

test('Manila time round trip', () => {
  assert.equal(manilaIso('2026-11-16', '13:00'), '2026-11-16T13:00:00+08:00');
  assert.deepEqual(splitManila('2026-11-16T05:00:00Z'), { date: '2026-11-16', time: '13:00' });
  assert.equal(manilaIso('', '13:00'), '');
});

test('end time follows the default duration', () => {
  assert.equal(addMinutes('13:00', 120), '15:00');
  assert.equal(addMinutes('09:30', 180), '12:30');
  assert.equal(minutesBetween('10:00', '13:00'), 180);
});

test('brand check names who is missing or different (tasting/training only)', () => {
  const ana = { id: 1, full_name: 'Ana', preferred_brand_id: 1 };
  const ben = { id: 2, full_name: 'Ben', preferred_brand_id: 2 };
  const dee = { id: 3, full_name: 'Dee', preferred_brand_id: null };

  assert.deepEqual(brandCheck('orientation', null, [ana, ben, dee]).missing, []);
  const tasting = brandCheck('product_tasting', null, [ana, ben, dee]);
  assert.deepEqual(tasting.missing.map((a) => a.id), [3]);
  assert.deepEqual(tasting.mismatched.map((a) => a.id), [1, 2]);
  assert.equal(brandCheck('training', null, [ana]).commonBrandId, 1);
  assert.deepEqual(brandCheck('training', 1, [ana, ben]).mismatched.map((a) => a.id), [2]);
});

test('payload drops the brand for orientation', () => {
  const form = { activity_type: 'orientation', brand_id: '3', date: '2026-11-16', start: '10:00', end: '12:00', handler_id: '5', venue: '', max_capacity: '' };
  const payload = sessionPayload(form);
  assert.equal(payload.brand_id, null);
  assert.equal(payload.handler_id, 5);
  assert.equal(payload.venue, null);
  assert.equal(sessionPayload({ ...form, activity_type: 'training' }).brand_id, 3);
});

test('early completion is judged by the Manila day, not the hour', () => {
  // Now: Nov 5, 23:30 Manila (15:30Z).
  const now = new Date('2026-11-05T15:30:00Z');
  assert.equal(isBeforeScheduledDay('2026-11-19T11:00:00+08:00', now), true);
  // Nov 6 00:30 Manila is tomorrow in Manila, even though it is still Nov 5 in UTC.
  assert.equal(isBeforeScheduledDay('2026-11-05T16:30:00Z', now), true);
  // Same Manila day (later hour) and past days need no confirmation.
  assert.equal(isBeforeScheduledDay('2026-11-05T23:59:00+08:00', now), false);
  assert.equal(isBeforeScheduledDay('2026-11-01T09:00:00+08:00', now), false);
  assert.equal(isBeforeScheduledDay(null, now), false);
});
