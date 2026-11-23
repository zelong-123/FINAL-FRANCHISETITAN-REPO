// Archiving a branch product: it leaves the branch list and Production, the server blocks
// producing it, nothing is deleted, and unarchiving puts it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, setup } from '../support/harness.ts';

const { pg, call, login, auth } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
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
const branch = await branchAccount('archive.one@test.local', 'Archive One');
const w = '/branch/workspace';

/** A published brand product with one ingredient, plus the stock item it uses. */
async function makeProduct(name: string) {
  const [stockItem] = await q(`insert into products (brand_id, sku, name, unit) values ($1, $2, $3, 'kg') returning id`, [brand.id, name.toUpperCase().replace(/[^A-Z]/g, ''), `${name} Mix`]);
  const created = await call('POST', '/brand-products', {
    token: admin,
    body: { brand_id: brand.id, name, is_active: true, ingredients: [{ product_id: stockItem.id, batch_amount: 1, yield_pieces: 10 }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return { productId: created.json.data.id as number, stockItemId: stockItem.id as number };
}

test('archiving hides the product from the branch and Production, and unarchive restores it', async () => {
  const { productId, stockItemId } = await makeProduct('Archived Latte');
  const list = () => call('GET', `${w}/products`, { token: branch.token });
  const archivedList = () => call('GET', `${w}/products?archived=1`, { token: branch.token });
  const ids = (res: any) => res.json.data.products.map((p: any) => p.id as number);

  assert.ok(ids(await list()).includes(productId), 'a published product is in the branch list');
  assert.ok(!ids(await archivedList()).includes(productId));

  // Only the branch owner archives; Admin and Logistics stay read-only.
  assert.equal((await call('POST', `${w}/products/${productId}/archive`, { token: logistics })).status, 403);
  assert.equal((await call('POST', `${w}/products/${productId}/archive`, { token: admin })).status, 403);

  // Produce once so there is history to protect.
  const [material] = await q(`insert into profittrack_materials (location_id, name, unit, warehouse_product_id, source) values ($1, 'Archived Mix', 'kg', $2, 'Warehouse') returning id`, [branch.id, stockItemId]);
  await q(`insert into profittrack_material_balances (location_id, material_id, quantity_milli) values ($1, $2, 5000)`, [branch.id, material.id]);
  const before = await call('POST', `${w}/produce-product`, { token: branch.token, body: { idempotency_key: 'arch-before', items: [{ brand_product_id: productId, quantity_pieces: 10 }] } });
  assert.equal(before.status, 201, JSON.stringify(before.json));

  const archived = await call('POST', `${w}/products/${productId}/archive`, { token: branch.token });
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  assert.equal(archived.json.data.is_active, false);
  assert.ok(!ids(await list()).includes(productId), 'it leaves the Active tab');
  assert.ok(ids(await archivedList()).includes(productId), 'it appears in the Archived tab');

  // Admin's product list follows the same flag, so it is not silently produced elsewhere.
  const adminList = await call('GET', '/brand-products?per_page=100', { token: admin });
  assert.ok(!adminList.json.data.some((p: any) => p.id === productId));

  // Production is blocked on the server, not just hidden in the dropdown.
  const blocked = await call('POST', `${w}/produce-product`, { token: branch.token, body: { idempotency_key: 'arch-blocked', items: [{ brand_product_id: productId, quantity_pieces: 10 }] } });
  assert.equal(blocked.status, 422);
  assert.match(blocked.json.errors.items[0], /not published/);

  // The batch made before the archive is still there.
  const [history] = await q(`select count(*)::int as n from profittrack_production_batches b join profittrack_recipes r on r.id = b.recipe_id where r.brand_product_id = $1`, [productId]);
  assert.equal(history.n, 1);

  const restored = await call('POST', `${w}/products/${productId}/unarchive`, { token: branch.token });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.data.is_active, true);
  assert.ok(ids(await list()).includes(productId), 'it comes back to the Production dropdown');
  const after = await call('POST', `${w}/produce-product`, { token: branch.token, body: { idempotency_key: 'arch-after', items: [{ brand_product_id: productId, quantity_pieces: 10 }] } });
  assert.equal(after.status, 201, JSON.stringify(after.json));
});

test('a product without a recipe cannot come back, and another branch cannot archive it', async () => {
  const created = await call('POST', '/brand-products', { token: admin, body: { brand_id: brand.id, name: 'Draft Product', is_active: false } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const draft = await call('POST', `${w}/products/${created.json.data.id}/unarchive`, { token: branch.token });
  assert.equal(draft.status, 422);
  assert.match(draft.json.errors.product[0], /recipe ingredient/);

  const [otherBrand] = await q(`insert into brands (name, code) values ('Archive Other Brand', 'ARCH-OTHER') returning id`);
  const [foreignStock] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'FOREIGN', 'Foreign Mix', 'kg') returning id`, [otherBrand.id]);
  const foreign = await call('POST', '/brand-products', {
    token: admin,
    body: { brand_id: otherBrand.id, name: 'Foreign Product', is_active: true, ingredients: [{ product_id: foreignStock.id, batch_amount: 1, yield_pieces: 10 }] },
  });
  assert.equal(foreign.status, 201, JSON.stringify(foreign.json));
  assert.equal((await call('POST', `${w}/products/${foreign.json.data.id}/archive`, { token: branch.token })).status, 404);
  assert.equal((await call('POST', `${w}/products/999999/archive`, { token: branch.token })).status, 404);
});
