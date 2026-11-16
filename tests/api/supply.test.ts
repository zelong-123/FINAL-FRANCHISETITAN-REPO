// Warehouse stock, CSV import, brand products and the supply workflow through to branch stock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, SALES, setup } from '../support/harness.ts';
import { earliestTargetDate, manilaDate } from '../../supabase/functions/api/services/workingDays.ts';

const { pg, call, login, db, auth, files } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id, name from brands order by id limit 1`);
const [category] = await q(`select id from product_categories where brand_id = $1 limit 1`, [brand.id]);

// A real, active branch account built through the database, as the pipeline test proves separately.
async function branchAccount() {
  const [roleRow] = await q(`select id from roles where name = 'franchisee'`);
  const email = 'branch.supply@test.local';
  const uid = await auth.addUser(email, PASSWORD);
  const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, 'Branch Owner', $2, 'active', $3::uuid) returning id`, [roleRow.id, email, uid]);
  const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ('Branch Owner', 'active_franchisee', $1, $2, '2026-01-01') returning id`, [user.id, brand.id]);
  const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Owner Co', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
  const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, type, address, is_active) values ($1, $2, 'Test Branch', 'franchise', 'Addr', true) returning id`, [franchisee.id, brand.id]);
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD, portal: 'branch' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { token: res.json.data.token as string, locationId: location.id as number, userId: user.id as number };
}
const branch = await branchAccount();

let inventoryId: number;
let productId: number;

test('warehouse: Admin adds catalog only, Logistics owns the quantities', async () => {
  const body = { name: 'Vanilla Syrup', brand_id: brand.id, category_id: category.id, unit: 'bottle', reorder_level: 20, critical_level: 5 };
  assert.match((await call('POST', '/inventories/items', { token: admin, body: { ...body, opening_quantity: 5 } })).json.errors.opening_quantity[0], /Only Logistics/);
  assert.match((await call('POST', '/inventories/items', { token: admin, body: { ...body, critical_level: 50 } })).json.errors.critical_level[0], /must not exceed/);
  const created = await call('POST', '/inventories/items', { token: admin, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  inventoryId = created.json.data.id;
  productId = created.json.data.product_id;
  assert.match(created.json.data.product.sku, /^[A-Z0-9]+-[A-Z]+-\d{4}$/);
  assert.equal(created.json.data.stock_status, 'critical');
  assert.match((await call('POST', '/inventories/items', { token: logistics, body: { ...body, name: 'VANILLA syrup' } })).json.errors.name[0], /already exists/);

  assert.equal((await call('POST', `/inventories/${inventoryId}/quantity`, { token: admin, body: { direction: 'increase', quantity: 5 } })).status, 403);
  const stocked = await call('POST', `/inventories/${inventoryId}/quantity`, { token: logistics, body: { direction: 'increase', quantity: 100, note: 'First delivery' } });
  assert.equal(stocked.json.data.transaction.balance_after, '100.00');
  assert.match((await call('POST', `/inventories/${inventoryId}/quantity`, { token: logistics, body: { direction: 'decrease', quantity: 500 } })).json.errors.quantity[0], /below zero/);
  const grouped = await call('GET', `/inventories/grouped?brand_id=${brand.id}`, { token: logistics });
  assert.equal(grouped.json.data.summary.total_units, 100);
  assert.equal(grouped.json.data.groups[0].items[0].status, 'normal');
  assert.equal((await call('GET', '/inventory-audit-logs', { token: admin })).json.data[0].action, 'adjust');
  assert.equal((await call('GET', '/inventories', { token: sales })).status, 403);
});

test('warehouse CSV: preview finds problems, apply updates exactly what it previewed', async () => {
  const template = await call('GET', `/warehouse/import-template?brand_id=${brand.id}`, { token: logistics });
  assert.equal(template.res.headers.get('x-template-rows'), '1');
  const text = await template.res.text();
  assert.match(text, /^brand,sku,product_name,category,unit,quantity\r\n/);
  assert.match(text, /Vanilla Syrup/);
  const sku = (await q(`select sku from products where id = $1`, [productId]))[0].sku;

  const csv = `sku,quantity,unit\n${sku},150,bottle\nNOPE-1,3,\n1.2E+5,1,\n${sku},,\n`;
  const preview = await call('POST', '/warehouse/import/preview', { token: logistics, body: { brand_id: brand.id, mode: 'set', csv } });
  assert.equal(preview.json.data.error_count, 2);
  assert.equal(preview.json.data.skipped_count, 1);
  assert.equal(preview.json.data.can_apply, false);
  assert.match(preview.json.data.errors[1].message, /scientific notation/);
  assert.equal((await call('POST', '/warehouse/import/apply', { token: logistics, body: { brand_id: brand.id, mode: 'set', csv } })).status, 422);
  assert.match((await call('POST', '/warehouse/import/preview', { token: logistics, body: { brand_id: brand.id, mode: 'set', csv: 'name\nfoo' } })).json.errors.csv[0], /missing the required/);

  const duplicate = `sku,quantity\n${sku},1\n${sku},2\n`;
  const dup = await call('POST', '/warehouse/import/preview', { token: logistics, body: { brand_id: brand.id, mode: 'set', csv: duplicate } });
  assert.equal(dup.json.data.duplicate_count, 2);
  assert.match(dup.json.data.duplicates[0].message, /Lines 2 and 3/);

  const quoted = `"sku";"quantity"\n"${sku}";"120"\n`;
  const applied = await call('POST', '/warehouse/import/apply', { token: logistics, body: { brand_id: brand.id, mode: 'set', csv: quoted } });
  assert.equal(applied.json.data.updated, 1, JSON.stringify(applied.json));
  assert.equal((await q(`select current_stock from inventories where id = $1`, [inventoryId]))[0].current_stock, '120.00');
  const same = await call('POST', '/warehouse/import/apply', { token: logistics, body: { brand_id: brand.id, mode: 'set', csv: quoted } });
  assert.equal(same.json.data.unchanged, 1, 'matching quantity writes nothing');
  const exported = await call('GET', `/warehouse/export?brand_id=${brand.id}`, { token: logistics });
  assert.match(await exported.res.text(), /120,20,5,NORMAL/);
  assert.equal((await call('POST', `/inventories/${inventoryId}/forecast`, { token: admin, body: {} })).json.data.method, 'simple_moving_average');
});

const stockOf = async () => Number((await q(`select current_stock from inventories where id = $1`, [inventoryId]))[0].current_stock);
const reservedOf = async (id: number) => Number((await q(`select coalesce(sum(quantity), 0) as q from supply_reservations where supply_request_id = $1 and status = 'active'`, [id]))[0].q);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const later = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const driver = { driver_name: "Ma. Santos-Dela Cruz", driver_contact: '09171234567', plate_number: 'abc 1234' };

test('supply: role scoping, reservation at endorsement, deduction at dispatch and per-item receipt', async () => {
  const body = { location_id: branch.locationId, delivery_address: 'Branch street', items: [{ product_id: productId, quantity_requested: 30 }] };
  assert.equal((await call('POST', '/supply-requests', { token: sales, body })).status, 403);
  assert.match((await call('POST', '/supply-requests', { token: branch.token, body: { ...body, items: [{ product_id: productId, quantity_requested: 1 }, { product_id: productId, quantity_requested: 2 }] } })).json.errors['items.1.product_id'][0], /already on the request/);
  assert.match((await call('POST', '/supply-requests', { token: branch.token, body: { ...body, urgency: 'urgent' } })).json.errors.urgency_reason[0], /reason for the urgency/);
  assert.match((await call('POST', '/supply-requests', { token: branch.token, body: { ...body, target_delivery_date: new Date().toISOString().slice(0, 10) } })).json.errors.target_delivery_date[0], /earliest delivery date/);
  const created = await call('POST', '/supply-requests', { token: branch.token, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const requestId = created.json.data.id;
  const path = `/supply-requests/${requestId}`;
  assert.match(created.json.data.request_number, /^FT-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(created.json.data.status, 'submitted');
  assert.ok(created.json.data.target_delivery_date, 'defaults to the earliest date');
  assert.deepEqual(created.json.data.owners, ['admin']);

  assert.equal((await call('GET', path, { token: logistics })).status, 404, 'Logistics sees it only after endorsement');
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'under_review' } })).status, 422, 'the old transition endpoint is retired');
  assert.equal((await call('POST', `${path}/start-review`, { token: branch.token })).status, 403);
  assert.equal((await call('POST', `${path}/start-review`, { token: admin })).json.data.status, 'under_review');
  assert.equal((await call('GET', path, { token: logistics })).status, 404, 'still in review');
  const detail = await call('GET', path, { token: admin });
  assert.equal(detail.json.data.can_endorse, true);
  assert.equal(detail.json.data.line_groups[0].lines[0].warehouse_stock, 120);

  const endorsed = await call('POST', `${path}/endorse`, { token: admin });
  assert.equal(endorsed.json.data.status, 'waiting_logistics', JSON.stringify(endorsed.json));
  assert.equal(await stockOf(), 120, 'endorsing reserves, it does not deduct');
  assert.equal(await reservedOf(requestId), 30);
  assert.deepEqual(endorsed.json.data.owners, ['logistics']);

  // Logistics asks for another date: scheduling waits for Admin; approving schedules it.
  assert.match((await call('POST', `${path}/date-change`, { token: logistics, body: { proposed_date: '2999-01-15' } })).json.errors.reason[0], /reason/);
  assert.equal((await call('POST', `${path}/date-change`, { token: logistics, body: { proposed_date: '2999-01-15', reason: 'Truck under repair' } })).status, 200);
  assert.match((await call('POST', `${path}/accept-schedule`, { token: logistics })).json.errors.status[0], /waiting for Admin/);
  assert.deepEqual((await call('GET', path, { token: admin })).json.data.owners, ['admin']);
  assert.match((await call('POST', `${path}/date-change/decide`, { token: admin, body: { approve: false } })).json.errors.reason[0], /reason/);
  const approved = await call('POST', `${path}/date-change/decide`, { token: admin, body: { approve: true } });
  assert.equal(approved.json.data.status, 'scheduled');
  assert.equal(approved.json.data.effective_delivery_date, '2999-01-15');

  assert.equal((await call('POST', `${path}/prepare`, { token: admin })).status, 403);
  assert.equal((await call('POST', `${path}/prepare`, { token: logistics })).json.data.status, 'preparing');
  const dispatch = (extra: object) => call('POST', `${path}/dispatch`, { token: logistics, body: { ...driver, departed_at: ago(30), eta_at: ago(-60), ...extra } });
  assert.match((await dispatch({ driver_contact: '0917123' })).json.errors.driver_contact[0], /11 digits/);
  assert.match((await dispatch({ driver_name: 'R2-D2' })).json.errors.driver_name[0], /driver name/);
  assert.match((await dispatch({ plate_number: '???' })).json.errors.plate_number[0], /plate/);
  assert.match((await dispatch({ departed_at: ago(-120) })).json.errors.departed_at[0], /future/);
  assert.match((await dispatch({ eta_at: ago(60) })).json.errors.eta_at[0], /on or after/);
  const itemId = detail.json.data.items[0].id;
  assert.match((await dispatch({ items: [{ item_id: itemId, prepared: 25 }] })).json.errors['items.0.prepared'][0], /must equal the endorsed/, 'never short a delivery silently');
  assert.equal(await stockOf(), 120);
  const sent = await dispatch({});
  assert.equal(sent.json.data.status, 'dispatched', JSON.stringify(sent.json));
  assert.equal(sent.json.data.delivery.plate_number, 'ABC 1234');
  assert.equal(await stockOf(), 90, 'deducted at dispatch');
  assert.equal(await reservedOf(requestId), 0, 'the reservation is consumed');
  const snapshot = (await call('GET', path, { token: admin })).json.data.stock_snapshot;
  assert.deepEqual([snapshot[0].stock_before, snapshot[0].deducted, snapshot[0].stock_after], [120, 30, 90]);
  assert.match((await call('POST', `${path}/cancel`, { token: admin, body: { reason: 'Changed plans' } })).json.errors.status[0], /before it is dispatched/);

  // The branch confirms before the POD: good + damaged + short must match, damage needs a photo.
  const receipt = (lines: object[], photo = false) => {
    const form = new FormData();
    form.set('lines', JSON.stringify(lines));
    if (photo) form.set(`photo_${itemId}`, new File([new Uint8Array([1, 2])], 'dent.png', { type: 'image/png' }));
    return call('POST', `${path}/receipt`, { token: branch.token, form });
  };
  assert.match((await receipt([{ item_id: itemId, good: 20, damaged: 0, short: 0 }])).json.errors['lines.0'][0], /must equal the 30/);
  assert.match((await receipt([{ item_id: itemId, good: 28, damaged: 2, short: 0, damage_reason: 'Dented bottles' }])).json.errors['lines.0.photo'][0], /photo/);
  assert.match((await receipt([{ item_id: itemId, good: 28, damaged: 2, short: 0 }], true)).json.errors['lines.0.damage_reason'][0], /damage reason/);
  const received = await receipt([{ item_id: itemId, good: 28, damaged: 2, short: 0, damage_reason: 'Dented bottles' }], true);
  assert.equal(received.status, 200, JSON.stringify(received.json));
  assert.equal(received.json.data.status, 'dispatched', 'waits for the POD');
  assert.ok((await call('GET', path, { token: admin })).json.data.documents.some((d: any) => d.type === 'receipt_damage_photo'));
  const [material] = await q(`select m.*, b.quantity_milli from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1`, [branch.locationId]);
  assert.equal(material.quantity_milli, 28000, 'only the good quantity is credited');
  assert.equal(material.warehouse_product_id, productId);
  assert.equal((await q(`select current_stock from inventories where location_id = $1 and product_id = $2`, [branch.locationId, productId]))[0].current_stock, '28.00', 'branch inventory mirrors the ledger');
  assert.equal((await receipt([{ item_id: itemId, good: 30, damaged: 0, short: 0 }])).status, 422, 'confirmed once');
  assert.equal((await call('POST', `${path}/acknowledge`, { token: branch.token, body: { recipient_name: 'x' } })).status, 422, 'acknowledge is the same Confirm Receipt: once only');

  const pod = new FormData();
  pod.set('file', new File(['pod'], 'pod.pdf', { type: 'application/pdf' }));
  pod.set('received_by', 'Branch Owner');
  pod.set('actual_delivered_at', ago(-120));
  assert.match((await call('POST', `${path}/pod`, { token: logistics, form: pod })).json.errors.actual_delivered_at[0], /future/);
  pod.set('actual_delivered_at', ago(5));
  const uploaded = await call('POST', `${path}/pod`, { token: logistics, form: pod });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  assert.equal(uploaded.json.data.document.type, 'proof_of_delivery');
  assert.equal(uploaded.json.data.status, 'discrepancy_review', 'damaged items need Admin');
  assert.ok(files.store.size >= 2);
  assert.equal((await call('GET', `${path}/documents/${uploaded.json.data.document.id}/download`, { token: branch.token })).status, 200);

  assert.match((await call('POST', `${path}/discrepancy/resolve`, { token: admin, body: { action: 'accept_loss' } })).json.errors.remarks[0], /Remarks/);
  const resolved = await call('POST', `${path}/discrepancy/resolve`, { token: admin, body: { action: 'accept_loss', remarks: 'Two bottles written off' } });
  assert.equal(resolved.json.data.status, 'completed_with_discrepancy');
  const history = (await call('GET', path, { token: admin })).json.data.status_history;
  assert.deepEqual(history.map((h: any) => h.action), ['submitted', 'review_started', 'endorsed_full', 'date_change_requested', 'date_change_approved', 'preparing_started', 'dispatched', 'receipt_confirmed', 'pod_encoded', 'discrepancy_opened', 'discrepancy_resolved']);
  assert.ok(history.every((h: any) => h.actor_role));
  await assert.rejects(q(`update supply_request_status_histories set remarks = 'x' where supply_request_id = $1`, [requestId]), /append-only/);

  const stats = await call('GET', '/supply-requests/stats', { token: admin });
  assert.equal(stats.json.data.by_status.completed_with_discrepancy, 1);
  assert.equal(stats.json.data.completed_this_month, 1);
  const pipeline = await call('GET', '/supply-requests/pipeline', { token: logistics });
  assert.ok(pipeline.json.data.stages.some((s: any) => s.key === 'waiting_logistics'));
  assert.equal(pipeline.json.data.rows[0].id, created.json.data.request_number);
  assert.equal((await call('GET', '/supply-requests', { token: branch.token })).json.data.length, 1);
});

const settingsOf = (data: any) => ({ lead_days: data.lead_days, bulk_percent: data.bulk_percent });
test('supply settings: defaults until Admin saves them, Admin only, within limits', async () => {
  const current = (await call('GET', '/supply-settings', { token: branch.token })).json.data;
  assert.deepEqual(settingsOf(current), { lead_days: 2, bulk_percent: 50 });
  const today = manilaDate();
  assert.equal(current.earliest_normal, earliestTargetDate(today, 2), 'the form shows the earliest date');
  assert.equal(current.earliest_urgent, earliestTargetDate(today, 2, true));
  assert.equal((await call('PUT', '/supply-settings', { token: logistics, body: { supply_lead_time_working_days: 3, bulk_threshold_percent: 40 } })).status, 403);
  assert.equal((await call('PUT', '/supply-settings', { token: admin, body: { supply_lead_time_working_days: 11, bulk_threshold_percent: 40 } })).status, 422);
  assert.equal((await call('PUT', '/supply-settings', { token: admin, body: { supply_lead_time_working_days: 3, bulk_threshold_percent: 40 } })).json.data.lead_days, 3);
  assert.equal((await call('PUT', '/supply-settings', { token: admin, body: { supply_lead_time_working_days: 2, bulk_threshold_percent: 50 } })).json.data.bulk_percent, 50);
  assert.equal((await q(`select count(*)::int as n from supply_settings`))[0].n, 1);
});

test('supply: short stock needs a Fulfillment Decision; backorders, hold, resume, shortage and cancel', async () => {
  const create = async (quantity: number) => {
    const res = await call('POST', '/supply-requests', { token: branch.token, body: { location_id: branch.locationId, delivery_address: 'x', items: [{ product_id: productId, quantity_requested: quantity }] } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    await call('POST', `/supply-requests/${res.json.data.id}/start-review`, { token: admin });
    return { id: res.json.data.id as number, number: res.json.data.request_number as string, path: `/supply-requests/${res.json.data.id}`, warnings: res.json.data.warnings, item: res.json.data.items[0].id as number };
  };
  assert.equal(await stockOf(), 90);
  const big = await create(200);
  assert.match((await call('GET', big.path, { token: admin })).json.data.endorse_block_reason, /Fulfillment Decision/);
  assert.match((await call('POST', `${big.path}/endorse`, { token: admin })).json.errors.items[0], /Fulfillment Decision/);
  assert.match((await call('POST', `${big.path}/reject`, { token: admin, body: {} })).json.errors.reason[0], /rejection reason/);
  const decide = (path: string, body: object) => call('POST', `${path}/fulfillment`, { token: admin, body: { reason: 'Supplier delivery next week', ...body } });
  assert.match((await decide(big.path, { type: 'partial_ship_now' })).json.errors['items.0.restock_date'][0], /restock date/);
  assert.match((await decide(big.path, { type: 'partial_ship_now', items: [{ item_id: big.item, available: 95, restock_date: later(7) }] })).json.errors['items.0.available'][0], /at most 90/);
  const split = await decide(big.path, { type: 'partial_ship_now', items: [{ item_id: big.item, restock_date: later(7) }] });
  assert.equal(split.json.data.status, 'waiting_logistics', JSON.stringify(split.json));
  assert.equal(Number(split.json.data.items[0].quantity_endorsed), 90);
  const child = split.json.data.result.child;
  assert.equal(child.request_number, `${big.number}-B`);
  assert.equal(child.status, 'on_hold');
  assert.equal(Number((await q(`select quantity_requested from supply_request_items where supply_request_id = $1`, [child.id]))[0].quantity_requested), 110);
  assert.equal(await reservedOf(big.id), 90);

  // Everything is reserved now: a new request must wait.
  const small = await create(10);
  assert.ok(small.warnings.some((w: string) => w.includes(big.number)), 'duplicate open request warning');
  assert.match((await call('POST', `${small.path}/endorse`, { token: admin })).json.errors.items[0], /short/);
  const held = await decide(small.path, { type: 'hold', items: [{ item_id: small.item, restock_date: later(5) }] });
  assert.equal(held.json.data.status, 'on_hold');
  assert.match((await call('POST', `${small.path}/resume`, { token: admin })).json.errors.items[0], /cannot cover/);
  assert.match((await call('POST', `${small.path}/restock-date`, { token: admin, body: { restock_date: later(9) } })).json.errors.reason[0], /reason/);
  const moved = await call('POST', `${small.path}/restock-date`, { token: admin, body: { restock_date: later(9), reason: 'Supplier delayed' } });
  assert.equal(moved.json.data.restock_revision_count, 1);
  assert.equal(moved.json.data.expected_restock_date, later(9));

  // Cancelling the big request releases its reservation; the held one can resume.
  assert.match((await call('POST', `${big.path}/cancel`, { token: branch.token, body: { reason: 'No longer needed' } })).json.errors.status[0], /branch can cancel only/);
  assert.equal((await call('POST', `${big.path}/cancel`, { token: admin, body: { reason: 'Branch changed plans' } })).json.data.status, 'cancelled');
  assert.equal(await reservedOf(big.id), 0);
  assert.equal((await call('POST', `${small.path}/resume`, { token: admin })).json.data.status, 'waiting_logistics');
  assert.equal(await reservedOf(small.id), 10);

  // Logistics counts only 4: a shortage report blocks preparing until Admin decides again.
  assert.equal((await call('POST', `${small.path}/accept-schedule`, { token: logistics })).json.data.status, 'scheduled');
  assert.match((await call('POST', `${small.path}/shortage`, { token: logistics, body: { reason: 'Broken seals', items: [{ item_id: small.item, actual_count: 10 }] } })).json.errors.items[0], /No item is short/);
  const reported = await call('POST', `${small.path}/shortage`, { token: logistics, body: { reason: 'Broken seals', items: [{ item_id: small.item, actual_count: 4 }] } });
  assert.equal(reported.status, 200, JSON.stringify(reported.json));
  assert.equal(await stockOf(), 90, 'a shortage report changes no inventory');
  assert.match((await call('POST', `${small.path}/prepare`, { token: logistics })).json.errors.status[0], /shortage report/);
  assert.match((await decide(small.path, { type: 'partial_ship_now', items: [{ item_id: small.item, available: 5, restock_date: later(5) }] })).json.errors['items.0.available'][0], /at most 4/, 'capped by the reported count');
  const after = await decide(small.path, { type: 'partial_ship_now', items: [{ item_id: small.item, restock_date: later(5) }] });
  assert.equal(after.json.data.status, 'waiting_logistics');
  assert.equal(after.json.data.result.child.request_number, `${small.number}-B`);
  assert.equal(await reservedOf(small.id), 4);
  await call('POST', `${small.path}/accept-schedule`, { token: logistics });
  await call('POST', `${small.path}/prepare`, { token: logistics });
  const whileOpen = await call('DELETE', '/inventories/items', { token: logistics, body: { inventory_ids: [inventoryId] } });
  assert.match(whileOpen.json.errors.inventory_ids[0], /still on an open supply request/, 'blocked while the request is open');
  const shipped = await call('POST', `${small.path}/dispatch`, { token: logistics, body: { ...driver, departed_at: ago(10), eta_at: ago(-30) } });
  assert.equal(shipped.json.data.status, 'dispatched', JSON.stringify(shipped.json));
  assert.equal(await stockOf(), 86, 'only the endorsed 4 leave the warehouse');

  // Close everything still open, then the product can be archived.
  await q(`update supply_requests set status = 'completed' where id = $1`, [small.id]);
  for (const id of [child.id, after.json.data.result.child.id]) {
    assert.equal((await call('POST', `/supply-requests/${id}/cancel`, { token: admin, body: { reason: 'Not needed anymore' } })).json.data.status, 'cancelled');
  }
  assert.equal((await call('POST', `/supply-requests/${child.id}/cancel`, { token: admin, body: { reason: 'Again please' } })).status, 422, 'already closed');
  assert.equal((await call('DELETE', '/inventories/items', { token: logistics, body: { inventory_ids: [inventoryId] } })).status, 200);
  assert.equal((await q(`select is_active from products where id = $1`, [productId]))[0].is_active, false);
});

test('brand products: activation needs ingredients, brand mismatch is refused, images are public', async () => {
  const [other] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'OTHER-1', 'Sugar', 'kg') returning id`, [brand.id]);
  assert.match((await call('POST', '/brand-products', { token: admin, body: { brand_id: brand.id, name: 'Latte', is_active: true } })).json.errors.is_active[0], /at least one ingredient/);
  const created = await call('POST', '/brand-products', { token: admin, body: { brand_id: brand.id, name: 'Latte', is_active: true, ingredients: [{ product_id: other.id, batch_amount: 1.5, yield_pieces: 10 }] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.data.sku, /-P\d{4}$/);
  assert.equal(created.json.data.ingredients[0].batch_amount, 1.5);
  assert.equal(created.json.data.ingredients[0].quantity_per_piece, 0.15);
  assert.equal((await call('POST', '/brand-products', { token: sales, body: {} })).status, 403);
  assert.match((await call('POST', '/brand-products', { token: admin, body: { brand_id: brand.id, name: ' LATTE ' } })).json.errors.name[0], /already has a product/);
  const [otherBrand] = await q(`select id from brands order by id desc limit 1`);
  assert.match((await call('POST', '/brand-products', { token: admin, body: { brand_id: otherBrand.id, name: 'Mocha', ingredients: [{ product_id: other.id, batch_amount: 1, yield_pieces: 1 }] } })).json.errors['ingredients.0.product_id'][0], /belongs to another brand/);

  const form = new FormData();
  form.set('image', new File([new Uint8Array([9])], 'pic.png', { type: 'image/png' }));
  const image = await call('POST', `/brand-products/${created.json.data.id}/image`, { token: admin, form });
  assert.match(image.json.data.image_url, /^http:\/\/files\.test\/public\/brand-products\//);
  assert.ok(files.store.has(`public/${image.json.data.image_path}`));
  assert.equal((await call('DELETE', `/brand-products/${created.json.data.id}/image`, { token: admin })).json.data.image_url, null);
  assert.equal(files.store.has(`public/${image.json.data.image_path}`), false);
  assert.equal((await call('GET', `/brand-products?brand_id=${brand.id}`, { token: sales })).json.data.length, 1);
});
