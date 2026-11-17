import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followUpChip, followUpFormErrors, holdFormErrors, manilaDayOffset, reasonLabel, splitStatusFilter } from './followUpState.js';

test('chips: label, days and whether Admin can remind from it', () => {
  assert.equal(followUpChip(null), null);
  assert.equal(followUpChip({ state: null }), null);
  const overdue = followUpChip({ state: 'overdue', days: 9, tooltip: '9 days in Scheduled, last update Nov 5 by Sales User' });
  assert.deepEqual([overdue.text, overdue.tone, overdue.remindable], ['Overdue · 9d', 'overdue', true]);
  assert.match(overdue.tooltip, /^9 days in Scheduled/);
  assert.deepEqual([followUpChip({ state: 'stalled', days: 15 }).text, followUpChip({ state: 'stalled', days: 15 }).remindable], ['Stalled · 15d', true]);
  assert.deepEqual([followUpChip({ state: 'waiting_admin', days: 3 }).text, followUpChip({ state: 'waiting_admin', days: 3 }).remindable], ['Waiting on Admin · 3d', false]);
  assert.equal(followUpChip({ state: 'waiting_admin', days: 0 }).text, 'Waiting on Admin');
  assert.equal(followUpChip({ state: 'on_hold' }).text, 'On hold');
});

test('the status filter keeps stages and follow-up states apart', () => {
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
