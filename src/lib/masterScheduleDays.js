/*
 * Pure date helpers for the Master Schedule (Day / Week / Month views).
 * Dates are "YYYY-MM-DD" strings in the schedule's own timezone (Asia/Manila),
 * so the logic is the same in every browser and is testable without a DOM.
 */

const TZ = 'Asia/Manila';

/** Today's date in Manila as "YYYY-MM-DD". */
export function manilaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Day of week for "YYYY-MM-DD": 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const isWeekend = (date) => [0, 6].includes(weekdayOf(date));

/** Adds days to a "YYYY-MM-DD" date (calendar arithmetic, no timezone drift). */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Previous/next business day: weekends are skipped. */
export function shiftBusinessDay(date, step) {
  let next = addDays(date, step);
  while (isWeekend(next)) next = addDays(next, step);
  return next;
}

/** Monday of the week containing `date`. */
export function mondayOf(date) {
  const day = weekdayOf(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

/** The Mon-Fri dates of the week containing `date`. */
export function weekDays(date) {
  const monday = mondayOf(date);
  return [0, 1, 2, 3, 4].map((offset) => addDays(monday, offset));
}

/** "YYYY-MM" of a date. */
export const monthOf = (date) => date.slice(0, 7);

/** Shifts a "YYYY-MM" month by `step` months. */
export function shiftMonth(month, step) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + step, 1)).toISOString().slice(0, 7);
}

/**
 * Mini calendar grid for one month: rows of Mon-Fri cells. Cells outside the
 * month are null so the grid keeps its shape; weekend days are not included.
 */
export function monthWeeks(month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = [];
  let week = [null, null, null, null, null];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const weekday = weekdayOf(date);
    if (weekday === 0 || weekday === 6) continue;
    week[weekday - 1] = date;
    if (weekday === 5) {
      weeks.push(week);
      week = [null, null, null, null, null];
    }
  }
  if (week.some(Boolean)) weeks.push(week);
  return weeks;
}

/**
 * Dots under a mini-calendar day: one per scheduled applicant, capped at 4,
 * with the rest shown as "+N". Input: sessions with start_at and participant_count.
 */
export function dayDots(sessions, date, maxDots = 4) {
  const count = sessions
    .filter((session) => session.start_at && manilaDateOf(session.start_at) === date)
    .reduce((sum, session) => sum + (session.participant_count ?? 0), 0);
  return { count, dots: Math.min(count, maxDots), more: Math.max(0, count - maxDots) };
}

/** Hour (Manila, 0-23) and minutes of an ISO timestamp, as a number of minutes since midnight. */
export function manilaMinutesOf(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return get('hour') * 60 + get('minute');
}

/** Business hours shown on the chart: 9 AM to 5 PM. Sessions outside are listed in a strip instead. */
export const BUSINESS_START_MINUTES = 9 * 60;
export const BUSINESS_END_MINUTES = 17 * 60;

/** True when a session starts before 9 AM or ends after 5 PM (Manila). */
export function isOutsideHours(session) {
  if (!session.start_at) return false;
  const start = manilaMinutesOf(session.start_at);
  const end = session.end_at ? manilaMinutesOf(session.end_at) : start;
  return start < BUSINESS_START_MINUTES || end > BUSINESS_END_MINUTES;
}

/**
 * Picks the counts for the panels. Uses the summary endpoint when it answered; otherwise
 * counts the loaded sessions (so an older API without /summary still shows numbers).
 */
export function panelCounts(summary, sessions) {
  const statusFromList = sessions.reduce((counts, s) => ({ ...counts, [s.status]: (counts[s.status] ?? 0) + 1 }), {});
  const activityFromList = sessions.reduce((counts, s) => ({ ...counts, [s.activity_type]: (counts[s.activity_type] ?? 0) + 1 }), { orientation: 0, training: 0 });
  return {
    status: summary?.status_counts ?? statusFromList,
    activity: summary?.activity_counts ?? activityFromList,
    source: summary ? 'summary' : 'list',
  };
}

/** "YYYY-MM-DD" in Manila for an ISO timestamp. */
export function manilaDateOf(iso) {
  return manilaToday(new Date(iso));
}
