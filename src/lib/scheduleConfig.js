/*
 * The scheduling window for every time picker — loaded from the API
 * (GET /schedule-sessions/config → App\Support\ScheduleWindow, the same values
 * the save check reads). Until it arrives the defaults below apply, and they
 * equal the backend defaults: Monday–Friday, 9:00 AM–6:00 PM.
 *
 * Plain module (no React, no API import) so the pure rules and their node tests
 * can read it; the React hook that loads it lives in useScheduleConfig.js.
 */
export const DEFAULT_SCHEDULE_CONFIG = {
  opens_at: '09:00',
  closes_at: '18:00',
  last_start: '17:00',
  working_days: [1, 2, 3, 4, 5],
  days_label: 'Monday to Friday',
  step_minutes: 30,
  default_duration_minutes: { orientation: 120, product_tasting: 120, training: 180 },
};

let current = DEFAULT_SCHEDULE_CONFIG;
const listeners = new Set();

export const getScheduleConfig = () => current;

export function setScheduleConfig(next) {
  current = { ...DEFAULT_SCHEDULE_CONFIG, ...(next || {}) };
  listeners.forEach((listener) => listener());
}

export function subscribeScheduleConfig(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "09:30" → 570 */
export function toMinutes(time) {
  const [h, m] = String(time || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export const opensMinutes = () => toMinutes(current.opens_at);
export const closesMinutes = () => toMinutes(current.closes_at);
/** Latest start that still fits one whole hour before closing. */
export const lastStartMinutes = () => closesMinutes() - 60;

/** 570 → "9:30 AM" */
export function minutesLabel(total) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** "YYYY-MM-DD" → is it a configured working day? (ISO weekday 1 = Monday … 7 = Sunday) */
export function isWorkingDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const [y, m, d] = date.split('-').map(Number);
  const js = new Date(y, m - 1, d).getDay();
  return current.working_days.includes(js === 0 ? 7 : js);
}

/** JS Date → is it a configured working day? */
export function isWorkingDay(dateObject) {
  const js = dateObject.getDay();
  return current.working_days.includes(js === 0 ? 7 : js);
}
