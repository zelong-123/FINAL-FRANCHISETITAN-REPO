/*
 * Whole-hour scheduling rules — the same rules the API enforces.
 *
 *  - Working days and opening/closing time come from the ONE scheduling window
 *    (lib/scheduleConfig.js ← GET /schedule-sessions/config ← the backend config);
 *    defaults Monday–Friday, 9:00 AM to 6:00 PM (Asia/Manila).
 *  - Starts sit on the hour or the half hour; the last valid start leaves one
 *    whole hour before closing (5:00 PM by default).
 *  - Duration is a whole number of hours only (1, 2, 3 … Custom). No minutes.
 *  - The end time is always calculated and never passes closing time.
 */
import {
  closesMinutes, getScheduleConfig, isWorkingDate, lastStartMinutes, minutesLabel, opensMinutes,
} from './scheduleConfig.js';

export const MINUTES = [0, 30];

/** Start hours offered by the picker (opening hour … last valid start hour). */
export function startHours() {
  const first = Math.floor(opensMinutes() / 60);
  const last = Math.floor(lastStartMinutes() / 60);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

/** Is this hour:minute an allowed start (inside the window, on :00/:30)? */
export function isValidStart(hour, minute) {
  const total = Number(hour) * 60 + Number(minute);
  return MINUTES.includes(Number(minute)) && total >= opensMinutes() && total <= lastStartMinutes();
}

export const VENUE_OPTIONS = [
  { value: 'Main Office (In-person)', label: 'Main Office (In-person)' },
  { value: 'Virtual', label: 'Virtual' },
];

/** Capacity per session, mirroring config/franchise.php (Training default is 10). */
export const CAPACITY = { orientation: 30, product_tasting: 15, training: 10 };

export const pad2 = (value) => String(value).padStart(2, '0');

export function hourLabel(hour) {
  return timeLabel(hour, 0);
}

export function timeLabel(hour, minute = 0) {
  const normalized = ((Number(hour) % 24) + 24) % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const display = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${display}:${pad2(minute)} ${suffix}`;
}

/** Whole hours that still fit before closing for this start time (0 = start unusable). */
export function maxHoursFor(hour, minute = 0) {
  return Math.floor((closesMinutes() - (Number(hour) * 60 + Number(minute))) / 60);
}

/** The duration the form currently represents (whole hours). */
export function resolvedHours(form) {
  const raw = form?.duration_choice === 'custom' ? Number(form?.custom_hours) : Number(form?.duration_choice);
  return Number.isFinite(raw) ? raw : 0;
}

export function endTimeLabel(form) {
  const hours = resolvedHours(form);
  if (!hours || hours < 1) return '—';
  const start = Number(form.start_hour) * 60 + Number(form.start_minute);
  const total = start + hours * 60;
  return timeLabel(Math.floor(total / 60), total % 60);
}

/** Default scheduling values (opening time on a working day, 1 hr slot). */
export function blankScheduleFields() {
  const opens = opensMinutes();
  return {
    start_date: '',
    start_hour: Math.floor(opens / 60),
    start_minute: opens % 60 >= 30 ? 30 : 0,
    duration_choice: '1',
    custom_hours: '',
    venue: VENUE_OPTIONS[0].value,
    meeting_link: '',
    merge_dismissed: false,
  };
}

/** Turn a stored timestamp back into the picker fields (used by Edit). */
export function scheduleFieldsFromActivity(activity) {
  const start = activity?.starts_at ? new Date(activity.starts_at) : null;
  const minutes = Number(activity?.duration_minutes) || 60;
  const hours = Math.max(1, Math.round(minutes / 60));
  const base = blankScheduleFields();
  if (!start) {
    return {
      ...base,
      duration_choice: String(Math.min(hours, 3)),
      custom_hours: hours > 3 ? String(hours) : '',
    };
  }

  return {
    ...base,
    start_date: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    start_hour: start.getHours(),
    start_minute: start.getMinutes() >= 30 ? 30 : 0,
    duration_choice: hours > 3 ? 'custom' : String(Math.max(1, Math.min(3, hours))),
    custom_hours: hours > 3 ? String(hours) : '',
    venue: activity?.venue || base.venue,
    meeting_link: activity?.meeting_link || '',
  };
}

/**
 * Validate the picker fields and build the API payload.
 * Throws an Error with a plain-English message the form can show as-is.
 */
export function buildScheduleWindow(form) {
  const date = String(form?.start_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Select the activity date.');
  }
  if (!isWorkingDate(date)) {
    throw new Error(`Activities can only be scheduled ${getScheduleConfig().days_label}.`);
  }

  const hour = Number(form.start_hour);
  const minute = Number(form.start_minute);
  if (minute !== 0 && minute !== 30) {
    throw new Error('Start time must be on the hour or on the half hour (e.g. 9:00 AM or 1:30 PM).');
  }
  const closeLabel = minutesLabel(closesMinutes());
  const max = maxHoursFor(hour, minute);
  if (max < 1) {
    throw new Error(`No whole-hour duration fits before ${closeLabel}, so this start time cannot be used. The last valid start time is ${minutesLabel(lastStartMinutes())}.`);
  }
  if (hour * 60 + minute < opensMinutes()) {
    throw new Error(`Activities must start between ${minutesLabel(opensMinutes())} and ${minutesLabel(lastStartMinutes())} local time.`);
  }

  const hours = resolvedHours(form);
  if (!Number.isInteger(hours) || hours < 1) {
    throw new Error('Duration must be a whole number of hours (minimum 1 hr). Minutes are not allowed.');
  }
  if (hours > max) {
    throw new Error(`This start time only allows up to ${max} hr${max === 1 ? '' : 's'} before ${closeLabel}.`);
  }

  return {
    starts_at: `${date} ${pad2(hour)}:${pad2(minute)}:00`,
    duration_minutes: hours * 60,
    duration_hours: hours,
  };
}
