// InventoryController and ForecastController.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, Filter, insertRow, intParam, ok, paginate, perPage, pick, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import {
  adjustStock, csvApply, csvExport, csvPreview, csvTemplate, generateForecast, inventoryJson, setStock, stockAudit, stockStatus, warehouse,
} from '../services/inventory.ts';

export const inventoryRoutes = new Hono<AppEnv>();
const MODEL = 'App\\Models\\Inventory';
const FORECAST = 'App\\Models\\Forecast';
const central = role('admin', 'logistics');
const logistics = role('logistics');
const allRoles = role('admin', 'logistics', 'franchisee');
const STOCK_TYPES = 'opening,adjustment_in,adjustment_out,consumption,fulfillment,replenishment,cancellation';

const NAME = (expr: string) => `(select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = ${expr})`;
const LOCATION_FULL = (i: string) => `(select to_jsonb(l) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = l.brand_id),
    'franchisee', (select to_jsonb(f) || jsonb_build_object('user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) from users u where u.id = f.user_id)) from franchisees f where f.id = l.franchisee_id))
  from franchise_locations l where l.id = ${i}.location_id)`;
const PRODUCT_FULL = (i: string) => `(select to_jsonb(p) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = p.brand_id)) from products p where p.id = ${i}.product_id)`;
const LOCATION = (i: string) => `(select to_jsonb(l) from franchise_locations l where l.id = ${i}.location_id)`;
const PRODUCT = (i: string) => `(select to_jsonb(p) from products p where p.id = ${i}.product_id)`;

const load = async (c: Context<AppEnv>): Promise<Row> => requireFound((await c.get('deps').db.query(
  `select i.*, ${LOCATION('i')} as location, ${PRODUCT('i')} as product from inventories i where i.id = $1`, [routeId(c, 'inventory')],
))[0]);
const withParts = async (db: Db, id: number) => inventoryJson(db, (await db.query(`select i.*, ${LOCATION('i')} as location, ${PRODUCT('i')} as product from inventories i where i.id = $1`, [id]))[0]);
const OWNS = `exists (select 1 from franchise_locations ol join franchisees of on of.id = ol.franchisee_id where ol.id = i.location_id and of.user_id = ?)`;

async function assertAccess(c: Context<AppEnv>, db: Db, i: Row) {
  if (roleName(c) !== 'franchisee') return;
  const owns = await db.query(`select 1 from franchise_locations l join franchisees f on f.id = l.franchisee_id where l.id = $1 and f.user_id = $2`, [i.location_id, c.get('user').id]);
  if (!owns.length) abort(403, 'You cannot access this inventory record.');
}

function addStockStatus(f: Filter, status: string | undefined, table = 'i') {
  if (status === 'critical') f.add(`${table}.current_stock <= ${table}.critical_level`);
  else if (status === 'low') f.add(`${table}.current_stock > ${table}.critical_level and ${table}.current_stock <= ${table}.reorder_level`);
  else if (status === 'normal') f.add(`${table}.current_stock > ${table}.reorder_level`);
}

inventoryRoutes.get('/inventories', allRoles, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = new Filter();
  if (roleName(c) === 'franchisee') f.add(OWNS, c.get('user').id);
  if (q.location_id) f.add('i.location_id = ?', intParam(q.location_id));
  if (q.location_type && roleName(c) !== 'franchisee') f.add('exists (select 1 from franchise_locations l where l.id = i.location_id and l.type = ?)', q.location_type);
  if (q.product_id) f.add('i.product_id = ?', intParam(q.product_id));
  if (q.brand_id) f.add('exists (select 1 from products p where p.id = i.product_id and p.brand_id = ?)', intParam(q.brand_id));
  addStockStatus(f, q.stock_status);
  const page = await paginate(c, db, {
    columns: `i.*, ${LOCATION_FULL('i')} as location, ${PRODUCT_FULL('i')} as product`,
    from: 'inventories i', where: f.clauses, params: f.params, orderBy: 'i.location_id, i.product_id', perPage: perPage(c, 50),
  });
  const body = await page.json();
  return c.json({ ...body, data: await Promise.all(body.data.map((row: Row) => inventoryJson(db, row))) });
});

inventoryRoutes.get('/inventories/grouped', central, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const wh = await warehouse(db);
  const brands = await db.query(`select id, name, code from brands where is_active = true order by id`);
  const brandId = q.brand_id ? intParam(q.brand_id) : brands[0]?.id;
  const brand = brands.find((b) => b.id === brandId);
  if (!brand) fail('brand_id', 'Choose one of the four active brands.');

  const f = new Filter();
  f.add('i.location_id = ?', wh.id);
  f.add('p.is_active = true and p.archived_at is null and p.brand_id = ?', brandId);
  if (q.category_id) f.add('p.category_id = ?', intParam(q.category_id));
  const search = String(q.search ?? '').trim();
  if (search) f.add('(p.name ilike ? or p.sku ilike ?)', `%${search}%`, `%${search}%`);
  addStockStatus(f, q.stock_status);

  const size = perPage(c, 10, 50);
  const page = await paginate(c, db, {
    columns: `i.*, p.name as product_name, p.sku, p.unit, p.brand_id as product_brand_id, p.category_id as product_category_id, p.category as product_category,
      (select pc.name from product_categories pc where pc.id = p.category_id) as category_name`,
    from: 'inventories i join products p on p.id = i.product_id', where: f.clauses, params: f.params, orderBy: 'coalesce(p.category_id, 999999), p.name', perPage: size,
  });
  const body = await page.json();
  const groups = new Map<number, Row>();
  for (const r of body.data) {
    const id = r.product_category_id ?? 0;
    if (!groups.has(id)) groups.set(id, { category: { id: id || null, name: r.category_name ?? 'Uncategorized' }, items: [] });
    groups.get(id)!.items.push({
      id: r.id, product_id: r.product_id, name: r.product_name, sku: r.sku, unit: r.unit, category: r.category_name ?? r.product_category, brand_id: r.product_brand_id,
      quantity: Number(r.current_stock), reorder_level: Number(r.reorder_level), critical_level: Number(r.critical_level), status: stockStatus(r),
    });
  }
  // Metrics describe the whole selected brand, never the current filter.
  const [summary] = await db.query(
    `select count(*)::int as total_items, coalesce(sum(i.current_stock), 0) as total_units,
       count(*) filter (where i.current_stock <= i.critical_level)::int as critical,
       count(*) filter (where i.current_stock > i.critical_level and i.current_stock <= i.reorder_level)::int as low
     from inventories i join products p on p.id = i.product_id where i.location_id = $1 and p.is_active = true and p.archived_at is null and p.brand_id = $2`, [wh.id, brandId],
  );
  const { current_page: current, last_page: last, per_page: per, total } = body.meta;
  const from = total ? (current - 1) * per + 1 : null;
  return ok(c, {
    brand, brands, groups: [...groups.values()],
    meta: { current_page: current, last_page: last, per_page: per, total, from, to: total ? (from as number) + body.data.length - 1 : null },
    summary: { total_items: summary.total_items, total_units: Number(summary.total_units), low: summary.low, critical: summary.critical },
  });
});

function generateSku(db: Db, brandId: number, category: Row) {
  return (async () => {
    const [b] = await db.query(`select code from brands where id = $1`, [brandId]);
    const brandCode = String(b?.code || 'WH').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6) || 'WH';
    const words = String(category.name).toUpperCase().split(/[^A-Za-z]+/);
    const present = words.filter(Boolean);
    const code = (words.length > 1 ? present.slice(0, 2).map((w) => w.slice(0, 2)).join('') : (words[0] ?? 'GEN').slice(0, 3)).slice(0, 4) || 'GEN';
    for (;;) {
      const sku = `${brandCode}-${code}-${String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0')}`;
      if (!(await db.query(`select 1 from products where sku = $1`, [sku])).length) return sku;
    }
  })();
}

inventoryRoutes.post('/inventories/items', central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    name: ['required', 'string', 'max:120'], brand_id: ['required', 'integer', 'exists:brands,id'], category_id: ['required', 'integer', 'exists:product_categories,id'],
    unit: ['required', 'string', 'max:30'], opening_quantity: ['nullable', 'numeric', 'min:0'], reorder_level: ['nullable', 'numeric', 'min:0'], critical_level: ['nullable', 'numeric', 'min:0'],
  });
  if (Number(v.critical_level ?? 0) > Number(v.reorder_level ?? 0)) fail('critical_level', 'The critical level must not exceed the reorder level.');
  const wh = await warehouse(db);
  const name = String(v.name).trim();
  if ((await db.query(`select 1 from products where brand_id = $1 and is_active = true and archived_at is null and lower(name) = lower($2) limit 1`, [v.brand_id, name])).length) {
    fail('name', 'This product name already exists for the selected brand.');
  }
  const [category] = await db.query(`select * from product_categories where id = $1 and brand_id = $2`, [v.category_id, v.brand_id]);
  if (!category) fail('category_id', 'Choose a category that belongs to the selected brand.');
  const unit = String(v.unit).trim();
  if (!(await db.query(`select 1 from units where name_normalized = $1`, [unit.replace(/\s+/gu, ' ').toLowerCase()])).length) fail('unit', 'Choose a unit from the shared unit list.');
  const opening = Number(v.opening_quantity ?? 0);
  if (roleName(c) === 'admin' && opening > 0) fail('opening_quantity', 'Only Logistics may set stock quantities.');

  const inventory = await db.tx(async (tx): Promise<Row> => {
    const product = await insertRow(tx, 'products', {
      brand_id: v.brand_id, sku: await generateSku(tx, v.brand_id, category), name, category_id: category.id, category: category.name, unit, is_active: true,
    });
    const row = await insertRow(tx, 'inventories', {
      location_id: wh.id, product_id: product.id, current_stock: 0, reorder_level: Number(v.reorder_level ?? 0), critical_level: Number(v.critical_level ?? 0), updated_by_user_id: user.id,
    });
    if (opening > 0) await adjustStock(tx, row.id, opening, 'opening', user, { remarks: 'Opening stock.' });
    return { ...row, product };
  });
  await audit(c, db, 'inventory.item_added', { type: MODEL, id: inventory.id }, null, pick(inventory, ['location_id', 'product_id', 'reorder_level', 'critical_level']));
  if (opening > 0) await stockAudit(db, user, 'opening', 'manual adjust', null, opening, { inventory, note: 'Opening quantity set when the product was added.' });
  const row = (await db.query(`select i.*, ${LOCATION('i')} as location, ${PRODUCT('i')} || jsonb_build_object('product_category', (select to_jsonb(pc) from product_categories pc where pc.id = $2)) as product from inventories i where i.id = $1`, [inventory.id, category.id]))[0];
  return ok(c, await inventoryJson(db, row), 'Warehouse item added.', 201);
});

inventoryRoutes.delete('/inventories/items', logistics, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { inventory_ids: ['required', 'array', 'min:1', 'max:100'] });
  const ids = [...new Set<number>(v.inventory_ids.map(Number))];
  const rows = await db.query(`select i.*, ${PRODUCT('i')} as product from inventories i where i.id = any($1::bigint[])`, [`{${ids.join(',')}}`]);
  if (rows.length !== ids.length) fail('inventory_ids', 'The selected inventory ids is invalid.');
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const blocked = await db.query(
    `select distinct p.name from supply_request_items si join supply_requests sr on sr.id = si.supply_request_id join products p on p.id = si.product_id
     where si.product_id = any($1::bigint[]) and sr.status not in ('completed', 'cancelled', 'rejected')`, [`{${productIds.join(',')}}`],
  );
  if (blocked.length) fail('inventory_ids', `These products are still on an open supply request: ${blocked.map((b) => b.name).join(', ')}. Reject, cancel or complete the request first.`);
  await db.query(`update products set is_active = false, archived_at = now() where id = any($1::bigint[])`, [`{${productIds.join(',')}}`]);
  for (const row of rows) await stockAudit(db, user, 'delete', 'delete product', Number(row.current_stock), null, { inventory: row, note: 'Warehouse product archived.' });
  await audit(c, db, 'inventory.items_archived', null, null, { product_ids: productIds, inventory_ids: rows.map((r) => r.id) });
  return ok(c, { archived: productIds }, productIds.length === 1 ? 'Product archived.' : `${productIds.length} products archived.`);
});

const csvResponse = (filename: string, csv: string, extra: Record<string, string> = {}) => new Response(csv, {
  headers: { 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': `attachment; filename="${filename}"`, ...extra },
});

inventoryRoutes.get('/warehouse/import-template', central, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, c.req.query(), { brand_id: ['required', 'integer', 'exists:brands,id'], mode: ['sometimes', 'in:set,add'] });
  const t = await csvTemplate(db, v.brand_id, v.mode ?? 'set');
  return csvResponse(t.filename, t.csv, { 'x-template-rows': String(t.rows) });
});

inventoryRoutes.get('/warehouse/export', logistics, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, c.req.query(), { brand_id: ['required', 'integer', 'exists:brands,id'] });
  const e = await csvExport(db, v.brand_id);
  return csvResponse(e.filename, e.csv);
});

const importRules = { brand_id: ['required', 'integer', 'exists:brands,id'], mode: ['required', 'in:set,add'], csv: ['required', 'string', 'max:2097152'] };

inventoryRoutes.post('/warehouse/import/preview', logistics, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), importRules);
  return ok(c, await csvPreview(db, v.brand_id, v.csv, v.mode));
});

inventoryRoutes.post('/warehouse/import/apply', logistics, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), importRules);
  const result = await csvApply(db, v.brand_id, v.csv, v.mode, c.get('user'));
  let message = `${result.updated} product(s) updated from CSV.`;
  if (result.unchanged > 0) message += ` ${result.unchanged} row(s) already matched the warehouse quantity.`;
  return ok(c, result, message);
});

inventoryRoutes.get('/inventory-audit-logs', role('admin'), async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = new Filter();
  if (q.brand_id) f.add('a.brand_id = ?', intParam(q.brand_id));
  if (q.product_id) f.add('a.product_id = ?', intParam(q.product_id));
  return paginate(c, db, {
    columns: `a.*, ${NAME('a.actor_user_id')} as actor, (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = a.brand_id) as brand,
      (select jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku) from products p where p.id = a.product_id) as product`,
    from: 'inventory_audit_logs a', where: f.clauses, params: f.params, orderBy: 'a.id desc', perPage: perPage(c, 50),
  });
});

inventoryRoutes.get('/inventory-transactions', allRoles, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = new Filter();
  if (roleName(c) === 'franchisee') f.add(`exists (select 1 from inventories oi join franchise_locations ol on ol.id = oi.location_id join franchisees of on of.id = ol.franchisee_id where oi.id = t.inventory_id and of.user_id = ?)`, c.get('user').id);
  if (q.inventory_id) f.add('t.inventory_id = ?', intParam(q.inventory_id));
  if (q.type) f.add('t.type = ?', q.type);
  if (q.from) f.add('t.transaction_date >= ?', new Date(`${q.from.slice(0, 10)}T00:00:00+08:00`));
  if (q.to) f.add('t.transaction_date <= ?', new Date(`${q.to.slice(0, 10)}T23:59:59+08:00`));
  return paginate(c, db, {
    columns: `t.*, ${NAME('t.recorded_by_user_id')} as recorded_by,
      (select to_jsonb(i) || jsonb_build_object('product', ${PRODUCT('i')}, 'location', ${LOCATION('i')}) from inventories i where i.id = t.inventory_id) as inventory`,
    from: 'inventory_transactions t', where: f.clauses, params: f.params, orderBy: 't.transaction_date desc', perPage: perPage(c, 50),
  });
});

inventoryRoutes.get('/inventories/:inventory', allRoles, async (c) => {
  const { db } = c.get('deps');
  const i = await load(c);
  await assertAccess(c, db, i);
  const [row] = await db.query(`select i.*, ${LOCATION_FULL('i')} as location, ${PRODUCT_FULL('i')} as product from inventories i where i.id = $1`, [i.id]);
  const transactions = await db.query(`select * from inventory_transactions where inventory_id = $1 order by transaction_date desc limit 100`, [i.id]);
  return ok(c, { ...(await inventoryJson(db, row)), transactions });
});

inventoryRoutes.post('/inventories', central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    location_id: ['required', 'exists:franchise_locations,id'], product_id: ['required', 'exists:products,id'], current_stock: ['nullable', 'integer', 'min:0'],
    reorder_level: ['required', 'integer', 'min:0'], critical_level: ['required', 'integer', 'min:0', 'lte:reorder_level'],
  });
  await db.query(
    `insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level, updated_by_user_id) values ($1, $2, 0, $3, $4, $5)
     on conflict (location_id, product_id) do update set reorder_level = excluded.reorder_level, critical_level = excluded.critical_level, updated_by_user_id = excluded.updated_by_user_id`,
    [v.location_id, v.product_id, v.reorder_level, v.critical_level, user.id],
  );
  const [row] = await db.query(`select * from inventories where location_id = $1 and product_id = $2`, [v.location_id, v.product_id]);
  if ('current_stock' in v && v.current_stock !== null && Number(v.current_stock) !== Number(row.current_stock)) {
    if (roleName(c) === 'admin') abort(403, 'Only logistics may change quantities.');
    await setStock(db, row.id, Number(v.current_stock), user, 'Initial or corrected stock count.');
  }
  await audit(c, db, 'inventory.configured', { type: MODEL, id: row.id }, null, pick(row, ['location_id', 'product_id', 'reorder_level', 'critical_level']));
  return ok(c, await withParts(db, row.id), 'Inventory record configured.', 201);
});

inventoryRoutes.post('/locations/:location/items', central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [routeId(c, 'location')]);
  requireFound(location);
  const v = await validate(db, await readInput(c), {
    name: ['required', 'string', 'max:255'], sku: ['required', 'string', 'max:80', 'unique:products,sku'], category_id: ['required', 'integer', 'exists:product_categories,id'],
    unit: ['required', 'string', 'max:30'], current_stock: ['nullable', 'numeric', 'min:0'], reorder_level: ['required', 'numeric', 'min:0'], critical_level: ['required', 'numeric', 'min:0', 'lte:reorder_level'],
  });
  const isWarehouse = location.type === 'warehouse';
  const quantity = Number(v.current_stock ?? 0);
  if (!isWarehouse && roleName(c) === 'admin') abort(403, 'Branch inventory is read-only for Admin.');
  if (isWarehouse && roleName(c) === 'admin' && quantity > 0) abort(403, 'Only logistics may set warehouse quantities.');
  const duplicate = await db.query(
    `select 1 from inventories i join products p on p.id = i.product_id where i.location_id = $1 and p.category_id = $2 and lower(p.name) = lower($3) limit 1`, [location.id, v.category_id, v.name],
  );
  if (duplicate.length) fail('name', 'This item already exists in this branch under the same category.');
  const [category] = await db.query(`select name from product_categories where id = $1`, [v.category_id]);
  const product = await insertRow(db, 'products', { sku: v.sku, name: v.name, category_id: v.category_id, category: category.name, unit: v.unit, is_active: true });
  const inventory = await insertRow(db, 'inventories', { location_id: location.id, product_id: product.id, current_stock: 0, reorder_level: v.reorder_level, critical_level: v.critical_level, updated_by_user_id: user.id });
  if (quantity > 0) await adjustStock(db, inventory.id, quantity, 'adjustment_in', user, { remarks: 'Opening stock.' });
  await audit(c, db, 'inventory.item_added', { type: MODEL, id: inventory.id }, null, inventory);
  return ok(c, await withParts(db, inventory.id), 'Item added to location.', 201);
});

inventoryRoutes.patch('/inventories/:inventory/thresholds', central, async (c) => {
  const { db } = c.get('deps');
  const i = await load(c);
  if (roleName(c) === 'admin' && i.location?.type === 'franchise') abort(403, 'Branch inventory is read-only for Admin.');
  const v = await validate(db, await readInput(c), { reorder_level: ['required', 'integer', 'min:0'], critical_level: ['required', 'integer', 'min:0', 'lte:reorder_level'] });
  const keys = ['reorder_level', 'critical_level'];
  const saved = await updateRow(db, 'inventories', i.id, { ...v, updated_by_user_id: c.get('user').id });
  await audit(c, db, 'inventory.thresholds_updated', { type: MODEL, id: i.id }, pick(i, keys), pick(saved!, keys));
  return ok(c, await inventoryJson(db, saved!), 'Inventory thresholds updated.');
});

inventoryRoutes.post('/inventories/:inventory/quantity', logistics, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const i = await load(c);
  if (i.location?.type !== 'warehouse') abort(422, 'This stock row is not a warehouse row.');
  const v = await validate(db, await readInput(c), {
    direction: ['required', 'in:increase,decrease'], quantity: ['required', 'numeric', 'gt:0'], note: ['nullable', 'string', 'max:255'], reason: ['nullable', 'string', 'max:255'],
  });
  const note = String(v.note ?? v.reason ?? '').trim();
  const signed = v.direction === 'increase' ? Number(v.quantity) : -Number(v.quantity);
  const before = Number(i.current_stock);
  if (signed < 0 && before + signed < 0) fail('quantity', `Stock cannot go below zero. Available: ${before.toFixed(2).replace(/\.?0+$/, '')}.`);
  const transaction = await adjustStock(db, i.id, signed, signed > 0 ? 'adjustment_in' : 'adjustment_out', user, { remarks: note || null });
  await audit(c, db, 'inventory.adjusted', { type: MODEL, id: i.id }, null, { transaction_id: transaction.id, balance_after: transaction.balance_after });
  await stockAudit(db, user, 'adjust', 'manual adjust', before, Number(transaction.balance_after), { inventory: i, note: note || null });
  return ok(c, { inventory: await withParts(db, i.id), transaction }, 'Stock adjusted.');
});

inventoryRoutes.post('/inventories/:inventory/adjust', allRoles, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const i = await load(c);
  await assertAccess(c, db, i);
  const name = roleName(c);
  if (!['logistics', 'franchisee'].includes(name)) abort(403, 'Only logistics may change quantities.');
  if (name === 'franchisee' && i.location?.type === 'warehouse') abort(403, 'Warehouse quantities are adjusted by logistics only.');
  const input = await readInput(c);
  const v = await validate(db, input, { mode: ['required', 'in:delta,set'], quantity: ['required', 'integer'], type: ['nullable', `in:${STOCK_TYPES}`], remarks: ['nullable', 'string'] });
  if (name === 'franchisee' && !String(v.remarks ?? '').trim()) fail('remarks', 'A reason is required for branch stock corrections.');
  let transaction: Row;
  if (v.mode === 'set') {
    if (v.quantity < 0) fail('quantity', 'The quantity field must be at least 0.');
    transaction = await setStock(db, i.id, Number(v.quantity), user, v.remarks ?? null);
  } else {
    if (v.quantity === 0) fail('quantity', 'The selected quantity is invalid.');
    if (name === 'logistics' && !String(v.remarks ?? '').trim()) fail('remarks', 'A reason is required for quantity adjustments.');
    transaction = await adjustStock(db, i.id, Number(v.quantity), v.type ?? (v.quantity >= 0 ? 'adjustment_in' : 'adjustment_out'), user, { remarks: v.remarks ?? null });
  }
  await audit(c, db, 'inventory.adjusted', { type: MODEL, id: i.id }, null, { transaction_id: transaction.id, balance_after: transaction.balance_after });
  return ok(c, { ...transaction, inventory: await withParts(db, i.id) }, 'Inventory updated.');
});

// ---- Monthly forecasts ----
const DEFAULT_PERIODS = 3;
const forecastJson = (db: Db, id: number) => db.query(
  `select f.*, (select to_jsonb(i) || jsonb_build_object('product', ${PRODUCT('i')}, 'location', ${LOCATION('i')}) from inventories i where i.id = f.inventory_id) as inventory from forecasts f where f.id = $1`, [id],
).then((r) => r[0]);

inventoryRoutes.get('/forecasts', central, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = new Filter();
  if (q.inventory_id) f.add('fc.inventory_id = ?', intParam(q.inventory_id));
  if (q.location_id) f.add('exists (select 1 from inventories i where i.id = fc.inventory_id and i.location_id = ?)', intParam(q.location_id));
  return paginate(c, db, {
    columns: `fc.*, ${NAME('fc.generated_by_user_id')} as generated_by,
      (select to_jsonb(i) || jsonb_build_object('product', ${PRODUCT_FULL('i')}, 'location', ${LOCATION('i')}) from inventories i where i.id = fc.inventory_id) as inventory`,
    from: 'forecasts fc', where: f.clauses, params: f.params, orderBy: 'fc.generated_at desc', perPage: perPage(c, 30),
  });
});

inventoryRoutes.post('/inventories/:inventory/forecast', central, async (c) => {
  const { db } = c.get('deps');
  const i = await load(c);
  const v = await validate(db, await readInput(c), { periods: ['nullable', 'integer', 'min:2', 'max:24'] });
  const forecast = await generateForecast(db, i, v.periods ?? DEFAULT_PERIODS, c.get('user'));
  await audit(c, db, 'forecast.generated', { type: FORECAST, id: forecast.id }, null, forecast);
  return ok(c, await forecastJson(db, forecast.id), 'Forecast generated.', 201);
});

inventoryRoutes.post('/forecasts/generate', central, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    location_id: ['nullable', 'exists:franchise_locations,id'], brand_id: ['nullable', 'exists:brands,id'], periods: ['nullable', 'integer', 'min:2', 'max:24'],
  });
  const periods = v.periods ?? DEFAULT_PERIODS;
  const f = new Filter();
  if (v.location_id) f.add('i.location_id = ?', v.location_id);
  if (v.brand_id) f.add('exists (select 1 from products p where p.id = i.product_id and p.brand_id = ?)', v.brand_id);
  const inventories = await db.query(`select i.* from inventories i ${f.where} order by i.id`, f.params);
  const forecasts = [];
  for (const i of inventories) forecasts.push(await forecastJson(db, (await generateForecast(db, i, periods, c.get('user'))).id));
  await audit(c, db, 'forecast.bulk_generated', null, null, { count: forecasts.length, periods });
  return ok(c, forecasts, 'Forecasts generated.', 201);
});
