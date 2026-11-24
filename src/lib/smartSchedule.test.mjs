// Run with: node --test src/lib/smartSchedule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarWeeks, dayTitle, dotSummary, formWindow, joinConfirmText, liveActions, masterScheduleLink, monthOfDate, shiftMonth, slotLabel,
} from './smartSchedule.js';
import { panelRange, sessionsInRange } from './masterScheduleDays.js';

test('calendar: Mon–Fri only, dots capped at 3 plus "+N", unavailable days carry the reason', () => {
  const days = [
    { date: '2026-11-23', available: true, reason: null, sessions: [{ time: '9:00–11:00 AM', occupancy: '2/5' }] },
    { date: '2026-11-24', available: false, reason: 'No free start on Nov 24. Sales User already has Training 9:00 AM–4:00 PM on Nov 24.', sessions: [1, 2, 3, 4, 5].map((i) => ({ time: `${i}`, occupancy: '1/5' })) },
  ];
  const weeks = calendarWeeks('2026-11', days);
  const cells = weeks.flat().filter(Boolean);
  assert.equal(cells.length, 21, 'November 2026 has 21 weekdays');
  assert.ok(cells.every((c) => ![0, 6].includes(new Date(`${c.date}T12:00:00Z`).getUTCDay())), 'no weekends');
  assert.equal(weeks[0].filter(Boolean)[0].date, '2026-11-02', 'Nov 1, 2026 is a Sunday: the first cell is Monday Nov 2');
  const mon = cells.find((c) => c.date === '2026-11-23');
  const tue = cells.find((c) => c.date === '2026-11-24');
  assert.deepEqual([mon.dots, mon.more, mon.available], [1, 0, true]);
  assert.deepEqual([tue.dots, tue.more, tue.available], [3, 2, false]);
  assert.match(dayTitle(tue, 'Orientation/Tasting'), /5 Orientation\/Tasting sessions/);
  assert.match(dayTitle(tue, 'Orientation/Tasting'), /No free start on Nov 24/);
  assert.equal(cells.find((c) => c.date === '2026-11-25').available, false, 'a day the API did not return is not pickable');
  assert.deepEqual(dotSummary(0), { dots: 0, more: 0 });
  assert.deepEqual(dotSummary(4), { dots: 3, more: 1 });
});

test('the day dot is red when a session there had an applicant who did not attend', () => {
  const weeks = calendarWeeks('2026-11', [
    { date: '2026-11-23', available: true, sessions: [{ time: '9:00–11:00 AM', occupancy: '3/5', did_not_attend: true }] },
    { date: '2026-11-24', available: true, sessions: [{ time: '9:00–11:00 AM', occupancy: '2/5', did_not_attend: false }] },
  ]);
  const cells = weeks.flat().filter(Boolean);
  const mon = cells.find((c) => c.date === '2026-11-23');
  const tue = cells.find((c) => c.date === '2026-11-24');
  assert.equal(mon.hasNoShow, true);
  assert.equal(tue.hasNoShow, false);
  assert.equal(cells.find((c) => c.date === '2026-11-25').hasNoShow, false, 'a day with no session has no red dot');
  assert.match(dayTitle(mon, 'Orientation/Tasting'), /did not attend/);
  assert.doesNotMatch(dayTitle(tue, 'Orientation/Tasting'), /did not attend/);
});

test('months, slots and the evaluate window', () => {
  assert.equal(monthOfDate('2026-12-04'), '2026-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
  assert.equal(slotLabel('09:00'), '9:00 AM');
  assert.equal(slotLabel('12:00'), '12:00 PM');
  assert.equal(slotLabel('17:00'), '5:00 PM');
  assert.deepEqual(formWindow({ start_date: '2026-11-23', start_hour: 14, start_minute: 0 }, 3), { start_at: '2026-11-23T14:00:00+08:00', end_at: '2026-11-23T17:00:00+08:00' });
  assert.equal(formWindow({ start_date: '', start_hour: 9, start_minute: 0 }, 2), null, 'nothing is checked until a day is picked');
});

test('live check actions: Join for a join target, Next available, Reassign for Admin only', () => {
  const blocked = { status: 'blocked', reasons: ['Sales User already has Orientation/Tasting 9:00–11:00 AM on Nov 21. Next free start: 12:00 PM (1-hour gap).'], merge_targets: [{ session_id: 7, time: 'Nov 21 9:00–11:00 AM', occupancy: '2/5' }] };
  const next = { date: '2026-11-21', time: '12:00', label: 'Fri, Nov 21 · 12:00–2:00 PM' };
  assert.deepEqual(liveActions(blocked, { isAdmin: true, nextAvailable: next }), { join: blocked.merge_targets[0], next, reassign: true });
  assert.equal(liveActions(blocked, { isAdmin: false, nextAvailable: next }).reassign, false, 'Reassign Sales is Admin only');
  const facility = { status: 'blocked', reasons: ['All 2 Training facilities are in use 2:00–3:00 PM on Nov 21.'], merge_targets: [] };
  assert.deepEqual(liveActions(facility, { isAdmin: true, nextAvailable: null }), { join: null, next: null, reassign: false });
  assert.deepEqual(liveActions({ status: 'ok', reasons: [] }), { join: null, next: null, reassign: false });
});

test('Join confirmation text and the Master Schedule link (Day view, session open)', () => {
  const row = { id: 12, date: '2026-11-23', activity_label: 'Training', date_label: 'Mon, Nov 23', time: '9:00 AM–12:00 PM', brand: { name: 'Daily Dash' }, occupancy: '0/1' };
  assert.equal(joinConfirmText(row, 'Ana Cruz'), 'Add Ana Cruz to Training on Mon, Nov 23 · 9:00 AM–12:00 PM · Daily Dash (0/1)?');
  const link = new URL(masterScheduleLink(row), 'http://x');
  assert.equal(link.pathname, '/activities');
  assert.deepEqual(Object.fromEntries(link.searchParams), { view: 'master-schedule', mode: 'day', date: '2026-11-23', session: '12' });
});

test('Master Schedule panels count exactly the displayed range (day / shown week days / month)', () => {
  const month = { from: '2026-11-01T00:00:00+08:00', to: '2026-12-01T00:00:00+08:00' };
  assert.deepEqual(panelRange('day', '2026-11-18', '2026-11-16', month), { from: '2026-11-18T00:00:00+08:00', to: '2026-11-19T00:00:00+08:00' });
  assert.deepEqual(panelRange('week', '2026-11-16', '2026-11-16', month), { from: '2026-11-16T00:00:00+08:00', to: '2026-11-21T00:00:00+08:00' });
  assert.equal(panelRange('month', '2026-11-18', '2026-11-16', month), month);
  const sessions = [
    { id: 1, start_at: '2026-11-18T09:00:00+08:00', end_at: '2026-11-18T11:00:00+08:00' },
    { id: 2, start_at: '2026-11-19T09:00:00+08:00', end_at: '2026-11-19T11:00:00+08:00' },
    { id: 3, start_at: '2026-11-23T09:00:00+08:00', end_at: '2026-11-23T11:00:00+08:00' },
  ];
  assert.deepEqual(sessionsInRange(sessions, panelRange('day', '2026-11-18', '2026-11-16', month)).map((s) => s.id), [1]);
  assert.deepEqual(sessionsInRange(sessions, panelRange('week', '2026-11-16', '2026-11-16', month)).map((s) => s.id), [1, 2], 'next week is not counted');
});
