import { can } from './roleAccess';
import { supplyStatusLabel } from './supplyStatus';

export { supplyStatusLabel };

/**
 * The supply-request actions a role may see for a request, and their state. Only actions the role
 * holds the permission for are returned; the API enforces every rule again.
 *
 * - review: admin, submitted (called automatically on open, not a visible button)
 * - endorse: admin, under_review; disabled with the backend reason when stock is short
 * - resume: admin, on_hold (the warehouse must cover what is held)
 * - confirm_date: admin, a new date requested by Logistics is waiting
 * - accept_schedule: logistics, waiting_logistics
 * - start_preparing: logistics, scheduled
 * - dispatch: logistics, preparing
 * - deliver: logistics, dispatched without a POD (encode the proof of delivery)
 * - reject: admin, submitted, under_review or on_hold (danger, needs a reason)
 * - cancel: admin, endorsed but not dispatched yet (danger, needs a reason; the reservation is released)
 * Logistics steps wait while a date change or a shortage report is with Admin.
 */
export function getSupplyActions(role, request) {
  const actions = [];
  if (!request) return actions;
  const status = request.status;
  const pendingDate = Boolean(request.pending_date_change ?? request.pending_date_revision);
  const pendingShortage = Boolean(request.pending_shortage ?? request.pending_shortage_report);
  const withAdmin = pendingDate || pendingShortage;
  const add = (key, extra = {}) => actions.push({ key, auto: false, disabled: false, reason: null, ...extra });

  if (can(role, 'supply.review') && status === 'submitted') add('review', { auto: true });

  if (can(role, 'supply.endorse') && status === 'under_review') {
    const disabled = request.can_endorse === false;
    add('endorse', { disabled, reason: disabled ? request.endorse_block_reason || null : null });
  }
  if (can(role, 'supply.resume') && status === 'on_hold') add('resume');
  if (can(role, 'supply.decide_date') && pendingDate) add('confirm_date');

  if (can(role, 'supply.accept_schedule') && status === 'waiting_logistics') add('accept_schedule', withAdmin ? { disabled: true, reason: 'Waiting for Admin.' } : {});
  if (can(role, 'supply.start_preparing') && status === 'scheduled') add('start_preparing', withAdmin ? { disabled: true, reason: 'Waiting for Admin.' } : {});
  if (can(role, 'supply.dispatch') && status === 'preparing') add('dispatch', withAdmin ? { disabled: true, reason: 'Waiting for Admin.' } : {});
  if (can(role, 'supply.deliver') && status === 'dispatched' && !request.pod_encoded) add('deliver');

  if (can(role, 'supply.cancel_reject') && ['submitted', 'under_review', 'on_hold'].includes(status)) add('reject', { danger: true });
  if (can(role, 'supply.cancel_reject') && ['waiting_logistics', 'scheduled', 'preparing', 'returned'].includes(status)) add('cancel', { danger: true });

  return actions;
}
