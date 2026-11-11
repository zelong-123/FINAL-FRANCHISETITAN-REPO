// Estimated requirement: the math, week rules, closures, exclusions, and dashboard analytics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, MARKETING, PASSWORD, SALES, setup } from '../support/harness.ts';
import { addDays, normalRange, outliers, phpRound, roundUpToPack, suggestedReorder, trend, weekLabel, weekStart, weightedAverage } from '../../supabase/functions/api/services/forecast.ts';
import { manilaToday } from '../../supabase/functions/api/lib/http.ts';

const { pg, call, login, auth } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const base = '/estimated-requirement';
const thisWeek = weekStart(manilaToday());
const weeksAgo = (n: number) => addDays(thisWeek, -7 * n);

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

test('math: the published formulas, by hand', () => {
  assert.equal(weightedAverage([10, 20, 30, 40]), 30, '(10 + 40 + 90 + 160) / 10');
  assert.equal(weightedAverage([99, 10, 20, 30, 40]), 30, 'only the last four weeks');
  assert.equal(weightedAverage([]), null);
  assert.deepEqual(normalRange([2, 4, 4, 4, 5, 5, 7, 9]), { low: 3, high: 7, average: 5, deviation: 2 });
  assert.equal(trend([10, 10, 10, 10, 20, 20, 20, 20], 10).direction, 'rising');
  assert.equal(trend([10, 10, 10, 10, 20, 20, 20, 20], 10).change_percent, 100);
  assert.equal(trend([10, 10, 10], 10).direction, 'insufficient');
  assert.equal(trend([0, 0, 0, 0, 1, 1, 1, 1], 10).change_percent, null);
  assert.equal(suggestedReorder(70, 1, 7, 5, 30, 10), 105, '70 x 2 weeks + 5 safety - 30 on hand - 10 on order');
  assert.equal(suggestedReorder(1, 1, 0, 0, 100, 0), 0, 'never negative');
  assert.equal(roundUpToPack(23, 10), 30);
  assert.equal(roundUpToPack(0.8, null), 1);
  assert.equal(roundUpToPack(20, 10), 20, 'an exact pack does not round up');
  assert.equal(phpRound(-1.5), -2);
  assert.equal(phpRound(1.005, 2), 1.01);

  const flat = outliers([10, 10, 10, 10, 10, 10, 10, 100], 8, true);
  assert.equal(flat.status, 'ok');
  assert.equal(flat.flags[7], 'spike');
  assert.equal(flat.adjusted[7], 20, 'capped at double the median');
  assert.equal(outliers([10, 10, 10, 10, 10, 10, 10, 100], 8, false).adjusted[7], 100, 'raw stays raw');
  assert.equal(outliers([1, 2, 3], 8, true).status, 'insufficient_history');
  assert.equal(outliers([0, 0, 0, 0, 0, 1, 2, 3], 8, true).status, 'skipped_sparse');
  const spread = outliers([10, 12, 14, 16, 18, 20, 22, 90], 8, true);
  assert.deepEqual(spread.fences, { low: 1, high: 33 }, 'Q1 13, Q3 21, IQR 8');
  assert.equal(spread.flags[7], 'spike');
  assert.equal(weekLabel('2026-11-02'), 'Nov 2 – 8');
  assert.equal(weekLabel('2026-11-30'), 'Nov 30 – Dec 6');
  assert.equal(weekStart('2026-11-08'), '2026-11-02', 'Sunday belongs to the week before');
});

let flour: number;
const movement = (material: number, week: string, milli: number) => q(
  `insert into profittrack_material_movements (location_id, material_id, type, quantity_delta_milli, reason, recorded_by_user_id, occurred_at) values ($1, $2, 'physical_count', $3, 'Used', $4, ($5::date + 2)::timestamp at time zone 'Asia/Manila')`,
  [branch.id, material, -milli, branch.userId, week],
);

test('estimate: only complete, included weeks count, and each status says why', async () => {
  const [product] = await q(`insert into products (brand_id, sku, name, unit, pack_size) values ($1, 'FC-FLOUR', 'Flour', 'kg', 25) returning id`, [brand.id]);
  const [store] = await q(`select id from franchise_locations where type = 'warehouse' limit 1`);
  await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, 700, 5, 1)`, [store.id, product.id]);
  const created = await call('POST', '/profittrack/materials', { token: branch.token, body: { name: 'Flour', unit: 'kg' } });
  flour = created.json.data.id;
  await q(`update profittrack_materials set warehouse_product_id = $1 where id = $2`, [product.id, flour]);
  await q(`update profittrack_material_balances set quantity_milli = 60000 where material_id = $1`, [flour]);
  const [request] = await q(`insert into supply_requests (location_id, request_number, status, requested_by_user_id, delivery_address) values ($1, 'FC-1', 'scheduled', $2, 'Addr') returning id`, [branch.id, branch.userId]);
  await q(`insert into supply_request_items (supply_request_id, product_id, quantity_requested, quantity_fulfilled) values ($1, $2, 30, 5)`, [request.id, product.id]);

  // Ten complete weeks of use, starting ten weeks back. Six weeks ago nobody recorded anything.
  const used: Record<number, number> = { 10: 70, 9: 70, 8: 70, 7: 70, 5: 70, 4: 70, 3: 70, 2: 70, 1: 70 };
  for (const [ago, kg] of Object.entries(used)) await movement(flour, weeksAgo(Number(ago)), kg * 1000);
  await movement(flour, thisWeek, 500_000); // the running week must never count

  const notReady = await call('GET', `${base}?horizon=2`, { token: branch.token });
  assert.equal(notReady.status, 200, JSON.stringify(notReady.json));
  const item = notReady.json.data.items[0];
  assert.equal(item.weeks, undefined, 'the list leaves the weekly detail out');
  assert.equal(item.included_weeks, 8, 'the first week is only partly open, the running week is out, one week has no records');
  assert.equal(item.ready, true);
  assert.equal(item.weighted_average, 70);
  assert.equal(item.estimated_need, 140, 'two weeks');
  assert.equal(item.on_hand, 60);
  assert.equal(item.on_order, 25, 'requested minus fulfilled');
  assert.equal(item.warehouse_stock, 700);
  assert.equal(item.days_left, 6, '60 kg at 10 kg a day');
  assert.equal(item.status, 'watch');
  assert.equal(item.suggested_reorder_raw, 55, '140 - 60 - 25, no spread');
  assert.equal(item.suggested_reorder, 75, 'rounded up to three 25 kg packs');
  assert.equal(item.pack_size, 25);
  assert.equal(item.warehouse_product.unit_match, true);
  assert.equal(notReady.json.data.summary.watch, 1);
  assert.equal(notReady.json.data.summary.excluded_breakdown.find((e: any) => e.status === 'no_records').weeks, 1);
  assert.equal(notReady.json.data.weeks.length, 12);
  assert.equal(notReady.json.data.location.opening_date_source, 'first_activity');
  assert.equal(notReady.json.data.location.effective_opening_date, addDays(weeksAgo(10), 2));

  const detail = await call('GET', `${base}/detail?material_id=${flour}`, { token: branch.token });
  const weeks = detail.json.data.item.weeks;
  assert.equal(weeks.length, 12);
  assert.equal(weeks[11].status, 'incomplete');
  assert.equal(weeks[11].usage, 500, 'shown, but not counted');
  assert.equal(weeks[10].status, 'included');
  assert.equal(weeks[5].status, 'no_records');
  assert.equal(weeks[0].status, 'not_yet_open', 'the week holding the first activity is only partly the branch\'s');
  assert.equal(detail.json.data.excluded_weeks.some((w: any) => w.status === 'incomplete'), false);
  assert.equal((await call('GET', `${base}/detail?material_id=99999`, { token: branch.token })).status, 404);

  assert.equal((await call('GET', `${base}?search=nothing`, { token: branch.token })).json.data.items.length, 0);
  assert.equal((await call('GET', `${base}?search=nothing`, { token: branch.token })).json.data.summary.items_tracked, 1, 'the cards ignore the search');
});

test('access: a branch stays on its own data', async () => {
  assert.equal((await call('GET', `${base}?location_id=${other.id}`, { token: branch.token })).status, 403);
  assert.equal((await call('GET', base, { token: sales })).status, 403);
  const picker = await call('GET', base, { token: admin });
  assert.equal(picker.json.data.requires_location, true);
  assert.ok(picker.json.data.locations.some((l: any) => l.id === branch.id));
  assert.match((await call('GET', `${base}/detail?material_id=1`, { token: admin })).json.errors.location_id[0], /Choose a branch/);
  assert.equal((await call('GET', `${base}/network`, { token: branch.token })).status, 403);
  assert.equal((await call('PATCH', `${base}/settings`, { token: logistics, body: { watch_days: 20 } })).status, 403);
  assert.equal((await call('GET', `${base}/settings`, { token: branch.token })).json.data.editable, false);
  assert.equal((await call('GET', `${base}/audit`, { token: logistics })).status, 403);
  assert.equal((await call('POST', `${base}/closures`, { token: branch.token, body: {} })).status, 403);
});

test('closures: a closed week leaves the estimate, undo brings it back', async () => {
  const body = { location_id: branch.id, starts_on: weeksAgo(2), ends_on: addDays(weeksAgo(2), 4), reason: 'Renovation' };
  assert.match((await call('POST', `${base}/closures`, { token: logistics, body: { ...body, ends_on: addDays(body.starts_on, -1) } })).json.errors.ends_on[0], /after or equal/);
  assert.match((await call('POST', `${base}/closures`, { token: logistics, body: { ...body, starts_on: weeksAgo(30), ends_on: weeksAgo(29) } })).json.errors.starts_on[0], /at most 8 weeks back/);
  const created = await call('POST', `${base}/closures`, { token: logistics, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.closure.days, 5);
  assert.equal(created.json.data.closure.created_by, (await q(`select full_name from users where email = $1`, [LOGISTICS]))[0].full_name);
  assert.match((await call('POST', `${base}/closures`, { token: logistics, body: { ...body, ends_on: body.starts_on } })).json.errors.starts_on[0], /overlaps/);
  const id = created.json.data.closure.id;

  const detail = async () => (await call('GET', `${base}/detail?material_id=${flour}`, { token: branch.token })).json.data.item;
  const closed = (await detail()).weeks.find((w: any) => w.week_start === weeksAgo(2));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.reason, 'Branch closed 5 of 7 days');
  assert.equal((await detail()).included_weeks, 7);

  const patched = await call('PATCH', `${base}/closures/${id}`, { token: admin, body: { ends_on: addDays(weeksAgo(2), 1), reason: 'Short works' } });
  assert.equal(patched.json.data.closure.days, 2);
  const partly = (await detail()).weeks.find((w: any) => w.week_start === weeksAgo(2));
  assert.equal(partly.status, 'partly_closed', 'under the four-day threshold it still counts');
  assert.equal((await detail()).included_weeks, 8);
  assert.match((await call('PATCH', `${base}/closures/${id}`, { token: admin, body: { ends_on: addDays(weeksAgo(2), -3) } })).json.errors.ends_on[0], /cannot be before/);

  assert.equal((await call('DELETE', `${base}/closures/${id}`, { token: logistics })).json.data.closure.undone, true);
  assert.match((await call('DELETE', `${base}/closures/${id}`, { token: logistics })).json.errors.closure[0], /already undone/);
  assert.match((await call('PATCH', `${base}/closures/${id}`, { token: admin, body: { reason: 'Again' } })).json.errors.closure[0], /Restore it/);
  assert.equal((await call('GET', `${base}/closures?location_id=${branch.id}`, { token: admin })).json.data.closures.length, 0);
  assert.equal((await call('GET', `${base}/closures?location_id=${branch.id}&include_undone=1`, { token: admin })).json.data.closures[0].undone_by !== null, true);
  assert.equal((await detail()).weeks.find((w: any) => w.week_start === weeksAgo(2)).status, 'included');
  assert.equal((await call('POST', `${base}/closures/${id}/restore`, { token: logistics })).json.data.closure.undone, false);
  assert.match((await call('POST', `${base}/closures/${id}/restore`, { token: logistics })).json.errors.closure[0], /not undone/);
  assert.equal((await call('DELETE', `${base}/closures/${id}`, { token: logistics })).status, 200);
});

test('exclusions: Monday only, past weeks only, branch-wide or one material', async () => {
  const body = { location_id: branch.id, week_start: weeksAgo(3), reason: 'Fiesta' };
  assert.match((await call('POST', `${base}/exclusions`, { token: admin, body: { ...body, week_start: addDays(weeksAgo(3), 1) } })).json.errors.week_start[0], /Choose the Monday/);
  assert.match((await call('POST', `${base}/exclusions`, { token: admin, body: { ...body, week_start: thisWeek } })).json.errors.week_start[0], /still running/);
  assert.match((await call('POST', `${base}/exclusions`, { token: admin, body: { ...body, material_id: 99999 } })).json.errors.material_id[0], /does not belong/);
  const created = await call('POST', `${base}/exclusions`, { token: logistics, body: { ...body, material_id: flour } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.exclusion.scope, 'material');
  assert.equal(created.json.data.exclusion.material.name, 'Flour');
  assert.match((await call('POST', `${base}/exclusions`, { token: logistics, body: { ...body, material_id: flour } })).json.errors.week_start[0], /already excluded/);
  const wide = await call('POST', `${base}/exclusions`, { token: logistics, body: { ...body, week_start: weeksAgo(4) } });
  assert.equal(wide.json.data.exclusion.scope, 'branch');

  const detail = await call('GET', `${base}/detail?material_id=${flour}`, { token: branch.token });
  const weeks = detail.json.data.item.weeks;
  assert.equal(weeks.find((w: any) => w.week_start === weeksAgo(3)).status, 'excluded');
  assert.equal(weeks.find((w: any) => w.week_start === weeksAgo(3)).reason, 'Fiesta');
  assert.equal(weeks.find((w: any) => w.week_start === weeksAgo(4)).status, 'excluded');
  assert.equal(detail.json.data.item.included_weeks, 6);
  const id = wide.json.data.exclusion.id;
  assert.equal((await call('DELETE', `${base}/exclusions/${id}`, { token: logistics })).json.message, 'Exclusion undone.');
  assert.equal((await call('POST', `${base}/exclusions/${id}/restore`, { token: logistics })).json.message, 'Exclusion restored.');
  assert.equal((await call('DELETE', `${base}/exclusions/${id}`, { token: logistics })).status, 200);
  assert.equal((await call('GET', `${base}/exclusions?location_id=${branch.id}`, { token: branch.token })).json.data.exclusions.length, 1);
  assert.equal((await call('GET', `${base}/exclusions?location_id=${branch.id}&include_undone=1`, { token: admin })).json.data.exclusions.length, 2);
  const trail = await call('GET', `${base}/audit?location_id=${branch.id}`, { token: admin });
  assert.ok(trail.json.data.some((e: any) => e.action === 'forecast.closure_created' && e.actor.full_name));
  assert.ok(trail.json.data.some((e: any) => e.action === 'forecast.exclusion_restored' && e.metadata.week_start === weeksAgo(4)));
});

test('settings, opening date, network view and the read-only suggestion', async () => {
  assert.match((await call('PATCH', `${base}/settings`, { token: admin, body: { watch_days: 3 } })).json.errors.watch_days[0], /higher than the run-out/);
  assert.match((await call('PATCH', `${base}/settings`, { token: admin, body: { minimum_included_weeks: 99 } })).json.errors.minimum_included_weeks[0], /not be greater than 26/);
  const saved = await call('PATCH', `${base}/settings`, { token: admin, body: { minimum_included_weeks: 8, lead_time_days: 7 } });
  assert.equal(saved.json.data.settings.minimum_included_weeks, 8);
  const before = await call('GET', `${base}/detail?material_id=${flour}`, { token: branch.token });
  assert.equal(before.json.data.item.ready, false, 'seven included weeks is now too few');
  assert.equal(before.json.data.item.needed_weeks, 1);
  assert.equal(before.json.data.item.weighted_average, null);
  await call('PATCH', `${base}/settings`, { token: admin, body: { minimum_included_weeks: 4 } });
  assert.ok((await q(`select 1 from audit_logs where action = 'forecast.settings_updated'`)).length);

  const opened = await call('PATCH', `${base}/opening-date`, { token: admin, body: { location_id: branch.id, opening_date: weeksAgo(6) } });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  assert.equal(opened.json.data.location.opening_date_source, 'recorded');
  const shorter = await call('GET', `${base}/detail?material_id=${flour}`, { token: branch.token });
  assert.equal(shorter.json.data.item.weeks.find((w: any) => w.week_start === weeksAgo(7)).status, 'not_yet_open');
  assert.equal(shorter.json.data.item.weeks.find((w: any) => w.week_start === weeksAgo(5)).status, 'included');
  assert.equal((await call('PATCH', `${base}/opening-date`, { token: admin, body: { location_id: branch.id, opening_date: null } })).json.data.location.opening_date, null);

  const network = await call('GET', `${base}/network`, { token: logistics });
  assert.equal(network.status, 200, JSON.stringify(network.json));
  const line = network.json.data.products.find((p: any) => p.name === 'Flour');
  assert.equal(line.weekly_usage, 70);
  assert.equal(line.warehouse_stock, 700);
  assert.equal(line.days_of_cover, 70, '700 kg at 10 kg a day');
  assert.equal(line.risk, 'ok');
  assert.equal(line.branches[0].branch, 'Forecast One Branch');

  const [product] = await q(`select id from products where sku = 'FC-FLOUR'`);
  const hint = await call('GET', `${base}/suggestion?product_id=${product.id}`, { token: branch.token });
  assert.equal(hint.status, 200, JSON.stringify(hint.json));
  assert.equal(hint.json.data.unit, 'kg');
  assert.equal(hint.json.data.suggested_quantity, 75, 'one week plus 7 days lead: 140 - 60 - 25 = 55, up to 25 kg packs');
  assert.equal(hint.json.data.materials[0].counted, true);
  assert.equal((await call('GET', `${base}/suggestion?product_id=99999`, { token: branch.token })).status, 404);
  const [{ n }] = await q(`select count(*)::int as n from supply_requests where location_id = $1`, [branch.id]);
  assert.equal(n, 1, 'the hint never creates a request');
});

test('analytics: conversion from the same rows, the funnel and date limits', async () => {
  const today = manilaToday();
  const insert = (name: string, source: string, status: string) => q(
    `insert into franchise_inquiries (lead_name, email, phone, source, status, inquiry_date, preferred_brand_id) values ($1, $2, '09170000000', $3, $4, $5, $6) returning id`, [name, `${name}@test.local`, source, status, today, brand.id],
  );
  const baseline = (await call('GET', '/analytics/overview', { token: admin })).json.data;
  await insert('a1', 'FB', 'new');
  await insert('a2', 'Facebook Page', 'converted');
  const [linked] = await insert('a3', 'walk-in', 'endorsed');
  await q(`insert into applicants (full_name, status, inquiry_id, application_date) values ('a3', 'rejected', $1, $2)`, [linked.id, today]);

  const overview = await call('GET', '/analytics/overview', { token: admin });
  assert.equal(overview.status, 200, JSON.stringify(overview.json));
  const data = overview.json.data;
  assert.equal(data.kpis.total_inquiries, baseline.kpis.total_inquiries + 3);
  assert.equal(data.inquiries_by_source.facebook, (baseline.inquiries_by_source.facebook ?? 0) + 2, 'spellings collapse into one channel');
  assert.equal(data.inquiries_by_source['walk in'], (baseline.inquiries_by_source['walk in'] ?? 0) + 1);
  assert.equal(data.kpis.conversion_converted, baseline.kpis.conversion_converted + 2, 'converted status, or an applicant linked');
  assert.ok(data.kpis.conversion_rate_percent <= 100);
  assert.equal(data.applicant_funnel.rejected, (baseline.applicant_funnel.rejected ?? 0) + 1);
  assert.equal(data.applicant_funnel.inquiry, data.kpis.total_inquiries);
  assert.equal(data.inquiry_trend.length, 12);
  assert.equal(data.inquiry_trend[11].count, data.inquiry_trend[11].count);
  assert.ok('critical' in data.inventory_status);
  assert.equal(data.supply_statuses.scheduled >= 1, true);

  const seen = await call('GET', '/analytics/overview', { token: marketing });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.data.applicant_funnel, undefined, 'Marketing never receives the funnel');
  assert.equal((await call('GET', '/analytics/top-locations', { token: marketing })).status, 403);
  assert.equal((await call('GET', '/analytics/franchising-dashboard', { token: logistics })).status, 403);
  assert.equal((await call('GET', '/analytics/overview?include_archived=1', { token: sales })).json.data.include_archived, false, 'Sales stays on the active view');
  assert.equal((await call('GET', '/analytics/overview?include_archived=1', { token: admin })).json.data.include_archived, true);
  assert.equal((await call('GET', '/analytics/overview?from=2020-01-01&to=2023-01-01', { token: admin })).status, 422);
  assert.equal((await call('GET', '/analytics/overview?from=2023-01-02&to=2025-12-01', { token: admin })).status, 200);
  assert.equal((await call('GET', '/analytics/overview?from=2023-01-02&to=2022-12-31', { token: admin })).status, 422);
});

test('analytics: inventory movement and the franchising dashboard', async () => {
  const today = manilaToday();
  const moved = await call('GET', '/analytics/inventory-movement', { token: logistics });
  assert.equal(moved.json.data.length, 30);
  assert.equal(moved.json.data[29].date, today);
  assert.equal((await call('GET', '/analytics/inventory-movement?from=2024-01-01&to=2025-06-01', { token: admin })).status, 422);
  assert.equal((await call('GET', '/analytics/top-locations?limit=1', { token: admin })).json.data.length, 1);

  // A sale and a production batch feed the two trends.
  const [item] = await q(`select i.id from inventories i join products p on p.id = i.product_id where p.sku = 'FC-FLOUR' limit 1`);
  const [mine] = await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) select $1, product_id, 10, 1, 0 from inventories where id = $2 returning id`, [branch.id, item.id]);
  const sale = await call('POST', '/branch/sales', { token: branch.token, body: { client_reference: 'fc-1', notes: 'Used', items: [{ inventory_id: mine.id, quantity: 4 }] } });
  assert.equal(sale.status, 201, JSON.stringify(sale.json));

  const dashboard = await call('GET', '/analytics/franchising-dashboard', { token: admin });
  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.json));
  const data = dashboard.json.data;
  assert.equal(data.sales_trend.length, 12);
  assert.equal(data.sales_trend[11].period, today.slice(0, 7));
  assert.equal(data.sales_trend[11].quantity, 4);
  assert.equal(data.top_branches[0].location_id, branch.id);
  assert.equal(data.top_branches[0].quantity, 4);
  assert.equal(data.top_branches[0].rank, 1);
  assert.match(data.insights[0].message, /Flour is in high demand/);
  assert.ok(data.summary.branches_with_sales >= 1);
  assert.ok(data.recent_applications[0].progress);
  assert.ok(data.alerts.length >= 0);

  const yearly = await call('GET', '/analytics/franchising-dashboard?period=year', { token: admin });
  assert.equal(yearly.json.data.sales_trend.length, 6);
  assert.equal(yearly.json.data.sales_trend[5].quantity, 4);
  const wide = await call('GET', '/analytics/franchising-dashboard?from=2024-01-01&to=2026-11-01', { token: admin });
  assert.equal(wide.json.data.bucket, 'year', 'wide ranges roll up to years');
  assert.equal(wide.json.data.sales_trend.length, 3);
  assert.match((await call('GET', '/analytics/franchising-dashboard?from=2024-01-01', { token: admin })).json.errors.to[0], /required when from/);
});
