// App\Services\Forecast\*: the "Estimated requirement". Descriptive statistics over weeks the
// branch already recorded. It predicts nothing and writes no stock; nothing is cached.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, manilaToday } from '../lib/http.ts';
import { resolveWorkspace } from './branchAccess.ts';
import { SUBMITTED_OPEN, sqlList } from './supplyStatus.ts';

const TZ = 'Asia/Manila';
const LOOKBACK_WEEKS = 26;
const CHART_WEEKS = 12;

export const FORECAST_DEFAULTS = {
  minimum_included_weeks: 4, detection_weeks: 8, closed_days_threshold: 4, include_manual_deductions: true, cap_spikes_and_dips: true,
  trend_threshold_percent: 10, runs_out_days: 5, watch_days: 10, lead_time_days: 0, closure_backdate_weeks: 8,
};

/** PHP's round(): half away from zero, ignoring float noise past 15 significant digits. */
export function phpRound(value: number, places = 0): number {
  const factor = 10 ** places;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

// ---- ForecastWeeks: Monday to Sunday, on plain YYYY-MM-DD strings ----
const parse = (date: string) => new Date(`${date.slice(0, 10)}T00:00:00Z`);
const format = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => format(new Date(parse(date).getTime() + days * 86_400_000));
export const isMonday = (date: string) => parse(date).getUTCDay() === 1;
export const weekStart = (date: string) => addDays(date, -((parse(date).getUTCDay() + 6) % 7));
export const weekEnd = (start: string) => addDays(start, 6);
export const weekWindow = (weeks: number, ending: string) => Array.from({ length: Math.max(1, weeks) }, (_, i) => addDays(ending, -7 * (Math.max(1, weeks) - 1 - i)));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthDay = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
export function weekLabel(start: string): string {
  const a = parse(start);
  const b = parse(weekEnd(start));
  return `${monthDay(a)} – ${a.getUTCMonth() === b.getUTCMonth() ? b.getUTCDate() : monthDay(b)}`;
}

// ---- ForecastMath ----
const WEIGHTS = [1, 2, 3, 4];
const RANGE_WEEKS = 8;

export function weightedAverage(values: number[]): number | null {
  if (!values.length) return null;
  const take = Math.min(values.length, WEIGHTS.length);
  const slice = values.slice(-take);
  const weights = WEIGHTS.slice(-take);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return slice.reduce((sum, value, i) => sum + value * weights[i], 0) / total;
}
const mean = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.trunc(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
/** Tukey hinges: the median of each half, leaving out the middle of an odd-sized set. */
function quartiles(values: number[]) {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.trunc(sorted.length / 2);
  const q1 = median(sorted.slice(0, half))!;
  const q3 = median(sorted.length % 2 === 0 ? sorted.slice(half) : sorted.slice(half + 1))!;
  return { q1, q3, iqr: q3 - q1 };
}
const standardDeviation = (values: number[]) => {
  const m = mean(values);
  return m === null ? null : Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length);
};
export function normalRange(values: number[]) {
  const window = values.slice(-RANGE_WEEKS);
  if (!window.length) return null;
  const average = mean(window)!;
  const deviation = standardDeviation(window)!;
  return { low: Math.max(0, average - deviation), high: average + deviation, average, deviation };
}
export function trend(values: number[], thresholdPercent: number) {
  if (values.length < RANGE_WEEKS) return { direction: 'insufficient', change_percent: null, recent_average: null, previous_average: null };
  const recent = mean(values.slice(-4))!;
  const previous = mean(values.slice(-8, -4))!;
  if (previous <= 0) return { direction: recent > 0 ? 'rising' : 'stable', change_percent: null, recent_average: recent, previous_average: previous };
  const change = ((recent - previous) / previous) * 100;
  return { direction: change > thresholdPercent ? 'rising' : change < -thresholdPercent ? 'falling' : 'stable', change_percent: change, recent_average: recent, previous_average: previous };
}
export const daysOfCover = (onHand: number, weekly: number | null) => (weekly === null || weekly <= 0 ? null : Math.max(0, onHand) / (weekly / 7));
export function suggestedReorder(weekly: number | null, horizon: number, leadDays: number, safety: number, onHand: number, onOrder: number) {
  if (weekly === null) return null;
  return Math.max(0, weekly * (Math.max(1, horizon) + Math.max(0, leadDays) / 7) + safety - Math.max(0, onHand) - Math.max(0, onOrder));
}
export function roundUpToPack(value: number, pack: number | null): number {
  if (value <= 0) return 0;
  if (pack === null || pack <= 0) return Math.ceil(value - 1e-9);
  return phpRound(Math.ceil(value / pack - 1e-9) * pack, 3);
}
const WHOLE_UNITS = new Set(['pcs', 'pc', 'piece', 'pieces', 'pack', 'packs', 'box', 'boxes', 'bottle', 'bottles', 'can', 'cans', 'sachet', 'sachets', 'bag', 'bags', 'tray', 'trays', 'sack', 'sacks', 'g', 'gram', 'grams', 'ml', 'millilitre', 'milliliter', 'each', 'unit', 'units']);
const FINE_UNITS = new Set(['kg', 'kilogram', 'kilograms', 'l', 'liter', 'litre', 'liters', 'litres']);
const unitPrecision = (unit: string) => {
  const key = unit.trim().toLowerCase();
  return WHOLE_UNITS.has(key) ? 0 : FINE_UNITS.has(key) ? 3 : 2;
};

/** Q1/Q3 ∓ 1.5 IQR; a flat history falls back to double or half the median, bound included. */
export function outliers(values: number[], detectionWeeks: number, cap: boolean) {
  const flags: (string | null)[] = values.map(() => null);
  const skipped = { status: 'skipped_sparse', fences: { low: null as number | null, high: null as number | null }, flags, adjusted: values };
  if (values.length < Math.max(2, detectionWeeks)) return { ...skipped, status: 'insufficient_history' };
  if (values.filter((v) => v === 0).length * 2 > values.length) return skipped;
  const q = quartiles(values);
  const middle = median(values);
  if (q === null || middle === null) return { ...skipped, status: 'insufficient_history' };
  let low: number;
  let high: number;
  if (q.iqr <= 0) {
    if (middle <= 0) return skipped;
    low = middle / 2;
    high = middle * 2;
  } else {
    low = Math.max(0, q.q1 - 1.5 * q.iqr);
    high = q.q3 + 1.5 * q.iqr;
  }
  const inclusive = q.iqr <= 0;
  const adjusted = [...values];
  values.forEach((value, i) => {
    if (inclusive ? value >= high : value > high) { flags[i] = 'spike'; if (cap) adjusted[i] = high; }
    else if (inclusive ? value <= low : value < low) { flags[i] = 'dip'; if (cap) adjusted[i] = low; }
  });
  return { status: 'ok', fences: { low, high }, flags, adjusted };
}

// ---- ForecastSettings ----
export interface ForecastSettings {
  minimum_included_weeks: number; detection_weeks: number; closed_days_threshold: number; include_manual_deductions: boolean; cap_spikes_and_dips: boolean;
  trend_threshold_percent: number; runs_out_days: number; watch_days: number; lead_time_days: number; closure_backdate_weeks: number;
}
const clamp = (value: unknown, min: number, max: number) => Math.max(min, Math.min(max, Number(value)));
const clampInt = (value: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(Number(value))));

/** The single settings row, created with the defaults on first read. */
export async function settingsRow(db: Db): Promise<Row> {
  const [row] = await db.query(`select * from forecast_settings order by id limit 1`);
  return row ?? insertRow(db, 'forecast_settings', FORECAST_DEFAULTS);
}
export function settingsFrom(row: Row): ForecastSettings {
  const runs = clamp(row.runs_out_days, 0, 365);
  return {
    minimum_included_weeks: clampInt(row.minimum_included_weeks, 1, 26), detection_weeks: clampInt(row.detection_weeks, 2, 52), closed_days_threshold: clampInt(row.closed_days_threshold, 0, 7),
    include_manual_deductions: Boolean(row.include_manual_deductions), cap_spikes_and_dips: Boolean(row.cap_spikes_and_dips), trend_threshold_percent: Math.max(0, Number(row.trend_threshold_percent)),
    runs_out_days: runs, watch_days: Math.max(clamp(row.watch_days, 0, 365), runs + 1), // keeps the Watch card reachable
    lead_time_days: clampInt(row.lead_time_days, 0, 365), closure_backdate_weeks: clampInt(row.closure_backdate_weeks, 1, 52),
  };
}

// ---- ForecastAccess ----
const LOCATION = `l.*, (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = l.brand_id) as brand,
  (select jsonb_build_object('id', f.id, 'business_name', f.business_name) from franchisees f where f.id = l.franchisee_id) as franchisee`;
const loadLocation = async (db: Db, id: number) => (await db.query(`select ${LOCATION} from franchise_locations l where l.id = $1`, [id]))[0];

export async function visibleLocations(db: Db, user: Row, brandId: number | null = null): Promise<Row[]> {
  if (user.role?.name === 'franchisee') {
    const own = await resolveWorkspace(db, user);
    return own ? [await loadLocation(db, own.id)] : [];
  }
  return db.query(
    `select ${LOCATION} from franchise_locations l where l.type = 'franchise' and l.is_active = true and ($1::bigint is null or l.brand_id = $1::bigint) order by l.name`, [brandId],
  );
}

/** A franchisee is pinned to its own branch: another id is a 403, never an empty result. */
export async function resolveForecastLocation(db: Db, user: Row, locationId: number | null, required = true): Promise<Row | null> {
  if (user.role?.name === 'franchisee') {
    const own = await resolveWorkspace(db, user);
    if (!own) abort(403, 'This account must be assigned to exactly one active branch. Contact an administrator.');
    if (locationId !== null && locationId !== own!.id) abort(403, 'Branch accounts can only open their own branch.');
    return loadLocation(db, own!.id);
  }
  if (locationId === null) {
    if (required) fail('location_id', 'Choose a branch.');
    return null;
  }
  const [location] = await db.query(`select ${LOCATION} from franchise_locations l where l.id = $1 and l.type = 'franchise'`, [locationId]);
  if (!location) abort(404, 'The requested branch was not found.');
  return location;
}

export const forecastAudit = (db: Db, actor: Row, locationId: number | null, action: string, entityType: string, entityId: number | null, reason: string | null = null, metadata: Row | null = null) => insertRow(db, 'profittrack_audit_events', {
  location_id: locationId, actor_user_id: actor.id, action, entity_type: entityType, entity_id: entityId, reason, metadata, occurred_at: new Date(),
});

// ---- ForecastDataProvider ----
const day = (column: string) => `((${column}) at time zone '${TZ}')::date::text`;
const moment = (param: string) => `${param}::date::timestamp at time zone '${TZ}'`;

/** First recorded activity per branch, in one query rather than one probe per branch. */
export async function firstActivityDates(db: Db, ids: number[]): Promise<Record<number, string>> {
  if (!ids.length) return {};
  const rows = await db.query(
    `select location_id, min(first_on) as first_on from (
       select location_id, min(${day('occurred_at')}) as first_on from profittrack_operations where location_id = any($1::bigint[]) group by location_id
       union all select location_id, min(${day('occurred_at')}) from profittrack_material_movements where location_id = any($1::bigint[]) group by location_id
       union all select i.location_id, min(${day('t.transaction_date')}) from inventory_transactions t join inventories i on i.id = t.inventory_id where i.location_id = any($1::bigint[]) group by i.location_id
     ) x group by location_id`,
    [`{${ids.join(',')}}`],
  );
  return Object.fromEntries(rows.map((r) => [r.location_id, r.first_on]));
}

async function firstStockedDates(db: Db, locationId: number): Promise<Map<number, string>> {
  const rows = await db.query(
    `select material_id, min(first_on) as first_on from (
       select material_id, ${day('occurred_at')} as first_on from profittrack_material_movements where location_id = $1
       union all select pc.material_id, ${day('o.occurred_at')} from profittrack_production_consumptions pc join profittrack_production_batches b on b.id = pc.batch_id join profittrack_operations o on o.id = b.operation_id
         where pc.location_id = $1 and b.voided_at is null
     ) x group by material_id`, [locationId],
  );
  return new Map(rows.map((r) => [r.material_id, r.first_on]));
}

async function activeWeeks(db: Db, locationId: number, from: string, to: string): Promise<Set<string>> {
  const end = addDays(weekEnd(to), 1);
  const rows = await db.query(
    `select distinct on_day from (
       select ${day('occurred_at')} as on_day from profittrack_operations where location_id = $1 and occurred_at >= ${moment('$2')} and occurred_at < ${moment('$3')}
       union all select ${day('occurred_at')} from profittrack_material_movements where location_id = $1 and occurred_at >= ${moment('$2')} and occurred_at < ${moment('$3')}
       union all select ${day('t.transaction_date')} from inventory_transactions t join inventories i on i.id = t.inventory_id where i.location_id = $1 and t.transaction_date >= ${moment('$2')} and t.transaction_date < ${moment('$3')}
     ) x`, [locationId, from, end],
  );
  return new Set(rows.map((r) => weekStart(r.on_day)));
}

async function usageByWeek(db: Db, locationId: number, from: string, to: string, includeManual: boolean) {
  const end = addDays(weekEnd(to), 1);
  const usage = new Map<number, Map<string, number>>();
  const add = (material: number, onDay: string, quantity: number) => {
    if (!usage.has(material)) usage.set(material, new Map());
    const weeks = usage.get(material)!;
    const week = weekStart(onDay);
    weeks.set(week, (weeks.get(week) ?? 0) + quantity);
  };
  const production = await db.query(
    `select pc.material_id, pc.quantity_milli, ${day('o.occurred_at')} as on_day from profittrack_production_consumptions pc join profittrack_production_batches b on b.id = pc.batch_id join profittrack_operations o on o.id = b.operation_id
     where pc.location_id = $1 and b.voided_at is null and o.occurred_at >= ${moment('$2')} and o.occurred_at < ${moment('$3')}`, [locationId, from, end],
  );
  for (const row of production) add(row.material_id, row.on_day, Number(row.quantity_milli) / 1000);
  if (includeManual) {
    // Only the negative half of a physical count is usage: spoilage, damage or a correction.
    const deductions = await db.query(
      `select material_id, quantity_delta_milli, ${day('occurred_at')} as on_day from profittrack_material_movements
       where location_id = $1 and type = 'physical_count' and quantity_delta_milli < 0 and occurred_at >= ${moment('$2')} and occurred_at < ${moment('$3')}`, [locationId, from, end],
    );
    for (const row of deductions) add(row.material_id, row.on_day, Math.abs(Number(row.quantity_delta_milli)) / 1000);
  }
  return usage;
}

async function supplySnapshot(db: Db, branchId: number, productIds: number[]) {
  const snapshot = { on_order: new Map<number, number>(), warehouse_stock: new Map<number, number>(), units: new Map<number, string>(), pack_sizes: new Map<number, number | null>(), reorder_status: new Map<number, string>() };
  if (!productIds.length) return snapshot;
  const ids = `{${productIds.join(',')}}`;
  const lines = await db.query(
    // On order = every open, submitted request not yet received by the branch (backorder children
    // included). A split request counts its endorsed quantity, so parent + backorder never double up.
    `select item.product_id, coalesce(item.quantity_endorsed, item.quantity_requested) as quantity_requested, item.quantity_fulfilled
     from supply_request_items item join supply_requests request on request.id = item.supply_request_id
     where request.location_id = $1 and request.status in (${sqlList(SUBMITTED_OPEN)}) and request.branch_received_at is null and item.product_id = any($2::bigint[])`, [branchId, ids],
  );
  for (const line of lines) {
    const remaining = Math.max(0, Number(line.quantity_requested) - Number(line.quantity_fulfilled ?? 0));
    snapshot.on_order.set(line.product_id, (snapshot.on_order.get(line.product_id) ?? 0) + remaining);
  }
  const [store] = await db.query(`select id from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
  if (store) {
    for (const row of await db.query(`select product_id, current_stock from inventories where location_id = $1 and product_id = any($2::bigint[])`, [store.id, ids])) snapshot.warehouse_stock.set(row.product_id, Number(row.current_stock));
  }
  for (const row of await db.query(`select product_id, current_stock, reorder_level, critical_level from inventories where location_id = $1 and product_id = any($2::bigint[])`, [branchId, ids])) {
    const stock = Number(row.current_stock);
    snapshot.reorder_status.set(row.product_id, stock <= Number(row.critical_level) ? 'critical' : stock <= Number(row.reorder_level) ? 'low' : 'normal');
  }
  for (const row of await db.query(`select id, unit, pack_size from products where id = any($1::bigint[])`, [ids])) {
    snapshot.units.set(row.id, String(row.unit));
    snapshot.pack_sizes.set(row.id, row.pack_size === null ? null : Number(row.pack_size));
  }
  return snapshot;
}

/** Closed days per week, counting a calendar day once even when closures overlap. */
function closureCoverage(weeks: string[], closures: Row[]): Map<string, number> {
  const coverage = new Map<string, number>();
  for (const week of weeks) {
    const end = weekEnd(week);
    const days = new Set<string>();
    for (const closure of closures) {
      const to = closure.ends_on < end ? closure.ends_on : end;
      for (let cursor = closure.starts_on > week ? closure.starts_on : week; cursor <= to; cursor = addDays(cursor, 1)) days.add(cursor);
    }
    coverage.set(week, Math.min(7, days.size));
  }
  return coverage;
}

const closureReason = (closed: number) => (closed >= 7 ? 'Branch closed all week' : `Branch closed ${closed} of 7 days`);
function flagDetails(flag: string, actual: number, typical: number) {
  const difference = actual - typical;
  const percent = typical > 0 ? (Math.abs(difference) / typical) * 100 : null;
  const label = flag === 'spike' ? 'Spike' : 'Dip';
  return {
    typical: phpRound(typical, 3), difference: phpRound(difference, 3), difference_percent: percent === null ? null : phpRound(percent, 1),
    note: percent === null ? `${label}: typical week is zero` : `${label}: ${phpRound(percent)}% ${difference >= 0 ? 'above' : 'below'} typical`,
  };
}

const longDate = (date: string) => {
  const d = parse(date);
  return `${monthDay(d)}, ${d.getUTCFullYear()}`;
};
const round3 = (n: number | null) => (n === null ? null : phpRound(n, 3));

export function openingDate(location: Row, firstActivity: string | null): string | null {
  return location.opening_date ? String(location.opening_date).slice(0, 10) : firstActivity;
}

/** Estimates every active material of one branch. */
export async function forLocation(db: Db, location: Row, horizon: number, settings: ForecastSettings) {
  const currentWeek = weekStart(manilaToday());
  const weeks = weekWindow(Math.max(settings.minimum_included_weeks, LOOKBACK_WEEKS), currentWeek);
  const firstActivity = (await firstActivityDates(db, [location.id]))[location.id] ?? null;
  const opening = openingDate(location, firstActivity);
  const closures = await db.query(`select starts_on, ends_on, reason from forecast_closure_periods where location_id = $1 and deleted_at is null order by starts_on`, [location.id]);
  const exclusions = await db.query(`select material_id, week_start, reason from forecast_week_exclusions where location_id = $1 and deleted_at is null and week_start >= $2::date`, [location.id, weeks[0]]);
  const active = await activeWeeks(db, location.id, weeks[0], currentWeek);
  const usage = await usageByWeek(db, location.id, weeks[0], currentWeek, settings.include_manual_deductions);
  const firstStocked = await firstStockedDates(db, location.id);
  const materials = await db.query(`select * from profittrack_materials where location_id = $1 and is_active = true order by name, variant`, [location.id]);
  const productIds = [...new Set(materials.map((m) => m.warehouse_product_id).filter((id) => id !== null))] as number[];
  const snapshot = await supplySnapshot(db, location.id, productIds);
  const balances = new Map((await db.query(`select material_id, quantity_milli from profittrack_material_balances where location_id = $1`, [location.id])).map((b) => [b.material_id, Number(b.quantity_milli) / 1000]));
  const branchExclusions = new Map<string, string>();
  const materialExclusions = new Map<number, Map<string, string>>();
  for (const row of exclusions) {
    const week = String(row.week_start).slice(0, 10);
    if (row.material_id === null) branchExclusions.set(week, row.reason);
    else {
      if (!materialExclusions.has(row.material_id)) materialExclusions.set(row.material_id, new Map());
      materialExclusions.get(row.material_id)!.set(week, row.reason);
    }
  }
  const coverage = closureCoverage(weeks, closures.map((c) => ({ starts_on: String(c.starts_on).slice(0, 10), ends_on: String(c.ends_on).slice(0, 10) })));

  const items = materials.map((material) => buildItem(material, {
    weeks, currentWeek, opening, coverage, settings, branchExclusions, materialExclusions: materialExclusions.get(material.id) ?? new Map(), active,
    usage: usage.get(material.id) ?? new Map(), firstStockedOn: firstStocked.get(material.id) ?? null, onHand: balances.get(material.id) ?? 0, snapshot, horizon,
  }));
  return {
    generated_at: new Date().toISOString(), horizon_weeks: horizon, timezone: TZ, settings,
    weeks: weeks.slice(-CHART_WEEKS).map((week) => ({ week_start: week, week_end: weekEnd(week), label: weekLabel(week) })),
    items,
  };
}

interface ItemContext {
  weeks: string[]; currentWeek: string; opening: string | null; coverage: Map<string, number>; settings: ForecastSettings; branchExclusions: Map<string, string>; materialExclusions: Map<string, string>;
  active: Set<string>; usage: Map<string, number>; firstStockedOn: string | null; onHand: number; snapshot: Awaited<ReturnType<typeof supplySnapshot>>; horizon: number;
}

function buildItem(material: Row, x: ItemContext): Row {
  const { settings, snapshot } = x;
  const closedThreshold = Math.max(1, settings.closed_days_threshold);
  const stockedWeek = x.firstStockedOn === null ? null : weekStart(x.firstStockedOn);
  const notStocked = x.firstStockedOn === null ? 'This item has not been stocked or used at this branch yet.' : `Not yet stocked — first stocked or used on ${longDate(x.firstStockedOn)}.`;

  const rows: Row[] = x.weeks.map((week) => {
    const closedDays = Math.min(7, x.coverage.get(week) ?? 0);
    let reason: string | null = null;
    let status = 'included';
    // The week holding the opening day counts as a full week only from the next Monday on.
    if (x.opening !== null && week < x.opening) { status = 'not_yet_open'; reason = 'The branch had not opened in this week.'; }
    else if (week === x.currentWeek) status = 'incomplete';
    else if (x.materialExclusions.has(week) || x.branchExclusions.has(week)) { status = 'excluded'; reason = x.materialExclusions.get(week) ?? x.branchExclusions.get(week)!; }
    else if (closedDays >= closedThreshold) { status = 'closed'; reason = closureReason(closedDays); }
    else if (stockedWeek === null || week < stockedWeek) { status = 'not_yet_stocked'; reason = notStocked; }
    else if (closedDays > 0) { status = 'partly_closed'; reason = closureReason(closedDays); }
    else if (!x.active.has(week)) status = 'no_records';
    const used = phpRound(x.usage.get(week) ?? 0, 3);
    return {
      week_start: week, week_end: weekEnd(week), label: weekLabel(week), status, reason, usage: used, adjusted_usage: used, flagged: null, closed_days: closedDays,
      is_included: status === 'included' || status === 'partly_closed',
    };
  });

  const included = rows.filter((r) => r.is_included);
  const raw = included.map((r) => r.usage as number);
  const found = outliers(raw, settings.detection_weeks, settings.cap_spikes_and_dips);
  const typical = found.status === 'ok' ? median(raw) : null;
  included.forEach((row, position) => {
    const flag = found.flags[position];
    row.flagged = flag;
    row.adjusted_usage = phpRound(found.adjusted[position] ?? row.usage, 3);
    if (flag !== null && typical !== null) Object.assign(row, flagDetails(flag, row.usage, typical));
  });
  const adjusted = found.adjusted;
  const ready = included.length >= settings.minimum_included_weeks;
  const average = ready ? weightedAverage(adjusted) : null;
  const range = ready ? normalRange(adjusted) : null;
  const direction = trend(adjusted, settings.trend_threshold_percent);

  const productId: number | null = material.warehouse_product_id;
  const productUnit = productId === null ? null : snapshot.units.get(productId) ?? null;
  const unitMatch = productUnit !== null && String(material.unit).trim().toLowerCase() === productUnit.trim().toLowerCase();
  const mappingNote = productId === null ? 'No warehouse product linked.' : productUnit === null ? 'Linked warehouse product is missing.'
    : !unitMatch ? `Warehouse product is in ${productUnit}, the material is in ${material.unit}.` : null;
  const onOrder = unitMatch ? snapshot.on_order.get(productId!) ?? 0 : null;
  const warehouseStock = unitMatch ? snapshot.warehouse_stock.get(productId!) ?? 0 : null;
  const onOrderNote = productId === null ? 'No warehouse product linked: on-order not counted' : productUnit !== null && !unitMatch ? 'Unit mismatch: on-order not counted'
    : productUnit === null ? 'Warehouse product missing: on-order not counted' : null;
  const packSize = unitMatch ? snapshot.pack_sizes.get(productId!) ?? null : null;
  const safety = range?.deviation ?? 0;
  const daysLeft = ready ? daysOfCover(x.onHand, average) : null;
  const reorderRaw = ready ? suggestedReorder(average, x.horizon, settings.lead_time_days, safety, x.onHand, onOrder ?? 0) : null;
  const status = daysLeft === null ? 'ok' : daysLeft < settings.runs_out_days ? 'runs_out_soon' : daysLeft < settings.watch_days ? 'watch' : 'ok';

  return {
    material_id: material.id, name: String(material.name), variant: String(material.variant), unit: String(material.unit), unit_precision: unitPrecision(String(material.unit)), first_stocked_on: x.firstStockedOn,
    included_weeks: included.length, needed_weeks: Math.max(0, settings.minimum_included_weeks - included.length), ready, weighted_average: round3(average),
    normal_range: range === null ? null : { low: round3(range.low), high: round3(range.high), average: round3(range.average), deviation: round3(range.deviation) },
    safety_stock: round3(safety),
    trend: { direction: direction.direction, change_percent: direction.change_percent === null ? null : phpRound(direction.change_percent, 2), recent_average: round3(direction.recent_average), previous_average: round3(direction.previous_average) },
    outliers: { status: found.status, typical: round3(typical), low_fence: round3(found.fences.low), high_fence: round3(found.fences.high), capped: settings.cap_spikes_and_dips },
    on_hand: round3(x.onHand), on_order: round3(onOrder), on_order_note: onOrderNote, reorder_status: productId === null ? null : snapshot.reorder_status.get(productId) ?? null, pack_size: packSize,
    warehouse_stock: round3(warehouseStock), days_left: daysLeft === null ? null : phpRound(daysLeft, 1), status,
    estimated_need: average === null ? null : round3(average * Math.max(1, x.horizon)), suggested_reorder_raw: round3(reorderRaw), suggested_reorder: reorderRaw === null ? null : roundUpToPack(reorderRaw, packSize),
    warehouse_product: { product_id: productId, unit: productUnit, unit_match: unitMatch, note: mappingNote },
    weeks: rows.slice(-CHART_WEEKS),
  };
}
