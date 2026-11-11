// Supply requests (Objective 3). Reading (lists, dashboards, detail) is here; every change of a
// request goes through one action endpoint that calls services/supplyWorkflow.ts, where the rules
// are enforced. The old PATCH /status and the Admin-proposed date revision are retired.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, Filter, fail, intParam, manilaToday, ok, perPage, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { downloadDocument, MAX_UPLOAD_KB, storeDocument } from '../lib/files.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { resolveWorkspace } from '../services/branchAccess.ts';
import * as S from '../services/supplyStatus.ts';
import * as W from '../services/supplyWorkflow.ts';
import { earliestTargetDate } from '../services/workingDays.ts';

export const supplyRoutes = new Hono<AppEnv>();
const MODEL = 'App\\Models\\SupplyRequest';
const DELIVERY = 'App\\Models\\Delivery';
const viewers = role('admin', 'logistics', 'franchisee');
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const day = (s: string) => s.slice(0, 10);
const NAME = (expr: string, extra = '') => `(select jsonb_build_object('id', u.id, 'full_name', u.full_name${extra}) from users u where u.id = ${expr})`;
const CREATED_ON = `(sr.created_at at time zone 'Asia/Manila')::date`;
/** The stages shown on the staff pipeline: every open status after the branch submits. */
const STAGES = S.SUBMITTED_OPEN;

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
  // Logistics sees a request once Admin has sent it on (or holds it); never drafts or requests still in review.
  if (name === 'logistics') f.add(`sr.status not in (${S.sqlList(S.HIDDEN_FROM_LOGISTICS)}) and not (sr.status in ('rejected', 'cancelled') and sr.fulfillment_decided_at is null)`);
  return f;
}

async function assertAccess(c: Context<AppEnv>, db: Db, sr: Row) {
  const name = roleName(c);
  if (name === 'logistics' && (S.HIDDEN_FROM_LOGISTICS.includes(sr.status) || (['rejected', 'cancelled'].includes(sr.status) && !sr.fulfillment_decided_at))) abort(404, 'Record not found.');
  if (name !== 'franchisee') return;
  const owns = (await ownLocationIds(c, db)).includes(sr.location_id);
  const creator = sr.requested_by_user_id === c.get('user').id;
  if (!owns || (!creator && sr.status === 'draft')) abort(403, 'You cannot access this supply request.');
}

const load = async (c: Context<AppEnv>): Promise<Row> => requireFound((await c.get('deps').db.query(`select * from supply_requests where id = $1`, [routeId(c, 'supplyRequest')]))[0]);

/** The delivery date everyone works to: Logistics' confirmed date, an older confirmed revision, or the branch's target. */
function effectiveDate(sr: Row, revisions: Row[]): string | null {
  if (sr.confirmed_delivery_date) return sr.confirmed_delivery_date;
  const confirmed = revisions.filter((r) => ['confirmed', 'approved'].includes(r.status)).pop();
  return confirmed?.revised_delivery_date ?? sr.target_delivery_date ?? null;
}

const LOCATION_BRAND = (a: string) => `(select to_jsonb(l) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = l.brand_id)) from franchise_locations l where l.id = ${a}.location_id)`;
const ITEMS = (a: string) => `coalesce((select jsonb_agg(to_jsonb(si) || jsonb_build_object('product', (select to_jsonb(p) from products p where p.id = si.product_id)) order by si.id) from supply_request_items si where si.supply_request_id = ${a}.id), '[]'::jsonb)`;
const DELIVERY_DOCS = (a: string) => `(select to_jsonb(d) || jsonb_build_object('documents', coalesce((select jsonb_agg(to_jsonb(doc) order by doc.id) from documents doc where doc.documentable_type = 'App\\Models\\Delivery' and doc.documentable_id = d.id), '[]'::jsonb)) from deliveries d where d.supply_request_id = ${a}.id limit 1)`;
const REVISIONS = (a: string) => `coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from supply_request_date_revisions r where r.supply_request_id = ${a}.id), '[]'::jsonb)`;
/** What the owner and overdue rules need, in the same row (no extra query per request). */
const SLA = (a: string) => `
  (select r.created_at from supply_request_date_revisions r where r.supply_request_id = ${a}.id and r.status = 'pending' and r.proposed_by_role = 'logistics' order by r.id desc limit 1) as sla_pending_date_at,
  (select s.created_at from supply_shortage_reports s where s.supply_request_id = ${a}.id and s.status = 'pending' order by s.id desc limit 1) as sla_pending_shortage_at,
  (select d.eta_at from deliveries d where d.supply_request_id = ${a}.id limit 1) as sla_eta_at,
  (select d.pod_encoded_at from deliveries d where d.supply_request_id = ${a}.id limit 1) as sla_pod_at,
  (select p.request_number from supply_requests p where p.id = ${a}.parent_request_id) as parent_request_number`;

/** Adds owners, the pending flags and the overdue reason; drops the helper columns. */
function withWorkflow(sr: Row, today = manilaToday()): Row {
  const { sla_pending_date_at, sla_pending_shortage_at, sla_eta_at, sla_pod_at, ...row } = sr;
  const ctx = { pod: Boolean(sla_pod_at), received: Boolean(sr.branch_received_at), pendingDate: Boolean(sla_pending_date_at), pendingShortage: Boolean(sla_pending_shortage_at) };
  const overdue = W.overdueReason(sr, { pendingDateAt: sla_pending_date_at, pendingShortageAt: sla_pending_shortage_at, etaAt: sla_eta_at, pod: ctx.pod }, today);
  return {
    ...row, status_label: S.LABELS[sr.status] ?? sr.status, owners: S.ownersOf(sr.status, ctx), pending_date_change: ctx.pendingDate, pending_shortage: ctx.pendingShortage,
    pod_encoded: ctx.pod, overdue: overdue !== null, overdue_reason: overdue,
  };
}

const fullRow = async (db: Db, id: number) => {
  const [row] = await db.query(
    `select sr.*, ${LOCATION_BRAND('sr')} as location, ${ITEMS('sr')} as items, ${DELIVERY_DOCS('sr')} as delivery, ${REVISIONS('sr')} as date_revisions, ${SLA('sr')} from supply_requests sr where sr.id = $1`, [id],
  );
  return { ...withWorkflow(row), effective_delivery_date: effectiveDate(row, row.date_revisions) };
};

// ---- dashboards ----
async function countsByStatus(db: Db, f: Filter): Promise<Row> {
  const rows = await db.query(`select sr.status, count(*)::int as n from supply_requests sr ${f.where} group by sr.status`, f.params);
  return Object.fromEntries(S.STATUSES.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
}

/** Open requests with their SLA columns, for counting the overdue ones. */
async function overdueCount(db: Db, f: Filter): Promise<number> {
  const where = f.where ? `${f.where} and` : 'where';
  const rows = await db.query(`select sr.*, ${SLA('sr')} from supply_requests sr ${where} sr.status in (${S.sqlList(S.SUBMITTED_OPEN)})`, f.params);
  const today = manilaToday();
  return rows.filter((r) => withWorkflow(r, today).overdue).length;
}

supplyRoutes.get('/supply-requests/stats', viewers, async (c) => {
  const { db } = c.get('deps');
  const f = await scoped(c, db);
  const byStatus = await countsByStatus(db, f);
  const where = f.where ? `${f.where} and` : 'where';
  const done = `sr.status in (${S.sqlList(['completed', 'completed_with_discrepancy'])})`;
  const [{ n: completed }] = await db.query(
    `select count(*)::int as n from supply_requests sr ${where} ${done} and sr.completed_at >= date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila' and sr.completed_at <= now()`, f.params,
  );
  const [{ avg }] = await db.query(
    `select avg((sr.completed_at at time zone 'Asia/Manila')::date - (sr.created_at at time zone 'Asia/Manila')::date) as avg from supply_requests sr ${where} ${done} and sr.completed_at is not null`, f.params,
  );
  return ok(c, {
    total: Object.values(byStatus).reduce((a: number, b) => a + Number(b), 0), by_status: byStatus, active: S.SUBMITTED_OPEN.reduce((a, s) => a + byStatus[s], 0),
    overdue: await overdueCount(db, f), completed_this_month: completed, avg_fulfillment_days: Math.round(Number(avg ?? 0) * 10) / 10,
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
  const [counts] = await db.query(
    `select count(*) filter (where sr.status in (${S.sqlList(STAGES)}))::int as queue, count(*) filter (where ${CREATED_ON} = '${today}'::date)::int as today from supply_requests sr ${f.where}`, f.params,
  );
  const done = S.sqlList(['completed', 'completed_with_discrepancy']);
  const cycles = await db.query(`select sr.created_at, sr.completed_at from supply_requests sr ${where} sr.status in (${done}) and sr.completed_at is not null`, f.params);
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
  const approved = ['waiting_logistics', 'scheduled', 'preparing', 'dispatched', 'delivered', 'discrepancy_review', 'completed', 'completed_with_discrepancy'];
  return ok(c, {
    stages: STAGES.map((key) => ({ key, label: S.LABELS[key], count: byStatus[key] ?? 0 })),
    kpis: {
      today: { value: counts.today, meta: latestToday ? `Latest: ${latestToday}` : latestNumber ? `Latest: ${latestNumber}` : 'Nothing queued yet' },
      approved: { value: approved.reduce((a, s) => a + byStatus[s], 0), meta: 'Endorsed and beyond' },
      queue: { value: counts.queue, critical: await overdueCount(db, f) },
      route_to_branch: { value: byStatus.dispatched, meta: dispatchedLatest ? `Latest: ${dispatchedLatest}` : 'Nothing in transit' },
      branch_confirmation: { value: byStatus.delivered, meta: deliveredLatest ? `Latest: ${deliveredLatest}` : 'No deliveries pending' },
    },
    avg_cycle_time: avgCycle,
    rows: rows.map((sr) => {
      const days = Math.round(daysBetween(sr.created_at, sr.completed_at ?? new Date()) * 10) / 10;
      return {
        id: sr.request_number, branch: sr.branch ?? '—', category: sr.categories?.length ? sr.categories.join(', ') : 'General',
        stage: S.LABELS[sr.status] ?? sr.status, queue_days: days, last_update: stamp.format(new Date(sr.updated_at)).replace(/,(?=[^,]*$)/, ','), cycle_days: days,
      };
    }),
  });
});

supplyRoutes.get('/supply-requests/active-counts', viewers, async (c) => {
  const { db } = c.get('deps');
  const f = await scoped(c, db);
  const by = await countsByStatus(db, f);
  const result: Row = Object.fromEntries(STAGES.map((s) => [s, by[s]]));
  return ok(c, { ...result, active_total: STAGES.reduce((a, s) => a + by[s], 0) });
});

// ---- settings (Admin) ----
/** The settings plus today's earliest target dates (normal, and urgent/critical) for the request forms. */
const settingsView = async (db: Db) => {
  const settings = await W.supplySettings(db);
  const today = manilaToday();
  return { ...settings, earliest_normal: earliestTargetDate(today, settings.lead_days), earliest_urgent: earliestTargetDate(today, settings.lead_days, true) };
};
supplyRoutes.get('/supply-settings', viewers, async (c) => ok(c, await settingsView(c.get('deps').db)));

supplyRoutes.put('/supply-settings', role('admin'), async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    supply_lead_time_working_days: ['required', 'integer', 'min:1', 'max:10'], bulk_threshold_percent: ['required', 'numeric', 'min:0', 'max:1000'],
  });
  const before = await W.supplySettings(db);
  const [row] = await db.query(`select id from supply_settings order by id limit 1`);
  const fields = { supply_lead_time_working_days: Number(v.supply_lead_time_working_days), bulk_threshold_percent: Number(v.bulk_threshold_percent), updated_by_user_id: c.get('user').id };
  if (row) await updateRow(db, 'supply_settings', row.id, fields);
  else await db.query(`insert into supply_settings (supply_lead_time_working_days, bulk_threshold_percent, updated_by_user_id) values ($1, $2, $3)`, Object.values(fields));
  await audit(c, db, 'supply_settings.updated', { type: 'App\\Models\\SupplySetting', id: row?.id ?? 1 }, before, fields);
  return ok(c, await settingsView(db), 'Supply settings saved.');
});

// ---- lists and detail ----
const ROLE_KEY: Record<string, string> = { admin: 'admin', logistics: 'logistics', franchisee: 'branch' };
const URGENCY_RANK: Record<string, number> = { critical: 0, urgent: 1, normal: 2 };
const SORTS = ['priority', 'newest', 'oldest', 'target', 'branch', 'brand'];

/**
 * Every request the viewer may see that matches the toolbar (search, brand, urgency, branch, date
 * requested), light enough to count tabs and KPIs and to sort by priority, which depends on the
 * owners and the working-day SLA.
 */
async function listCandidates(c: Context<AppEnv>, db: Db, q: Record<string, string>): Promise<Row[]> {
  const f = await scoped(c, db);
  // Staff never see a branch's unsent drafts.
  if (roleName(c) !== 'franchisee') f.add(`sr.status <> 'draft'`);
  if (q.urgency) {
    if (!['normal', 'urgent', 'critical'].includes(q.urgency)) fail('urgency', 'The urgency must be normal, urgent or critical.');
    f.add('sr.urgency = ?', q.urgency);
  }
  if (q.brand_id) f.add('l.brand_id = ?', intParam(q.brand_id));
  if (q.location_id) f.add('sr.location_id = ?', intParam(q.location_id));
  if (q.from) f.add(`${CREATED_ON} >= ?::date`, day(q.from));
  if (q.to) f.add(`${CREATED_ON} <= ?::date`, day(q.to));
  if (q.search?.trim()) {
    const term = `%${q.search.trim()}%`;
    f.add('(sr.request_number ilike ? or l.name ilike ? or l.city ilike ?)', term, term, term);
  }
  const rows = await db.query(
    `select sr.id, sr.status, sr.urgency, sr.created_at, sr.updated_at, sr.status_changed_at, sr.target_delivery_date, sr.confirmed_delivery_date,
       sr.expected_restock_date, sr.branch_received_at, sr.request_number, l.name as branch_name, l.city, b.name as brand_name, ${SLA('sr')}
     from supply_requests sr join franchise_locations l on l.id = sr.location_id left join brands b on b.id = l.brand_id ${f.where}`, f.params,
  );
  const today = manilaToday();
  const mine = ROLE_KEY[roleName(c)];
  return rows.map((row) => {
    const w = withWorkflow(row, today);
    return { ...w, needs_my_action: w.owners.includes(mine) };
  });
}

function tabCounts(rows: Row[]) {
  const tabs: Row = { needs_action: rows.filter((r) => r.needs_my_action).length };
  for (const [key, statuses] of Object.entries(S.TABS)) tabs[key] = statuses ? rows.filter((r) => statuses.includes(r.status)).length : rows.length;
  const kpis = {
    needs_action: tabs.needs_action,
    overdue: rows.filter((r) => r.overdue).length,
    on_hold: rows.filter((r) => r.status === 'on_hold').length,
    in_transit: rows.filter((r) => S.IN_TRANSIT.includes(r.status)).length,
    discrepancies: rows.filter((r) => r.status === 'discrepancy_review').length,
  };
  return { tabs, kpis };
}

function sortRows(rows: Row[], sort: string) {
  const time = (v: unknown) => new Date(v as string).getTime();
  const target = (r: Row) => String(r.confirmed_delivery_date ?? r.target_delivery_date ?? '9999-12-31');
  const by: Record<string, (a: Row, b: Row) => number> = {
    // Overdue first, then Critical, Urgent, Normal; the longest waiting first within each.
    priority: (a, b) => Number(b.overdue) - Number(a.overdue) || (URGENCY_RANK[a.urgency] ?? 2) - (URGENCY_RANK[b.urgency] ?? 2) || time(a.created_at) - time(b.created_at) || a.id - b.id,
    newest: (a, b) => time(b.created_at) - time(a.created_at) || b.id - a.id,
    oldest: (a, b) => time(a.created_at) - time(b.created_at) || a.id - b.id,
    target: (a, b) => target(a).localeCompare(target(b)) || a.id - b.id,
    branch: (a, b) => String(a.branch_name).localeCompare(String(b.branch_name)) || a.id - b.id,
    brand: (a, b) => String(a.brand_name ?? '').localeCompare(String(b.brand_name ?? '')) || String(a.branch_name).localeCompare(String(b.branch_name)) || a.id - b.id,
  };
  return [...rows].sort(by[sort]);
}

/** Tab and KPI counts for the toolbar's current filters (the list returns the same in meta). */
supplyRoutes.get('/supply-requests/counts', viewers, async (c) => {
  const { db } = c.get('deps');
  return ok(c, tabCounts(await listCandidates(c, db, c.req.query())));
});

/**
 * The list. tab: needs_action | all | under_review | on_hold | scheduled_preparing | dispatched |
 * discrepancy | completed | closed; overdue=1; status; view=active|history (older clients);
 * search, brand_id, urgency, location_id, from, to; sort: priority (default) | newest | oldest |
 * target | branch | brand. meta carries the tab and KPI counts.
 */
supplyRoutes.get('/supply-requests', viewers, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const sort = q.sort || 'priority';
  if (!SORTS.includes(sort)) fail('sort', `The sort must be one of: ${SORTS.join(', ')}.`);
  if (q.tab && q.tab !== 'needs_action' && !(q.tab in S.TABS)) fail('tab', 'Unknown tab.');
  if (q.view !== undefined && !['active', 'history'].includes(q.view)) abort(422, 'The view must be active or history.');
  if (q.status && !S.STATUSES.includes(q.status)) fail('status', 'Unknown status.');

  const candidates = await listCandidates(c, db, q);
  const counts = tabCounts(candidates);
  let rows = candidates;
  if (q.tab === 'needs_action') rows = rows.filter((r) => r.needs_my_action);
  else if (q.tab && S.TABS[q.tab]) rows = rows.filter((r) => S.TABS[q.tab]!.includes(r.status));
  if (q.view === 'active') rows = rows.filter((r) => S.SUBMITTED_OPEN.includes(r.status));
  if (q.view === 'history') rows = rows.filter((r) => S.TERMINAL.includes(r.status));
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.overdue === '1' || q.overdue === 'true') rows = rows.filter((r) => r.overdue);
  rows = sortRows(rows, sort);

  const size = perPage(c, 20);
  const total = rows.length;
  const lastPage = Math.max(1, Math.ceil(total / size));
  const page = Math.max(1, intParam(q.page, 1));
  const ids = rows.slice((page - 1) * size, page * size).map((r) => r.id);
  const full = ids.length ? await db.query(
    `select sr.*, ${LOCATION_BRAND('sr')} as location, ${NAME('sr.requested_by_user_id')} as requested_by, ${ITEMS('sr')} as items, ${DELIVERY_DOCS('sr')} as delivery, ${REVISIONS('sr')} as date_revisions, ${SLA('sr')}
     from supply_requests sr where sr.id = any($1::bigint[])`, [`{${ids.join(',')}}`],
  ) : [];
  const byId = new Map(full.map((r) => [Number(r.id), r]));
  const mine = ROLE_KEY[roleName(c)];
  const today = manilaToday();
  const data = [];
  for (const id of ids) {
    const sr = withWorkflow(byId.get(Number(id))!, today);
    let reason: string | null = null;
    if (sr.status === 'under_review') {
      const lines = await W.availabilityOf(db, sr).catch(() => null);
      if (!lines) reason = 'No active warehouse location is configured.';
      else if (lines.some((l) => l.unavailable > 0)) reason = 'Stock is short; choose a Fulfillment Decision.';
    } else reason = 'Only a request under review can be endorsed.';
    data.push({
      ...sr, needs_my_action: sr.owners.includes(mine), effective_delivery_date: effectiveDate(sr, sr.date_revisions), pending_date_revision: sr.pending_date_change,
      can_endorse: reason === null, endorse_block_reason: reason,
    });
  }
  const url = (n: number) => {
    const u = new URL(c.req.url);
    u.searchParams.set('page', String(n));
    return u.toString();
  };
  return c.json({
    data,
    meta: { current_page: page, last_page: lastPage, per_page: size, total, from: total ? (page - 1) * size + 1 : null, to: total ? Math.min(page * size, total) : null, sort, ...counts },
    links: { first: url(1), last: url(lastPage), prev: page > 1 ? url(page - 1) : null, next: page < lastPage ? url(page + 1) : null },
  });
});

supplyRoutes.post('/supply-requests', role('franchisee', 'admin'), async (c) => {
  const { db } = c.get('deps');
  const input = await readInput(c);
  const { request, warnings } = await W.createRequest(db, c.get('user'), input);
  await audit(c, db, 'supply_request.created', { type: MODEL, id: request.id }, null, request);
  const history = await db.query(`select h.*, ${NAME('h.changed_by_user_id')} as changed_by from supply_request_status_histories h where h.supply_request_id = $1 order by h.id`, [request.id]);
  return ok(c, { ...(await fullRow(db, request.id)), status_history: history, warnings }, request.status === 'draft' ? 'Draft saved.' : 'Supply request submitted.', 201);
});

/** Earliest date, suggestions and warnings for the request form, without saving. */
supplyRoutes.post('/supply-requests/check', role('franchisee', 'admin'), async (c) => {
  const { db } = c.get('deps');
  const input = await readInput(c);
  const checked = await W.checkRequest(db, c.get('user'), input);
  return ok(c, { warnings: checked.warnings, earliest_date: checked.earliest_date, target_delivery_date: checked.fields.target_delivery_date, items: checked.items });
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
       coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('proposed_by', ${NAME('r.proposed_by_user_id')}) order by r.id) from supply_request_date_revisions r where r.supply_request_id = sr.id), '[]'::jsonb) as date_revisions,
       coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object('reported_by', ${NAME('s.reported_by_user_id')}) order by s.id) from supply_shortage_reports s where s.supply_request_id = sr.id), '[]'::jsonb) as shortage_reports,
       coalesce((select jsonb_agg(to_jsonb(rv) order by rv.id) from supply_reservations rv where rv.supply_request_id = sr.id), '[]'::jsonb) as reservations,
       coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'request_number', b.request_number, 'status', b.status) order by b.id) from supply_requests b where b.parent_request_id = sr.id), '[]'::jsonb) as backorders,
       coalesce((select jsonb_agg(to_jsonb(doc) order by doc.id) from documents doc where doc.documentable_type = '${MODEL}' and doc.documentable_id = sr.id and doc.removed_at is null), '[]'::jsonb) as documents,
       ${SLA('sr')}
     from supply_requests sr where sr.id = $1`, [sr.id],
  );
  const availability = await W.availabilityOf(db, sr);
  const groups = new Map<number, Row>();
  const categories = await db.query(`select p.id as product_id, p.category_id, p.name, p.unit, (select pc.name from product_categories pc where pc.id = p.category_id) as category_name from supply_request_items si join products p on p.id = si.product_id where si.supply_request_id = $1 order by si.id`, [sr.id]);
  for (const item of row.items) {
    const product = categories.find((x) => x.product_id === item.product_id);
    const line = availability.find((i) => i.item_id === item.id)!;
    const id = product?.category_id ?? 0;
    if (!groups.has(id)) groups.set(id, { category_id: id || null, category_name: product?.category_name ?? 'Uncategorized', lines: [] });
    groups.get(id)!.lines.push({ item_id: item.id, product_id: item.product_id, product_name: product?.name, unit: product?.unit, requested: Number(item.quantity_requested), warehouse_stock: line.warehouse_free, shortage: line.unavailable, short: line.unavailable > 0 });
  }
  const histories = await db.query(`select h.*, ${NAME('h.changed_by_user_id')} as changed_by from supply_request_status_histories h where h.supply_request_id = $1 order by h.id`, [sr.id]);
  const staff = ['admin', 'logistics'].includes(roleName(c));
  // What left the warehouse: the dispatch record, or the Preparing record of the previous workflow.
  const dispatched = [...histories].reverse().find((h) => h.action === 'dispatched' && Array.isArray(h.payload?.stock));
  const legacy = histories.find((h) => h.to_status === 'preparing' && Array.isArray(h.payload));
  const lines = dispatched ? dispatched.payload.stock : legacy ? legacy.payload : null;
  let stockSnapshot = null;
  if (lines && staff) {
    const [warehouse] = await db.query(`select id from franchise_locations where type = 'warehouse' and is_active = true order by id limit 1`);
    const now = new Map((await db.query(`select product_id, current_stock from inventories where location_id = $1`, [warehouse?.id ?? 0])).map((r) => [r.product_id, Number(r.current_stock)]));
    stockSnapshot = lines.map((line: Row) => {
      const productId = Number(line.product_id ?? 0);
      const p = categories.find((x) => x.product_id === productId);
      return { product_id: productId, product_name: p?.name ?? null, unit: p?.unit ?? null, stock_before: Number(line.stock_before ?? 0), deducted: Number(line.quantity_deducted ?? 0), stock_after: Number(line.stock_after ?? 0), stock_now: now.get(productId) ?? 0 };
    });
  }
  const sla = withWorkflow(row);
  const d = row.delivery;
  const others = await db.query(
    `select id, request_number, status, target_delivery_date from supply_requests where location_id = $1 and id <> $2 and status in (${S.sqlList(S.SUBMITTED_OPEN)}) order by id desc limit 20`, [sr.location_id, sr.id],
  );
  const [parent] = sr.parent_request_id ? await db.query(`select id, request_number, status from supply_requests where id = $1`, [sr.parent_request_id]) : [];
  const short = availability.some((l) => l.unavailable > 0);
  const payload: Row = {
    ...sla,
    effective_delivery_date: effectiveDate(row, row.date_revisions),
    pending_date_revision: row.date_revisions.filter((r: Row) => r.status === 'pending').pop() ?? null,
    pending_shortage_report: row.shortage_reports.filter((r: Row) => r.status === 'pending').pop() ?? null,
    line_groups: [...groups.values()],
    availability,
    can_endorse: sr.status === 'under_review' && !short,
    endorse_block_reason: sr.status !== 'under_review' ? 'Only a request under review can be endorsed.' : short ? 'Stock is short; choose a Fulfillment Decision.' : null,
    stock_snapshot: stockSnapshot,
    other_open_requests: others,
    parent: parent ?? null,
    delivery_receipt: await W.deliveryReceipt(db, sr.id),
    delivery_confirmation: d?.pod_encoded_at || d?.delivered_at ? {
      confirmed_by_type: d.confirmed_by_party, confirmed_by_user_id: d.pod_encoded_by_user_id ?? d.delivered_by_user_id, confirmed_at: iso(d.actual_delivered_at) ?? iso(d.acknowledged_at) ?? iso(d.delivered_at), recipient_name: d.recipient_name, note: d.notes,
    } : null,
    status_history: histories.map((h) => ({
      from: h.from_status, to: h.to_status, action: h.action, actor_role: h.actor_role, actor_user_id: h.changed_by_user_id, actor: h.changed_by, at: iso(h.created_at), document_id: h.document_id,
      remarks: h.remarks, ...(staff ? { details: h.payload } : {}),
    })),
  };
  if (!staff) delete payload.reservations;
  if (staff) {
    payload.review_lines = await W.reviewLines(db, sr);
    payload.stock_check = ['under_review', 'on_hold'].includes(sr.status) ? {
      sufficient: !short,
      lines: availability.map((i) => ({ item_id: i.item_id, product_name: i.name, required: i.requested, available: i.warehouse_free, shortage: i.unavailable })),
    } : null;
  }
  return ok(c, payload);
});

supplyRoutes.get('/supply-requests/:supplyRequest/availability', role('admin', 'logistics'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const items = await W.availabilityOf(db, sr);
  return ok(c, {
    items: items.map((i) => ({ ...i, product_name: i.name, warehouse_stock: i.warehouse_free, available: i.unavailable === 0, available_quantity: i.available, shortage: i.unavailable })),
    all_available: items.every((i) => i.unavailable === 0),
  });
});

supplyRoutes.put('/supply-requests/:supplyRequest', role('franchisee', 'admin'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const input = await readInput(c);
  const { warnings } = await W.updateRequest(db, c.get('user'), sr.id, input);
  await audit(c, db, 'supply_request.updated', { type: MODEL, id: sr.id }, sr, input);
  return ok(c, { ...(await fullRow(db, sr.id)), warnings }, 'Supply request updated.');
});

// ---- actions ----
type Action = (db: Db, actor: Row, id: number, input: Row) => Promise<unknown>;
const ACTIONS: Record<string, { roles: string[]; run: Action; message: string }> = {
  submit: { roles: ['franchisee', 'admin'], run: (db, a, id) => W.submitRequest(db, a, id), message: 'Supply request submitted.' },
  cancel: { roles: ['franchisee', 'admin'], run: (db, a, id, i) => W.cancelRequest(db, a, id, i.reason), message: 'Supply request cancelled.' },
  'start-review': { roles: ['admin'], run: (db, a, id) => W.startReview(db, a, id), message: 'Review started.' },
  return: { roles: ['admin'], run: (db, a, id, i) => W.returnRequest(db, a, id, i.reason), message: 'Returned to the branch for correction.' },
  reject: { roles: ['admin'], run: (db, a, id, i) => W.rejectRequest(db, a, id, i.reason), message: 'Supply request rejected.' },
  endorse: { roles: ['admin'], run: (db, a, id) => W.endorseFull(db, a, id), message: 'Endorsed – Full and sent to Logistics.' },
  fulfillment: { roles: ['admin'], run: (db, a, id, i) => W.decideFulfillment(db, a, id, i), message: 'Fulfillment decision saved.' },
  resume: { roles: ['admin'], run: (db, a, id) => W.resumeRequest(db, a, id), message: 'Resumed and sent to Logistics.' },
  'restock-date': { roles: ['admin'], run: (db, a, id, i) => W.updateRestockDate(db, a, id, i), message: 'Restock date updated.' },
  'accept-schedule': { roles: ['logistics'], run: (db, a, id) => W.acceptSchedule(db, a, id), message: 'Schedule accepted.' },
  'date-change': { roles: ['logistics'], run: (db, a, id, i) => W.requestDateChange(db, a, id, i), message: 'New delivery date sent to Admin.' },
  'date-change/decide': { roles: ['admin'], run: (db, a, id, i) => W.decideDateChange(db, a, id, i), message: 'Date change decided.' },
  shortage: { roles: ['logistics'], run: (db, a, id, i) => W.reportShortage(db, a, id, i), message: 'Shortage reported to Admin.' },
  prepare: { roles: ['logistics'], run: (db, a, id) => W.startPreparing(db, a, id), message: 'Preparing started.' },
  dispatch: { roles: ['logistics'], run: (db, a, id, i) => W.dispatchRequest(db, a, id, i), message: 'Dispatched.' },
  'discrepancy/resolve': { roles: ['admin'], run: (db, a, id, i) => W.resolveDiscrepancy(db, a, id, i), message: 'Discrepancy resolved.' },
};

/** What a Fulfillment Decision would do (the backorder preview); nothing is saved. */
supplyRoutes.post('/supply-requests/:supplyRequest/fulfillment/preview', role('admin'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  return ok(c, await W.previewFulfillment(db, c.get('user'), sr.id, await readInput(c)));
});

/** The Delivery Receipt (print) once the request is dispatched. */
supplyRoutes.get('/supply-requests/:supplyRequest/delivery-receipt', viewers, async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const receipt = await W.deliveryReceipt(db, sr.id);
  if (!receipt) fail('status', 'The Delivery Receipt is available after dispatch.');
  return ok(c, receipt);
});

for (const [path, action] of Object.entries(ACTIONS)) {
  supplyRoutes.post(`/supply-requests/:supplyRequest/${path}`, role(...action.roles), async (c) => {
    const { db } = c.get('deps');
    const sr = await load(c);
    await assertAccess(c, db, sr);
    const input = await readInput(c);
    const result = await action.run(db, c.get('user'), sr.id, input) as Row;
    const [after] = await db.query(`select status from supply_requests where id = $1`, [sr.id]);
    await audit(c, db, `supply_request.${path.replace(/[/-]/g, '_')}`, { type: MODEL, id: sr.id }, { status: sr.status }, { status: after.status, input });
    return ok(c, { ...(await fullRow(db, sr.id)), result: result ?? null, warnings: (result as Row)?.warnings ?? [] }, action.message);
  });
}

/** Kept so an older client can still start a review; it is the start-review action. */
supplyRoutes.post('/supply-requests/:supplyRequest/review', role('admin'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  if (sr.status !== 'submitted') return ok(c, await fullRow(db, sr.id), 'Supply request already reviewed.');
  await W.startReview(db, c.get('user'), sr.id);
  await audit(c, db, 'supply_request.reviewed', { type: MODEL, id: sr.id }, { status: 'submitted' }, { status: 'under_review' });
  return ok(c, await fullRow(db, sr.id), 'Supply request marked as under review.');
});

const RETIRED = 'This action moved to the new supply workflow. Use the action endpoints (start-review, endorse, fulfillment, accept-schedule, prepare, dispatch, pod, receipt).';
supplyRoutes.patch('/supply-requests/:supplyRequest/status', viewers, (c) => c.json({ message: RETIRED, errors: { status: [RETIRED] } }, 422));
supplyRoutes.post('/supply-requests/:supplyRequest/date-revision', role('admin'), (c) => c.json({ message: RETIRED, errors: { status: [RETIRED] } }, 422));
supplyRoutes.post('/supply-requests/:supplyRequest/date-revision/confirm', role('logistics'), (c) => c.json({ message: RETIRED, errors: { status: [RETIRED] } }, 422));

/** POD by Logistics: photo or signature, who received it and when. */
supplyRoutes.post('/supply-requests/:supplyRequest/pod', role('logistics'), async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const v = await validate(db, await readInput(c), {
    file: ['required', 'file', 'mimes:pdf,jpg,jpeg,png', `max:${MAX_UPLOAD_KB}`], received_by: ['required', 'string', 'max:255'], actual_delivered_at: ['required', 'date'], notes: ['nullable', 'string'],
  });
  if (sr.status !== 'dispatched') fail('status', `The POD is encoded after dispatch. (The request is ${S.LABELS[sr.status] ?? sr.status}.)`);
  const [delivery] = await db.query(`select * from deliveries where supply_request_id = $1`, [sr.id]);
  if (!delivery) fail('status', 'This request has no dispatch record.');
  if (delivery.pod_encoded_at) fail('status', 'The POD is already encoded.');
  const document = await storeDocument(c, db, v.file, `supply-requests/${sr.id}/pod`, { type: DELIVERY, id: delivery.id }, 'proof_of_delivery');
  if (v.notes) await updateRow(db, 'deliveries', delivery.id, { notes: v.notes });
  await W.encodePod(db, c.get('user'), sr.id, { received_by: v.received_by, actual_delivered_at: v.actual_delivered_at, document_id: document.id });
  await audit(c, db, 'delivery.pod_uploaded', { type: DELIVERY, id: delivery.id }, null, { document_id: document.id });
  return ok(c, { ...(await fullRow(db, sr.id)), document }, 'Proof of delivery saved.', 201);
});

/**
 * Confirm Receipt by the branch. Multipart: `lines` (JSON: item_id, good, damaged, short, damage_reason,
 * short_reason) and one photo per damaged item as `photo_<item_id>`. Only the good quantity is credited.
 */
const confirmReceiptRoute = async (c: Context<AppEnv>) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const input = await readInput(c);
  let lines: Row[] = input.lines;
  if (typeof lines === 'string') {
    try { lines = JSON.parse(lines); } catch { fail('lines', 'The receipt lines are not valid.'); }
  }
  if (!Array.isArray(lines)) fail('lines', 'Enter the received quantities.');
  if (!S.IN_TRANSIT.includes(sr.status) || sr.branch_received_at) fail('status', 'This delivery cannot be confirmed now.');
  for (const [index, line] of lines.entries()) {
    const file = input[`photo_${Number(line?.item_id)}`];
    if (!file || Number(line?.damaged ?? 0) <= 0) continue;
    await validate(db, { photo: file }, { photo: ['file', 'mimes:jpg,jpeg,png,webp', `max:${MAX_UPLOAD_KB}`] }).catch(() => fail(`lines.${index}.photo`, 'The damage photo must be a JPG, PNG or WebP image.'));
    const doc = await storeDocument(c, db, file as File, `supply-requests/${sr.id}/receipt`, { type: MODEL, id: sr.id }, 'receipt_damage_photo', { item_id: Number(line.item_id) });
    line.photo_document_id = doc.id;
  }
  await W.confirmReceipt(db, c.get('user'), sr.id, { lines });
  await audit(c, db, 'supply_request.receipt_confirmed', { type: MODEL, id: sr.id }, { status: sr.status }, { lines });
  return ok(c, await fullRow(db, sr.id), 'Receipt confirmed.');
};
supplyRoutes.post('/supply-requests/:supplyRequest/receipt', role('franchisee'), confirmReceiptRoute);
/** The existing acknowledge endpoint, extended: it is the same per-item Confirm Receipt. */
supplyRoutes.post('/supply-requests/:supplyRequest/acknowledge', role('franchisee'), confirmReceiptRoute);


supplyRoutes.get('/supply-requests/:supplyRequest/documents/:document/download', viewers, async (c) => {
  const { db } = c.get('deps');
  const sr = await load(c);
  await assertAccess(c, db, sr);
  const [delivery] = await db.query(`select id from deliveries where supply_request_id = $1`, [sr.id]);
  const [document] = await db.query(
    `select * from documents where id = $1 and ((documentable_type = $2 and documentable_id = $3) or (documentable_type = $4 and documentable_id = $5))`,
    [routeId(c, 'document'), DELIVERY, delivery?.id ?? 0, MODEL, sr.id],
  );
  return downloadDocument(c, requireFound(document));
});
