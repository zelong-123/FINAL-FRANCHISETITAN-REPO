import { STATUSES } from './supplyStatus.js';
/** Pages of the branch workspace; `?view=` selects one and unknown values open the dashboard. */
export const BRANCH_VIEWS = {
  dashboard: { label: 'Branch Dashboard' },
  inventory: { label: 'Branch Inventory' },
  products: { label: 'Products' },
  production: { label: 'Production' },
  supply: { label: 'Supply Request Panel' },
  transactions: { label: 'All Transactions', parent: 'dashboard' },
};

export function resolveView(value) {
  return Object.hasOwn(BRANCH_VIEWS, value || '') ? value : 'dashboard';
}

/** Breadcrumb trail. Every level but the last carries the view it links to. */
export function breadcrumbFor(value) {
  const view = resolveView(value);
  const { label, parent } = BRANCH_VIEWS[view];
  return [
    { label: 'Branch Workspace', view: 'dashboard' },
    ...(parent ? [{ label: BRANCH_VIEWS[parent].label, view: parent }] : []),
    { label, view: null },
  ];
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Address first, then city. Skips an address that only repeats the owner's name. */
export function branchPlace(location, ownerName) {
  const place = [location?.address, location?.city].find((value) => (
    String(value || '').trim() && !same(value, ownerName) && !same(value, 'Location not set')
  ));
  return place ? String(place).trim() : 'Location not set';
}

// Backend statuses a branch can see (drafts never appear in this list).
export const REQUEST_STATUSES = STATUSES.filter((status) => status !== 'draft');

// quantity_requested is stored with two decimals.
const roundQuantity = (value) => Math.round(Number(value) * 100) / 100;

const sameProduct = (line, productId) => Number(line.product_id) === Number(productId);

/** The other row already holding this product. The row being edited does not count. */
export function findDuplicate(lines, productId, editingId = null) {
  return lines.find((line) => sameProduct(line, productId) && !sameProduct(line, editingId)) || null;
}

/** Adds a line, or replaces the edited row in place so the list order stays. */
export function putLine(lines, line, editingId = null) {
  if (editingId === null) return [...lines, line];
  return lines.map((row) => (sameProduct(row, editingId) ? line : row));
}

/** Adds the quantity to the row already holding the product; the edited row, if any, goes away. */
export function combineLine(lines, line, editingId = null) {
  return lines
    .filter((row) => editingId === null || !sameProduct(row, editingId) || sameProduct(row, line.product_id))
    .map((row) => (
      sameProduct(row, line.product_id)
        ? { ...row, quantity: roundQuantity(Number(row.quantity) + Number(line.quantity)) }
        : row
    ));
}

export function removeLine(lines, productId) {
  return lines.filter((row) => !sameProduct(row, productId));
}

/** Request List rows as the supply-request API expects them. */
export function toRequestItems(lines) {
  return lines.map((line) => ({ product_id: Number(line.product_id), quantity_requested: Number(line.quantity) }));
}

// ---- Supply requests as the branch sees them ----

/** The branch's 4-step tracker: Submitted → Approved → On the way → Received. */
export const BRANCH_STEPS = ['Submitted', 'Approved', 'On the way', 'Received'];
const STEP_OF = {
  draft: -1, submitted: 0, under_review: 0, returned: 0,
  waiting_logistics: 1, scheduled: 1, preparing: 1, on_hold: 1,
  dispatched: 2, delivered: 2,
  discrepancy_review: 3, completed: 3, completed_with_discrepancy: 3,
  rejected: 0, cancelled: 0,
};
/** { step: 0..3 (-1 for a draft), stopped, label } for a request status. */
export function branchStep(status, receivedAt = null) {
  const stopped = status === 'rejected' || status === 'cancelled';
  // Confirmed before the POD: the branch has it, even if the request is still "dispatched".
  const step = receivedAt && ['dispatched', 'delivered'].includes(status) ? 3 : (STEP_OF[status] ?? 0);
  const label = {
    draft: 'Draft (not sent yet)', returned: 'Returned – edit and resubmit', on_hold: 'Approved – on hold for restock',
    rejected: 'Rejected', cancelled: 'Cancelled', discrepancy_review: 'Received – being reviewed', completed_with_discrepancy: 'Received – with discrepancy',
  }[status] ?? (step >= 0 ? BRANCH_STEPS[step] : 'Draft');
  return { step, stopped, label };
}

/** The branch may edit or cancel only while the request is a draft, submitted or returned. */
export const BRANCH_EDITABLE = ['draft', 'submitted', 'returned'];

/**
 * One Confirm Receipt line, checked the same way the server checks it:
 * good + damaged + short = dispatched; damaged needs a reason and a photo; short needs a reason.
 * Returns { field: message } (empty when the line is fine).
 */
export function receiptLineErrors(line, dispatched) {
  const errors = {};
  const n = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const good = n(line.good); const damaged = n(line.damaged || 0); const short = n(line.short || 0);
  if (![good, damaged, short].every((x) => Number.isFinite(x) && x >= 0)) errors.sum = 'Enter zero or more for good, damaged and short.';
  else if (Math.abs(good + damaged + short - Number(dispatched)) > 1e-9) errors.sum = `Good + damaged + short must equal the ${roundQuantity(dispatched)} dispatched (now ${roundQuantity(good + damaged + short)}).`;
  if (damaged > 0 && String(line.damage_reason || '').trim().length < 5) errors.damage_reason = 'Describe the damage (at least 5 characters).';
  if (damaged > 0 && !line.photo) errors.photo = 'Attach a photo of the damaged items.';
  if (short > 0 && String(line.short_reason || '').trim().length < 5) errors.short_reason = 'Say why it is short (at least 5 characters).';
  return errors;
}
