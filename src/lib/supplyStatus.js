// Supply request statuses, mirrored from supabase/functions/api/services/supplyStatus.ts
// (supplyStatus.test.mjs fails if the two drift apart). Use these lists everywhere instead of
// spelling statuses out, so a new status is never missed.

export const MAIN_PATH = ['draft', 'submitted', 'under_review', 'waiting_logistics', 'scheduled', 'preparing', 'dispatched', 'delivered', 'completed'];
export const SIDE = ['returned', 'on_hold', 'discrepancy_review', 'completed_with_discrepancy', 'rejected', 'cancelled'];
export const STATUSES = [...MAIN_PATH, ...SIDE];
export const TERMINAL = ['completed', 'completed_with_discrepancy', 'rejected', 'cancelled'];
export const OPEN = STATUSES.filter((s) => !TERMINAL.includes(s));
/** Open and already sent by the branch (no drafts). */
export const SUBMITTED_OPEN = OPEN.filter((s) => s !== 'draft');
export const IN_TRANSIT = ['dispatched', 'delivered'];
export const TO_SHIP = ['waiting_logistics', 'scheduled', 'preparing'];
export const EDITABLE = ['draft', 'submitted', 'returned'];
/** The delivery reached the branch (POD and/or receipt). */
export const DELIVERED_ON = ['delivered', 'discrepancy_review', 'completed', 'completed_with_discrepancy'];

export const LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  returned: 'Returned',
  waiting_logistics: 'Waiting for Logistics',
  scheduled: 'Scheduled',
  on_hold: 'On hold',
  preparing: 'Preparing',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  discrepancy_review: 'Discrepancy review',
  completed: 'Completed',
  completed_with_discrepancy: 'Completed with discrepancy',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Display label for a status; an unknown value is title-cased so nothing renders blank. */
export function supplyStatusLabel(status) {
  const key = String(status || '').toLowerCase();
  return LABELS[key] ?? key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
