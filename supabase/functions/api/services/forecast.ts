// The "Estimated requirement", daily model. Statistical and rule-based only (no AI/ML): it summarizes the
// usage a branch already recorded (Descriptive) and projects a flat daily rate from it (Predictive).
// Estimates support decisions; they never create orders or change stock. Computed on every request.
//
// Pipeline per branch material:
//   1. A status for every day back to MAX_LOOKBACK_DAYS. A day is left out when it is before the branch
//      opened, today (incomplete), a closure day, in an excluded week, before the material was first
//      stocked or used, or a day the branch recorded nothing at all ("No records that day"). Every other
//      day is an open day, and zero usage on an open day is real data.
//   2. The window: the newest `lookback_open_days` open days, ending yesterday.
//   3. Dips and spikes: Tukey fences (outliers()), capped or included; recorded usage is never changed.
//   4. Demand pattern (Syntetos–Boylan): ADI and CV² → smooth (WMA), erratic (SES), intermittent or
//      lumpy (Croston). The method only switches after the new pattern held `method_switch_days` open days.
//   5. Daily rate, one-step-ahead RMSE as the forecast error, safety stock = z × error × √cover days,
//      target, suggested reorder rounded up to the pack size; days of cover and status.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, manilaToday } from '../lib/http.ts';
import { resolveWorkspace } from './branchAccess.ts';
import { SUBMITTED_OPEN, sqlList } from './supplyStatus.ts';

const TZ = 'Asia/Manila';
/** The window never reaches further back than this, whatever was closed or excluded. */
export const MAX_LOOKBACK_DAYS = 120;
/** How many recent windows are classified to apply the method-switch rule. */
const CLASS_HISTORY_DAYS = 30;
/** One-step-ahead errors start after this warm-up (the first forecast needs 7 open days). */
const WARM_UP_DAYS = 7;
export const HORIZON_DAYS = [7, 14, 30] as const;
/** Legacy horizon in weeks (1 | 2 | 4) → days; 4 weeks reads as "1 month" = 30 days. */
export function horizonDays(value: unknown): number {
  const n = Number(value ?? 7);
  if (n === 1) return 7;
  if (n === 2) return 14;
  if (n === 4) return 30;
  return (HORIZON_DAYS as readonly number[]).includes(n) ? n : 7;
}

export const FORECAST_DEFAULTS = {
  // Weekly-model columns: kept in the table (and on a fresh row) but no longer read.
  minimum_included_weeks: 4, detection_weeks: 8, closed_days_threshold: 4, runs_out_days: 5, watch_days: 10,
  // Read by the daily model.
  include_manual_deductions: true, cap_spikes_and_dips: true, trend_threshold_percent: 10, lead_time_days: 0, closure_backdate_weeks: 8,
  lookback_open_days: 28, minimum_open_days: 14, adi_cutoff: 1.32, cv2_cutoff: 0.49, ses_alpha: 0.2, croston_alpha: 0.1, z_score: 1.65,
  low_cover_days: 4, overstock_days: 14, method_switch_days: 3, stale_count_days: 7,
};

/** PHP's round(): half away from zero, ignoring float noise past 15 significant digits. */
export function phpRound(value: number, places = 0): number {
  const factor = 10 ** places;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

// ---- Dates on plain YYYY-MM-DD strings (weeks are still used by the week exclusions) ----
const parse = (date: string) => new Date(`${date.slice(0, 10)}T00:00:00Z`);
const format = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => format(new Date(parse(date).getTime() + days * 86_400_000));
export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
export const isMonday = (date: string) => parse(date).getUTCDay() === 1;
export const weekStart = (date: string) => addDays(date, -((parse(date).getUTCDay() + 6) % 7));
export const weekEnd = (start: string) => addDays(start, 6);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthDay = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
export function weekLabel(start: string): string {
  const a = parse(start);
  const b = parse(weekEnd(start));
  return `${monthDay(a)} – ${a.getUTCMonth() === b.getUTCMonth() ? b.getUTCDate() : monthDay(b)}`;
}
export const longDate = (date: string) => `${monthDay(parse(date))}, ${parse(date).getUTCFullYear()}`;

// ---- Statistics ----
const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null);
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
/** Population standard deviation. */
const populationSd = (values: number[]) => {
  const m = mean(values);
  return m === null ? null : Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
};

/** Q1/Q3 ∓ 1.5 IQR; a flat history falls back to double or half the median, bound included. */
export function outliers(values: number[], minimum: number, cap: boolean) {
  const flags: (string | null)[] = values.map(() => null);
  const skipped = { status: 'skipped_sparse', fences: { low: null as number | null, high: null as number | null }, flags, adjusted: values };
  if (values.length < Math.max(2, minimum)) return { ...skipped, status: 'insufficient_history' };
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

// ---- Demand pattern (Syntetos–Boylan) ----
export type Pattern = 'smooth' | 'erratic' | 'intermittent' | 'lumpy';
export type Method = 'wma' | 'ses' | 'croston';
export const METHOD_OF: Record<Pattern, Method> = { smooth: 'wma', erratic: 'ses', intermittent: 'croston', lumpy: 'croston' };
export const METHOD_LABEL: Record<Method, string> = { wma: 'WMA', ses: 'SES', croston: 'Croston' };

/** ADI = open days ÷ days with usage; CV² = (population sd ÷ mean)² of the non-zero days. Null without usage. */
export function demandPattern(values: number[], adiCutoff: number, cv2Cutoff: number): { pattern: Pattern; adi: number; cv2: number } | null {
  const nonZero = values.filter((v) => v > 0);
  if (!nonZero.length) return null;
  const adi = values.length / nonZero.length;
  const m = mean(nonZero)!;
  const cv2 = nonZero.length < 2 || m <= 0 ? 0 : (populationSd(nonZero)! / m) ** 2;
  const frequent = adi < adiCutoff;
  const steady = cv2 < cv2Cutoff;
  const pattern: Pattern = frequent ? (steady ? 'smooth' : 'erratic') : (steady ? 'intermittent' : 'lumpy');
  return { pattern, adi, cv2 };
}

// ---- Methods: the daily rate after the given series (oldest first) ----
/** WMA: the last 7 days weighted 7 (newest) down to 1. */
export function wmaRate(values: number[]): number | null {
  const take = values.slice(-7);
  if (!take.length) return null;
  const weights = take.map((_, i) => i + 1); // oldest 1 … newest 7
  return sum(take.map((v, i) => v * weights[i])) / sum(weights);
}
/** SES: the level starts at the mean of the first 7 days and is smoothed with alpha over the rest. */
export function sesRate(values: number[], alpha: number): number | null {
  if (!values.length) return null;
  let level = mean(values.slice(0, WARM_UP_DAYS))!;
  for (let t = WARM_UP_DAYS; t < values.length; t += 1) level += alpha * (values[t] - level);
  return level;
}
/** Croston: non-zero sizes (z) and intervals between them (p) smoothed with alpha; rate = z ÷ p. */
export function crostonRate(values: number[], alpha: number): number | null {
  const first = values.findIndex((v) => v > 0);
  if (first < 0) return null;
  let z = values[first];
  let p = first + 1; // days up to and including the first demand
  let last = first;
  for (let t = first + 1; t < values.length; t += 1) {
    if (values[t] > 0) {
      z += alpha * (values[t] - z);
      p += alpha * (t - last - p);
      last = t;
    }
  }
  return z / p;
}
export function methodRate(method: Method, values: number[], settings: ForecastSettings): number | null {
  if (method === 'wma') return wmaRate(values);
  if (method === 'ses') return sesRate(values, settings.ses_alpha);
  return crostonRate(values, settings.croston_alpha);
}
/**
 * Forecast error: root mean square of the one-step-ahead errors over the window. The forecast for day t
 * uses only days before t; days 1–7 are warm-up. Croston has no forecast before its first demand.
 */
export function forecastError(method: Method, values: number[], settings: ForecastSettings): { rmse: number; points: number } {
  const errors: number[] = [];
  for (let t = WARM_UP_DAYS; t < values.length; t += 1) {
    const forecast = methodRate(method, values.slice(0, t), settings);
    if (forecast === null) continue;
    errors.push(forecast - values[t]);
  }
  return { rmse: errors.length ? Math.sqrt(sum(errors.map((e) => e * e)) / errors.length) : 0, points: errors.length };
}

// ---- Reorder math ----
export function roundUpToPack(value: number, pack: number | null): number {
  if (value <= 0) return 0;
  if (pack === null || pack <= 0) return Math.ceil(value - 1e-9);
  return phpRound(Math.ceil(value / pack - 1e-9) * pack, 3);
}
/** Lead time + horizon, capped by the material's max cover days (perishables). */
export function coverPeriod(leadDays: number, horizon: number, maxCoverDays: number | null) {
  const full = Math.max(0, leadDays) + horizon;
  const capped = maxCoverDays !== null && maxCoverDays > 0 && maxCoverDays < full;
  return { days: capped ? maxCoverDays! : full, full, capped };
}
/** Safety, target and suggested reorder (before pack rounding) from the daily rate and its error. */
export function reorderMath(rate: number, error: number, horizon: number, cover: number, z: number, onHand: number, onOrder: number) {
  const safety = z * error * Math.sqrt(cover);
  const need = rate * horizon;
  const target = rate * cover + safety;
  const raw = Math.max(0, target - Math.max(0, onHand) - Math.max(0, onOrder));
  return { safety, need, target, raw };
}
export function coverStatus(daysOfCover: number | null, settings: ForecastSettings): string {
  if (daysOfCover === null) return 'no_estimate';
  if (daysOfCover < settings.low_cover_days) return 'low_cover';
  if (daysOfCover > settings.overstock_days) return 'overstocked';
  return 'normal';
}
/** Last 7 open days against the 7 before them. */
export function usageTrend(values: number[], thresholdPercent: number) {
  if (values.length < 14) return { direction: 'insufficient', change_percent: null, last_7: null, previous_7: null };
  const last = sum(values.slice(-7));
  const previous = sum(values.slice(-14, -7));
  if (previous <= 0) return { direction: 'insufficient', change_percent: null, last_7: last, previous_7: previous };
  const change = ((last - previous) / previous) * 100;
  return { direction: change > thresholdPercent ? 'up' : change < -thresholdPercent ? 'down' : 'flat', change_percent: change, last_7: last, previous_7: previous };
}

const WHOLE_UNITS = new Set(['pcs', 'pc', 'piece', 'pieces', 'pack', 'packs', 'box', 'boxes', 'bottle', 'bottles', 'can', 'cans', 'sachet', 'sachets', 'bag', 'bags', 'tray', 'trays', 'sack', 'sacks', 'g', 'gram', 'grams', 'ml', 'millilitre', 'milliliter', 'each', 'unit', 'units']);
const FINE_UNITS = new Set(['kg', 'kilogram', 'kilograms', 'l', 'liter', 'litre', 'liters', 'litres']);
const unitPrecision = (unit: string) => {
  const key = unit.trim().toLowerCase();
  return WHOLE_UNITS.has(key) ? 0 : FINE_UNITS.has(key) ? 3 : 2;
};

// ---- Settings ----
export interface ForecastSettings {
  include_manual_deductions: boolean; cap_spikes_and_dips: boolean; trend_threshold_percent: number; lead_time_days: number; closure_backdate_weeks: number;
  lookback_open_days: number; minimum_open_days: number; adi_cutoff: number; cv2_cutoff: number; ses_alpha: number; croston_alpha: number; z_score: number;
  low_cover_days: number; overstock_days: number; method_switch_days: number; stale_count_days: number;
}
const num = (value: unknown, fallback: number) => (value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value));
const clamp = (value: unknown, min: number, max: number, fallback: number) => Math.max(min, Math.min(max, num(value, fallback)));
const clampInt = (value: unknown, min: number, max: number, fallback: number) => Math.max(min, Math.min(max, Math.trunc(num(value, fallback))));

/** The single settings row, created with the defaults on first read. */
export async function settingsRow(db: Db): Promise<Row> {
  const [row] = await db.query(`select * from forecast_settings order by id limit 1`);
  return row ?? insertRow(db, 'forecast_settings', FORECAST_DEFAULTS);
}
export function settingsFrom(row: Row): ForecastSettings {
  const d = FORECAST_DEFAULTS;
  const lowCover = clamp(row.low_cover_days, 0, 60, d.low_cover_days);
  const lookback = clampInt(row.lookback_open_days, 14, 90, d.lookback_open_days);
  return {
    include_manual_deductions: row.include_manual_deductions === undefined ? d.include_manual_deductions : Boolean(row.include_manual_deductions),
    cap_spikes_and_dips: row.cap_spikes_and_dips === undefined ? d.cap_spikes_and_dips : Boolean(row.cap_spikes_and_dips),
    trend_threshold_percent: Math.max(0, num(row.trend_threshold_percent, d.trend_threshold_percent)),
    lead_time_days: clampInt(row.lead_time_days, 0, 365, d.lead_time_days),
    closure_backdate_weeks: clampInt(row.closure_backdate_weeks, 1, 52, d.closure_backdate_weeks),
    lookback_open_days: lookback,
    // The window must be able to reach readiness.
    minimum_open_days: Math.min(lookback, clampInt(row.minimum_open_days, 7, 60, d.minimum_open_days)),
    adi_cutoff: clamp(row.adi_cutoff, 1, 3, d.adi_cutoff),
    cv2_cutoff: clamp(row.cv2_cutoff, 0.1, 2, d.cv2_cutoff),
    ses_alpha: clamp(row.ses_alpha, 0.05, 0.9, d.ses_alpha),
    croston_alpha: clamp(row.croston_alpha, 0.05, 0.9, d.croston_alpha),
    z_score: clamp(row.z_score, 0, 3.5, d.z_score),
    low_cover_days: lowCover,
    // Overstocked must stay above Low cover so both statuses stay reachable.
    overstock_days: Math.max(lowCover + 1, clamp(row.overstock_days, 1, 365, d.overstock_days)),
    method_switch_days: clampInt(row.method_switch_days, 1, 14, d.method_switch_days),
    stale_count_days: clampInt(row.stale_count_days, 1, 30, d.stale_count_days),
  };
}

// ---- Access ----
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

// ---- Data ----
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

export function openingDate(location: Row, firstActivity: string | null): string | null {
  return location.opening_date ? String(location.opening_date).slice(0, 10) : firstActivity;
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

/** Days on which the branch recorded anything at all (production, a count, a receipt, any movement). */
async function activeDays(db: Db, locationId: number, from: string, to: string): Promise<Set<string>> {
  const end = addDays(to, 1);
  const rows = await db.query(
    `select distinct on_day from (
       select ${day('occurred_at')} as on_day from profittrack_operations where location_id = $1 and occurred_at >= ${moment('$2')} and occurred_at < ${moment('$3')}
       union all select ${day('occurred_at')} from profittrack_material_movements where location_id = $1 and occurred_at >= ${moment('$2')} and occurred_at < ${moment('$3')}
       union all select ${day('t.transaction_date')} from inventory_transactions t join inventories i on i.id = t.inventory_id where i.location_id = $1 and t.transaction_date >= ${moment('$2')} and t.transaction_date < ${moment('$3')}
     ) x`, [locationId, from, end],
  );
  return new Set(rows.map((r) => String(r.on_day)));
}

/** The branch's latest recorded activity on or before today (the data-freshness note). */
async function lastActivityDate(db: Db, locationId: number): Promise<string | null> {
  const [row] = await db.query(
    `select max(on_day) as last_on from (
       select max(${day('occurred_at')}) as on_day from profittrack_operations where location_id = $1 and occurred_at < ${moment('$2')}
       union all select max(${day('occurred_at')}) from profittrack_material_movements where location_id = $1 and occurred_at < ${moment('$2')}
       union all select max(${day('t.transaction_date')}) from inventory_transactions t join inventories i on i.id = t.inventory_id where i.location_id = $1 and t.transaction_date < ${moment('$2')}
     ) x`, [locationId, addDays(manilaToday(), 1)],
  );
  return row?.last_on ? String(row.last_on).slice(0, 10) : null;
}

async function usageByDay(db: Db, locationId: number, from: string, to: string, includeManual: boolean) {
  const end = addDays(to, 1);
  const usage = new Map<number, Map<string, number>>();
  const add = (material: number, onDay: string, quantity: number) => {
    if (!usage.has(material)) usage.set(material, new Map());
    const days = usage.get(material)!;
    days.set(onDay, (days.get(onDay) ?? 0) + quantity);
  };
  const production = await db.query(
    `select pc.material_id, pc.quantity_milli, ${day('o.occurred_at')} as on_day from profittrack_production_consumptions pc join profittrack_production_batches b on b.id = pc.batch_id join profittrack_operations o on o.id = b.operation_id
     where pc.location_id = $1 and b.voided_at is null and o.occurred_at >= ${moment('$2')} and o.occurred_at < ${moment('$3')}`, [locationId, from, end],
  );
  for (const row of production) add(row.material_id, String(row.on_day), Number(row.quantity_milli) / 1000);
  if (includeManual) {
    // Only the negative half of a physical count is usage: spoilage, damage or a correction.
    const deductions = await db.query(
      `select material_id, quantity_delta_milli, ${day('occurred_at')} as on_day from profittrack_material_movements
       where location_id = $1 and type = 'physical_count' and quantity_delta_milli < 0 and occurred_at >= ${moment('$2')} and occurred_at < ${moment('$3')}`, [locationId, from, end],
    );
    for (const row of deductions) add(row.material_id, String(row.on_day), Math.abs(Number(row.quantity_delta_milli)) / 1000);
  }
  return usage;
}

/** The latest physical count per material (the "Last counted" column and the stale-count card). */
async function lastCounts(db: Db, locationId: number): Promise<Map<number, string>> {
  const rows = await db.query(
    `select material_id, max(${day('occurred_at')}) as counted_on from profittrack_material_movements where location_id = $1 and type = 'physical_count' group by material_id`, [locationId],
  );
  return new Map(rows.map((r) => [r.material_id, String(r.counted_on)]));
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

const round3 = (n: number | null | undefined) => (n === null || n === undefined ? null : phpRound(n, 3));
const round2 = (n: number | null | undefined) => (n === null || n === undefined ? null : phpRound(n, 2));

export const DAY_STATUS_LABELS: Record<string, string> = {
  open: 'Counted', not_yet_open: 'Before the branch opened', incomplete: 'Today (still running)', closed: 'Branch closed', excluded: 'Left out (week excluded)',
  not_yet_stocked: 'Before this item was stocked', no_records: 'No records that day',
};

/** The status of one branch day for one material; null = an open day. */
function dayStatus(date: string, x: BranchContext, materialExclusions: Map<string, string>, firstStockedOn: string | null): { status: string; reason: string | null } {
  if (x.opening !== null && date < x.opening) return { status: 'not_yet_open', reason: 'The branch had not opened yet.' };
  if (date >= x.today) return { status: 'incomplete', reason: 'Today is still running.' };
  const closure = x.closedDays.get(date);
  if (closure !== undefined) return { status: 'closed', reason: closure };
  const week = weekStart(date);
  const excluded = materialExclusions.get(week) ?? x.branchExclusions.get(week);
  if (excluded !== undefined) return { status: 'excluded', reason: excluded };
  if (firstStockedOn === null || date < firstStockedOn) {
    return { status: 'not_yet_stocked', reason: firstStockedOn === null ? 'Not stocked or used at this branch yet.' : `First stocked or used on ${longDate(firstStockedOn)}.` };
  }
  if (!x.active.has(date)) return { status: 'no_records', reason: 'No records that day.' };
  return { status: 'open', reason: null };
}

interface BranchContext {
  today: string; yesterday: string; from: string; opening: string | null; closedDays: Map<string, string>; branchExclusions: Map<string, string>;
  active: Set<string>; settings: ForecastSettings; horizon: number; snapshot: Awaited<ReturnType<typeof supplySnapshot>>;
}

/** Applies the cap/raw option to one window and classifies it. */
function analyseWindow(values: number[], settings: ForecastSettings) {
  const found = outliers(values, settings.minimum_open_days, settings.cap_spikes_and_dips);
  const series = found.adjusted;
  return { found, series, pattern: demandPattern(series, settings.adi_cutoff, settings.cv2_cutoff) };
}

/**
 * The method-switch rule, stateless: classify the windows ending on each of the latest open days (newest
 * first). The current pattern is the newest run of `method_switch_days` identical patterns; without such a
 * run (a new item) the oldest classified window's pattern applies, so the first pattern is used at once.
 */
export function stablePattern(recent: (Pattern | null)[], switchDays: number): { pattern: Pattern | null; pending: { pattern: Pattern; days: number; needed: number } | null } {
  const sequence: Pattern[] = [];
  for (const p of recent) { if (p === null) break; sequence.push(p); }
  if (!sequence.length) return { pattern: null, pending: null };
  let current: Pattern | null = null;
  for (let i = 0; i + switchDays <= sequence.length; i += 1) {
    if (sequence.slice(i, i + switchDays).every((p) => p === sequence[i])) { current = sequence[i]; break; }
  }
  if (current === null) current = sequence[sequence.length - 1];
  let lead = 0;
  while (lead < sequence.length && sequence[lead] === sequence[0]) lead += 1;
  const pending = sequence[0] !== current ? { pattern: sequence[0], days: lead, needed: switchDays } : null;
  return { pattern: current, pending };
}

function buildItem(material: Row, x: BranchContext, data: { usage: Map<string, number>; firstStockedOn: string | null; onHand: number; lastCounted: string | null; exclusions: Map<string, string> }): Row {
  const { settings, snapshot } = x;
  // Every day from the oldest considered day to yesterday, with its status (oldest first).
  const days: Row[] = [];
  for (let date = x.from; date <= x.yesterday; date = addDays(date, 1)) {
    const { status, reason } = dayStatus(date, x, data.exclusions, data.firstStockedOn);
    days.push({ date, status, reason, usage: phpRound(data.usage.get(date) ?? 0, 3) });
  }
  const openDays = days.filter((d) => d.status === 'open');
  const window = openDays.slice(-settings.lookback_open_days);
  const values = window.map((d) => d.usage as number);
  const openCount = window.length;
  const enoughDays = openCount >= settings.minimum_open_days;
  const { found, series, pattern: latest } = analyseWindow(values, settings);
  window.forEach((d, i) => {
    d.adjusted_usage = phpRound(series[i] ?? d.usage, 3);
    d.flagged = found.flags[i] ?? null;
  });
  const ready = enoughDays && latest !== null;
  const notReadyReason = !enoughDays ? `Needs ${settings.minimum_open_days - openCount} more day${settings.minimum_open_days - openCount === 1 ? '' : 's'}`
    : latest === null ? 'No usage recorded yet' : null;

  // Stable classification over the windows ending on each of the latest open days.
  const recent: (Pattern | null)[] = [];
  if (ready) {
    for (let end = openDays.length; end > 0 && recent.length < CLASS_HISTORY_DAYS; end -= 1) {
      const slice = openDays.slice(Math.max(0, end - settings.lookback_open_days), end).map((d) => d.usage as number);
      if (slice.length < settings.minimum_open_days) break;
      recent.push(analyseWindow(slice, settings).pattern?.pattern ?? null);
    }
  }
  const stable = ready ? stablePattern(recent, settings.method_switch_days) : { pattern: null, pending: null };
  const pattern = stable.pattern;
  const method = pattern ? METHOD_OF[pattern] : null;

  // Daily rate, error and reorder (only for a ready item).
  const rate = method ? methodRate(method, series, settings) : null;
  const error = method ? forecastError(method, series, settings) : null;
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
  const maxCover = material.max_cover_days === null || material.max_cover_days === undefined ? null : Number(material.max_cover_days);
  const cover = coverPeriod(settings.lead_time_days, x.horizon, maxCover);
  const math = rate !== null && error !== null ? reorderMath(rate, error.rmse, x.horizon, cover.days, settings.z_score, data.onHand, onOrder ?? 0) : null;
  const daysOfCover = rate !== null && rate > 0 ? (Math.max(0, data.onHand) + (onOrder ?? 0)) / rate : null;
  const daysOnHand = rate !== null && rate > 0 ? Math.max(0, data.onHand) / rate : null;
  const status = ready ? coverStatus(daysOfCover, settings) : 'no_estimate';

  // Descriptive figures (on the series the dips option chose).
  const avgDaily = values.length ? mean(series)! : null;
  const zeroDays = values.length ? (values.filter((v) => v === 0).length / values.length) * 100 : null;
  const trendResult = usageTrend(series, settings.trend_threshold_percent);
  const daysSinceCount = data.lastCounted === null ? null : daysBetween(data.lastCounted, x.today);
  const windowFrom = window[0]?.date ?? null;
  const left = days.filter((d) => windowFrom !== null && d.date >= windowFrom && ['closed', 'excluded', 'no_records'].includes(d.status));
  // The chart: the window, and always at least the last lookback_open_days calendar days, to yesterday,
  // with a 7-open-day average.
  const recentFrom = addDays(x.today, -settings.lookback_open_days);
  const chartFrom = windowFrom !== null && windowFrom < recentFrom ? windowFrom : recentFrom;
  const chartDays = days.filter((d) => d.date >= chartFrom);
  let seen: number[] = [];
  for (const d of chartDays) {
    if (d.status === 'open') {
      seen = [...seen, (d.adjusted_usage ?? d.usage) as number].slice(-7);
      d.avg7 = seen.length === 7 ? round3(mean(seen)) : null;
    } else d.avg7 = null;
    d.offset = daysBetween(x.today, d.date);
  }

  return {
    material_id: material.id, name: String(material.name), variant: String(material.variant), unit: String(material.unit), unit_precision: unitPrecision(String(material.unit)),
    first_stocked_on: data.firstStockedOn, max_cover_days: maxCover,
    // Readiness
    ready, not_ready_reason: notReadyReason, open_days: openCount, needed_days: Math.max(0, settings.minimum_open_days - openCount),
    needed_weeks: Math.ceil(Math.max(0, settings.minimum_open_days - openCount) / 7), // kept for older clients
    window_from: windowFrom, window_to: window[window.length - 1]?.date ?? null,
    days_left_out: { closed: left.filter((d) => d.status === 'closed').length, excluded: left.filter((d) => d.status === 'excluded').length, no_records: left.filter((d) => d.status === 'no_records').length },
    // Descriptive
    avg_daily_use: round3(avgDaily), last_7_days: values.length >= 7 ? round3(sum(series.slice(-7))) : null, zero_days_percent: zeroDays === null ? null : phpRound(zeroDays, 1),
    trend: { direction: trendResult.direction, change_percent: trendResult.change_percent === null ? null : phpRound(trendResult.change_percent, 1), last_7: round3(trendResult.last_7), previous_7: round3(trendResult.previous_7) },
    last_counted_on: data.lastCounted, days_since_count: daysSinceCount, count_stale: daysSinceCount === null || daysSinceCount >= settings.stale_count_days,
    // Predictive
    pattern, method, method_label: method ? METHOD_LABEL[method] : null, low_confidence: pattern === 'lumpy',
    adi: latest ? phpRound(latest.adi, 2) : null, cv2: latest ? phpRound(latest.cv2, 2) : null, latest_pattern: latest?.pattern ?? null,
    pending_pattern: stable.pending,
    daily_rate: round3(rate), forecast_error: error ? round3(error.rmse) : null, error_points: error?.points ?? null,
    cover_days: cover.days, cover_days_full: cover.full, cover_capped: cover.capped,
    safety_stock: round3(math?.safety), estimated_need: round3(math?.need), target: round3(math?.target),
    suggested_reorder_raw: round3(math?.raw), suggested_reorder: math ? roundUpToPack(math.raw, packSize) : null,
    days_of_cover: daysOfCover === null ? null : phpRound(daysOfCover, 1), days_on_hand: daysOnHand === null ? null : phpRound(daysOnHand, 1),
    days_left: daysOnHand === null ? null : phpRound(daysOnHand, 1), // on hand only (the supply workflow's "days covered")
    status,
    outliers: {
      status: found.status, low_fence: round3(found.fences.low), high_fence: round3(found.fences.high), capped: settings.cap_spikes_and_dips,
      typical: found.status === 'ok' ? round3(median(values)) : null,
    },
    // Stock and supply
    on_hand: round3(data.onHand), on_order: round3(onOrder), on_order_note: onOrderNote, reorder_status: productId === null ? null : snapshot.reorder_status.get(productId) ?? null, pack_size: packSize,
    warehouse_stock: round3(warehouseStock), warehouse_product: { product_id: productId, unit: productUnit, unit_match: unitMatch, note: mappingNote },
    days: chartDays,
  };
}

/**
 * Estimates every active material of one branch. With an `actor` (a signed-in request), a changed demand
 * class is recorded once and audited as forecast.method_changed; without one nothing is written.
 */
export async function forLocation(db: Db, location: Row, horizon: number, settings: ForecastSettings, actor: Row | null = null) {
  const today = manilaToday();
  const yesterday = addDays(today, -1);
  const from = addDays(today, -MAX_LOOKBACK_DAYS);
  const firstActivity = (await firstActivityDates(db, [location.id]))[location.id] ?? null;
  const opening = openingDate(location, firstActivity);
  const closures = await db.query(`select starts_on, ends_on, reason from forecast_closure_periods where location_id = $1 and deleted_at is null and ends_on >= $2::date order by starts_on`, [location.id, from]);
  const exclusions = await db.query(`select material_id, week_start, reason from forecast_week_exclusions where location_id = $1 and deleted_at is null and week_start >= $2::date`, [location.id, weekStart(from)]);
  const active = await activeDays(db, location.id, from, yesterday);
  const usage = await usageByDay(db, location.id, from, yesterday, settings.include_manual_deductions);
  const firstStocked = await firstStockedDates(db, location.id);
  const counted = await lastCounts(db, location.id);
  const lastActivity = await lastActivityDate(db, location.id);
  const materials = await db.query(`select * from profittrack_materials where location_id = $1 and is_active = true order by name, variant`, [location.id]);
  const productIds = [...new Set(materials.map((m) => m.warehouse_product_id).filter((id) => id !== null))] as number[];
  const snapshot = await supplySnapshot(db, location.id, productIds);
  const balances = new Map((await db.query(`select material_id, quantity_milli from profittrack_material_balances where location_id = $1`, [location.id])).map((b) => [b.material_id, Number(b.quantity_milli) / 1000]));

  const closedDays = new Map<string, string>();
  for (const c of closures) {
    const end = String(c.ends_on).slice(0, 10);
    for (let d = String(c.starts_on).slice(0, 10); d <= end; d = addDays(d, 1)) if (!closedDays.has(d)) closedDays.set(d, String(c.reason));
  }
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
  const context: BranchContext = { today, yesterday, from, opening, closedDays, branchExclusions, active, settings, horizon, snapshot };
  const items = materials.map((material) => buildItem(material, context, {
    usage: usage.get(material.id) ?? new Map(), firstStockedOn: firstStocked.get(material.id) ?? null, onHand: balances.get(material.id) ?? 0,
    lastCounted: counted.get(material.id) ?? null, exclusions: materialExclusions.get(material.id) ?? new Map(),
  }));
  if (actor) await recordClassChanges(db, location.id, items, actor, today);
  return { generated_at: new Date().toISOString(), today, horizon_days: horizon, timezone: TZ, settings, last_activity_on: lastActivity, items };
}

/**
 * Records each ready item's class. Only rows whose pattern actually changes are written (one upsert with a
 * "distinct from" guard), so concurrent requests write and audit a change once. The first class of a
 * material is stored without an audit event; a later change is audited with before and after.
 */
async function recordClassChanges(db: Db, locationId: number, items: Row[], actor: Row, today: string) {
  const ready = items.filter((i) => i.pattern !== null);
  if (!ready.length) return;
  const stored = new Map((await db.query(`select material_id, pattern, method from forecast_material_classes where location_id = $1`, [locationId])).map((r) => [Number(r.material_id), r]));
  const changed = ready.filter((i) => stored.get(Number(i.material_id))?.pattern !== i.pattern);
  for (const item of changed) {
    const [written] = await db.query(
      `insert into forecast_material_classes (location_id, material_id, pattern, method, adi, cv2, classified_on) values ($1, $2, $3, $4, $5, $6, $7::date)
       on conflict (location_id, material_id) do update set pattern = excluded.pattern, method = excluded.method, adi = excluded.adi, cv2 = excluded.cv2, classified_on = excluded.classified_on
       where forecast_material_classes.pattern is distinct from excluded.pattern
       returning material_id`,
      [locationId, item.material_id, item.pattern, item.method, item.adi, item.cv2, today],
    );
    const before = stored.get(Number(item.material_id));
    if (written && before) {
      await forecastAudit(db, actor, locationId, 'forecast.method_changed', 'profittrack_material', Number(item.material_id), null, {
        automatic: true, before: { pattern: before.pattern, method: before.method }, after: { pattern: item.pattern, method: item.method, adi: item.adi, cv2: item.cv2 },
      });
    }
  }
}
