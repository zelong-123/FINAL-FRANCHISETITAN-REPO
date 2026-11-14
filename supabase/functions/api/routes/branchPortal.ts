// BranchPortalController: the franchisee's own stock, plus Admin's read-only preview.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, ok, perPage } from '../lib/http.ts';
import { readInput, validate, validateEach } from '../lib/validate.ts';
import { role, roleName } from '../lib/middleware.ts';
import { resolveWorkspace } from '../services/branchAccess.ts';
import { adjustStock, inventoryJson, stockStatus } from '../services/inventory.ts';
import { notifyRoles } from '../services/notifications.ts';
import { audit, publicUser } from '../services/users.ts';
import { DELIVERED_ON, OPEN as OPEN_SUPPLY, sqlList } from '../services/supplyStatus.ts';

export const portalRoutes = new Hono<AppEnv>();
const franchisee = role('franchisee');
const admin = role('admin');
const SALE_MODEL = 'App\\Models\\BranchSale';

const RELATIONS = `(select to_jsonb(b) from brands b where b.id = l.brand_id) as brand,
  (select to_jsonb(f) || jsonb_build_object('user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email) from users u where u.id = f.user_id)) from franchisees f where f.id = l.franchisee_id) as franchisee`;
const PRODUCTS = `select p.*, (select to_jsonb(b) from brands b where b.id = p.brand_id) as brand from products p where p.is_active = true and p.brand_id = $1 order by p.name`;
const SALE_ITEMS = `coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'unit', p.unit) from products p where p.id = i.product_id)) order by i.id) from branch_sale_items i where i.branch_sale_id = s.id), '[]'::jsonb) as items`;
const RECORDED_BY = `(select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = s.recorded_by_user_id) as recorded_by`;
const REQUEST_ITEMS = `coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'name', p.name, 'unit', p.unit) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = sr.id), '[]'::jsonb) as items`;
const productsOf = (db: Db, loc: Row) => (loc.brand_id ? db.query(PRODUCTS, [loc.brand_id]) : Promise.resolve([]));
const salesOf = (db: Db, id: number, limit: number) => db.query(`select s.*, ${SALE_ITEMS}, ${RECORDED_BY} from branch_sales s where s.location_id = $1 order by s.created_at desc, s.id desc limit ${limit}`, [id]);
const requestsOf = (db: Db, id: number, limit: number) => db.query(`select sr.*, ${REQUEST_ITEMS} from supply_requests sr where sr.location_id = $1 order by sr.created_at desc, sr.id desc limit ${limit}`, [id]);

async function resolveLocation(c: Context<AppEnv>): Promise<Row> {
  const { db } = c.get('deps');
  const code = String((await readInput(c)).branch_code ?? '').trim();
  if (roleName(c) === 'franchisee') {
    const own = await resolveWorkspace(db, c.get('user'));
    if (!own) abort(403, 'This account must be assigned to exactly one active branch. Contact an administrator.');
    // A branch may repeat its own code, but can never select another branch.
    if (code !== '' && code !== String(own!.branch_code)) abort(403, 'Branch accounts can only open the branch assigned to their account.');
    return (await db.query(`select l.*, ${RELATIONS} from franchise_locations l where l.id = $1`, [own!.id]))[0];
  }
  if (code === '') fail('branch_code', 'The branch code is required.');
  const [found] = await db.query(`select l.*, ${RELATIONS} from franchise_locations l where l.branch_code = $1 and l.type = 'franchise' and l.is_active = true`, [code]);
  if (!found) abort(404, 'The requested branch site is not configured.');
  return found;
}

async function syncData(db: Db, loc: Row) {
  const [{ version }] = await db.query(`select coalesce(max(t.id), 0) as version from inventory_transactions t join inventories i on i.id = t.inventory_id where i.location_id = $1`, [loc.id]);
  return { version: Number(version), server_time: new Date().toISOString(), location_updated_at: loc.updated_at ?? null };
}

const inventoryRows = async (db: Db, id: number) => {
  const rows = await db.query(
    `select i.*, (select jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit, 'brand', (select to_jsonb(b) from brands b where b.id = p.brand_id)) from products p where p.id = i.product_id) as product,
       (select max(t.id) from inventory_transactions t where t.inventory_id = i.id) as transactions_max_id
     from inventories i where i.location_id = $1 order by i.product_id`, [id],
  );
  return Promise.all(rows.map((row) => inventoryJson(db, row)));
};

portalRoutes.get('/branch/context', franchisee, async (c) => {
  const { db } = c.get('deps');
  const loc = await resolveLocation(c);
  return ok(c, { branch_code: loc.branch_code, location: loc, user: publicUser(c.get('user')), available_products: await productsOf(db, loc), sync: await syncData(db, loc) });
});

portalRoutes.get('/branch/preview', admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { branch_code: ['required', 'string', 'exists:franchise_locations,branch_code'] });
  const [loc] = await db.query(`select l.*, ${RELATIONS} from franchise_locations l where l.branch_code = $1 and l.type = 'franchise' and l.is_active = true`, [v.branch_code]);
  if (!loc) abort(404, 'Record not found.');
  const inventories = await inventoryRows(db, loc.id);
  const user = c.get('user');
  return ok(c, {
    branch_code: loc.branch_code, location: { ...loc, inventories }, available_products: await productsOf(db, loc), requests: await requestsOf(db, loc.id, 20), sales: await salesOf(db, loc.id, 8),
    user: { full_name: user.full_name, role: user.role }, read_only: true,
  });
});

portalRoutes.get('/branch/dashboard', franchisee, async (c) => {
  const { db } = c.get('deps');
  const loc = await resolveLocation(c);
  const inventory = await db.query(`select current_stock, reorder_level, critical_level from inventories where location_id = $1`, [loc.id]);
  const [{ open }] = await db.query(`select count(*)::int as open from supply_requests where location_id = $1 and status in (${sqlList(OPEN_SUPPLY)})`, [loc.id]);
  return ok(c, {
    location: loc,
    summary: {
      inventory_items: inventory.length, inventory_units: inventory.reduce((sum, i) => sum + Number(i.current_stock), 0),
      low_stock_items: inventory.filter((i) => ['low', 'critical'].includes(stockStatus(i))).length, open_supply_requests: open,
    },
    recent_sales: await salesOf(db, loc.id, 8), recent_supply_requests: await requestsOf(db, loc.id, 8), sync: await syncData(db, loc),
  });
});

portalRoutes.get('/branch/products', franchisee, async (c) => ok(c, await productsOf(c.get('deps').db, await resolveLocation(c))));

portalRoutes.get('/branch/inventory', franchisee, async (c) => {
  const { db } = c.get('deps');
  const loc = await resolveLocation(c);
  return ok(c, { location: loc, inventory: await inventoryRows(db, loc.id), sync: await syncData(db, loc) });
});

portalRoutes.get('/branch/fulfillment', franchisee, async (c) => {
  const { db } = c.get('deps');
  const loc = await resolveLocation(c);
  const columns = 'id, request_number, status, target_delivery_date';
  const delivered = await db.query(`select ${columns} from supply_requests where location_id = $1 and status in (${sqlList(DELIVERED_ON)}) and branch_received_at is not null order by id desc`, [loc.id]);
  const awaiting = await db.query(`select ${columns} from supply_requests where location_id = $1 and status in ('dispatched', 'delivered') and branch_received_at is null order by id desc`, [loc.id]);
  const [last] = await db.query(
    `select t.id, t.type, t.quantity, t.reference_type, t.reference_id, t.transaction_date from inventory_transactions t join inventories i on i.id = t.inventory_id
     where i.location_id = $1 and t.type in ('fulfillment', 'replenishment', 'cancellation') order by t.id desc limit 1`, [loc.id],
  );
  return ok(c, {
    delivered_count: delivered.length, delivered, awaiting_receipt_count: awaiting.length, awaiting_receipt: awaiting, last_transaction: last ?? null, sync: await syncData(db, loc),
  });
});

portalRoutes.get('/branch/inventory-grouped', franchisee, async (c) => {
  const { db } = c.get('deps');
  const loc = await resolveLocation(c);
  const size = perPage(c, 10);
  const page = Math.max(1, Math.trunc(Number(c.req.query('page') ?? 1)) || 1);
  const all = await db.query(`select current_stock, reorder_level, critical_level from inventories where location_id = $1`, [loc.id]);
  const rows = await db.query(
    `select i.*, to_jsonb(p) || jsonb_build_object('product_category', (select to_jsonb(pc) from product_categories pc where pc.id = p.category_id)) as product
     from inventories i join products p on p.id = i.product_id where i.location_id = $1 order by p.category_id nulls first, p.name limit ${size} offset ${(page - 1) * size}`, [loc.id],
  );
  const groups = new Map<number, Row>();
  for (const row of rows) {
    const json = await inventoryJson(db, row);
    const categoryId = Number(row.product?.category_id ?? 0);
    if (!groups.has(categoryId)) groups.set(categoryId, { category_id: categoryId || null, category_name: row.product?.product_category?.name ?? 'Uncategorized', items: [] });
    groups.get(categoryId)!.items.push(json);
  }
  const summary = { total_items: 0, total_units: 0, low: 0, critical: 0 };
  for (const inventory of all) {
    summary.total_items += 1;
    summary.total_units += Math.max(0, Math.floor(Number(inventory.current_stock)));
    const status = stockStatus(inventory);
    if (status === 'critical') summary.critical += 1;
    else if (status === 'low') summary.low += 1;
  }
  const from = rows.length ? (page - 1) * size + 1 : null;
  return ok(c, {
    groups: [...groups.values()],
    meta: { current_page: page, last_page: Math.max(1, Math.ceil(all.length / size)), per_page: size, total: all.length, from, to: from === null ? null : from + rows.length - 1 },
    summary,
  });
});

portalRoutes.get('/branch/sales', franchisee, async (c) => ok(c, await salesOf(c.get('deps').db, (await resolveLocation(c)).id, 30)));

const stamp = () => new Date(Date.now() + 8 * 3600_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 36]).join('');

const fullSale = async (db: Db, id: number) => (await db.query(
  `select s.*, coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('product', (select to_jsonb(p) from products p where p.id = i.product_id)) order by i.id) from branch_sale_items i where i.branch_sale_id = s.id), '[]'::jsonb) as items,
     ${RECORDED_BY}, (select to_jsonb(l) from franchise_locations l where l.id = s.location_id) as location from branch_sales s where s.id = $1`, [id],
))[0];

portalRoutes.post('/branch/sales', franchisee, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loc = await resolveLocation(c);
  const v = await validate(db, await readInput(c), { client_reference: ['required', 'string', 'max:100'], notes: ['nullable', 'string', 'max:2000'], items: ['required', 'array', 'min:1', 'max:100'] });
  const items = await validateEach(db, v.items, 'items', { inventory_id: ['required', 'integer', 'exists:inventories,id'], quantity: ['required', 'integer', 'min:1'] });
  const distinct = new Set<number>();
  for (const [index, item] of items.entries()) {
    if (distinct.has(item.inventory_id)) fail(`items.${index}.inventory_id`, 'The items inventory id field has a duplicate value.');
    distinct.add(item.inventory_id);
  }
  if (!v.notes) fail('notes', 'A reason is required for branch stock deductions.');

  const result = await db.tx(async (tx) => {
    const [created] = await tx.query(
      `insert into branch_sales (location_id, client_reference, sale_number, recorded_by_user_id, notes) values ($1, $2, $3, $4, $5) on conflict (location_id, client_reference) do nothing returning *`,
      [loc.id, v.client_reference, `SALE-${stamp()}-${randomCode()}`, user.id, v.notes],
    );
    if (!created) {
      const [existing] = await tx.query(`select id from branch_sales where location_id = $1 and client_reference = $2`, [loc.id, v.client_reference]);
      return { sale: await fullSale(tx, existing.id), duplicate: true };
    }
    const ordered = [...items].sort((a, b) => a.inventory_id - b.inventory_id);
    const inventories = await tx.query(
      `select i.*, (select p.name from products p where p.id = i.product_id) as product_name from inventories i where i.location_id = $1 and i.id = any($2::bigint[]) order by i.id for update`,
      [loc.id, `{${ordered.map((i) => i.inventory_id).join(',')}}`],
    );
    if (inventories.length !== ordered.length) fail('items', 'One or more selected items do not belong to this branch. Refresh the page and try again.');
    for (const item of ordered) {
      const inventory = inventories.find((i) => i.id === item.inventory_id)!;
      if (Number(inventory.current_stock) - item.quantity < 0) fail('items', `Insufficient stock for ${inventory.product_name}. Available: ${inventory.current_stock}.`);
    }
    for (const item of ordered) {
      const inventory = inventories.find((i) => i.id === item.inventory_id)!;
      const transaction = await adjustStock(tx, inventory.id, -item.quantity, 'consumption', user, { referenceType: SALE_MODEL, referenceId: created.id, remarks: `Branch deduction ${created.sale_number}` });
      await insertRow(tx, 'branch_sale_items', {
        branch_sale_id: created.id, inventory_id: inventory.id, product_id: inventory.product_id, inventory_transaction_id: transaction.id, quantity: item.quantity,
        balance_before: transaction.balance_before, balance_after: transaction.balance_after,
      });
    }
    return { sale: await fullSale(tx, created.id), duplicate: false };
  });

  if (!result.duplicate) {
    const low: string[] = [];
    for (const item of result.sale.items) {
      const [inventory] = await db.query(`select reorder_level from inventories where id = $1`, [item.inventory_id]);
      if (inventory && Number(item.balance_after) <= Number(inventory.reorder_level) && item.product?.name) low.push(item.product.name);
    }
    if (low.length) {
      await notifyRoles(db, ['admin', 'logistics'], 'branch_low_stock', `Low stock at ${loc.name}`,
        `The following items reached reorder level after ${result.sale.sale_number}: ${low.join(', ')}.`, { location_id: loc.id, branch_sale_id: result.sale.id });
    }
    await audit(c, db, 'branch.sale_recorded', { type: SALE_MODEL, id: result.sale.id }, null, result.sale);
  }
  return ok(c, { ...result, sync: await syncData(db, loc) },
    result.duplicate ? 'This transaction was already recorded; stock was not deducted twice.' : 'Stock deducted successfully.', result.duplicate ? 200 : 201);
});

// Branch inventory is read-only for Admin, the only role these two routes allow, so the original
// closed them and kept them for the record. Nothing in the frontend calls them.
portalRoutes.post('/branch/items', admin, (c) => c.json({ message: 'Branch inventory is read-only for Admin.' }, 403));
portalRoutes.delete('/branch/items', admin, (c) => c.json({ message: 'Branch inventory is read-only for Admin.' }, 403));
