// Replaces the product catalogue with supabase/seed/products.csv.
//
// The CSV lists, per brand, every menu product (brand_products), its Product Type and the raw
// materials it uses (products = warehouse products, with stock in `inventories`). This module:
//   1. removes every warehouse product and menu product that is NOT in the CSV, with the records
//      that depend on them (recipes, branch ProfitTrack materials and recipes, stock movements,
//      supply requests that carry them, warehouse logs);
//   2. adds the categories the CSV needs (per brand; existing ones are reused by name);
//   3. adds each (brand + raw material) once as a warehouse product, with its opening stock written
//      through the system's own stock functions (adjustStock + stockAudit, as Add Product does);
//   4. adds each menu product with its Product Type as description and its recipe.
// Everything runs in ONE transaction: any error rolls all of it back. Running it again changes
// nothing that is already in place (CSV items that exist are kept as they are).
import type { Db, Row } from '../functions/api/lib/db.ts';
import { insertRow } from '../functions/api/lib/http.ts';
import { adjustStock, stockAudit } from '../functions/api/services/inventory.ts';
import { nextBrandProductSku } from '../functions/api/services/branchStock.ts';

export interface CsvRow { brand: string; type: string; product: string; material: string; category: string; unit: string }

export function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = lines.shift()!.split(',').map((h) => h.trim().toLowerCase());
  const expected = ['brand', 'product type', 'product', 'raw material', 'category', 'suggested unit'];
  if (expected.some((name, i) => header[i] !== name)) throw new Error(`Unexpected CSV header: ${header.join(', ')}`);
  return lines.filter((l) => l.trim()).map((line, i) => {
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== 6 || cells.some((c) => !c)) throw new Error(`CSV line ${i + 2} must have 6 filled columns.`);
    const [brand, type, product, material, category, unit] = cells;
    return { brand, type, product, material, category, unit };
  });
}

const key = (s: string) => s.trim().replace(/\s+/gu, ' ').toLowerCase();
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---- Quantity per serving, in the raw material's own unit (kg, L or pcs) ----
const BY_NAME: Record<string, number> = {
  'espresso beans': 0.018, ice: 0.2, 'fresh milk': 0.15, 'whipping cream': 0.03, 'cold foam cream': 0.03, 'all-purpose cream': 0.1,
  'condensed milk': 0.03, 'non-dairy creamer': 0.025, 'cream cheese': 0.03, 'parmesan cheese': 0.015,
  'strawberry puree / jam': 0.04, 'mango puree': 0.08, 'avocado pulp': 0.1, 'lemon / calamansi': 0.03,
  'matcha powder': 0.01, 'soft serve mix (vanilla)': 0.06, 'cheese foam powder': 0.02, 'ube powder': 0.025,
  'cookies & cream powder': 0.03, 'dark chocolate powder': 0.02, 'frappe base powder': 0.03,
  'tapioca pearls': 0.05, 'nata de coco / fruit jelly': 0.04, 'crushed chocolate cookies': 0.015, 'graham crumbs': 0.015, 'fried garlic toppings': 0.01,
  'ground beef': 0.06, hotdog: 0.04, 'bacon bits': 0.03, garlic: 0.005, onion: 0.02,
  'truffle oil': 0.005, 'olive oil': 0.01, 'cooking oil': 0.01, 'pesto sauce': 0.06,
};
const BY_CATEGORY: Record<string, number> = {
  'syrup / flavoring': 0.03, sweeteners: 0.02, 'powder / mixes': 0.025, 'tea base': 0.01, toppings: 0.02, 'pasta / noodles': 0.15,
  'sauces / condiments': 0.12, 'meat / protein': 0.06, 'vegetables / produce': 0.01, 'spices / seasonings': 0.001, 'oils / fats': 0.01,
  'dairy / creamers': 0.03, fruits: 0.05, 'frappe ingredients': 0.03, 'coffee beans / coffee base': 0.018, 'other ingredients': 0.05,
};
/** Familia Platters are family size: four servings in one order. */
const SERVINGS_BY_TYPE: Record<string, number> = { 'familia platters': 4 };

export function perServing(row: CsvRow): number {
  if (key(row.unit) === 'pcs') return 1;
  const base = BY_NAME[key(row.material)] ?? BY_CATEGORY[key(row.category)] ?? 0.02;
  return round3(base * (SERVINGS_BY_TYPE[key(row.type)] ?? 1));
}

// ---- Opening stock and levels: most items healthy, a few Low Stock, two Critical ----
const LEVELS: Record<string, { reorder: number; critical: number; healthy: number[]; low: number; criticalStock: number }> = {
  kg: { reorder: 10, critical: 4, healthy: [25, 30, 35, 40, 45, 50, 60], low: 7, criticalStock: 3 },
  l: { reorder: 8, critical: 3, healthy: [15, 20, 24, 30, 36, 42, 50], low: 5, criticalStock: 2 },
  pcs: { reorder: 500, critical: 150, healthy: [1500, 2000, 2500, 3000, 3600, 4200, 5000], low: 320, criticalStock: 100 },
};
export const LOW_STOCK = ['kkopi|matcha powder', 'kkopi|okinawa syrup', 'daily dash|pistachio sauce', 'godo|avocado pulp', 'la pasta|parmesan cheese', 'godo|soft serve cup'];
export const CRITICAL_STOCK = ['kkopi|tapioca pearls', 'la pasta|truffle oil'];
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

export function stockPlan(brand: string, material: string, unit: string) {
  const id = `${key(brand)}|${key(material)}`;
  if (id.endsWith('|ice')) return { stock: 180, reorder: 50, critical: 20 };
  const l = LEVELS[key(unit)] ?? LEVELS.pcs;
  const stock = CRITICAL_STOCK.includes(id) ? l.criticalStock : LOW_STOCK.includes(id) ? l.low : l.healthy[hash(id) % l.healthy.length];
  return { stock, reorder: l.reorder, critical: l.critical };
}

/** Same SKU shape as Add Product (BRAND-CAT-NNNN), numbered instead of random so a rerun is stable. */
async function warehouseSku(db: Db, brandCode: string, categoryName: string): Promise<string> {
  const code = (String(brandCode || 'WH').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)) || 'WH';
  const words = String(categoryName).toUpperCase().split(/[^A-Za-z]+/);
  const present = words.filter(Boolean);
  const cat = (words.length > 1 ? present.slice(0, 2).map((w) => w.slice(0, 2)).join('') : (words[0] ?? 'GEN').slice(0, 3)).slice(0, 4) || 'GEN';
  for (let n = 1; ; n++) {
    const sku = `${code}-${cat}-${String(n).padStart(4, '0')}`;
    if (!(await db.query(`select 1 from products where sku = $1`, [sku])).length) return sku;
  }
}

const ids = (rows: Row[], field = 'id') => `{${rows.map((r) => r[field]).join(',')}}`;

export interface Report {
  removed: Record<string, number>;
  added: { categories: string[]; raw_materials: number; products: number; ingredients: number };
  kept: { raw_materials: number; products: number };
  products_per_brand: Record<string, number>;
  raw_materials_per_brand: Record<string, number>;
}

export async function replaceProducts(db: Db, csvText: string): Promise<Report> {
  const rows = parseCsv(csvText);
  return db.tx(async (tx) => {
    const report: Report = { removed: {}, added: { categories: [], raw_materials: 0, products: 0, ingredients: 0 }, kept: { raw_materials: 0, products: 0 }, products_per_brand: {}, raw_materials_per_brand: {} };
    const count = async (label: string, sql: string, params: unknown[] = []) => {
      const result = await tx.query(`with gone as (${sql} returning 1) select count(*)::int as n from gone`, params);
      report.removed[label] = (report.removed[label] ?? 0) + result[0].n;
    };

    // ---- Who records it: Logistics owns stock quantities, Admin owns the menu ----
    const actor = async (roleName: string) => {
      const [u] = await tx.query(`select u.*, to_jsonb(r) as role from users u join roles r on r.id = u.role_id where r.name = $1 and u.account_status = 'active' order by u.id limit 1`, [roleName]);
      if (!u) throw new Error(`An active ${roleName} account is required to record the catalogue.`);
      return u;
    };
    const logistics = await actor('logistics');
    const admin = await actor('admin');
    const [warehouse] = await tx.query(`select * from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
    if (!warehouse) throw new Error('No active warehouse location is configured.');

    // ---- Brands (existing only, matched by name without spaces/case: "Godo" = "GoDo") ----
    const brandRows = await tx.query(`select id, name, code from brands`);
    const squash = (s: string) => key(s).replace(/[^a-z0-9]/g, '');
    const brandOf = new Map<string, Row>();
    for (const r of rows) {
      const brand = brandRows.find((b) => squash(b.name) === squash(r.brand));
      if (!brand) throw new Error(`Brand "${r.brand}" does not exist. Add it first; this script does not create brands.`);
      brandOf.set(key(r.brand), brand);
    }

    // ---- What the CSV keeps ----
    const materials = new Map<string, CsvRow>(); // brandId|material
    const products = new Map<string, { brand: Row; name: string; type: string; lines: CsvRow[] }>();
    for (const r of rows) {
      const brand = brandOf.get(key(r.brand))!;
      const mKey = `${brand.id}|${key(r.material)}`;
      const prior = materials.get(mKey);
      if (prior && (key(prior.category) !== key(r.category) || key(prior.unit) !== key(r.unit))) {
        throw new Error(`"${r.material}" (${r.brand}) has two different categories or units in the CSV.`);
      }
      materials.set(mKey, prior ?? r);
      const pKey = `${brand.id}|${key(r.product)}`;
      const p = products.get(pKey) ?? { brand, name: r.product, type: r.type, lines: [] };
      if (key(p.type) !== key(r.type)) throw new Error(`"${r.product}" (${r.brand}) has two Product Types in the CSV.`);
      p.lines.push(r);
      products.set(pKey, p);
    }

    // ---- 1. Remove what is not in the CSV ----
    const allProducts = await tx.query(`select id, brand_id, name from products`);
    const doomedProducts = allProducts.filter((p) => !materials.has(`${p.brand_id}|${key(p.name)}`));
    const allMenu = await tx.query(`select id, brand_id, name from brand_products`);
    const doomedMenu = allMenu.filter((p) => !products.has(`${p.brand_id}|${key(p.name)}`));
    const P = ids(doomedProducts);
    const B = ids(doomedMenu);

    // Branch ProfitTrack data built on the removed items (the branches themselves stay).
    const M = ids(await tx.query(`select id from profittrack_materials where warehouse_product_id = any($1::bigint[])`, [P]));
    const R = ids(await tx.query(`select id from profittrack_recipes where brand_product_id = any($1::bigint[])`, [B]));
    const V = ids(await tx.query(`select id from profittrack_recipe_versions where recipe_id = any($1::bigint[])`, [R]));
    const batches = ids(await tx.query(`select id from profittrack_production_batches where recipe_id = any($1::bigint[]) or id in (select batch_id from profittrack_production_consumptions where material_id = any($2::bigint[]))`, [R, M]));
    const ops = ids(await tx.query(
      `select operation_id as id from profittrack_production_batches where id = any($1::bigint[]) and operation_id is not null
       union select operation_id from profittrack_material_movements where material_id = any($2::bigint[]) and operation_id is not null
       union select operation_id from profittrack_counts where material_id = any($2::bigint[]) and operation_id is not null`, [batches, M]));
    await count('branch production consumptions', `delete from profittrack_production_consumptions where batch_id = any($1::bigint[]) or material_id = any($2::bigint[])`, [batches, M]);
    await count('branch production batches', `delete from profittrack_production_batches where id = any($1::bigint[])`, [batches]);
    await count('branch sale lines', `delete from profittrack_sale_items where recipe_id = any($1::bigint[])`, [R]);
    await count('branch finished-goods balances', `delete from profittrack_finished_balances where recipe_id = any($1::bigint[])`, [R]);
    await count('branch recipe ingredients', `delete from profittrack_recipe_ingredients where recipe_version_id = any($1::bigint[]) or material_id = any($2::bigint[])`, [V, M]);
    await count('branch recipe versions', `delete from profittrack_recipe_versions where id = any($1::bigint[])`, [V]);
    await count('branch recipes', `delete from profittrack_recipes where id = any($1::bigint[])`, [R]);
    await count('branch stock counts', `delete from profittrack_counts where material_id = any($1::bigint[])`, [M]);
    await count('branch stock movements', `delete from profittrack_material_movements where material_id = any($1::bigint[])`, [M]);
    await count('branch stock balances', `delete from profittrack_material_balances where material_id = any($1::bigint[])`, [M]);
    await count('branch materials', `delete from profittrack_materials where id = any($1::bigint[])`, [M]);
    await count('branch operations', `delete from profittrack_operations o where o.id = any($1::bigint[])
      and not exists (select 1 from profittrack_production_batches x where x.operation_id = o.id)
      and not exists (select 1 from profittrack_material_movements x where x.operation_id = o.id)
      and not exists (select 1 from profittrack_counts x where x.operation_id = o.id)
      and not exists (select 1 from profittrack_sales x where x.operation_id = o.id)`, [ops]);
    await count('branch activity log entries', `delete from profittrack_audit_events where (entity_type ilike '%material%' and entity_id = any($1::bigint[]))
      or (entity_type ilike '%recipe%' and entity_id = any($2::bigint[])) or (entity_type ilike '%batch%' and entity_id = any($3::bigint[]))`, [M, R, batches]);

    // Supply requests that carry a removed item go with their history (items, status history, deliveries cascade).
    await count('supply requests', `delete from supply_requests where id in (select supply_request_id from supply_request_items where product_id = any($1::bigint[]))`, [P]);
    await count('branch sale lines (legacy)', `delete from branch_sale_items where product_id = any($1::bigint[])`, [P]);
    await count('menu recipes (ingredients)', `delete from brand_product_ingredients where brand_product_id = any($1::bigint[]) or product_id = any($2::bigint[])`, [B, P]);
    await count('menu products', `delete from brand_products where id = any($1::bigint[])`, [B]);
    await count('warehouse logs', `delete from inventory_audit_logs where product_id = any($1::bigint[])`, [P]);
    await count('stock rows (warehouse and branches; movements and forecasts cascade)', `delete from inventories where product_id = any($1::bigint[])`, [P]);
    await count('warehouse products', `delete from products where id = any($1::bigint[])`, [P]);

    // ---- 2. Categories (per brand; reuse by name, add what is missing) ----
    const categoryOf = new Map<string, Row>();
    for (const m of materials.values()) {
      const brand = brandOf.get(key(m.brand))!;
      const cKey = `${brand.id}|${key(m.category)}`;
      if (categoryOf.has(cKey)) continue;
      const name = m.category.trim().replace(/\s+/gu, ' ');
      let [category] = await tx.query(`select * from product_categories where brand_id = $1 and name_normalized = $2`, [brand.id, name.toLowerCase()]);
      if (!category) {
        category = await insertRow(tx, 'product_categories', { brand_id: brand.id, name, name_normalized: name.toLowerCase() });
        report.added.categories.push(`${brand.name}: ${name}`);
      }
      categoryOf.set(cKey, category);
    }

    // ---- 3. Warehouse products with their opening stock ----
    const units = new Set((await tx.query(`select name_normalized from units`)).map((u) => u.name_normalized));
    const productIdOf = new Map<string, Row>();
    for (const [mKey, m] of materials) {
      const brand = brandOf.get(key(m.brand))!;
      const unit = m.unit.trim();
      if (!units.has(unit.toLowerCase())) throw new Error(`Unit "${unit}" is not in the unit list.`);
      const category = categoryOf.get(`${brand.id}|${key(m.category)}`)!;
      const name = m.material.trim().replace(/\s+/gu, ' ');
      const [existing] = await tx.query(`select * from products where brand_id = $1 and lower(name) = lower($2)`, [brand.id, name]);
      if (existing) { productIdOf.set(mKey, existing); report.kept.raw_materials++; continue; }
      const plan = stockPlan(m.brand, m.material, unit);
      const product = await insertRow(tx, 'products', {
        brand_id: brand.id, sku: await warehouseSku(tx, brand.code, category.name), name, category_id: category.id, category: category.name, unit, is_active: true,
      });
      const inventory = await insertRow(tx, 'inventories', {
        location_id: warehouse.id, product_id: product.id, current_stock: 0, reorder_level: plan.reorder, critical_level: plan.critical, updated_by_user_id: logistics.id,
      });
      await adjustStock(tx, inventory.id, plan.stock, 'opening', logistics, { remarks: 'Opening stock.' });
      await stockAudit(tx, logistics, 'opening', 'manual adjust', null, plan.stock, { inventory: { ...inventory, product }, note: 'Opening quantity set when the product was added.' });
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, new_values, created_at) values ($1, 'inventory.item_added', 'App\\Models\\Inventory', $2, $3, now())`,
        [logistics.id, inventory.id, JSON.stringify({ location_id: warehouse.id, product_id: product.id, reorder_level: plan.reorder, critical_level: plan.critical })],
      );
      productIdOf.set(mKey, product);
      report.added.raw_materials++;
    }

    // ---- 4. Menu products, Product Type as description, recipe linked ----
    for (const p of products.values()) {
      const name = p.name.trim().replace(/\s+/gu, ' ');
      const [existing] = await tx.query(`select id from brand_products where brand_id = $1 and name_key = $2`, [p.brand.id, key(name)]);
      if (existing) { report.kept.products++; continue; }
      const row = await insertRow(tx, 'brand_products', {
        brand_id: p.brand.id, sku: await nextBrandProductSku(tx, p.brand.id), name, name_key: key(name), description: p.type.trim(), image_path: null,
        is_active: true, created_by_user_id: admin.id, updated_by_user_id: admin.id,
      });
      const seen = new Set<number>();
      for (const line of p.lines) {
        const source = productIdOf.get(`${p.brand.id}|${key(line.material)}`)!;
        if (seen.has(Number(source.id))) continue;
        seen.add(Number(source.id));
        await insertRow(tx, 'brand_product_ingredients', {
          brand_id: p.brand.id, brand_product_id: row.id, product_id: source.id, batch_amount_milli: Math.round(perServing(line) * 1000), batch_unit: String(source.unit), yield_pieces: 1,
        });
        report.added.ingredients++;
      }
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, new_values, created_at) values ($1, 'brand_product.created', 'App\\Models\\BrandProduct', $2, $3, now())`,
        [admin.id, row.id, JSON.stringify({ brand_id: row.brand_id, sku: row.sku, name: row.name, description: row.description, is_active: true })],
      );
      report.added.products++;
    }

    // ---- Final counts, straight from the database ----
    for (const r of await tx.query(`select b.name, (select count(*)::int from brand_products bp where bp.brand_id = b.id) as products,
        (select count(*)::int from products p where p.brand_id = b.id) as raw from brands b order by b.id`)) {
      report.products_per_brand[r.name] = r.products;
      report.raw_materials_per_brand[r.name] = r.raw;
    }
    return report;
  });
}
