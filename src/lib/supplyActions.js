import { can } from './roleAccess';

/**
 * Display label for a supply-request status: Submitted, Under Review, Endorsed,
 * Preparing, Dispatched, Delivered, Completed (plus Rejected / Cancelled).
 * The action that moves a request into "preparing" is labelled "Start Prepare".
 */
export function supplyStatusLabel(status) {
  const key = String(status || '').toLowerCase();
  return key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Which supply-request actions a role may see for a request, and their state.
 * Returns only the actions the role holds the permission for.
 *
 * - review: admin, status submitted (called automatically on open, not a visible button)
 * - endorse: admin, status under_review; disabled with the backend reason when can_endorse is false
 * - propose_date: admin, status under_review or endorsed (reschedule after a short-stock hold)
 * - start_preparing: logistics, status endorsed
 * - dispatch: logistics, status preparing
 * - deliver: logistics, status dispatched
 * - complete: admin, status delivered
 * - reject: admin, status under_review or endorsed (danger, needs a reason)
 * - cancel: admin, status preparing (danger, needs a reason; stock is restored)
 * - confirm_date: logistics, status under_review or endorsed with a pending date revision
 */
export function getSupplyActions(role, request) {
  const actions = [];
  if (!request) return actions;
  const status = request.status;

  if (can(role, 'supply.review') && status === 'submitted') {
    actions.push({ key: 'review', auto: true, disabled: false, reason: null });
  }

  if (can(role, 'supply.endorse') && status === 'under_review') {
    const disabled = request.can_endorse === false;
    actions.push({
      key: 'endorse',
      auto: false,
      disabled,
      reason: disabled ? request.endorse_block_reason || null : null,
    });
  }

  if (can(role, 'supply.propose_date') && (status === 'under_review' || status === 'endorsed')) {
    actions.push({ key: 'propose_date', auto: false, disabled: false, reason: null });
  }

  if (can(role, 'supply.start_preparing') && status === 'endorsed') {
    actions.push({ key: 'start_preparing', auto: false, disabled: false, reason: null });
  }

  if (can(role, 'supply.dispatch') && status === 'preparing') {
    actions.push({ key: 'dispatch', auto: false, disabled: false, reason: null });
  }

  if (can(role, 'supply.deliver') && status === 'dispatched') {
    actions.push({ key: 'deliver', auto: false, disabled: false, reason: null });
  }

  if (can(role, 'supply.complete') && status === 'delivered') {
    actions.push({ key: 'complete', auto: false, disabled: false, reason: null });
  }

  // Works with the index row flag and with the show object: both are truthy only when pending.
  if (can(role, 'supply.confirm_date') && (status === 'under_review' || status === 'endorsed') && request.pending_date_revision) {
    actions.push({ key: 'confirm_date', auto: false, disabled: false, reason: null });
  }

  if (can(role, 'supply.cancel_reject') && (status === 'under_review' || status === 'endorsed')) {
    actions.push({ key: 'reject', auto: false, disabled: false, reason: null, danger: true });
  }

  if (can(role, 'supply.cancel_reject') && status === 'preparing') {
    actions.push({ key: 'cancel', auto: false, disabled: false, reason: null, danger: true });
  }

  return actions;
}
