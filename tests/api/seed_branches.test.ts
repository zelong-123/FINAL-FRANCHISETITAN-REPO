// supabase/seed/branchActivity.ts: 14 days of branch activity through the system's own routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN, PASSWORD, setup } from '../support/harness.ts';
import { replaceProducts } from '../../supabase/seed/replaceProducts.ts';
import { seedBranchActivity } from '../../supabase/seed/branchActivity.ts';

const { pg, db, auth, call, login } = await setup();
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
await replaceProducts(db, readFileSync(new URL('../../supabase/seed/products.csv', import.meta.url), 'utf8'));

// Two branches with active owners (Kkopi, La Pasta) and one whose account is inactive.
async function branch(brandName: string, name: string, status = 'active') {
  const [brand] = await q(`select id from brands where name = $1`, [brandName]);
  const [role] = await q(`select id from roles where name = 'franchisee'`);
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}@branch.local`;
  const uid = await auth.addUser(email, PASSWORD);
  const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, $2, $3, $4, $5::uuid) returning id`, [role.id, `${name} Owner`, email, status, uid]);
  const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ($1, 'active_franchisee', $2, $3, '2026-01-01') returning id`, [`${name} Owner`, user.id, brand.id]);
  const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, $3, 'active', '2026-01-01') returning id`, [applicant.id, user.id, name]);
  const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, type, address, is_active) values ($1, $2, $3, 'franchise', 'Main Road', true) returning id`, [franchisee.id, brand.id, name]);
  return location.id as number;
}
const kkopi = await branch('Kkopi', 'Kkopi Alabang');
const pasta = await branch('La Pasta', 'La Pasta Ortigas');
const closed = await branch('Kkopi', 'Kkopi Paranaque', 'inactive');
const warehouseBefore = await q(`select i.product_id, i.current_stock::float as stock from inventories i where i.location_id = (select id from franchise_locations where type = 'warehouse' limit 1) order by i.product_id`);

const report = await seedBranchActivity(db);

test('active branches get two deliveries, 14 days of production and one open request', async () => {
  for (const id of [kkopi, pasta]) {
    const statuses = (await q(`select status from supply_requests where location_id = $1 order by id`, [id])).map((r) => r.status);
    assert.deepEqual(statuses.slice(0, 2), ['completed', 'completed']);
    assert.equal(statuses.length, 3);
    const days = await q(`select count(distinct (created_at at time zone 'Asia/Manila')::date)::int as n, min(created_at) as first from profittrack_production_batches where location_id = $1`, [id]);
    assert.equal(days[0].n, 14, '14 production days');
    assert.ok(Date.now() - new Date(days[0].first).getTime() > 13 * 86_400_000, 'history starts two weeks back');
    assert.equal((await q(`select count(*)::int as n from profittrack_material_balances where location_id = $1 and quantity_milli < 0`, [id]))[0].n, 0, 'never negative');
    const used = await q(`select count(*)::int as n from profittrack_material_movements where location_id = $1 and type = 'production_consumption'`, [id]);
    assert.ok(used[0].n > 0, 'production deducted branch stock');
  }
  assert.equal((await q(`select count(*)::int as n from supply_requests where created_at > now() or (completed_at is not null and completed_at > now())`))[0].n, 0, 'nothing dated in the future');
});

test('an inactive branch account gets a dispatched delivery waiting for receipt, nothing else', async () => {
  assert.deepEqual((await q(`select status from supply_requests where location_id = $1`, [closed])).map((r) => r.status), ['dispatched']);
  assert.equal((await q(`select count(*)::int as n from profittrack_materials where location_id = $1`, [closed]))[0].n, 0);
  assert.match(report.branches.find((b) => b.branch === 'Kkopi Paranaque')!.status, /inactive/);
});

test('the warehouse receives one supplier delivery and ends where it started; every stock change is in its ledger', async () => {
  assert.ok(report.warehouse_restock.items > 0);
  // Free stock = on hand minus active reservations (requests endorsed but not dispatched yet).
  const after = await q(`select i.product_id, (i.current_stock - coalesce((select sum(r.quantity) from supply_reservations r where r.product_id = i.product_id and r.status = 'active'), 0))::float as stock
     from inventories i where i.location_id = (select id from franchise_locations where type = 'warehouse' limit 1) order by i.product_id`);
  // The supplier delivery covered every draw: dispatched requests and the reservations of open ones,
  // so each item's free stock ends where it started (rounding aside).
  for (const row of after) {
    const before = warehouseBefore.find((b) => b.product_id === row.product_id)!.stock;
    assert.ok(Math.abs(row.stock - before) < 0.02, `warehouse item ${row.product_id}: ${before} -> ${row.stock}`);
  }
  assert.equal((await q(`select count(*)::int as n from inventories i where i.current_stock <> coalesce((select t.balance_after from inventory_transactions t where t.inventory_id = i.id order by t.id desc limit 1), 0)`))[0].n, 0);
});

test('the Branches page reads the activity, and a second run changes nothing', async () => {
  const admin = await login(ADMIN);
  const overview = (await call('GET', '/branches/overview', { token: admin })).json.data;
  const k = overview.branches.find((b: any) => b.id === kkopi);
  assert.ok(k.materials_count > 5);
  assert.equal(k.open_request_count, 1);
  const ops = (await call('GET', `/branches/${kkopi}/operations`, { token: admin })).json.data;
  assert.equal(ops.deliveries.length, 2);
  assert.ok(ops.inventory.some((m: any) => m.daily_usage > 0), 'usage shows on the branch page');

  const counts = async () => (await q(`select (select count(*)::int from supply_requests) as r, (select count(*)::int from profittrack_production_batches) as b, (select count(*)::int from inventory_transactions) as t`))[0];
  const before = await counts();
  const again = await seedBranchActivity(db);
  assert.ok(again.branches.every((b) => b.status.startsWith('skipped')));
  assert.equal(again.warehouse_restock.items, 0);
  assert.deepEqual(await counts(), before);
});
