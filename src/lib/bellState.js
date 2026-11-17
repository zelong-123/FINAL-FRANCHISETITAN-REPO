// The notification bell: two tabs (Notifications / Follow-ups), counts, which tab opens, and when the
// bell shakes. Pure, so it is tested. Mirrors FOLLOW_UP_NOTIFICATION_TYPES in services/followUp.ts.

export const FOLLOW_UP_NOTIFICATION_TYPES = ['applicant_overdue', 'applicant_stalled', 'applicant_reminder', 'applicant_follow_up_logged', 'applicant_on_hold'];

/** Shake for about a second, every 12 seconds while there are follow-up items. */
export const SHAKE_EVERY_MS = 12000;
export const SHAKE_DURATION_MS = 1000;

export const isFollowUpNotification = (item) => FOLLOW_UP_NOTIFICATION_TYPES.includes(String(item?.type || ''));

/** { general, followUp }: general notifications for the Notifications tab, follow-up ones apart. */
export function splitNotifications(items = []) {
  const general = [];
  const followUp = [];
  for (const item of items) (isFollowUpNotification(item) ? followUp : general).push(item);
  return { general, followUp };
}

/**
 * The Follow-ups tab count. Sales: their Overdue / Stalled / On hold applicants. Admin: Overdue / Stalled
 * ones (On hold never counts for Admin).
 */
export function followUpCount(items = [], role = 'sales') {
  const states = role === 'admin' ? ['overdue', 'stalled'] : ['overdue', 'stalled', 'on_hold'];
  return items.filter((row) => states.includes(row?.follow_up?.state)).length;
}

/** The tab the panel opens on: Follow-ups when there is something to follow up and nothing unread elsewhere. */
export function defaultTab({ followUps = 0, generalUnread = 0 } = {}) {
  return followUps > 0 && generalUnread === 0 ? 'follow_ups' : 'notifications';
}

/** Whether the bell shakes at all: only with follow-up items, never with reduced motion. */
export function shouldShake({ followUps = 0, reducedMotion = false } = {}) {
  return followUps > 0 && !reducedMotion;
}

/** True when a follow-up item appeared that was not there before (shake at once). */
export function hasNewFollowUp(previousIds, nextIds) {
  if (!previousIds) return false; // the first load is not "new"
  const before = new Set(previousIds.map(String));
  return nextIds.some((id) => !before.has(String(id)));
}

/** The red badge on the bell: unread general notifications plus follow-up items. */
export const bellBadge = ({ followUps = 0, generalUnread = 0 } = {}) => followUps + generalUnread;
