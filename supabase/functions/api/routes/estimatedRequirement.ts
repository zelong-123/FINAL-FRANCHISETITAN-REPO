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
  addDays, DAY_STATUS_LABELS, firstActivityDates, FORECAST_DEFAULTS, forecastAudit, type ForecastSettings, forLocation, horizonDays, isMonday, longDate, phpRound, resolveForecastLocation, settingsFrom, settingsRow,
  visibleLocations, weekEnd, weekLabel, weekStart,
} from '../services/forecast.ts';

export const forecastRoutes = new Hono<AppEnv>();
const anyRole = role('admin', 'logistics', 'franchisee');
const central = role('admin', 'logistics');
const admin = role('admin');
const NOTE = 'Estimates are based on past usage to support decisions. They are not guarantees.';
const TZ = 'Asia/Manila';
const base = '/estimated-requirement';
const FILTERS = { location_id: ['nullable', 'integer'], horizon: ['nullable', 'integer', 'in:7,14,30,1,2,4'], dips: ['nullable', 'in:cap,raw'] };

/** Settings a view filter changed away from the saved ones: shown, never recorded. */
const VIEW_ONLY = new WeakSet<ForecastSettings>();

/** The dips and spikes option on the page header; the saved setting is the default. */
async function settingsFor(db: Db, dips: string | null | undefined): Promise<ForecastSettings> {
  const settings = settingsFrom(await settingsRow(db));
  if (dips !== 'cap' && dips !== 'raw') return settings;
  const viewed = { ...settings, cap_spikes_and_dips: dips === 'cap' };
  if (viewed.cap_spikes_and_dips !== settings.cap_spikes_and_dips) VIEW_ONLY.add(viewed);
  return viewed;
}
/**
 * Who a request records demand classes as. Only a request on the SAVED settings records (and audits) a
 * class: a different "Dips and spikes" view may show another pattern, but must never write one, or two
 * viewers with different filters would keep flipping the stored class and refreshing each other.
 */
const recorder = (user: Row, settings: ForecastSettings): Row | null => (VIEW_ONLY.has(settings) ? null : user);
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
const freshness = (last: string | null) => (last ? `Last recorded activity: ${longDate(last)}` : 'No recorded activity yet');

/** The cards of both views. Days left out are counted once per day across the branch's materials. */
function summary(items: Row[], settings: ForecastSettings, horizon: number, lastActivity: string | null) {
  const leftOut = new Map<string, string>();
  for (const item of items) {
    for (const d of item.days as Row[]) {
      if (item.window_from && d.date >= item.window_from && ['closed', 'excluded', 'no_records'].includes(d.status) && !leftOut.has(d.date)) leftOut.set(d.date, d.status);
    }
  }
  const count = (status: string) => [...leftOut.values()].filter((s) => s === status).length;
  const ready = items.filter((i) => i.ready);
  const zero = ready.map((i) => Number(i.zero_days_percent ?? 0));
  const mix = { wma: 0, ses: 0, croston: 0 } as Record<string, number>;
  for (const item of ready) if (item.method) mix[item.method] += 1;
  return {
    items_tracked: items.length,
    stale_counts: items.filter((i) => i.count_stale).length, stale_count_days: settings.stale_count_days,
    avg_zero_days_percent: zero.length ? phpRound(zero.reduce((s, v) => s + v, 0) / zero.length, 1) : null,
    days_excluded: { closed: count('closed'), excluded: count('excluded'), no_records: count('no_records'), total: leftOut.size },
    low_cover: items.filter((i) => i.status === 'low_cover').length, overstocked: items.filter((i) => i.status === 'overstocked').length,
    reorders_suggested: items.filter((i) => (i.suggested_reorder ?? 0) > 0).length, cover_days: settings.lead_time_days + horizon,
    method_mix: mix, low_cover_days: settings.low_cover_days, overstock_days: settings.overstock_days,
    last_activity_on: lastActivity, freshness: freshness(lastActivity),
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
  const horizon = horizonDays(v.horizon);
  const settings = await settingsFor(db, v.dips);
  const firstFor = async (row: Row) => firstDates[row.id] ?? (await firstActivityDates(db, [row.id]))[row.id] ?? null;
  const payload: Row = {
    generated_at: new Date().toISOString(), timezone: TZ, horizon_days: horizon, settings, dips_mode: settings.cap_spikes_and_dips ? 'cap' : 'raw',
    locations: locations.map((row) => locationSummary(row, firstDates[row.id] ?? null)), location: location === null ? null : locationSummary(location, await firstFor(location)),
    items: [], summary: null, brands: brandsOf(brandId !== null ? await visibleLocations(db, user) : locations), note: NOTE,
  };
  if (location === null) return ok(c, { ...payload, requires_location: true });
  const result = await forLocation(db, location, horizon, settings, recorder(user, settings));
  const needle = String(v.search ?? '').trim().toLowerCase();
  const items = needle ? result.items.filter((item) => `${item.name} ${item.variant}`.toLowerCase().includes(needle)) : result.items;
  return ok(c, {
    ...payload, today: result.today, items: items.map(({ days: _days, ...item }) => ({ ...item, brand_name: location.brand?.name ?? null })),
    summary: summary(result.items, settings, horizon, result.last_activity_on), requires_location: false,
  });
});

/** Consecutive left-out days with the same status and reason, as ranges. */
function leftOutRanges(days: Row[]): Row[] {
  const ranges: Row[] = [];
  for (const d of days) {
    if (d.status === 'open') continue;
    const last = ranges[ranges.length - 1];
    if (last && last.status === d.status && last.reason === d.reason && addDays(last.to, 1) === d.date) { last.to = d.date; last.days += 1; continue; }
    ranges.push({ status: d.status, label: DAY_STATUS_LABELS[d.status] ?? d.status, reason: d.reason, from: d.date, to: d.date, days: 1 });
  }
  return ranges;
}

const amount = (value: number | null | undefined, unit: string, precision: number) => (value === null || value === undefined ? '—' : `${phpRound(value, Math.max(2, precision))} ${unit}`.trim());
const PATTERN_TEXT: Record<string, string> = { smooth: 'smooth', erratic: 'erratic', intermittent: 'intermittent', lumpy: 'lumpy' };
const METHOD_REASON: Record<string, string> = {
  wma: 'WMA (7-day window, weights 7 down to 1). Steady daily use, so recent days get the most weight.',
  ses: 'SES (alpha {alpha}). Daily use swings a lot, so the rate is smoothed instead of following every swing.',
  croston: 'Croston (alpha {alpha}). Usage comes on some days only, so the size of a use and the gap between uses are smoothed separately.',
};

/** "How usage was summarized" (Descriptive) and "How this was worked out" (Predictive), with the item's numbers. */
function explanation(item: Row, settings: ForecastSettings, horizon: number): Row {
  const u = item.unit;
  const p = item.unit_precision;
  const leftOut = item.days_left_out;
  const skipped = [leftOut.closed ? `${leftOut.closed} closed day${leftOut.closed === 1 ? '' : 's'}` : null, leftOut.excluded ? `${leftOut.excluded} excluded` : null,
    leftOut.no_records ? `${leftOut.no_records} with no records` : null].filter(Boolean).join(', ');
  const openText = `${item.open_days} open day${item.open_days === 1 ? '' : 's'}`;
  const skippedText = skipped ? `, ${skipped} skipped` : '';
  const descriptive = !item.open_days ? 'No open days with records yet, so there is nothing to summarize.'
    : `Last ${openText}${skippedText}. Average ${amount(item.avg_daily_use, u, p)} per day, ${item.zero_days_percent}% zero-usage days${item.last_7_days !== null ? `, last 7 days ${amount(item.last_7_days, u, p)}` : ''}. Switch to Predictive to see the method and forecast.`;
  if (!item.ready) return { descriptive, steps: [], not_ready: item.not_ready_reason };
  const alpha = item.method === 'ses' ? settings.ses_alpha : settings.croston_alpha;
  const pending = item.pending_pattern
    ? ` Pattern looks ${PATTERN_TEXT[item.pending_pattern.pattern]} for ${item.pending_pattern.days} of ${item.pending_pattern.needed} days; method stays ${item.method_label} for now.` : '';
  const coverText = item.cover_capped
    ? `Lead time ${settings.lead_time_days} day${settings.lead_time_days === 1 ? '' : 's'} + horizon ${horizon} days = ${item.cover_days_full} days, capped at ${item.cover_days} days (max cover for this item).`
    : `Lead time ${settings.lead_time_days} day${settings.lead_time_days === 1 ? '' : 's'} + horizon ${horizon} days = ${item.cover_days} days to cover.`;
  const onOrderText = item.on_order === null ? 'on order not counted' : `on order ${phpRound(item.on_order, 3)}`;
  const steps = [
    { title: 'History used', text: `${openText} used${skippedText}. Dips and spikes: ${settings.cap_spikes_and_dips ? 'capped' : 'included'}.` },
    { title: 'Demand pattern', text: `ADI ${item.adi?.toFixed(2)}, CV² ${item.cv2?.toFixed(2)} → ${PATTERN_TEXT[item.latest_pattern]} demand.${item.low_confidence ? ' Lumpy demand: low confidence.' : ''}${pending}` },
    { title: 'Method chosen', text: METHOD_REASON[item.method].replace('{alpha}', String(alpha)) },
    { title: 'Daily rate', text: `About ${amount(item.daily_rate, u, p)} per day × ${horizon} days = ${amount(item.estimated_need, u, p)} estimated need.` },
    { title: 'Cover period', text: coverText },
    { title: 'Safety stock', text: `${settings.z_score} × forecast error ${phpRound(item.forecast_error, 2)} × √${item.cover_days} days = ${amount(item.safety_stock, u, p)}.` },
    {
      title: 'Suggested reorder',
      text: `Target ${phpRound(item.target, 1)} (rate × ${item.cover_days} days + safety stock) − on hand ${phpRound(item.on_hand, 3)} − ${onOrderText} = ${phpRound(item.suggested_reorder_raw, 1)}, rounded up ${item.pack_size ? `to packs of ${phpRound(item.pack_size, 2).toFixed(2)}` : 'to whole units'} → ${amount(item.suggested_reorder, u, 1)}.`,
    },
  ];
  return { descriptive, steps, not_ready: null };
}

forecastRoutes.get(`${base}/detail`, anyRole, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { ...FILTERS, material_id: ['required', 'integer'] });
  const location = (await resolveForecastLocation(db, c.get('user'), idOf(v.location_id), true))!;
  const settings = await settingsFor(db, v.dips);
  const horizon = horizonDays(v.horizon);
  const result = await forLocation(db, location, horizon, settings, recorder(c.get('user'), settings));
  const item = result.items.find((row) => row.material_id === v.material_id);
  if (!item) abort(404, 'That raw material is not tracked for this branch.');
  const days = item!.days as Row[];
  // The forecast line: a flat daily rate from today to +horizon days.
  const forecast = item!.ready ? Array.from({ length: horizon + 1 }, (_, i) => ({ offset: i, rate: item!.daily_rate })) : [];
  return ok(c, {
    generated_at: result.generated_at, timezone: result.timezone, today: result.today, horizon_days: horizon, settings, dips_mode: settings.cap_spikes_and_dips ? 'cap' : 'raw',
    location: locationSummary(location, (await firstActivityDates(db, [location.id]))[location.id] ?? null),
    last_activity_on: result.last_activity_on, freshness: freshness(result.last_activity_on),
    item, forecast, explanation: explanation(item!, settings, horizon),
    left_out: leftOutRanges(days.filter((d) => d.status !== 'incomplete')),
    dips_and_spikes: days.filter((d) => d.flagged).map((d) => ({ date: d.date, flag: d.flagged, usage: d.usage, adjusted_usage: d.adjusted_usage })),
    note: NOTE,
  });
});

forecastRoutes.get(`${base}/network`, central, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { brand_id: ['nullable', 'integer'], horizon: FILTERS.horizon, dips: FILTERS.dips });
  const horizon = horizonDays(v.horizon);
  const settings = await settingsFor(db, v.dips);
  const locations = await visibleLocations(db, user, idOf(v.brand_id));
  const rows = new Map<number, Row>();
  const unmapped: Row[] = [];
  for (const location of locations) {
    const result = await forLocation(db, location, horizon, settings, recorder(user, settings));
    for (const item of result.items) {
      const mapping = item.warehouse_product;
      if (mapping.product_id === null || !mapping.unit_match) {
        unmapped.push({ location_id: location.id, branch: String(location.name), material_id: item.material_id, material: item.name, unit: item.unit, reason: mapping.note ?? 'No warehouse product linked.' });
        continue;
      }
      const row = rows.get(mapping.product_id) ?? {
        product_id: mapping.product_id, unit: mapping.unit, warehouse_stock: item.warehouse_stock, materials: 0, estimated_need: 0, suggested_reorder: 0, daily_usage: 0, low_cover_branches: 0,
        method_mix: { wma: 0, ses: 0, croston: 0 } as Record<string, number>, branches: [],
      };
      row.materials += 1;
      row.estimated_need += item.estimated_need ?? 0;
      row.suggested_reorder += item.suggested_reorder ?? 0;
      row.daily_usage += item.daily_rate ?? 0;
      if (item.status === 'low_cover') row.low_cover_branches += 1;
      if (item.method) row.method_mix[item.method] += 1;
      row.branches.push({
        location_id: location.id, branch: String(location.name), material: item.name, ready: item.ready, not_ready_reason: item.not_ready_reason, on_hand: item.on_hand, on_order: item.on_order,
        estimated_need: item.estimated_need, suggested_reorder: item.suggested_reorder, days_of_cover: item.days_of_cover, status: item.status, method_label: item.method_label,
      });
      rows.set(mapping.product_id, row);
    }
  }
  const catalogue = await db.query(`select id, name, sku from products where id = any($1::bigint[])`, [`{${[...rows.keys()].join(',')}}`]);
  const products = [...rows.entries()].map(([productId, row]) => {
    const product = catalogue.find((p) => p.id === productId);
    const stock = row.warehouse_stock === null ? null : Number(row.warehouse_stock);
    const cover = stock !== null && row.daily_usage > 0 ? phpRound(stock / row.daily_usage, 1) : null;
    return {
      product_id: productId, name: product?.name ?? `Product #${productId}`, sku: product?.sku ?? null, unit: row.unit, warehouse_stock: stock, materials: row.materials,
      estimated_need: phpRound(row.estimated_need, 3), suggested_reorder: phpRound(row.suggested_reorder, 3), daily_usage: phpRound(row.daily_usage, 3), warehouse_days_of_cover: cover,
      low_cover_branches: row.low_cover_branches, method_mix: row.method_mix, branches: row.branches,
    };
  });
  products.sort((a, b) => b.low_cover_branches - a.low_cover_branches || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ok(c, {
    generated_at: new Date().toISOString(), timezone: TZ, horizon_days: horizon, settings, dips_mode: settings.cap_spikes_and_dips ? 'cap' : 'raw', branch_count: locations.length,
    brands: brandsOf(await visibleLocations(db, user)).sort((a, b) => (a.name < b.name ? -1 : 1)), products, unmapped, note: NOTE,
  });
});

// Read-only hint on the Supply Request panel (horizon 1 week). It never fills or creates a request.
forecastRoutes.get(`${base}/suggestion`, anyRole, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { location_id: FILTERS.location_id, product_id: ['required', 'integer'] });
  const location = (await resolveForecastLocation(db, c.get('user'), idOf(v.location_id), true))!;
  const result = await forLocation(db, location, 7, await settingsFor(db, null), c.get('user'));
  const materials: Row[] = [];
  let suggested = 0;
  let ready = false;
  for (const item of result.items) {
    if (item.warehouse_product.product_id !== v.product_id) continue;
    const unitMatch = Boolean(item.warehouse_product.unit_match);
    materials.push({
      material_id: item.material_id, name: item.name, unit: item.unit, suggested_reorder: item.suggested_reorder, ready: item.ready, needed_days: item.needed_days, needed_weeks: item.needed_weeks,
      not_ready_reason: item.not_ready_reason, on_order: item.on_order, counted: unitMatch, note: unitMatch ? null : item.on_order_note,
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
    include_manual_deductions: ['sometimes', 'boolean'], cap_spikes_and_dips: ['sometimes', 'boolean'], trend_threshold_percent: ['sometimes', 'numeric', 'min:0', 'max:100'],
    lead_time_days: ['sometimes', 'integer', 'min:0', 'max:365'], closure_backdate_weeks: ['sometimes', 'integer', 'min:1', 'max:52'],
    lookback_open_days: ['sometimes', 'integer', 'min:14', 'max:90'], minimum_open_days: ['sometimes', 'integer', 'min:7', 'max:60'],
    adi_cutoff: ['sometimes', 'numeric', 'min:1', 'max:3'], cv2_cutoff: ['sometimes', 'numeric', 'min:0.1', 'max:2'],
    ses_alpha: ['sometimes', 'numeric', 'min:0.05', 'max:0.9'], croston_alpha: ['sometimes', 'numeric', 'min:0.05', 'max:0.9'], z_score: ['sometimes', 'numeric', 'min:0', 'max:3.5'],
    low_cover_days: ['sometimes', 'numeric', 'min:0', 'max:60'], overstock_days: ['sometimes', 'numeric', 'min:1', 'max:365'],
    method_switch_days: ['sometimes', 'integer', 'min:1', 'max:14'], stale_count_days: ['sometimes', 'integer', 'min:1', 'max:30'],
  });
  const row = await settingsRow(db);
  if ('overstock_days' in v || 'low_cover_days' in v) {
    if (Number(v.overstock_days ?? row.overstock_days) <= Number(v.low_cover_days ?? row.low_cover_days)) fail('overstock_days', 'Overstocked must be more days than Low cover.');
  }
  if ('minimum_open_days' in v || 'lookback_open_days' in v) {
    if (Number(v.minimum_open_days ?? row.minimum_open_days) > Number(v.lookback_open_days ?? row.lookback_open_days)) fail('minimum_open_days', 'The minimum open days cannot be more than the history window.');
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
