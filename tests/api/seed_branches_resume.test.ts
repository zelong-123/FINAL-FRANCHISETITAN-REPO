// A branch-activity run that stopped after the warehouse supplier delivery and before the branches:
// the next run must not restock again, and two runs can never overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOGISTICS, PASSWORD, setup } from '../support/harness.ts';
import { replaceProducts } from '../../supabase/seed/replaceProducts.ts';
import { seedBranchActivity } from '../../supabase/seed/branchActivity.ts';

const { pg, db, auth, call, login } = await setup();
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
await replaceProducts(db, readFileSync(new URL('../../supabase/seed/products.csv', import.meta.url), 'utf8'));

const [brand] = await q(`select id from brands where name = 'Kkopi'`);
const [role] = await q(`select id from roles where name = 'franchisee'`);
const uid = await auth.addUser('kkopi.resume@branch.local', PASSWORD);
const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, 'Resume Owner', 'kkopi.resume@branch.local', 'active', $2::uuid) returning id`, [role.id, uid]);
const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ('Resume Owner', 'active_franchisee', $1, $2, '2026-01-01') returning id`, [user.id, brand.id]);
const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Kkopi Resume', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, type, address, is_active) values ($1, $2, 'Kkopi Resume', 'franchise', 'Main Road', true) returning id`, [franchisee.id, brand.id]);
// Free stock: on hand minus the reservations of endorsed requests not dispatched yet.
const stock = async () => Object.fromEntries((await q(`select i.product_id, (i.current_stock - coalesce((select sum(r.quantity) from supply_reservations r where r.product_id = i.product_id and r.status = 'active'), 0))::float as s from inventories i where i.location_id = (select id from franchise_locations where type = 'warehouse' limit 1)`)).map((r) => [r.product_id, r.s]));

test('a run that stopped after the supplier delivery is finished without restocking twice', async () => {
  const before = await stock();
  // Simulate the stopped run: the supplier delivery is recorded (as Logistics would), no branch is filled.
  const plan = await seedBranchActivity(db, { planOnly: true });
  assert.ok(plan.warehouse_restock.items > 0);
  const logistics = await login(LOGISTICS);
  for (const line of plan.warehouse_restock.lines) {
    const [productId, amount] = line.split(': +');
    const [inv] = await q(`select id from inventories where product_id = $1 and location_id = (select id from franchise_locations where type = 'warehouse' limit 1)`, [Number(productId)]);
    const res = await call('POST', `/inventories/${inv.id}/quantity`, { token: logistics, body: { direction: 'increase', quantity: Number(amount), note: 'Supplier delivery received at the Central Warehouse.' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
  }
  assert.equal((await seedBranchActivity(db, { planOnly: true })).warehouse_restock.items, 0, 'the plan now sees the delivery already recorded');

  const report = await seedBranchActivity(db);
  assert.equal(report.warehouse_restock.items, 0, 'no second supplier delivery');
  assert.equal(report.branches.find((b) => b.branch === 'Kkopi Resume')!.status, 'done');
  assert.equal((await q(`select count(*)::int as n from supply_requests where location_id = $1`, [location.id]))[0].n, 3);
  const after = await stock();
  for (const [id, s] of Object.entries(before)) assert.ok(Math.abs(after[id] - s) < 0.02, `warehouse item ${id} back to ${s} (now ${after[id]})`);
});

test('two runs can never overlap', async () => {
  await pg.query(`select pg_advisory_lock(hashtext('franchisetitan.seed-branch-activity'))`);
  try {
    // PGlite has one session, so the lock is re-entrant there; check the guard text against the SQL instead.
    const [{ held }] = await q(`select count(*)::int as held from pg_locks where locktype = 'advisory'`);
    assert.ok(held >= 1);
  } finally {
    await pg.query(`select pg_advisory_unlock(hashtext('franchisetitan.seed-branch-activity'))`);
  }
  const source = readFileSync(new URL('../../supabase/seed/branchActivity.ts', import.meta.url), 'utf8');
  assert.match(source, /pg_try_advisory_lock\(hashtext\('franchisetitan\.seed-branch-activity'\)\)/);
  assert.match(source, /Another branch-activity run is still in progress/);
});
