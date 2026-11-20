/*
 * Pure helpers for the Schedule activity modal's smart picker (no React, no API import),
 * so the node lib tests can check them. The API decides every rule; these only shape
 * its answers (GET /schedule-sessions/availability and /joinable) for the screen.
 */

export const MAX_DOTS = 3;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export const PICKER_WEEKDAYS = WEEKDAYS;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad2 = (value) => String(value).padStart(2, '0');

/** "2026-11" from "2026-11-23" (or the current Manila month when empty). */
export function monthOfDate(date) {
  if (/^\d{4}-\d{2}/.test(String(date || ''))) return String(date).slice(0, 7);
  const now = new Date(Date.now() + 8 * 3600_000);
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
}

/** "2026-11" + 1 -> "2026-12". */
export function shiftMonth(month, step) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + step;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

export const monthTitle = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** Day of the week (1 = Monday … 7 = Sunday) of a YYYY-MM-DD date. */
function isoWeekday(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Up to 3 dots, then "+N": the sessions of the same activity by the applicant's Sales user. */
export function dotSummary(count, max = MAX_DOTS) {
  const n = Math.max(0, Number(count) || 0);
  return { dots: Math.min(n, max), more: Math.max(0, n - max) };
}

/**
 * Mon–Fri weeks of the month for the calendar grid. Each cell carries the API day (sessions,
 * available, reason) or null when it is outside the month (blank leading cells).
 */
export function calendarWeeks(month, days = []) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const weeks = [];
  let week = [null, null, null, null, null];
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  for (let d = 1; d <= last; d += 1) {
    const date = `${month}-${pad2(d)}`;
    const weekday = isoWeekday(date);
    if (weekday > 5) continue;
    if (weekday === 1 && week.some(Boolean)) { weeks.push(week); week = [null, null, null, null, null]; }
    const day = byDate.get(date) ?? null;
    week[weekday - 1] = {
      date, day: d,
      available: day ? Boolean(day.available) : false,
      reason: day?.reason ?? null,
      sessions: day?.sessions ?? [],
      ...dotSummary(day?.sessions?.length ?? 0),
    };
  }
  if (week.some(Boolean)) weeks.push(week);
  return weeks;
}

/** The hover text of a calendar day: its sessions, or why the Sales user cannot take the activity. */
export function dayTitle(cell, activityLabel = 'this activity') {
  if (!cell) return '';
  const lines = [];
  if (cell.sessions.length) lines.push(`${cell.sessions.length} ${activityLabel} session${cell.sessions.length === 1 ? '' : 's'}: ${cell.sessions.map((s) => `${s.time} (${s.occupancy})`).join(', ')}`);
  if (!cell.available && cell.reason) lines.push(cell.reason);
  return lines.join('\n');
}

/** "9:00 AM" from "09:00". */
export function slotLabel(time) {
  const [h, m] = String(time).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m || 0)} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** The start/end the evaluate call needs, in Manila time, from the form (null until complete). */
export function formWindow(form, hours) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form?.start_date || '')) || !(hours >= 1)) return null;
  const start = Number(form.start_hour) * 60 + Number(form.start_minute || 0);
  const end = start + hours * 60;
  const at = (minutes) => `${form.start_date}T${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}:00+08:00`;
  return { start_at: at(start), end_at: at(end) };
}

/** Which actions the live check offers for an evaluation result. */
export function liveActions(evaluation, { isAdmin = false, nextAvailable = null } = {}) {
  if (!evaluation || evaluation.status === 'ok') return { join: null, next: null, reassign: false };
  const reasons = evaluation.reasons || [];
  const busy = reasons.some((r) => /already has|assigned to another Sales user|no assigned Sales user/.test(r));
  return {
    join: evaluation.merge_targets?.[0] ?? null,
    next: nextAvailable,
    reassign: Boolean(isAdmin && busy),
  };
}

/** "Add Ana Cruz to Orientation/Tasting on Mon, Nov 23 · 9:00–11:00 AM (2/5)?" */
export function joinConfirmText(row, applicantName) {
  const when = [row.date_label, row.time].filter(Boolean).join(' · ');
  const brand = row.brand?.name ? ` · ${row.brand.name}` : '';
  return `Add ${applicantName || 'this applicant'} to ${row.activity_label} on ${when}${brand} (${row.occupancy})?`;
}

/** The Master Schedule link for a session: Day view on its date with the session modal open. */
export function masterScheduleLink(row) {
  const params = new URLSearchParams({ view: 'master-schedule', mode: 'day', date: row.date, session: String(row.id) });
  return `/activities?${params.toString()}`;
}
