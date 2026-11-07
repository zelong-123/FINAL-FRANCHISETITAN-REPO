// EstimatedRequirementController, ForecastClosureController and ForecastExclusionController.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, Filter, insertRow, manilaToday, ok, paginate, perPage, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import {
  addDays, firstActivityDates, FORECAST_DEFAULTS, forecastAudit, type ForecastSettings, forLocation, isMonday, phpRound, resolveForecastLocation, settingsFrom, settingsRow, visibleLocations, weekEnd, weekLabel, weekStart,
} from '../services/forecast.ts';

export const forecastRoutes = new Hono<AppEnv>();
const anyRole = role('admin', 'logistics', 'franchisee');
const central = role('admin', 'logistics');
const admin = role('admin');
const NOTE = 'Estimates are based on past usage to support decisions. They are not guarantees.';
const TZ = 'Asia/Manila';
const base = '/estimated-requirement';
const FILTERS = { location_id: ['nullable', 'integer'], horizon: ['nullable', 'integer', 'in:1,2,4'], dips: ['nullable', 'in:cap,raw'] };

/** The dips and spikes option on the page header; the saved setting is the default. */
async function settingsFor(db: Db, dips: string | null | undefined): Promise<ForecastSettings> {
  const settings = settingsFrom(await settingsRow(db));
  return dips === 'cap' || dips === 'raw' ? { ...settings, cap_spikes_and_dips: dips === 'cap' } : settings;
}
const idOf = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function locationSummary(location: Row, firstActivity: string | null): Row {
  const stored = location.opening_date ? String(location.opening_date).slice(0, 10) : null;
  const first = stored ? null : firstActivity;
  return {
    id: location.id, name: String(location.name), branch_code: location.branch_code, city: location.city, province: location.province, is_active: Boolean(location.is_active), opening_date: stored,
    effective_opening_date: stored ?? first, opening_date_source: stored ? 'recorded' : first === null ? null : 'first_activity', opening_date_needed: !stored && first === null,
    brand: location.brand ?? null, franchisee: location.franchisee ?? null,
  };
}
const brandsOf = (locations: Row[]) => [...new Map(locations.filter((l) => l.brand).map((l) => [l.brand_id, { id: l.brand_id, name: String(l.brand.name) }])).values()];

function summary(items: Row[], weeks: Row[]) {
  const excluded = new Map<string, string>();
  for (const item of items) {
    for (const week of item.weeks) if (['closed', 'no_records', 'excluded'].includes(week.status)) excluded.set(week.week_start, week.status);
  }
  const labels: Record<string, string> = { closed: 'Branch closed', no_records: 'No records', excluded: 'Manually excluded' };
  return {
    items_tracked: items.length, runs_out_soon: items.filter((i) => i.status === 'runs_out_soon').length, watch: items.filter((i) => i.status === 'watch').length,
    reorders_suggested: items.filter((i) => (i.suggested_reorder ?? 0) > 0).length, weeks_excluded: excluded.size,
    excluded_breakdown: Object.entries(labels).map(([status, label]) => ({ status, label, weeks: [...excluded.values()].filter((v) => v === status).length })),
    chart_weeks: weeks.length,
  };
}

forecastRoutes.get(base, anyRole, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { ...FILTERS, brand_id: ['nullable', 'integer'], search: ['nullable', 'string', 'max:100'] });
  const brandId = idOf(v.brand_id);
  const locations = await visibleLocations(db, user, brandId);
  const location = await resolveForecastLocation(db, user, idOf(v.location_id), roleName(c) === 'franchisee');
  const firstDates = await firstActivityDates(db, locations.map((l) => l.id));
  const horizon = Number(v.horizon ?? 1);
  const settings = await settingsFor(db, v.dips);
  const firstFor = async (row: Row) => firstDates[row.id] ?? (await firstActivityDates(db, [row.id]))[row.id] ?? null;
  const payload: Row = {
    generated_at: new Date().toISOString(), timezone: TZ, horizon_weeks: horizon, settings, dips_mode: settings.cap_spikes_and_dips ? 'cap' : 'raw',
    locations: locations.map((row) => locationSummary(row, firstDates[row.id] ?? null)), location: location === null ? null : locationSummary(location, await firstFor(location)),
    weeks: [], items: [], summary: null, brands: brandsOf(brandId !== null ? await visibleLocations(db, user) : locations), note: NOTE,
  };
  if (location === null) return ok(c, { ...payload, requires_location: true });
  const result = await forLocation(db, location, horizon, settings);
  const needle = String(v.search ?? '').trim().toLowerCase();
  const items = needle ? result.items.filter((item) => `${item.name} ${item.variant}`.toLowerCase().includes(needle)) : result.items;
  return ok(c, {
    ...payload, weeks: result.weeks, items: items.map(({ weeks: _weeks, ...item }) => ({ ...item, brand_name: location.brand?.name ?? null })), summary: summary(result.items, result.weeks), requires_location: false,
  });
});

forecastRoutes.get(`${base}/detail`, anyRole, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { ...FILTERS, material_id: ['required', 'integer'] });
  const location = (await resolveForecastLocation(db, c.get('user'), idOf(v.location_id), true))!;
  const settings = await settingsFor(db, v.dips);
  const result = await forLocation(db, location, Number(v.horizon ?? 1), settings);
  const item = result.items.find((row) => row.material_id === v.material_id);
  if (!item) abort(404, 'That raw material is not tracked for this branch.');
  return ok(c, {
    generated_at: result.generated_at, timezone: result.timezone, horizon_weeks: result.horizon_weeks, settings, dips_mode: settings.cap_spikes_and_dips ? 'cap' : 'raw',
    location: locationSummary(location, (await firstActivityDates(db, [location.id]))[location.id] ?? null), chart_weeks: result.weeks, item,
    excluded_weeks: item!.weeks.filter((w: Row) => !w.is_included && w.status !== 'incomplete'), dips_and_spikes: item!.weeks.filter((w: Row) => w.flagged !== null), note: NOTE,
  });
});

const riskOf = (days: number | null, settings: ForecastSettings) => (days === null ? 'unknown' : days < settings.runs_out_days ? 'runs_out_soon' : days < settings.watch_days ? 'watch' : 'ok');

forecastRoutes.get(`${base}/network`, central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { brand_id: ['nullable', 'integer'], horizon: FILTERS.horizon, dips: FILTERS.dips });
  const horizon = Number(v.horizon ?? 1);
  const settings = await settingsFor(db, v.dips);
  const locations = await visibleLocations(db, user, idOf(v.brand_id));
  const rows = new Map<number, Row>();
  const unmapped: Row[] = [];
  for (const location of locations) {
    const result = await forLocation(db, location, horizon, settings);
    for (const item of result.items) {
      const mapping = item.warehouse_product;
      if (mapping.product_id === null || !mapping.unit_match) {
        unmapped.push({ location_id: location.id, branch: String(location.name), material_id: item.material_id, material: item.name, unit: item.unit, reason: mapping.note ?? 'No warehouse product linked.' });
        continue;
      }
      const row = rows.get(mapping.product_id) ?? { product_id: mapping.product_id, unit: mapping.unit, warehouse_stock: item.warehouse_stock, materials: 0, estimated_need: 0, suggested_reorder: 0, weekly_usage: 0, branches: [] };
      row.materials += 1;
      row.estimated_need += item.estimated_need ?? 0;
      row.suggested_reorder += item.suggested_reorder ?? 0;
      row.weekly_usage += item.weighted_average ?? 0;
      row.branches.push({
        location_id: location.id, branch: String(location.name), material: item.name, ready: item.ready, on_hand: item.on_hand, on_order: item.on_order, estimated_need: item.estimated_need,
        suggested_reorder: item.suggested_reorder, days_left: item.days_left, status: item.status,
      });
      rows.set(mapping.product_id, row);
    }
  }
  const catalogue = await db.query(`select id, name, sku from products where id = any($1::bigint[])`, [`{${[...rows.keys()].join(',')}}`]);
  const products = [...rows.entries()].map(([productId, row]) => {
    const product = catalogue.find((p) => p.id === productId);
    const stock = row.warehouse_stock === null ? null : Number(row.warehouse_stock);
    const daily = row.weekly_usage / 7;
    const cover = stock !== null && daily > 0 ? phpRound(stock / daily, 1) : null;
    return {
      product_id: productId, name: product?.name ?? `Product #${productId}`, sku: product?.sku ?? null, unit: row.unit, warehouse_stock: stock, materials: row.materials, estimated_need: phpRound(row.estimated_need, 3),
      suggested_reorder: phpRound(row.suggested_reorder, 3), weekly_usage: phpRound(row.weekly_usage, 3), days_of_cover: cover, risk: riskOf(cover, settings), branches: row.branches,
    };
  });
  const order: Record<string, number> = { runs_out_soon: 0, watch: 1, unknown: 2, ok: 3 };
  products.sort((a, b) => (order[a.risk] ?? 9) - (order[b.risk] ?? 9) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ok(c, {
    generated_at: new Date().toISOString(), timezone: TZ, horizon_weeks: horizon, settings, dips_mode: settings.cap_spikes_and_dips ? 'cap' : 'raw', branch_count: locations.length,
    brands: brandsOf(await visibleLocations(db, user)).sort((a, b) => (a.name < b.name ? -1 : 1)), products, unmapped, note: NOTE,
  });
});

// Read-only hint on the Supply Request panel. It never fills or creates a request.
forecastRoutes.get(`${base}/suggestion`, anyRole, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { location_id: FILTERS.location_id, product_id: ['required', 'integer'] });
  const location = (await resolveForecastLocation(db, c.get('user'), idOf(v.location_id), true))!;
  const result = await forLocation(db, location, 1, await settingsFor(db, null));
  const materials: Row[] = [];
  let suggested = 0;
  let ready = false;
  for (const item of result.items) {
    if (item.warehouse_product.product_id !== v.product_id) continue;
    const unitMatch = Boolean(item.warehouse_product.unit_match);
    materials.push({
      material_id: item.material_id, name: item.name, unit: item.unit, suggested_reorder: item.suggested_reorder, ready: item.ready, needed_weeks: item.needed_weeks, on_order: item.on_order, counted: unitMatch, note: unitMatch ? null : item.on_order_note,
    });
    if (!unitMatch) continue; // a quantity in another unit cannot be added to the product's
    suggested += item.suggested_reorder ?? 0;
    ready = ready || item.ready;
  }
  if (!materials.length) abort(404, 'No raw material of this branch is linked to that warehouse product.');
  const [product] = await db.query(`select unit from products where id = $1`, [v.product_id]);
  return ok(c, {
    location_id: location.id, product_id: v.product_id, suggested_quantity: ready ? phpRound(suggested, 3) : null, unit: product?.unit ?? null, materials,
    note: 'Read-only estimate based on past usage. It is not an order and never fills the request automatically.',
  });
});

forecastRoutes.get(`${base}/settings`, anyRole, async (c) => ok(c, { settings: settingsFrom(await settingsRow(c.get('deps').db)), defaults: FORECAST_DEFAULTS, editable: roleName(c) === 'admin' }));

forecastRoutes.patch(`${base}/settings`, admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    minimum_included_weeks: ['sometimes', 'integer', 'min:1', 'max:26'], detection_weeks: ['sometimes', 'integer', 'min:2', 'max:52'], closed_days_threshold: ['sometimes', 'integer', 'min:0', 'max:7'],
    include_manual_deductions: ['sometimes', 'boolean'], cap_spikes_and_dips: ['sometimes', 'boolean'], trend_threshold_percent: ['sometimes', 'numeric', 'min:0', 'max:100'], runs_out_days: ['sometimes', 'numeric', 'min:0', 'max:365'],
    watch_days: ['sometimes', 'numeric', 'min:0', 'max:365'], lead_time_days: ['sometimes', 'integer', 'min:0', 'max:365'], closure_backdate_weeks: ['sometimes', 'integer', 'min:1', 'max:52'],
  });
  const row = await settingsRow(db);
  if ('watch_days' in v || 'runs_out_days' in v) {
    if (Number(v.watch_days ?? row.watch_days) <= Number(v.runs_out_days ?? row.runs_out_days)) fail('watch_days', 'The watch threshold must be higher than the run-out threshold.');
  }
  const saved = await updateRow(db, 'forecast_settings', row.id, { ...v, updated_by_user_id: c.get('user').id });
  const after = settingsFrom(saved!);
  // Settings are global, so they go to the global audit log rather than a branch event.
  await audit(c, db, 'forecast.settings_updated', { type: 'App\\Models\\ForecastSetting', id: row.id }, { settings: settingsFrom(row) }, { settings: after });
  return ok(c, { settings: after }, 'Settings saved.');
});

forecastRoutes.patch(`${base}/opening-date`, admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { location_id: ['required', 'integer'], opening_date: ['nullable', 'date_format:Y-m-d'] });
  const location = (await resolveForecastLocation(db, c.get('user'), v.location_id, true))!;
  const next = v.opening_date ?? null;
  await updateRow(db, 'franchise_locations', location.id, { opening_date: next });
  await forecastAudit(db, c.get('user'), location.id, 'forecast.opening_date_changed', 'franchise_location', location.id, null, { before: location.opening_date ?? null, after: next });
  const fresh = (await resolveForecastLocation(db, c.get('user'), location.id, true))!;
  return ok(c, { location: locationSummary(fresh, (await firstActivityDates(db, [fresh.id]))[fresh.id] ?? null) }, 'Opening date saved.');
});

forecastRoutes.get(`${base}/audit`, admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { location_id: FILTERS.location_id, action: ['nullable', 'string', 'max:60'] });
  const f = new Filter();
  f.add(`e.action like 'forecast.%'`);
  if (v.location_id !== null && v.location_id !== undefined) f.add('e.location_id = ?', v.location_id);
  if (v.action) f.add('e.action = ?', v.action);
  return paginate(c, db, {
    columns: `e.*, (select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = e.actor_user_id) as actor`,
    from: 'profittrack_audit_events e', where: f.clauses, params: f.params, orderBy: 'e.id desc', perPage: perPage(c, 50),
  });
});

// ---- Closure periods ----
const NAME = (column: string) => `(select u.full_name from users u where u.id = ${column})`;
const CLOSURE = `x.*, ${NAME('x.created_by_user_id')} as created_by, ${NAME('x.deleted_by_user_id')} as undone_by`;
const asDate = (value: unknown) => String(value).slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function closurePayload(row: Row): Row {
  const starts = asDate(row.starts_on);
  const ends = asDate(row.ends_on);
  return {
    id: row.id, location_id: row.location_id, starts_on: starts, ends_on: ends, days: Math.max(0, daysBetween(starts, ends) + 1), reason: String(row.reason), created_by: row.created_by ?? null, created_at: row.created_at,
    undone: row.deleted_at !== null, undone_at: row.deleted_at, undone_by: row.undone_by ?? null,
  };
}
const loadClosure = async (db: Db, id: number) => (await db.query(`select ${CLOSURE} from forecast_closure_periods x where x.id = $1`, [id]))[0];

/** Stops a branch rewriting the estimate's history; an administrator may still record older ones. */
async function assertBackdateAllowed(c: Context<AppEnv>, db: Db, startsOn: string) {
  if (roleName(c) === 'admin') return;
  const limit = Number((await settingsRow(db)).closure_backdate_weeks ?? 8);
  const earliest = addDays(weekStart(manilaToday()), -7 * Math.max(0, limit - 1));
  if (startsOn < earliest) fail('starts_on', `A closure can start at most ${limit} weeks back. Ask an administrator to record an older one.`);
}
async function assertNoOverlap(db: Db, locationId: number, startsOn: string, endsOn: string, ignoreId: number | null = null) {
  const overlap = await db.query(
    `select 1 from forecast_closure_periods where location_id = $1 and deleted_at is null and ($2::bigint is null or id <> $2::bigint) and starts_on <= $3::date and ends_on >= $4::date limit 1`, [locationId, ignoreId, endsOn, startsOn],
  );
  if (overlap.length) fail('starts_on', 'This period overlaps a closure that is already recorded for this branch.');
}

forecastRoutes.get(`${base}/closures`, anyRole, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { location_id: FILTERS.location_id, include_undone: ['nullable', 'boolean'] });
  const location = (await resolveForecastLocation(db, c.get('user'), idOf(v.location_id), true))!;
  const withUndone = v.include_undone && ['admin', 'logistics'].includes(roleName(c));
  const rows = await db.query(`select ${CLOSURE} from forecast_closure_periods x where x.location_id = $1 ${withUndone ? '' : 'and x.deleted_at is null'} order by x.starts_on desc, x.id desc limit 200`, [location.id]);
  return ok(c, { location: { id: location.id, name: String(location.name) }, closures: rows.map(closurePayload) });
});

forecastRoutes.post(`${base}/closures`, central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    location_id: FILTERS.location_id, starts_on: ['required', 'date_format:Y-m-d'], ends_on: ['required', 'date_format:Y-m-d', 'after_or_equal:starts_on'], reason: ['required', 'string', 'min:3', 'max:500'],
  });
  const location = (await resolveForecastLocation(db, user, idOf(v.location_id), true))!;
  await assertBackdateAllowed(c, db, v.starts_on);
  await assertNoOverlap(db, location.id, v.starts_on, v.ends_on);
  const reason = String(v.reason).trim();
  const closure = await insertRow(db, 'forecast_closure_periods', { location_id: location.id, starts_on: v.starts_on, ends_on: v.ends_on, reason, created_by_user_id: user.id });
  await forecastAudit(db, user, location.id, 'forecast.closure_created', 'forecast_closure_period', closure.id, reason, { starts_on: v.starts_on, ends_on: v.ends_on });
  return ok(c, { closure: closurePayload(await loadClosure(db, closure.id)) }, 'Closure recorded.', 201);
});

forecastRoutes.patch(`${base}/closures/:closure`, central, async (c) => {
  const { db } = c.get('deps');
  const id = routeId(c, 'closure');
  const row = requireFound(await loadClosure(db, id));
  if (row.deleted_at) fail('closure', 'This closure was undone. Restore it before editing.');
  const v = await validate(db, await readInput(c), { starts_on: ['sometimes', 'date_format:Y-m-d'], ends_on: ['sometimes', 'date_format:Y-m-d'], reason: ['sometimes', 'string', 'min:3', 'max:500'] });
  const before = { starts_on: asDate(row.starts_on), ends_on: asDate(row.ends_on), reason: row.reason };
  const starts = v.starts_on ?? before.starts_on;
  const ends = v.ends_on ?? before.ends_on;
  if (ends < starts) fail('ends_on', 'The last closed day cannot be before the first.');
  if ('reason' in v && String(v.reason).trim() === '') fail('reason', 'A reason is required for a closure.');
  await assertBackdateAllowed(c, db, starts);
  await assertNoOverlap(db, row.location_id, starts, ends, id);
  const reason = 'reason' in v ? String(v.reason).trim() : row.reason;
  await updateRow(db, 'forecast_closure_periods', id, { starts_on: starts, ends_on: ends, reason });
  await forecastAudit(db, c.get('user'), row.location_id, 'forecast.closure_updated', 'forecast_closure_period', id, reason, { before, after: { starts_on: starts, ends_on: ends, reason } });
  return ok(c, { closure: closurePayload(await loadClosure(db, id)) }, 'Closure updated.');
});

/** Undo and restore share one shape: a soft delete that keeps the row and its audit trail. */
function softDeleteRoutes(path: string, param: string, table: string, entity: string, noun: string, load: (db: Db, id: number) => Promise<Row>, present: (row: Row) => Row, key: string, metadata: (row: Row) => Row | null, restoredMeta: boolean) {
  const Title = noun[0].toUpperCase() + noun.slice(1);
  forecastRoutes.delete(`${base}/${path}/:${param}`, central, async (c) => {
    const { db } = c.get('deps');
    const user = c.get('user');
    const id = routeId(c, param);
    const row = requireFound(await load(db, id));
    if (row.deleted_at) fail(key, `This ${noun} is already undone.`);
    await updateRow(db, table, id, { deleted_by_user_id: user.id, deleted_at: new Date() });
    await forecastAudit(db, user, row.location_id, `forecast.${noun}_undone`, entity, id, row.reason, metadata(row));
    return ok(c, { [key]: present(await load(db, id)) }, `${Title} undone.`);
  });
  forecastRoutes.post(`${base}/${path}/:${param}/restore`, central, async (c) => {
    const { db } = c.get('deps');
    const id = routeId(c, param);
    const row = requireFound(await load(db, id));
    if (!row.deleted_at) fail(key, `This ${noun} is not undone.`);
    await updateRow(db, table, id, { deleted_by_user_id: null, deleted_at: null });
    await forecastAudit(db, c.get('user'), row.location_id, `forecast.${noun}_restored`, entity, id, row.reason, restoredMeta ? metadata(row) : null);
    return ok(c, { [key]: present(await load(db, id)) }, `${Title} restored.`);
  });
}
softDeleteRoutes('closures', 'closure', 'forecast_closure_periods', 'forecast_closure_period', 'closure', loadClosure, closurePayload, 'closure', (r) => ({ starts_on: asDate(r.starts_on), ends_on: asDate(r.ends_on) }), false);

// ---- Week exclusions ----
const EXCLUSION = `${CLOSURE}, (select jsonb_build_object('id', m.id, 'name', m.name, 'variant', m.variant, 'unit', m.unit) from profittrack_materials m where m.id = x.material_id) as material`;
const loadExclusion = async (db: Db, id: number) => (await db.query(`select ${EXCLUSION} from forecast_week_exclusions x where x.id = $1`, [id]))[0];
function exclusionPayload(row: Row): Row {
  const week = asDate(row.week_start);
  return {
    id: row.id, location_id: row.location_id, material_id: row.material_id, material: row.material ?? null, week_start: week, week_end: weekEnd(week), label: weekLabel(week), scope: row.material_id === null ? 'branch' : 'material',
    reason: String(row.reason), created_by: row.created_by ?? null, created_at: row.created_at, undone: row.deleted_at !== null, undone_at: row.deleted_at, undone_by: row.undone_by ?? null,
  };
}

forecastRoutes.get(`${base}/exclusions`, anyRole, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { location_id: FILTERS.location_id, include_undone: ['nullable', 'boolean'] });
  const location = (await resolveForecastLocation(db, c.get('user'), idOf(v.location_id), true))!;
  const withUndone = v.include_undone && roleName(c) === 'admin';
  const rows = await db.query(`select ${EXCLUSION} from forecast_week_exclusions x where x.location_id = $1 ${withUndone ? '' : 'and x.deleted_at is null'} order by x.week_start desc, x.id desc limit 200`, [location.id]);
  return ok(c, { location: { id: location.id, name: String(location.name) }, exclusions: rows.map(exclusionPayload) });
});

forecastRoutes.post(`${base}/exclusions`, central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { location_id: ['required', 'integer'], material_id: ['nullable', 'integer'], week_start: ['required', 'date_format:Y-m-d'], reason: ['required', 'string', 'min:3', 'max:500'] });
  const location = (await resolveForecastLocation(db, user, v.location_id, true))!;
  if (!isMonday(v.week_start)) fail('week_start', 'Weeks run Monday to Sunday. Choose the Monday that starts the week.');
  if (v.week_start >= weekStart(manilaToday())) fail('week_start', 'The current week is still running; it is already left out of the estimate.');
  const materialId = idOf(v.material_id);
  if (materialId !== null && !(await db.query(`select 1 from profittrack_materials where location_id = $1 and id = $2`, [location.id, materialId])).length) fail('material_id', 'That raw material does not belong to this branch.');
  const duplicate = await db.query(
    `select 1 from forecast_week_exclusions where location_id = $1 and week_start = $2::date and deleted_at is null and material_id is not distinct from $3::bigint limit 1`, [location.id, v.week_start, materialId],
  );
  if (duplicate.length) fail('week_start', 'That week is already excluded. Undo the existing exclusion first.');
  const reason = String(v.reason).trim();
  const row = await insertRow(db, 'forecast_week_exclusions', { location_id: location.id, material_id: materialId, week_start: v.week_start, reason, created_by_user_id: user.id });
  await forecastAudit(db, user, location.id, 'forecast.exclusion_created', 'forecast_week_exclusion', row.id, reason, { week_start: v.week_start, material_id: materialId });
  return ok(c, { exclusion: exclusionPayload(await loadExclusion(db, row.id)) }, 'Week excluded.', 201);
});
softDeleteRoutes('exclusions', 'exclusion', 'forecast_week_exclusions', 'forecast_week_exclusion', 'exclusion', loadExclusion, exclusionPayload, 'exclusion', (r) => ({ week_start: asDate(r.week_start), material_id: r.material_id }), true);
