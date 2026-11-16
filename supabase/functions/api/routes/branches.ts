// BranchManagementController: the Branches panel for Admin and Logistics.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, fail, manilaToday, ok, pick, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { attentionText, branchStatus, defaultLevels, evaluate, formatQuantity, STOCK_LABELS } from '../services/materialStock.ts';
import { stockStatus } from '../services/inventory.ts';
import { audit } from '../services/users.ts';
import { DELIVERED_ON, IN_TRANSIT, OPEN as OPEN_SUPPLY, sqlList, SUBMITTED_OPEN } from '../services/supplyStatus.ts';

export const branchRoutes = new Hono<AppEnv>();
const adminOrLogistics = role('admin', 'logistics');
const admin = role('admin');
const logistics = role('logistics');
const LOCATION = 'App\\Models\\FranchiseLocation';
const USER = 'App\\Models\\User';
const MATERIAL = 'App\\Models\\ProfitTrackMaterial';
const USAGE_WINDOW_DAYS = 7;
const LIVE_SYNC_SECONDS = 30;
const OPEN = OPEN_SUPPLY;
const SHIPPED = IN_TRANSIT;
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const inList = (ids: number[]) => `{${ids.join(',')}}`;

const LOCATION_COLUMNS = `l.*, (select jsonb_build_object('id', b.id, 'name', b.name, 'code', b.code) from brands b where b.id = l.brand_id) as brand,
  (select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = l.archived_by_user_id) as archived_by,
  (select to_jsonb(f) || jsonb_build_object('user', (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'phone', u.phone, 'account_status', u.account_status) from users u where u.id = f.user_id))
     from franchisees f where f.id = l.franchisee_id) as franchisee,
  (select max(d.delivered_at) from deliveries d join supply_requests sr on sr.id = d.supply_request_id where sr.location_id = l.id) as last_delivered_at,
  (select min(sr.target_delivery_date) from supply_requests sr where sr.location_id = l.id and sr.status in (${sqlList(IN_TRANSIT)})) as next_delivery_target`;

/** The card title's place; null reads "Location not set". A place equal to the operator's own name is not a location. */
function locationLabel(l: Row): string | null {
  const place = [l.city, l.province].map((part) => String(part ?? '').trim()).filter(Boolean).join(', ');
  if (!place) return null;
  const people = [l.franchisee?.user?.full_name, l.franchisee?.business_name].filter(Boolean).map((name: string) => name.trim().toLowerCase());
  return people.includes(place.toLowerCase()) ? null : place;
}
const portalActive = (l: Row) => l.franchisee?.franchise_status === 'active' && l.franchisee?.user?.account_status === 'active';

const latest = (values: unknown[]) => values.filter(Boolean).map((v) => new Date(v as string)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

branchRoutes.get('/branches/overview', adminOrLogistics, async (c) => {
  const { db } = c.get('deps');
  const includeArchived = boolParam(c.req.query('include_archived')) && roleName(c) === 'admin';
  const visible = includeArchived ? `((l.is_active = true and l.archived_at is null) or l.archived_at is not null)` : `l.is_active = true and l.archived_at is null`;
  const locations = await db.query(`select ${LOCATION_COLUMNS} from franchise_locations l where l.type = 'franchise' and ${visible} order by l.name`);
  const ids = inList(locations.map((l) => l.id));

  const inventories = await db.query(
    `select i.*, (select jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'unit', p.unit) from products p where p.id = i.product_id) as product,
       (select coalesce(sum(t.quantity), 0) from inventory_transactions t where t.inventory_id = i.id and t.type = 'consumption' and t.transaction_date >= now() - interval '30 days') as consumed
     from inventories i where i.location_id = any($1::bigint[]) order by i.product_id`, [ids],
  );
  const materials = await db.query(
    `select m.*, (select to_jsonb(b) from profittrack_material_balances b where b.material_id = m.id limit 1) as balance from profittrack_materials m where m.location_id = any($1::bigint[]) and m.is_active = true order by m.name`, [ids],
  );
  const sales = await db.query(
    `select s.*, (select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = s.recorded_by_user_id) as recorded_by,
       coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'unit', p.unit) from products p where p.id = i.product_id)) order by i.id) from branch_sale_items i where i.branch_sale_id = s.id), '[]'::jsonb) as items
     from branch_sales s where s.location_id = any($1::bigint[]) order by s.created_at desc, s.id desc limit 80`, [ids],
  );
  const requests = await db.query(
    `select sr.*, coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'unit', p.unit) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = sr.id), '[]'::jsonb) as items
     from supply_requests sr where sr.location_id = any($1::bigint[]) order by sr.created_at desc, sr.id desc limit 80`, [ids],
  );
  const today = manilaToday();

  const branches = locations.map((l) => {
    const stockRows = inventories.filter((i) => i.location_id === l.id);
    const branchSales = sales.filter((s) => s.location_id === l.id).slice(0, 12);
    const branchRequests = requests.filter((r) => r.location_id === l.id);
    const open = branchRequests.filter((r) => OPEN.includes(r.status));
    const requested = new Set<number>(open.flatMap((r) => r.items.map((i: Row) => i.product_id)));
    const stock = materials.filter((m) => m.location_id === l.id).map((material) => ({ material, ...evaluate(material) }));
    const statuses = stock.map((row) => row.status);

    const needsAttention: Row[] = [];
    for (const row of stock) {
      if (!['critical', 'out'].includes(row.status)) continue;
      if (row.material.warehouse_product_id !== null && requested.has(row.material.warehouse_product_id)) continue;
      needsAttention.push({
        label: row.material.name, alert: row.status === 'out' ? 'No stock' : 'Critical stock',
        detail: `${attentionText(row.material.name, row.material.unit, row)} · No open supply request for this item.`,
      });
    }
    for (const r of branchRequests) {
      // Carbon compared the date at midnight with now, so a target of today already counts.
      if (SHIPPED.includes(r.status) && r.target_delivery_date && r.target_delivery_date <= today) {
        needsAttention.push({ label: r.request_number, alert: 'Overdue shipment', detail: 'Dispatched/delivered but past target delivery date.' });
      }
    }
    return {
      id: l.id, name: l.name, branch_code: l.branch_code, address: l.address, city: l.city, province: l.province, contact_number: l.contact_number, brand: l.brand,
      preferred_branch_type: l.preferred_branch_type, operator: l.franchisee?.user ?? null, is_active: l.is_active, location_label: locationLabel(l), portal_active: portalActive(l), is_demo: Boolean(l.is_demo),
      archived_at: l.archived_at, archive_reason: l.archive_reason, archived_by: l.archived_by, portal_path: '/branch-portal/login',
      product_count: stockRows.length, materials_count: statuses.length,
      low_stock_count: statuses.filter((s) => s === 'low').length, critical_stock_count: statuses.filter((s) => s === 'critical').length, out_of_stock_count: statuses.filter((s) => s === 'out').length,
      stock_status: branchStatus(statuses), open_request_count: open.length,
      pending_review_count: branchRequests.filter((r) => r.status === 'submitted').length, awaiting_endorsement_count: branchRequests.filter((r) => r.status === 'under_review').length,
      open_supply_requests: open.map((r) => ({
        id: r.id, request_number: r.request_number, status: r.status, target_delivery_date: r.target_delivery_date,
        items: r.items.map((i: Row) => ({ product: i.product ? { name: i.product.name } : null, quantity_requested: Math.round(Number(i.quantity_requested)) })),
      })),
      needs_attention: needsAttention, last_delivery: l.last_delivered_at ? { delivered_at: l.last_delivered_at } : null, next_delivery_target: l.next_delivery_target,
      last_activity_at: latest([branchSales[0]?.created_at, branchRequests[0]?.updated_at]),
      inventory: stockRows.map((i) => {
        const daily = Number(i.consumed) / 30;
        return {
          id: i.id, product: i.product, current_stock: Math.round(Number(i.current_stock)), reorder_level: Math.round(Number(i.reorder_level)), critical_level: Math.round(Number(i.critical_level)),
          stock_status: stockStatus(i), estimated_days_left: daily <= 0 ? null : Math.max(0, round(Number(i.current_stock) / daily, 1)), updated_at: i.updated_at,
        };
      }),
      recent_deductions: branchSales.map((s) => ({
        id: s.id, sale_number: s.sale_number, notes: s.notes, recorded_by: s.recorded_by, total_quantity: Math.round(s.items.reduce((sum: number, i: Row) => sum + Number(i.quantity), 0)),
        items: s.items.map((i: Row) => ({ id: i.id, product: i.product, quantity: Math.round(Number(i.quantity)), balance_before: Math.round(Number(i.balance_before)), balance_after: Math.round(Number(i.balance_after)) })),
        created_at: s.created_at,
      })),
    };
  });
  const current = branches.filter((b) => !b.archived_at);
  const total = (key: 'materials_count' | 'low_stock_count' | 'critical_stock_count' | 'out_of_stock_count' | 'open_request_count') => branches.reduce((sum, b) => sum + b[key], 0);
  return ok(c, {
    summary: {
      active_branches: current.length, with_portal_account: current.filter((b) => !b.is_demo && b.portal_active).length, demo_with_portal_account: current.filter((b) => b.is_demo && b.portal_active).length,
      archived_branches: branches.length - current.length, materials_tracked: total('materials_count'), low_stock_items: total('low_stock_count'), critical_stock_items: total('critical_stock_count'),
      out_of_stock_items: total('out_of_stock_count'), open_requests: total('open_request_count'),
    },
    branches, live_sync_seconds: LIVE_SYNC_SECONDS, server_time: new Date().toISOString(),
  });
});

const loadBranch = async (c: Context<AppEnv>, db: Db): Promise<Row> => {
  const [location] = await db.query(`select ${LOCATION_COLUMNS} from franchise_locations l where l.id = $1`, [routeId(c, 'location')]);
  requireFound(location);
  if (location.type !== 'franchise') abort(404, 'This site is not a branch.');
  return location;
};

branchRoutes.get('/branches/:location/operations', adminOrLogistics, async (c) => {
  const { db, costingEnabled } = c.get('deps');
  const l = await loadBranch(c, db);
  const materials = await db.query(
    `select m.*, (select to_jsonb(b) from profittrack_material_balances b where b.material_id = m.id limit 1) as balance,
       (select jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku) from products p where p.id = m.warehouse_product_id) as warehouse_product
     from profittrack_materials m where m.location_id = $1 and m.is_active = true order by m.name`, [l.id],
  );
  // Recent production usage, for the informational days-of-cover figure. Voiding a batch restores its
  // materials without writing a movement, so voided batches are left out here. (The original filtered on
  // type 'consumption', which the ledger never writes, so this always read as no usage.)
  const usage = await db.query(
    `select m.material_id, sum(m.quantity_delta_milli) as used from profittrack_material_movements m
     where m.location_id = $1 and m.type = 'production_consumption' and m.occurred_at >= now() - ($2::int * interval '1 day')
       and not exists (select 1 from profittrack_production_batches b where b.operation_id = m.operation_id and b.voided_at is not null)
     group by m.material_id`, [l.id, USAGE_WINDOW_DAYS],
  );
  const inventory = materials.map((m) => {
    const stock = evaluate(m);
    const usedPerDay = Math.abs(Number(usage.find((u) => u.material_id === m.id)?.used ?? 0)) / 1000 / USAGE_WINDOW_DAYS;
    const reference = Math.max(stock.on_hand, stock.low_level, stock.critical_level);
    const value = m.balance?.value_cents ?? null;
    const unitCost = m.balance?.unit_cost_micropesos ?? null;
    return {
      id: m.id, name: m.name, variant: m.variant, unit: m.unit, source: m.source, warehouse_product: m.warehouse_product, on_hand: stock.on_hand, on_hand_display: formatQuantity(stock.on_hand, m.unit, reference),
      unit_cost: unitCost === null ? null : round(Number(unitCost) / 1_000_000, 2), stock_value: value === null ? null : round(Number(value) / 100, 2),
      daily_usage: round(usedPerDay, 3), days_cover: usedPerDay > 0 ? round(stock.on_hand / usedPerDay, 1) : null, low_level: stock.low_level, critical_level: stock.critical_level,
      low_level_display: formatQuantity(stock.low_level, m.unit, reference), critical_level_display: formatQuantity(stock.critical_level, m.unit, reference), reorder_level: stock.low_level,
      status: stock.status, status_label: STOCK_LABELS[stock.status], reason: stock.status === 'ok' ? null : attentionText(m.name, m.unit, stock), updated_at: m.balance?.updated_at ?? null,
    };
  });
  const order: Record<string, number> = { out: 0, critical: 1, low: 2 };
  const labels: Record<string, string> = { out: 'No stock', critical: 'Critical stock', low: 'Low stock' };
  const needsAttention = inventory.filter((r) => r.status !== 'ok').sort((a, b) => order[a.status] - order[b.status] || a.on_hand - b.on_hand).map((r) => ({
    material_id: r.id, label: r.name + (r.variant ? ` · ${r.variant}` : ''), alert: labels[r.status], status: r.status, on_hand: r.on_hand, unit: r.unit, low_level: r.low_level, critical_level: r.critical_level, reason: r.reason, detail: r.reason,
  }));
  const ITEMS = `coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'name', p.name, 'unit', p.unit) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = sr.id), '[]'::jsonb) as items`;
  const active = await db.query(`select sr.*, ${ITEMS} from supply_requests sr where sr.location_id = $1 and sr.status in (${sqlList(SUBMITTED_OPEN)}) order by sr.id desc`, [l.id]);
  const delivered = await db.query(
    `select sr.*, ${ITEMS}, (select d.delivered_at from deliveries d where d.supply_request_id = sr.id limit 1) as delivered_on from supply_requests sr where sr.location_id = $1 and sr.status in (${sqlList(DELIVERED_ON)}) order by sr.id desc limit 50`, [l.id],
  );
  const activeRequests = active.map((r) => ({
    id: r.id, request_number: r.request_number, status: r.status, target_delivery_date: r.target_delivery_date, created_at: r.created_at,
    items: r.items.map((i: Row) => ({ product_id: i.product_id, name: i.product?.name ?? i.product_name_snapshot, unit: i.product?.unit ?? i.unit_snapshot, quantity: Number(i.quantity_requested) })),
  }));
  const deliveries = delivered.map((r) => ({
    id: r.id, request_number: r.request_number, delivered_at: r.delivered_on ?? r.branch_received_at ?? r.updated_at, item_count: r.items.length,
    items: r.items.map((i: Row) => ({ name: i.product?.name ?? i.product_name_snapshot ?? 'Item', unit: i.product?.unit ?? i.unit_snapshot, quantity: Number(i.quantity_requested) })),
  }));
  const count = (status: string) => inventory.filter((r) => r.status === status).length;
  return ok(c, {
    branch: {
      id: l.id, name: l.name, branch_code: l.branch_code, brand: l.brand, brand_type: l.preferred_branch_type, address: l.address, city: l.city, province: l.province, contact_number: l.contact_number,
      operator: l.franchisee?.user ?? null, is_active: l.is_active, location_label: locationLabel(l), portal_active: portalActive(l), is_demo: Boolean(l.is_demo), archived_at: l.archived_at, archive_reason: l.archive_reason,
      archived_by: l.archived_by, last_activity_at: latest([l.last_delivered_at, activeRequests[0]?.created_at, deliveries[0]?.delivered_at]),
    },
    inventory,
    inventory_summary: {
      items: inventory.length, materials: inventory.length, status: branchStatus(inventory.map((r) => r.status)),
      ...(costingEnabled ? { value: round(inventory.reduce((sum, r) => sum + Number(r.stock_value ?? 0), 0), 2) } : {}),
      low: count('low'), critical: count('critical'), out: count('out'), normal: count('ok'),
    },
    active_requests: activeRequests, needs_attention: needsAttention, deliveries,
    thresholds: { basis: 'material_levels', description: "Based on each material's low and critical levels" },
    server_time: new Date().toISOString(),
  });
});

branchRoutes.patch('/branches/:location/materials/:material/levels', logistics, async (c) => {
  const { db } = c.get('deps');
  const locationId = routeId(c, 'location');
  requireFound((await db.query(`select id from franchise_locations where id = $1`, [locationId]))[0]);
  const [material] = await db.query(`select * from profittrack_materials where id = $1`, [routeId(c, 'material')]);
  requireFound(material);
  if (material.location_id !== locationId) abort(404, 'Record not found.');
  const input = await readInput(c);
  const reset = boolParam(input.reset);
  let low: number;
  let critical: number;
  if (reset) {
    const defaults = defaultLevels(material.unit);
    low = defaults.low;
    critical = defaults.critical;
  } else {
    const v = await validate(db, input, { low_level: ['required', 'numeric', 'max:999999999'], critical_level: ['required', 'numeric', 'max:999999999'] });
    low = Number(v.low_level);
    critical = Number(v.critical_level);
    if (low < 0) fail('low_level', 'The low level cannot be negative.');
    if (critical < 0) fail('critical_level', 'The critical level cannot be negative.');
    if (critical >= low) fail('critical_level', 'The critical level must be lower than the low level.');
  }
  const saved = await updateRow(db, 'profittrack_materials', material.id, { low_level: round(low, 3), critical_level: round(critical, 3) });
  await audit(c, db, reset ? 'branch_material.levels_reset' : 'branch_material.levels_updated', { type: MATERIAL, id: material.id },
    { low_level: material.low_level, critical_level: material.critical_level }, { low_level: saved!.low_level, critical_level: saved!.critical_level, unit: material.unit, location_id: locationId });
  return ok(c, pick(saved!, ['id', 'name', 'unit', 'low_level', 'critical_level']), 'Stock levels saved.');
});

async function requireReason(c: Context<AppEnv>, db: Db, message: string): Promise<string> {
  const input = await readInput(c);
  if (input.reason === null || input.reason === undefined) fail('reason', message);
  const v = await validate(db, input, { reason: ['required', 'string', 'min:3', 'max:1000'] });
  return String(v.reason).trim();
}

branchRoutes.post('/branches/:location/archive', admin, async (c) => {
  const { db } = c.get('deps');
  const location = await loadBranch(c, db);
  const reason = await requireReason(c, db, 'Enter why this branch is archived.');
  if (location.archived_at) fail('reason', 'This branch is already archived.');
  const saved = await updateRow(db, 'franchise_locations', location.id, { is_active: false, archived_at: new Date(), archived_by_user_id: c.get('user').id, archive_reason: reason });
  await audit(c, db, 'branch.archived', { type: LOCATION, id: location.id }, pick(location, ['is_active', 'archived_at', 'archive_reason']), pick(saved!, ['is_active', 'archived_at', 'archived_by_user_id', 'archive_reason']));
  return ok(c, pick(saved!, ['id', 'name', 'archived_at', 'archive_reason']), 'Branch archived.');
});

branchRoutes.post('/branches/:location/restore', admin, async (c) => {
  const { db } = c.get('deps');
  const location = await loadBranch(c, db);
  if (!location.archived_at) fail('branch', 'This branch is not archived.');
  const saved = await updateRow(db, 'franchise_locations', location.id, { is_active: true, archived_at: null, archived_by_user_id: null, archive_reason: null });
  await audit(c, db, 'branch.restored', { type: LOCATION, id: location.id }, pick(location, ['is_active', 'archived_at', 'archived_by_user_id', 'archive_reason']), { is_active: true, archived_at: null });
  return ok(c, pick(saved!, ['id', 'name', 'is_active']), 'Branch restored.');
});

async function branchAccount(c: Context<AppEnv>, db: Db): Promise<Row> {
  const locationId = routeId(c, 'location');
  requireFound((await db.query(`select id from franchise_locations where id = $1`, [locationId]))[0]);
  const [user] = await db.query(`select u.* from franchise_locations l join franchisees f on f.id = l.franchisee_id join users u on u.id = f.user_id where l.id = $1`, [locationId]);
  return user;
}

branchRoutes.post('/branches/:location/deactivate-account', admin, async (c) => {
  const { db, auth } = c.get('deps');
  const reason = await requireReason(c, db, 'Enter why this account is deactivated.');
  const user = await branchAccount(c, db);
  if (!user) fail('account', 'No franchisee account is linked to this branch.');
  await updateRow(db, 'users', user.id, { account_status: 'inactive', suspended_from: null, suspended_until: null });
  if (user.auth_user_id) await auth.revokeAll(user.auth_user_id);
  await audit(c, db, 'franchisee.account_deactivated', { type: USER, id: user.id }, { account_status: user.account_status }, { account_status: 'inactive', reason, branch_id: routeId(c, 'location') });
  return ok(c, { user_id: user.id, account_status: 'inactive' }, 'Franchisee account deactivated.');
});

branchRoutes.post('/branches/:location/reactivate-account', admin, async (c) => {
  const { db } = c.get('deps');
  const user = await branchAccount(c, db);
  if (!user) fail('account', 'No franchisee account is linked to this branch.');
  await updateRow(db, 'users', user.id, { account_status: 'active' });
  await audit(c, db, 'franchisee.account_reactivated', { type: USER, id: user.id }, { account_status: user.account_status }, { account_status: 'active', branch_id: routeId(c, 'location') });
  return ok(c, { user_id: user.id, account_status: 'active' }, 'Franchisee account reactivated.');
});
