// SupplyRequestController.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, Filter, fail, insertRow, intParam, manilaToday, ok, paginate, perPage, routeId, updateRow, ValidationError } from '../lib/http.ts';
import { readInput, validate, validateEach } from '../lib/validate.ts';
import { downloadDocument, MAX_UPLOAD_KB, storeDocument } from '../lib/files.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { notifyRoles } from '../services/notifications.ts';
import { resolveWorkspace } from '../services/branchAccess.ts';
import { supplyTransition } from '../services/supplyWorkflow.ts';

export const supplyRoutes = new Hono<AppEnv>();
const MODEL = 'App\\Models\\SupplyRequest';
const DELIVERY = 'App\\Models\\Delivery';
const REVISION = 'App\\Models\\SupplyRequestDateRevision';
const STATUSES = ['draft', 'submitted', 'under_review', 'endorsed', 'rejected', 'preparing', 'dispatched', 'delivered', 'completed', 'cancelled'];
const ACTIVE = ['under_review', 'endorsed', 'preparing', 'dispatched', 'delivered'];
const OPEN = ['submitted', 'under_review', 'endorsed', 'preparing', 'dispatched'];
const STAGE_LABELS: Row = { submitted: 'Submitted', under_review: 'Under review', endorsed: 'Endorsed', preparing: 'Preparing', dispatched: 'Dispatched', delivered: 'Delivered' };
const viewers = role('admin', 'logistics', 'franchisee');
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const day = (s: string) => s.slice(0, 10);
const NAME = (expr: string, extra = '') => `(select jsonb_build_object('id', u.id, 'full_name', u.full_name${extra}) from users u where u.id = ${expr})`;
const CREATED_ON = `(sr.created_at at time zone 'Asia/Manila')::date`;

async function ownLocationIds(c: Context<AppEnv>, db: Db): Promise<number[]> {
  const location = await resolveWorkspace(db, c.get('user'));
  if (!location) abort(403, 'Your account must be assigned to exactly one active branch. Contact an administrator.');
  return [location!.id];
}

async function scoped(c: Context<AppEnv>, db: Db): Promise<Filter> {
  const f = new Filter();
  const name = roleName(c);
  if (name === 'franchisee') {
    const [id] = await ownLocationIds(c, db);
    f.add(`sr.location_id = ? and (sr.requested_by_user_id = ? or sr.status <> 'draft')`, id, c.get('user').id);
  }
  if (name === 'logistics') f.add(`sr.status not in ('draft', 'submitted')`);
  return f;
}

async function assertAccess(c: Context<AppEnv>, db: Db, sr: Row) {
  const name = roleName(c);
  if (name === 'logistics' && ['draft', 'submitted'].includes(sr.status)) abort(404, 'Record not found.');
  if (name !== 'franchisee') return;
  const owns = (await ownLocationIds(c, db)).includes(sr.location_id);
  const creator = sr.requested_by_user_id === c.get('user').id;
  if (!owns || (!creator && sr.status === 'draft')) abort(403, 'You cannot access this supply request.');
}

const load = async (c: Context<AppEnv>): Promise<Row> => requireFound((await c.get('deps').db.query(`select * from supply_requests where id = $1`, [routeId(c, 'supplyRequest')]))[0]);
const revisionsOf = (db: Db, id: number) => db.query(`select * from supply_request_date_revisions where supply_request_id = $1 order by id`, [id]);
const pendingRevision = (revisions: Row[]) => revisions.filter((r) => r.status === 'pending').pop() ?? null;

function effectiveDate(sr: Row, revisions: Row[]): string | null {
  const confirmed = revisions.filter((r) => r.status === 'confirmed').pop();
  return confirmed?.revised_delivery_date ?? sr.target_delivery_date ?? null;
}

const LOCATION_BRAND = (a: string) => `(select to_jsonb(l) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = l.brand_id)) from franchise_locations l where l.id = ${a}.location_id)`;
const ITEMS = (a: string) => `coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select to_jsonb(p) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = ${a}.id), '[]'::jsonb)`;
const DELIVERY_DOCS = (a: string) => `(select to_jsonb(d) || jsonb_build_object('documents', coalesce((select jsonb_agg(to_jsonb(doc) order by doc.id) from documents doc where doc.documentable_type = 'App\\Models\\Delivery' and doc.documentable_id = d.id), '[]'::jsonb)) from deliveries d where d.supply_request_id = ${a}.id limit 1)`;
const REVISIONS = (a: string) => `coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from supply_request_date_revisions r where r.supply_request_id = ${a}.id), '[]'::jsonb)`;
const fullRow = async (db: Db, id: number) => {
  const [row] = await db.query(
    `select sr.*, ${LOCATION_BRAND('sr')} as location, ${ITEMS('sr')} as items, ${DELIVERY_DOCS('sr')} as delivery, ${REVISIONS('sr')} as date_revisions from supply_requests sr where sr.id = $1`, [id],
  );
  return { ...row, effective_delivery_date: effectiveDate(row, row.date_revisions) };
};

// ---- dashboards ----
async function countsByStatus(db: Db, f: Filter): Promise<Row> {
  const rows = await db.query(`select sr.status, count(*)::int as n from supply_requests sr ${f.where} group by sr.status`, f.params);
  return Object.fromEntries(STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
}

supplyRoutes.get('/supply-requests/stats', viewers, async (c) => {
  const { db } = c.get('deps');
  const f = await scoped(c, db);
  const byStatus = await countsByStatus(db, f);
  const where = f.where ? `${f.where} and` : 'where';
  const today = manilaToday();
  const [{ overdue }] = await db.query(`select count(*)::int as overdue from supply_requests sr ${where} sr.status in ('submitted','under_review','endorsed','preparing','dispatched') and sr.target_delivery_date < '${today}'::date`, f.params);
  const [{ done }] = await db.query(
    `select count(*)::int as done from supply_requests sr ${where} sr.status = 'completed' and sr.completed_at >= date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila' and sr.completed_at <= now()`, f.params,
  );
  // MySQL's datediff counts calendar days, so this compares dates rather than elapsed hours.
  const [{ avg }] = await db.query(
    `select avg((sr.completed_at at time zone 'Asia/Manila')::date - (sr.created_at at time zone 'Asia/Manila')::date) as avg from supply_requests sr ${where} sr.status = 'completed' and sr.completed_at is not null`, f.params,
  );
  return ok(c, {
    total: Object.values(byStatus).reduce((a: number, b) => a + Number(b), 0), by_status: byStatus, active: OPEN.reduce((a, s) => a + byStatus[s], 0),
    overdue, completed_this_month: done, avg_fulfillment_days: Math.round(Number(avg ?? 0) * 10) / 10,
  });
});

supplyRoutes.get('/supply-requests/pipeline', role('admin', 'logistics'), async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  await validate(db, q, { from: ['nullable', 'date'], to: ['nullable', 'date', 'after_or_equal:from'] });
  const f = await scoped(c, db);
  if (q.from) f.add(`${CREATED_ON} >= ?::date`, day(q.from));
  if (q.to) f.add(`${CREATED_ON} <= ?::date`, day(q.to));
  const byStatus = await countsByStatus(db, f);
  const where = f.where ? `${f.where} and` : 'where';
  const today = manilaToday();
  const latest = async (extra: string) => (await db.query(`select sr.request_number from supply_requests sr ${where} ${extra} order by sr.id desc limit 1`, f.params))[0]?.request_number ?? null;
  const latestNumber = await latest('true');
  const latestToday = await latest(`${CREATED_ON} = '${today}'::date`);
  const latestIn = (status: string) => latest(`sr.status = '${status}'`);
  const open = `sr.status in (${Object.keys(STAGE_LABELS).map((s) => `'${s}'`).join(',')})`;
  const [counts] = await db.query(
    `select count(*) filter (where ${open})::int as queue, count(*) filter (where ${open} and sr.target_delivery_date < '${today}'::date)::int as critical,
       count(*) filter (where ${CREATED_ON} = '${today}'::date)::int as today from supply_requests sr ${f.where}`, f.params,
  );
  const cycles = await db.query(`select sr.created_at, sr.completed_at from supply_requests sr ${where} sr.status = 'completed' and sr.completed_at is not null`, f.params);
  const daysBetween = (a: unknown, b: unknown) => Math.max(0, new Date(b as string).getTime() - new Date(a as string).getTime()) / 86400000;
  const avgCycle = cycles.length ? Math.round((cycles.reduce((sum, r) => sum + daysBetween(r.created_at, r.completed_at), 0) / cycles.length) * 10) / 10 : 0;
  const rows = await db.query(
    `select sr.*, (select l.name from franchise_locations l where l.id = sr.location_id) as branch,
       (select array_agg(distinct p.category) from supply_request_items si join products p on p.id = si.product_id where si.supply_request_id = sr.id and p.category is not null) as categories
     from supply_requests sr ${f.where} order by sr.id desc limit 12`, f.params,
  );
  const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dispatchedLatest = await latestIn('dispatched');
  const deliveredLatest = await latestIn('delivered');
  return ok(c, {
    stages: Object.entries(STAGE_LABELS).map(([key, label]) => ({ key, label, count: byStatus[key] ?? 0 })),
    kpis: {
      today: { value: counts.today, meta: latestToday ? `Latest: ${latestToday}` : latestNumber ? `Latest: ${latestNumber}` : 'Nothing queued yet' },
      approved: { value: ['endorsed', 'preparing', 'dispatched', 'delivered', 'completed'].reduce((a, s) => a + byStatus[s], 0), meta: 'Endorsed and beyond' },
      queue: { value: counts.queue, critical: counts.critical },
      route_to_branch: { value: byStatus.dispatched, meta: dispatchedLatest ? `Latest: ${dispatchedLatest}` : 'Nothing in transit' },
      branch_confirmation: { value: byStatus.delivered, meta: deliveredLatest ? `Latest: ${deliveredLatest}` : 'No deliveries pending' },
    },
    avg_cycle_time: avgCycle,
    rows: rows.map((sr) => {
      const days = Math.round(daysBetween(sr.created_at, sr.completed_at ?? new Date()) * 10) / 10;
      return {
        id: sr.request_number, branch: sr.branch ?? '—', category: sr.categories?.length ? sr.categories.join(', ') : 'General',
        stage: STAGE_LABELS[sr.status] ?? (sr.status[0].toUpperCase() + sr.status.slice(1).replace(/_/g, ' ')), queue_days: days,
        last_update: stamp.format(new Date(sr.updated_at)).replace(/,(?=[^,]*$)/, ','), cycle_days: days,
      };
    }),
  });
});

supplyRoutes.get('/supply-requests/active-counts', viewers, async (c) => {
  const { db } = c.get('deps');
  const f = await scoped(c, db);
  const by = await countsByStatus(db, f);
  const result: Row = Object.fromEntries(ACTIVE.map((s) => [s, by[s]]));
  return ok(c, { ...result, active_total: ACTIVE.reduce((a, s) => a + by[s], 0) });
});

async function availabilityData(db: Db, id: number) {
  const [warehouse] = await db.query(`select * from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
  if (!warehouse) fail('warehouse', 'No active warehouse location is configured.');
  const rows = await db.query(
    `select si.product_id, si.quantity_requested, p.name, coalesce((select i.current_stock from inventories i where i.location_id = $1 and i.product_id = si.product_id), 0) as stock
     from supply_request_items si join products p on p.id = si.product_id where si.supply_request_id = $2 order by si.id`, [warehouse.id, id],
  );
  const items = rows.map((r) => {
    const requested = Number(r.quantity_requested);
    const stock = Number(r.stock);
    return { product_id: r.product_id, product_name: r.name, requested, warehouse_stock: stock, available: stock >= requested, shortage: Math.max(0, requested - stock) };
  });
  return { warehouse, items, all_available: items.every((i) => i.available) };
}

supplyRoutes.get('/supply-requests', viewers, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = await scoped(c, db);
  if (q.view !== undefined) {
    if (q.view === 'active') f.add(`sr.status in (${ACTIVE.map((s) => `'${s}'`).join(',')})`);
    else if (q.view === 'history') f.add(`sr.status in ('completed', 'cancelled', 'rejected')`);
    else abort(422, 'The view must be active or history.');
  }
  if (q.status) f.add('sr.status = ?', q.status);
  if (q.location_id) f.add('sr.location_id = ?', intParam(q.location_id));
  if (q.from) f.add(`${CREATED_ON} >= ?::date`, day(q.from));
  if (q.to) f.add(`${CREATED_ON} <= ?::date`, day(q.to));
  if (q.search) f.add('sr.request_number ilike ?', `%${q.search}%`);
  const page = await paginate(c, db, {
    columns: `sr.*, ${LOCATION_BRAND('sr')} as location, ${NAME('sr.requested_by_user_id')} as requested_by, ${ITEMS('sr')} as items, ${DELIVERY_DOCS('sr')} as delivery, ${REVISIONS('sr')} as date_revisions`,
    from: 'supply_requests sr', where: f.clauses, params: f.params, orderBy: 'sr.created_at desc, sr.id desc', perPage: perPage(c, 20),
  });
  const body = await page.json();
  const [warehouse] = await db.query(`select id from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
  const needsStock = body.data.some((sr: Row) => sr.status === 'under_review');
  const productIds = needsStock ? [...new Set(body.data.flatMap((sr: Row) => sr.items.map((i: Row) => i.product_id)))] : [];
  const stock = new Map(warehouse && productIds.length
    ? (await db.query(`select product_id, current_stock from inventories where location_id = $1 and product_id = any($2::bigint[])`, [warehouse.id, `{${productIds.join(',')}}`])).map((r) => [r.product_id, Number(r.current_stock)])
    : []);
  const data = body.data.map((sr: Row) => {
    const pending = sr.date_revisions.some((r: Row) => r.status === 'pending');
    let reason: string | null = null;
    if (sr.status === 'under_review') {
      if (pending) reason = 'Waiting for Logistics to confirm the new delivery date';
      else if (!warehouse) reason = 'No active warehouse location is configured.';
      else if (sr.items.some((i: Row) => (stock.get(i.product_id) ?? 0) < Number(i.quantity_requested))) reason = 'insufficient stock';
    }
    return { ...sr, effective_delivery_date: effectiveDate(sr, sr.date_revisions), pending_date_revision: pending, can_endorse: reason === null, endorse_block_reason: reason };
  });
  return c.json({ ...body, data });
});

const itemRules = { product_id: ['required', 'exists:products,id'], quantity_requested: ['required', 'numeric', 'min:0.01'] };

function assertDistinctProducts(items: Row[]) {
  const seen = new Set();
  items.forEach((item, index) => {
    if (seen.has(Number(item.product_id))) fail(`items.${index}.product_id`, 'The items product id field has a duplicate value.');
    seen.add(Number(item.product_id));
  });
}

async function assertProductsMatchBrand(db: Db, location: Row, items: Row[]) {
  const ids = [...new Set(items.map((i) => Number(i.product_id)))];
  const [{ n }] = await db.query<{ n: number }>(`select count(*)::int as n from products where id = any($1::bigint[]) and brand_id is not distinct from $2::bigint`, [`{${ids.join(',')}}`, location.brand_id]);
  if (n !== ids.length) fail('items', 'One or more products do not belong to this branch brand.');
}

async function generateRequestNumber(db: Db): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('');
    const number = `FT-${manilaToday().replace(/-/g, '')}-${random}`;
    if (!(await db.query(`select 1 from supply_requests where request_number = $1`, [number])).length) return number;
  }
}

const insertItems = async (tx: Db, id: number, items: Row[]) => {
  for (const item of items) await insertRow(tx, 'supply_request_items', { supply_request_id: id, product_id: item.product_id, quantity_requested: item.quantity_requested });
};

supplyRoutes.post('/supply-requests', role('franchisee', 'admin'), async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const input = await readInput(c);
  const v = await validate(db, input, {
    location_id: ['required', 'exists:franchise_locations,id'], submit: ['nullable', 'boolean'], target_delivery_date: ['nullable', 'date', 'after_or_equal:today'],
    delivery_address: ['required', 'string'], remarks: ['nullable', 'string'], items: ['required', 'array', 'min:1', 'max:100'],
  });
  const items = await validateEach(db, v.items, 'items', itemRules);
  assertDistinctProducts(items);
  const [location] = await db.query(`select * from franchise_locations where id = $1`, [v.location_id]);
  if (roleName(c) === 'franchisee') {
    const own = await resolveWorkspace(db, user);
    if (!own || own.id !== location.id) abort(403, 'You can only request supplies for your assigned active branch.');
  }
  await assertProductsMatchBrand(db, location, items);
  const status = v.submit ?? true ? 'submitted' : 'draft';
  const created = await db.tx(async (tx) => {
    const row = await insertRow(tx, 'supply_requests', {
      request_number: await generateRequestNumber(tx), location_id: v.location_id, requested_by_user_id: user.id, status,
      target_delivery_date: v.target_delivery_date ?? null, delivery_address: v.delivery_address, remarks: v.remarks ?? null,
    });
    await insertItems(tx, row.id, items);
    await insertRow(tx, 'supply_request_status_histories', {
      supply_request_id: row.id, from_status: null, to_status: status, remarks: status === 'submitted' ? 'Request submitted.' : 'Draft request created.', changed_by_user_id: user.id,
    });
    return row;
  });
  if (status === 'submitted') await notifyRoles(db, ['admin'], 'supply_request_submitted', 'New supply request', `${created.request_number} requires review.`, { supply_request_id: created.id });
  await audit(c, db, 'supply_request.created', { type: MODEL, id: created.id }, null, { ...created, items });
  const history = await db.query(`select h.*, ${NAME('h.changed_by_user_id')} as changed_by from supply_request_status_histories h where h.supply_request_id = $1 order by h.id`, [created.id]);
  return ok(c, { ...(await fullRow(db, created.id)), status_history: history }, 'Supply request created.', 201);
});

supplyRoutes.get('/supply-requests/:supplyRequest', viewers, async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const [row] = await db.query(
    `select sr.*, (select to_jsonb(l) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = l.brand_id),
         'franchisee', (select to_jsonb(f) || jsonb_build_object('user', ${NAME('f.user_id', `, 'email', u.email`)}) from franchisees f where f.id = l.franchisee_id)) from franchise_locations l where l.id = sr.location_id) as location,
       ${NAME('sr.requested_by_user_id', `, 'email', u.email`)} as requested_by, ${NAME('sr.reviewed_by_user_id')} as reviewed_by, ${NAME('sr.endorsed_by_user_id')} as endorsed_by,
       coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select to_jsonb(p) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = p.brand_id)) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = sr.id), '[]'::jsonb) as items,
       (select to_jsonb(d) || jsonb_build_object('documents', coalesce((select jsonb_agg(to_jsonb(doc) || jsonb_build_object('uploaded_by', ${NAME('doc.uploaded_by_user_id')}) order by doc.id) from documents doc where doc.documentable_type = 'App\\Models\\Delivery' and doc.documentable_id = d.id), '[]'::jsonb)) from deliveries d where d.supply_request_id = sr.id limit 1) as delivery,
       coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('proposed_by', ${NAME('r.proposed_by_user_id')}) order by r.id) from supply_request_date_revisions r where r.supply_request_id = sr.id), '[]'::jsonb) as date_revisions
     from supply_requests sr where sr.id = $1`, [sr.id],
  );
  const availability = await availabilityData(db, sr.id);
  const groups = new Map<number, Row>();
  const categories = await db.query(`select p.id as product_id, p.category_id, p.name, p.unit, (select pc.name from product_categories pc where pc.id = p.category_id) as category_name from supply_request_items si join products p on p.id = si.product_id where si.supply_request_id = $1 order by si.id`, [sr.id]);
  for (const item of row.items) {
    const product = categories.find((x) => x.product_id === item.product_id);
    const line = availability.items.find((i) => i.product_id === item.product_id)!;
    const id = product?.category_id ?? 0;
    if (!groups.has(id)) groups.set(id, { category_id: id || null, category_name: product?.category_name ?? 'Uncategorized', lines: [] });
    groups.get(id)!.lines.push({ product_id: item.product_id, product_name: product?.name, unit: product?.unit, requested: Number(item.quantity_requested), warehouse_stock: line.warehouse_stock, shortage: line.shortage, short: line.shortage > 0 });
  }
  const pending = pendingRevision(row.date_revisions);
  let reason: string | null = null;
  if (sr.status === 'under_review') {
    if (pending) reason = 'Waiting for Logistics to confirm the new delivery date';
    else if (!availability.all_available) reason = 'insufficient stock';
  }
  const histories = await db.query(`select * from supply_request_status_histories where supply_request_id = $1 order by id`, [sr.id]);
  const staff = ['admin', 'logistics'].includes(roleName(c));
  const preparing = histories.find((h) => h.to_status === 'preparing');
  let stockSnapshot = null;
  if (preparing && Array.isArray(preparing.payload)) {
    const now = new Map((await db.query(`select product_id, current_stock from inventories where location_id = $1`, [availability.warehouse.id])).map((r) => [r.product_id, Number(r.current_stock)]));
    stockSnapshot = preparing.payload.map((line: Row) => {
      const productId = Number(line.product_id ?? 0);
      const p = categories.find((x) => x.product_id === productId);
      return { product_id: productId, product_name: p?.name ?? null, unit: p?.unit ?? null, stock_before: Number(line.stock_before ?? 0), deducted: Number(line.quantity_deducted ?? 0), stock_after: Number(line.stock_after ?? 0), stock_now: now.get(productId) ?? 0 };
    });
  }
  const d = row.delivery;
  const payload: Row = {
    ...row,
    effective_delivery_date: effectiveDate(row, row.date_revisions),
    pending_date_revision: pending,
    line_groups: [...groups.values()],
    can_endorse: reason === null,
    endorse_block_reason: reason,
    stock_snapshot: stockSnapshot,
    delivery_confirmation: d?.delivered_at ? {
      confirmed_by_type: d.confirmed_by_party, confirmed_by_user_id: d.delivered_by_user_id, confirmed_at: iso(d.acknowledged_at) ?? iso(d.delivered_at), recipient_name: d.recipient_name, note: d.notes,
    } : null,
    status_history: histories.map((h) => ({ from: h.from_status, to: h.to_status, actor_user_id: h.changed_by_user_id, at: iso(h.created_at), ...(staff ? { remarks: h.remarks } : {}) })),
  };
  if (staff) {
    payload.stock_check = ['under_review', 'endorsed'].includes(sr.status) ? {
      sufficient: availability.all_available,
      lines: availability.items.map((i) => ({ product_name: i.product_name, required: i.requested, available: i.warehouse_stock, shortage: i.shortage })),
    } : null;
  }
  return ok(c, payload);
});

supplyRoutes.get('/supply-requests/:supplyRequest/availability', viewers, async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  return ok(c, await availabilityData(db, sr.id));
});

supplyRoutes.put('/supply-requests/:supplyRequest', role('franchisee', 'admin'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  if (sr.status !== 'draft') fail('status', 'Only draft requests can be edited.');
  const v = await validate(db, await readInput(c), {
    target_delivery_date: ['nullable', 'date', 'after_or_equal:today'], delivery_address: ['sometimes', 'required', 'string'], remarks: ['nullable', 'string'], items: ['sometimes', 'array', 'min:1', 'max:100'],
  });
  const { items: rawItems, ...fields } = v;
  const items = rawItems ? await validateEach(db, rawItems, 'items', itemRules) : null;
  if (items) {
    assertDistinctProducts(items);
    const [location] = await db.query(`select * from franchise_locations where id = $1`, [sr.location_id]);
    await assertProductsMatchBrand(db, location, items);
  }
  await db.tx(async (tx) => {
    await updateRow(tx, 'supply_requests', sr.id, fields);
    if (items) {
      await tx.query(`delete from supply_request_items where supply_request_id = $1`, [sr.id]);
      await insertItems(tx, sr.id, items);
    }
  });
  await audit(c, db, 'supply_request.draft_updated', { type: MODEL, id: sr.id }, sr, v);
  return ok(c, await fullRow(db, sr.id), 'Draft request updated.');
});

function assertTransitionRole(name: string, to: string, sr: Row, actorId: number) {
  const allowed: Row = {
    franchisee: ['submitted', 'cancelled'],
    admin: ['submitted', 'cancelled', 'under_review', 'endorsed', 'rejected', 'completed'],
    logistics: ['preparing', 'dispatched', 'delivered'],
  };
  if (!(allowed[name] ?? []).includes(to)) abort(403, 'Your role cannot perform this supply request transition.');
  if (name === 'franchisee' && sr.requested_by_user_id !== actorId) abort(403, 'This action is unauthorized.');
  if (name === 'franchisee' && to === 'cancelled' && sr.status !== 'submitted') fail('status', 'A request can only be cancelled while it is still submitted.');
}

supplyRoutes.patch('/supply-requests/:supplyRequest/status', viewers, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const v = await validate(db, await readInput(c), { status: ['required', `in:${STATUSES.join(',')}`], remarks: ['nullable', 'string'] });
  const to = v.status;
  assertTransitionRole(roleName(c), to, sr, user.id);
  if (to === 'endorsed' && sr.status === 'endorsed') return ok(c, await fullRow(db, sr.id), 'Supply request is already endorsed.');
  if (['cancelled', 'rejected'].includes(to)) {
    if (!String(v.remarks ?? '').trim()) fail('remarks', 'A reason is required to cancel or reject a request.');
    if (['dispatched', 'delivered', 'completed'].includes(sr.status)) fail('status', 'This request is already dispatched or delivered, so it cannot be cancelled or rejected in the system. Handle it outside the system.');
  }
  if (to === 'endorsed') {
    if (pendingRevision(await revisionsOf(db, sr.id))) fail('status', 'Waiting for Logistics to confirm the new delivery date.');
    if (!(await availabilityData(db, sr.id)).all_available) fail('inventory', 'The request cannot be endorsed because one or more items have insufficient warehouse stock.');
  }
  await supplyTransition(db, sr.id, sr.status, to, user, v.remarks ?? null);
  if (['cancelled', 'rejected'].includes(to) && ['endorsed', 'preparing'].includes(sr.status)) {
    await notifyRoles(db, ['logistics'], 'supply_request_stopped', `Supply request ${to}`, `${sr.request_number} was ${to}.`, { supply_request_id: sr.id });
  }
  if (to === 'endorsed') await notifyRoles(db, ['logistics'], 'supply_request_endorsed', 'Supply request endorsed', `${sr.request_number} is ready for fulfillment.`, { supply_request_id: sr.id });
  await audit(c, db, 'supply_request.status_changed', { type: MODEL, id: sr.id }, { status: sr.status }, { status: to });
  return ok(c, await fullRow(db, sr.id), 'Supply request status updated.');
});

supplyRoutes.post('/supply-requests/:supplyRequest/date-revision', role('admin'), async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  if (!['under_review', 'endorsed'].includes(sr.status)) fail('status', 'A new delivery date can only be proposed while the request is under review or endorsed.');
  const v = await validate(db, await readInput(c), { revised_delivery_date: ['required', 'date'], note: ['nullable', 'string'] });
  const revised = String(v.revised_delivery_date).slice(0, 10);
  if (revised <= manilaToday()) fail('revised_delivery_date', 'The revised delivery date field must be a date after today.');
  const revision = await db.tx(async (tx) => {
    await tx.query(`update supply_request_date_revisions set status = 'superseded' where supply_request_id = $1 and status = 'pending'`, [sr.id]);
    const row = await insertRow(tx, 'supply_request_date_revisions', {
      supply_request_id: sr.id, original_delivery_date: sr.target_delivery_date, revised_delivery_date: revised, note: v.note ?? null, status: 'pending', proposed_by_user_id: user.id,
    });
    await insertRow(tx, 'supply_request_status_histories', {
      supply_request_id: sr.id, from_status: sr.status, to_status: sr.status, remarks: 'Delivery date revision proposed.',
      payload: { original_delivery_date: sr.target_delivery_date, revised_delivery_date: revised }, changed_by_user_id: user.id,
    });
    return row;
  });
  await notifyRoles(db, ['logistics'], 'supply_request_date_proposed', 'New delivery date proposed', `${sr.request_number} has a proposed new delivery date.`, { supply_request_id: sr.id, revision_id: revision.id });
  await notifyRoles(db, ['admin'], 'supply_request_date_waiting', 'Waiting for Logistics', `${sr.request_number}: waiting for Logistics to confirm the new delivery date.`, { supply_request_id: sr.id, revision_id: revision.id });
  return ok(c, revision, 'Delivery date revision proposed.', 201);
});

supplyRoutes.post('/supply-requests/:supplyRequest/date-revision/confirm', role('logistics'), async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const revision = pendingRevision(await revisionsOf(db, sr.id));
  if (!revision) fail('date', 'There is no pending delivery date to confirm.');
  const availability = await availabilityData(db, sr.id);
  if (!availability.all_available) {
    throw new ValidationError({
      inventory: ['The new delivery date cannot be confirmed because one or more items have insufficient warehouse stock.'],
      shortages: [JSON.stringify(availability.items.filter((i) => !i.available))],
    });
  }
  await db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from supply_request_date_revisions where id = $1 for update`, [revision!.id]);
    if (locked.status !== 'pending') fail('date', 'This delivery date was already handled.');
    await updateRow(tx, 'supply_request_date_revisions', locked.id, { status: 'confirmed', confirmed_by_user_id: user.id, confirmed_at: new Date() });
    if (sr.status === 'under_review') await supplyTransition(tx, sr.id, sr.status, 'endorsed', user);
    await tx.query(`update system_notifications set read_at = now() where type = 'supply_request_date_waiting' and read_at is null and (data ->> 'supply_request_id')::bigint = $1`, [sr.id]);
  });
  await notifyRoles(db, ['admin'], 'supply_request_date_confirmed', 'Delivery date confirmed', `${sr.request_number}: Logistics confirmed the new delivery date.`, { supply_request_id: sr.id, revision_id: revision!.id });
  await audit(c, db, 'supply_request.date_confirmed', { type: REVISION, id: revision!.id }, null, { revised_delivery_date: revision!.revised_delivery_date });
  const [row] = await db.query(`select sr.*, ${REVISIONS('sr')} as date_revisions from supply_requests sr where sr.id = $1`, [sr.id]);
  return ok(c, { ...row, effective_delivery_date: effectiveDate(row, row.date_revisions) }, 'Delivery date confirmed and request endorsed.');
});

supplyRoutes.post('/supply-requests/:supplyRequest/pod', role('logistics'), async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const sr = await load(c);
  if (!['dispatched', 'delivered', 'completed'].includes(sr.status)) fail('status', 'Proof of delivery can only be uploaded after dispatch.');
  const v = await validate(db, await readInput(c), {
    file: ['required', 'file', 'mimes:pdf,jpg,jpeg,png', `max:${MAX_UPLOAD_KB}`], recipient_name: ['nullable', 'string', 'max:255'], notes: ['nullable', 'string'],
  });
  const fields = { delivery_date: manilaToday(), delivered_by_user_id: user.id, recipient_name: v.recipient_name ?? null, notes: v.notes ?? null };
  const [existing] = await db.query(`select id from deliveries where supply_request_id = $1`, [sr.id]);
  const delivery = existing ? await updateRow(db, 'deliveries', existing.id, fields) : await insertRow(db, 'deliveries', { supply_request_id: sr.id, ...fields });
  const document = await storeDocument(c, db, v.file, `supply-requests/${sr.id}/pod`, { type: DELIVERY, id: delivery!.id }, 'proof_of_delivery');
  await audit(c, db, 'delivery.pod_uploaded', { type: DELIVERY, id: delivery!.id }, null, { document_id: document.id });
  return ok(c, document, 'Proof of delivery uploaded.', 201);
});

supplyRoutes.post('/supply-requests/:supplyRequest/review', role('admin'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  if (sr.status !== 'submitted') return ok(c, await fullRow(db, sr.id), 'Supply request already reviewed.');
  await supplyTransition(db, sr.id, sr.status, 'under_review', c.get('user'));
  await audit(c, db, 'supply_request.reviewed', { type: MODEL, id: sr.id }, { status: 'submitted' }, { status: 'under_review' });
  return ok(c, await fullRow(db, sr.id), 'Supply request marked as under review.');
});

supplyRoutes.post('/supply-requests/:supplyRequest/acknowledge', role('franchisee'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  if (['delivered', 'completed'].includes(sr.status)) return ok(c, await fullRow(db, sr.id), 'Receipt already confirmed.');
  if (sr.status !== 'dispatched') fail('status', 'The delivery cannot be acknowledged yet.');
  const v = await validate(db, await readInput(c), { recipient_name: ['required', 'string', 'max:255'], notes: ['nullable', 'string'] });
  await supplyTransition(db, sr.id, sr.status, 'delivered', c.get('user'), 'Receipt confirmed by branch.', 'branch');
  const [delivery] = await db.query(`select id from deliveries where supply_request_id = $1`, [sr.id]);
  const saved = await updateRow(db, 'deliveries', delivery.id, { recipient_name: v.recipient_name, acknowledged_at: new Date(), notes: v.notes ?? null });
  await notifyRoles(db, ['admin', 'logistics'], 'supply_request_receipt_confirmed', 'Receipt confirmed', `Request ${sr.request_number} was received by the branch.`, { supply_request_id: sr.id });
  await audit(c, db, 'delivery.acknowledged', { type: DELIVERY, id: delivery.id }, null, saved);
  return ok(c, saved, 'Receipt of supplies acknowledged.');
});

supplyRoutes.get('/supply-requests/:supplyRequest/documents/:document/download', viewers, async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const [delivery] = await db.query(`select id from deliveries where supply_request_id = $1`, [sr.id]);
  const [document] = await db.query(`select * from documents where id = $1 and documentable_type = $2 and documentable_id = $3`, [routeId(c, 'document'), DELIVERY, delivery?.id ?? 0]);
  return downloadDocument(c, requireFound(document));
});
