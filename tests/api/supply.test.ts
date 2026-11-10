// Warehouse stock, CSV import, brand products and the supply workflow through to branch stock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, SALES, setup } from '../support/harness.ts';

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

let requestId: number;

test('supply: role scoping, stock gate and the full workflow', async () => {
  const body = { location_id: branch.locationId, delivery_address: 'Branch street', items: [{ product_id: productId, quantity_requested: 30 }] };
  assert.equal((await call('POST', '/supply-requests', { token: sales, body })).status, 403);
  assert.match((await call('POST', '/supply-requests', { token: branch.token, body: { ...body, items: [{ product_id: productId, quantity_requested: 1 }, { product_id: productId, quantity_requested: 2 }] } })).json.errors['items.1.product_id'][0], /duplicate/);
  const created = await call('POST', '/supply-requests', { token: branch.token, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  requestId = created.json.data.id;
  const path = `/supply-requests/${requestId}`;
  assert.match(created.json.data.request_number, /^FT-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(created.json.data.status, 'submitted');

  assert.equal((await call('GET', path, { token: logistics })).status, 404, 'Logistics sees it only after review');
  assert.equal((await call('POST', `${path}/review`, { token: admin })).json.data.status, 'under_review');
  const detail = await call('GET', path, { token: admin });
  assert.equal(detail.json.data.can_endorse, true);
  assert.equal(detail.json.data.line_groups[0].lines[0].warehouse_stock, 120);

  // Date revision blocks endorsing until Logistics confirms, and shows in the effective date.
  const revised = await call('POST', `${path}/date-revision`, { token: admin, body: { revised_delivery_date: '2999-01-15' } });
  assert.equal(revised.status, 201, JSON.stringify(revised.json));
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'endorsed' } })).json.errors.status[0], /Waiting for Logistics/);
  const list = await call('GET', '/supply-requests?view=active', { token: admin });
  assert.equal(list.json.data.find((r: any) => r.id === requestId).endorse_block_reason, 'Waiting for Logistics to confirm the new delivery date');
  const confirmed = await call('POST', `${path}/date-revision/confirm`, { token: logistics, body: {} });
  assert.equal(confirmed.json.data.status, 'endorsed');
  assert.equal(confirmed.json.data.effective_delivery_date, '2999-01-15');

  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'preparing' } })).status, 403);
  const preparing = await call('PATCH', `${path}/status`, { token: logistics, body: { status: 'preparing' } });
  assert.equal(preparing.json.data.status, 'preparing');
  assert.equal((await q(`select current_stock from inventories where id = $1`, [inventoryId]))[0].current_stock, '90.00', 'deducted on Preparing');
  const snapshot = (await call('GET', path, { token: admin })).json.data.stock_snapshot;
  assert.deepEqual([snapshot[0].stock_before, snapshot[0].deducted, snapshot[0].stock_after], [120, 30, 90]);

  assert.equal((await call('PATCH', `${path}/status`, { token: logistics, body: { status: 'dispatched' } })).status, 200);
  assert.equal((await q(`select current_stock from inventories where id = $1`, [inventoryId]))[0].current_stock, '90.00', 'never deducted twice');
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'cancelled', remarks: 'x' } })).json.errors.status[0], /already dispatched/);

  // Proof of delivery, then the branch confirms receipt and its stock arrives once.
  const pod = new FormData();
  pod.set('file', new File(['pod'], 'pod.pdf', { type: 'application/pdf' }));
  const uploaded = await call('POST', `${path}/pod`, { token: logistics, form: pod });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));
  assert.equal(uploaded.json.data.type, 'proof_of_delivery');
  assert.ok(files.store.size >= 1);
  assert.equal((await call('GET', `${path}/documents/${uploaded.json.data.id}/download`, { token: branch.token })).status, 200);

  const ack = await call('POST', `${path}/acknowledge`, { token: branch.token, body: { recipient_name: 'Branch Owner' } });
  assert.equal(ack.status, 200, JSON.stringify(ack.json));
  assert.equal(ack.json.data.recipient_name, 'Branch Owner');
  const [material] = await q(`select m.*, b.quantity_milli, b.value_cents from profittrack_materials m join profittrack_material_balances b on b.material_id = m.id where m.location_id = $1`, [branch.locationId]);
  assert.equal(material.quantity_milli, 30000, 'thirty units in milli-units');
  assert.equal(material.warehouse_product_id, productId);
  assert.equal(material.unit, 'bottle');
  const again = await call('POST', `${path}/acknowledge`, { token: branch.token, body: { recipient_name: 'Branch Owner' } });
  assert.match(again.json.message, /already confirmed/);
  assert.equal((await q(`select quantity_milli from profittrack_material_balances where material_id = $1`, [material.id]))[0].quantity_milli, 30000, 'idempotent');
  assert.equal((await q(`select current_stock from inventories where location_id = $1 and product_id = $2`, [branch.locationId, productId]))[0].current_stock, '30.00', 'branch inventory mirrors the ledger');
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'completed' } })).json.data.status, 'completed');

  const stats = await call('GET', '/supply-requests/stats', { token: admin });
  assert.equal(stats.json.data.by_status.completed, 1);
  const pipeline = await call('GET', '/supply-requests/pipeline', { token: logistics });
  assert.equal(pipeline.json.data.stages.length, 6);
  assert.equal(pipeline.json.data.rows[0].id, created.json.data.request_number);
  assert.equal((await call('GET', '/supply-requests', { token: branch.token })).json.data.length, 1);
});

test('supply: short stock blocks endorsing, and cancelling after Preparing restores stock', async () => {
  const big = await call('POST', '/supply-requests', { token: branch.token, body: { location_id: branch.locationId, delivery_address: 'x', items: [{ product_id: productId, quantity_requested: 5000 }] } });
  const path = `/supply-requests/${big.json.data.id}`;
  await call('POST', `${path}/review`, { token: admin });
  assert.equal((await call('GET', path, { token: admin })).json.data.endorse_block_reason, 'insufficient stock');
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'endorsed' } })).json.errors.inventory[0], /insufficient/);
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'rejected' } })).json.errors.remarks[0], /reason is required/);
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'rejected', remarks: 'Too much' } })).json.data.status, 'rejected');

  const small = await call('POST', '/supply-requests', { token: branch.token, body: { location_id: branch.locationId, delivery_address: 'x', items: [{ product_id: productId, quantity_requested: 10 }] } });
  const p2 = `/supply-requests/${small.json.data.id}`;
  await call('POST', `${p2}/review`, { token: admin });
  await call('PATCH', `${p2}/status`, { token: admin, body: { status: 'endorsed' } });
  await call('PATCH', `${p2}/status`, { token: logistics, body: { status: 'preparing' } });
  assert.equal((await q(`select current_stock from inventories where id = $1`, [inventoryId]))[0].current_stock, '80.00');
  const whileOpen = await call('DELETE', '/inventories/items', { token: logistics, body: { inventory_ids: [inventoryId] } });
  assert.match(whileOpen.json.errors.inventory_ids[0], /still on an open supply request/, 'blocked while the request is open');
  assert.equal((await call('PATCH', `${p2}/status`, { token: admin, body: { status: 'cancelled', remarks: 'Changed mind' } })).status, 200);
  assert.equal((await q(`select current_stock from inventories where id = $1`, [inventoryId]))[0].current_stock, '90.00');

  // A product on an open request cannot be archived; a closed one can.
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
