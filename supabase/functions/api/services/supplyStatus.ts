// The one list of supply request statuses. Every route, service and screen that reads a supply
// status uses these constants (the frontend mirrors them in src/lib/supplyStatus.js, and a test
// checks the two lists are identical), so a new status is never missed.

export const MAIN_PATH = ['draft', 'submitted', 'under_review', 'waiting_logistics', 'scheduled', 'preparing', 'dispatched', 'delivered', 'completed'] as const;
export const SIDE = ['returned', 'on_hold', 'discrepancy_review', 'completed_with_discrepancy', 'rejected', 'cancelled'] as const;
export const STATUSES = [...MAIN_PATH, ...SIDE] as string[];

/** Finished: nothing more happens to the request. */
export const TERMINAL = ['completed', 'completed_with_discrepancy', 'rejected', 'cancelled'];
/** Still in progress (draft included). */
export const OPEN = STATUSES.filter((s) => !TERMINAL.includes(s));
/** In progress and already sent by the branch (no draft). */
export const SUBMITTED_OPEN = OPEN.filter((s) => s !== 'draft');
/** On the way or waiting for the branch's receipt. */
export const IN_TRANSIT = ['dispatched', 'delivered'];
/** Endorsed and still to ship: Logistics' queue. */
export const TO_SHIP = ['waiting_logistics', 'scheduled', 'preparing'];
/** Open and not yet at the branch: what can be late against the delivery date. */
export const BEFORE_DELIVERY = SUBMITTED_OPEN.filter((s) => !['delivered', 'discrepancy_review'].includes(s));
/** The delivery reached the branch (POD and/or receipt). */
export const DELIVERED_ON = ['delivered', 'discrepancy_review', 'completed', 'completed_with_discrepancy'];
/** The branch may edit or cancel. */
export const EDITABLE = ['draft', 'submitted', 'returned'];
/** Admin may still cancel (anything before dispatch). */
export const CANCELLABLE_BY_ADMIN = ['draft', 'submitted', 'under_review', 'returned', 'waiting_logistics', 'scheduled', 'on_hold', 'preparing'];
/** Logistics never sees requests that have not reached it. */
export const HIDDEN_FROM_LOGISTICS = ['draft', 'submitted', 'under_review', 'returned'];

/** The staff list tabs ("needs_action" is worked out per role from the owners). */
export const TABS = {
  all: null,
  under_review: ['submitted', 'under_review', 'returned'],
  on_hold: ['on_hold'],
  scheduled_preparing: ['waiting_logistics', 'scheduled', 'preparing'],
  dispatched: ['dispatched', 'delivered'],
  discrepancy: ['discrepancy_review'],
  completed: ['completed', 'completed_with_discrepancy'],
  closed: ['rejected', 'cancelled'],
} as Record<string, string[] | null>;

export const LABELS: Record<string, string> = {
  draft: 'Draft', submitted: 'Submitted', under_review: 'Under review', returned: 'Returned', waiting_logistics: 'Waiting for Logistics',
  scheduled: 'Scheduled', on_hold: 'On hold', preparing: 'Preparing', dispatched: 'Dispatched', delivered: 'Delivered',
  discrepancy_review: 'Discrepancy review', completed: 'Completed', completed_with_discrepancy: 'Completed with discrepancy',
  rejected: 'Rejected', cancelled: 'Cancelled',
};

/** SQL list literal, e.g. `status in (${sqlList(OPEN)})`. Only ever built from these constants. */
export const sqlList = (statuses: readonly string[]) => statuses.map((s) => `'${s}'`).join(', ');

export interface OwnerContext { pod: boolean; received: boolean; pendingDate: boolean; pendingShortage: boolean }

/** Who must act next. More than one owner is possible (e.g. dispatched: Logistics for the POD, Branch for the receipt). */
export function ownersOf(status: string, ctx: OwnerContext): ('admin' | 'logistics' | 'branch')[] {
  const owners = new Set<'admin' | 'logistics' | 'branch'>();
  if (['submitted', 'under_review', 'on_hold', 'discrepancy_review'].includes(status)) owners.add('admin');
  if ((ctx.pendingDate || ctx.pendingShortage) && TO_SHIP.includes(status)) owners.add('admin');
  else if (TO_SHIP.includes(status)) owners.add('logistics');
  if (status === 'dispatched' && !ctx.pod) owners.add('logistics');
  if (['draft', 'returned'].includes(status)) owners.add('branch');
  if (IN_TRANSIT.includes(status) && !ctx.received) owners.add('branch');
  return [...owners];
}
