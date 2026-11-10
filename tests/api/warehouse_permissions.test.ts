// Warehouse Inventory permissions: Add Product for Admin and Logistics; Import CSV, Export CSV
// and Delete for Logistics only. Delete archives the product, and is refused while the product
// is still on an open supply request or in an active product recipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, MARKETING, SALES, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const [category] = await q(`select id from product_categories where brand_id = $1 limit 1`, [brand.id]);
const product = (name: string) => ({ name, brand_id: brand.id, category_id: category.id, unit: 'bottle', reorder_level: 10, critical_level: 2 });
const summary = async () => (await call('GET', `/inventories/grouped?brand_id=${brand.id}`, { token: logistics })).json.data.summary;

test('Add Product: Admin and Logistics may add, every other role gets 403', async () => {
  const byAdmin = await call('POST', '/inventories/items', { token: admin, body: product('Perm Admin Syrup') });
  assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.json));
  const byLogistics = await call('POST', '/inventories/items', { token: logistics, body: { ...product('Perm Logistics Syrup'), opening_quantity: 30 } });
  assert.equal(byLogistics.status, 201, JSON.stringify(byLogistics.json));
  for (const token of [sales, marketing]) assert.equal((await call('POST', '/inventories/items', { token, body: product('Perm Nope') })).status, 403);
});

test('Import CSV and Export CSV: Logistics only; Admin gets 403 even calling the URL directly', async () => {
  const csv = 'brand,sku,product_name,category,unit,quantity\r\n';
  const body = { brand_id: brand.id, mode: 'set', csv };
  for (const token of [admin, sales, marketing]) {
    assert.equal((await call('GET', `/warehouse/export?brand_id=${brand.id}`, { token })).status, 403, 'export');
    assert.equal((await call('GET', `/warehouse/import-template?brand_id=${brand.id}`, { token })).status, 403, 'template');
    assert.equal((await call('POST', '/warehouse/import/preview', { token, body })).status, 403, 'preview');
    assert.equal((await call('POST', '/warehouse/import/apply', { token, body })).status, 403, 'apply');
  }
  assert.equal((await call('GET', `/warehouse/export?brand_id=${brand.id}`, { token: logistics })).status, 200);
  assert.equal((await call('GET', `/warehouse/import-template?brand_id=${brand.id}`, { token: logistics })).status, 200);
});

test('Delete: Logistics only; the row leaves the list and the stats update', async () => {
  const created = await call('POST', '/inventories/items', { token: logistics, body: { ...product('Perm Delete Me'), opening_quantity: 7 } });
  const id = created.json.data.id;
  for (const token of [admin, sales, marketing]) {
    assert.equal((await call('DELETE', '/inventories/items', { token, body: { inventory_ids: [id] } })).status, 403);
  }
  const before = await summary();
  const deleted = await call('DELETE', '/inventories/items', { token: logistics, body: { inventory_ids: [id] } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.message, 'Product archived.');
  const after = await summary();
  assert.equal(after.total_items, before.total_items - 1, 'Total Items drops by one');
  assert.equal(Number(after.total_units), Number(before.total_units) - 7, 'Total Units drops by its quantity');
  const list = (await call('GET', `/inventories/grouped?brand_id=${brand.id}`, { token: logistics })).json.data.groups.flatMap((g: any) => g.items);
  assert.ok(!list.some((i: any) => i.id === id), 'the row is gone from the list');
  const [row] = await q(`select p.is_active, p.archived_at is not null as archived from inventories i join products p on p.id = i.product_id where i.id = $1`, [id]);
  assert.deepEqual(row, { is_active: false, archived: true }, 'soft delete: the product is archived, history keeps it');
});

test('Delete is refused while the product is used in an active product recipe', async () => {
  const created = await call('POST', '/inventories/items', { token: logistics, body: product('Perm Recipe Milk') });
  const { id, product_id: productId } = created.json.data;
  const recipe = await call('POST', '/brand-products', { token: admin, body: { brand_id: brand.id, name: 'Perm Latte', is_active: true, ingredients: [{ product_id: productId, batch_amount: 1, yield_pieces: 4 }] } });
  assert.equal(recipe.status, 201, JSON.stringify(recipe.json));
  const refused = await call('DELETE', '/inventories/items', { token: logistics, body: { inventory_ids: [id] } });
  assert.equal(refused.status, 422);
  assert.match(refused.json.errors.inventory_ids[0], /used in an active product recipe: Perm Recipe Milk \(in Perm Latte\)/);
  assert.equal((await q(`select is_active from products where id = $1`, [productId]))[0].is_active, true, 'nothing archived');
});

test('List: date range by stock activity or by date added, and server-side sort', async () => {
  const names = ['Range Old Quiet', 'Range Old Moved', 'Range New'];
  const ids: Record<string, any> = {};
  for (const [n, qty] of [[names[0], 5], [names[1], 50], [names[2], 1]] as const) {
    const res = await call('POST', '/inventories/items', { token: logistics, body: { ...product(n), opening_quantity: qty } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    ids[n] = res.json.data;
  }
  // The two "Old" products were added 60 days ago; "Old Quiet" has not moved since, "Old Moved" moved 3 days ago.
  for (const n of [names[0], names[1]]) {
    await q(`update products set created_at = now() - interval '60 days' where id = $1`, [ids[n].product_id]);
    await q(`update inventory_transactions set transaction_date = now() - interval '60 days' where inventory_id = $1`, [ids[n].id]);
  }
  await q(`update inventory_transactions set transaction_date = now() - interval '3 days' where inventory_id = $1`, [ids[names[1]].id]);

  const list = async (params: string) => {
    const res = await call('GET', `/inventories/grouped?brand_id=${brand.id}&search=Range&per_page=50&${params}`, { token: logistics });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.data.items.map((i: any) => i.name);
  };
  assert.deepEqual((await list('')).sort(), [...names].sort(), 'All time shows everything');
  assert.deepEqual((await list('period=7d&period_basis=activity')).sort(), ['Range New', 'Range Old Moved'], 'activity in the last 7 days');
  assert.deepEqual(await list('period=30d&period_basis=added'), ['Range New'], 'added in the last 30 days');
  assert.deepEqual((await list('period=90d&period_basis=added')).sort(), [...names].sort(), 'added in the last 90 days');
  assert.deepEqual(await list('period=today&period_basis=activity'), ['Range New'], 'activity today');

  assert.deepEqual(await list('sort=item'), ['Range New', 'Range Old Moved', 'Range Old Quiet']);
  assert.deepEqual(await list('sort=quantity_desc'), ['Range Old Moved', 'Range Old Quiet', 'Range New']);
  assert.deepEqual(await list('sort=quantity_asc'), ['Range New', 'Range Old Quiet', 'Range Old Moved']);
  assert.equal((await list('sort=newest'))[0], 'Range New', 'newest product first');
  assert.equal((await list('sort=recent'))[0], 'Range New', 'most recent activity first');
  assert.equal((await list('sort=status'))[0], 'Range New', 'critical first (1 unit, critical level 2)');
  const item = (await call('GET', `/inventories/grouped?brand_id=${brand.id}&search=Range Old Moved`, { token: logistics })).json.data.items[0];
  assert.ok(item.last_activity_at && item.added_at, 'last activity and date added are returned for the optional columns');

  for (const bad of ['period=yesterday', 'period_basis=other&period=7d', 'sort=random']) {
    assert.equal((await call('GET', `/inventories/grouped?brand_id=${brand.id}&${bad}`, { token: logistics })).status, 422, bad);
  }
  const summaryAll = await summary();
  const filtered = (await call('GET', `/inventories/grouped?brand_id=${brand.id}&period=today&period_basis=activity`, { token: logistics })).json.data.summary;
  assert.deepEqual(filtered, summaryAll, 'the stats always describe the whole brand');
});
