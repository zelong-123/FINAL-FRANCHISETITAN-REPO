// The live mix before the new supply workflow (completed 20, submitted 3, under_review 2,
// endorsed 3, preparing 2, dispatched 1; no delivered, draft, rejected or cancelled), rebuilt with
// the old flow's stock effects, then the migration is applied. Old flow: stock was deducted at
// Preparing (stock_deducted_at) and the branch was credited in full at Delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrationFiles } from '../support/testDb.ts';
import { LOGISTICS, PASSWORD, setup } from '../support/harness.ts';

const { pg, call, login, auth } = await setup();
const logistics = await login(LOGISTICS);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const MIGRATION = migrationFiles().find((f) => f.endsWith('20261111000001_supply_workflow.sql'))!;
const [brand] = await q(`select id from brands order by id limit 1`);
const [warehouse] = await q(`select id from franchise_locations where type = 'warehouse' and is_active order by id limit 1`);

const [role] = await q(`select id from roles where name = 'franchisee'`);
const email = 'migration.branch@test.local';
const uid = await auth.addUser(email, PASSWORD);
const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, 'Migration Owner', $2, 'active', $3::uuid) returning id`, [role.id, email, uid]);
const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ('Migration Owner', 'active_franchisee', $1, $2, '2026-01-01') returning id`, [user.id, brand.id]);
const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Migration Co', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, type, address, is_active) values ($1, $2, 'Migration Branch', 'franchise', 'Addr', true) returning id`, [franchisee.id, brand.id]);
const branchLogin = await call('POST', '/auth/login', { body: { email, password: PASSWORD, portal: 'branch' } });
const branchToken = branchLogin.json.data.token as string;

const [beans] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'MIG-BEANS', 'Beans', 'kg') returning id`, [brand.id]);
const [cups] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'MIG-CUPS', 'Cups', 'pcs') returning id`, [brand.id]);
// Beans after the old flow: 200 received, minus 20 completed (1 each), 2 Preparing (10 + 15) and 1 Dispatched (5).
const [beansStock] = await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, 150, 5, 1) returning id`, [warehouse.id, beans.id]);
const [cupsStock] = await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, 5, 1, 0) returning id`, [warehouse.id, cups.id]);
const stock = async (id: number) => Number((await q(`select current_stock from inventories where id = $1`, [id]))[0].current_stock);

// The old statuses are not allowed by the new check: lift it to rebuild the old rows.
await q(`alter table supply_requests drop constraint supply_requests_status_check`);
let n = 0;
async function legacy(status: string, lines: [number, number][], extra: Record<string, unknown> = {}) {
  n += 1;
  const keys = Object.keys(extra);
  const [sr] = await q(
    `insert into supply_requests (request_number, location_id, requested_by_user_id, status, delivery_address, target_delivery_date, created_at, submitted_at, status_changed_at ${keys.map((k) => `, ${k}`).join('')})
     values ($1, $2, $3, $4, 'Addr', '2026-11-20', now() - interval '3 days', null, null ${keys.map((_, i) => `, $${i + 5}`).join('')}) returning id`,
    [`FT-20261101-OLD${String(n).padStart(3, '0')}`, location.id, user.id, status, ...Object.values(extra)],
  );
  for (const [product, quantity] of lines) await q(`insert into supply_request_items (supply_request_id, product_id, quantity_requested) values ($1, $2, $3)`, [sr.id, product, quantity]);
  return sr.id as number;
}
const completed: number[] = [];
for (let i = 0; i < 20; i++) {
  const id = await legacy('completed', [[beans.id, 1]], { stock_deducted_at: new Date(), branch_received_at: new Date(), completed_at: new Date() });
  await q(`insert into deliveries (supply_request_id, delivery_date, dispatched_at, delivered_at) values ($1, current_date - 2, now() - interval '2 days', now() - interval '2 days')`, [id]);
  completed.push(id);
}
const submitted = [await legacy('submitted', [[beans.id, 3]]), await legacy('submitted', [[cups.id, 2]]), await legacy('submitted', [[beans.id, 4]])];
const review = [await legacy('under_review', [[beans.id, 6]]), await legacy('under_review', [[cups.id, 1]])];
const endorsed = [
  await legacy('endorsed', [[beans.id, 10]], { endorsed_at: new Date() }),
  await legacy('endorsed', [[beans.id, 20]], { endorsed_at: new Date() }),
  await legacy('endorsed', [[cups.id, 10]], { endorsed_at: new Date() }), // only 5 cups in the warehouse
];
const preparing = [
  await legacy('preparing', [[beans.id, 10]], { endorsed_at: new Date(), preparing_at: new Date(), stock_deducted_at: new Date() }),
  await legacy('preparing', [[beans.id, 15]], { endorsed_at: new Date(), preparing_at: new Date(), stock_deducted_at: new Date() }),
];
const dispatched = await legacy('dispatched', [[beans.id, 5]], { endorsed_at: new Date(), preparing_at: new Date(), stock_deducted_at: new Date() });
await q(`insert into deliveries (supply_request_id, dispatched_at) values ($1, now() - interval '1 hour')`, [dispatched]);

const counts = async () => Object.fromEntries((await q(`select status, count(*)::int as n from supply_requests where location_id = $1 group by status`, [location.id])).map((r) => [r.status, r.n]));
assert.deepEqual(await counts(), { completed: 20, submitted: 3, under_review: 2, endorsed: 3, preparing: 2, dispatched: 1 }, 'the live mix');

await pg.exec(readFileSync(MIGRATION, 'utf8'));

test('statuses map: endorsed → scheduled, the rest stay; the new check holds', async () => {
  assert.deepEqual(await counts(), { completed: 20, submitted: 3, under_review: 2, scheduled: 3, preparing: 2, dispatched: 1 });
  await assert.rejects(q(`update supply_requests set status = 'endorsed' where id = $1`, [submitted[0]]), /supply_requests_status_check/);
  assert.equal(await stock(beansStock.id), 150, 'the migration moves no stock');
  assert.equal(await stock(cupsStock.id), 5);
  for (const id of [...submitted, ...review]) assert.ok((await q(`select submitted_at from supply_requests where id = $1`, [id]))[0].submitted_at);
  const done = await q(`select si.quantity_endorsed, si.quantity_prepared from supply_request_items si where si.supply_request_id = any($1::bigint[])`, [`{${completed.join(',')}}`]);
  assert.ok(done.every((r) => r.quantity_endorsed === '1.00' && r.quantity_prepared === '1.00'));
});

test('endorsed rows are reserved, or flagged when the warehouse is short', async () => {
  const reserved = async (id: number) => Number((await q(`select coalesce(sum(quantity), 0) as q from supply_reservations where supply_request_id = $1 and status = 'active'`, [id]))[0].q);
  assert.equal(await reserved(endorsed[0]), 10);
  assert.equal(await reserved(endorsed[1]), 20);
  assert.equal(await reserved(endorsed[2]), 5, 'as much as there is');
  const flags = await q(`select id, reservation_incomplete, fulfillment_type, confirmed_delivery_date from supply_requests where id = any($1::bigint[]) order by id`, [`{${endorsed.join(',')}}`]);
  assert.deepEqual(flags.map((f) => f.reservation_incomplete), [false, false, true]);
  assert.ok(flags.every((f) => f.fulfillment_type === 'full' && f.confirmed_delivery_date === '2026-11-20'));
  const [note] = await q(`select remarks, action, actor_role from supply_request_status_histories where supply_request_id = $1`, [endorsed[2]]);
  assert.match(note.remarks, /Reservation incomplete at migration/);
  assert.deepEqual([note.action, note.actor_role], ['migrated', 'system']);
  for (const id of preparing) assert.equal(await reserved(id), 0, 'already deducted, nothing to reserve');

  // Logistics sees the flagged request and reports the shortage; Admin then decides.
  const list = await call('GET', '/supply-requests?status=scheduled', { token: logistics });
  assert.equal(list.json.data.filter((r: any) => r.location_id === location.id).length, 3);
  assert.equal(list.json.data.find((r: any) => r.id === endorsed[2]).reservation_incomplete, true);
  const [item] = await q(`select id from supply_request_items where supply_request_id = $1`, [endorsed[2]]);
  const report = await call('POST', `/supply-requests/${endorsed[2]}/shortage`, { token: logistics, body: { reason: 'Only five cups on the shelf', items: [{ item_id: item.id, actual_count: 5 }] } });
  assert.equal(report.status, 200, JSON.stringify(report.json));
  assert.equal(await stock(cupsStock.id), 5);
});

test('preparing rows are not deducted twice when dispatched', async () => {
  const before = await stock(beansStock.id);
  const res = await call('POST', `/supply-requests/${preparing[0]}/dispatch`, {
    token: logistics,
    body: { driver_name: 'Pedro Reyes', driver_contact: '09181234567', plate_number: 'XYZ 987', departed_at: new Date(Date.now() - 60_000).toISOString(), eta_at: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.status, 'dispatched');
  assert.equal(await stock(beansStock.id), before, 'deducted once, at the old Preparing');
  assert.equal(Number(res.json.data.items[0].quantity_prepared), 10);
  assert.match((await call('POST', `/supply-requests/${preparing[1]}/shortage`, { token: logistics, body: { reason: 'Count is off', items: [] } })).json.errors.status[0], /previous workflow/);
});

test('the dispatched row is confirmed through the new receipt form and credits only the good quantity', async () => {
  const [item] = await q(`select id, quantity_prepared from supply_request_items where supply_request_id = $1`, [dispatched]);
  assert.equal(item.quantity_prepared, '5.00');
  const form = new FormData();
  form.set('lines', JSON.stringify([{ item_id: item.id, good: 3, damaged: 1, short: 1, damage_reason: 'Torn bag', short_reason: 'One bag missing' }]));
  form.set(`photo_${item.id}`, new File([new Uint8Array([1])], 'torn.jpg', { type: 'image/jpeg' }));
  const res = await call('POST', `/supply-requests/${dispatched}/receipt`, { token: branchToken, form });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const [material] = await q(`select b.quantity_milli from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1 and m.warehouse_product_id = $2`, [location.id, beans.id]);
  assert.equal(material.quantity_milli, 3000, 'only the 3 good');
  assert.equal(res.json.data.status, 'dispatched', 'the POD is still to come');
});

test('running the migration again changes nothing', async () => {
  const before = { counts: await counts(), reservations: (await q(`select count(*)::int as n from supply_reservations`))[0].n, history: (await q(`select count(*)::int as n from supply_request_status_histories`))[0].n };
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
  assert.deepEqual(await counts(), before.counts);
  assert.equal((await q(`select count(*)::int as n from supply_reservations`))[0].n, before.reservations);
  assert.equal((await q(`select count(*)::int as n from supply_request_status_histories`))[0].n, before.history);
  assert.equal((await q(`select count(*)::int as n from supply_settings`))[0].n, 0, 'created on first save, not by the migration');
});
