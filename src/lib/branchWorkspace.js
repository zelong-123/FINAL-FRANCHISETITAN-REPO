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
export const REQUEST_STATUSES = [
  'submitted', 'under_review', 'endorsed', 'rejected', 'preparing', 'dispatched', 'delivered', 'completed', 'cancelled',
];

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
