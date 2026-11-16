import { can } from './roleAccess.js';
import { supplyStatusLabel } from './supplyStatus.js';

export { supplyStatusLabel };

const ADMIN_CANCELLABLE = ['submitted', 'under_review', 'returned', 'waiting_logistics', 'scheduled', 'on_hold', 'preparing'];
const ROLE_KEY = { admin: 'admin', logistics: 'logistics', franchisee: 'branch' };
const pendingDate = (r) => Boolean(r.pending_date_change === true || (r.pending_date_revision && r.pending_date_revision.proposed_by_role === 'logistics') || (r.pending_date_revision === true));
const pendingShortage = (r) => Boolean(r.pending_shortage === true || r.pending_shortage_report);

/**
 * The buttons a role gets in the drawer for a request, in order; the API checks every rule again.
 * Each action: { key, label, kind: 'primary' | 'ghost' | 'danger', disabled, reason }.
 * Keys: start_review, endorse, fulfillment, return, reject, cancel, resume, restock_date,
 * decide_date, accept_schedule, request_date, shortage, start_preparing, dispatch, pod,
 * resolve_discrepancy.
 */
export function getSupplyActions(role, request) {
  const out = [];
  if (!request) return out;
  const status = request.status;
  const add = (key, label, kind = 'ghost', extra = {}) => out.push({ key, label, kind, disabled: false, reason: null, ...extra });
  const date = pendingDate(request);
  const shortage = pendingShortage(request);

  if (role === 'admin') {
    if (status === 'submitted' && can(role, 'supply.review')) add('start_review', 'Start review', 'primary');
    if (status === 'under_review' && can(role, 'supply.endorse')) {
      const short = request.can_endorse === false;
      add('endorse', 'Endorse – Full', 'primary', short ? { disabled: true, reason: request.endorse_block_reason || 'Stock is short; choose a Fulfillment Decision.' } : {});
      add('fulfillment', 'Fulfillment decision', short ? 'primary' : 'ghost', short ? {} : { disabled: true, reason: 'Every item is available: use Endorse – Full.' });
    }
    if (shortage && can(role, 'supply.fulfillment')) add('fulfillment', 'New fulfillment decision', 'primary');
    if (date && can(role, 'supply.decide_date')) add('decide_date', 'Review new date', 'primary');
    if (status === 'on_hold' && can(role, 'supply.resume')) {
      add('resume', 'Resume request', 'primary');
      add('restock_date', 'Update restock date');
    }
    if (status === 'discrepancy_review' && can(role, 'supply.resolve_discrepancy')) add('resolve_discrepancy', 'Resolve discrepancy', 'primary');
    if (['submitted', 'under_review'].includes(status) && can(role, 'supply.return')) add('return', 'Return for correction');
    if (['submitted', 'under_review', 'on_hold'].includes(status) && can(role, 'supply.cancel_reject')) add('reject', 'Reject', 'danger');
    if (ADMIN_CANCELLABLE.includes(status) && can(role, 'supply.cancel_reject')) add('cancel', 'Cancel request', 'danger');
  }

  if (role === 'logistics') {
    const waiting = date || shortage;
    const blocked = waiting ? { disabled: true, reason: date ? 'A new date is waiting for Admin.' : 'A shortage report is waiting for Admin.' } : {};
    if (status === 'waiting_logistics' && can(role, 'supply.accept_schedule')) add('accept_schedule', 'Accept schedule', 'primary', blocked);
    if (status === 'scheduled' && can(role, 'supply.start_preparing')) add('start_preparing', 'Start preparing', 'primary', blocked);
    if (status === 'preparing' && can(role, 'supply.dispatch')) add('dispatch', 'Dispatch', 'primary', blocked);
    if (['waiting_logistics', 'scheduled'].includes(status) && can(role, 'supply.request_date')) add('request_date', 'Request new date', 'ghost', blocked);
    if (['waiting_logistics', 'scheduled', 'preparing'].includes(status) && can(role, 'supply.report_shortage') && !request.stock_deducted_at) add('shortage', 'Report shortage', 'ghost', blocked);
    if (status === 'dispatched' && !request.pod_encoded && can(role, 'supply.deliver')) add('pod', 'Encode POD', 'primary');
  }
  return out;
}

/** The one table button: what the signed-in role does next, or null when it is someone else's turn. */
export function rowActionLabel(role, request) {
  if (!request?.owners?.includes(ROLE_KEY[role])) return null;
  const status = request.status;
  if (role === 'admin') {
    if (pendingDate(request)) return 'Review date';
    if (pendingShortage(request)) return 'Review shortage';
    if (status === 'on_hold') return 'Resume';
    if (status === 'discrepancy_review') return 'Resolve';
    return 'Review';
  }
  if (role === 'logistics') {
    return { waiting_logistics: 'Confirm schedule', scheduled: 'Start preparing', preparing: 'Dispatch', dispatched: 'Encode POD' }[status] || 'Open';
  }
  return 'Open';
}

/** The read-only line other roles see in the drawer. */
export function waitingLine(request) {
  const owners = request?.owners || [];
  if (!owners.length) return 'Closed. No further action.';
  const names = owners.map((o) => ({ admin: 'Admin', logistics: 'Logistics', branch: 'the branch' }[o] || o));
  return `Waiting for ${names.join(' and ')}.`;
}
