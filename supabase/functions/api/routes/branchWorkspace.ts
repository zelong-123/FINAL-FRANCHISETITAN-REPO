// BranchWorkspaceController: raw materials, production and receiving for one branch.
// The branch comes from the signed-in franchisee; Admin and Logistics pass branch_code.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, fail, manilaToday, ok, paginate, perPage, routeId, updateRow, ValidationError } from '../lib/http.ts';
import { readInput, validate, validateEach } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { resolveWorkspace } from '../services/branchAccess.ts';
import * as ledger from '../services/ledger.ts';
import { readCsv, warehouse } from '../services/inventory.ts';
import { receiveLines, recordCost, requirementsFor, resolveBrandProduct, syncRecipe } from '../services/branchStock.ts';
import { notifyRoles } from '../services/notifications.ts';
import { DELIVERED_ON, sqlList, STATUSES as SUPPLY_STATUSES } from '../services/supplyStatus.ts';

export const workspaceRoutes = new Hono<AppEnv>();
const anyBranchRole = role('admin', 'logistics', 'franchisee');
const franchisee = role('franchisee');
const admin = role('admin');
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const brandOf = async (db: Db, id: number | null) => (id ? (await db.query(`select * from brands where id = $1`, [id]))[0] ?? null : null);
const brandBrief = (brand: Row | null) => (brand ? { id: brand.id, name: brand.name } : null);

/** Franchisee: own branch. Admin and Logistics: explicit branch_code (read-only previews). */
async function location(c: Context<AppEnv>): Promise<Row> {
  const { db } = c.get('deps');
  const user = c.get('user');
  if (roleName(c) === 'franchisee') {
    const own = await resolveWorkspace(db, user);
    if (!own) abort(403, 'Your account must be assigned to exactly one active branch.');
    return { ...own, brand: await brandOf(db, own!.brand_id) };
  }
  if (!['admin', 'logistics'].includes(roleName(c))) abort(403, 'This action is unauthorized.');
  const code = String((await readInput(c)).branch_code ?? '').trim();
  const [found] = await db.query(`select * from franchise_locations where branch_code = $1 and type = 'franchise' and is_active = true`, [code]);
  if (!found) abort(404, 'The requested branch site is not configured.');
  return { ...found, brand: await brandOf(db, found.brand_id) };
}

// SupplyRequest's $appends: a confirmed date revision replaces the target date.
const EFFECTIVE_DATE = (a: string) => `coalesce((select r.revised_delivery_date from supply_request_date_revisions r where r.supply_request_id = ${a}.id and r.status = 'confirmed' order by r.id desc limit 1), ${a}.target_delivery_date) as effective_delivery_date`;
const ITEMS = (a: string) => `coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select jsonb_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unit', p.unit) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = ${a}.id), '[]'::jsonb) as items`;

workspaceRoutes.get('/branch/workspace/warehouse-products', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const store = await warehouse(db);
  const products = await db.query(
    `select p.*, (select pc.name from product_categories pc where pc.id = p.category_id) as category_name,
       (select i.current_stock from inventories i where i.location_id = $1 and i.product_id = p.id limit 1) as available
     from products p where p.brand_id = $2 and p.is_active = true order by p.name`,
    [store.id, loc.brand_id],
  );
  return ok(c, {
    brand: brandBrief(loc.brand),
    products: products.map((p) => ({ id: p.id, sku: p.sku, name: p.name, category: p.category_name ?? p.category, unit: p.unit, available: Number(p.available ?? 0) })),
  });
});

workspaceRoutes.get('/branch/workspace/supply-requests', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, c.req.query(), { date: ['nullable', 'date_format:Y-m-d'], status: ['nullable', `in:${SUPPLY_STATUSES.join(',')}`] });
  const clauses = ['sr.location_id = $1'];
  const params: unknown[] = [loc.id];
  if (!boolParam(c.req.query('include_draft'))) clauses.push(`sr.status <> 'draft'`);
  if (v.date) { params.push(v.date); clauses.push(`(sr.created_at at time zone 'Asia/Manila')::date = $${params.length}`); }
  if (v.status) { params.push(v.status); clauses.push(`sr.status = $${params.length}`); }
  const rows = await db.query(
    `select sr.*, ${EFFECTIVE_DATE('sr')}, ${ITEMS('sr')},
       (select jsonb_build_object('id', d.id, 'supply_request_id', d.supply_request_id, 'delivered_at', d.delivered_at) from deliveries d where d.supply_request_id = sr.id limit 1) as delivery
     from supply_requests sr where ${clauses.join(' and ')} order by sr.id desc limit 50`,
    params,
  );
  return ok(c, rows);
});

workspaceRoutes.get('/branch/workspace/receivable-requests', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const rows = await db.query(
    `select sr.*, ${EFFECTIVE_DATE('sr')}, ${ITEMS('sr')} from supply_requests sr where sr.location_id = $1 and sr.status in (${sqlList(DELIVERED_ON)}) order by sr.id desc limit 50`, [loc.id],
  );
  const keys = await db.query(`select idempotency_key from profittrack_material_movements where location_id = $1 and idempotency_key like 'delivery-cost-%'`, [loc.id]);
  const costed = new Set(keys.map((k) => Number(String(k.idempotency_key).split('-')[2])));
  return ok(c, rows.map((r) => ({ ...r, received_at: r.branch_received_at, cost_recorded: costed.has(r.id) })));
});

workspaceRoutes.post('/branch/workspace/receive-stock', franchisee, async (c) => {
  const { db, costingEnabled } = c.get('deps');
  const user = c.get('user');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), {
    supply_request_id: ['required', 'integer', 'exists:supply_requests,id'], total_cost_cents: ['nullable', 'integer', 'min:0'], lines: ['required', 'array', 'min:1', 'max:100'],
  });
  const lines = await validateEach(db, v.lines, 'lines', { product_id: ['required', 'integer'], quantity: ['required', 'numeric', 'gt:0'], total_cost_cents: ['nullable', 'integer', 'min:0'] });
  const seen = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (seen.has(line.product_id)) fail(`lines.${index}.product_id`, 'The lines product id field has a duplicate value.');
    seen.add(line.product_id);
  }
  const total = Number(v.total_cost_cents ?? 0);
  const [request] = await db.query(`select * from supply_requests where location_id = $1 and id = $2`, [loc.id, v.supply_request_id]);
  requireFound(request);
  if (!DELIVERED_ON.includes(request.status)) fail('supply_request_id', 'Only delivered requests can be received.');
  // Quantities reach the branch only through Confirm Receipt (good quantity only); afterwards this records the cost.
  // Only a request completed under the previous workflow without a branch credit is received here.
  if (!request.branch_received_at && request.status !== 'completed') fail('supply_request_id', 'Confirm the receipt of this delivery first (good, damaged and short per item).');
  const byProduct = new Map<number, Row>(lines.map((l) => [l.product_id, l]));
  const totalQuantity = lines.reduce((sum, l) => sum + Number(l.quantity), 0);
  // The cost is split by confirmed quantity; with no line costs the branch value still reconciles.
  const costFor = (line: Row) => (line.total_cost_cents !== undefined && line.total_cost_cents !== null ? Number(line.total_cost_cents)
    : totalQuantity > 0 ? Math.round(total * (Number(line.quantity) / totalQuantity)) : Math.trunc(total / Math.max(1, lines.length)));
  if (request.branch_received_at) {
    await db.tx((tx) => recordCost(tx, request, user, byProduct, total));
    return ok(c, { created_materials: [], cost_recorded: true }, 'Receipt cost recorded. The quantities were already added when the receipt was confirmed.');
  }
  const received = await db.tx((tx) => receiveLines(tx, request, user, byProduct, costFor, costingEnabled));
  return ok(c, received, 'Delivered items were added to branch raw materials.');
});

// ---- Production ----
const PRODUCTION_ROW = `b.*, (select r.name from profittrack_recipes r where r.id = b.recipe_id) as product_name,
  (select u.full_name from profittrack_operations o join users u on u.id = o.recorded_by_user_id where o.id = b.operation_id) as submitted_by,
  coalesce((select sum(c.total_cost_cents) from profittrack_production_consumptions c where c.batch_id = b.id), 0) as consumed_cents`;
const productionRow = (b: Row): Row => ({
  id: b.id, date: b.created_at, product: b.product_name ?? 'Product', quantity: Number(b.quantity_pieces), submitted_by: b.submitted_by ?? 'Branch user',
  material_cost: round2(Number(b.total_cost_cents) / 100), voided: b.voided_at !== null, void_reason: b.void_reason,
});
const monthLabel = (year: number, month: number) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;

workspaceRoutes.get('/branch/workspace/production-dashboard', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const period = c.req.query('period') === 'year' ? 'year' : 'month';
  const count = period === 'year' ? 6 : 12;
  const [year, month] = manilaToday().split('-').map(Number);
  const start = period === 'year' ? new Date(Date.UTC(year - count + 1, 0, 1)) : new Date(Date.UTC(year, month - count, 1));
  const batches = await db.query(
    `select b.quantity_pieces, to_char(b.created_at at time zone 'Asia/Manila', 'YYYY-MM') as month_key,
       coalesce((select sum(c.total_cost_cents) from profittrack_production_consumptions c where c.batch_id = b.id), 0) as consumed_cents
     from profittrack_production_batches b where b.location_id = $1 and b.voided_at is null and b.created_at >= ($2::date::timestamp at time zone 'Asia/Manila')`,
    [loc.id, start.toISOString().slice(0, 10)],
  );
  const sum = (rows: Row[], key: string) => rows.reduce((total, r) => total + Number(r[key]), 0);
  const series = Array.from({ length: count }, (_, index) => {
    const bucket = period === 'year' ? new Date(Date.UTC(start.getUTCFullYear() + index, 0, 1)) : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    // A year bucket takes every month of that year; the original matched January only.
    const key = bucket.toISOString().slice(0, period === 'year' ? 4 : 7);
    const rows = batches.filter((b) => (period === 'year' ? String(b.month_key).startsWith(key) : b.month_key === key));
    return {
      period: key, label: period === 'year' ? String(bucket.getUTCFullYear()) : monthLabel(bucket.getUTCFullYear(), bucket.getUTCMonth() + 1),
      units: sum(rows, 'quantity_pieces'), transactions: rows.length, material_cost: round2(sum(rows, 'consumed_cents') / 100),
    };
  });
  const thisMonth = batches.filter((b) => b.month_key === manilaToday().slice(0, 7));
  const recent = await db.query(`select ${PRODUCTION_ROW} from profittrack_production_batches b where b.location_id = $1 and b.voided_at is null order by b.id desc limit 8`, [loc.id]);
  const threeDays = await db.query(`select ${PRODUCTION_ROW} from profittrack_production_batches b where b.location_id = $1 and b.voided_at is null and b.created_at >= now() - interval '3 days' order by b.id desc limit 50`, [loc.id]);
  return ok(c, {
    period, series,
    summary: { month_units: sum(thisMonth, 'quantity_pieces'), month_material_cost: round2(sum(thisMonth, 'consumed_cents') / 100), month_batches: thisMonth.length, total_units: sum(batches, 'quantity_pieces') },
    recent: recent.map(productionRow), recent_three_days: threeDays.map(productionRow),
  });
});

workspaceRoutes.get('/branch/workspace/production-transactions', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  return paginate(c, db, {
    columns: PRODUCTION_ROW, from: 'profittrack_production_batches b', where: ['b.location_id = $1'], params: [loc.id], orderBy: 'b.id desc', perPage: perPage(c, 15), map: productionRow,
  });
});

workspaceRoutes.get('/branch/workspace/recent-production', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const today = boolParam(c.req.query('today')) ? ` and (b.created_at at time zone 'Asia/Manila')::date = '${manilaToday()}'::date` : '';
  const rows = await db.query(`select ${PRODUCTION_ROW} from profittrack_production_batches b where b.location_id = $1${today} order by b.id desc limit 20`, [loc.id]);
  return ok(c, rows.map(productionRow));
});

function shortageError(shortages: Row[]): never {
  const message = shortages.map((r) => `${r.material} (need ${r.required} ${r.unit}, have ${r.available} ${r.unit})`).join('; ');
  throw new ValidationError({ items: [`Insufficient ingredients: ${message}`], shortages: [JSON.stringify(shortages)] });
}

async function withRecipeNames(db: Db, batches: Row[]) {
  const out: Row[] = [];
  for (const batch of batches) {
    const [recipe] = await db.query(`select id, name from profittrack_recipes where id = $1`, [batch.recipe_id]);
    out.push({ ...batch, recipe: recipe ?? null });
  }
  return out;
}

workspaceRoutes.post('/branch/workspace/produce', franchisee, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { idempotency_key: ['required', 'string', 'max:100'], items: ['required', 'array', 'min:1', 'max:50'] });
  const items = await validateEach(db, v.items, 'items', { recipe_id: ['required', 'integer'], quantity_pieces: ['required', 'integer', 'min:1'] });
  const distinct = new Set<number>();
  for (const [index, item] of items.entries()) {
    if (distinct.has(item.recipe_id)) fail(`items.${index}.recipe_id`, 'The items recipe id field has a duplicate value.');
    distinct.add(item.recipe_id);
  }
  const recipes = await db.query(`select * from profittrack_recipes where location_id = $1 and is_active = true and id = any($2::bigint[])`, [loc.id, `{${[...distinct].join(',')}}`]);
  if (recipes.length !== items.length) fail('items', 'One or more products are not active for this branch.');

  // Every requirement is added up before stock is touched, so all shortages are reported together.
  const required = new Map<number, number>();
  for (const item of items) {
    const recipe = recipes.find((r) => r.id === item.recipe_id)!;
    const ingredients = await db.query(
      `select i.material_id, i.quantity_milli_per_piece from profittrack_recipe_ingredients i join profittrack_recipe_versions v on v.id = i.recipe_version_id where v.recipe_id = $1 and v.version = $2`,
      [recipe.id, recipe.current_version],
    );
    if (!ingredients.length) fail('items', `${recipe.name} has no recipe ingredients configured.`);
    for (const ingredient of ingredients) required.set(ingredient.material_id, (required.get(ingredient.material_id) ?? 0) + Number(ingredient.quantity_milli_per_piece) * item.quantity_pieces);
  }
  const balances = await db.query(
    `select b.material_id, b.quantity_milli, m.name, m.unit from profittrack_material_balances b join profittrack_materials m on m.id = b.material_id where b.location_id = $1 and b.material_id = any($2::bigint[])`,
    [loc.id, `{${[...required.keys()].join(',')}}`],
  );
  const shortages: Row[] = [];
  for (const [material_id, amount] of required) {
    const balance = balances.find((b) => b.material_id === material_id);
    const available = Number(balance?.quantity_milli ?? 0);
    if (!balance || available < amount) shortages.push({ material_id, material: balance?.name ?? 'Material missing', required: round3(amount / 1000), available: round3(available / 1000), unit: balance?.unit ?? '' });
  }
  if (shortages.length) shortageError(shortages);

  const batches = await db.tx(async (tx) => {
    const created: Row[] = [];
    for (const [index, item] of items.entries()) {
      const result = await ledger.produce(tx, loc, user, { recipe_id: item.recipe_id, quantity_pieces: item.quantity_pieces, idempotency_key: `${v.idempotency_key}-${item.recipe_id}-${index}` });
      created.push(result.batch);
    }
    return created;
  });
  return ok(c, { batches: await withRecipeNames(db, batches) }, 'Production submitted and ingredients deducted.', 201);
});

workspaceRoutes.get('/branch/workspace/materials', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const active = boolParam(c.req.query('include_inactive')) ? '' : ' and m.is_active = true';
  return ok(c, await db.query(
    `select m.*, (select to_jsonb(b) from profittrack_material_balances b where b.material_id = m.id limit 1) as balance from profittrack_materials m where m.location_id = $1${active} order by m.name`, [loc.id],
  ));
});

const withImage = (c: Context<AppEnv>, recipe: Row): Row => ({ ...recipe, image_url: recipe.image_path ? c.get('deps').files.publicUrl(recipe.image_path) : null });

workspaceRoutes.get('/branch/workspace/recipes', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const active = boolParam(c.req.query('include_inactive')) ? '' : ' and r.is_active = true';
  const rows = await db.query(`select r.*, ${ledger.RECIPE_RELATIONS('r')} from profittrack_recipes r where r.location_id = $1${active} order by r.name`, [loc.id]);
  return ok(c, rows.map((r) => withImage(c, r)));
});

workspaceRoutes.get('/branch/workspace/products', anyBranchRole, async (c) => {
  const { db, files } = c.get('deps');
  const loc = await location(c);
  const products = await db.query(`select * from brand_products where brand_id = $1 and is_active = true order by name`, [loc.brand_id]);
  const rows: Row[] = [];
  for (const product of products) {
    const ingredients = await resolveBrandProduct(db, product.id, loc);
    rows.push({
      id: product.id, sku: product.sku, name: product.name, description: product.description, image_url: product.image_path ? files.publicUrl(product.image_path) : null,
      ingredients: ingredients.map((row) => ({
        product_id: row.product_id, name: row.name, unit: row.material_unit || row.unit, quantity_per_piece: row.required_milli !== null ? round3(row.required_milli / 1000) : round3(Number(row.quantity_per_piece)),
        batch_amount: row.batch_amount, batch_unit: row.unit, yield_pieces: row.yield_pieces, available: row.available, missing: Boolean(row.missing),
      })),
    });
  }
  const materials = await db.query(`select 1 from profittrack_materials where location_id = $1 and is_active = true limit 1`, [loc.id]);
  return ok(c, { brand: brandBrief(loc.brand), products: rows, has_materials: materials.length > 0 });
});

workspaceRoutes.post('/branch/workspace/produce-product', franchisee, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { idempotency_key: ['required', 'string', 'max:100'], items: ['required', 'array', 'min:1', 'max:50'] });
  const items = await validateEach(db, v.items, 'items', { brand_product_id: ['required', 'integer'], quantity_pieces: ['required', 'integer', 'min:1', 'max:1000000'] });
  const ids = new Set<number>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.brand_product_id)) fail(`items.${index}.brand_product_id`, 'The items brand product id field has a duplicate value.');
    ids.add(item.brand_product_id);
  }
  const products = await db.query(`select * from brand_products where brand_id = $1 and is_active = true and id = any($2::bigint[])`, [loc.brand_id, `{${[...ids].join(',')}}`]);
  if (products.length !== items.length) fail('items', 'One or more products are not published for this branch.');
  const lines: Row[] = [];
  for (const item of items) {
    const product = products.find((p) => p.id === item.brand_product_id)!;
    if (!(await db.query(`select 1 from brand_product_ingredients where brand_product_id = $1 limit 1`, [product.id])).length) fail('items', `${product.name} has no recipe ingredients configured.`);
    lines.push({ product, pieces: item.quantity_pieces });
  }
  const plan = await requirementsFor(db, lines, loc);
  if (plan.shortages.length) {
    shortageError(plan.shortages.map((row: Row) => ({
      material_id: row.material_id, material: row.missing ? `${row.name} (not in branch inventory)` : row.name, required: round3(row.required_milli / 1000), available: round3(row.available_milli / 1000), unit: row.unit,
    })));
  }
  const batches = await db.tx(async (tx) => {
    const created: Row[] = [];
    for (const [index, line] of lines.entries()) {
      // The branch's recipe mirror refreshes just before deducting, so Admin edits never touch old batches.
      const recipe = await syncRecipe(tx, line.product, loc, user);
      // Costing is optional: unvalued ingredients are consumed at zero cost.
      const result = await ledger.produce(tx, loc, user, { recipe_id: recipe.id, quantity_pieces: line.pieces, idempotency_key: `${v.idempotency_key}-${line.product.id}-${index}`, allow_unvalued: true });
      created.push(result.batch);
    }
    return created;
  });
  return ok(c, { batches: await withRecipeNames(db, batches) }, 'Production submitted and ingredients deducted from branch stock.', 201);
});

workspaceRoutes.put('/branch/workspace/recipes/:recipe', admin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const id = routeId(c, 'recipe');
  const [recipe] = await db.query(`select id, location_id from profittrack_recipes where id = $1`, [id]);
  requireFound(recipe);
  if (recipe.location_id !== loc.id) abort(404, 'Record not found.');
  const v = await validate(db, await readInput(c), {
    name: ['required', 'string', 'max:150'], standard_price_cents: ['nullable', 'integer', 'min:0'], is_active: ['sometimes', 'boolean'], ingredients: ['required', 'array', 'min:1', 'max:100'],
  });
  const ingredients = await validateEach(db, v.ingredients, 'ingredients', { material_id: ['required', 'integer'], quantity: ['required', 'numeric', 'gt:0'], unit: ['nullable', 'string', 'max:20'] });
  const seen = new Set<number>();
  for (const [index, row] of ingredients.entries()) {
    if (seen.has(row.material_id)) fail(`ingredients.${index}.material_id`, 'The ingredients material id field has a duplicate value.');
    seen.add(row.material_id);
  }
  const fields: Row = { name: v.name, ingredients };
  if (v.standard_price_cents !== null && v.standard_price_cents !== undefined) fields.standard_price_cents = v.standard_price_cents;
  return ok(c, withImage(c, await ledger.updateRecipe(db, loc, c.get('user'), id, fields)), 'Recipe saved.');
});

// Production belongs to the branch: only the franchisee voids, only today's batch, and Admin is told.
workspaceRoutes.post('/branch/workspace/production/:batch/void', franchisee, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loc = await location(c);
  const id = routeId(c, 'batch');
  const [batch] = await db.query(`select id, location_id, (created_at at time zone 'Asia/Manila')::date::text as made_on from profittrack_production_batches where id = $1`, [id]);
  requireFound(batch);
  if (batch.location_id !== loc.id) abort(404, 'Record not found.');
  if (batch.made_on !== manilaToday()) abort(403, "The branch can void only today's production.");
  const input = await readInput(c);
  if (input.reason === null || input.reason === undefined) fail('reason', 'Enter a reason for voiding this production.');
  const v = await validate(db, input, { reason: ['required', 'string', 'max:1000'] });
  const reason = String(v.reason).trim();
  const voided = await ledger.voidProduction(db, loc, user, id, reason);
  const [recipe] = await db.query(`select id, name from profittrack_recipes where id = $1`, [voided.recipe_id]);
  await notifyRoles(db, ['admin'], 'production_voided', 'Production voided by a branch',
    `${loc.name} (${loc.branch_code}) voided ${voided.quantity_pieces} x ${recipe?.name ?? 'product'}. Reason: ${reason}`,
    { production_batch_id: voided.id, branch_code: loc.branch_code }, user);
  return ok(c, { ...voided, recipe: recipe ?? null }, 'Production voided and ingredient stock restored.');
});

// ---- Raw material CSV ----
workspaceRoutes.get('/branch/workspace/materials-template', anyBranchRole, (c) => {
  const csv = c.get('deps').costingEnabled
    ? 'material_name,variant,unit,quantity,unit_cost\r\nCaramel Syrup,Original,bottle,10,350.00\r\nFresh Milk,Full Cream,L,20,95.00\r\n'
    : 'material_name,variant,unit,quantity\r\nCaramel Syrup,Original,bottle,10\r\nFresh Milk,Full Cream,L,20\r\n';
  return c.body(csv, 200, { 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': 'attachment; filename="raw_materials_template.csv"' });
});

function parseMaterials(csv: string) {
  const rows = readCsv(csv.replace(/^﻿/, ''), ',');
  if (!rows.length) fail('csv', 'The CSV file is empty.');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  for (const column of ['material_name', 'variant', 'unit', 'quantity']) {
    if (!header.includes(column)) fail('csv', `The CSV is missing the "${column}" column.`);
  }
  const records: { line: number; values: Record<string, string> }[] = [];
  rows.slice(1).forEach((fields, index) => {
    if (!fields.some((cell) => cell.trim() !== '')) return;
    records.push({ line: index + 2, values: Object.fromEntries(header.map((key, i) => [key, (fields[i] ?? '').trim()])) });
  });
  if (records.length > 2000) fail('csv', 'Import at most 2000 rows at a time.');
  return records;
}

const numeric = (text: string) => text !== '' && !Number.isNaN(Number(text));

async function previewMaterials(db: Db, loc: Row, csv: string) {
  const records = parseMaterials(csv);
  const units = new Map((await db.query(`select name from units`)).map((u) => [String(u.name).toLowerCase(), u.name]));
  const products = new Map((await db.query(`select id, name from products where brand_id = $1 and is_active = true`, [loc.brand_id])).map((p) => [String(p.name).trim().toLowerCase(), p]));
  const existing = await db.query(`select * from profittrack_materials where location_id = $1`, [loc.id]);
  const rows: Row[] = [];
  const errors: Row[] = [];
  for (const { line, values } of records) {
    const name = values.material_name ?? '';
    const variant = values.variant ?? '';
    const unit = values.unit ?? '';
    const quantity = values.quantity ?? '';
    const unitCost = (values.unit_cost ?? '') === '' ? '0' : values.unit_cost;
    if (name === '') { errors.push({ line, message: 'Material name is required.' }); continue; }
    if (!units.has(unit.toLowerCase())) { errors.push({ line, message: `Unit "${unit}" is not in the shared unit list.` }); continue; }
    if (!numeric(quantity) || Number(quantity) <= 0) { errors.push({ line, message: 'Quantity must be greater than zero.' }); continue; }
    if (!numeric(unitCost) || Number(unitCost) < 0) { errors.push({ line, message: 'Unit cost must be zero or more.' }); continue; }
    const product = products.get(name.toLowerCase());
    const key = `${name.toLowerCase()}|${variant.toLowerCase()}|${unit.toLowerCase()}`;
    const match = existing.find((m) => `${String(m.name).toLowerCase()}|${String(m.variant).toLowerCase()}|${String(m.unit).toLowerCase()}` === key);
    rows.push({
      line, key, material_name: name, variant, unit: units.get(unit.toLowerCase()), quantity: Number(quantity), unit_cost: Number(unitCost), source: match?.source ?? (product ? 'Warehouse' : 'Manual'),
      warehouse_product_id: match?.warehouse_product_id ?? product?.id ?? null, duplicate: Boolean(match), in_inventory: Boolean(match),
    });
  }
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
  const duplicates: Row[] = [];
  for (const [key, group] of groups) {
    const inFile = group.length > 1;
    if (!inFile && !group[0].duplicate) continue;
    duplicates.push({
      key, label: group[0].material_name + (group[0].variant ? ` · ${group[0].variant}` : ''), in_file: inFile, in_inventory: group[0].duplicate, rows: group.map((r) => ({ line: r.line, quantity: r.quantity })),
    });
  }
  return { rows, errors, duplicates, valid_count: rows.length, error_count: errors.length, groups };
}

workspaceRoutes.post('/branch/workspace/materials-preview', anyBranchRole, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { csv: ['required', 'string', 'max:1048576'] });
  const { groups: _groups, ...preview } = await previewMaterials(db, loc, v.csv);
  return ok(c, preview);
});

workspaceRoutes.post('/branch/workspace/materials-import', franchisee, async (c) => {
  const { db, costingEnabled } = c.get('deps');
  const user = c.get('user');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { csv: ['required', 'string', 'max:1048576'], resolutions: ['nullable', 'array_or_object'] });
  const resolutions: Record<string, string> = v.resolutions ?? {};
  for (const [key, choice] of Object.entries(resolutions)) {
    if (!['combine', 'remove'].includes(String(choice))) fail(`resolutions.${key}`, `The selected resolutions.${key} is invalid.`);
  }
  const preview = await previewMaterials(db, loc, v.csv);
  if (preview.error_count > 0) throw new ValidationError({ csv: ['Fix the row errors before applying the import.'], errors: [JSON.stringify(preview.errors)] });
  if (!preview.rows.length) fail('csv', 'The file has no importable rows.');
  const unresolved = preview.duplicates.filter((d) => !['combine', 'remove'].includes(resolutions[d.key]));
  if (unresolved.length) throw new ValidationError({ duplicates: ['Choose Combine or Remove for every duplicate material.'], unresolved: [JSON.stringify(unresolved)] });

  let created = 0;
  await db.tx(async (tx) => {
    for (const [key, all] of preview.groups) {
      const choice = resolutions[key];
      const first = all[0];
      let rows = all;
      // "Remove" discards a material already held; on duplicate lines it keeps only the first line.
      if (all.length > 1 && choice === 'remove') rows = all.slice(0, 1);
      else if (first.in_inventory && choice === 'remove') continue;
      const quantity = rows.reduce((sum, r) => sum + r.quantity, 0);
      const totalCost = Math.round(rows.reduce((sum, r) => sum + r.quantity * r.unit_cost, 0) * 100);
      // The original looked up manual materials by warehouse id -1, so re-importing one always hit
      // the unique index and failed. Manual materials are matched by name, variant and unit here.
      const [found] = first.warehouse_product_id !== null
        ? await tx.query(`select * from profittrack_materials where location_id = $1 and warehouse_product_id = $2 limit 1`, [loc.id, first.warehouse_product_id])
        : await tx.query(`select * from profittrack_materials where location_id = $1 and lower(name) = lower($2) and lower(variant) = lower($3) and lower(unit) = lower($4) limit 1`, [loc.id, first.material_name, first.variant, first.unit]);
      let material = found;
      if (!material) {
        material = await ledger.addMaterial(tx, loc, user, { name: first.material_name, variant: first.variant, unit: first.unit, source: first.source ?? 'Manual', warehouse_product_id: first.warehouse_product_id });
        created += 1;
      }
      await ledger.receive(tx, loc, user, {
        material_id: material.id, quantity_milli: Math.round(quantity * 1000), total_cost_cents: totalCost, reason: 'Raw material CSV import', idempotency_key: `csv-${crypto.randomUUID()}`,
      }, costingEnabled);
    }
  });
  return ok(c, { created, updated: preview.rows.length - created }, 'Raw materials imported.');
});

workspaceRoutes.post('/branch/workspace/recipes/:recipe/image', admin, async (c) => {
  const { db, files } = c.get('deps');
  const loc = await location(c);
  const id = routeId(c, 'recipe');
  const [recipe] = await db.query(`select id, location_id from profittrack_recipes where id = $1`, [id]);
  requireFound(recipe);
  if (recipe.location_id !== loc.id) abort(404, 'Record not found.');
  const v = await validate(db, await readInput(c), { image: ['required', 'file', 'mimes:jpg,jpeg,png,webp', 'max:5120'] });
  const file = v.image as File;
  const path = `product-images/${loc.id}/${crypto.randomUUID()}.${file.name.split('.').pop()!.toLowerCase()}`;
  await files.put('public', path, new Uint8Array(await file.arrayBuffer()), file.type);
  await updateRow(db, 'profittrack_recipes', id, { image_path: path, updated_by_user_id: c.get('user').id });
  return ok(c, { image_path: path, image_url: files.publicUrl(path) }, 'Product picture saved.');
});
