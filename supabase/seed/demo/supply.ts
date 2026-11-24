// Supply requests built from the branch simulation (the restock cycle), plus the open requests of
// every workflow status and the closed special cases. Each request carries the status history,
// items, reservations, delivery and POD that the workflow would have written. The warehouse draws
// (dispatches) and reservations are returned for the warehouse step.
import type { Db, Row } from './common.ts';
import { addDays, addWorkingDays, at, Batch, Ids, isWeekday, LAST_DAY, MODELS, nextWeekday, plusMinutes, rng, round } from './common.ts';
import type { Mat, SimRequest, SimResult } from './branches.ts';

export interface Draw { productId: number; qty: number; at: Date; requestId: number; number: string }
export interface Reserve { productId: number; qty: number; requestId: number; itemId: number }
interface Ev { to: string; action: string; at: Date; actor: Row; remarks: string; payload?: Row | null; doc?: number | null }

const RANK: Record<string, number> = { dispatched_overdue: 9, delivered_unconfirmed: 8, dispatched_pod_ready: 7, preparing_shortage: 6, preparing: 5, on_hold: 5, scheduled_date_change: 4, scheduled: 4, waiting_logistics: 3, under_review: 2, submitted: 1 };
const DRIVERS = [['Jun Rey Dela Cruz', '09171234561', 'NBC 4821'], ['Romeo Santos', '09281234562', 'ABK 7315'], ['Elmer Villareal', '09391234563', 'NDS 2094'], ['Arnel Bautista', '09451234564', 'ZTR 5628']];

export interface SupplyContext { db: Db; ids: Ids; batch: Batch; admin: Row; logistics: Row; warehouseId: number; docs: Record<string, { path: string; name: string; mime: string; size: number }> }

export async function writeSupply(ctx: SupplyContext, sims: SimResult[]) {
  const { db, ids, batch, admin, logistics } = ctx;
  const draws: Draw[] = [];
  const reserves: Reserve[] = [];
  const holds: { productId: number; requested: number; requestId: number }[] = [];
  const used = new Set<string>();
  const products = new Map<number, Row>();
  const wpIds = [...new Set(sims.flatMap((s) => s.branch.mats.map((m) => m.wp).filter((x): x is number => x !== null)))];
  for (const p of await db.query(`select id, name, unit, brand_id, pack_size from products where id = any($1::bigint[])`, [`{${wpIds.join(',')}}`])) products.set(Number(p.id), p);
  const r = rng('supply-numbers');
  const numberFor = (day: string) => {
    for (;;) {
      const n = `FT-${day.replace(/-/g, '')}-${Array.from({ length: 6 }, () => r.pick('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''))).join('')}`;
      if (!used.has(n)) { used.add(n); return n; }
    }
  };
  const officeTime = (day: string, hhmm: string) => at(nextWeekday(day), hhmm);

  async function emit(sim: SimResult, req: SimRequest, state: string | null, opts: { parent?: Row } = {}) {
    const b = sim.branch;
    const branchUser = b.user;
    const id = await ids.next('supply_requests');
    req.id = id;
    req.number ??= numberFor(req.createdDay);
    const events: Ev[] = [];
    const ev = (to: string, action: string, when: Date, actor: Row, remarks: string, payload: Row | null = null, doc: number | null = null) => events.push({ to, action, at: when, actor, remarks, payload, doc });
    const lines = req.lines.filter((l) => l.qty > 0 && l.mat.wp !== null);
    const items = [];
    for (const l of lines) items.push({ id: await ids.next('supply_request_items'), mat: l.mat, qty: l.qty, product: products.get(l.mat.wp!)! });
    const fields: Row = {
      id, request_number: req.number, location_id: b.location.id, requested_by_user_id: branchUser.id, delivery_address: b.location.address, contact_number: b.location.contact_number ?? null,
      urgency: 'normal', target_delivery_date: req.delivery, created_at: req.created, submitted_at: req.created,
    };
    const itemRow = (it: typeof items[number], extra: Row = {}) => ({
      id: it.id, supply_request_id: id, product_id: it.product.id, quantity_requested: it.qty, quantity_fulfilled: 0, product_name_snapshot: it.product.name, unit_snapshot: it.product.unit,
      suggested_quantity: null, over_bulk: false, created_at: req.created, updated_at: req.created, ...extra,
    });
    const reviewAt = isWeekday(req.createdDay) ? plusMinutes(req.created, 150 + (id % 60)) : officeTime(req.createdDay, '09:40');
    const endorseAt = plusMinutes(reviewAt, 25);
    let delivery: Row | null = null;
    const reserve = async (it: typeof items[number], qty: number, status: 'active' | 'consumed', consumedAt: Date | null) => {
      batch.add('supply_reservations', { id: await ids.next('supply_reservations'), supply_request_id: id, supply_request_item_id: it.id, product_id: it.product.id, location_id: ctx.warehouseId, quantity: qty, status, created_by_user_id: admin.id, consumed_at: consumedAt, created_at: endorseAt, updated_at: consumedAt ?? endorseAt });
      if (status === 'active') reserves.push({ productId: it.product.id, qty, requestId: id, itemId: it.id });
    };

    ev('submitted', 'submitted', req.created, branchUser, 'Request submitted.', { warnings: [] });
    if (state === 'submitted' || state === 'draft') {
      if (state === 'draft') { events.length = 0; ev('draft', 'draft_created', req.created, branchUser, 'Draft saved.', { warnings: [] }); fields.submitted_at = null; }
      for (const it of items) batch.add('supply_request_items', itemRow(it));
      return finish();
    }
    ev('under_review', 'review_started', reviewAt, admin, 'Review started.');
    Object.assign(fields, { reviewed_by_user_id: admin.id, reviewed_at: reviewAt });
    if (state === 'under_review') { for (const it of items) batch.add('supply_request_items', itemRow(it)); return finish(); }
    if (state === 'rejected' || state === 'returned') {
      const reason = state === 'rejected' ? 'Duplicate of an open request for the same items. Please wait for that delivery.' : 'Quantities are above one week of use. Please revise to the suggested quantities and resubmit.';
      ev(state, state, plusMinutes(reviewAt, 20), admin, reason);
      Object.assign(fields, state === 'rejected' ? { rejected_reason: reason, rejected_by_user_id: admin.id, rejected_at: plusMinutes(reviewAt, 20) } : { returned_reason: reason, returned_by_user_id: admin.id, returned_at: plusMinutes(reviewAt, 20) });
      for (const it of items) batch.add('supply_request_items', itemRow(it));
      return finish();
    }
    if (state === 'on_hold') {
      const restock = '2026-11-27';
      const short = items[0];
      const linesOut = items.map((it, i) => ({ item_id: it.id, product_id: it.product.id, requested: it.qty, available: i === 0 ? round(it.qty * 0.3, 2) : it.qty, unavailable: i === 0 ? round(it.qty * 0.7, 2) : 0, restock_date: i === 0 ? restock : null }));
      const reason = `${short.product.name} is short at the warehouse; the supplier delivers on Nov 27.`;
      ev('on_hold', 'fulfillment_hold', endorseAt, admin, reason, { fulfillment_type: 'hold', items: linesOut });
      Object.assign(fields, { fulfillment_type: 'hold', fulfillment_reason: reason, fulfillment_decided_by_user_id: admin.id, fulfillment_decided_at: endorseAt, endorsed_by_user_id: admin.id, endorsed_at: endorseAt, expected_restock_date: restock, on_hold_at: endorseAt });
      items.forEach((it, i) => batch.add('supply_request_items', itemRow(it, { quantity_available: linesOut[i].available, quantity_unavailable: linesOut[i].unavailable, expected_restock_date: linesOut[i].restock_date, quantity_endorsed: null })));
      holds.push({ productId: short.product.id, requested: short.qty, requestId: id });
      return finish();
    }
    // Endorsed (full, or partial ship-now with a backorder child).
    const partial = req.partial;
    const endorsedQty = (it: typeof items[number]) => (partial && partial.matId === it.mat.id ? partial.shipped : it.qty);
    if (partial) {
      const reason = 'Part of the order is short at the warehouse: the available quantity ships now, the rest follows as a backorder.';
      ev('waiting_logistics', 'fulfillment_partial_ship_now', endorseAt, admin, reason, { fulfillment_type: 'partial_ship_now' });
      Object.assign(fields, { fulfillment_type: 'partial_ship_now', fulfillment_reason: reason });
    } else {
      ev('waiting_logistics', 'endorsed_full', endorseAt, admin, 'Endorsed – Full. Stock reserved.', { fulfillment_type: 'full', items: items.map((it) => ({ item_id: it.id, product_id: it.product.id, requested: it.qty })) });
      Object.assign(fields, { fulfillment_type: 'full', fulfillment_reason: null });
    }
    Object.assign(fields, { fulfillment_decided_by_user_id: admin.id, fulfillment_decided_at: endorseAt, endorsed_by_user_id: admin.id, endorsed_at: endorseAt });

    // Logistics: schedule, prepare, dispatch (the scenario decides the days).
    let scheduledAt: Date; let preparingAt: Date | null = null; let dispatchAt: Date | null = null; let eta: Date | null = null; let confirmed = req.delivery;
    const dispatchDay = (() => { let d = addWorkingDays(req.createdDay, 1); if (d > addDays(req.delivery, -2)) d = addDays(req.delivery, -2); return d; })();
    if (state === 'dispatched_pod_ready') { scheduledAt = at('2026-11-20', '09:30'); confirmed = '2026-11-25'; preparingAt = at('2026-11-23', '09:30'); dispatchAt = at('2026-11-23', '14:00'); eta = at('2026-11-25', '09:30'); }
    else if (state === 'dispatched_overdue') { scheduledAt = at(addWorkingDays(req.createdDay, 1), '09:30'); confirmed = addDays(addWorkingDays(req.createdDay, 1), 2); preparingAt = at(addWorkingDays(req.createdDay, 1), '10:30'); dispatchAt = at(addWorkingDays(req.createdDay, 1), '14:00'); eta = at(confirmed, '10:00'); }
    else if (state === 'delivered_unconfirmed') { scheduledAt = at(addWorkingDays(req.createdDay, 1), '09:30'); confirmed = addDays(addWorkingDays(req.createdDay, 1), 2); preparingAt = at(addWorkingDays(req.createdDay, 1), '10:30'); dispatchAt = at(addWorkingDays(req.createdDay, 1), '14:00'); eta = at(confirmed, '10:00'); }
    else if (state && state !== 'waiting_logistics') { scheduledAt = at(LAST_DAY, '09:30'); confirmed = '2026-11-26'; if (state.startsWith('preparing')) preparingAt = at(LAST_DAY, '13:00'); }
    else { scheduledAt = at(dispatchDay, '09:30'); preparingAt = at(dispatchDay, '10:30'); dispatchAt = at(dispatchDay, '14:00'); eta = at(req.delivery, '09:00'); }
    fields.target_delivery_date = confirmed;

    if (state === 'waiting_logistics') {
      for (const it of items) { batch.add('supply_request_items', itemRow(it, { quantity_available: it.qty, quantity_unavailable: 0, quantity_endorsed: it.qty })); await reserve(it, it.qty, 'active', null); }
      return finish();
    }
    ev('scheduled', 'schedule_accepted', scheduledAt, logistics, `Schedule confirmed for ${confirmed}.`, { confirmed_delivery_date: confirmed });
    Object.assign(fields, { confirmed_delivery_date: confirmed, scheduled_by_user_id: logistics.id, scheduled_at: scheduledAt });
    if (preparingAt) { ev('preparing', 'preparing_started', preparingAt, logistics, 'Preparing started.'); fields.preparing_at = preparingAt; }
    if (state === 'scheduled_date_change') {
      const proposed = '2026-11-27';
      const reason = 'The delivery truck for this route is under maintenance on Nov 26.';
      const revision = await ids.next('supply_request_date_revisions');
      batch.add('supply_request_date_revisions', { id: revision, supply_request_id: id, original_delivery_date: confirmed, revised_delivery_date: proposed, note: reason, reason, status: 'pending', proposed_by_user_id: logistics.id, proposed_by_role: 'logistics', created_at: at(LAST_DAY, '15:10'), updated_at: at(LAST_DAY, '15:10') });
      ev('scheduled', 'date_change_requested', at(LAST_DAY, '15:10'), logistics, reason, { proposed_date: proposed, revision_id: revision });
    }
    if (state === 'scheduled' || state === 'scheduled_date_change' || state === 'preparing' || state === 'preparing_shortage') {
      for (const it of items) { batch.add('supply_request_items', itemRow(it, { quantity_available: it.qty, quantity_unavailable: 0, quantity_endorsed: it.qty })); await reserve(it, it.qty, 'active', null); }
      if (state === 'preparing_shortage') {
        const it = items[0];
        const reportId = await ids.next('supply_shortage_reports');
        const reason = `Only part of the ${it.product.name} on the shelf passed the quality check this morning.`;
        const lns = items.map((x, i) => ({ item_id: x.id, product_id: x.product.id, name: x.product.name, to_ship: x.qty, actual_count: i === 0 ? round(x.qty * 0.5, 2) : x.qty }));
        batch.add('supply_shortage_reports', { id: reportId, supply_request_id: id, stage: 'preparing', reason, items: lns, status: 'pending', reported_by_user_id: logistics.id, created_at: at(LAST_DAY, '14:30'), updated_at: at(LAST_DAY, '14:30') });
        ev('preparing', 'shortage_reported', at(LAST_DAY, '14:30'), logistics, reason, { items: lns, report_id: reportId });
      }
      return finish();
    }
    // Dispatched: the warehouse stock leaves now; the reservation is consumed.
    const driver = DRIVERS[id % DRIVERS.length];
    for (const it of items) {
      const q = endorsedQty(it);
      draws.push({ productId: it.product.id, qty: q, at: dispatchAt!, requestId: id, number: req.number });
      await reserve(it, q, 'consumed', dispatchAt);
    }
    ev('dispatched', 'dispatched', dispatchAt!, logistics, `Dispatched with ${driver[0]} (${driver[2]}).`, { driver_name: driver[0], plate_number: driver[2], departed_at: dispatchAt, eta_at: eta });
    fields.stock_deducted_at = dispatchAt;
    const deliveryId = await ids.next('deliveries');
    delivery = { id: deliveryId, supply_request_id: id, dispatched_at: dispatchAt, departed_at: dispatchAt, eta_at: eta, driver_name: driver[0], driver_contact: driver[1], plate_number: driver[2], created_at: dispatchAt, updated_at: dispatchAt };
    const receipt = sim.receipts.find((x) => x.req === req);
    const received = state === null && receipt;
    let podAt: Date | null = null;
    if (state === 'delivered_unconfirmed' || received) {
      const arrival = received ? receipt!.at : at(confirmed, '10:15');
      podAt = received ? (isWeekday(req.delivery) ? at(req.delivery, '10:20') : officeTime(req.delivery, '09:35')) : at(LAST_DAY, '09:40');
      const docId = await doc('App\\Models\\Delivery', deliveryId, 'proof_of_delivery', 'pod', `POD-${req.number}.png`, logistics.id, podAt);
      Object.assign(delivery, { recipient_name: branchUser.full_name, actual_delivered_at: arrival, delivered_at: arrival, delivery_date: req.delivery, pod_encoded_by_user_id: logistics.id, pod_encoded_at: podAt, pod_document_id: docId, delivered_by_user_id: logistics.id, confirmed_by_party: 'logistics', updated_at: podAt });
      if (received) {
        const lns = items.map((it) => {
          const shipped = endorsedQty(it);
          const damaged = req.damaged && req.damaged.matId === it.mat.id ? req.damaged.qty : 0;
          return { item_id: it.id, product_id: it.product.id, dispatched: shipped, good: round(shipped - damaged, 2), damaged, short: 0, damage_reason: damaged ? 'Crushed boxes; the inner packs were punctured in transit.' : null, short_reason: null, photo_document_id: null as number | null };
        });
        for (const l of lns) if (l.damaged > 0) l.photo_document_id = await doc(MODELS.supply, id, 'receipt_damage_photo', 'damaged', 'damaged-items.jpg', branchUser.id, receipt!.at, { item_id: l.item_id });
        ev('dispatched', 'receipt_confirmed', receipt!.at, branchUser, 'Branch confirmed the receipt (POD pending).', { lines: lns });
        Object.assign(fields, { branch_received_at: receipt!.at, branch_received_by_user_id: branchUser.id });
        ev('dispatched', 'pod_encoded', podAt, logistics, `POD encoded. Received by ${branchUser.full_name}.`, { actual_delivered_at: arrival }, delivery.pod_document_id);
        items.forEach((it, i) => batch.add('supply_request_items', itemRow(it, {
          quantity_available: partial && partial.matId === it.mat.id ? partial.shipped : it.qty, quantity_unavailable: partial && partial.matId === it.mat.id ? partial.backorder : 0,
          quantity_endorsed: endorsedQty(it), quantity_prepared: endorsedQty(it), quantity_fulfilled: lns[i].good, received_good: lns[i].good, received_damaged: lns[i].damaged, received_short: 0, damage_reason: lns[i].damage_reason,
        })));
        if (lns.some((l) => l.damaged > 0)) {
          ev('discrepancy_review', 'discrepancy_opened', podAt, logistics, 'Received with damaged or short items: Admin review needed.');
          if (req.special === 'completed_with_discrepancy') {
            const resolved = officeTime(addDays(req.delivery, 1), '10:05');
            ev('completed_with_discrepancy', 'discrepancy_resolved', resolved, admin, 'Damage confirmed from the photos; the supplier credits the loss.', { action: 'accept_loss' });
            Object.assign(fields, { discrepancy_action: 'accept_loss', discrepancy_remarks: 'Damage confirmed from the photos; the supplier credits the loss.', discrepancy_resolved_by_user_id: admin.id, discrepancy_resolved_at: resolved, completed_at: resolved });
          }
        } else {
          ev('completed', 'completed', podAt, logistics, 'POD and branch receipt recorded: completed.');
          fields.completed_at = podAt;
        }
      } else {
        ev('delivered', 'pod_encoded', podAt, logistics, `POD encoded. Received by ${branchUser.full_name}.`, { actual_delivered_at: arrival }, delivery.pod_document_id);
        for (const it of items) batch.add('supply_request_items', itemRow(it, { quantity_available: it.qty, quantity_unavailable: 0, quantity_endorsed: it.qty, quantity_prepared: it.qty }));
      }
    } else {
      for (const it of items) batch.add('supply_request_items', itemRow(it, { quantity_available: it.qty, quantity_unavailable: 0, quantity_endorsed: it.qty, quantity_prepared: it.qty }));
    }
    batch.add('deliveries', delivery);
    // The backorder child of a partial ship-now.
    if (partial) {
      const it = items.find((x) => x.mat.id === partial.matId)!;
      const child = await ids.next('supply_requests');
      const reason = 'Part of the order is short at the warehouse: the available quantity ships now, the rest follows as a backorder.';
      batch.add('supply_requests', {
        id: child, request_number: `${req.number}-B`, location_id: b.location.id, requested_by_user_id: branchUser.id, status: 'on_hold', status_changed_at: endorseAt, submitted_at: endorseAt,
        target_delivery_date: req.delivery, delivery_address: b.location.address, contact_number: b.location.contact_number ?? null, remarks: `Backorder of ${req.number}.`, urgency: 'normal', parent_request_id: id, backorder_seq: 1,
        fulfillment_type: 'hold', fulfillment_reason: reason, fulfillment_decided_by_user_id: admin.id, fulfillment_decided_at: endorseAt, expected_restock_date: '2026-11-27', on_hold_at: endorseAt,
        reviewed_by_user_id: admin.id, reviewed_at: endorseAt, created_at: endorseAt, updated_at: endorseAt, restock_revision_count: 1,
      });
      batch.add('supply_request_items', { id: await ids.next('supply_request_items'), supply_request_id: child, product_id: it.product.id, quantity_requested: partial.backorder, quantity_fulfilled: 0, product_name_snapshot: it.product.name, unit_snapshot: it.product.unit, quantity_available: 0, quantity_unavailable: partial.backorder, expected_restock_date: '2026-11-27', created_at: endorseAt, updated_at: endorseAt });
      batch.add('supply_request_status_histories', { id: await ids.next('supply_request_status_histories'), supply_request_id: child, from_status: null, to_status: 'on_hold', action: 'backorder_created', actor_role: 'admin', remarks: `Backorder of ${req.number}: ${reason}`, payload: null, changed_by_user_id: admin.id, created_at: endorseAt, updated_at: endorseAt });
      batch.add('supply_request_status_histories', { id: await ids.next('supply_request_status_histories'), supply_request_id: child, from_status: 'on_hold', to_status: 'on_hold', action: 'restock_date_updated', actor_role: 'admin', remarks: 'Supplier moved the delivery to Nov 27.', payload: { from: '2026-11-20', to: '2026-11-27', revision: 1 }, changed_by_user_id: admin.id, created_at: at('2026-11-19', '15:20'), updated_at: at('2026-11-19', '15:20') });
      holds.push({ productId: it.product.id, requested: partial.backorder, requestId: child });
    }
    return finish();

    function finish() {
      let from: string | null = null;
      let last = req.created;
      for (const e of events.sort((a, c) => a.at.getTime() - c.at.getTime())) {
        batch.add('supply_request_status_histories', { id: null, supply_request_id: id, from_status: from, to_status: e.to, action: e.action, actor_role: e.actor.role_name ?? e.actor.role?.name ?? null, remarks: e.remarks, payload: e.payload ?? null, changed_by_user_id: e.actor.id, document_id: e.doc ?? null, created_at: e.at, updated_at: e.at });
        if (e.to !== from) last = e.at;
        from = e.to;
      }
      const status = events.length ? events[events.length - 1].to : 'draft';
      batch.add('supply_requests', { ...fields, status, status_changed_at: last, updated_at: events.length ? events[events.length - 1].at : req.created });
      return id;
    }
  }

  async function doc(type: string, ownerId: number, docType: string, file: string, name: string, userId: number, when: Date, metadata: Row | null = null) {
    const f = ctx.docs[file];
    const id = await ids.next('documents');
    batch.add('documents', { id, documentable_type: type, documentable_id: ownerId, type: docType, original_name: name, stored_name: f.path.split('/').pop(), disk: 'private', path: f.path, mime_type: f.mime, size_bytes: f.size, uploaded_by_user_id: userId, metadata: { sample_demo_data: true, ...(metadata ?? {}) }, created_at: when, updated_at: when });
    return id;
  }

  // Requests of each branch: the simulated cycle, the open ones (by scenario) and the closed specials.
  for (const sim of sims) {
    const b = sim.branch;
    const open = sim.requests.filter((q) => q.state).sort((a, c) => a.created.getTime() - c.created.getTime());
    const states = [...b.spec.openStates].sort((a, c) => (RANK[c] ?? 0) - (RANK[a] ?? 0));
    while (open.length < states.length) open.push(synthetic(sim, LAST_DAY, '10:15'));
    const stateOf = new Map<SimRequest, string>();
    open.forEach((q, i) => stateOf.set(q, states[i] ?? (q.createdDay >= LAST_DAY ? 'submitted' : 'scheduled')));
    for (const q of sim.requests) await emit(sim, q, q.state ? stateOf.get(q)! : null);
    for (const q of open.filter((x) => !sim.requests.includes(x))) await emit(sim, q, stateOf.get(q)!);
    for (const extra of b.spec.extras) {
      const day = { rejected: b.spec.code.startsWith('GD') ? '2026-10-14' : '2026-10-21', cancelled: '2026-11-16', returned: '2026-11-20', draft: LAST_DAY }[extra as 'rejected'];
      if (!day) continue;
      const q = synthetic(sim, day, '11:05');
      if (extra === 'cancelled') {
        const id = await emitCancelled(sim, q);
        void id;
      } else await emit(sim, q, extra);
    }
  }

  function synthetic(sim: SimResult, day: string, time: string): SimRequest {
    const b = sim.branch;
    const used = new Map<number, number>();
    for (const d of sim.days.slice(-14)) for (const p of d.batches) for (const ing of p.recipe.ingredients) used.set(ing.materialId, (used.get(ing.materialId) ?? 0) + ing.perPiece * p.pieces);
    const top = b.mats.filter((m: Mat) => m.wp !== null && (used.get(m.id) ?? 0) > 0 && !(b.spec.forecast.lowCover ?? []).some((re) => re.test(m.name)))
      .sort((a, c) => (used.get(c.id) ?? 0) - (used.get(a.id) ?? 0)).slice(0, 4);
    const lines = top.map((m) => ({ mat: m, qty: Math.max(1, Math.ceil(((used.get(m.id) ?? 0) / 14) * 7 / 1000)) }));
    return { branch: b, created: at(day, time), createdDay: day, delivery: addWorkingDays(day, 2), lines, state: 'open' };
  }

  async function emitCancelled(sim: SimResult, q: SimRequest) {
    const id = await emit(sim, q, 'submitted');
    // Turn the submitted request into a cancelled one: the branch cancelled it before the review.
    const rows = batch.tables.get('supply_requests')!;
    const row = rows.find((x) => x.id === id)!;
    const when = plusMinutes(q.created, 55);
    const reason = 'Ordered twice by mistake; keeping the earlier request.';
    Object.assign(row, { status: 'cancelled', cancelled_reason: reason, cancelled_by_user_id: sim.branch.user.id, cancelled_at: when, status_changed_at: when, updated_at: when });
    batch.add('supply_request_status_histories', { id: null, supply_request_id: id, from_status: 'submitted', to_status: 'cancelled', action: 'cancelled', actor_role: 'franchisee', remarks: reason, payload: null, changed_by_user_id: sim.branch.user.id, document_id: null, created_at: when, updated_at: when });
    return id;
  }

  // History rows need ids too.
  for (const h of batch.tables.get('supply_request_status_histories') ?? []) if (h.id === null) h.id = await ids.next('supply_request_status_histories');
  return { draws, reserves, holds, products };
}
