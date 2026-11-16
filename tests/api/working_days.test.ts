// Working days (Mon–Fri) for supply target dates and the overdue rules. 2026-11-09 is a Monday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWorkingDays, earliestTargetDate, isWeekend, manilaDate, pastOneWorkingDay } from '../../supabase/functions/api/services/workingDays.ts';
import { overdueReason } from '../../supabase/functions/api/services/supplyWorkflow.ts';

const MON = '2026-11-09';
const THU = '2026-11-12';
const FRI = '2026-11-13';
const SAT = '2026-11-14';
const SUN = '2026-11-15';

test('earliest target date: 2 working days, weekends count from Monday', () => {
  assert.equal(earliestTargetDate(MON, 2), '2026-11-11', 'Mon → Wed');
  assert.equal(earliestTargetDate(THU, 2), '2026-11-16', 'Thu → Mon');
  assert.equal(earliestTargetDate(FRI, 2), '2026-11-17', 'Fri → Tue');
  assert.equal(earliestTargetDate(SAT, 2), '2026-11-18', 'Sat → Wed');
  assert.equal(earliestTargetDate(SUN, 2), '2026-11-18', 'Sun → Wed');
  assert.equal(earliestTargetDate(MON, 3), '2026-11-12', 'the lead time is a setting');
});

test('urgent and critical may ask for the next working day', () => {
  assert.equal(earliestTargetDate(MON, 2, true), '2026-11-10', 'Mon → Tue');
  assert.equal(earliestTargetDate(THU, 2, true), '2026-11-13', 'Thu → Fri');
  assert.equal(earliestTargetDate(FRI, 2, true), '2026-11-16', 'Fri → Mon');
  assert.equal(earliestTargetDate(SAT, 2, true), '2026-11-16', 'Sat → Mon');
  assert.equal(earliestTargetDate(SUN, 2, true), '2026-11-16', 'Sun → Mon');
});

test('helpers: weekends, adding working days and the Manila date', () => {
  assert.equal(isWeekend(SAT), true);
  assert.equal(isWeekend(SUN), true);
  assert.equal(isWeekend(FRI), false);
  assert.equal(addWorkingDays(FRI, 1), '2026-11-16');
  assert.equal(addWorkingDays(FRI, 0), FRI);
  assert.equal(manilaDate(new Date('2026-11-09T16:30:00Z')), '2026-11-10', 'past 4 pm UTC is the next day in Manila');
});

test('one working day: Monday work is overdue from Wednesday, Friday work from Tuesday', () => {
  assert.equal(pastOneWorkingDay(MON, '2026-11-10'), false);
  assert.equal(pastOneWorkingDay(MON, '2026-11-11'), true);
  assert.equal(pastOneWorkingDay(FRI, SAT), false);
  assert.equal(pastOneWorkingDay(FRI, '2026-11-16'), false);
  assert.equal(pastOneWorkingDay(FRI, '2026-11-17'), true);
  assert.equal(pastOneWorkingDay(SAT, '2026-11-17'), false, 'a weekend start counts from Monday');
  assert.equal(pastOneWorkingDay(SAT, '2026-11-18'), true);
});

test('overdue rules per status', () => {
  const at = (day: string) => `${day}T02:00:00Z`; // 10 am in Manila
  assert.equal(overdueReason({ status: 'submitted', status_changed_at: at(MON) }, {}, '2026-11-10'), null);
  assert.match(overdueReason({ status: 'under_review', status_changed_at: at(MON) }, {}, '2026-11-11')!, /Admin/);
  assert.match(overdueReason({ status: 'waiting_logistics', status_changed_at: at(FRI) }, {}, '2026-11-17')!, /Logistics/);
  assert.equal(overdueReason({ status: 'waiting_logistics', status_changed_at: at(FRI) }, {}, '2026-11-16'), null);
  assert.match(overdueReason({ status: 'scheduled', status_changed_at: at(MON) }, { pendingDateAt: at(MON) }, '2026-11-11')!, /Admin has not answered/);
  assert.equal(overdueReason({ status: 'scheduled', status_changed_at: at(MON) }, {}, '2026-11-20'), null, 'a scheduled request waits for its date');
  assert.match(overdueReason({ status: 'on_hold', expected_restock_date: MON }, {}, '2026-11-10')!, /restock/);
  assert.equal(overdueReason({ status: 'on_hold', expected_restock_date: MON }, {}, MON), null);
  assert.match(overdueReason({ status: 'dispatched' }, { etaAt: at(MON), pod: false }, '2026-11-11')!, /POD/);
  assert.equal(overdueReason({ status: 'dispatched' }, { etaAt: at(MON), pod: true }, '2026-11-11'), null);
  assert.equal(overdueReason({ status: 'delivered', status_changed_at: at(MON) }, { pod: true }, '2026-11-30'), null, 'branch receipt gets a reminder, not overdue');
});
