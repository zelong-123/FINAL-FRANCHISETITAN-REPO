// ProfitTrackController + ProfitTrackPreviewController + ProfitTrackCsvPreview.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Row } from '../lib/db.ts';
import { abort, boolParam, fail, ok, paginate, perPage, routeId } from '../lib/http.ts';
import { readInput, validate, validateEach } from '../lib/validate.ts';
import { role, roleName } from '../lib/middleware.ts';
import { resolveWorkspace } from '../services/branchAccess.ts';
import * as ledger from '../services/ledger.ts';

export const profitTrackRoutes = new Hono<AppEnv>();
const branchOrAdmin = role('franchisee', 'admin');
const admin = role('admin');
const franchisee = role('franchisee');
const NO_BRANCH = { branch_code: ['prohibited'], location_id: ['prohibited'] };

async function location(c: Context<AppEnv>): Promise<Row> {
  const { db } = c.get('deps');
  const input = await readInput(c);
  if (roleName(c) === 'franchisee') {
    if (input.branch_code || input.location_id) abort(422, 'Branch identifiers are not accepted; the workspace comes from your account.');
    const own = await resolveWorkspace(db, c.get('user'));
    if (!own) abort(404, 'ProfitTrack workspace unavailable.');
    return own!;
  }
  const code = String(input.branch_code ?? '').trim();
  if (!code) abort(422, 'An active branch_code is required for Admin operational actions.');
  const [found] = await db.query(
    `select l.* from franchise_locations l join franchisees f on f.id = l.franchisee_id join applicants a on a.id = f.applicant_id
     where l.branch_code = $1 and l.type = 'franchise' and l.is_active = true and f.franchise_status = 'active' and a.status = 'active_franchisee' and a.archived_at is null`, [code],
  );
  if (!found) abort(404, 'Active branch workspace unavailable.');
  return found;
}

profitTrackRoutes.get('/profittrack/workspace', franchisee, async (c) => {
  const own = await resolveWorkspace(c.get('deps').db, c.get('user'));
  if (!own) abort(404, 'ProfitTrack workspace unavailable. Contact an administrator to verify your branch assignment.');
  return ok(c, { branch: { id: own!.id, name: own!.name, branch_code: own!.branch_code } });
});

profitTrackRoutes.get('/profittrack/dashboard', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const [totals] = await db.query(
    `select (select count(*)::int from profittrack_material_balances where location_id = $1) as materials,
       (select coalesce(sum(quantity_milli), 0) from profittrack_material_balances where location_id = $1) as material_units_milli,
       (select coalesce(sum(value_cents), 0) from profittrack_material_balances where location_id = $1) as raw_material_value_cents,
       (select count(*)::int from profittrack_recipes where location_id = $1 and is_active = true) as products,
       (select coalesce(sum(b.quantity_pieces), 0) from profittrack_finished_balances b join profittrack_recipes r on r.id = b.recipe_id where r.location_id = $1 and r.is_active = true) as finished_pieces`, [loc.id],
  );
  const [month] = await db.query(
    `select coalesce(sum(revenue_cents), 0) as revenue, coalesce(sum(profit_cents), 0) as profit, count(*)::int as sales from profittrack_sales s
     where s.location_id = $1 and s.sold_at >= (date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')
       and not exists (select 1 from profittrack_sale_voids v where v.sale_id = s.id)`, [loc.id],
  );
  return ok(c, {
    branch: { id: loc.id, name: loc.name, branch_code: loc.branch_code },
    summary: {
      materials: totals.materials, material_units_milli: Number(totals.material_units_milli), raw_material_value_cents: Number(totals.raw_material_value_cents), products: totals.products,
      finished_pieces: Number(totals.finished_pieces), month_revenue_cents: Number(month.revenue), month_profit_cents: Number(month.profit), month_sales_count: month.sales,
    },
  });
});

profitTrackRoutes.get('/profittrack/materials', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const active = boolParam(c.req.query('include_inactive')) ? '' : ' and m.is_active = true';
  return ok(c, await db.query(`select m.*, (select to_jsonb(b) from profittrack_material_balances b where b.material_id = m.id limit 1) as balance from profittrack_materials m where m.location_id = $1${active} order by m.name`, [loc.id]));
});

profitTrackRoutes.post('/profittrack/materials', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { ...NO_BRANCH, name: ['required', 'string', 'max:150'], variant: ['nullable', 'string', 'max:100'], unit: ['required', 'string', 'max:30'] });
  if (!(await db.query(`select 1 from units where name = $1`, [v.unit])).length) fail('unit', 'The selected unit is invalid.');
  return ok(c, await ledger.addMaterial(db, loc, c.get('user'), { name: v.name, variant: v.variant, unit: v.unit }), 'Material created.', 201);
});

profitTrackRoutes.post('/profittrack/materials/receive', branchOrAdmin, async (c) => {
  const { db, costingEnabled } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), {
    ...NO_BRANCH, material_id: ['required', 'integer'], quantity_milli: ['required', 'integer', 'min:1'], total_cost_cents: ['nullable', 'integer', 'min:0'], reason: ['nullable', 'string', 'max:2000'], idempotency_key: ['required', 'string', 'max:100'],
  });
  const result = await ledger.receive(db, loc, c.get('user'), v, costingEnabled);
  return ok(c, result, result.duplicate ? 'Receipt retry returned the original transaction.' : 'Receipt recorded.', result.duplicate ? 200 : 201);
});

profitTrackRoutes.post('/profittrack/materials/count', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), {
    ...NO_BRANCH, material_id: ['required', 'integer'], counted_quantity_milli: ['required', 'integer', 'min:0'], reason: ['required', 'string', 'max:2000'], idempotency_key: ['required', 'string', 'max:100'],
  });
  const result = await ledger.physicalCount(db, loc, c.get('user'), v);
  return ok(c, result, result.duplicate ? 'Count retry returned the original count.' : 'Count adjustment posted.', result.duplicate ? 200 : 201);
});

profitTrackRoutes.put('/profittrack/materials/:material/valuation', admin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { unit_cost_micropesos: ['required', 'integer', 'min:0'], reason: ['required', 'string', 'max:2000'] });
  return ok(c, await ledger.setMaterialValuation(db, loc, c.get('user'), routeId(c, 'material'), v), 'Material valuation recorded.');
});

const withImage = (c: Context<AppEnv>, recipe: Row): Row => ({ ...recipe, image_url: recipe.image_path ? c.get('deps').files.publicUrl(recipe.image_path) : null });

profitTrackRoutes.get('/profittrack/recipes', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const active = boolParam(c.req.query('include_inactive')) ? '' : ' and r.is_active = true';
  const rows = await db.query(`select r.*, ${ledger.RECIPE_RELATIONS('r')} from profittrack_recipes r where r.location_id = $1${active} order by r.name`, [loc.id]);
  return ok(c, rows.map((r) => withImage(c, r)));
});

async function recipeInput(c: Context<AppEnv>, required: boolean): Promise<Row> {
  const { db } = c.get('deps');
  const lead = required ? [] : ['sometimes'];
  const v = await validate(db, await readInput(c), {
    location_id: ['prohibited'], image_path: ['nullable', 'string', 'max:255'], is_active: ['sometimes', 'boolean'],
    ingredients: required ? ['required', 'array', 'min:1', 'max:100'] : ['sometimes', 'array', 'min:1', 'max:100'],
    name: [...lead, 'required', 'string', 'max:150'], sku: [...lead, 'required', 'string', 'max:80'], standard_price_cents: ['sometimes', 'nullable', 'integer', 'min:0'],
  });
  if (v.ingredients) {
    v.ingredients = await validateEach(db, v.ingredients, 'ingredients', {
      material_id: ['required', 'integer'], quantity_milli_per_piece: ['nullable', 'integer'], quantity: ['nullable', 'numeric', 'gt:0'], unit: ['nullable', 'string', 'max:20'],
    });
    const seen = new Set<number>();
    for (const [index, row] of v.ingredients.entries()) {
      if (seen.has(row.material_id)) fail(`ingredients.${index}.material_id`, 'The ingredients material id field has a duplicate value.');
      seen.add(row.material_id);
    }
  }
  return v;
}

profitTrackRoutes.post('/profittrack/recipes', admin, async (c) => {
  const loc = await location(c);
  return ok(c, withImage(c, await ledger.createRecipe(c.get('deps').db, loc, c.get('user'), await recipeInput(c, true))), 'Recipe created.', 201);
});

profitTrackRoutes.put('/profittrack/recipes/:recipe', admin, async (c) => {
  const loc = await location(c);
  return ok(c, withImage(c, await ledger.updateRecipe(c.get('deps').db, loc, c.get('user'), routeId(c, 'recipe'), await recipeInput(c, false))), 'Recipe updated.');
});

profitTrackRoutes.post('/profittrack/production', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { ...NO_BRANCH, recipe_id: ['required', 'integer'], quantity_pieces: ['required', 'integer', 'min:1'], idempotency_key: ['required', 'string', 'max:100'] });
  const result = await ledger.produce(db, loc, c.get('user'), v);
  return ok(c, result, result.duplicate ? 'Production retry returned the original batch.' : 'Production recorded.', result.duplicate ? 200 : 201);
});

profitTrackRoutes.get('/profittrack/sales', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  return paginate(c, db, {
    columns: `s.*, coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from profittrack_sale_items i where i.sale_id = s.id), '[]'::jsonb) as items, (select to_jsonb(v) from profittrack_sale_voids v where v.sale_id = s.id limit 1) as void`,
    from: 'profittrack_sales s', where: ['s.location_id = $1'], params: [loc.id], orderBy: 's.sold_at desc', perPage: perPage(c, 30),
  });
});

profitTrackRoutes.post('/profittrack/sales', branchOrAdmin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { ...NO_BRANCH, idempotency_key: ['required', 'string', 'max:100'], items: ['required', 'array', 'min:1', 'max:100'] });
  v.items = await validateEach(db, v.items, 'items', {
    recipe_id: ['required', 'integer'], quantity_pieces: ['required', 'integer', 'min:1'], realized_price_cents: ['nullable', 'integer', 'min:0'], discount_reason: ['nullable', 'string', 'max:2000'],
  });
  const seen = new Set<number>();
  for (const [index, row] of v.items.entries()) {
    if (seen.has(row.recipe_id)) fail(`items.${index}.recipe_id`, 'The items recipe id field has a duplicate value.');
    seen.add(row.recipe_id);
  }
  const result = await ledger.sell(db, loc, c.get('user'), v);
  return ok(c, result, result.duplicate ? 'Sale retry returned the original sale.' : 'Sale recorded.', result.duplicate ? 200 : 201);
});

profitTrackRoutes.post('/profittrack/sales/:sale/void', admin, async (c) => {
  const { db } = c.get('deps');
  const loc = await location(c);
  const v = await validate(db, await readInput(c), { reason: ['required', 'string', 'max:2000'] });
  return ok(c, await ledger.voidSale(db, loc, c.get('user'), routeId(c, 'sale'), v.reason), 'Sale voided and stock restored.');
});

// ---- CSV preview: reads the file only; nothing is imported ----
const MAX_BYTES = 1_048_576;
const MAX_RECORDS = 1000;
const NUMBER = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function records(content: string) {
  const out: { row: number; fields: string[]; error: boolean }[] = [];
  let fields: string[] = [];
  let field = '';
  let state = 'start';
  let error = false;
  let row = 1;
  let startRow = 1;
  const tooMany = () => { if (out.length > MAX_RECORDS) fail('csv', 'CSV exceeds the 1000-record preview limit.'); };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; } else state = 'closed';
      } else {
        field += ch;
        if (ch === '\n' || (ch === '\r' && content[i + 1] !== '\n')) row++;
      }
      continue;
    }
    if (ch === ',' || ch === '\n' || ch === '\r') {
      fields.push(field);
      field = '';
      state = 'start';
      if (ch !== ',') {
        out.push({ row: startRow, fields, error });
        tooMany();
        fields = [];
        error = false;
        if (ch === '\r' && content[i + 1] === '\n') i++;
        startRow = ++row;
      }
      continue;
    }
    if (state === 'start' && ch === '"') state = 'quoted';
    else if (state === 'closed' || ch === '"') { error = true; state = 'invalid'; }
    else { field += ch; state = 'unquoted'; }
  }
  if (state !== 'start' || fields.length || field !== '') {
    fields.push(field);
    out.push({ row: startRow, fields, error: error || state === 'quoted' });
  }
  tooMany();
  return out;
}

/** Exact total cost / quantity, reduced, as a fraction like the original's BigRational string. */
function exactRatio(cost: string, quantity: string): string {
  const parts = (text: string): [bigint, number] => {
    const [whole, fraction = ''] = text.split('.');
    return [BigInt(whole + fraction), fraction.length];
  };
  const [costDigits, costScale] = parts(cost);
  const [quantityDigits, quantityScale] = parts(quantity);
  let numerator = costDigits * 10n ** BigInt(quantityScale);
  let denominator = quantityDigits * 10n ** BigInt(costScale);
  let [a, b] = [numerator, denominator];
  while (b) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  return denominator === 1n ? String(numerator) : `${numerator}/${denominator}`;
}

function parsePreview(raw: string) {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) fail('csv', 'CSV exceeds the 1 MiB preview limit.');
  const rows: Row[] = [];
  const errors: Row[] = [];
  const seen = new Set<string>();
  records(raw.replace(/^﻿/, '')).forEach((record, index) => {
    const line = record.row;
    if (record.error) { errors.push({ row: line, message: 'Malformed CSV quoting.' }); return; }
    const { fields } = record;
    if (index === 0 && (fields[0] ?? '').toLowerCase().includes('name')) return;
    if (fields.length === 1 && fields[0].trim() === '') return;
    let name: string, variant = '', quantity: string, unit: string, cost: string;
    if (fields.length === 4) [name, quantity, unit, cost] = fields;
    else if (fields.length === 5) [name, variant, quantity, unit, cost] = fields;
    else { errors.push({ row: line, message: 'Expected Name,Variant,Qty,Unit,TotalCost or Name,Qty,Unit,TotalCost.' }); return; }
    name = name.trim(); variant = variant.trim(); quantity = quantity.trim(); unit = unit.trim().toLowerCase(); cost = cost.trim();
    if (name === '' || !['pieces', 'kilograms', 'grams', 'liters', 'milliliters'].includes(unit) || quantity.length > 128 || cost.length > 128 || !NUMBER.test(quantity) || !NUMBER.test(cost) || /^[0.]+$/.test(quantity)) {
      errors.push({ row: line, message: 'Name, positive quantity, supported unit and non-negative total cost are required (numeric fields: max 128 characters).' });
      return;
    }
    const key = JSON.stringify([name.toLowerCase(), variant.toLowerCase(), unit]);
    if (seen.has(key)) { errors.push({ row: line, message: 'Duplicate material, variant and unit in this CSV.' }); return; }
    seen.add(key);
    rows.push({ name, variant, quantity, unit, total_cost: cost, unit_cost_exact: exactRatio(cost, quantity) });
  });
  return { rows, errors };
}

profitTrackRoutes.post('/profittrack/csv-preview', franchisee, async (c) => {
  const { db } = c.get('deps');
  if (!(await resolveWorkspace(db, c.get('user')))) abort(404, 'ProfitTrack workspace unavailable.');
  const v = await validate(db, await readInput(c), {
    ...NO_BRANCH, branch_id: ['prohibited'], franchisee_id: ['prohibited'], brand_id: ['prohibited'], csv: ['required', 'string', 'max:1048576'],
  });
  return ok(c, parsePreview(v.csv), 'Preview only; no inventory was imported.');
});
