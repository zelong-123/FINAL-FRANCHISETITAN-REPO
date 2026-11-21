import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayDots, isOutsideHours, manilaToday, panelCounts, mondayOf, monthWeeks, shiftBusinessDay, shiftMonth, weekDays, weekdayOf,
} from './masterScheduleDays.js';

test('weekday and Monday arithmetic use calendar dates', () => {
  assert.equal(weekdayOf('2026-11-16'), 1); // Monday
  assert.equal(weekdayOf('2026-11-22'), 0); // Sunday
  assert.equal(mondayOf('2026-11-22'), '2026-11-16');
  assert.deepEqual(weekDays('2026-11-18'), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
});

test('prev/next day skips weekends in both directions', () => {
  assert.equal(shiftBusinessDay('2026-11-20', 1), '2026-11-23'); // Fri -> Mon
  assert.equal(shiftBusinessDay('2026-11-23', -1), '2026-11-20'); // Mon -> Fri
  assert.equal(shiftBusinessDay('2026-11-18', 1), '2026-11-19');
});

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('month shifting wraps the year', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
});

test('mini calendar shows Mon-Fri only, with blanks for other weekdays', () => {
  const weeks = monthWeeks('2026-11'); // Nov 1 2026 is a Sunday
  assert.equal(weeks[0][0], '2026-11-02'); // Nov 1 is a Sunday, so the first Monday is Nov 2
  assert.equal(weeks[0][1], '2026-11-03');
  assert.equal(weeks[0][4], '2026-11-06');
  for (const week of weeks) assert.equal(week.length, 5);
  assert.equal(weeks.flat().filter(Boolean).length, 21); // Nov 2026 has 21 weekdays
});

test('dots cap at four and report the remainder', () => {
  const sessions = [
    { start_at: '2026-11-18T01:00:00Z', participant_count: 3 }, // 09:00 Manila
    { start_at: '2026-11-18T05:00:00Z', participant_count: 3 },
    { start_at: '2026-11-19T01:00:00Z', participant_count: 2 },
  ];
  assert.deepEqual(dayDots(sessions, '2026-11-18'), { count: 6, dots: 4, more: 2, done: 0 });
  assert.deepEqual(dayDots(sessions, '2026-11-19'), { count: 2, dots: 2, more: 0, done: 0 });
  assert.deepEqual(dayDots(sessions, '2026-11-20'), { count: 0, dots: 0, more: 0, done: 0 });
});

test('completed sessions are counted as done (blue), scheduled ones are not', () => {
  const sessions = [
    { start_at: '2026-11-18T01:00:00Z', participant_count: 2, status: 'completed' },
    { start_at: '2026-11-18T03:00:00Z', participant_count: 3, status: 'confirmed' },
  ];
  assert.deepEqual(dayDots(sessions, '2026-11-18'), { count: 5, dots: 4, more: 1, done: 2 });
});

test('sessions outside 9 AM-5 PM Manila are flagged, inside ones are not', () => {
  // 9:00 AM to 11:00 AM Manila is inside; 7:30 AM start is outside; 4:30 PM to 6:00 PM ends outside.
  assert.equal(isOutsideHours({ start_at: '2026-11-18T01:00:00Z', end_at: '2026-11-18T03:00:00Z' }), false);
  assert.equal(isOutsideHours({ start_at: '2026-11-17T23:30:00Z', end_at: '2026-11-18T01:00:00Z' }), true);
  assert.equal(isOutsideHours({ start_at: '2026-11-18T08:30:00Z', end_at: '2026-11-18T10:00:00Z' }), true);
});

test('panel counts fall back to the loaded list when the summary is missing', () => {
  const sessions = [
    { status: 'confirmed', activity_type: 'orientation' },
    { status: 'pending', activity_type: 'training' },
    { status: 'confirmed', activity_type: 'training' },
  ];
  // 404 / 500 from /schedule-sessions/summary -> summary is null.
  const fallback = panelCounts(null, sessions);
  assert.equal(fallback.source, 'list');
  assert.deepEqual(fallback.status, { confirmed: 2, pending: 1 });
  assert.deepEqual(fallback.activity, { orientation: 1, training: 2 });
  // Summary present -> it wins.
  const live = panelCounts({ status_counts: { confirmed: 9 }, activity_counts: { orientation: 4, training: 5 } }, sessions);
  assert.equal(live.source, 'summary');
  assert.deepEqual(live.activity, { orientation: 4, training: 5 });
});

test('a Manila late-night time stays on the Manila date', () => {
  // 23:30 Manila on Nov 18 is 15:30 UTC on Nov 18.
  assert.equal(manilaToday(new Date('2026-11-18T15:30:00Z')), '2026-11-18');
  // 00:30 Manila on Nov 19 is still Nov 18 in UTC.
  assert.equal(manilaToday(new Date('2026-11-18T16:30:00Z')), '2026-11-19');
});
