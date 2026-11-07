// Run with: node --test src/lib/scheduleRules.test.mjs
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCHEDULE_CONFIG, setScheduleConfig } from './scheduleConfig.js';
import { buildScheduleWindow, isValidStart, maxHoursFor, startHours } from './scheduleRules.js';

afterEach(() => setScheduleConfig(DEFAULT_SCHEDULE_CONFIG));

const form = (date, hour, minute, hours) => ({ start_date: date, start_hour: hour, start_minute: minute, duration_choice: String(hours), custom_hours: '' });
// 2030-01-07 is a Monday; 2030-01-12 a Saturday.
const MONDAY = '2030-01-07';
const SATURDAY = '2030-01-12';

test('defaults: Mon–Fri, 9:00 AM–6:00 PM, same messages as before', () => {
  assert.deepEqual(startHours(), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(maxHoursFor(15, 0), 3);
  assert.equal(isValidStart(17, 30), false);
  assert.throws(() => buildScheduleWindow(form(SATURDAY, 9, 0, 1)), /Activities can only be scheduled Monday to Friday\./);
  assert.throws(() => buildScheduleWindow(form(MONDAY, 17, 30, 1)), /No whole-hour duration fits before 6:00 PM, so this start time cannot be used\. The last valid start time is 5:00 PM\./);
  assert.throws(() => buildScheduleWindow(form(MONDAY, 16, 0, 3)), /only allows up to 2 hrs before 6:00 PM/);
  assert.equal(buildScheduleWindow(form(MONDAY, 15, 0, 3)).duration_minutes, 180);
});

test('a changed config moves the picker and its checks with it', () => {
  setScheduleConfig({ opens_at: '08:00', closes_at: '17:00', last_start: '16:00', working_days: [1, 2, 3, 4, 5, 6], days_label: 'Monday to Saturday' });
  assert.deepEqual(startHours(), [8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(buildScheduleWindow(form(SATURDAY, 8, 0, 2)).starts_at, '2030-01-12 08:00:00');
  assert.throws(() => buildScheduleWindow(form(MONDAY, 16, 30, 1)), /before 5:00 PM.*The last valid start time is 4:00 PM\./);
  assert.throws(() => buildScheduleWindow(form('2030-01-13', 9, 0, 1)), /Monday to Saturday/);
});
