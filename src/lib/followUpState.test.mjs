import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_UP_SECTION_ID, FOLLOW_UP_STATES, followUpChip, followUpFormErrors, holdFormErrors, manilaDayOffset, reasonLabel, splitStatusFilter,
} from './followUpState.js';

test('no chip when on track, waiting for Admin or closed; never "On track" or "Waiting on Admin"', () => {
  assert.equal(followUpChip(null), null);
  assert.equal(followUpChip({ state: null }), null);
  assert.equal(followUpChip({ state: 'waiting_admin', days: 3 }), null, 'Waiting on Admin is gone');
  assert.deepEqual(Object.keys(FOLLOW_UP_STATES), ['overdue', 'stalled', 'on_hold'], 'no Waiting on Admin filter');
});

test('Overdue, Stalled and On hold labels, colors and icons', () => {
  const overdue = followUpChip({ state: 'overdue', days: 12, tooltip: '12 days in Scheduled, last update Nov 5 by Sales User' });
  assert.deepEqual([overdue.text, overdue.tone, overdue.icon], ['Overdue · 12d', 'overdue', 'clock']);
  assert.match(overdue.tooltip, /^12 days in Scheduled/);
  const stalled = followUpChip({ state: 'stalled', days: 15 });
  assert.deepEqual([stalled.text, stalled.tone, stalled.icon], ['Stalled · 15d', 'stalled', 'warning']);
  const hold = followUpChip({ state: 'on_hold', tooltip: 'On hold until Nov 30' });
  assert.deepEqual([hold.text, hold.tone, hold.icon, hold.tooltip], ['On hold', 'hold', 'pause', 'On hold until Nov 30']);
});

test('after a reminder: "Reminder sent" for Admin, "Reminder from Admin" for Sales; amber for Overdue, red stays for Stalled', () => {
  const reminder = { at: '2026-11-18T02:30:00Z', by: 'System Administrator' };
  const overdue = { state: 'overdue', days: 12, reminded: true, last_reminder: reminder };
  assert.deepEqual([followUpChip(overdue, 'admin').text, followUpChip(overdue, 'admin').tone, followUpChip(overdue, 'admin').icon], ['Reminder sent · 12d', 'reminded', 'bell']);
  assert.equal(followUpChip(overdue, 'sales').text, 'Reminder from Admin · 12d');
  assert.equal(followUpChip(overdue, 'admin').tooltip, 'Reminder sent by System Administrator · Nov 18, 2026, 10:30 AM');
  const stalled = { state: 'stalled', days: 15, reminded: true, last_reminder: reminder };
  assert.deepEqual([followUpChip(stalled, 'admin').text, followUpChip(stalled, 'admin').tone], ['Reminder sent · 15d', 'stalled']);
  assert.equal(followUpChip(stalled, 'sales').text, 'Reminder from Admin · 15d');
  assert.equal(followUpChip({ ...overdue, reminded: false }, 'admin').text, 'Overdue · 12d', 'an older reminder does not count');
});

test('the chip leads to the Follow-up section; the status filter keeps stages and follow-up states apart', () => {
  assert.equal(FOLLOW_UP_SECTION_ID, 'ap-follow-up');
  assert.deepEqual(splitStatusFilter('scheduled'), { status: 'scheduled', follow_up: '' });
  assert.deepEqual(splitStatusFilter('follow_up:stalled'), { status: '', follow_up: 'stalled' });
  assert.deepEqual(splitStatusFilter(''), { status: '', follow_up: '' });
});

test('Log follow-up and hold forms: reason, Other needs a note, no past dates', () => {
  const today = '2026-11-18';
  assert.deepEqual(Object.keys(followUpFormErrors({ reason: '', next_action_date: '' }, today)).sort(), ['next_action_date', 'reason']);
  assert.match(followUpFormErrors({ reason: 'not_responding', next_action_date: '2026-11-17' }, today).next_action_date, /past/);
  assert.deepEqual(followUpFormErrors({ reason: 'not_responding', next_action_date: today }, today), {}, 'today is allowed');
  assert.ok(followUpFormErrors({ reason: 'other', notes: 'x', next_action_date: today }, today).notes);
  assert.equal(reasonLabel('still_deciding'), 'Applicant still deciding');
  assert.ok(holdFormErrors({ reason: 'Abroad until December', until: today }, today).until, 'must end after today');
  assert.deepEqual(holdFormErrors({ reason: 'Abroad until December', until: '2026-11-30' }, today), {});
  assert.match(manilaDayOffset(1, new Date('2026-11-18T00:00:00+08:00')), /^2026-11-19$/);
});
