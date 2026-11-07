// App\Services\SupplyWorkflowService: every status change, with the warehouse deduction,
// cancellation restock and branch receipt it implies, in one transaction.
import type { Db, Row } from '../lib/db.ts';
import { fail, insertRow, manilaToday, updateRow, ValidationError } from '../lib/http.ts';
import { adjustStock, stockAudit } from './inventory.ts';
import { notifyUser } from './notifications.ts';
import { deliverToBranch } from './branchStock.ts';

const SUPPLY_MODEL = 'App\\Models\\SupplyRequest';
const ALLOWED: Record<string, string[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['under_review', 'rejected', 'cancelled'],
  under_review: ['endorsed', 'rejected', 'cancelled'],
  endorsed: ['preparing', 'rejected', 'cancelled'],
  preparing: ['dispatched', 'cancelled'],
  dispatched: ['delivered'],
  delivered: ['completed'],
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

async function activeWarehouse(db: Db): Promise<Row> {
  const [w] = await db.query(`select * from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
  if (!w) fail('inventory', 'No active warehouse location is configured.');
  return w;
}

const itemsOf = (db: Db, id: number) => db.query(
  `select si.*, (select to_jsonb(p) from products p where p.id = si.product_id) as product from supply_request_items si where si.supply_request_id = $1 order by si.id`, [id],
);

async function prepareAndDeduct(tx: Db, request: Row, actor: Row, updates: Row): Promise<Row[]> {
  const warehouse = await activeWarehouse(tx);
  const items = await itemsOf(tx, request.id);
  const lines: Row[] = [];
  const shortages: Row[] = [];
  for (const item of items) {
    const [inventory] = await tx.query(`select * from inventories where location_id = $1 and product_id = $2 for update`, [warehouse.id, item.product_id]);
    const requested = Number(item.quantity_requested);
    const stock = Number(inventory?.current_stock ?? 0);
    if (!inventory || stock < requested) shortages.push({ product_id: item.product_id, requested, warehouse_stock: stock, shortage: Math.max(0, requested - stock) });
    lines.push({ product_id: item.product_id, product: item.product, inventory, quantity: requested, stock_before: stock });
  }
  if (shortages.length) throw new ValidationError({ inventory: ['Insufficient warehouse stock for one or more items.'], shortages: [JSON.stringify(shortages)] });
  const snapshot: Row[] = [];
  for (const line of lines) {
    await adjustStock(tx, line.inventory.id, -line.quantity, 'fulfillment', actor, { referenceType: SUPPLY_MODEL, referenceId: request.id, remarks: `Prepared ${request.request_number}` });
    const after = round2(line.stock_before - line.quantity);
    snapshot.push({ product_id: line.product_id, stock_before: line.stock_before, quantity_deducted: line.quantity, stock_after: after });
    await stockAudit(tx, actor, 'supply_request', `supply request ${request.id}`, line.stock_before, after, { inventory: { ...line.inventory, product: line.product }, note: `Preparing ${request.request_number}` });
  }
  // Completed requests keep their own snapshot even if the product is archived later.
  for (const item of items) {
    await updateRow(tx, 'supply_request_items', item.id, {
      quantity_fulfilled: item.quantity_requested, product_name_snapshot: item.product_name_snapshot ?? item.product?.name, unit_snapshot: item.unit_snapshot ?? item.product?.unit,
    });
  }
  updates.preparing_at = new Date();
  updates.stock_deducted_at = new Date();
  return snapshot;
}

async function restoreIfDeducted(tx: Db, request: Row, actor: Row, updates: Row): Promise<Row[] | null> {
  if (!request.stock_deducted_at) return null;
  const warehouse = await activeWarehouse(tx);
  const snapshot: Row[] = [];
  for (const item of await itemsOf(tx, request.id)) {
    const [inventory] = await tx.query(`select * from inventories where location_id = $1 and product_id = $2 for update`, [warehouse.id, item.product_id]);
    const quantity = Number(item.quantity_requested);
    const before = Number(inventory.current_stock);
    await adjustStock(tx, inventory.id, quantity, 'cancellation', actor, { referenceType: SUPPLY_MODEL, referenceId: request.id, remarks: `Cancelled ${request.request_number}` });
    const after = round2(before + quantity);
    snapshot.push({ product_id: item.product_id, stock_before: before, quantity_restored: quantity, stock_after: after });
    await stockAudit(tx, actor, 'supply_request_restore', `supply request ${request.id}`, before, after, { inventory: { ...inventory, product: item.product }, note: `Cancelled ${request.request_number}` });
  }
  updates.stock_deducted_at = null;
  return snapshot;
}

async function confirmDelivery(tx: Db, request: Row, actor: Row, party: string, remarks: string | null) {
  const note = String(remarks ?? '').trim();
  const [existing] = await tx.query(`select * from deliveries where supply_request_id = $1`, [request.id]);
  const fields: Row = { delivered_at: new Date(), delivery_date: manilaToday(), delivered_by_user_id: actor.id, confirmed_by_party: party };
  if (note && !String(existing?.notes ?? '').trim()) fields.notes = [...note].slice(0, 255).join('');
  if (existing) await updateRow(tx, 'deliveries', existing.id, fields);
  else await insertRow(tx, 'deliveries', { supply_request_id: request.id, ...fields });
  await deliverToBranch(tx, request, actor);
}

export async function supplyTransition(db: Db, requestId: number, currentStatus: string, to: string, actor: Row, remarks: string | null = null, party = 'logistics'): Promise<Row> {
  if (!(ALLOWED[currentStatus] ?? []).includes(to)) fail('status', `Invalid transition from ${currentStatus} to ${to}.`);
  return db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from supply_requests where id = $1 for update`, [requestId]);
    if (locked.status !== currentStatus) fail('status', `The request is already ${locked.status}.`);
    const updates: Row = { status: to };
    let payload: Row[] | null = null;
    if (to === 'under_review') Object.assign(updates, { reviewed_by_user_id: actor.id, reviewed_at: new Date() });
    else if (to === 'endorsed') Object.assign(updates, { endorsed_by_user_id: actor.id, endorsed_at: new Date() });
    else if (to === 'preparing') payload = await prepareAndDeduct(tx, locked, actor, updates);
    else if (to === 'dispatched') payload = locked.stock_deducted_at ? null : await prepareAndDeduct(tx, locked, actor, updates);
    else if (to === 'delivered') await confirmDelivery(tx, locked, actor, party, remarks);
    else if (to === 'completed') updates.completed_at = new Date();
    else if (to === 'cancelled') payload = await restoreIfDeducted(tx, locked, actor, updates);

    const saved = (await updateRow(tx, 'supply_requests', requestId, updates))!;
    await insertRow(tx, 'supply_request_status_histories', {
      supply_request_id: requestId, from_status: currentStatus, to_status: to, remarks, payload, changed_by_user_id: actor.id,
    });
    await notifyUser(tx, locked.requested_by_user_id, 'supply_request_status', 'Supply request updated', `Request ${locked.request_number} is now ${to}.`, { supply_request_id: requestId, status: to });
    return saved;
  });
}
