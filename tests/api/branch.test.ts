// Branch workspace, portal, ProfitTrack ledger and the Branches panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, SALES, setup } from '../support/harness.ts';
import { manilaToday } from '../../supabase/functions/api/lib/http.ts';

const { pg, call, login, auth, deps } = await setup();
deps.costingEnabled = true; // These tests check money; the ones about hiding it turn it off.
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id, name from brands order by id limit 1`);

async function branchAccount(email: string, name: string) {
  const [roleRow] = await q(`select id from roles where name = 'franchisee'`);
  const uid = await auth.addUser(email, PASSWORD);
  const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, $2, $3, 'active', $4::uuid) returning id`, [roleRow.id, name, email, uid]);
  const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ($1, 'active_franchisee', $2, $3, '2026-01-01') returning id`, [name, user.id, brand.id]);
  const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Co', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
  const code = `BR-${user.id}`;
  const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, branch_code, type, address, city, is_active) values ($1, $2, $3, $4, 'franchise', 'Addr', 'Cebu', true) returning id`, [franchisee.id, brand.id, `${name} Branch`, code]);
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD, portal: 'branch' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { token: res.json.data.token as string, id: location.id as number, userId: user.id as number, code };
}
const branch = await branchAccount('owner.one@test.local', 'Owner One');
const other = await branchAccount('owner.two@test.local', 'Owner Two');
const w = '/branch/workspace';

let flour: number;
let sugar: number;
let recipeId: number;

test('ProfitTrack ledger: weighted average, idempotent retries, exact sale and void', async () => {
  const material = async (name: string, unit: string) => (await call('POST', '/profittrack/materials', { token: branch.token, body: { name, unit } }));
  const created = await material('Flour', 'kg');
  assert.equal(created.status, 201, JSON.stringify(created.json));
  flour = created.json.data.id;
  sugar = (await material('Sugar', 'kg')).json.data.id;
  assert.match((await call('POST', '/profittrack/materials', { token: branch.token, body: { name: 'X', unit: 'nope' } })).json.errors.unit[0], /invalid/);
  assert.equal((await call('GET', '/profittrack/materials', { token: branch.token })).status, 200);
  assert.equal((await call('GET', '/profittrack/materials?branch_code=OTHER', { token: branch.token })).status, 422, 'a branch never selects a branch');
  assert.equal((await call('GET', '/profittrack/materials', { token: admin })).status, 422, 'Admin must name a branch');
  assert.equal((await call('GET', '/profittrack/materials', { token: logistics })).status, 403);

  const receive = (key: string, material_id: number, quantity_milli: number, total_cost_cents: number) => call('POST', '/profittrack/materials/receive', { token: branch.token, body: { material_id, quantity_milli, total_cost_cents, reason: 'Stock', idempotency_key: key } });
  const first = await receive('r1', flour, 10_000, 1000);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal((await receive('r1', flour, 10_000, 1000)).status, 200, 'same key and data replays');
  assert.match((await receive('r1', flour, 9_000, 1000)).json.errors.idempotency_key[0], /different receipt/);
  await receive('r2', flour, 10_000, 3000);
  await receive('r3', sugar, 5_000, 500);
  const [balance] = await q(`select * from profittrack_material_balances where material_id = $1`, [flour]);
  assert.equal(balance.quantity_milli, 20000);
  assert.equal(balance.value_cents, 4000);
  assert.equal(balance.unit_cost_micropesos, 2000000, '₱2.00 per unit-milli scale: 4000 cents over 20000 milli');

  // Recipes are Admin's; a branch cannot create one.
  const body = { branch_code: branch.code, name: 'Bread', sku: 'BREAD', standard_price_cents: 500, ingredients: [{ material_id: flour, quantity: 0.5 }, { material_id: sugar, quantity_milli_per_piece: 100 }] };
  assert.equal((await call('POST', '/profittrack/recipes', { token: branch.token, body })).status, 403);
  const recipe = await call('POST', '/profittrack/recipes', { token: admin, body });
  assert.equal(recipe.status, 201, JSON.stringify(recipe.json));
  recipeId = recipe.json.data.id;
  assert.equal(recipe.json.data.versions[0].ingredients[0].quantity_milli_per_piece, 500);
  assert.equal(recipe.json.data.versions[0].ingredients[0].material.balance.quantity_milli, 20000);

  const made = await call('POST', '/profittrack/production', { token: branch.token, body: { recipe_id: recipeId, quantity_pieces: 10, idempotency_key: 'p1' } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.data.batch.total_cost_cents, 1100, '5 kg flour at ₱2 + 1 kg sugar at ₱1');
  assert.equal((await call('POST', '/profittrack/production', { token: branch.token, body: { recipe_id: recipeId, quantity_pieces: 10, idempotency_key: 'p1' } })).status, 200);
  assert.equal((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [flour]))[0].quantity_milli, 15000, 'the retry deducted nothing');
  assert.match((await call('POST', '/profittrack/production', { token: branch.token, body: { recipe_id: recipeId, quantity_pieces: 9999, idempotency_key: 'p2' } })).json.errors.quantity_pieces[0], /Insufficient material/);

  const sale = await call('POST', '/profittrack/sales', { token: branch.token, body: { idempotency_key: 's1', items: [{ recipe_id: recipeId, quantity_pieces: 4 }] } });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));
  assert.deepEqual([sale.json.data.sale.revenue_cents, sale.json.data.sale.cost_cents, sale.json.data.sale.profit_cents], [2000, 440, 1560]);
  assert.match(sale.json.data.sale.sale_number, /^PT-\d+-\d{14}-\d+$/);
  assert.match((await call('POST', '/profittrack/sales', { token: branch.token, body: { idempotency_key: 's2', items: [{ recipe_id: recipeId, quantity_pieces: 1, realized_price_cents: 100 }] } })).json.errors['items.0.discount_reason'][0], /reason is required/);
  const dashboard = await call('GET', '/profittrack/dashboard', { token: branch.token });
  assert.equal(dashboard.json.data.summary.month_revenue_cents, 2000);
  assert.equal(dashboard.json.data.summary.finished_pieces, 6);
  assert.equal((await call('POST', `/profittrack/sales/${sale.json.data.sale.id}/void?branch_code=${branch.code}`, { token: admin, body: { reason: 'Mistake' } })).status, 200);
  assert.match((await call('POST', `/profittrack/sales/${sale.json.data.sale.id}/void?branch_code=${branch.code}`, { token: admin, body: { reason: 'Again' } })).json.errors.sale[0], /already been voided/);
  assert.equal((await call('GET', '/profittrack/dashboard', { token: branch.token })).json.data.summary.month_revenue_cents, 0, 'a voided sale no longer counts');
  assert.equal((await call('GET', '/profittrack/dashboard', { token: branch.token })).json.data.summary.finished_pieces, 10);
  const listed = await call('GET', '/profittrack/sales', { token: branch.token });
  assert.equal(listed.json.meta.total, 1);
  assert.ok(listed.json.data[0].void);
  assert.equal((await call('GET', '/profittrack/analytics', { token: admin })).status, 403);

  // A physical count moves value at the average cost, with the reason on record.
  const counted = await call('POST', '/profittrack/materials/count', { token: branch.token, body: { material_id: sugar, counted_quantity_milli: 3000, reason: 'Spilled', idempotency_key: 'c1' } });
  assert.equal(counted.status, 201, JSON.stringify(counted.json));
  assert.equal(counted.json.data.count.quantity_delta_milli, -1000);
  assert.equal((await q(`select quantity_milli, value_cents from profittrack_material_balances where material_id = $1`, [sugar]))[0].value_cents, 300);
  const valued = await call('PUT', `/profittrack/materials/${sugar}/valuation?branch_code=${branch.code}`, { token: admin, body: { unit_cost_micropesos: 2_000_000, reason: 'Corrected' } });
  assert.equal(valued.status, 200, JSON.stringify(valued.json));
  assert.equal(valued.json.data.value_cents, 600);
});

test('CSV preview reads without importing', async () => {
  const csv = `Name,Variant,Qty,Unit,TotalCost\r\nFlour,,10,kilograms,100\r\nMilk,Fresh,3,liters,10\r\nMilk,Fresh,1,liters,1\r\nBad,1,oops,0\r\n"Broken"x,1,pieces,1\r\n`;
  const res = await call('POST', '/profittrack/csv-preview', { token: branch.token, body: { csv } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.rows.length, 2);
  assert.equal(res.json.data.rows[0].unit_cost_exact, '10');
  assert.equal(res.json.data.rows[1].unit_cost_exact, '10/3');
  assert.deepEqual(res.json.data.errors.map((e: any) => e.row), [4, 5, 6]);
  assert.match(res.json.data.errors[2].message, /Malformed/);
  assert.match((await call('POST', '/profittrack/csv-preview', { token: branch.token, body: { csv, brand_id: 1 } })).json.errors.brand_id[0], /prohibited/);
});

test('workspace: multi-line production reports every shortage, voids only today, Admin is told', async () => {
  assert.equal((await call('GET', `${w}/materials`, { token: sales })).status, 403);
  assert.equal((await call('GET', `${w}/materials?branch_code=${branch.code}`, { token: logistics })).json.data.length, 2);
  assert.equal((await call('GET', `${w}/materials?branch_code=NOPE`, { token: admin })).status, 404);

  const short = await call('POST', `${w}/produce`, { token: branch.token, body: { idempotency_key: 'm1', items: [{ recipe_id: recipeId, quantity_pieces: 5000 }] } });
  assert.equal(short.status, 422);
  assert.match(short.json.errors.items[0], /^Insufficient ingredients: Flour \(need 2500 kg, have 15 kg\); Sugar/);
  assert.equal(JSON.parse(short.json.errors.shortages[0]).length, 2);

  const made = await call('POST', `${w}/produce`, { token: branch.token, body: { idempotency_key: 'm2', items: [{ recipe_id: recipeId, quantity_pieces: 2 }] } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const batch = made.json.data.batches[0];
  assert.equal(batch.recipe.name, 'Bread');

  const dashboard = await call('GET', `${w}/production-dashboard`, { token: branch.token });
  assert.equal(dashboard.json.data.series.length, 12);
  assert.equal(dashboard.json.data.summary.month_batches, 2);
  assert.equal(dashboard.json.data.summary.month_units, 12);
  assert.equal(dashboard.json.data.series[11].units, 12);
  assert.equal(dashboard.json.data.recent[0].submitted_by, 'Owner One');
  const yearly = (await call('GET', `${w}/production-dashboard?period=year`, { token: branch.token })).json.data.series;
  assert.equal(yearly.length, 6);
  assert.equal(yearly[5].period, manilaToday().slice(0, 4));
  assert.equal(yearly[5].units, 12, 'a year counts every month, not only January');
  assert.equal(yearly[5].transactions, 2);
  // An older batch in another month of last year lands in last year's bar.
  const lastYear = Number(manilaToday().slice(0, 4)) - 1;
  await q(`update profittrack_production_batches set created_at = $1::timestamptz where id = $2`, [`${lastYear}-06-15T12:00:00+08:00`, batch.id]);
  const moved = (await call('GET', `${w}/production-dashboard?period=year`, { token: branch.token })).json.data.series;
  assert.equal(moved[4].units, 2);
  assert.equal(moved[5].units, 10);
  await q(`update profittrack_production_batches set created_at = now() where id = $1`, [batch.id]);
  assert.equal((await call('GET', `${w}/production-transactions`, { token: branch.token })).json.meta.total, 2);

  assert.equal((await call('POST', `${w}/production/${batch.id}/void`, { token: admin, body: { reason: 'x' } })).status, 403, 'Admin is view-only');
  assert.equal((await call('POST', `${w}/production/${batch.id}/void`, { token: other.token, body: { reason: 'x' } })).status, 404, 'another branch cannot see it');
  assert.match((await call('POST', `${w}/production/${batch.id}/void`, { token: branch.token, body: {} })).json.errors.reason[0], /Enter a reason/);
  const voided = await call('POST', `${w}/production/${batch.id}/void`, { token: branch.token, body: { reason: 'Burned' } });
  assert.equal(voided.status, 200, JSON.stringify(voided.json));
  assert.equal((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [flour]))[0].quantity_milli, 15000, 'ingredients restored');
  assert.match((await call('POST', `${w}/production/${batch.id}/void`, { token: branch.token, body: { reason: 'Again' } })).json.errors.production[0], /already voided/);
  assert.ok((await q(`select 1 from system_notifications where type = 'production_voided'`)).length >= 1);
  const recent = await call('GET', `${w}/recent-production?today=1`, { token: branch.token });
  assert.equal(recent.json.data[0].voided, true);
  assert.equal(recent.json.data[0].void_reason, 'Burned');

  await q(`update profittrack_production_batches set created_at = now() - interval '2 days' where voided_at is null`);
  const [old] = await q(`select id from profittrack_production_batches where voided_at is null limit 1`);
  assert.equal((await call('POST', `${w}/production/${old.id}/void`, { token: branch.token, body: { reason: 'Late' } })).status, 403);
});

test('workspace: recipe edits are Admin only and create a new version', async () => {
  const body = { branch_code: branch.code, name: 'Bread 2', ingredients: [{ material_id: flour, quantity: 250, unit: 'g' }] };
  assert.equal((await call('PUT', `${w}/recipes/${recipeId}`, { token: branch.token, body })).status, 403);
  const saved = await call('PUT', `${w}/recipes/${recipeId}`, { token: admin, body });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.data.current_version, 2);
  assert.equal(saved.json.data.standard_price_cents, 500, 'price kept when omitted');
  assert.equal(saved.json.data.versions[1].ingredients[0].quantity_milli_per_piece, 250, '250 g of a kg material');
  assert.match((await call('PUT', `${w}/recipes/${recipeId}`, { token: admin, body: { ...body, ingredients: [{ material_id: flour, quantity: 1, unit: 'ml' }] } })).json.errors.ingredients[0], /not compatible/);
  const listed = await call('GET', `${w}/recipes`, { token: branch.token });
  assert.equal(listed.json.data[0].versions.length, 2);
  assert.equal(listed.json.data[0].image_url, null);
});

test('workspace: raw material CSV needs duplicates resolved, re-imports reuse materials', async () => {
  assert.match(await (await call('GET', `${w}/materials-template`, { token: branch.token })).res.text(), /unit_cost/);
  deps.costingEnabled = false;
  assert.doesNotMatch(await (await call('GET', `${w}/materials-template`, { token: branch.token })).res.text(), /unit_cost/, 'no costing column while costing is off');
  deps.costingEnabled = true;

  const csv = 'material_name,variant,unit,quantity\nButter,,kg,2\nFlour,,kg,1\nButter,,kg,3\n';
  const preview = await call('POST', `${w}/materials-preview`, { token: branch.token, body: { csv } });
  assert.equal(preview.json.data.valid_count, 3);
  assert.deepEqual(preview.json.data.duplicates.map((d: any) => d.label).sort(), ['Butter', 'Flour']);
  assert.equal(preview.json.data.groups, undefined);
  assert.match((await call('POST', `${w}/materials-import`, { token: branch.token, body: { csv } })).json.errors.duplicates[0], /Combine or Remove/);
  assert.equal((await call('POST', `${w}/materials-import`, { token: admin, body: { csv, branch_code: branch.code } })).status, 403);
  assert.match((await call('POST', `${w}/materials-preview`, { token: branch.token, body: { csv: 'name\nfoo' } })).json.errors.csv[0], /missing the "material_name"/);
  const badUnit = await call('POST', `${w}/materials-preview`, { token: branch.token, body: { csv: 'material_name,variant,unit,quantity\nA,,parsec,1\nB,,kg,0\n,,kg,1\n' } });
  assert.deepEqual(badUnit.json.data.errors.map((e: any) => e.line), [2, 3, 4]);

  const flourBefore = Number((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [flour]))[0].quantity_milli);
  const done = await call('POST', `${w}/materials-import`, { token: branch.token, body: { csv, resolutions: { 'butter||kg': 'combine', 'flour||kg': 'combine' } } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.data.created, 1);
  const [butter] = await q(`select b.quantity_milli from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1 and m.name = 'Butter'`, [branch.id]);
  assert.equal(butter.quantity_milli, 5000);
  assert.equal(Number((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [flour]))[0].quantity_milli), flourBefore + 1000, 'an existing manual material is reused, not duplicated');
  const removed = await call('POST', `${w}/materials-import`, { token: branch.token, body: { csv: 'material_name,variant,unit,quantity\nButter,,kg,100\n', resolutions: { 'butter||kg': 'remove' } } });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal((await q(`select b.quantity_milli from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1 and m.name = 'Butter'`, [branch.id]))[0].quantity_milli, 5000, 'Remove discards the row');
});

test('workspace: brand products sync a recipe, report missing materials and produce at zero cost', async () => {
  const [wheat] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'WHEAT', 'Wheat Mix', 'kg') returning id`, [brand.id]);
  const created = await call('POST', '/brand-products', { token: admin, body: { brand_id: brand.id, name: 'Pandesal', is_active: true, ingredients: [{ product_id: wheat.id, batch_amount: 1, yield_pieces: 10 }] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const productId = created.json.data.id;
  const listed = await call('GET', `${w}/products`, { token: branch.token });
  assert.equal(listed.json.data.products[0].ingredients[0].missing, true);
  assert.equal(listed.json.data.has_materials, true);

  const body = { idempotency_key: 'bp1', items: [{ brand_product_id: productId, quantity_pieces: 10 }] };
  const missing = await call('POST', `${w}/produce-product`, { token: branch.token, body });
  assert.match(missing.json.errors.items[0], /Wheat Mix \(not in branch inventory\)/);

  // Delivered with no known cost: quantity arrives, value stays unknown.
  const [material] = await q(`insert into profittrack_materials (location_id, name, unit, warehouse_product_id, source) values ($1, 'Wheat Mix', 'kg', $2, 'Warehouse') returning id`, [branch.id, wheat.id]);
  await q(`insert into profittrack_material_balances (location_id, material_id, quantity_milli) values ($1, $2, 5000)`, [branch.id, material.id]);
  const made = await call('POST', `${w}/produce-product`, { token: branch.token, body });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  assert.equal(made.json.data.batches[0].total_cost_cents, 0);
  assert.equal(made.json.data.batches[0].recipe.name, 'Pandesal');
  assert.equal((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [material.id]))[0].quantity_milli, 4000);
  const again = await call('POST', `${w}/produce-product`, { token: branch.token, body: { ...body, idempotency_key: 'bp2' } });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.equal((await q(`select count(*)::int as n from profittrack_recipes where brand_product_id = $1`, [productId]))[0].n, 1);
  assert.equal((await q(`select current_version from profittrack_recipes where brand_product_id = $1`, [productId]))[0].current_version, 1, 'an unchanged recipe adds no version');
  assert.equal((await call('POST', `${w}/produce-product`, { token: branch.token, body: { idempotency_key: 'bp3', items: [{ brand_product_id: 99999, quantity_pieces: 1 }] } })).json.errors.items[0], 'One or more products are not published for this branch.');
});

test('workspace: receiving a delivered request, and adding only the cost afterwards', async () => {
  const [store] = await q(`select id from franchise_locations where type = 'warehouse' limit 1`);
  const [product] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'OIL', 'Cooking Oil', 'kg') returning id`, [brand.id]);
  await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, 40, 5, 1)`, [store.id, product.id]);
  const warehouse = await call('GET', `${w}/warehouse-products`, { token: branch.token });
  assert.equal(warehouse.json.data.products.find((p: any) => p.id === product.id).available, 40);

  // Dispatched with a POD (status Delivered): the branch has not confirmed the receipt yet.
  const [request] = await q(`insert into supply_requests (location_id, request_number, status, requested_by_user_id, delivery_address) values ($1, 'FT-MANUAL', 'dispatched', $2, 'Addr') returning id`, [branch.id, branch.userId]);
  const [item] = await q(`insert into supply_request_items (supply_request_id, product_id, quantity_requested, quantity_endorsed, quantity_prepared) values ($1, $2, 4, 4, 4) returning id`, [request.id, product.id]);
  await q(`insert into deliveries (supply_request_id, dispatched_at, pod_encoded_at) values ($1, now(), now())`, [request.id]);
  const body = { supply_request_id: request.id, total_cost_cents: 800, lines: [{ product_id: product.id, quantity: 4 }] };
  assert.match((await call('POST', `${w}/receive-stock`, { token: branch.token, body })).json.errors.supply_request_id[0], /Only delivered/);
  assert.equal((await call('POST', `${w}/receive-stock`, { token: other.token, body })).status, 404, 'another branch cannot receive it');
  await q(`update supply_requests set status = 'delivered' where id = $1`, [request.id]);
  assert.match((await call('POST', `${w}/receive-stock`, { token: branch.token, body })).json.errors.supply_request_id[0], /Confirm the receipt/, 'quantities only come through Confirm Receipt');

  const stock = async () => (await q(`select b.quantity_milli, b.value_cents from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1 and m.name = 'Cooking Oil'`, [branch.id]))[0];
  const received = await call('POST', `/supply-requests/${request.id}/receipt`, { token: branch.token, body: { lines: [{ item_id: item.id, good: 4, damaged: 0, short: 0 }] } });
  assert.equal(received.status, 200, JSON.stringify(received.json));
  assert.equal(received.json.data.status, 'completed', 'POD and receipt both recorded');
  assert.equal((await stock()).quantity_milli, 4000);

  const cost = await call('POST', `${w}/receive-stock`, { token: branch.token, body });
  assert.match(cost.json.message, /already added/);
  assert.equal((await stock()).quantity_milli, 4000, 'quantities are never added twice');
  const valued = (await stock()).value_cents;
  assert.ok(valued >= 800);
  await call('POST', `${w}/receive-stock`, { token: branch.token, body });
  assert.equal((await stock()).value_cents, valued, 'the same cost is recorded once');
  const receivable = await call('GET', `${w}/receivable-requests`, { token: branch.token });
  assert.equal(receivable.json.data[0].cost_recorded, true);
  assert.ok(receivable.json.data[0].received_at);
  assert.equal(receivable.json.data[0].effective_delivery_date, null);
  const filtered = await call('GET', `${w}/supply-requests?status=completed`, { token: branch.token });
  assert.equal(filtered.json.data.length, 1);
  assert.equal((await call('GET', `${w}/supply-requests?status=nope`, { token: branch.token })).status, 422);
  assert.equal((await call('GET', `${w}/supply-requests?date=11/07/2026`, { token: branch.token })).status, 422);
});

test('portal: deductions are idempotent, scoped to the branch and warn on low stock', async () => {
  const context = await call('GET', '/branch/context', { token: branch.token });
  assert.equal(context.status, 200, JSON.stringify(context.json));
  assert.equal(context.json.data.branch_code, branch.code);
  assert.equal(context.json.data.user.auth_user_id, undefined);
  assert.equal((await call('GET', `/branch/context?branch_code=${other.code}`, { token: branch.token })).status, 403, 'cross-tenant read refused');
  assert.equal((await call('GET', '/branch/context', { token: admin })).status, 403);

  const [product] = await q(`select id from products where sku = 'OIL'`);
  const [stock] = await q(`select id from inventories where location_id = $1 and product_id = $2`, [branch.id, product.id]);
  const body = { client_reference: 'ref-1', notes: 'Used in kitchen', items: [{ inventory_id: stock.id, quantity: 3 }] };
  assert.match((await call('POST', '/branch/sales', { token: branch.token, body: { ...body, notes: null } })).json.errors.notes[0], /reason is required/);
  assert.match((await call('POST', '/branch/sales', { token: other.token, body })).json.errors.items[0], /do not belong/);
  await q(`update inventories set reorder_level = 2 where id = $1`, [stock.id]);
  const first = await call('POST', '/branch/sales', { token: branch.token, body });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.match(first.json.data.sale.sale_number, /^SALE-\d{8}-\d{6}-[A-Z0-9]{6}$/);
  assert.equal(first.json.data.sale.items[0].balance_after, 1);
  assert.ok((await q(`select 1 from system_notifications where type = 'branch_low_stock'`)).length >= 1);
  const replay = await call('POST', '/branch/sales', { token: branch.token, body });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.duplicate, true);
  assert.equal((await q(`select current_stock from inventories where id = $1`, [stock.id]))[0].current_stock, '1.00', 'not deducted twice');
  assert.match((await call('POST', '/branch/sales', { token: branch.token, body: { ...body, client_reference: 'ref-2' } })).json.errors.items[0], /Insufficient stock/);
  assert.equal((await q(`select 1 from branch_sales where client_reference = 'ref-2'`)).length, 0, 'the failed sale rolled back');

  const dashboard = await call('GET', '/branch/dashboard', { token: branch.token });
  assert.equal(dashboard.json.data.summary.inventory_units, 1);
  assert.equal(dashboard.json.data.recent_sales.length, 1);
  assert.equal(dashboard.json.data.summary.low_stock_items, 1);
  const inventory = await call('GET', '/branch/inventory', { token: branch.token });
  assert.equal(inventory.json.data.inventory[0].product.brand.id, brand.id);
  assert.ok(inventory.json.data.inventory[0].transactions_max_id);
  assert.equal(inventory.json.data.sync.version, inventory.json.data.inventory[0].transactions_max_id);
  const grouped = await call('GET', '/branch/inventory-grouped', { token: branch.token });
  assert.equal(grouped.json.data.groups[0].category_name, 'Uncategorized');
  assert.equal(grouped.json.data.meta.total, 1);
  assert.equal((await call('GET', '/branch/products', { token: branch.token })).json.data[0].brand.id, brand.id);
  const fulfillment = await call('GET', '/branch/fulfillment', { token: branch.token });
  assert.equal(fulfillment.json.data.delivered_count, 1);
  assert.equal(fulfillment.json.data.last_transaction.type, 'replenishment');
  assert.equal((await call('GET', '/branch/sales', { token: branch.token })).json.data[0].recorded_by.full_name, 'Owner One');
  const preview = await call('GET', `/branch/preview?branch_code=${branch.code}`, { token: admin });
  assert.equal(preview.json.data.read_only, true);
  assert.equal(preview.json.data.location.inventories.length, 1);
  assert.equal((await call('POST', '/branch/items', { token: admin, body: {} })).status, 403);
  assert.equal((await call('DELETE', '/branch/items', { token: admin, body: {} })).status, 403);
});

test('Branches panel: overview, operations, levels and the account lifecycle', async () => {
  assert.equal((await call('GET', '/branches/overview', { token: sales })).status, 403);
  await q(`update profittrack_material_balances set quantity_milli = 500 where material_id = $1`, [sugar]);
  const overview = await call('GET', '/branches/overview', { token: admin });
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  const card = overview.json.data.branches.find((b: any) => b.id === branch.id);
  assert.equal(card.location_label, 'Cebu');
  assert.equal(card.portal_active, true);
  assert.equal(card.operator.full_name, 'Owner One');
  assert.equal(card.product_count, 1);
  assert.ok(card.materials_count >= 4);
  assert.equal(card.recent_deductions[0].total_quantity, 3);
  assert.ok(card.needs_attention.some((n: any) => /No open supply request/.test(n.detail)));
  const active = overview.json.data.summary.active_branches; // the seed adds sample branches
  assert.ok(active >= 2);
  assert.ok(overview.json.data.summary.with_portal_account >= 2);
  assert.equal(overview.json.data.live_sync_seconds, 30);
  const emptyCard = overview.json.data.branches.find((b: any) => b.id === other.id);
  assert.equal(emptyCard.stock_status, 'none');

  const costed = await call('GET', `/branches/${branch.id}/operations`, { token: logistics });
  assert.equal(costed.json.data.inventory.find((r: any) => r.id === flour).unit_cost, 1.88, '₱30 over 16 kg after a free kilo was imported');
  assert.ok(costed.json.data.inventory_summary.value > 0);
  deps.costingEnabled = false;
  const ops = await call('GET', `/branches/${branch.id}/operations`, { token: logistics });
  deps.costingEnabled = true;
  assert.equal(ops.status, 200, JSON.stringify(ops.json));
  const flourRow = ops.json.data.inventory.find((r: any) => r.id === flour);
  assert.equal(flourRow.status, 'ok');
  assert.ok(flourRow.on_hand_display.endsWith(' kg'));
  // Usage comes from the last 7 days of batches that were not voided.
  await q(`update profittrack_material_movements set occurred_at = now() where material_id = $1 and type = 'production_consumption'`, [flour]);
  const counted = await q(`select coalesce(sum(m.quantity_delta_milli), 0) as used from profittrack_material_movements m where m.material_id = $1 and m.type = 'production_consumption'
    and not exists (select 1 from profittrack_production_batches b where b.operation_id = m.operation_id and b.voided_at is not null)`, [flour]);
  const usedKg = Math.abs(Number(counted[0].used)) / 1000;
  assert.ok(usedKg > 0, 'the test has non-voided production to measure');
  const withUsage = (await call('GET', `/branches/${branch.id}/operations`, { token: logistics })).json.data.inventory.find((r: any) => r.id === flour);
  assert.equal(withUsage.daily_usage, Math.round((usedKg / 7) * 1000) / 1000);
  assert.ok(withUsage.days_cover > 0);
  const [voidedBatch] = await q(`select count(*)::int as n from profittrack_production_batches where location_id = $1 and voided_at is not null`, [branch.id]);
  assert.ok(voidedBatch.n >= 1, 'a voided batch exists, and its movements are not in the figure above');
  assert.equal(flourRow.unit_cost, undefined, 'costing stays hidden with the feature off');
  assert.equal(ops.json.data.inventory_summary.value, undefined);
  assert.equal(ops.json.data.deliveries[0].request_number, 'FT-MANUAL');
  assert.equal(ops.json.data.branch.location_label, 'Cebu');
  const [store] = await q(`select id from franchise_locations where type = 'warehouse' limit 1`);
  assert.equal((await call('GET', `/branches/${store.id}/operations`, { token: admin })).json.message, 'This site is not a branch.');

  const levels = `/branches/${branch.id}/materials/${flour}/levels`;
  assert.equal((await call('PATCH', levels, { token: admin, body: { low_level: 5, critical_level: 2 } })).status, 403);
  assert.match((await call('PATCH', levels, { token: logistics, body: { low_level: 5, critical_level: 5 } })).json.errors.critical_level[0], /lower than the low level/);
  assert.match((await call('PATCH', levels, { token: logistics, body: { low_level: -1, critical_level: -2 } })).json.errors.low_level[0], /cannot be negative/);
  assert.equal((await call('PATCH', `/branches/${other.id}/materials/${flour}/levels`, { token: logistics, body: { low_level: 5, critical_level: 2 } })).status, 404);
  const raised = await call('PATCH', levels, { token: logistics, body: { low_level: 9999, critical_level: 2 } });
  assert.equal(Number(raised.json.data.low_level), 9999);
  const after = await call('GET', `/branches/${branch.id}/operations`, { token: logistics });
  assert.equal(after.json.data.inventory.find((r: any) => r.id === flour).status, 'low');
  assert.ok(after.json.data.needs_attention.some((n: any) => n.material_id === flour && /\(low at /.test(n.reason)));
  assert.equal(Number((await call('PATCH', levels, { token: logistics, body: { reset: true } })).json.data.low_level), 5);
  assert.ok((await q(`select 1 from audit_logs where action = 'branch_material.levels_reset'`)).length);

  // Deactivating ends the session at once; every record stays.
  const deactivate = `/branches/${other.id}/deactivate-account`;
  assert.equal((await call('POST', deactivate, { token: logistics, body: { reason: 'Closed' } })).status, 403);
  assert.match((await call('POST', deactivate, { token: admin, body: {} })).json.errors.reason[0], /why this account/);
  assert.equal((await call('POST', deactivate, { token: admin, body: { reason: 'Contract ended' } })).json.data.account_status, 'inactive');
  assert.equal((await call('GET', '/branch/context', { token: other.token })).status, 401);
  assert.equal((await call('POST', `/branches/${other.id}/reactivate-account`, { token: admin, body: {} })).json.data.account_status, 'active');

  // Archiving hides the branch and closes its portal, restoring brings all of it back.
  const archive = `/branches/${other.id}/archive`;
  assert.match((await call('POST', archive, { token: admin, body: { reason: 'ab' } })).json.errors.reason[0], /at least 3/);
  assert.equal((await call('POST', archive, { token: admin, body: { reason: 'Moved away' } })).status, 200);
  assert.match((await call('POST', archive, { token: admin, body: { reason: 'Moved away' } })).json.errors.reason[0], /already archived/);
  assert.equal((await call('GET', '/branches/overview', { token: admin })).json.data.summary.active_branches, active - 1);
  const shown = await call('GET', '/branches/overview?include_archived=1', { token: admin });
  assert.equal(shown.json.data.summary.archived_branches, 1);
  assert.equal(shown.json.data.branches.find((b: any) => b.id === other.id).archive_reason, 'Moved away');
  assert.equal((await call('GET', '/branches/overview?include_archived=1', { token: logistics })).json.data.summary.archived_branches, 0, 'only Admin sees archived');
  assert.equal((await call('POST', `/branches/${other.id}/restore`, { token: admin, body: {} })).json.data.is_active, true);
  assert.match((await call('POST', `/branches/${other.id}/restore`, { token: admin, body: {} })).json.errors.branch[0], /not archived/);
});
