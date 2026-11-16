// Objective 3: the ten supply scenarios from the brief, end to end through the API, plus the
// list tabs, KPIs, filters and sorts. Each scenario uses its own products so stock never leaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, setup } from '../support/harness.ts';
import { addDays, manilaDate, weekday, earliestTargetDate } from '../../supabase/functions/api/services/workingDays.ts';
import { addDays as forecastAddDays, weekStart } from '../../supabase/functions/api/services/forecast.ts';

const { pg, call, login, auth, files } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id, name from brands order by id limit 1`);
const [warehouse] = await q(`select id from franchise_locations where type = 'warehouse' and is_active order by id limit 1`);

async function branchAccount(email: string, name: string, city: string) {
  const [roleRow] = await q(`select id from roles where name = 'franchisee'`);
  const uid = await auth.addUser(email, PASSWORD);
  const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, $2, $3, 'active', $4::uuid) returning id`, [roleRow.id, `${name} Owner`, email, uid]);
  const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ($1, 'active_franchisee', $2, $3, '2026-01-01') returning id`, [`${name} Owner`, user.id, brand.id]);
  const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, $3, 'active', '2026-01-01') returning id`, [applicant.id, user.id, name]);
  const [location] = await q(
    `insert into franchise_locations (franchisee_id, brand_id, name, branch_code, type, address, city, contact_number, is_active) values ($1, $2, $3, $4, 'franchise', $5, $6, '09170000000', true) returning id`,
    [franchisee.id, brand.id, name, `SC-${user.id}`, `${name} street`, city],
  );
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD, portal: 'branch' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { token: res.json.data.token as string, id: location.id as number, userId: user.id as number, name };
}
const A = await branchAccount('scenario.a@test.local', 'Alpha Branch', 'Cebu');
const B = await branchAccount('scenario.b@test.local', 'Bravo Branch', 'Davao');

let sku = 0;
async function product(name: string, unit: string, stock: number) {
  sku += 1;
  const [p] = await q(`insert into products (brand_id, sku, name, unit) values ($1, $2, $3, $4) returning id`, [brand.id, `SCN-${sku}`, name, unit]);
  const [inv] = await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, $3, 1, 0) returning id`, [warehouse.id, p.id, stock]);
  return { id: p.id as number, inventory: inv.id as number, name };
}
const stockOf = async (p: { inventory: number }) => Number((await q(`select current_stock from inventories where id = $1`, [p.inventory]))[0].current_stock);
const reservedOf = async (id: number) => Number((await q(`select coalesce(sum(quantity), 0) as q from supply_reservations where supply_request_id = $1 and status = 'active'`, [id]))[0].q);
const branchStock = async (branch: { id: number }, p: { id: number }) => Number((await q(`select coalesce(sum(b.quantity_milli), 0) as m from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1 and m.warehouse_product_id = $2`, [branch.id, p.id]))[0].m) / 1000;
const notified = async (type: string, requestId: number) => (await q(`select r.name as role from system_notifications n join users u on u.id = n.user_id join roles r on r.id = u.role_id where n.type = $1 and (n.data ->> 'supply_request_id')::bigint = $2`, [type, requestId])).map((r) => r.role);
const later = (days: number) => addDays(manilaDate(), days);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const post = (token: string, path: string, body: object = {}) => call('POST', path, { token, body });
async function act(token: string, id: number, action: string, body: object = {}, status = 200) {
  const res = await post(token, `/supply-requests/${id}/${action}`, body);
  assert.equal(res.status, status, `${action}: ${JSON.stringify(res.json)}`);
  return res.json;
}
async function create(branch: { token: string; id: number }, items: [{ id: number }, number][], extra: object = {}) {
  const res = await post(branch.token, '/supply-requests', { location_id: branch.id, delivery_address: 'Branch street', items: items.map(([p, n]) => ({ product_id: p.id, quantity_requested: n })), ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.data;
}
const detail = async (token: string, id: number) => (await call('GET', `/supply-requests/${id}`, { token })).json.data;
const DRIVER = { driver_name: 'Jose P. Rizal', driver_contact: '09181112222', plate_number: 'NAB 4521' };
const dispatch = (id: number, extra: object = {}) => act(logistics, id, 'dispatch', { ...DRIVER, departed_at: minutesAgo(60), eta_at: minutesAgo(-60), ...extra });
async function pod(id: number, actual = minutesAgo(5), status = 201) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array([137, 80, 78, 71])], 'pod.png', { type: 'image/png' }));
  form.set('received_by', 'Branch crew');
  form.set('actual_delivered_at', actual);
  const res = await call('POST', `/supply-requests/${id}/pod`, { token: logistics, form });
  assert.equal(res.status, status, JSON.stringify(res.json));
  return res.json;
}
async function receipt(branch: { token: string }, id: number, lines: object[], photos: number[] = [], status = 200) {
  const form = new FormData();
  form.set('lines', JSON.stringify(lines));
  for (const itemId of photos) form.set(`photo_${itemId}`, new File([new Uint8Array([255, 216, 255])], 'damage.jpg', { type: 'image/jpeg' }));
  const res = await call('POST', `/supply-requests/${id}/receipt`, { token: branch.token, form });
  assert.equal(res.status, status, JSON.stringify(res.json));
  return res.json;
}
const allGood = (sr: any) => sr.items.map((i: any) => ({ item_id: i.id, good: Number(i.quantity_prepared), damaged: 0, short: 0 }));
/** Endorsed or resumed request → scheduled → preparing → dispatched → POD → all good → completed. */
async function shipAndReceive(branch: { token: string }, id: number) {
  await act(logistics, id, 'accept-schedule');
  await act(logistics, id, 'prepare');
  const sent = await dispatch(id);
  await pod(id);
  const done = await receipt(branch, id, allGood(sent.data));
  assert.equal(done.data.status, 'completed');
  return done.data;
}
const addStock = async (p: { inventory: number }, quantity: number) => {
  const res = await post(logistics, `/inventories/${p.inventory}/quantity`, { direction: 'increase', quantity, note: 'Supplier restock' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
};

test('1. normal request, full stock, end to end', async () => {
  const beans = await product('Coffee beans', 'kg', 50);
  const sr = await create(A, [[beans, 10]]);
  assert.equal(sr.status, 'submitted');
  assert.equal(sr.target_delivery_date, earliestTargetDate(manilaDate(), 2), 'defaults to the earliest date');
  assert.deepEqual(await notified('supply_request_submitted', sr.id), ['admin']);
  await act(admin, sr.id, 'start-review');
  const review = (await detail(admin, sr.id)).review_lines[0];
  assert.deepEqual([review.requested, review.available, review.unavailable, review.branch_stock_status, review.days_covered, review.suggested, review.critical], [10, 10, 0, 'none', null, null, false]);
  assert.equal((await act(admin, sr.id, 'endorse')).data.status, 'waiting_logistics');
  assert.equal(await reservedOf(sr.id), 10);
  assert.ok((await notified('supply_request_endorsed', sr.id)).includes('logistics'));
  assert.equal((await act(logistics, sr.id, 'accept-schedule')).data.status, 'scheduled');
  assert.ok((await notified('supply_request_scheduled', sr.id)).includes('franchisee'));
  await act(logistics, sr.id, 'prepare');
  assert.equal(await stockOf(beans), 50, 'nothing leaves before dispatch');
  const sent = await dispatch(sr.id);
  assert.equal(sent.data.status, 'dispatched');
  assert.equal(await stockOf(beans), 40);
  assert.ok((await notified('supply_request_dispatched', sr.id)).includes('franchisee'));
  const slip = (await call('GET', `/supply-requests/${sr.id}/delivery-receipt`, { token: logistics })).json.data;
  assert.deepEqual([slip.request_number, slip.branch, slip.city, slip.driver_name, slip.plate_number], [sr.request_number, 'Alpha Branch', 'Cebu', 'Jose P. Rizal', 'NAB 4521']);
  assert.deepEqual(slip.items, [{ name: 'Coffee beans', unit: 'kg', quantity: 10 }]);
  assert.deepEqual(slip.signatures, ['Released by', 'Received by']);
  const seen = await detail(A.token, sr.id);
  assert.deepEqual([seen.delivery.driver_name, seen.delivery.plate_number, Boolean(seen.delivery.eta_at)], ['Jose P. Rizal', 'NAB 4521', true], 'the branch sees driver, plate and ETA');
  assert.equal(seen.review_lines, undefined, 'review data is for staff');
  const delivered = await pod(sr.id);
  assert.equal(delivered.data.status, 'delivered');
  assert.deepEqual(delivered.data.owners, ['branch']);
  const done = await receipt(A, sr.id, allGood(sent.data));
  assert.equal(done.data.status, 'completed');
  assert.equal(await branchStock(A, beans), 10);
});

test('2. short stock, not urgent: Hold for Restock, Resume blocked until the restock', async () => {
  const cups = await product('Paper cups', 'pcs', 5);
  const sr = await create(A, [[cups, 20]]);
  await act(admin, sr.id, 'start-review');
  assert.match((await act(admin, sr.id, 'endorse', {}, 422)).errors.items[0], /Fulfillment Decision/);
  const preview = (await act(admin, sr.id, 'fulfillment/preview', { type: 'hold' })).data;
  assert.equal(preview.backorder, null);
  assert.deepEqual([preview.items[0].max_available, preview.items[0].unavailable], [5, 15]);
  const held = await act(admin, sr.id, 'fulfillment', { type: 'hold', reason: 'Cups arrive next week', items: [{ item_id: preview.items[0].item_id, restock_date: later(5) }] });
  assert.equal(held.data.status, 'on_hold');
  assert.equal(await reservedOf(sr.id), 0, 'Hold reserves nothing');
  assert.ok((await notified('supply_request_on_hold', sr.id)).includes('franchisee'));
  assert.match((await act(admin, sr.id, 'resume', {}, 422)).errors.items[0], /cannot cover/);
  await addStock(cups, 30);
  assert.equal((await act(admin, sr.id, 'resume')).data.status, 'waiting_logistics');
  assert.equal(await reservedOf(sr.id), 20);
  await shipAndReceive(A, sr.id);
  assert.equal(await stockOf(cups), 15);
  assert.equal(await branchStock(A, cups), 20);
});

test('3. short and Critical: Partial – Ship Now creates the -B backorder; both complete separately', async () => {
  const milk = await product('Fresh milk', 'l', 4);
  const urgentDay = earliestTargetDate(manilaDate(), 2, true);
  assert.match((await post(A.token, '/supply-requests', { location_id: A.id, delivery_address: 'x', urgency: 'critical', target_delivery_date: urgentDay, items: [{ product_id: milk.id, quantity_requested: 10 }] })).json.errors.urgency_reason[0], /reason/);
  const sr = await create(A, [[milk, 10]], { urgency: 'critical', urgency_reason: 'Out of milk since morning', target_delivery_date: urgentDay });
  await act(admin, sr.id, 'start-review');
  const item = sr.items[0].id;
  const preview = (await act(admin, sr.id, 'fulfillment/preview', { type: 'partial_ship_now' })).data;
  assert.equal(preview.message, `${sr.request_number}-B will be created for Fresh milk 6 l`);
  const split = await act(admin, sr.id, 'fulfillment', { type: 'partial_ship_now', reason: 'Ship what we have today', items: [{ item_id: item, restock_date: later(3) }] });
  const child = split.data.result.child;
  assert.equal(child.request_number, `${sr.request_number}-B`);
  assert.equal(child.status, 'on_hold');
  assert.equal(child.urgency, 'critical');
  assert.equal(Number(split.data.items[0].quantity_endorsed), 4);
  assert.deepEqual((await detail(admin, sr.id)).backorders.map((b: any) => b.request_number), [child.request_number]);
  assert.equal((await detail(admin, child.id)).parent.request_number, sr.request_number);

  await shipAndReceive(A, sr.id);
  assert.equal(await branchStock(A, milk), 4);
  assert.equal((await detail(admin, child.id)).status, 'on_hold', 'the backorder waits on its own');
  await addStock(milk, 6);
  await act(admin, child.id, 'resume');
  await shipAndReceive(A, child.id);
  assert.equal(await branchStock(A, milk), 10);
  assert.equal(await stockOf(milk), 0);
});

test('4. Partial – Consolidated reserves stock another request cannot take, then ships together', async () => {
  const syrup = await product('Caramel syrup', 'bottle', 6);
  const sr = await create(A, [[syrup, 10]]);
  await act(admin, sr.id, 'start-review');
  const preview = (await act(admin, sr.id, 'fulfillment/preview', { type: 'partial_consolidated' })).data;
  assert.match(preview.message, /Caramel syrup 6 bottle will be reserved/);
  const held = await act(admin, sr.id, 'fulfillment', { type: 'partial_consolidated', reason: 'Same trip once the rest arrives', items: [{ item_id: sr.items[0].id, restock_date: later(4) }] });
  assert.equal(held.data.status, 'on_hold');
  assert.equal(await reservedOf(sr.id), 6);

  const other = await create(B, [[syrup, 3]]);
  await act(admin, other.id, 'start-review');
  assert.match((await act(admin, other.id, 'endorse', {}, 422)).errors.items[0], /short/, 'the reserved 6 are not free');
  assert.equal((await detail(admin, other.id)).review_lines[0].available, 0);

  await addStock(syrup, 4);
  await act(admin, sr.id, 'resume');
  assert.equal(await reservedOf(sr.id), 10, 'everything together');
  const done = await shipAndReceive(A, sr.id);
  assert.equal(Number(done.items[0].quantity_prepared), 10);
  assert.equal(await branchStock(A, syrup), 10);
  await act(admin, other.id, 'reject', { reason: 'Re-request after the next delivery' });
});

test('5. bulk: over 50% needs a reason; Admin returns it; the branch edits and resubmits', async () => {
  // A ready estimate for Alpha: nine complete weeks of 10 kg used, nothing on hand.
  const sugar = await product('Brown sugar', 'kg', 500);
  const created = await call('POST', '/profittrack/materials', { token: A.token, body: { name: 'Brown sugar', unit: 'kg' } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await q(`update profittrack_materials set warehouse_product_id = $1 where id = $2`, [sugar.id, created.json.data.id]);
  const thisWeek = weekStart(manilaDate());
  for (let ago = 10; ago >= 1; ago--) {
    if (ago === 6) continue;
    await q(
      `insert into profittrack_material_movements (location_id, material_id, type, quantity_delta_milli, reason, recorded_by_user_id, occurred_at) values ($1, $2, 'physical_count', -10000, 'Used', $3, ($4::date + 2)::timestamp at time zone 'Asia/Manila')`,
      [A.id, created.json.data.id, A.userId, forecastAddDays(thisWeek, -7 * ago)],
    );
  }
  const check = await post(A.token, '/supply-requests/check', { location_id: A.id, items: [{ product_id: sugar.id, quantity_requested: 1 }] });
  const suggested = check.json.data.items[0].suggested_quantity;
  assert.ok(suggested > 0, `a suggestion exists (${JSON.stringify(check.json)})`);
  const bulk = Math.ceil(suggested * 1.5) + 5;
  const body = { location_id: A.id, delivery_address: 'x', items: [{ product_id: sugar.id, quantity_requested: bulk }] };
  // The form's live check says what is needed instead of refusing.
  const live = await post(A.token, '/supply-requests/check', { ...body, urgency: 'urgent' });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  assert.equal(live.json.data.bulk_required, true);
  assert.match(live.json.data.issues.bulk_reason, /suggested/);
  assert.match(live.json.data.issues.urgency_reason, /reason/);
  assert.ok(typeof live.json.data.items[0].days_covered === 'number', 'days covered per line');
  const refused = await post(A.token, '/supply-requests', body);
  assert.equal(refused.status, 422);
  assert.match(refused.json.errors.bulk_reason[0], /suggested/);
  const sr = await create(A, [[sugar, bulk]], { bulk_reason: 'Two weeks of stock before the town fiesta' });
  assert.equal(sr.items[0].over_bulk, true);
  assert.equal(Number(sr.items[0].suggested_quantity), suggested);

  await act(admin, sr.id, 'start-review');
  assert.match((await act(admin, sr.id, 'return', {}, 422)).errors.reason[0], /reason/);
  const returned = await act(admin, sr.id, 'return', { reason: 'Please order one week only' });
  assert.equal(returned.data.status, 'returned');
  assert.deepEqual(returned.data.owners, ['branch']);
  assert.ok((await notified('supply_request_returned', sr.id)).includes('franchisee'));
  const edited = await call('PUT', `/supply-requests/${sr.id}`, { token: A.token, body: { items: [{ product_id: sugar.id, quantity_requested: suggested }], bulk_reason: null } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  const again = await act(A.token, sr.id, 'submit');
  assert.equal(again.data.status, 'submitted');
  assert.equal(again.data.request_number, sr.request_number, 'same number');
  assert.equal(again.data.items[0].over_bulk, false);
  const actions = (await detail(admin, sr.id)).status_history.map((h: any) => h.action);
  assert.deepEqual(actions, ['submitted', 'review_started', 'returned', 'edited', 'resubmitted']);
  assert.deepEqual(await notified('supply_request_submitted', sr.id), ['admin', 'admin']);
});

test('6. Logistics asks for a new date: Admin approves, and in another case rejects with a reason', async () => {
  const flour = await product('Bread flour', 'kg', 40);
  const one = await create(A, [[flour, 5]]);
  await act(admin, one.id, 'start-review');
  await act(admin, one.id, 'endorse');
  const newDate = later(9);
  await act(logistics, one.id, 'date-change', { proposed_date: newDate, reason: 'Truck in maintenance' });
  assert.deepEqual(await notified('supply_request_date_requested', one.id), ['admin']);
  assert.match((await act(logistics, one.id, 'accept-schedule', {}, 422)).errors.status[0], /waiting for Admin/);
  const approved = await act(admin, one.id, 'date-change/decide', { approve: true });
  assert.equal(approved.data.status, 'scheduled');
  assert.equal(approved.data.confirmed_delivery_date, newDate);
  assert.deepEqual((await notified('supply_request_date_decided', one.id)).sort(), ['franchisee', 'logistics']);

  const two = await create(A, [[flour, 5]]);
  await act(admin, two.id, 'start-review');
  await act(admin, two.id, 'endorse');
  await act(logistics, two.id, 'date-change', { proposed_date: later(12), reason: 'Driver on leave' });
  assert.match((await act(admin, two.id, 'date-change/decide', { approve: false }, 422)).errors.reason[0], /reason/);
  const rejected = await act(admin, two.id, 'date-change/decide', { approve: false, reason: 'The branch needs it on the original date' });
  assert.equal(rejected.data.status, 'waiting_logistics');
  assert.equal(rejected.data.effective_delivery_date, two.target_delivery_date);
  const scheduled = await act(logistics, two.id, 'accept-schedule');
  assert.equal(scheduled.data.confirmed_delivery_date, two.target_delivery_date);
  const revisions = (await detail(admin, two.id)).date_revisions;
  assert.deepEqual([revisions[0].status, revisions[0].decision_reason], ['rejected', 'The branch needs it on the original date']);
});

test('7. Logistics reports a shortage per item, back to Admin for a new decision', async () => {
  const tea = await product('Black tea', 'box', 10);
  const lids = await product('Cup lids', 'pcs', 50);
  const sr = await create(A, [[tea, 10], [lids, 20]]);
  await act(admin, sr.id, 'start-review');
  await act(admin, sr.id, 'endorse');
  await act(logistics, sr.id, 'accept-schedule');
  await act(logistics, sr.id, 'prepare');
  const [teaItem, lidItem] = sr.items.map((i: any) => i.id);
  assert.match((await act(logistics, sr.id, 'shortage', { reason: 'Wet boxes', items: [{ item_id: teaItem, actual_count: 7 }] }, 422)).errors['items.1.actual_count'][0], /actual count/, 'every item is counted');
  await act(logistics, sr.id, 'shortage', { reason: 'Three boxes were wet', items: [{ item_id: teaItem, actual_count: 7 }, { item_id: lidItem, actual_count: 20 }] });
  assert.deepEqual(await notified('supply_request_shortage', sr.id), ['admin']);
  assert.equal(await stockOf(tea), 10, 'no silent inventory change');
  const pending = await detail(admin, sr.id);
  assert.deepEqual(pending.owners, ['admin']);
  assert.equal(pending.pending_shortage_report.items[0].actual_count, 7);
  assert.match((await act(logistics, sr.id, 'dispatch', { ...DRIVER, departed_at: minutesAgo(5), eta_at: minutesAgo(-5) }, 422)).errors.status[0], /shortage report/, 'dispatch waits for Admin');
  const preview = (await act(admin, sr.id, 'fulfillment/preview', { type: 'partial_ship_now' })).data;
  assert.deepEqual(preview.items.map((i: any) => i.max_available), [7, 20]);
  assert.equal(preview.message, `${sr.request_number}-B will be created for Black tea 3 box`);
  const decided = await act(admin, sr.id, 'fulfillment', { type: 'partial_ship_now', reason: 'Ship the dry boxes now', items: [{ item_id: teaItem, restock_date: later(6) }] });
  assert.equal(decided.data.status, 'waiting_logistics');
  assert.equal((await q(`select status from supply_shortage_reports where supply_request_id = $1`, [sr.id]))[0].status, 'decided');
  await act(logistics, sr.id, 'accept-schedule');
  await act(logistics, sr.id, 'prepare');
  const sent = await dispatch(sr.id);
  assert.deepEqual(sent.data.items.map((i: any) => Number(i.quantity_prepared)), [7, 20]);
  assert.equal(await stockOf(tea), 3);
});

test('8. dispatched Thursday, ETA Sunday: the branch confirms Sunday, the POD is encoded Monday with Sunday\'s time', async () => {
  // The most recent Thursday at least a week back, so every time is in the past.
  let thursday = addDays(manilaDate(), -7);
  while (weekday(thursday) !== 4) thursday = addDays(thursday, -1);
  const sunday = addDays(thursday, 3);
  const at = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`).toISOString();
  const rice = await product('Jasmine rice', 'kg', 30);
  const sr = await create(A, [[rice, 12]]);
  await act(admin, sr.id, 'start-review');
  await act(admin, sr.id, 'endorse');
  await act(logistics, sr.id, 'accept-schedule');
  await act(logistics, sr.id, 'prepare');
  const sent = await dispatch(sr.id, { departed_at: at(thursday, 15), eta_at: at(sunday, 10) });
  assert.deepEqual(sent.data.warnings, ['The ETA is on a weekend. Make sure the branch can receive.']);
  assert.match((await detail(admin, sr.id)).overdue_reason, /POD/, 'past the ETA with no POD after one working day');

  const received = await receipt(A, sr.id, allGood(sent.data));
  assert.equal(received.data.status, 'dispatched', 'received before the POD');
  assert.equal(await branchStock(A, rice), 12, 'credited at once');
  assert.match((await pod(sr.id, at(thursday, 14), 422)).errors.actual_delivered_at[0], /on or after the departure/);
  const done = await pod(sr.id, at(sunday, 11));
  assert.equal(done.data.status, 'completed');
  assert.equal(new Date(done.data.delivery.actual_delivered_at).toISOString(), at(sunday, 11));
  assert.ok(new Date(done.data.delivery.pod_encoded_at) > new Date(done.data.delivery.actual_delivered_at), 'encoded on a later day');
});

test('9. damaged items: only the good quantity is credited, then discrepancy review', async () => {
  const eggs = await product('Eggs (tray)', 'tray', 20);
  const sr = await create(A, [[eggs, 10]]);
  await act(admin, sr.id, 'start-review');
  await act(admin, sr.id, 'endorse');
  await act(logistics, sr.id, 'accept-schedule');
  await act(logistics, sr.id, 'prepare');
  await dispatch(sr.id);
  await pod(sr.id);
  const item = sr.items[0].id;
  const line = { item_id: item, good: 7, damaged: 2, short: 1, damage_reason: 'Cracked in transit', short_reason: 'One tray missing' };
  assert.match((await receipt(A, sr.id, [line], [], 422)).errors['lines.0.photo'][0], /photo/);
  assert.match((await receipt(A, sr.id, [{ ...line, short_reason: '' }], [item], 422)).errors['lines.0.short_reason'][0], /reason/);
  const review = await receipt(A, sr.id, [line], [item]);
  assert.equal(review.data.status, 'discrepancy_review');
  assert.equal(await branchStock(A, eggs), 7, 'only the good 7');
  assert.equal(await stockOf(eggs), 10, 'damaged items are not returned to the warehouse');
  assert.deepEqual((await notified('supply_request_discrepancy', sr.id)).sort(), ['admin', 'logistics']);
  const seen = await detail(admin, sr.id);
  assert.deepEqual([seen.items[0].received_good, seen.items[0].received_damaged, seen.items[0].received_short].map(Number), [7, 2, 1]);
  assert.equal(seen.items[0].damage_reason, 'Cracked in transit');
  const photo = seen.documents.find((d: any) => d.type === 'receipt_damage_photo');
  assert.equal(photo.metadata.item_id, item);
  assert.equal((await call('GET', `/supply-requests/${sr.id}/documents/${photo.id}/download`, { token: admin })).status, 200);
  assert.ok(files.store.size > 0);
  const resolved = await act(admin, sr.id, 'discrepancy/resolve', { action: 'logistics_investigation', remarks: 'Check the packing of egg trays' });
  assert.equal(resolved.data.status, 'completed_with_discrepancy');
  assert.equal(resolved.data.discrepancy_action, 'logistics_investigation');
  assert.deepEqual((await notified('supply_request_discrepancy_resolved', sr.id)).sort(), ['franchisee', 'logistics']);
});

test('10. permissions and required reasons', async () => {
  const salt = await product('Sea salt', 'kg', 100);
  const sr = await create(A, [[salt, 2]]);
  const path = `/supply-requests/${sr.id}`;
  assert.equal((await call('GET', path, { token: B.token })).status, 403, 'another branch cannot see it');
  assert.equal((await post(B.token, `${path}/cancel`, { reason: 'Not mine to cancel' })).status, 403);
  assert.equal((await call('PUT', path, { token: B.token, body: { remarks: 'x' } })).status, 403);
  assert.equal((await post(B.token, '/supply-requests', { location_id: A.id, delivery_address: 'x', items: [{ product_id: salt.id, quantity_requested: 1 }] })).status, 403, 'nor request for it');
  assert.equal((await call('GET', path, { token: logistics })).status, 404, 'Logistics sees it only after endorsement');
  assert.equal((await post(A.token, `${path}/start-review`)).status, 403);

  await act(admin, sr.id, 'start-review');
  assert.match((await call('PUT', path, { token: A.token, body: { remarks: 'Late change' } })).json.errors.status[0], /can be edited/, 'no edits once review starts');
  assert.match((await act(A.token, sr.id, 'cancel', { reason: 'Changed my mind' }, 422)).errors.status[0], /branch can cancel only/);
  assert.equal((await post(logistics, `${path}/endorse`)).status, 403, 'Logistics cannot endorse');
  for (const [action, field] of [['reject', 'reason'], ['return', 'reason'], ['cancel', 'reason']] as const) {
    assert.match((await act(admin, sr.id, action, { reason: '  ' }, 422)).errors[field][0], /required/, `${action} needs a reason`);
  }
  assert.match((await act(admin, sr.id, 'fulfillment', { type: 'hold' }, 422)).errors.reason[0], /required/);
  await act(admin, sr.id, 'endorse');
  assert.match((await act(logistics, sr.id, 'date-change', { proposed_date: later(9) }, 422)).errors.reason[0], /required/);
  assert.match((await act(logistics, sr.id, 'shortage', { items: [] }, 422)).errors.reason[0], /required/);
  assert.equal((await post(A.token, `${path}/accept-schedule`)).status, 403);
  assert.equal((await post(admin, `${path}/dispatch`, DRIVER)).status, 403, 'only Logistics dispatches');
  await act(logistics, sr.id, 'accept-schedule');
  await act(logistics, sr.id, 'prepare');
  await dispatch(sr.id);
  assert.match((await act(admin, sr.id, 'cancel', { reason: 'Too late now' }, 422)).errors.status[0], /before it is dispatched/, 'no cancel after dispatch');
  assert.equal((await post(logistics, `${path}/receipt`, { lines: [] })).status, 403, 'only the branch confirms receipt');
  assert.equal((await post(B.token, `${path}/receipt`, { lines: [] })).status, 403);
  await pod(sr.id);
  const done = await receipt(A, sr.id, [{ item_id: sr.items[0].id, good: 1, damaged: 0, short: 1, short_reason: 'One bag missing' }]);
  assert.equal(done.data.status, 'discrepancy_review');
  assert.match((await act(admin, sr.id, 'discrepancy/resolve', { action: 'accept_loss' }, 422)).errors.remarks[0], /required/);
  assert.equal((await post(logistics, `${path}/discrepancy/resolve`, { action: 'accept_loss', remarks: 'Not my call' })).status, 403);

  const held = await create(A, [[salt, 500]]);
  await act(admin, held.id, 'start-review');
  await act(admin, held.id, 'fulfillment', { type: 'hold', reason: 'Salt restock pending', items: [{ item_id: held.items[0].id, restock_date: later(5) }] });
  assert.match((await act(admin, held.id, 'restock-date', { restock_date: later(8) }, 422)).errors.reason[0], /required/);
  assert.match((await act(admin, held.id, 'restock-date', { reason: 'Supplier moved it' }, 422)).errors.restock_date[0], /restock date/);
  const history = (await detail(admin, sr.id)).status_history;
  assert.ok(history.every((h: any) => h.actor_role && h.action && h.at));
});

test('list: tabs, KPIs, filters and sorts follow the role', async () => {
  const list = async (token: string, query = '') => (await call('GET', `/supply-requests?per_page=100${query}`, { token })).json;
  // One request Admin has left untouched for a week: overdue.
  const late = await create(B, [[await product('Napkins', 'pack', 10), 2]]);
  await q(`update supply_requests set status_changed_at = now() - interval '7 days' where id = $1`, [late.id]);
  const all = await list(admin);
  assert.equal(all.data[0].id, late.id, 'priority: the overdue request comes first');
  assert.match(all.data[0].overdue_reason, /Admin/);
  const meta = all.meta;
  assert.equal(meta.tabs.all, all.data.length);
  assert.equal(meta.tabs.completed, all.data.filter((r: any) => ['completed', 'completed_with_discrepancy'].includes(r.status)).length);
  assert.equal(meta.tabs.discrepancy, 1, 'the salt request waits for Admin');
  assert.equal(meta.kpis.discrepancies, 1);
  assert.equal(meta.tabs.on_hold, meta.kpis.on_hold);
  assert.ok(meta.tabs.on_hold >= 1);
  assert.deepEqual(await (await call('GET', '/supply-requests/counts', { token: admin })).json.data, { tabs: meta.tabs, kpis: meta.kpis });

  const mine = await list(admin, '&tab=needs_action');
  assert.equal(mine.data.length, meta.tabs.needs_action);
  assert.ok(mine.data.every((r: any) => r.needs_my_action && r.owners.includes('admin')));
  const logisticsList = await list(logistics, '&tab=needs_action');
  assert.ok(logisticsList.data.every((r: any) => r.owners.includes('logistics')));
  assert.ok((await list(logistics)).data.every((r: any) => !['submitted', 'under_review', 'returned', 'draft'].includes(r.status)), 'Logistics never sees requests in review');

  const overdue = await list(admin, '&overdue=1');
  assert.ok(overdue.data.length >= 1 && overdue.data.every((r: any) => r.overdue));
  const closed = await list(admin, '&tab=closed');
  assert.ok(closed.data.every((r: any) => ['rejected', 'cancelled'].includes(r.status)) && closed.data.length >= 1);

  assert.ok((await list(admin, '&search=Davao')).data.every((r: any) => r.location.city === 'Davao'));
  assert.ok((await list(admin, '&search=bravo')).data.length >= 1);
  const number = all.data[0].request_number;
  assert.ok((await list(admin, `&search=${number}`)).data.some((r: any) => r.request_number === number));
  assert.ok((await list(admin, '&urgency=critical')).data.every((r: any) => r.urgency === 'critical'));
  assert.equal((await list(admin, `&brand_id=${brand.id}`)).data.length, all.data.length);
  assert.equal((await list(admin, '&brand_id=999999')).data.length, 0);
  const today = manilaDate();
  assert.equal((await list(admin, `&from=${today}&to=${today}`)).data.length, all.data.length, 'all created today');
  assert.equal((await list(admin, `&from=${addDays(today, 1)}`)).data.length, 0);

  const priority = all.data;
  const firstNotOverdue = priority.findIndex((r: any) => !r.overdue);
  assert.ok(priority.slice(0, firstNotOverdue === -1 ? priority.length : firstNotOverdue).every((r: any) => r.overdue), 'overdue first');
  const rank: Record<string, number> = { critical: 0, urgent: 1, normal: 2 };
  const rest = priority.filter((r: any) => !r.overdue).map((r: any) => rank[r.urgency]);
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b), 'then Critical, Urgent, Normal');
  const byBranch = (await list(admin, '&sort=branch')).data.map((r: any) => r.location.name);
  assert.deepEqual(byBranch, [...byBranch].sort((a, b) => a.localeCompare(b)));
  const newest = (await list(admin, '&sort=newest')).data.map((r: any) => r.id);
  assert.deepEqual(newest, [...newest].sort((a, b) => b - a));
  const oldest = (await list(admin, '&sort=oldest')).data.map((r: any) => r.id);
  assert.deepEqual(oldest, [...oldest].sort((a, b) => a - b));
  const targets = (await list(admin, '&sort=target')).data.map((r: any) => r.effective_delivery_date ?? '9999');
  assert.deepEqual(targets, [...targets].sort());
  assert.equal((await call('GET', '/supply-requests?sort=nope', { token: admin })).status, 422);
  assert.equal((await call('GET', '/supply-requests?tab=nope', { token: admin })).status, 422);

  const paged = await call('GET', '/supply-requests?per_page=2&page=2&sort=oldest', { token: admin });
  assert.equal(paged.json.data.length, 2);
  assert.equal(paged.json.data[0].id, oldest[2]);
  assert.equal(paged.json.meta.current_page, 2);

  const branchList = await list(A.token);
  assert.ok(branchList.data.every((r: any) => r.location_id === A.id), 'a branch sees only its own');
  assert.ok(branchList.meta.tabs.needs_action >= 0);
});
