// supabase/seed/replaceProducts.ts: the catalogue becomes exactly products.csv, in one transaction,
// and running it again changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from '../support/harness.ts';
import { CRITICAL_STOCK, LOW_STOCK, parseCsv, perServing, replaceProducts } from '../../supabase/seed/replaceProducts.ts';

const csv = readFileSync(new URL('../../supabase/seed/products.csv', import.meta.url), 'utf8');
const { pg, db } = await setup();
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];

test('the CSV is read as 257 lines, 33 products and 95 raw materials', () => {
  const rows = parseCsv(csv);
  assert.equal(rows.length, 257);
  assert.equal(new Set(rows.map((r) => `${r.brand}|${r.product}`)).size, 33);
  assert.equal(new Set(rows.map((r) => `${r.brand}|${r.material.toLowerCase()}`)).size, 95);
  assert.equal(perServing({ brand: 'Kkopi', type: 'Iced Latte', product: 'x', material: 'Espresso Beans', category: 'Coffee Beans / Coffee Base', unit: 'kg' }), 0.018);
  assert.equal(perServing({ brand: 'La Pasta', type: 'Familia Platters', product: 'x', material: 'Spaghetti Noodles', category: 'Pasta / Noodles', unit: 'kg' }), 0.6, 'a platter is four servings');
  assert.equal(perServing({ brand: 'Godo', type: 'Shakes', product: 'x', material: 'Dome Lid', category: 'Packaging', unit: 'pcs' }), 1);
});

test('old products go with their dependents; the CSV catalogue arrives complete', async () => {
  const [brand] = await q(`select id from brands order by id limit 1`);
  const [old] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'OLD-1', 'Old Syrup', 'L') returning id`, [brand.id]);
  const [wh] = await q(`select id from franchise_locations where type = 'warehouse' limit 1`);
  await q(`insert into inventories (location_id, product_id, current_stock) values ($1, $2, 5)`, [wh.id, old.id]);
  const before = await q(`select (select count(*)::int from users) as users, (select count(*)::int from franchise_locations) as locations, (select count(*)::int from brands) as brands, (select count(*)::int from units) as units`);

  const report = await replaceProducts(db, csv);
  assert.equal(report.added.products, 33);
  assert.equal(report.added.raw_materials, 95);
  assert.equal(report.added.ingredients, 257);
  assert.equal((await q(`select count(*)::int as n from products where id = $1`, [old.id]))[0].n, 0, 'the old product is gone');

  const perBrand = Object.fromEntries((await q(`select b.name, (select count(*)::int from brand_products bp where bp.brand_id = b.id) as n from brands b`)).map((r) => [r.name.toLowerCase().replace(/\s/g, ''), r.n]));
  assert.deepEqual([perBrand.kkopi, perBrand.dailydash, perBrand.godo, perBrand.lapasta], [17, 5, 6, 5]);
  assert.equal((await q(`select count(*)::int as n from products`))[0].n, 95);
  assert.equal((await q(`select count(*)::int as n from brand_products bp where not exists (select 1 from brand_product_ingredients i where i.brand_product_id = bp.id)`))[0].n, 0, 'every product has a recipe');
  assert.equal((await q(`select count(*)::int as n from brand_products where image_path is not null`))[0].n, 0, 'images are left for the owner to add');
  // Every ingredient used by a product is a warehouse item: it has a stock row in the Central
  // Warehouse, is active, and is listed on the Warehouse Inventory page for its brand.
  assert.equal((await q(`select count(*)::int as n from brand_product_ingredients bi
    where not exists (select 1 from inventories i join products p on p.id = i.product_id
      where i.product_id = bi.product_id and i.location_id = $1 and p.is_active and p.archived_at is null and p.brand_id = bi.brand_id)`, [wh.id]))[0].n, 0, 'every ingredient is in Warehouse Inventory');
  assert.equal((await q(`select count(distinct bi.product_id)::int as n from brand_product_ingredients bi`))[0].n, 95, 'all 95 raw materials are used by at least one product');
  for (const b of await q(`select id from brands`)) {
    const page = await pg.query(`select count(*)::int as n from inventories i join products p on p.id = i.product_id where i.location_id = $1 and p.brand_id = $2 and p.is_active and p.archived_at is null`, [wh.id, b.id]);
    const used = await pg.query(`select count(distinct product_id)::int as n from brand_product_ingredients where brand_id = $1`, [b.id]);
    assert.equal((page.rows[0] as any).n, (used.rows[0] as any).n, 'the warehouse list of each brand holds exactly the raw materials its products use');
  }
  assert.equal((await q(`select description from brand_products where name = 'Signature Cheesu'`))[0].description, 'Iced Latte', 'Product Type is the description');

  const status = await q(`select case when current_stock <= critical_level then 'critical' when current_stock <= reorder_level then 'low' else 'normal' end as s, count(*)::int as n
    from inventories where location_id = $1 group by 1`, [wh.id]);
  const counts = Object.fromEntries(status.map((r) => [r.s, r.n]));
  assert.deepEqual([counts.critical, counts.low], [CRITICAL_STOCK.length, LOW_STOCK.length]);
  assert.equal((await q(`select count(*)::int as n from inventory_transactions where type = 'opening'`))[0].n, 95, 'opening stock goes through the stock ledger');
  assert.equal((await q(`select count(*)::int as n from inventories i where i.current_stock <> (select t.balance_after from inventory_transactions t where t.inventory_id = i.id order by t.id desc limit 1)`))[0].n, 0);

  for (const [table, column] of [['products', 'name'], ['brand_products', 'name'], ['brand_products', 'description'], ['product_categories', 'name']]) {
    assert.equal((await q(`select count(*)::int as n from ${table} where ${column} ~* '\\m(demo|sample|test|dummy|placeholder)\\M'`))[0].n, 0, `${table}.${column} is clean`);
  }
  const after = await q(`select (select count(*)::int from users) as users, (select count(*)::int from franchise_locations) as locations, (select count(*)::int from brands) as brands, (select count(*)::int from units) as units`);
  assert.deepEqual(after, before, 'users, branches, brands and units are untouched');
});

test('running it again changes nothing', async () => {
  const stockBefore = await q(`select id, current_stock from inventories order by id`);
  const report = await replaceProducts(db, csv);
  assert.deepEqual(report.added, { categories: [], raw_materials: 0, products: 0, ingredients: 0 });
  assert.ok(Object.values(report.removed).every((n) => n === 0));
  assert.deepEqual(await q(`select id, current_stock from inventories order by id`), stockBefore);
});

test('an error part-way rolls everything back', async () => {
  // A new category is written first, then the unknown unit fails: the category must not survive.
  const products = (await q(`select count(*)::int as n from products`))[0].n;
  const broken = `${csv.trim()}\nKkopi,Seasonal,Seasonal Drink,Seasonal Base,Seasonal Extras,bucket`;
  await assert.rejects(replaceProducts(db, broken), /Unit "bucket" is not in the unit list/);
  assert.equal((await q(`select count(*)::int as n from product_categories where name = 'Seasonal Extras'`))[0].n, 0, 'the new category was rolled back');
  assert.equal((await q(`select count(*)::int as n from products`))[0].n, products, 'nothing was half-written');
  await assert.rejects(replaceProducts(db, csv.replace('Kkopi,Iced Latte,Signature Cheesu,Espresso Beans', 'Unknown Brand,Iced Latte,Signature Cheesu,Espresso Beans')), /Brand "Unknown Brand" does not exist/);
});
