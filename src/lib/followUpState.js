// Applicant follow-up states as the UI shows them (the API decides the state; see services/followUp.ts).
// Pure, so it is tested.

export const FOLLOW_UP_STATES = {
  overdue: { label: 'Overdue', filterLabel: 'Overdue', tone: 'overdue' },
  stalled: { label: 'Stalled', filterLabel: 'Stalled', tone: 'stalled' },
  waiting_admin: { label: 'Waiting on Admin', filterLabel: 'Waiting on Admin', tone: 'waiting' },
  on_hold: { label: 'On hold', filterLabel: 'On hold', tone: 'hold' },
};

export const FOLLOW_UP_REASONS = [
  { value: 'waiting_documents', label: 'Waiting for applicant documents' },
  { value: 'not_responding', label: 'Applicant not responding' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'still_deciding', label: 'Applicant still deciding' },
  { value: 'other', label: 'Other' },
];
export const reasonLabel = (value) => FOLLOW_UP_REASONS.find((r) => r.value === value)?.label || value || '';

/** Status filter values: stages stay as they are; follow-up states are prefixed so they never clash. */
export const FOLLOW_UP_FILTER_PREFIX = 'follow_up:';
export function splitStatusFilter(value) {
  const text = String(value || '');
  return text.startsWith(FOLLOW_UP_FILTER_PREFIX) ? { status: '', follow_up: text.slice(FOLLOW_UP_FILTER_PREFIX.length) } : { status: text, follow_up: '' };
}

/** What a chip shows: null when there is nothing to show. */
export function followUpChip(followUp) {
  const state = followUp?.state;
  const meta = state ? FOLLOW_UP_STATES[state] : null;
  if (!meta) return null;
  const days = typeof followUp.days === 'number' ? followUp.days : null;
  let text = meta.label;
  if ((state === 'overdue' || state === 'stalled') && days !== null) text = `${meta.label} · ${days}d`;
  else if (state === 'waiting_admin' && days !== null && days > 0) text = `${meta.label} · ${days}d`;
  return { state, tone: meta.tone, label: meta.label, text, tooltip: followUp.tooltip || meta.label, remindable: state === 'overdue' || state === 'stalled' };
}

/** Today in Manila as YYYY-MM-DD (the earliest next action date). */
export function manilaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
}
export function manilaDayOffset(days, now = new Date()) {
  return manilaToday(new Date(now.getTime() + days * 86400000));
}

/** Client-side checks of the Log follow-up form (the API checks again). Returns { field: message }. */
export function followUpFormErrors(form, today = manilaToday()) {
  const errors = {};
  if (!form.reason) errors.reason = 'Choose a reason.';
  if (form.reason === 'other' && String(form.notes || '').trim().length < 5) errors.notes = 'Describe the reason (at least 5 characters) when you choose Other.';
  if (!form.next_action_date) errors.next_action_date = 'Choose the next action date.';
  else if (form.next_action_date < today) errors.next_action_date = 'The next action date cannot be in the past.';
  return errors;
}

/** Client-side checks of the Put on hold form. */
export function holdFormErrors(form, today = manilaToday()) {
  const errors = {};
  if (String(form.reason || '').trim().length < 5) errors.reason = 'Give a reason of at least 5 characters.';
  if (!form.until) errors.until = 'Choose until when the applicant is on hold.';
  else if (form.until <= today) errors.until = 'The hold must end after today.';
  return errors;
}
