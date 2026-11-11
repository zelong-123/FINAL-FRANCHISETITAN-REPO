// Supply Request workflow (Objective 3). Every action of Branch, Admin and Logistics lives here,
// enforced on the server: allowed status, role, required reasons, stock reservation, warehouse
// deduction, branch credit, the audit trail and notifications, each in one transaction.
//
// Stock: reserved at endorsement (net of other reservations), deducted from the warehouse at
// dispatch using the prepared quantities (the reservation is consumed), released on cancel or
// reject. Only the GOOD quantity is credited to the branch, at Confirm Receipt.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, updateRow } from '../lib/http.ts';
import { adjustStock, stockAudit } from './inventory.ts';
import { notifyRoles, notifyUser } from './notifications.ts';
import { creditReceived } from './branchStock.ts';
import { forecastFor } from './supplyForecast.ts';
import { resolveWorkspace } from './branchAccess.ts';
import { evaluate, STOCK_LABELS } from './materialStock.ts';
import * as S from './supplyStatus.ts';
import { addWorkingDays, earliestTargetDate, isWeekend, manilaDate, nextWorkingDayOrSame, pastOneWorkingDay } from './workingDays.ts';

const SUPPLY_MODEL = 'App\\Models\\SupplyRequest';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);
export const roleOf = (actor: Row): string => actor.role?.name ?? actor.role_name ?? actor.role ?? '';
const isBranch = (actor: Row) => roleOf(actor) === 'franchisee';

/** A required reason: at least 5 characters after trimming. */
export function reasonOf(value: unknown, field: string, label: string): string {
  const text = String(value ?? '').trim();
  if (text.length < 5) fail(field, `${label} is required (at least 5 characters).`);
  return text;
}

// ---- settings ----
export async function supplySettings(db: Db): Promise<{ lead_days: number; bulk_percent: number }> {
  const [row] = await db.query(`select * from supply_settings order by id limit 1`);
  return { lead_days: Number(row?.supply_lead_time_working_days ?? 2), bulk_percent: Number(row?.bulk_threshold_percent ?? 50) };
}

// ---- small building blocks ----
async function warehouseOf(db: Db): Promise<Row> {
  const [w] = await db.query(`select * from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
  if (!w) fail('inventory', 'No active warehouse location is configured.');
  return w;
}
export const itemsOf = (db: Db, id: number) => db.query(
  `select si.*, (select to_jsonb(p) from products p where p.id = si.product_id) as product from supply_request_items si where si.supply_request_id = $1 order by si.id`, [id],
);
async function lockRequest(tx: Db, id: number): Promise<Row> {
  const [row] = await tx.query(`select * from supply_requests where id = $1 for update`, [id]);
  if (!row) abort(404, 'Record not found.');
  return row;
}
function requireStatus(sr: Row, allowed: readonly string[], message: string) {
  if (!allowed.includes(sr.status)) fail('status', `${message} (The request is ${S.LABELS[sr.status] ?? sr.status}.)`);
}
function requireRole(actor: Row, roles: string[], message = 'Your role cannot perform this action.') {
  if (!roles.includes(roleOf(actor))) abort(403, message);
}
async function history(tx: Db, sr: Row, to: string, action: string, actor: Row | null, remarks: string | null, details: unknown = null, documentId: number | null = null) {
  await insertRow(tx, 'supply_request_status_histories', {
    supply_request_id: sr.id, from_status: sr.status, to_status: to, action, actor_role: actor ? roleOf(actor) || null : 'system',
    remarks, payload: details === null ? null : details, changed_by_user_id: actor?.id ?? null, document_id: documentId,
  });
}
async function setStatus(tx: Db, sr: Row, to: string, extra: Row = {}): Promise<Row> {
  return (await updateRow(tx, 'supply_requests', sr.id, { status: to, status_changed_at: new Date(), ...extra }))!;
}
const notifyBranch = (db: Db, sr: Row, type: string, title: string, message: string) => notifyUser(db, sr.requested_by_user_id, type, title, message, { supply_request_id: sr.id });
const notify = (db: Db, roles: string[], sr: Row, type: string, title: string, message: string) => notifyRoles(db, roles, type, title, message, { supply_request_id: sr.id });

/** Pending sub-states that Admin must answer. */
export async function pendingOf(db: Db, id: number): Promise<{ date: Row | null; shortage: Row | null }> {
  const [date] = await db.query(`select * from supply_request_date_revisions where supply_request_id = $1 and status = 'pending' and proposed_by_role = 'logistics' order by id desc limit 1`, [id]);
  const [shortage] = await db.query(`select * from supply_shortage_reports where supply_request_id = $1 and status = 'pending' order by id desc limit 1`, [id]);
  return { date: date ?? null, shortage: shortage ?? null };
}
async function requireNoPending(db: Db, sr: Row) {
  const pending = await pendingOf(db, sr.id);
  if (pending.date) fail('status', 'A new delivery date is waiting for Admin. Wait for the decision first.');
  if (pending.shortage) fail('status', 'A shortage report is waiting for Admin. Wait for the new fulfillment decision first.');
}

// ---- warehouse availability and reservations ----
/** Warehouse stock minus every active reservation (optionally ignoring one request's own). */
export async function netAvailable(db: Db, productId: number, exceptRequestId: number | null = null, lock = false): Promise<number> {
  const warehouse = await warehouseOf(db);
  const [inv] = await db.query(`select current_stock from inventories where location_id = $1 and product_id = $2 ${lock ? 'for update' : ''}`, [warehouse.id, productId]);
  const [{ reserved }] = await db.query(
    `select coalesce(sum(quantity), 0)::float as reserved from supply_reservations where product_id = $1 and status = 'active' and ($2::bigint is null or supply_request_id <> $2::bigint)`,
    [productId, exceptRequestId],
  );
  return round2(num(inv?.current_stock) - num(reserved));
}
async function reservedFor(db: Db, itemId: number): Promise<number> {
  const [{ q }] = await db.query(`select coalesce(sum(quantity), 0)::float as q from supply_reservations where supply_request_item_id = $1 and status = 'active'`, [itemId]);
  return round2(num(q));
}
async function reserve(db: Db, sr: Row, item: Row, quantity: number, actor: Row) {
  if (quantity <= 0) return;
  const warehouse = await warehouseOf(db);
  await insertRow(db, 'supply_reservations', {
    supply_request_id: sr.id, supply_request_item_id: item.id, product_id: item.product_id, location_id: warehouse.id, quantity: round2(quantity), status: 'active', created_by_user_id: actor.id,
  });
}
async function releaseReservations(db: Db, requestId: number) {
  await db.query(`update supply_reservations set status = 'released', released_at = now(), updated_at = now() where supply_request_id = $1 and status = 'active'`, [requestId]);
}

/** Per item: requested, available in the warehouse for this request (net of other reservations), unavailable. */
export async function availabilityOf(db: Db, sr: Row): Promise<Row[]> {
  const out: Row[] = [];
  for (const item of await itemsOf(db, sr.id)) {
    const requested = num(item.quantity_requested);
    const free = Math.max(0, await netAvailable(db, item.product_id, sr.id));
    const available = round2(Math.min(requested, free));
    out.push({ item_id: Number(item.id), product_id: Number(item.product_id), name: item.product?.name ?? item.product_name_snapshot, unit: item.product?.unit ?? item.unit_snapshot, requested, warehouse_free: free, available, unavailable: round2(requested - available) });
  }
  return out;
}

// ---- creating and editing (Branch; Admin may also create) ----
async function generateRequestNumber(db: Db): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('');
    const number = `FT-${manilaDate().replace(/-/g, '')}-${random}`;
    if (!(await db.query(`select 1 from supply_requests where request_number = $1`, [number])).length) return number;
  }
}

interface RequestInput { location_id?: unknown; items?: unknown; urgency?: unknown; urgency_reason?: unknown; bulk_reason?: unknown; target_delivery_date?: unknown; delivery_address?: unknown; contact_number?: unknown; remarks?: unknown }

/** Validates a request as the branch would submit it. Returns the clean fields, items and non-blocking warnings. */
export async function checkRequest(db: Db, actor: Row, input: RequestInput, existing: Row | null = null, soft = false) {
  const locationId = Number(existing?.location_id ?? input.location_id);
  if (!Number.isInteger(locationId) || locationId <= 0) fail('location_id', 'Choose the branch.');
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [locationId]);
  if (!location || location.type !== 'franchise') fail('location_id', 'Choose an existing branch.');
  if (!location.is_active || location.archived_at) fail('location_id', 'This branch is not active, so it cannot request supplies.');
  if (isBranch(actor)) {
    const own = await resolveWorkspace(db, actor);
    if (!own || Number(own.id) !== locationId) abort(403, 'You can only request supplies for your assigned active branch.');
  }

  // Items: from the branch brand's catalog, no duplicate, positive quantity.
  const raw = Array.isArray(input.items) ? input.items as Row[] : [];
  if (!raw.length) fail('items', 'Add at least one item.');
  if (raw.length > 100) fail('items', 'A request can have at most 100 items.');
  const seen = new Set<number>();
  const items: Row[] = [];
  for (const [index, line] of raw.entries()) {
    const productId = Number(line?.product_id);
    const quantity = Number(line?.quantity_requested);
    if (!Number.isInteger(productId) || productId <= 0) fail(`items.${index}.product_id`, 'Choose a product.');
    if (seen.has(productId)) fail(`items.${index}.product_id`, 'This product is already on the request.');
    seen.add(productId);
    if (!Number.isFinite(quantity) || quantity <= 0) fail(`items.${index}.quantity_requested`, 'Enter a quantity greater than zero.');
    if (round2(quantity) !== quantity && Math.abs(round2(quantity) - quantity) > 1e-9) fail(`items.${index}.quantity_requested`, 'Use at most two decimals.');
    const [product] = await db.query(`select id, name, unit, brand_id, is_active, archived_at from products where id = $1`, [productId]);
    if (!product || !product.is_active || product.archived_at) fail(`items.${index}.product_id`, 'This product is not in the catalog.');
    if (Number(product.brand_id) !== Number(location.brand_id)) fail(`items.${index}.product_id`, `${product.name} is not in this branch's brand catalog.`);
    items.push({ product_id: productId, quantity_requested: round2(quantity), name: product.name, unit: product.unit });
  }

  // Urgency and target date (working days, Mon-Fri; the date itself may be a weekend).
  const urgency = String(input.urgency ?? 'normal');
  if (!['normal', 'urgent', 'critical'].includes(urgency)) fail('urgency', 'Urgency must be Normal, Urgent or Critical.');
  const urgent = urgency !== 'normal';
  // Soft mode (the form's live check) collects these problems instead of stopping at the first.
  const issues: Record<string, string> = {};
  const problem = (field: string, message: string) => (soft ? (issues[field] = message) : fail(field, message));
  let urgencyReason: string | null = null;
  if (urgent) {
    const text = String(input.urgency_reason ?? '').trim();
    if (text.length < 5) problem('urgency_reason', 'A reason for the urgency is required (at least 5 characters).');
    urgencyReason = text || null;
  }
  const settings = await supplySettings(db);
  const today = manilaDate();
  const earliestNormal = earliestTargetDate(today, settings.lead_days);
  const earliest = urgent ? earliestTargetDate(today, settings.lead_days, true) : earliestNormal;
  const target = input.target_delivery_date ? String(input.target_delivery_date).slice(0, 10) : earliestNormal;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) fail('target_delivery_date', 'Enter a valid target delivery date.');
  if (target < earliest) {
    problem('target_delivery_date', urgent
      ? `The earliest delivery date for an ${urgency} request is ${earliest}.`
      : `The earliest delivery date is ${earliestNormal} (${settings.lead_days} working days). Mark the request Urgent or Critical, with a reason, to ask for an earlier date.`);
  }

  // Bulk check against the existing estimate: more than the threshold above the suggestion needs a reason.
  const forecast = await forecastFor(db, location, items.map((i) => i.product_id));
  // The forecast counts an open request as "on order", this one included: when editing or
  // resubmitting, its own quantity is added back so it is not measured against itself.
  const ownOnOrder = new Map<number, number>();
  if (existing && S.SUBMITTED_OPEN.includes(existing.status) && !existing.branch_received_at) {
    for (const row of await db.query(`select product_id, coalesce(quantity_endorsed, quantity_requested) as q, quantity_fulfilled from supply_request_items where supply_request_id = $1`, [existing.id])) {
      ownOnOrder.set(Number(row.product_id), Math.max(0, num(row.q) - num(row.quantity_fulfilled)));
    }
  }
  const over: string[] = [];
  for (const item of items) {
    const forecastSuggested = forecast.get(item.product_id)?.suggested ?? null;
    const suggested = forecastSuggested === null ? null : round2(forecastSuggested + (ownOnOrder.get(item.product_id) ?? 0));
    item.suggested_quantity = suggested;
    item.days_covered = forecast.get(item.product_id)?.days_covered ?? null;
    item.over_bulk = suggested !== null && item.quantity_requested > suggested * (1 + settings.bulk_percent / 100);
    if (item.over_bulk) over.push(`${item.name} (${item.quantity_requested} vs suggested ${suggested})`);
  }
  const bulkText = String(input.bulk_reason ?? '').trim();
  if (over.length && bulkText.length < 5) {
    problem('bulk_reason', `A bulk reason is required (at least 5 characters): more than ${settings.bulk_percent}% above the suggested quantity: ${over.join(', ')}.`);
  }
  const bulkReason = bulkText || null;

  const address = String(input.delivery_address ?? existing?.delivery_address ?? location.address ?? '').trim();
  if (!address) problem('delivery_address', 'Enter the delivery address.');
  const contact = String(input.contact_number ?? existing?.contact_number ?? location.contact_number ?? '').trim() || null;

  // Warnings that never block: weekend target, another open request with the same product.
  const warnings: string[] = [];
  if (isWeekend(target)) warnings.push('Target date is a weekend. Make sure the branch can receive.');
  const dupes = await db.query(
    `select distinct sr.request_number, p.name from supply_requests sr join supply_request_items si on si.supply_request_id = sr.id join products p on p.id = si.product_id
     where sr.location_id = $1 and sr.status in (${S.sqlList(S.OPEN)}) and si.product_id = any($2::bigint[]) and ($3::bigint is null or sr.id <> $3::bigint) order by 1`,
    [locationId, `{${items.map((i) => i.product_id).join(',')}}`, existing?.id ?? null],
  );
  for (const d of dupes) warnings.push(`You have a pending request for ${d.name} (${d.request_number}).`);

  return {
    location,
    fields: { location_id: locationId, urgency, urgency_reason: urgencyReason, bulk_reason: bulkReason, target_delivery_date: target, delivery_address: address, contact_number: contact, remarks: String(input.remarks ?? '').trim() || null },
    items, warnings, earliest_date: earliest,
    bulk_required: over.length > 0, bulk_percent: settings.bulk_percent, issues,
  };
}

const writeItems = async (tx: Db, id: number, items: Row[]) => {
  await tx.query(`delete from supply_request_items where supply_request_id = $1`, [id]);
  for (const item of items) {
    await insertRow(tx, 'supply_request_items', {
      supply_request_id: id, product_id: item.product_id, quantity_requested: item.quantity_requested, product_name_snapshot: item.name, unit_snapshot: item.unit,
      suggested_quantity: item.suggested_quantity, over_bulk: Boolean(item.over_bulk),
    });
  }
};

export async function createRequest(db: Db, actor: Row, input: RequestInput & { submit?: unknown }) {
  requireRole(actor, ['franchisee', 'admin']);
  const checked = await checkRequest(db, actor, input);
  const submit = input.submit === undefined || input.submit === null ? true : Boolean(input.submit) && input.submit !== 'false' && input.submit !== '0';
  const status = submit ? 'submitted' : 'draft';
  const row = await db.tx(async (tx) => {
    const created = await insertRow(tx, 'supply_requests', {
      request_number: await generateRequestNumber(tx), requested_by_user_id: actor.id, status, status_changed_at: new Date(), submitted_at: submit ? new Date() : null, ...checked.fields,
    });
    await writeItems(tx, created.id, checked.items);
    await history(tx, { id: created.id, status: null }, status, submit ? 'submitted' : 'draft_created', actor, submit ? 'Request submitted.' : 'Draft saved.', { warnings: checked.warnings });
    return created;
  });
  if (submit) await notify(db, ['admin'], row, 'supply_request_submitted', 'New supply request', `${row.request_number} needs review.`);
  return { request: row, warnings: checked.warnings };
}

export async function updateRequest(db: Db, actor: Row, id: number, input: RequestInput) {
  requireRole(actor, ['franchisee', 'admin']);
  const [sr] = await db.query(`select * from supply_requests where id = $1`, [id]);
  if (!sr) abort(404, 'Record not found.');
  requireStatus(sr, S.EDITABLE, 'Only a draft, submitted or returned request can be edited.');
  if (isBranch(actor) && sr.requested_by_user_id !== actor.id) abort(403, 'You can only edit your own branch requests.');
  const merged: RequestInput = {
    urgency: sr.urgency, urgency_reason: sr.urgency_reason, bulk_reason: sr.bulk_reason, target_delivery_date: sr.target_delivery_date, delivery_address: sr.delivery_address,
    contact_number: sr.contact_number, remarks: sr.remarks, ...input,
    items: input.items ?? (await itemsOf(db, id)).map((i) => ({ product_id: i.product_id, quantity_requested: i.quantity_requested })),
  };
  const checked = await checkRequest(db, actor, merged, sr);
  await db.tx(async (tx) => {
    const locked = await lockRequest(tx, id);
    requireStatus(locked, S.EDITABLE, 'Only a draft, submitted or returned request can be edited.');
    const { location_id: _ignored, ...fields } = checked.fields;
    await updateRow(tx, 'supply_requests', id, fields);
    await writeItems(tx, id, checked.items);
    await history(tx, sr, sr.status, 'edited', actor, 'Request edited.', { warnings: checked.warnings });
  });
  return { warnings: checked.warnings };
}

/** Draft → submitted, or Returned → submitted again under the same number (history kept). */
export async function submitRequest(db: Db, actor: Row, id: number) {
  requireRole(actor, ['franchisee', 'admin']);
  const result = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['draft', 'returned'], 'Only a draft or returned request can be submitted.');
    if (isBranch(actor) && sr.requested_by_user_id !== actor.id) abort(403, 'You can only submit your own branch requests.');
    // The rules are checked again: a returned request must still meet them.
    const items = (await itemsOf(tx, id)).map((i) => ({ product_id: i.product_id, quantity_requested: i.quantity_requested }));
    await checkRequest(tx, actor, { ...sr, items }, sr);
    const resubmit = sr.status === 'returned';
    await history(tx, sr, 'submitted', resubmit ? 'resubmitted' : 'submitted', actor, resubmit ? 'Corrected and resubmitted.' : 'Request submitted.');
    return { sr: await setStatus(tx, sr, 'submitted', { submitted_at: new Date() }), resubmit };
  });
  await notify(db, ['admin'], result.sr, 'supply_request_submitted', result.resubmit ? 'Supply request resubmitted' : 'New supply request', `${result.sr.request_number} needs review.`);
  return result.sr;
}

/** Branch: only while editable. Admin: any time before dispatch. A reason is always required; reservations are released. */
export async function cancelRequest(db: Db, actor: Row, id: number, reasonInput: unknown) {
  requireRole(actor, ['franchisee', 'admin']);
  const reason = reasonOf(reasonInput, 'reason', 'A cancellation reason');
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    if (isBranch(actor)) {
      if (sr.requested_by_user_id !== actor.id) abort(403, 'You can only cancel your own branch requests.');
      requireStatus(sr, S.EDITABLE, 'The branch can cancel only while the request is a draft, submitted or returned.');
    } else {
      requireStatus(sr, S.CANCELLABLE_BY_ADMIN, 'A request can be cancelled only before it is dispatched.');
    }
    await releaseReservations(tx, id);
    const restored = await restoreLegacyDeduction(tx, sr, actor);
    await tx.query(`update supply_shortage_reports set status = 'decided', decided_by_user_id = $2, decided_at = now() where supply_request_id = $1 and status = 'pending'`, [id, actor.id]);
    await tx.query(`update supply_request_date_revisions set status = 'superseded', decided_at = now(), decision_reason = 'Request cancelled.' where supply_request_id = $1 and status = 'pending'`, [id]);
    await history(tx, sr, 'cancelled', 'cancelled', actor, reason, restored ? { stock_restored: restored } : null);
    return { sr, saved: await setStatus(tx, sr, 'cancelled', { cancelled_reason: reason, cancelled_by_user_id: actor.id, cancelled_at: new Date(), ...(restored ? { stock_deducted_at: null } : {}) }) };
  });
  if (!isBranch(actor)) await notifyBranch(db, saved.saved, 'supply_request_cancelled', 'Supply request cancelled', `${saved.saved.request_number} was cancelled: ${reason}`);
  if (S.TO_SHIP.includes(saved.sr.status)) await notify(db, ['logistics'], saved.saved, 'supply_request_stopped', 'Supply request cancelled', `${saved.saved.request_number} was cancelled.`);
  return saved.saved;
}

/** Requests prepared under the previous workflow had their stock deducted at Preparing; cancelling them puts it back. */
async function restoreLegacyDeduction(tx: Db, sr: Row, actor: Row): Promise<Row[] | null> {
  if (!sr.stock_deducted_at || sr.status === 'dispatched') return null;
  const warehouse = await warehouseOf(tx);
  const restored: Row[] = [];
  for (const item of await itemsOf(tx, sr.id)) {
    const quantity = num(item.quantity_prepared ?? item.quantity_endorsed ?? item.quantity_requested);
    if (quantity <= 0) continue;
    const [inventory] = await tx.query(`select * from inventories where location_id = $1 and product_id = $2 for update`, [warehouse.id, item.product_id]);
    if (!inventory) continue;
    const before = num(inventory.current_stock);
    await adjustStock(tx, inventory.id, quantity, 'cancellation', actor, { referenceType: SUPPLY_MODEL, referenceId: sr.id, remarks: `Cancelled ${sr.request_number}` });
    await stockAudit(tx, actor, 'supply_request_restore', `supply request ${sr.id}`, before, round2(before + quantity), { inventory: { ...inventory, product: item.product }, note: `Cancelled ${sr.request_number}` });
    restored.push({ product_id: item.product_id, quantity });
  }
  return restored;
}

// ---- Admin review ----
export async function startReview(db: Db, actor: Row, id: number) {
  requireRole(actor, ['admin']);
  return db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['submitted'], 'Only a submitted request can be put under review.');
    await history(tx, sr, 'under_review', 'review_started', actor, 'Review started.');
    return setStatus(tx, sr, 'under_review', { reviewed_by_user_id: actor.id, reviewed_at: new Date() });
  });
}

export async function returnRequest(db: Db, actor: Row, id: number, reasonInput: unknown) {
  requireRole(actor, ['admin']);
  const reason = reasonOf(reasonInput, 'reason', 'A return reason');
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['submitted', 'under_review'], 'Only a request in review can be returned for correction.');
    await history(tx, sr, 'returned', 'returned', actor, reason);
    return setStatus(tx, sr, 'returned', { returned_reason: reason, returned_by_user_id: actor.id, returned_at: new Date() });
  });
  await notifyBranch(db, saved, 'supply_request_returned', 'Supply request returned', `${saved.request_number} needs a correction: ${reason}`);
  return saved;
}

export async function rejectRequest(db: Db, actor: Row, id: number, reasonInput: unknown) {
  requireRole(actor, ['admin']);
  const reason = reasonOf(reasonInput, 'reason', 'A rejection reason');
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['submitted', 'under_review', 'on_hold'], 'Only a request in review or on hold can be rejected.');
    await releaseReservations(tx, id);
    await history(tx, sr, 'rejected', 'rejected', actor, reason);
    return setStatus(tx, sr, 'rejected', { rejected_reason: reason, rejected_by_user_id: actor.id, rejected_at: new Date() });
  });
  await notifyBranch(db, saved, 'supply_request_rejected', 'Supply request rejected', `${saved.request_number} was rejected: ${reason}`);
  return saved;
}

/** Endorse – Full: only when every item is fully available (net of reservations). */
export async function endorseFull(db: Db, actor: Row, id: number) {
  requireRole(actor, ['admin']);
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['under_review'], 'Start the review before endorsing.');
    const items = await itemsOf(tx, id);
    const lines: Row[] = [];
    for (const item of items) {
      const free = await netAvailable(tx, item.product_id, id, true);
      if (free < num(item.quantity_requested)) fail('items', 'Stock is short; choose a Fulfillment Decision.');
      lines.push({ item_id: item.id, product_id: item.product_id, requested: num(item.quantity_requested) });
    }
    for (const item of items) {
      await reserve(tx, sr, item, num(item.quantity_requested), actor);
      await updateRow(tx, 'supply_request_items', item.id, { quantity_available: item.quantity_requested, quantity_unavailable: 0, quantity_endorsed: item.quantity_requested, expected_restock_date: null });
    }
    await history(tx, sr, 'waiting_logistics', 'endorsed_full', actor, 'Endorsed – Full. Stock reserved.', { fulfillment_type: 'full', items: lines });
    return setStatus(tx, sr, 'waiting_logistics', {
      fulfillment_type: 'full', fulfillment_reason: null, fulfillment_decided_by_user_id: actor.id, fulfillment_decided_at: new Date(), endorsed_by_user_id: actor.id, endorsed_at: new Date(),
    });
  });
  await notifyBranch(db, saved, 'supply_request_endorsed', 'Supply request endorsed', `${saved.request_number} was endorsed and sent to Logistics.`);
  await notify(db, ['logistics'], saved, 'supply_request_endorsed', 'Supply request endorsed', `${saved.request_number} is ready for scheduling.`);
  return saved;
}

/**
 * Fulfillment Decision when something is short: Hold for Restock, Partial – Ship Now (backorder
 * child "-B"), or Partial – Consolidated. Also answers a Logistics shortage report.
 */
export async function decideFulfillment(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['admin']);
  const type = String(input.type ?? '');
  if (!['hold', 'partial_ship_now', 'partial_consolidated'].includes(type)) fail('type', 'Choose Hold for Restock, Partial – Ship Now or Partial – Consolidated.');
  const reason = reasonOf(input.reason, 'reason', 'A reason for the decision');
  const today = manilaDate();
  const result = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    const pending = await pendingOf(tx, id);
    if (!(sr.status === 'under_review' || (pending.shortage && S.TO_SHIP.includes(sr.status)))) {
      fail('status', 'A Fulfillment Decision is made during review, or to answer a shortage report.');
    }
    if (sr.stock_deducted_at) fail('status', 'This request was prepared under the previous workflow; its stock is already deducted.');
    // A new decision replaces this request's reservations.
    await releaseReservations(tx, id);
    const lines = await fulfillmentLines(tx, sr, pending, input, today, true);
    if (type === 'partial_ship_now' && !lines.some((l) => l.available > 0)) fail('type', 'Nothing is available to ship now. Choose Hold for Restock.');
    const restockDate = lines.map((l) => l.restock).filter(Boolean).sort().pop() ?? null;
    const details = { fulfillment_type: type, items: lines.map((l) => ({ item_id: l.item.id, product_id: l.item.product_id, requested: l.requested, available: l.available, unavailable: l.unavailable, restock_date: l.restock })) };
    if (pending.shortage) await updateRow(tx, 'supply_shortage_reports', pending.shortage.id, { status: 'decided', decided_by_user_id: actor.id, decided_at: new Date() });

    const common = { fulfillment_type: type, fulfillment_reason: reason, fulfillment_decided_by_user_id: actor.id, fulfillment_decided_at: new Date(), endorsed_by_user_id: actor.id, endorsed_at: new Date() };
    let child: Row | null = null;
    if (type === 'hold') {
      for (const l of lines) await updateRow(tx, 'supply_request_items', l.item.id, { quantity_available: l.available, quantity_unavailable: l.unavailable, expected_restock_date: l.restock, quantity_endorsed: null });
      await history(tx, sr, 'on_hold', 'fulfillment_hold', actor, reason, details);
      return { sr: await setStatus(tx, sr, 'on_hold', { ...common, expected_restock_date: restockDate, on_hold_at: new Date() }), child, type };
    }
    if (type === 'partial_consolidated') {
      for (const l of lines) {
        await reserve(tx, sr, l.item, l.available, actor);
        await updateRow(tx, 'supply_request_items', l.item.id, { quantity_available: l.available, quantity_unavailable: l.unavailable, expected_restock_date: l.restock, quantity_endorsed: l.requested });
      }
      await history(tx, sr, 'on_hold', 'fulfillment_consolidated', actor, reason, details);
      return { sr: await setStatus(tx, sr, 'on_hold', { ...common, expected_restock_date: restockDate, on_hold_at: new Date() }), child, type };
    }
    // Partial – Ship Now: the available part continues, the unavailable part becomes a backorder child.
    for (const l of lines) {
      await reserve(tx, sr, l.item, l.available, actor);
      await updateRow(tx, 'supply_request_items', l.item.id, { quantity_available: l.available, quantity_unavailable: l.unavailable, expected_restock_date: l.restock, quantity_endorsed: l.available });
    }
    const { root, seq, number } = await nextBackorder(tx, sr);
    child = await insertRow(tx, 'supply_requests', {
      request_number: number, location_id: sr.location_id, requested_by_user_id: sr.requested_by_user_id, status: 'on_hold', status_changed_at: new Date(),
      submitted_at: new Date(), target_delivery_date: sr.target_delivery_date, delivery_address: sr.delivery_address, contact_number: sr.contact_number, remarks: `Backorder of ${sr.request_number}.`,
      urgency: sr.urgency, urgency_reason: sr.urgency_reason, bulk_reason: sr.bulk_reason, parent_request_id: root.id, backorder_seq: seq,
      fulfillment_type: 'hold', fulfillment_reason: reason, fulfillment_decided_by_user_id: actor.id, fulfillment_decided_at: new Date(), expected_restock_date: restockDate, on_hold_at: new Date(),
      reviewed_by_user_id: actor.id, reviewed_at: new Date(),
    });
    for (const l of lines.filter((x) => x.unavailable > 0)) {
      await insertRow(tx, 'supply_request_items', {
        supply_request_id: child.id, product_id: l.item.product_id, quantity_requested: l.unavailable, product_name_snapshot: l.item.product?.name ?? l.item.product_name_snapshot,
        unit_snapshot: l.item.product?.unit ?? l.item.unit_snapshot, quantity_available: 0, quantity_unavailable: l.unavailable, expected_restock_date: l.restock,
      });
    }
    await history(tx, { id: child.id, status: null }, 'on_hold', 'backorder_created', actor, `Backorder of ${sr.request_number}: ${reason}`, details);
    await history(tx, sr, 'waiting_logistics', 'fulfillment_partial_ship_now', actor, reason, { ...details, backorder_request_id: child.id, backorder_number: child.request_number });
    return { sr: await setStatus(tx, sr, 'waiting_logistics', common), child, type };
  });
  const s = result.sr;
  if (result.type === 'partial_ship_now') {
    await notifyBranch(db, s, 'supply_request_endorsed', 'Supply request partly endorsed', `${s.request_number}: the available items ship now; ${result.child!.request_number} waits for restock.`);
    await notify(db, ['logistics'], s, 'supply_request_endorsed', 'Supply request endorsed', `${s.request_number} is ready for scheduling.`);
  } else {
    await notifyBranch(db, s, 'supply_request_on_hold', 'Supply request on hold', `${s.request_number} is on hold for restock (expected ${s.expected_restock_date}).`);
  }
  return result;
}

/**
 * Per item: requested, available (capped by the warehouse net of other reservations and by a
 * pending shortage count), unavailable and restock date. Strict mode (the real decision) also
 * requires a valid restock date for anything unavailable.
 */
async function fulfillmentLines(db: Db, sr: Row, pending: { shortage: Row | null }, input: Row, today: string, strict: boolean): Promise<Row[]> {
  const reported = new Map<number, number>((pending.shortage?.items ?? []).map((r: Row) => [Number(r.item_id), num(r.actual_count)]));
  const given = new Map<number, Row>((Array.isArray(input.items) ? input.items : []).map((r: Row) => [Number(r.item_id), r]));
  const lines: Row[] = [];
  for (const [index, item] of (await itemsOf(db, sr.id)).entries()) {
    const requested = num(item.quantity_requested);
    const free = Math.max(0, await netAvailable(db, item.product_id, sr.id, strict));
    const cap = Math.min(requested, free, reported.has(Number(item.id)) ? reported.get(Number(item.id))! : Infinity);
    const row = given.get(Number(item.id));
    const name = item.product?.name ?? item.product_name_snapshot ?? 'This item';
    const available = row && row.available !== undefined && row.available !== null && row.available !== '' ? round2(num(row.available)) : round2(cap);
    if (!Number.isFinite(available) || available < 0) fail(`items.${index}.available`, 'Enter an available quantity of zero or more.');
    if (available > cap + 1e-9) fail(`items.${index}.available`, `${name}: at most ${round2(cap)} is available.`);
    const unavailable = round2(requested - available);
    const restock = row?.restock_date ? String(row.restock_date).slice(0, 10) : null;
    if (strict && unavailable > 0) {
      if (!restock) fail(`items.${index}.restock_date`, `${name}: enter the expected restock date.`);
      if (restock! < today) fail(`items.${index}.restock_date`, 'The expected restock date cannot be in the past.');
    }
    lines.push({ item, name, unit: item.product?.unit ?? item.unit_snapshot, requested, max_available: round2(cap), available, unavailable, restock: unavailable > 0 ? restock : null });
  }
  if (!lines.some((l) => l.unavailable > 0)) fail('type', 'Nothing is short. Use Endorse – Full.');
  return lines;
}

/** The next backorder number: the root request's number plus -B, -B2, -B3 … */
async function nextBackorder(db: Db, sr: Row) {
  const root = sr.parent_request_id ? (await db.query(`select * from supply_requests where id = $1`, [sr.parent_request_id]))[0] : sr;
  const [{ n }] = await db.query(`select count(*)::int as n from supply_requests where parent_request_id = $1`, [root.id]);
  const seq = n + 1;
  return { root, seq, number: `${root.request_number}-B${seq > 1 ? seq : ''}` };
}

/** What a Fulfillment Decision would do, without saving anything (for the confirmation preview). */
export async function previewFulfillment(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['admin']);
  const [sr] = await db.query(`select * from supply_requests where id = $1`, [id]);
  if (!sr) abort(404, 'Record not found.');
  const pending = await pendingOf(db, id);
  if (!(sr.status === 'under_review' || (pending.shortage && S.TO_SHIP.includes(sr.status)))) fail('status', 'A Fulfillment Decision is made during review, or to answer a shortage report.');
  const type = String(input.type ?? 'partial_ship_now');
  if (!['hold', 'partial_ship_now', 'partial_consolidated'].includes(type)) fail('type', 'Choose Hold for Restock, Partial – Ship Now or Partial – Consolidated.');
  const lines = await fulfillmentLines(db, sr, pending, input, manilaDate(), false);
  const qty = (l: Row, n: number) => `${l.name} ${round2(n)} ${l.unit ?? ''}`.trim();
  const backorder = type === 'partial_ship_now' && lines.some((l) => l.available > 0)
    ? { request_number: (await nextBackorder(db, sr)).number, items: lines.filter((l) => l.unavailable > 0).map((l) => ({ item_id: l.item.id, name: l.name, unit: l.unit, quantity: l.unavailable })) }
    : null;
  let message = 'Nothing ships yet; the request waits on hold for the restock.';
  if (backorder) message = `${backorder.request_number} will be created for ${lines.filter((l) => l.unavailable > 0).map((l) => qty(l, l.unavailable)).join(', ')}`;
  else if (type === 'partial_consolidated') message = `${lines.filter((l) => l.available > 0).map((l) => qty(l, l.available)).join(', ') || 'Nothing'} will be reserved; everything ships together after the restock.`;
  return {
    type, backorder, message,
    items: lines.map((l) => ({ item_id: l.item.id, name: l.name, unit: l.unit, requested: l.requested, max_available: l.max_available, available: l.available, unavailable: l.unavailable, restock_date: l.restock })),
  };
}

/** On hold → waiting for Logistics, once the warehouse can cover what is still held. */
export async function resumeRequest(db: Db, actor: Row, id: number) {
  requireRole(actor, ['admin']);
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['on_hold'], 'Only a request on hold can be resumed.');
    const items = await itemsOf(tx, id);
    const short: string[] = [];
    const needs: Row[] = [];
    for (const item of items) {
      const reserved = await reservedFor(tx, item.id);
      const need = round2(num(item.quantity_requested) - reserved);
      const free = await netAvailable(tx, item.product_id, id, true);
      if (need > free + 1e-9) short.push(`${item.product?.name ?? 'Item'} (needs ${need}, available ${Math.max(0, free)})`);
      needs.push({ item, need });
    }
    if (short.length) fail('items', `The warehouse cannot cover the held quantities yet: ${short.join(', ')}.`);
    for (const { item, need } of needs) {
      await reserve(tx, sr, item, need, actor);
      await updateRow(tx, 'supply_request_items', item.id, { quantity_available: item.quantity_requested, quantity_unavailable: 0, quantity_endorsed: item.quantity_requested });
    }
    await history(tx, sr, 'waiting_logistics', 'resumed', actor, 'Restocked: resumed and sent to Logistics.', { items: needs.map((n) => ({ item_id: n.item.id, reserved_now: n.need })) });
    return setStatus(tx, sr, 'waiting_logistics', { endorsed_by_user_id: actor.id, endorsed_at: new Date() });
  });
  await notifyBranch(db, saved, 'supply_request_endorsed', 'Supply request resumed', `${saved.request_number} was restocked and sent to Logistics.`);
  await notify(db, ['logistics'], saved, 'supply_request_endorsed', 'Supply request endorsed', `${saved.request_number} is ready for scheduling.`);
  return saved;
}

export async function updateRestockDate(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['admin']);
  const reason = reasonOf(input.reason, 'reason', 'A reason for the new restock date');
  const date = String(input.restock_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('restock_date', 'Enter the new expected restock date.');
  if (date < manilaDate()) fail('restock_date', 'The expected restock date cannot be in the past.');
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['on_hold'], 'The restock date can be changed only while the request is on hold.');
    await tx.query(`update supply_request_items set expected_restock_date = $2 where supply_request_id = $1 and coalesce(quantity_unavailable, 0) > 0`, [id, date]);
    await history(tx, sr, 'on_hold', 'restock_date_updated', actor, reason, { from: sr.expected_restock_date, to: date, revision: num(sr.restock_revision_count) + 1 });
    return (await updateRow(tx, 'supply_requests', id, { expected_restock_date: date, restock_revision_count: num(sr.restock_revision_count) + 1 }))!;
  });
  await notifyBranch(db, saved, 'supply_request_restock_date', 'Restock date changed', `${saved.request_number}: expected restock is now ${date}. ${reason}`);
  return saved;
}

// ---- Logistics ----
export async function acceptSchedule(db: Db, actor: Row, id: number) {
  requireRole(actor, ['logistics']);
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['waiting_logistics'], 'Only a request waiting for Logistics can be scheduled.');
    await requireNoPending(tx, sr);
    const date = sr.confirmed_delivery_date ?? sr.target_delivery_date;
    await history(tx, sr, 'scheduled', 'schedule_accepted', actor, `Schedule confirmed for ${date ?? 'the target date'}.`, { confirmed_delivery_date: date });
    return setStatus(tx, sr, 'scheduled', { confirmed_delivery_date: date, scheduled_by_user_id: actor.id, scheduled_at: new Date() });
  });
  await notifyBranch(db, saved, 'supply_request_scheduled', 'Delivery scheduled', `${saved.request_number} is scheduled for ${saved.confirmed_delivery_date}.`);
  return saved;
}

export async function requestDateChange(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['logistics']);
  const reason = reasonOf(input.reason, 'reason', 'A reason for the new date');
  const date = String(input.proposed_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('proposed_date', 'Enter the proposed delivery date.');
  if (date < manilaDate()) fail('proposed_date', 'The proposed date cannot be in the past.');
  const result = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['waiting_logistics', 'scheduled'], 'A new date can be requested before preparing starts.');
    await requireNoPending(tx, sr);
    const revision = await insertRow(tx, 'supply_request_date_revisions', {
      supply_request_id: id, original_delivery_date: sr.confirmed_delivery_date ?? sr.target_delivery_date, revised_delivery_date: date, note: reason, reason, status: 'pending',
      proposed_by_user_id: actor.id, proposed_by_role: 'logistics',
    });
    await history(tx, sr, sr.status, 'date_change_requested', actor, reason, { proposed_date: date, revision_id: revision.id });
    return { sr, revision };
  });
  await notify(db, ['admin'], result.sr, 'supply_request_date_requested', 'New delivery date requested', `${result.sr.request_number}: Logistics asks to deliver on ${date}.`);
  return result.revision;
}

export async function decideDateChange(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['admin']);
  const approve = input.approve === true || input.approve === 'true' || input.approve === 1 || input.approve === '1';
  const reason = approve ? (String(input.reason ?? '').trim() || null) : reasonOf(input.reason, 'reason', 'A reason for rejecting the new date');
  const result = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    const { date: revision } = await pendingOf(tx, id);
    if (!revision) fail('status', 'There is no new date waiting for a decision.');
    await updateRow(tx, 'supply_request_date_revisions', revision!.id, { status: approve ? 'approved' : 'rejected', decided_by_user_id: actor.id, decided_at: new Date(), decision_reason: reason });
    const date = String(revision!.revised_delivery_date).slice(0, 10);
    if (!approve) {
      await history(tx, sr, sr.status, 'date_change_rejected', actor, reason, { proposed_date: date });
      return { sr, approve };
    }
    await history(tx, sr, sr.status === 'waiting_logistics' ? 'scheduled' : sr.status, 'date_change_approved', actor, reason, { confirmed_delivery_date: date });
    const saved = sr.status === 'waiting_logistics'
      ? await setStatus(tx, sr, 'scheduled', { confirmed_delivery_date: date, scheduled_by_user_id: actor.id, scheduled_at: new Date() })
      : (await updateRow(tx, 'supply_requests', id, { confirmed_delivery_date: date }))!;
    return { sr: saved, approve };
  });
  const s = result.sr;
  const text = result.approve ? `${s.request_number}: new delivery date approved (${s.confirmed_delivery_date}).` : `${s.request_number}: the new delivery date was not approved.`;
  await notify(db, ['logistics'], s, 'supply_request_date_decided', result.approve ? 'New date approved' : 'New date rejected', text);
  await notifyBranch(db, s, 'supply_request_date_decided', result.approve ? 'Delivery date changed' : 'Delivery date unchanged', text);
  return s;
}

/** Logistics reports the actual count per item; Admin must answer with a new Fulfillment Decision. Inventory is not changed. */
export async function reportShortage(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['logistics']);
  const reason = reasonOf(input.reason, 'reason', 'A reason for the shortage');
  const result = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, S.TO_SHIP, 'A shortage can be reported before dispatch.');
    await requireNoPending(tx, sr);
    if (sr.stock_deducted_at) fail('status', 'This request was prepared under the previous workflow (stock already deducted). Ask Admin to cancel it, which restores the stock.');
    const given = new Map<number, Row>((Array.isArray(input.items) ? input.items : []).map((r: Row) => [Number(r.item_id), r]));
    const lines: Row[] = [];
    let short = false;
    for (const [index, item] of (await itemsOf(tx, id)).entries()) {
      const toShip = num(item.quantity_endorsed ?? item.quantity_requested);
      const row = given.get(Number(item.id));
      if (!row || row.actual_count === undefined || row.actual_count === null || row.actual_count === '') fail(`items.${index}.actual_count`, `${item.product?.name ?? 'Item'}: enter the actual count.`);
      const actual = num(row!.actual_count);
      if (!Number.isFinite(actual) || actual < 0) fail(`items.${index}.actual_count`, 'The actual count must be zero or more.');
      if (actual < toShip) short = true;
      lines.push({ item_id: Number(item.id), product_id: Number(item.product_id), name: item.product?.name ?? item.product_name_snapshot, to_ship: toShip, actual_count: round2(actual) });
    }
    if (!short) fail('items', 'No item is short: every actual count covers the quantity to ship.');
    const report = await insertRow(tx, 'supply_shortage_reports', { supply_request_id: id, stage: sr.status, reason, items: lines, status: 'pending', reported_by_user_id: actor.id });
    await history(tx, sr, sr.status, 'shortage_reported', actor, reason, { items: lines, report_id: report.id });
    return { sr, report };
  });
  await notify(db, ['admin'], result.sr, 'supply_request_shortage', 'Shortage reported', `${result.sr.request_number}: Logistics reported a shortage. A new Fulfillment Decision is needed.`);
  return result.report;
}

export async function startPreparing(db: Db, actor: Row, id: number) {
  requireRole(actor, ['logistics']);
  return db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['scheduled'], 'Accept the schedule before preparing.');
    await requireNoPending(tx, sr);
    await history(tx, sr, 'preparing', 'preparing_started', actor, 'Preparing started.');
    return setStatus(tx, sr, 'preparing', { preparing_at: new Date() });
  });
}

const DRIVER_NAME = /^[\p{L} .'-]+$/u;
const PLATE = /^[A-Z]{2,3}[ -]?\d{3,4}$|^\d{3,4}[ -]?[A-Z]{2,3}$/;
const TOLERANCE_MS = 10 * 60_000;

/** Dispatch: driver and vehicle details; prepared must equal endorsed; stock leaves the warehouse now. */
export async function dispatchRequest(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['logistics']);
  const driver = String(input.driver_name ?? '').trim().replace(/\s+/g, ' ');
  if (!driver || !DRIVER_NAME.test(driver) || !/\p{L}/u.test(driver)) fail('driver_name', 'Enter the driver name (letters, spaces and . - \' only).');
  const contact = String(input.driver_contact ?? '').trim();
  if (!/^\d{11}$/.test(contact)) fail('driver_contact', 'The driver contact must be exactly 11 digits.');
  const plate = String(input.plate_number ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!PLATE.test(plate)) fail('plate_number', 'Enter a valid plate number (e.g. ABC 1234).');
  const departed = new Date(String(input.departed_at ?? ''));
  if (Number.isNaN(departed.getTime())) fail('departed_at', 'Enter the departure date and time.');
  if (departed.getTime() > Date.now() + TOLERANCE_MS) fail('departed_at', 'The departure cannot be in the future.');
  const eta = new Date(String(input.eta_at ?? ''));
  if (Number.isNaN(eta.getTime())) fail('eta_at', 'Enter the ETA.');
  if (eta < departed) fail('eta_at', 'The ETA must be on or after the departure.');
  const given = new Map<number, number>((Array.isArray(input.items) ? input.items : []).map((r: Row) => [Number(r.item_id), num(r.prepared)]));
  const result = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['preparing'], 'Only a request being prepared can be dispatched.');
    await requireNoPending(tx, sr);
    const warehouse = await warehouseOf(tx);
    const items = await itemsOf(tx, id);
    const lines: Row[] = [];
    for (const [index, item] of items.entries()) {
      const endorsed = num(item.quantity_endorsed ?? item.quantity_requested);
      const prepared = given.has(Number(item.id)) ? round2(given.get(Number(item.id))!) : endorsed;
      // Never short a delivery silently: a smaller quantity needs a shortage report and a new decision first.
      if (Math.abs(prepared - endorsed) > 1e-9) fail(`items.${index}.prepared`, `${item.product?.name ?? 'Item'}: the prepared quantity must equal the endorsed ${endorsed}. Report a shortage if you cannot prepare it.`);
      lines.push({ item, prepared });
    }
    const deducted: Row[] = [];
    for (const { item, prepared } of lines) {
      await updateRow(tx, 'supply_request_items', item.id, { quantity_prepared: prepared });
      if (prepared <= 0 || sr.stock_deducted_at) continue; // legacy rows were already deducted at Preparing
      const [inventory] = await tx.query(`select * from inventories where location_id = $1 and product_id = $2 for update`, [warehouse.id, item.product_id]);
      const before = num(inventory?.current_stock);
      if (!inventory || before < prepared) fail('items', `${item.product?.name ?? 'Item'}: the warehouse has only ${before}. Report a shortage.`);
      await adjustStock(tx, inventory.id, -prepared, 'fulfillment', actor, { referenceType: SUPPLY_MODEL, referenceId: sr.id, remarks: `Dispatched ${sr.request_number}` });
      await stockAudit(tx, actor, 'supply_request', `supply request ${sr.id}`, before, round2(before - prepared), { inventory: { ...inventory, product: item.product }, note: `Dispatched ${sr.request_number}` });
      deducted.push({ product_id: item.product_id, stock_before: before, quantity_deducted: prepared, stock_after: round2(before - prepared) });
    }
    await tx.query(`update supply_reservations set status = 'consumed', consumed_at = now(), updated_at = now() where supply_request_id = $1 and status = 'active'`, [id]);
    const fields = { driver_name: driver, driver_contact: contact, plate_number: plate, departed_at: departed, eta_at: eta, dispatched_at: departed };
    const [existing] = await tx.query(`select id from deliveries where supply_request_id = $1`, [id]);
    if (existing) await updateRow(tx, 'deliveries', existing.id, fields);
    else await insertRow(tx, 'deliveries', { supply_request_id: id, ...fields });
    await history(tx, sr, 'dispatched', 'dispatched', actor, `Dispatched with ${driver} (${plate}).`, { driver_name: driver, plate_number: plate, departed_at: departed, eta_at: eta, items: lines.map((l) => ({ item_id: l.item.id, prepared: l.prepared })), stock: deducted });
    const saved = await setStatus(tx, sr, 'dispatched', sr.stock_deducted_at ? {} : { stock_deducted_at: new Date() });
    return { saved, warnings: isWeekend(manilaDate(eta)) ? ['The ETA is on a weekend. Make sure the branch can receive.'] : [] };
  });
  await notifyBranch(db, result.saved, 'supply_request_dispatched', 'Supplies on the way', `${result.saved.request_number} left the warehouse with ${driver} (${plate}), ETA ${eta.toISOString()}.`);
  return result;
}

/** Both POD and branch receipt exist: completed, or discrepancy review when anything was damaged or short. */
async function closeIfComplete(tx: Db, sr: Row, actor: Row): Promise<Row> {
  const [delivery] = await tx.query(`select pod_encoded_at from deliveries where supply_request_id = $1`, [sr.id]);
  const [fresh] = await tx.query(`select * from supply_requests where id = $1`, [sr.id]);
  if (!delivery?.pod_encoded_at || !fresh.branch_received_at) return fresh;
  const [{ issues }] = await tx.query(`select count(*)::int as issues from supply_request_items where supply_request_id = $1 and (coalesce(received_damaged, 0) > 0 or coalesce(received_short, 0) > 0)`, [sr.id]);
  if (issues > 0) {
    await history(tx, fresh, 'discrepancy_review', 'discrepancy_opened', actor, 'Received with damaged or short items: Admin review needed.');
    return setStatus(tx, fresh, 'discrepancy_review');
  }
  await history(tx, fresh, 'completed', 'completed', actor, 'POD and branch receipt recorded: completed.');
  return setStatus(tx, fresh, 'completed', { completed_at: new Date() });
}

/** POD by Logistics: file (stored by the route), received-by name and the actual delivery time; may be encoded on a later day. */
export async function encodePod(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['logistics']);
  const receivedBy = String(input.received_by ?? '').trim();
  if (receivedBy.length < 2) fail('received_by', 'Enter who received the delivery.');
  const actual = new Date(String(input.actual_delivered_at ?? ''));
  if (Number.isNaN(actual.getTime())) fail('actual_delivered_at', 'Enter the actual delivery date and time.');
  if (actual.getTime() > Date.now() + TOLERANCE_MS) fail('actual_delivered_at', 'The actual delivery time cannot be in the future.');
  if (!input.document_id) fail('file', 'Attach the POD photo or signature.');
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['dispatched'], 'The POD is encoded after dispatch.');
    const [delivery] = await tx.query(`select * from deliveries where supply_request_id = $1 for update`, [id]);
    if (!delivery) fail('status', 'This request has no dispatch record.');
    if (delivery.pod_encoded_at) fail('status', 'The POD is already encoded.');
    if (delivery.departed_at && actual < new Date(delivery.departed_at)) fail('actual_delivered_at', 'The actual delivery time must be on or after the departure.');
    await updateRow(tx, 'deliveries', delivery.id, {
      recipient_name: receivedBy, actual_delivered_at: actual, delivered_at: actual, delivery_date: manilaDate(actual), pod_encoded_by_user_id: actor.id, pod_encoded_at: new Date(),
      pod_document_id: Number(input.document_id), delivered_by_user_id: actor.id, confirmed_by_party: 'logistics',
    });
    const received = Boolean(sr.branch_received_at);
    await history(tx, sr, received ? sr.status : 'delivered', 'pod_encoded', actor, `POD encoded. Received by ${receivedBy}.`, { actual_delivered_at: actual }, Number(input.document_id));
    if (received) return closeIfComplete(tx, sr, actor);
    return setStatus(tx, sr, 'delivered');
  });
  if (saved.status === 'delivered') await notifyBranch(db, saved, 'supply_request_delivered', 'Delivery recorded', `${saved.request_number} was delivered. Please confirm the items you received.`);
  if (saved.status === 'discrepancy_review') await notify(db, ['admin', 'logistics'], saved, 'supply_request_discrepancy', 'Delivery discrepancy', `${saved.request_number} was received with damaged or short items.`);
  return saved;
}

/**
 * Confirm Receipt by the branch, per item: good + damaged + short = dispatched quantity.
 * Only the good quantity is credited, immediately. Allowed once dispatched, before or after the POD.
 */
export async function confirmReceipt(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['franchisee']);
  const given = new Map<number, Row>((Array.isArray(input.lines) ? input.lines : []).map((r: Row) => [Number(r.item_id), r]));
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    const own = await resolveWorkspace(tx, actor);
    if (!own || Number(own.id) !== Number(sr.location_id)) abort(403, 'You can only confirm deliveries for your own branch.');
    requireStatus(sr, S.IN_TRANSIT, 'The receipt can be confirmed once the request is dispatched.');
    if (sr.branch_received_at) fail('status', 'The receipt is already confirmed.');
    const good = new Map<number, number>();
    const lines: Row[] = [];
    for (const [index, item] of (await itemsOf(tx, id)).entries()) {
      const shipped = num(item.quantity_prepared ?? item.quantity_endorsed ?? item.quantity_requested);
      if (shipped <= 0) continue;
      const row = given.get(Number(item.id)) ?? {};
      const g = round2(num(row.good));
      const d = round2(num(row.damaged));
      const s = round2(num(row.short));
      const name = item.product?.name ?? item.product_name_snapshot ?? 'Item';
      if ([g, d, s].some((x) => !Number.isFinite(x) || x < 0)) fail(`lines.${index}`, `${name}: quantities cannot be negative.`);
      if (Math.abs(g + d + s - shipped) > 1e-9) fail(`lines.${index}`, `${name}: good + damaged + short must equal the ${shipped} dispatched.`);
      const damageReason = d > 0 ? reasonOf(row.damage_reason, `lines.${index}.damage_reason`, `${name}: the damage reason`) : null;
      if (d > 0 && !row.photo_document_id) fail(`lines.${index}.photo`, `${name}: attach a photo of the damaged items.`);
      const shortReason = s > 0 ? reasonOf(row.short_reason, `lines.${index}.short_reason`, `${name}: the reason for the short quantity`) : null;
      await updateRow(tx, 'supply_request_items', item.id, {
        received_good: g, received_damaged: d, received_short: s, damage_reason: damageReason, short_reason: shortReason, quantity_fulfilled: g,
      });
      good.set(Number(item.id), g);
      lines.push({ item_id: item.id, product_id: item.product_id, dispatched: shipped, good: g, damaged: d, short: s, damage_reason: damageReason, short_reason: shortReason, photo_document_id: row.photo_document_id ?? null });
    }
    await creditReceived(tx, sr, actor, good);
    const pod = Boolean((await tx.query(`select pod_encoded_at from deliveries where supply_request_id = $1`, [id]))[0]?.pod_encoded_at);
    await history(tx, sr, sr.status, 'receipt_confirmed', actor, pod ? 'Branch confirmed the receipt.' : 'Branch confirmed the receipt (POD pending).', { lines });
    return closeIfComplete(tx, sr, actor);
  });
  if (saved.status === 'discrepancy_review') await notify(db, ['admin', 'logistics'], saved, 'supply_request_discrepancy', 'Delivery discrepancy', `${saved.request_number} was received with damaged or short items.`);
  else await notify(db, ['admin', 'logistics'], saved, 'supply_request_receipt_confirmed', 'Receipt confirmed', `${saved.request_number} was received by the branch.`);
  return saved;
}

export async function resolveDiscrepancy(db: Db, actor: Row, id: number, input: Row) {
  requireRole(actor, ['admin']);
  const action = String(input.action ?? '');
  if (!['accept_loss', 'logistics_investigation', 'branch_rerequest'].includes(action)) fail('action', 'Choose Accept loss, For Logistics investigation or Branch to re-request.');
  const remarks = reasonOf(input.remarks, 'remarks', 'Remarks');
  const saved = await db.tx(async (tx) => {
    const sr = await lockRequest(tx, id);
    requireStatus(sr, ['discrepancy_review'], 'Only a request in discrepancy review can be resolved.');
    await history(tx, sr, 'completed_with_discrepancy', 'discrepancy_resolved', actor, remarks, { action });
    return setStatus(tx, sr, 'completed_with_discrepancy', {
      discrepancy_action: action, discrepancy_remarks: remarks, discrepancy_resolved_by_user_id: actor.id, discrepancy_resolved_at: new Date(), completed_at: new Date(),
    });
  });
  const label = { accept_loss: 'Accept loss', logistics_investigation: 'For Logistics investigation', branch_rerequest: 'Branch to re-request' }[action];
  await notifyBranch(db, saved, 'supply_request_discrepancy_resolved', 'Discrepancy resolved', `${saved.request_number}: ${label}. ${remarks}`);
  await notify(db, ['logistics'], saved, 'supply_request_discrepancy_resolved', 'Discrepancy resolved', `${saved.request_number}: ${label}.`);
  return saved;
}

// ---- SLA: overdue (working days, Mon-Fri) ----
export interface SlaContext { pendingDateAt?: unknown; pendingShortageAt?: unknown; etaAt?: unknown; pod?: boolean }

/** Why a request is overdue, or null. Branch receipt is never overdue (a reminder is sent instead). */
export function overdueReason(sr: Row, ctx: SlaContext, today = manilaDate()): string | null {
  const day = (v: unknown) => (v ? manilaDate(new Date(v as string)) : null);
  const since = day(sr.status_changed_at ?? sr.updated_at ?? sr.created_at);
  if (['submitted', 'under_review'].includes(sr.status) && since && pastOneWorkingDay(since, today)) return 'No Admin action after 1 working day.';
  if (sr.status === 'waiting_logistics' && since && pastOneWorkingDay(since, today)) return 'No Logistics action after 1 working day.';
  const pendingAt = day(ctx.pendingDateAt) ?? day(ctx.pendingShortageAt);
  if (pendingAt && S.TO_SHIP.includes(sr.status) && pastOneWorkingDay(pendingAt, today)) return 'Admin has not answered the Logistics request after 1 working day.';
  if (sr.status === 'on_hold' && sr.expected_restock_date && String(sr.expected_restock_date).slice(0, 10) < today) return 'Past the expected restock date.';
  const eta = day(ctx.etaAt);
  if (sr.status === 'dispatched' && !ctx.pod && eta && today > addWorkingDays(nextWorkingDayOrSame(eta), 1)) return 'Past the ETA with no POD after 1 working day.';
  return null;
}

/** Status, owners and SLA for one request (used by lists and the detail view). */
export async function workflowState(db: Db, sr: Row): Promise<Row> {
  const pending = await pendingOf(db, sr.id);
  const [delivery] = await db.query(`select eta_at, pod_encoded_at from deliveries where supply_request_id = $1`, [sr.id]);
  const ctx = { pod: Boolean(delivery?.pod_encoded_at), received: Boolean(sr.branch_received_at), pendingDate: Boolean(pending.date), pendingShortage: Boolean(pending.shortage) };
  return {
    owners: S.ownersOf(sr.status, ctx),
    pending_date_change: pending.date, pending_shortage: pending.shortage,
    received: ctx.received, pod: ctx.pod,
    overdue_reason: overdueReason(sr, { pendingDateAt: pending.date?.created_at, pendingShortageAt: pending.shortage?.created_at, etaAt: delivery?.eta_at, pod: ctx.pod }),
  };
}

// ---- what Admin sees while reviewing ----
const SEVERITY: Record<string, number> = { none: 0, ok: 1, low: 2, critical: 3, out: 4 };

/**
 * Per item: requested, warehouse available (net of other reservations), unavailable, the
 * branch's stock status, days covered and suggested quantity (existing forecast, read only),
 * and the automatic Critical flag (branch stock Critical/Out, or fewer days covered than the
 * supply lead time). Information only: Admin still decides.
 */
export async function reviewLines(db: Db, sr: Row): Promise<Row[]> {
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [sr.location_id]);
  const availability = await availabilityOf(db, sr);
  const forecast = location ? await forecastFor(db, location, availability.map((l) => l.product_id)) : new Map();
  const { lead_days } = await supplySettings(db);
  const materials = await db.query(
    `select m.*, (select to_jsonb(b) from profittrack_material_balances b where b.material_id = m.id limit 1) as balance
     from profittrack_materials m where m.location_id = $1 and m.is_active = true and m.warehouse_product_id = any($2::bigint[])`,
    [sr.location_id, `{${availability.map((l) => l.product_id).join(',')}}`],
  );
  return availability.map((line) => {
    // A product can feed more than one branch material: the worst one speaks for it.
    let status = 'none';
    let onHand: number | null = null;
    for (const m of materials.filter((x) => Number(x.warehouse_product_id) === line.product_id)) {
      const e = evaluate(m);
      onHand = (onHand ?? 0) + e.on_hand;
      if (SEVERITY[e.status] > SEVERITY[status]) status = e.status;
    }
    const f = forecast.get(line.product_id) ?? { suggested: null, days_covered: null };
    const critical = ['critical', 'out'].includes(status) || (f.days_covered !== null && f.days_covered < lead_days);
    return {
      ...line, branch_stock_status: status, branch_stock_label: STOCK_LABELS[status], branch_on_hand: onHand,
      days_covered: f.days_covered, suggested: f.suggested, critical,
    };
  });
}

/** The Delivery Receipt Logistics prints after dispatch. */
export async function deliveryReceipt(db: Db, id: number): Promise<Row | null> {
  const [sr] = await db.query(
    `select sr.*, l.name as branch_name, l.city, l.contact_number as branch_contact, (select b.name from brands b where b.id = l.brand_id) as brand_name
     from supply_requests sr join franchise_locations l on l.id = sr.location_id where sr.id = $1`, [id],
  );
  const [delivery] = await db.query(`select * from deliveries where supply_request_id = $1`, [id]);
  if (!sr || !delivery?.departed_at) return null;
  const items = await itemsOf(db, id);
  return {
    request_number: sr.request_number, branch: sr.branch_name, city: sr.city, brand: sr.brand_name,
    address: sr.delivery_address, contact: sr.contact_number ?? sr.branch_contact ?? null,
    items: items.filter((i) => num(i.quantity_prepared) > 0).map((i) => ({ name: i.product?.name ?? i.product_name_snapshot, unit: i.product?.unit ?? i.unit_snapshot, quantity: num(i.quantity_prepared) })),
    driver_name: delivery.driver_name, driver_contact: delivery.driver_contact, plate_number: delivery.plate_number,
    departed_at: delivery.departed_at, eta_at: delivery.eta_at, eta_weekend: delivery.eta_at ? isWeekend(manilaDate(new Date(delivery.eta_at))) : false,
    signatures: ['Released by', 'Received by'],
  };
}
