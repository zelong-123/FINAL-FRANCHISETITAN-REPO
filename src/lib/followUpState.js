// Applicant follow-up states as the UI shows them (the API decides the state; see services/followUp.ts).
// Pure, so it is tested. Applicants waiting for Admin review have no state at all (they are not counted).

export const FOLLOW_UP_STATES = {
  overdue: { label: 'Overdue', filterLabel: 'Overdue' },
  stalled: { label: 'Stalled', filterLabel: 'Stalled' },
  on_hold: { label: 'On hold', filterLabel: 'On hold' },
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

const MANILA = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const when = (value) => (value ? MANILA.format(new Date(value)) : '');

/**
 * What the chip shows, or null (on track, waiting for Admin, closed: no chip). After Admin sends a
 * reminder (until Sales updates or the stage changes) Admin sees "Reminder sent", Sales "Reminder from
 * Admin"; Overdue turns amber with a bell, Stalled stays red with a bell.
 */
export function followUpChip(followUp, role = 'admin') {
  const state = followUp?.state;
  if (!['overdue', 'stalled', 'on_hold'].includes(state)) return null;
  if (state === 'on_hold') return { state, tone: 'hold', icon: 'pause', text: 'On hold', tooltip: followUp.tooltip || 'On hold' };
  const days = typeof followUp.days === 'number' ? ` · ${followUp.days}d` : '';
  if (followUp.reminded && followUp.last_reminder) {
    const label = role === 'admin' ? 'Reminder sent' : 'Reminder from Admin';
    return {
      state,
      tone: state === 'stalled' ? 'stalled' : 'reminded',
      icon: 'bell',
      text: `${label}${days}`,
      tooltip: `Reminder sent by ${followUp.last_reminder.by || 'Admin'} · ${when(followUp.last_reminder.at)}`,
    };
  }
  return {
    state,
    tone: state,
    icon: state === 'stalled' ? 'warning' : 'clock',
    text: `${state === 'stalled' ? 'Stalled' : 'Overdue'}${days}`,
    tooltip: followUp.tooltip || (state === 'stalled' ? 'Stalled' : 'Overdue'),
  };
}

/** Where a chip click leads: the applicant's Follow-up section (DOM id of that section). */
export const FOLLOW_UP_SECTION_ID = 'ap-follow-up';

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
