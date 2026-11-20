// Estimated requirement, daily model: day statuses, the window, demand patterns, the methods, forecast
// error and safety stock, the method-switch rule, cover and status, closures, exclusions, settings, the
// network view, the supply suggestion, access, and the dashboard analytics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, MARKETING, PASSWORD, SALES, setup } from '../support/harness.ts';
import {
  addDays, coverPeriod, coverStatus, crostonRate, demandPattern, forecastError, FORECAST_DEFAULTS, horizonDays, outliers, phpRound, reorderMath, roundUpToPack, sesRate, settingsFrom,
  stablePattern, usageTrend, weekLabel, weekStart, wmaRate,
} from '../../supabase/functions/api/services/forecast.ts';
import { manilaToday } from '../../supabase/functions/api/lib/http.ts';

const { pg, call, login, auth } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const base = '/estimated-requirement';
const today = manilaToday();
const ago = (n: number) => addDays(today, -n);
const settings = settingsFrom(FORECAST_DEFAULTS);
const close = (actual: number, expected: number, tolerance = 0.005, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} ≈ ${expected}`);

async function branchAccount(email: string, name: string) {
  const [roleRow] = await q(`select id from roles where name = 'franchisee'`);
  const uid = await auth.addUser(email, PASSWORD);
  const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, $2, $3, 'active', $4::uuid) returning id`, [roleRow.id, name, email, uid]);
  const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ($1, 'active_franchisee', $2, $3, '2026-01-01') returning id`, [name, user.id, brand.id]);
  const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Co', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
  const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, branch_code, type, address, is_active) values ($1, $2, $3, $4, 'franchise', 'Addr', true) returning id`, [franchisee.id, brand.id, `${name} Branch`, `FC-${user.id}`]);
  const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD, portal: 'branch' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { token: res.json.data.token as string, id: location.id as number, userId: user.id as number };
}
const branch = await branchAccount('forecast.one@test.local', 'Forecast One');
const other = await branchAccount('forecast.two@test.local', 'Forecast Two');

async function material(name: string, unit: string, owner = branch) {
  const created = await call('POST', '/profittrack/materials', { token: owner.token, body: { name, unit } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return Number(created.json.data.id);
}
/** Usage on a day (a negative physical count), which is also activity that day. */
const use = (materialId: number, daysAgo: number, quantity: number, owner = branch) => q(
  `insert into profittrack_material_movements (location_id, material_id, type, quantity_delta_milli, reason, recorded_by_user_id, occurred_at) values ($1, $2, 'physical_count', $3, 'Used', $4, ($5::date + time '12:00') at time zone 'Asia/Manila')`,
  [owner.id, materialId, -Math.round(quantity * 1000), owner.userId, ago(daysAgo)],
);
/** Activity without usage: a positive count on a separate marker material. */
let marker: number;
const active = (daysAgo: number, owner = branch) => q(
  `insert into profittrack_material_movements (location_id, material_id, type, quantity_delta_milli, reason, recorded_by_user_id, occurred_at) values ($1, $2, 'physical_count', 1000, 'Recount', $3, ($4::date + time '12:00') at time zone 'Asia/Manila')`,
  [owner.id, marker, owner.userId, ago(daysAgo)],
);

// ---------------------------------------------------------------- pure math
test('methods: WMA weights 7..1, SES from the first-7 mean, Croston z ÷ p, by hand', () => {
  assert.equal(wmaRate([1, 2, 3, 4, 5, 6, 7]), 5, '(1·1 + 2·2 + … + 7·7) ÷ 28 = 140 ÷ 28');
  assert.equal(wmaRate([99, 1, 2, 3, 4, 5, 6, 7]), 5, 'only the last 7 days');
  close(sesRate([2, 2, 2, 2, 2, 2, 2, 10], 0.2)!, 3.6, 1e-9, 'level 2, then 2 + 0.2·(10 − 2)');
  close(sesRate([2, 2, 2, 2, 2, 2, 2, 10, 0], 0.2)!, 2.88, 1e-9, '3.6 + 0.2·(0 − 3.6)');
  close(crostonRate([0, 0, 4, 0, 0, 0, 6], 0.1)!, 4.2 / 3.1, 1e-9, 'z 4 → 4.2, p 3 → 3.1');
  assert.equal(crostonRate([0, 0, 0], 0.1), null);
});

test('demand pattern: one fixture per class with exact ADI and CV²', () => {
  const smooth = demandPattern([5, 5, 5, 5, 6, 4], 1.32, 0.49)!;
  assert.deepEqual([smooth.pattern, smooth.adi], ['smooth', 1]);
  close(smooth.cv2, 1 / 75, 1e-9, 'variance 1/3 over mean² 25');
  const erratic = demandPattern([1, 9, 1, 9], 1.32, 0.49)!;
  assert.deepEqual([erratic.pattern, erratic.adi], ['erratic', 1]);
  close(erratic.cv2, 0.64, 1e-9);
  const intermittent = demandPattern([5, 0, 5, 0, 5, 0], 1.32, 0.49)!;
  assert.deepEqual([intermittent.pattern, intermittent.adi, intermittent.cv2], ['intermittent', 2, 0]);
  const lumpy = demandPattern([1, 0, 9, 0], 1.32, 0.49)!;
  assert.deepEqual([lumpy.pattern, lumpy.adi], ['lumpy', 2]);
  close(lumpy.cv2, 0.64, 1e-9);
  assert.equal(demandPattern([0, 0, 0], 1.32, 0.49), null, 'no usage: no pattern');
  assert.equal(demandPattern([0, 0, 7, 0], 1.32, 0.49)!.cv2, 0, 'a single non-zero day has CV² 0');
});

test('forecast error: one-step-ahead RMSE after the 7-day warm-up', () => {
  const err = forecastError('wma', [1, 1, 1, 1, 1, 1, 1, 3], settings);
  assert.deepEqual([err.rmse, err.points], [2, 1], 'forecast 1 for an actual 3');
  const two = forecastError('wma', [1, 1, 1, 1, 1, 1, 1, 3, 1], settings);
  // day 8: 1 vs 3 → −2; day 9: (1+2+3+4+5+6 + 3·7)/28 = 42/28 = 1.5 vs 1 → 0.5
  close(two.rmse, Math.sqrt((4 + 0.25) / 2), 1e-9);
  assert.equal(forecastError('wma', [1, 2, 3], settings).points, 0, 'too short: no error points');
});

test('cover period per horizon and with max cover days; status boundaries ignore the horizon', () => {
  assert.equal(coverPeriod(0, 7, null).days, 7);
  assert.equal(coverPeriod(0, 14, null).days, 14);
  assert.equal(coverPeriod(1, 30, null).days, 31);
  assert.deepEqual(coverPeriod(1, 30, 10), { days: 10, full: 31, capped: true });
  assert.equal(coverPeriod(1, 7, 10).capped, false, 'a cap above the period changes nothing');
  assert.deepEqual([horizonDays(7), horizonDays(14), horizonDays(30), horizonDays(1), horizonDays(2), horizonDays(4)], [7, 14, 30, 7, 14, 30], '1 | 2 | 4 weeks are aliases');
  assert.equal(coverStatus(3.99, settings), 'low_cover');
  assert.equal(coverStatus(4, settings), 'normal');
  assert.equal(coverStatus(14, settings), 'normal');
  assert.equal(coverStatus(14.01, settings), 'overstocked');
  assert.equal(coverStatus(null, settings), 'no_estimate');
});

test('Fresh Milk worked example (the mockup): need 127.0, safety 5.92, target 137.1, reorder 112.0', () => {
  // The mockup shows the rate and the error rounded (4.23 L, 0.64); the unrounded values are 4.233 and 0.644.
  const rate = 4.233;
  const error = 0.644;
  const cover = coverPeriod(1, 30, null).days;
  const m = reorderMath(rate, error, 30, cover, 1.65, 12.6, 13.0);
  assert.equal(cover, 31, 'lead 1 + horizon 30');
  assert.equal(phpRound(m.need, 1), 127.0);
  assert.equal(phpRound(m.safety, 2), 5.92, '1.65 × 0.644 × √31');
  assert.equal(phpRound(m.target, 1), 137.1, 'rate × 31 + safety');
  assert.equal(phpRound(m.raw, 1), 111.5, 'target − 12.6 − 13.0');
  assert.equal(roundUpToPack(m.raw, 1.0), 112, 'packs of 1.00');
  console.log(`Fresh Milk: need ${phpRound(m.need, 1)} L, safety ${phpRound(m.safety, 2)} L, target ${phpRound(m.target, 1)}, raw ${phpRound(m.raw, 1)} → reorder ${roundUpToPack(m.raw, 1.0)} L`);
  assert.equal(reorderMath(1, 0, 7, 7, 1.65, 100, 0).raw, 0, 'never negative');
  assert.equal(roundUpToPack(23, 10), 30);
  assert.equal(roundUpToPack(0.8, null), 1, 'whole units without a pack size');
  assert.equal(roundUpToPack(20, 10), 20, 'an exact pack does not round up');
});

test('method-switch rule: a blip does not switch, the run of N does, the first pattern applies at once', () => {
  assert.deepEqual(stablePattern(['erratic', 'smooth', 'smooth', 'smooth'], 3), { pattern: 'smooth', pending: { pattern: 'erratic', days: 1, needed: 3 } });
  assert.deepEqual(stablePattern(['erratic', 'erratic', 'erratic', 'smooth'], 3).pattern, 'erratic');
  assert.deepEqual(stablePattern(['smooth'], 3), { pattern: 'smooth', pending: null }, 'first classification at once');
  assert.deepEqual(stablePattern(['erratic', 'smooth'], 3).pattern, 'smooth', 'the oldest window until a run exists');
  assert.equal(stablePattern([null], 3).pattern, null);
});

test('trend, outliers and the older helpers', () => {
  const flat = Array(14).fill(1);
  assert.equal(usageTrend(flat, 10).direction, 'flat');
  assert.equal(usageTrend([...Array(7).fill(1), ...Array(7).fill(2)], 10).direction, 'up');
  assert.equal(usageTrend([...Array(7).fill(1), ...Array(7).fill(2)], 10).change_percent, 100);
  assert.equal(usageTrend([...Array(7).fill(2), ...Array(7).fill(1)], 10).direction, 'down');
  assert.equal(usageTrend(Array(13).fill(1), 10).direction, 'insufficient', 'fewer than 14 open days');
  assert.equal(usageTrend([...Array(7).fill(0), ...Array(7).fill(1)], 10).direction, 'insufficient', 'previous 7 sum to 0');
  const capped = outliers([10, 10, 10, 10, 10, 10, 10, 100], 8, true);
  assert.equal(capped.adjusted[7], 20, 'capped at double the median');
  assert.equal(outliers([10, 10, 10, 10, 10, 10, 10, 100], 8, false).adjusted[7], 100, 'raw stays raw');
  assert.equal(outliers([0, 0, 0, 0, 0, 1, 2, 3], 8, true).status, 'skipped_sparse');
  assert.equal(weekLabel('2026-11-02'), 'Nov 2 – 8');
  assert.equal(weekStart('2026-11-08'), '2026-11-02');
});

// ---------------------------------------------------------------- API, daily fixture
let milk: number;
let syrup: number;
let product: number;

test('daily statuses: closed, excluded week, no records, not yet stocked, today; zero on an open day counts', async () => {
  marker = await material('Marker', 'pcs');
  milk = await material('Fresh milk', 'L');
  syrup = await material('Syrup', 'L');
  const [p] = await q(`insert into products (brand_id, sku, name, unit, pack_size) values ($1, 'FC-MILK', 'Fresh milk', 'L', 1) returning id`, [brand.id]);
  product = Number(p.id);
  const [store] = await q(`select id from franchise_locations where type = 'warehouse' limit 1`);
  await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, 500, 5, 1)`, [store.id, product]);
  await q(`update profittrack_materials set warehouse_product_id = $1 where id = $2`, [product, milk]);
  await q(`update profittrack_material_balances set quantity_milli = 12600 where material_id = $1`, [milk]);
  const [request] = await q(`insert into supply_requests (location_id, request_number, status, requested_by_user_id, delivery_address) values ($1, 'FC-1', 'scheduled', $2, 'Addr') returning id`, [branch.id, branch.userId]);
  await q(`insert into supply_request_items (supply_request_id, product_id, quantity_requested, quantity_fulfilled) values ($1, $2, 13, 0)`, [request.id, product]);

  // 40 days back: activity every day except 12 days ago (nothing recorded); milk 4 L a day except a zero 3 days ago.
  for (let n = 40; n >= 1; n -= 1) {
    if (n === 12) continue;
    await active(n);
    if (n !== 3) await use(milk, n, 4);
  }
  await use(milk, 0, 99); // today: never counted
  for (let n = 8; n >= 1; n -= 1) await use(syrup, n, 1); // first used 8 days ago

  // A closure 20–19 days ago and an excluded week (the Monday–Sunday week holding 30 days ago).
  assert.equal((await call('POST', `${base}/closures`, { token: logistics, body: { location_id: branch.id, starts_on: ago(20), ends_on: ago(19), reason: 'Renovation' } })).status, 201);
  const excludedWeek = weekStart(ago(30));
  assert.equal((await call('POST', `${base}/exclusions`, { token: logistics, body: { location_id: branch.id, week_start: excludedWeek, reason: 'Fiesta' } })).status, 201);

  const detail = await call('GET', `${base}/detail?material_id=${milk}&location_id=${branch.id}`, { token: admin });
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  const days = detail.json.data.item.days as any[];
  const status = (n: number) => days.find((d) => d.date === ago(n))?.status;
  assert.equal(status(20), 'closed');
  assert.equal(status(19), 'closed');
  for (let d = 0; d < 7; d += 1) {
    const date = addDays(excludedWeek, d);
    const row = days.find((x) => x.date === date);
    if (row) assert.equal(row.status, 'excluded', `all 7 days of the excluded week (${date})`);
  }
  assert.equal(status(12), 'no_records', 'nothing recorded that day');
  assert.equal(status(3), 'open', 'activity but no milk used: a real zero');
  assert.equal(days.find((d) => d.date === ago(3)).usage, 0);
  assert.equal(days.some((d) => d.date === today), false, 'today is left out of the math and the chart');
  const syrupDays = (await call('GET', `${base}/detail?material_id=${syrup}&location_id=${branch.id}`, { token: admin })).json.data.item.days as any[];
  assert.equal(syrupDays.find((d: any) => d.date === ago(9)).status, 'not_yet_stocked');
  assert.ok(detail.json.data.left_out.some((r: any) => r.status === 'no_records' && r.label === 'No records that day'));
  assert.match(detail.json.data.freshness, /^Last recorded activity: /);
});

test('window: the newest 28 open days, skipping left-out days; below the minimum it says how many more', async () => {
  const list = await call('GET', `${base}?location_id=${branch.id}&horizon=7`, { token: admin });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const item = list.json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(item.days, undefined, 'the list leaves the daily detail out');
  assert.equal(item.open_days, 28);
  assert.equal(item.ready, true);
  const syrupItem = list.json.data.items.find((i: any) => i.material_id === syrup);
  assert.deepEqual([syrupItem.ready, syrupItem.open_days, syrupItem.needed_days, syrupItem.not_ready_reason], [false, 8, 6, 'Needs 6 more days']);
  assert.equal(syrupItem.status, 'no_estimate');
  assert.equal(syrupItem.suggested_reorder, null, 'no numbers are guessed');
  const summary = list.json.data.summary;
  assert.ok(summary.days_excluded.closed >= 2 && summary.days_excluded.no_records >= 1, JSON.stringify(summary.days_excluded));
  assert.equal(summary.items_tracked, 3);
  assert.match(summary.freshness, /^Last recorded activity: /);
});

test('predictive: method, rate, error, safety, reorder with pack rounding; cover incl. on order; status', async () => {
  // Hand-checked numbers on the recorded series (dips and spikes included).
  const res = await call('GET', `${base}?location_id=${branch.id}&horizon=30&dips=raw`, { token: admin });
  const item = res.json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(item.pattern, 'smooth', 'daily 4 L with one zero: ADI 28/27 < 1.32, CV² 0');
  assert.deepEqual([item.method, item.method_label, item.low_confidence], ['wma', 'WMA', false]);
  close(item.adi, 28 / 27, 0.01);
  assert.equal(item.cv2, 0);
  // Last 7 open days, oldest first (weights 1..7): 4, 4, 4, 4, 0 (3 days ago), 4, 4.
  const expectedRate = (4 * 1 + 4 * 2 + 4 * 3 + 4 * 4 + 0 * 5 + 4 * 6 + 4 * 7) / 28;
  close(item.daily_rate, phpRound(expectedRate, 3), 0.001, 'WMA');
  // With capping on (the default), the flat series' zero day is a dip raised to the fence (half the median).
  const capped = (await call('GET', `${base}?location_id=${branch.id}&horizon=30`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(capped.adi, 1, 'classified after capping, as specified');
  close(capped.daily_rate, phpRound((4 * 1 + 4 * 2 + 4 * 3 + 4 * 4 + 2 * 5 + 4 * 6 + 4 * 7) / 28, 3), 0.001);
  assert.equal(capped.zero_days_percent, item.zero_days_percent, 'the zero-day share is from recorded usage');
  assert.equal(item.on_hand, 12.6);
  assert.equal(item.on_order, 13);
  assert.equal(item.cover_days, 30, 'lead 0 + horizon 30');
  assert.ok(item.forecast_error > 0);
  close(item.safety_stock, 1.65 * item.forecast_error * Math.sqrt(30), 0.002);
  close(item.estimated_need, item.daily_rate * 30, 0.02, 'need = rate × 30 (rate shown rounded)');
  close(item.target, item.daily_rate * 30 + item.safety_stock, 0.02);
  close(item.suggested_reorder_raw, Math.max(0, item.target - 12.6 - 13), 0.003);
  assert.equal(item.suggested_reorder, Math.ceil(item.suggested_reorder_raw - 1e-9), 'packs of 1');
  close(item.days_of_cover, (12.6 + 13) / item.daily_rate, 0.06, 'days of cover includes on order');
  close(item.days_on_hand, 12.6 / item.daily_rate, 0.06);
  assert.equal(item.status, 'normal', '7.5 days');
  // Status does not depend on the horizon.
  const week = (await call('GET', `${base}?location_id=${branch.id}&horizon=7&dips=raw`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(week.status, item.status);
  assert.equal(week.days_of_cover, item.days_of_cover);
  const legacy = await call('GET', `${base}?location_id=${branch.id}&horizon=4`, { token: admin });
  assert.equal(legacy.json.data.horizon_days, 30, '4 weeks reads as 1 month');
  assert.equal((await call('GET', `${base}?location_id=${branch.id}&horizon=5`, { token: admin })).status, 422);

  const detail = (await call('GET', `${base}/detail?material_id=${milk}&location_id=${branch.id}&horizon=30&dips=raw`, { token: admin })).json.data;
  assert.equal(detail.explanation.steps.length, 7);
  assert.match(detail.explanation.steps[0].text, /^28 open days used, .*Dips and spikes: included\.$/);
  assert.match(detail.explanation.steps[1].text, /^ADI 1\.04, CV² 0\.00 → smooth demand\./);
  assert.match(detail.explanation.steps[2].text, /^WMA \(7-day window, weights 7 down to 1\)/);
  assert.match(detail.explanation.steps[4].text, /Lead time 0 days \+ horizon 30 days = 30 days to cover\./);
  assert.match(detail.explanation.steps[5].text, /^1\.65 × forecast error .* × √30 days = /);
  assert.match(detail.explanation.descriptive, /^Last 28 open days, 2 closed days, .* skipped\. Average .* L per day, .*% zero-usage days, last 7 days .* L\. Switch to Predictive/);
  assert.equal(detail.forecast.length, 31, 'today to +30 days');
});

test('dips and spikes: capped and included give different rates; recorded usage is unchanged', async () => {
  await use(milk, 2, 60); // a spike two days ago (on top of the 4 L)
  const cap = (await call('GET', `${base}?location_id=${branch.id}&dips=cap`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  const raw = (await call('GET', `${base}?location_id=${branch.id}&dips=raw`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.ok(raw.daily_rate > cap.daily_rate, `raw ${raw.daily_rate} > capped ${cap.daily_rate}`);
  const day = (await call('GET', `${base}/detail?material_id=${milk}&location_id=${branch.id}&dips=cap`, { token: admin })).json.data.item.days.find((d: any) => d.date === ago(2));
  assert.equal(day.usage, 64, 'recorded usage is unchanged');
  assert.equal(day.flagged, 'spike');
  assert.ok(day.adjusted_usage < 64);
  const [{ total }] = await q(`select sum(-quantity_delta_milli)::int as total from profittrack_material_movements where material_id = $1 and occurred_at >= now() - interval '3 days' and occurred_at < now() - interval '1 day'`, [milk]);
  assert.ok(total >= 64000, 'nothing was written back');
});

test('descriptive: trend, last counted and stale counts', async () => {
  const items = (await call('GET', `${base}?location_id=${branch.id}`, { token: admin })).json.data.items as any[];
  const milkItem = items.find((i) => i.material_id === milk);
  assert.equal(milkItem.last_counted_on, today, 'the count recorded today is the latest');
  assert.equal(milkItem.days_since_count, 0);
  assert.equal(milkItem.count_stale, false);
  assert.ok(['up', 'down', 'flat'].includes(milkItem.trend.direction));
  const fresh = await material('Never counted', 'pcs');
  const again = (await call('GET', `${base}?location_id=${branch.id}`, { token: admin })).json.data;
  const never = again.items.find((i: any) => i.material_id === fresh);
  assert.deepEqual([never.last_counted_on, never.count_stale], [null, true]);
  assert.ok(again.summary.stale_counts >= 1);
});

test('method changes are recorded once and audited; the first class is stored without an event', async () => {
  const [stored] = await q(`select pattern, method from forecast_material_classes where location_id = $1 and material_id = $2`, [branch.id, milk]);
  assert.equal(stored.pattern, 'smooth', 'the first class is stored at once');
  assert.equal((await q(`select count(*)::int c from profittrack_audit_events where action = 'forecast.method_changed' and entity_id = $1`, [milk]))[0].c, 0);
  await q(`update forecast_material_classes set pattern = 'erratic', method = 'ses' where location_id = $1 and material_id = $2`, [branch.id, milk]);
  await call('GET', `${base}?location_id=${branch.id}`, { token: admin });
  await call('GET', `${base}?location_id=${branch.id}`, { token: admin });
  const events = await q(`select metadata from profittrack_audit_events where action = 'forecast.method_changed' and entity_id = $1`, [milk]);
  assert.equal(events.length, 1, 'audited once');
  assert.deepEqual(events[0].metadata.before, { pattern: 'erratic', method: 'ses' });
  assert.equal(events[0].metadata.after.method, 'wma');
  assert.equal(events[0].metadata.automatic, true);
});

test('max cover days (perishables): Logistics sets it, it caps the cover period, audited', async () => {
  assert.equal((await call('PATCH', `/branches/${branch.id}/materials/${milk}/levels`, { token: admin, body: { max_cover_days: 5 } })).status, 403, 'Admin reads only');
  const saved = await call('PATCH', `/branches/${branch.id}/materials/${milk}/levels`, { token: logistics, body: { max_cover_days: 5 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.ok((await call('PATCH', `/branches/${branch.id}/materials/${milk}/levels`, { token: logistics, body: { max_cover_days: 61 } })).json.errors.max_cover_days);
  const item = (await call('GET', `${base}?location_id=${branch.id}&horizon=30`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.deepEqual([item.cover_days, item.cover_days_full, item.cover_capped, item.max_cover_days], [5, 30, true, 5]);
  close(item.estimated_need, item.daily_rate * 30, 0.002, 'estimated need still uses the horizon');
  const detail = (await call('GET', `${base}/detail?material_id=${milk}&location_id=${branch.id}&horizon=30`, { token: admin })).json.data;
  assert.match(detail.explanation.steps[4].text, /capped at 5 days/);
  assert.equal((await q(`select count(*)::int c from profittrack_audit_events where action = 'forecast.max_cover_days_changed' and entity_id = $1`, [milk]))[0].c, 1);
  assert.equal((await call('PATCH', `/branches/${branch.id}/materials/${milk}/levels`, { token: logistics, body: { max_cover_days: null } })).status, 200, 'cleared again');
});

test('access: a branch stays on its own data; settings are Admin only', async () => {
  assert.equal((await call('GET', `${base}?location_id=${other.id}`, { token: branch.token })).status, 403);
  assert.equal((await call('GET', base, { token: sales })).status, 403);
  const picker = await call('GET', base, { token: admin });
  assert.equal(picker.json.data.requires_location, true);
  assert.match((await call('GET', `${base}/detail?material_id=1`, { token: admin })).json.errors.location_id[0], /Choose a branch/);
  assert.equal((await call('GET', `${base}/network`, { token: branch.token })).status, 403);
  assert.equal((await call('PATCH', `${base}/settings`, { token: logistics, body: { low_cover_days: 3 } })).status, 403);
  assert.equal((await call('GET', `${base}/settings`, { token: branch.token })).json.data.editable, false);
  assert.equal((await call('GET', `${base}/audit`, { token: logistics })).status, 403);
  assert.equal((await call('POST', `${base}/closures`, { token: branch.token, body: {} })).status, 403);
});

test('settings: validated, clamped, audited, and they change the estimate', async () => {
  assert.match((await call('PATCH', `${base}/settings`, { token: admin, body: { overstock_days: 3 } })).json.errors.overstock_days[0], /more days than Low cover/);
  assert.match((await call('PATCH', `${base}/settings`, { token: admin, body: { minimum_open_days: 99 } })).json.errors.minimum_open_days[0], /not be greater than 60/);
  assert.match((await call('PATCH', `${base}/settings`, { token: admin, body: { minimum_open_days: 40 } })).json.errors.minimum_open_days[0], /more than the history window/);
  const saved = await call('PATCH', `${base}/settings`, { token: admin, body: { low_cover_days: 10 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const item = (await call('GET', `${base}?location_id=${branch.id}`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(item.status, 'low_cover', 'about 7 days of cover is now under 10');
  await call('PATCH', `${base}/settings`, { token: admin, body: { low_cover_days: 4 } });
  assert.ok((await q(`select 1 from audit_logs where action = 'forecast.settings_updated'`)).length);
  const [row] = await q(`select lead_time_days, minimum_included_weeks from forecast_settings`);
  assert.deepEqual([row.lead_time_days, row.minimum_included_weeks], [0, 4], 'older columns keep their values');
});

test('opening date: days before it are not yet open', async () => {
  const opened = await call('PATCH', `${base}/opening-date`, { token: admin, body: { location_id: branch.id, opening_date: ago(10) } });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  const days = (await call('GET', `${base}/detail?material_id=${milk}&location_id=${branch.id}`, { token: admin })).json.data.item.days as any[];
  const item = (await call('GET', `${base}?location_id=${branch.id}`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(item.ready, false, 'only 9 open days since opening');
  assert.ok(days.every((d) => d.date >= ago(10) || d.status === 'not_yet_open'));
  assert.equal((await call('PATCH', `${base}/opening-date`, { token: admin, body: { location_id: branch.id, opening_date: null } })).json.data.location.opening_date, null);
});

test('network view, the read-only suggestion and forecastFor keep their shape', async () => {
  const network = await call('GET', `${base}/network?horizon=7`, { token: logistics });
  assert.equal(network.status, 200, JSON.stringify(network.json));
  const line = network.json.data.products.find((p: any) => p.name === 'Fresh milk');
  assert.equal(line.warehouse_stock, 500);
  assert.ok(line.daily_usage > 0);
  assert.equal(line.method_mix.wma, 1);
  assert.ok('low_cover_branches' in line);
  assert.equal(line.branches[0].branch, 'Forecast One Branch');
  assert.ok(network.json.data.unmapped.some((u: any) => u.material === 'Syrup'));

  const hint = await call('GET', `${base}/suggestion?product_id=${product}`, { token: branch.token });
  assert.equal(hint.status, 200, JSON.stringify(hint.json));
  for (const key of ['suggested_quantity', 'unit', 'materials', 'note']) assert.ok(key in hint.json.data, key);
  assert.equal(hint.json.data.unit, 'L');
  assert.equal(typeof hint.json.data.suggested_quantity, 'number');
  const m = hint.json.data.materials[0];
  for (const key of ['needed_days', 'needed_weeks', 'counted', 'on_order', 'ready']) assert.ok(key in m, key);
  assert.equal((await call('GET', `${base}/suggestion?product_id=99999`, { token: branch.token })).status, 404);

  const { forecastFor } = await import('../../supabase/functions/api/services/supplyForecast.ts');
  const { pgliteDb } = await import('../support/testDb.ts');
  const [location] = await q(`select * from franchise_locations where id = $1`, [branch.id]);
  const out = await forecastFor(pgliteDb(pg as any), location, [product]);
  const f = out.get(product)!;
  assert.deepEqual(Object.keys(f).sort(), ['days_covered', 'suggested']);
  assert.equal(f.suggested, hint.json.data.suggested_quantity, 'the same 1-week figure');
  const item = (await call('GET', `${base}?location_id=${branch.id}`, { token: admin })).json.data.items.find((i: any) => i.material_id === milk);
  assert.equal(f.days_covered, item.days_on_hand, 'days covered is on hand only');
  const [{ n }] = await q(`select count(*)::int as n from supply_requests where location_id = $1`, [branch.id]);
  assert.equal(n, 1, 'the hint never creates a request');
});

test('closures and exclusions keep their rules (undo, restore, audit)', async () => {
  const body = { location_id: branch.id, starts_on: ago(6), ends_on: ago(5), reason: 'Water outage' };
  assert.match((await call('POST', `${base}/closures`, { token: logistics, body: { ...body, ends_on: addDays(body.starts_on, -1) } })).json.errors.ends_on[0], /after or equal/);
  const created = await call('POST', `${base}/closures`, { token: logistics, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.data.closure.id;
  const status = async () => (await call('GET', `${base}/detail?material_id=${milk}&location_id=${branch.id}`, { token: admin })).json.data.item.days.find((d: any) => d.date === ago(6)).status;
  assert.equal(await status(), 'closed');
  assert.equal((await call('DELETE', `${base}/closures/${id}`, { token: logistics })).json.data.closure.undone, true);
  assert.equal(await status(), 'open');
  assert.equal((await call('POST', `${base}/closures/${id}/restore`, { token: logistics })).json.data.closure.undone, false);
  assert.match((await call('POST', `${base}/exclusions`, { token: admin, body: { location_id: branch.id, week_start: addDays(weekStart(ago(14)), 1), reason: 'Fiesta' } })).json.errors.week_start[0], /Choose the Monday/);
  assert.match((await call('POST', `${base}/exclusions`, { token: admin, body: { location_id: branch.id, week_start: weekStart(today), reason: 'Fiesta' } })).json.errors.week_start[0], /still running/);
  const trail = await call('GET', `${base}/audit?location_id=${branch.id}`, { token: admin });
  assert.ok(trail.json.data.some((e: any) => e.action === 'forecast.closure_created' && e.actor.full_name));
});

// ---------------------------------------------------------------- analytics (unchanged)
test('analytics: conversion from the same rows, the funnel and date limits', async () => {
  const day = manilaToday();
  const insert = (name: string, source: string, status: string) => q(
    `insert into franchise_inquiries (lead_name, email, phone, source, status, inquiry_date, preferred_brand_id) values ($1, $2, '09170000000', $3, $4, $5, $6) returning id`, [name, `${name}@test.local`, source, status, day, brand.id],
  );
  const baseline = (await call('GET', '/analytics/overview', { token: admin })).json.data;
  await insert('a1', 'FB', 'new');
  await insert('a2', 'Facebook Page', 'converted');
  const [linked] = await insert('a3', 'walk-in', 'endorsed');
  await q(`insert into applicants (full_name, status, inquiry_id, application_date) values ('a3', 'rejected', $1, $2)`, [linked.id, day]);
  const overview = await call('GET', '/analytics/overview', { token: admin });
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  const data = overview.json.data;
  assert.equal(data.kpis.total_inquiries, baseline.kpis.total_inquiries + 3);
  assert.equal(data.inquiries_by_source.facebook, (baseline.inquiries_by_source.facebook ?? 0) + 2, 'spellings collapse into one channel');
  assert.equal(data.kpis.conversion_converted, baseline.kpis.conversion_converted + 2);
  assert.equal(data.applicant_funnel.rejected, (baseline.applicant_funnel.rejected ?? 0) + 1);
  const seen = await call('GET', '/analytics/overview', { token: marketing });
  assert.equal(seen.json.data.applicant_funnel, undefined, 'Marketing never receives the funnel');
  assert.equal((await call('GET', '/analytics/franchising-dashboard', { token: logistics })).status, 403);
  assert.equal((await call('GET', '/analytics/overview?from=2020-01-01&to=2023-01-01', { token: admin })).status, 422);
});

test('analytics: inventory movement and the franchising dashboard', async () => {
  const day = manilaToday();
  const moved = await call('GET', '/analytics/inventory-movement', { token: logistics });
  assert.equal(moved.json.data.length, 30);
  assert.equal(moved.json.data[29].date, day);
  assert.equal((await call('GET', '/analytics/inventory-movement?from=2024-01-01&to=2025-06-01', { token: admin })).status, 422);
  assert.equal((await call('GET', '/analytics/top-locations?limit=1', { token: admin })).json.data.length, 1);

  // A sale and a production batch feed the two trends.
  const [item] = await q(`select i.id from inventories i join products p on p.id = i.product_id where p.sku = 'FC-MILK' limit 1`);
  const [mine] = await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) select $1, product_id, 10, 1, 0 from inventories where id = $2 returning id`, [branch.id, item.id]);
  const sale = await call('POST', '/branch/sales', { token: branch.token, body: { client_reference: 'fc-1', notes: 'Used', items: [{ inventory_id: mine.id, quantity: 4 }] } });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const dashboard = await call('GET', '/analytics/franchising-dashboard', { token: admin });
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.json));
  const data = dashboard.json.data;
  assert.equal(data.sales_trend.length, 12);
  assert.equal(data.sales_trend[11].period, day.slice(0, 7));
  assert.equal(data.sales_trend[11].quantity, 4);
  assert.equal(data.top_branches[0].location_id, branch.id);
  assert.equal(data.top_branches[0].quantity, 4);
  assert.match(data.insights[0].message, /Fresh milk is in high demand/);
  assert.ok(data.summary.branches_with_sales >= 1);
  const yearly = await call('GET', '/analytics/franchising-dashboard?period=year', { token: admin });
  assert.equal(yearly.json.data.sales_trend.length, 6);
  const wide = await call('GET', '/analytics/franchising-dashboard?from=2024-01-01&to=2026-11-01', { token: admin });
  assert.equal(wide.json.data.bucket, 'year', 'wide ranges roll up to years');
  assert.match((await call('GET', '/analytics/franchising-dashboard?from=2024-01-01', { token: admin })).json.errors.to[0], /required when from/);
});
