// Working days for the supply workflow: Monday to Friday, in Manila time. Holidays are not tracked.
// (The activity scheduler has its own rules; this helper is only for supply dates and SLAs.)

/** 'YYYY-MM-DD' for an instant, in Manila. */
export function manilaDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(at);
}

const parse = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday, for a calendar date. */
export const weekday = (day: string) => parse(day).getUTCDay();
export const isWeekend = (day: string) => [0, 6].includes(weekday(day));

export function addDays(day: string, n: number): string {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

/** The date `n` working days after `day` (n = 0 returns `day`). */
export function addWorkingDays(day: string, n: number): string {
  let current = day.slice(0, 10);
  let left = n;
  while (left > 0) {
    current = addDays(current, 1);
    if (!isWeekend(current)) left -= 1;
  }
  return current;
}

/** A request made on a weekend counts as received on the next Monday. */
export function nextWorkingDayOrSame(day: string): string {
  let current = day.slice(0, 10);
  while (isWeekend(current)) current = addDays(current, 1);
  return current;
}

/**
 * Earliest target delivery date for a request made on `requestDay`:
 * normal requests need `leadDays` working days (Mon→Wed, Thu→Mon, Fri→Tue, Sat/Sun→Wed with 2);
 * urgent and critical requests may ask for the next working day.
 */
export function earliestTargetDate(requestDay: string, leadDays: number, urgent = false): string {
  if (urgent) return addWorkingDays(requestDay, 1);
  return addWorkingDays(nextWorkingDayOrSame(requestDay), leadDays);
}

/** True when `today` is later than one working day after `startDay` (e.g. Mon start → overdue from Wed). */
export function pastOneWorkingDay(startDay: string, today: string): boolean {
  return today > addWorkingDays(nextWorkingDayOrSame(startDay), 1);
}
