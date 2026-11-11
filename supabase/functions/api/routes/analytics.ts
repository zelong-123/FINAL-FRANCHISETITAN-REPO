// AnalyticsController and App\Support\ConversionRate.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { intParam, manilaToday, ok } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { role, roleName } from '../lib/middleware.ts';
import { PERMISSIONS } from '../config/roles.ts';
import { STAGE_ORDER } from '../services/pipeline.ts';
import { progress } from '../services/applicantModel.ts';
import { BEFORE_DELIVERY, sqlList, STATUSES as SUPPLY_STATUSES } from '../services/supplyStatus.ts';

export const analyticsRoutes = new Hono<AppEnv>();
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const startOf = (param: string) => `${param}::date::timestamp at time zone 'Asia/Manila'`;
const endOf = (param: string) => `(${param}::date + 1)::timestamp at time zone 'Asia/Manila'`;
const allowsArchive = (c: Context<AppEnv>) => (PERMISSIONS['analytics.include_archived'] as string[]).includes(roleName(c));

// Month arithmetic on YYYY-MM strings and on dates, clamped like Carbon's overflow-free months.
const monthKey = (year: number, month: number) => {
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toISOString().slice(0, 7);
};
const shiftMonth = (key: string, by: number) => {
  const [y, m] = key.split('-').map(Number);
  return monthKey(y, m + by);
};
const monthsBetween = (from: string, to: string) => {
  const [a, b] = from.split('-').map(Number);
  const [c, d] = to.split('-').map(Number);
  return (c - a) * 12 + (d - b);
};
const addMonthsToDate = (date: string, by: number) => {
  const [y, m, d] = date.split('-').map(Number);
  const key = monthKey(y, m + by);
  const [ky, km] = key.split('-').map(Number);
  const last = new Date(Date.UTC(ky, km, 0)).getUTCDate();
  return `${key}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
/** The range is measured from the start of `from` to the end of `to`, so ending on the 36-month mark is over. */
const overThirtySixMonths = (from: string, to: string) => addMonthsToDate(from, 35) <= to;
const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const dayOnly = (value: unknown) => String(value).slice(0, 10);

/** Admin and Marketing type the source by hand, so every spelling of a channel collapses into one key. */
function normalizeSource(source: unknown): string {
  const value = String(source ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases: Record<string, string> = {
    '': 'other', other: 'other', others: 'other', unknown: 'other', 'walk in': 'walk in', walkin: 'walk in', 'walk ins': 'walk in', walkins: 'walk in', 'walk in customer': 'walk in',
    fb: 'facebook', facebook: 'facebook', 'facebook page': 'facebook', viber: 'viber', 'viber account': 'viber', gmail: 'gmail', email: 'gmail', 'e mail': 'gmail',
    referral: 'referral', referrals: 'referral', referred: 'referral', referal: 'referral',
  };
  return aliases[value] ?? value;
}

const percent = (converted: number, total: number) => (total <= 0 ? 0 : round2(Math.min(100, Math.max(0, (converted / total) * 100))));

/** One definition of conversion: the numerator is always drawn from the same rows as the denominator. */
async function convertedIds(db: Db, inquiries: Row[]): Promise<Set<number>> {
  if (!inquiries.length) return new Set();
  const linked = await db.query(`select distinct inquiry_id from applicants where inquiry_id = any($1::bigint[])`, [`{${inquiries.map((i) => i.id).join(',')}}`]);
  const ids = new Set(linked.map((l) => l.inquiry_id));
  return new Set(inquiries.filter((i) => i.status === 'converted' || ids.has(i.id)).map((i) => i.id));
}
const conversionOf = (rows: Row[], converted: Set<number>) => {
  const hit = rows.filter((r) => converted.has(r.id)).length;
  return { converted: hit, total: rows.length, percent: percent(hit, rows.length) };
};

async function furthestStage(db: Db, rejected: number[]): Promise<Map<number, number>> {
  const best = new Map<number, number>();
  if (!rejected.length) return best;
  const history = await db.query(`select applicant_id, to_status from applicant_status_histories where applicant_id = any($1::bigint[])`, [`{${rejected.join(',')}}`]);
  for (const row of history) {
    if (row.to_status === null || row.to_status === 'rejected') continue;
    const index = STAGE_ORDER.indexOf(row.to_status);
    if (index !== -1 && (!best.has(row.applicant_id) || index > best.get(row.applicant_id)!)) best.set(row.applicant_id, index);
  }
  return best;
}

analyticsRoutes.get('/analytics/overview', role('admin', 'marketing', 'sales', 'logistics'), async (c) => {
  const { db } = c.get('deps');
  const input = await readInput(c);
  const v = await validate(db, input, { from: ['nullable', 'date'], to: ['nullable', 'date', 'after_or_equal:from'], include_archived: ['nullable', 'boolean'] });
  const today = manilaToday();
  const from = v.from ? dayOnly(v.from) : `${shiftMonth(today.slice(0, 7), -11)}-01`;
  const to = v.to ? dayOnly(v.to) : today;
  if (overThirtySixMonths(from, to)) return c.json({ message: 'Analytics ranges are limited to 36 months.' }, 422);

  // One switch for the whole payload; inventory and supply requests have no archive.
  const includeArchived = Boolean(v.include_archived) && allowsArchive(c);
  const activeOnly = includeArchived ? '' : 'and archived_at is null';
  const inquiries = await db.query(
    `select i.id, i.status, i.source, i.inquiry_date, (select b.name from brands b where b.id = i.preferred_brand_id) as brand_name from franchise_inquiries i where i.inquiry_date between $1::date and $2::date ${activeOnly}`, [from, to],
  );
  const applicants = await db.query(`select id, status from applicants where application_date between $1::date and $2::date ${activeOnly}`, [from, to]);

  // A rejected candidate counts at the furthest stage actually reached, keeping the funnel honest.
  const funnel: Record<string, number> = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0]));
  funnel.rejected = 0;
  const furthest = await furthestStage(db, applicants.filter((a) => a.status === 'rejected').map((a) => a.id));
  for (const candidate of applicants) {
    if (candidate.status === 'rejected') {
      funnel.rejected += 1;
      funnel[STAGE_ORDER[furthest.get(candidate.id) ?? 0]] += 1;
    } else if (candidate.status in funnel) funnel[candidate.status] += 1;
  }

  const requests = await db.query(
    `select status, to_char(created_at at time zone 'Asia/Manila', 'YYYY-MM') as created_key, to_char(completed_at at time zone 'Asia/Manila', 'YYYY-MM') as completed_key,
       extract(epoch from (completed_at - created_at)) / 3600 as hours from supply_requests where created_at >= ${startOf('$1')} and created_at < ${endOf('$2')}`, [from, to],
  );
  const inventories = await db.query(`select current_stock, reorder_level, critical_level from inventories`);
  const converted = await convertedIds(db, inquiries);
  const conversion = conversionOf(inquiries, converted);
  const completed = requests.filter((r) => ['completed', 'completed_with_discrepancy'].includes(r.status)).length;

  const bySource = new Map<string, Row[]>();
  for (const row of inquiries) {
    const key = normalizeSource(row.source);
    bySource.set(key, [...(bySource.get(key) ?? []), row]);
  }
  const sourceConversion = [...bySource.entries()].map(([source, rows]) => {
    const result = conversionOf(rows, converted);
    return { source, leads: result.total, converted: result.converted, conversion_rate_percent: result.percent };
  }).sort((a, b) => b.conversion_rate_percent - a.conversion_rate_percent);

  const months = Array.from({ length: Math.max(1, monthsBetween(from.slice(0, 7), to.slice(0, 7)) + 1) }, (_, i) => shiftMonth(from.slice(0, 7), i));
  const status = (test: (stock: number, reorder: number, critical: number) => boolean) => inventories.filter((i) => test(Number(i.current_stock), Number(i.reorder_level), Number(i.critical_level))).length;
  const inventoryStatus = { normal: status((s, r) => s > r), low: status((s, r, k) => s > k && s <= r), critical: status((s, _r, k) => s <= k) };
  const leadTimes = requests.filter((r) => r.hours !== null).map((r) => Number(r.hours));
  const [{ pipeline }] = await db.query(`select count(*)::int as pipeline from applicants where status not in ('rejected', 'active_franchisee') ${activeOnly}`);
  const [{ branches }] = await db.query(`select count(*)::int as branches from franchise_locations where is_active = true and type = 'franchise'`);

  const byBranch: Record<string, number> = {};
  for (const row of inquiries) {
    const key = String(row.brand_name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    byBranch[key] = (byBranch[key] ?? 0) + 1;
  }
  return ok(c, {
    period: { from: `${from}T00:00:00+08:00`, to: `${to}T23:59:59+08:00` }, include_archived: includeArchived,
    kpis: {
      total_inquiries: inquiries.length, endorsed_inquiries: inquiries.filter((i) => ['endorsed', 'converted'].includes(i.status)).length, converted_inquiries: inquiries.filter((i) => i.status === 'converted').length,
      active_applicants: pipeline, active_franchise_locations: branches, conversion_converted: conversion.converted, conversion_total: conversion.total, conversion_rate_percent: conversion.percent,
      supply_requests: requests.length, fulfillment_rate_percent: requests.length ? round2((completed / requests.length) * 100) : 0,
      average_fulfillment_hours: leadTimes.length ? round2(leadTimes.reduce((sum, h) => sum + h, 0) / leadTimes.length) : null, critical_inventory_items: inventoryStatus.critical,
    },
    inquiry_trend: months.map((period) => ({ period, count: inquiries.filter((i) => dayOnly(i.inquiry_date).slice(0, 7) === period).length })),
    supply_request_trend: months.map((period) => ({ period, submitted: requests.filter((r) => r.created_key === period).length, completed: requests.filter((r) => r.completed_key === period).length })),
    inventory_status: inventoryStatus,
    inquiries_by_source: Object.fromEntries([...bySource.entries()].map(([k, rows]) => [k, rows.length] as const).sort((a, b) => b[1] - a[1])),
    inquiries_by_branch: byBranch, inquiries_by_source_conversion: sourceConversion,
    // Marketing shares this response for its other panels but never receives the funnel.
    ...(roleName(c) === 'marketing' ? {} : { applicant_funnel: { ...funnel, inquiry: inquiries.length } }),
    supply_statuses: Object.fromEntries(SUPPLY_STATUSES.map((s) => [s, requests.filter((r) => r.status === s).length])),
  });
});

const staffAnalytics = role('admin', 'sales', 'logistics');

analyticsRoutes.get('/analytics/top-locations', staffAnalytics, async (c) => {
  const { db } = c.get('deps');
  const limit = Math.max(1, Math.min(50, intParam(c.req.query('limit'), 10)));
  return ok(c, await db.query(
    `select l.*, (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = l.brand_id) as brand,
       (select jsonb_build_object('id', f.id, 'business_name', f.business_name) from franchisees f where f.id = l.franchisee_id) as franchisee,
       (select count(*)::int from supply_requests sr where sr.location_id = l.id) as supply_requests_count,
       (select count(*)::int from supply_requests sr where sr.location_id = l.id and sr.status in ('completed', 'completed_with_discrepancy')) as completed_supply_requests_count
     from franchise_locations l where l.type = 'franchise' order by completed_supply_requests_count desc, l.id limit ${limit}`,
  ));
});

analyticsRoutes.get('/analytics/inventory-movement', staffAnalytics, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { from: ['nullable', 'date'], to: ['nullable', 'date', 'after_or_equal:from'], location_id: ['nullable', 'exists:franchise_locations,id'] });
  const today = manilaToday();
  const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const from = v.from ? dayOnly(v.from) : shift(today, -29);
  const to = v.to ? dayOnly(v.to) : today;
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  // Measured to the end of `to`, so a span of exactly 366 whole days is already over the limit.
  if (span >= 366) return c.json({ message: 'Inventory movement ranges are limited to 366 days.' }, 422);
  const rows = await db.query(
    `select (t.transaction_date at time zone 'Asia/Manila')::date::text as on_day, t.quantity from inventory_transactions t join inventories i on i.id = t.inventory_id
     where t.transaction_date >= ${startOf('$1')} and t.transaction_date < ${endOf('$2')} and ($3::bigint is null or i.location_id = $3::bigint)`, [from, to, v.location_id ?? null],
  );
  return ok(c, Array.from({ length: span + 1 }, (_, offset) => {
    const date = shift(from, offset);
    const quantities = rows.filter((r) => r.on_day === date).map((r) => Number(r.quantity));
    return { date, inbound: round2(quantities.filter((q) => q > 0).reduce((s, q) => s + q, 0)), outbound: round2(Math.abs(quantities.filter((q) => q < 0).reduce((s, q) => s + q, 0))) };
  }));
});

analyticsRoutes.get('/analytics/franchising-dashboard', role('admin', 'sales'), async (c) => {
  const { db } = c.get('deps');
  const input = await readInput(c);
  const v = await validate(db, input, {
    period: ['nullable', 'in:month,year'], limit: ['nullable', 'integer', 'min:1', 'max:25'], from: ['nullable', 'date', 'required_with:to'], to: ['nullable', 'date', 'after_or_equal:from', 'required_with:from'], include_archived: ['nullable', 'boolean'],
  });
  const period = v.period || 'month';
  const limit = Math.max(1, Math.min(25, Number(v.limit ?? 8)));
  const includeArchived = Boolean(v.include_archived) && allowsArchive(c);
  const activeOnly = includeArchived ? '' : 'and archived_at is null';
  const rangeFrom: string | null = v.from ? dayOnly(v.from) : null;
  const rangeTo: string | null = v.to ? dayOnly(v.to) : null;
  if (rangeFrom && overThirtySixMonths(rangeFrom, rangeTo!)) return c.json({ message: 'Analytics ranges are limited to 36 months.' }, 422);

  // Very wide ranges roll up to years, so the chart never draws more than 24 bars.
  let bucket: string = period;
  if (rangeFrom && bucket === 'month' && monthsBetween(rangeFrom.slice(0, 7), rangeTo!.slice(0, 7)) + 1 > 24) bucket = 'year';
  const pattern = bucket === 'year' ? 'YYYY' : 'YYYY-MM';
  const key = (column: string) => `to_char(${column} at time zone 'Asia/Manila', '${pattern}')`;
  const params = rangeFrom ? [rangeFrom, rangeTo] : [];
  const within = (column: string) => (rangeFrom ? `and ${column} >= ${startOf('$1')} and ${column} < ${endOf('$2')}` : '');

  const today = manilaToday();
  const thisMonth = today.slice(0, 7);
  const thisYear = Number(today.slice(0, 4));
  let periods: string[];
  if (rangeFrom) {
    periods = bucket === 'year'
      ? Array.from({ length: Number(rangeTo!.slice(0, 4)) - Number(rangeFrom.slice(0, 4)) + 1 }, (_, i) => String(Number(rangeFrom.slice(0, 4)) + i))
      : Array.from({ length: monthsBetween(rangeFrom.slice(0, 7), rangeTo!.slice(0, 7)) + 1 }, (_, i) => shiftMonth(rangeFrom.slice(0, 7), i));
  } else {
    periods = bucket === 'year' ? Array.from({ length: 6 }, (_, i) => String(thisYear - 5 + i)) : Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth, i - 11));
  }
  const labelOf = (k: string) => (bucket === 'year' ? k : monthLabel(k));

  const salesRows = await db.query(
    `select ${key('s.created_at')} as period_key, count(distinct s.id)::int as sale_count, coalesce(sum(i.quantity), 0) as quantity from branch_sales s join branch_sale_items i on i.branch_sale_id = s.id where true ${within('s.created_at')} group by 1`, params,
  );
  const sales = new Map(salesRows.map((r) => [r.period_key, r]));
  const batchRows = await db.query(
    `select ${key('b.created_at')} as period_key, coalesce(sum(b.quantity_pieces), 0) as units, count(*)::int as batch_count,
       coalesce(sum((select coalesce(sum(pc.total_cost_cents), 0) from profittrack_production_consumptions pc where pc.batch_id = b.id)), 0) as cost_cents
     from profittrack_production_batches b where b.voided_at is null ${within('b.created_at')} group by 1`, params,
  );
  const batches = new Map(batchRows.map((r) => [r.period_key, r]));

  const topRows = await db.query(
    `select l.id, l.name, l.branch_code, (select b.name from brands b where b.id = l.brand_id) as brand, (select f.business_name from franchisees f where f.id = l.franchisee_id) as business_name,
       (select count(*)::int from branch_sales s where s.location_id = l.id ${within('s.created_at')}) as sale_count,
       (select coalesce(sum(i.quantity), 0) from branch_sales s join branch_sale_items i on i.branch_sale_id = s.id where s.location_id = l.id ${within('s.created_at')}) as quantity
     from franchise_locations l where l.type = 'franchise' order by quantity desc, l.id limit ${limit}`, params,
  );

  const demand = await db.query(
    `select p.name, sum(i.quantity) as quantity from branch_sales s join branch_sale_items i on i.branch_sale_id = s.id join products p on p.id = i.product_id
     where s.created_at >= ((now() at time zone 'Asia/Manila')::date - 6)::timestamp at time zone 'Asia/Manila' group by p.name order by quantity desc limit 3`,
  );
  const insights: Row[] = [];
  if (demand.length) insights.push({ type: 'demand', message: `${demand.map((d) => d.name).join(', ')} ${demand.length === 1 ? 'is' : 'are'} in high demand this week.` });
  const count = async (sql: string, values: unknown[] = []) => Number((await db.query(sql, values))[0].n);
  const activeApplicants = await count(`select count(*)::int as n from applicants where status not in ('rejected', 'active_franchisee') ${activeOnly}`);
  const completedApplicants = await count(`select count(*)::int as n from applicants where status in ('approved', 'active_franchisee') ${activeOnly}`);
  const activeBranches = await count(`select count(*)::int as n from franchise_locations where type = 'franchise' and is_active = true`);
  insights.push({ type: 'coverage', message: `${activeApplicants} candidates are in the pipeline across ${activeBranches} active branches.` });
  insights.push({
    type: 'conversion',
    message: activeApplicants + completedApplicants > 0 ? `${completedApplicants} of ${activeApplicants + completedApplicants} pipeline candidates have been approved so far.` : 'No candidates are currently in the pipeline.',
  });

  const alerts: Row[] = [];
  const critical = await count(`select count(*)::int as n from inventories where current_stock <= critical_level`);
  if (critical > 0) alerts.push({ severity: 'danger', message: `${critical} inventory item(s) have reached the critical level.` });
  const stalled = await count(
    `select count(*)::int as n from applicants a where a.status = 'scheduled' ${includeArchived ? '' : 'and a.archived_at is null'} and not exists (select 1 from activity_schedules s where s.applicant_id = a.id and s.starts_at >= now() - interval '14 days')`,
  );
  if (stalled > 0) alerts.push({ severity: 'warning', message: `${stalled} scheduled applicant(s) have no activity in the last 14 days.` });
  const pending = await count(`select count(*)::int as n from payments where status = 'pending' and created_at <= now() - interval '3 days'`);
  if (pending > 0) alerts.push({ severity: 'warning', message: `${pending} payment(s) are awaiting verification.` });
  const late = await count(`select count(*)::int as n from supply_requests where status in (${sqlList(BEFORE_DELIVERY)}) and coalesce(confirmed_delivery_date, target_delivery_date) < $1::date`, [today]);
  if (late > 0) alerts.push({ severity: 'danger', message: `${late} supply request(s) are past their target delivery date.` });

  const recent = await db.query(
    `select a.*, (select b.name from brands b where b.id = a.preferred_brand_id) as brand_name from applicants a where true ${includeArchived ? '' : 'and a.archived_at is null'}
     ${rangeFrom ? 'and a.application_date between $1::date and $2::date' : ''} order by a.application_date desc, a.id desc limit 6`, params,
  );
  return ok(c, {
    period, bucket, range: rangeFrom ? { from: rangeFrom, to: rangeTo } : null, include_archived: includeArchived,
    sales_trend: periods.map((k) => ({ period: k, label: labelOf(k), sales: Number(sales.get(k)?.sale_count ?? 0), quantity: round2(Number(sales.get(k)?.quantity ?? 0)) })),
    production_trend: periods.map((k) => ({
      period: k, label: labelOf(k), units: Number(batches.get(k)?.units ?? 0), transactions: Number(batches.get(k)?.batch_count ?? 0), material_cost: round2(Number(batches.get(k)?.cost_cents ?? 0) / 100),
    })),
    top_branches: topRows.map((l, index) => ({ location_id: l.id, name: l.name, branch_code: l.branch_code, brand: l.brand, business_name: l.business_name, sales: Number(l.sale_count), quantity: round2(Number(l.quantity)), rank: index + 1 })),
    insights, alerts,
    recent_applications: recent.map((a) => ({ id: a.id, applicant_code: a.applicant_code, full_name: a.full_name, brand: a.brand_name, status: a.status, application_date: dayOnly(a.application_date), progress: progress(a) })),
    summary: {
      active_applicants: activeApplicants, active_franchisees: await count(`select count(*)::int as n from franchisees where franchise_status = 'active'`),
      branches_with_sales: await count(`select count(*)::int as n from franchise_locations l where exists (select 1 from branch_sales s where s.location_id = l.id)`),
    },
  });
});
