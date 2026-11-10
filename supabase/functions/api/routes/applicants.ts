// ApplicantController.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, fail, Filter, insertRow, intParam, manilaToday, ok, paginate, perPage, pick, routeId, updateRow } from '../lib/http.ts';
import { readInput, validate, validateEach } from '../lib/validate.ts';
import { downloadDocument, MAX_UPLOAD_KB, storeDocument } from '../lib/files.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit, assignPublicCode, createAccount, publicUser } from '../services/users.ts';
import { notifyRoles, notifyUser } from '../services/notifications.ts';
import { applyRecordSearch } from '../services/recordSearch.ts';
import { provisionBranch } from '../services/branchAccess.ts';
import { renameParticipantName } from '../services/scheduleNames.ts';
import {
  APPLICANT_MODEL, applicantJson, hasVerifiedInitialPayment, isPaymentFullyDiscounted, loadApplicant, loadPlan, milestoneState, MILESTONES, PAYMENT_INITIAL_PERCENT, paymentPercent,
  QUALIFICATION_KEYS, REQUIRED_MILESTONES, verifiedPaymentTotal,
} from '../services/applicantModel.ts';
import {
  ACTIVITY_ORDER, activityDone, activityDoneState, activityLabel, assertLoiCompletable, assertLoiProceedable, assertQualificationChecked, assertTransition, LOI_PENDING_BLOCK, loiPending,
  qualificationChecked, scheduledChecked, STAGE_ORDER, stageLabel, statusLabel, TRACKED_ACTIVITY_MILESTONES,
} from '../services/pipeline.ts';
import { fileRef, logEvent, logStageChange, transition } from '../services/applicantStage.ts';
import { activeSalesUser, assertAssignedSales, notifyAssignedSales, optionalReason, requireReason } from '../services/accountability.ts';
import {
  assertBrandUnlocked, BRAND_METHODS, brandState, latestBrandConfirmation, retastingDone, tastedBrandId,
} from '../services/brandConfirmation.ts';
import * as payments from '../services/paymentStage.ts';
import { assertNoSessionOfOtherBrand, sessionsFor, syncApplicantAttendance } from '../services/scheduleHooks.ts';
import { forgetActivity, releaseCompletedTastingKeys } from '../services/schedule/sync.ts';
import { assertStageRequirements, loiRequirement } from '../services/requirements.ts';
import { OFF_MESSAGE, paymentAdvanced, recordPayload, setAgreedAmount } from '../services/paymentRecord.ts';
import { applicantMonitor, applyDateRange, createFollowUp, deliverDueReminders, followUpsOf, STAGE_DAYS_SQL } from '../services/monitoring.ts';
import { applicantHistory, REPORT_PAGES } from '../services/applicationDetail.ts';
import { canSeeRequirementFiles, requirementsPayload } from './requirements.ts';
import { accountAuditValues, cleanOptionalPhone, issueInitialCredentials } from '../services/credentials.ts';

export const applicantRoutes = new Hono<AppEnv>();

const PAYMENT_MODEL = 'App\\Models\\Payment';
const PAYMENT_TYPE_VALUES = 'downpayment,installment_payment,full_payment,initial_franchise_fee,fully_paid,installment';
const LEAD_CODE_SQL = '(select fi.lead_code from franchise_inquiries fi where fi.id = applicants.inquiry_id)';
const STATUSES = 'converted,qualified,scheduled,loi_submitted,payment_submitted,for_approval,approved,rejected,active_franchisee';
const viewers = role('admin', 'sales', 'franchisee');
const admin = role('admin');
const sales = role('sales');

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
/** The date bases of the applicant filters. */
const DATE_BASIS = (alias: string) => ({ applied: `${alias}.application_date`, approved: `${alias}.approved_at`, rejected: `${alias}.rejected_at`, updated: `${alias}.updated_at` });
const NAME = (expr: string) => `(select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = ${expr})`;
const HISTORY = (id: string) => `coalesce((select jsonb_agg(to_jsonb(h) || jsonb_build_object('changed_by', ${NAME('h.changed_by_user_id')}) order by h.id)
  from applicant_status_histories h where h.applicant_id = ${id}), '[]'::jsonb)`;

function authorize(c: Context<AppEnv>, a: Row, staffOnly = false) {
  const name = roleName(c);
  if (name === 'sales' && a.archived_at) abort(404, 'Record not found.');
  if (name === 'franchisee' && (staffOnly || a.user_id !== c.get('user').id)) abort(403, 'You cannot access this applicant record.');
}
const requireRole = (c: Context<AppEnv>, roles: string[]) => {
  if (!roles.includes(roleName(c))) abort(403, 'Your role is not allowed to perform this action.');
};
const load = async (c: Context<AppEnv>): Promise<Row> =>
  requireFound((await c.get('deps').db.query(`select * from applicants where id = $1`, [routeId(c, 'applicant')]))[0]);
const fresh = async (db: Db, id: number) => applicantJson((await db.query(`select * from applicants where id = $1`, [id]))[0]);
const freshWithHistory = async (db: Db, id: number) => applicantJson((await db.query(`select a.*, ${HISTORY('a.id')} as status_history from applicants a where a.id = $1`, [id]))[0]);
const leadReference = (row: Row) => (row.inquiry_id && row.inquiry ? { id: row.inquiry.id, lead_code: row.inquiry.lead_code } : null);

async function unreadApplicantIds(db: Db, userId: number, type: string): Promise<Set<number>> {
  const rows = await db.query(`select data from system_notifications where user_id = $1 and read_at is null and type = $2`, [userId, type]);
  return new Set(rows.map((r) => Number(r.data?.applicant_id ?? 0)).filter(Boolean));
}

function paymentRequestDetails(p: Row | null | undefined) {
  if (!p) return null;
  return {
    id: p.id, department: p.department, paid_date: p.payment_date, requested_at: iso(p.requested_at), remarks: p.remarks,
    payment_type: p.payment_type, amount: Number(p.amount), payment_method: p.payment_method, status: p.status,
    documents: p.documents ?? [],
  };
}
const PAYMENT_DOCS = (id: string) => `coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'original_name', d.original_name) order by d.id) from documents d
  where d.documentable_type = 'App\\Models\\Payment' and d.documentable_id = ${id}), '[]'::jsonb)`;

// ---- lists ----
applicantRoutes.get('/applicants', viewers, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const user = c.get('user');
  const name = roleName(c);
  const f = new Filter();
  await deliverDueReminders(db, user);
  if (name === 'franchisee') f.add('applicants.user_id = ?', user.id);
  applyDateRange(f, q, DATE_BASIS('applicants'), 'applied');
  if (boolParam(q.archived)) {
    requireRole(c, ['admin']);
    f.add('applicants.archived_at is not null');
  } else {
    f.add('applicants.archived_at is null');
    if (name !== 'franchisee') f.add(`applicants.status not in ('active_franchisee', 'rejected')`);
  }
  if (q.status) f.add('applicants.status = ?', q.status);
  if (boolParam(q.eligible_for_scheduling)) f.add(`applicants.status = 'scheduled'`);
  if (q.brand_id) f.add('applicants.preferred_brand_id = ?', intParam(q.brand_id));
  if (q.assigned_sales_user_id === 'unassigned') f.add('applicants.assigned_sales_user_id is null');
  else if (q.assigned_sales_user_id) f.add('applicants.assigned_sales_user_id = ?', intParam(q.assigned_sales_user_id));
  const ranked = applyRecordSearch(f, q.search, ['applicants.applicant_code', LEAD_CODE_SQL], ['applicants.full_name', 'applicants.email'], ['applicants.phone']);

  const page = await paginate(c, db, {
    columns: `applicants.*, (select to_jsonb(b) from brands b where b.id = applicants.preferred_brand_id) as preferred_brand,
      ${NAME('applicants.assigned_sales_user_id')} as assigned_sales,
      ${STAGE_DAYS_SQL('applicants')} as days_in_stage,
      (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'role_id', u.role_id, 'role', (select to_jsonb(r) from roles r where r.id = u.role_id)) from users u where u.id = applicants.user_id) as "user",
      (select jsonb_build_object('id', fi.id, 'source', fi.source, 'converted_from_status', fi.converted_from_status, 'lead_code', fi.lead_code) from franchise_inquiries fi where fi.id = applicants.inquiry_id) as inquiry,
      (select count(*)::int from applicants seq where seq.archived_at is null ${name === 'franchisee' ? 'and seq.user_id = ?' : ''} and seq.id <= applicants.id) as display_no`,
    columnParams: name === 'franchisee' ? [user.id] : [],
    from: 'applicants', where: f.clauses, params: f.params,
    orderBy: [ranked?.orderBy, 'applicants.application_date desc nulls last'].filter(Boolean).join(', '),
    orderParams: ranked?.orderParams ?? [],
    perPage: perPage(c, 20),
  });
  const body = await page.json();
  const canSeePayments = ['admin', 'sales'].includes(name);
  const ids = `{${body.data.map((a: Row) => a.id).join(',')}}`;
  const pendingSchedules = canSeePayments
    ? new Set((await db.query(`select applicant_id from activity_schedules where applicant_id = any($1::bigint[]) and approval_status = 'pending_admin'`, [ids])).map((r) => r.applicant_id))
    : new Set();
  const paymentRows = canSeePayments
    ? await db.query(`select p.*, ${PAYMENT_DOCS('p.id')} as documents from payments p where p.applicant_id = any($1::bigint[]) order by p.id desc`, [ids])
    : [];
  const assessment = name === 'sales' ? await unreadApplicantIds(db, user.id, 'assessment_pending') : null;
  const activity = name === 'admin' ? await unreadApplicantIds(db, user.id, 'applicant_activity_completed') : null;

  const data = [];
  for (const row of body.data) {
    const out: Row = { ...applicantJson(row), status_label: await statusLabel(db, row), lead: leadReference(row), ...applicantMonitor(row) };
    if (canSeePayments) {
      const own = paymentRows.filter((p) => p.applicant_id === row.id);
      out.has_pending_schedule_update = pendingSchedules.has(row.id);
      out.has_pending_payment_request = own.some((p) => p.status === 'pending');
      out.payment_request = paymentRequestDetails(own[0]);
      out.payment_confirmed = row.payment_confirmed_at !== null;
    }
    if (assessment) out.has_assessment_request = assessment.has(row.id);
    if (activity) out.has_activity_update = activity.has(row.id);
    data.push(out);
  }
  return c.json({ ...body, data });
});

/** Active Sales accounts, for the Admin pickers (convert, reassign). */
applicantRoutes.get('/applicants/sales-users', admin, async (c) => {
  const { db } = c.get('deps');
  const rows = await db.query(
    `select u.id, u.full_name, u.email, u.user_code,
       (select count(*)::int from applicants a where a.assigned_sales_user_id = u.id and a.archived_at is null and a.status not in ('active_franchisee', 'rejected')) as open_applicants
     from users u join roles r on r.id = u.role_id where r.name = 'sales' and u.account_status = 'active' and u.archived_at is null order by u.full_name`,
  );
  return ok(c, rows);
});

applicantRoutes.post('/applicants/:applicant/follow-ups', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  if (roleName(c) !== 'sales') abort(403, 'The assigned Sales user logs the follow-ups of an applicant.');
  await assertAssignedSales(c, a);
  if (a.archived_at || ['active_franchisee', 'rejected'].includes(a.status)) fail('applicant', 'A closed or archived applicant takes no follow-ups.');
  const user = c.get('user');
  const row = await db.tx(async (tx) => {
    const saved = await createFollowUp(tx, 'applicant', a.id, user, await readInput(c));
    await logEvent(tx, a, 'follow_up_logged', user.id, { follow_up_id: saved.id }, saved.notes, {
      step: 'follow_up', new_values: { channel: saved.channel, outcome: saved.outcome, contacted_at: iso(saved.contacted_at), next_follow_up_at: iso(saved.next_follow_up_at) },
    });
    return saved;
  });
  return ok(c, { follow_up: row, follow_ups: await followUpsOf(db, 'applicant', a.id) }, 'Follow-up logged.', 201);
});

applicantRoutes.get('/applicants/active-franchisees', viewers, async (c) => {
  const { db } = c.get('deps');
  if (roleName(c) === 'franchisee') abort(403, 'You cannot access this list.');
  const q = c.req.query();
  const f = new Filter();
  f.add(`a.archived_at is null and a.status = 'active_franchisee'`);
  if (q.status) f.add(`(exists (select 1 from franchisees x where x.applicant_id = a.id and x.franchise_status = ?)${q.status === 'active' ? ' or not exists (select 1 from franchisees x where x.applicant_id = a.id)' : ''})`, q.status);
  if (q.search) {
    const t = `%${q.search}%`;
    f.add(`(a.full_name ilike ? or a.applicant_code ilike ? or (select fi.lead_code from franchise_inquiries fi where fi.id = a.inquiry_id) ilike ?
      or exists (select 1 from franchisees x where x.applicant_id = a.id and x.business_name ilike ?) or a.email ilike ?)`, t, t, t, t, t);
  }
  return paginate(c, db, {
    columns: `a.*, (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = a.preferred_brand_id) as brand,
      (select fi.lead_code from franchise_inquiries fi where fi.id = a.inquiry_id) as lead_code,
      (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'role_id', u.role_id, 'role', (select to_jsonb(r) from roles r where r.id = u.role_id)) from users u where u.id = a.user_id) as portal_user,
      (select to_jsonb(x) || jsonb_build_object('locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'franchisee_id', l.franchisee_id, 'name', l.name, 'city', l.city, 'province', l.province, 'is_active', l.is_active) order by l.id) from franchise_locations l where l.franchisee_id = x.id), '[]'::jsonb))
       from franchisees x where x.applicant_id = a.id limit 1) as franchisee`,
    from: 'applicants a', where: f.clauses, params: f.params, orderBy: 'a.approved_at desc nulls last, a.id desc', perPage: perPage(c, 20),
    map: (a) => ({
      id: a.franchisee?.id ?? null,
      applicant_id: a.id,
      business_name: a.franchisee?.business_name ?? a.full_name,
      franchise_status: a.franchisee?.franchise_status ?? 'active',
      approval_date: a.franchisee?.approval_date ?? a.approved_at ?? a.application_date,
      applicant: {
        id: a.id, applicant_code: a.applicant_code, lead: a.inquiry_id && a.lead_code ? { id: a.inquiry_id, lead_code: a.lead_code } : null,
        full_name: a.full_name, email: a.email, phone: a.phone, status: a.status, preferred_brand: a.brand,
      },
      user: a.user_id ? a.portal_user : null,
      has_portal_account: a.user_id !== null && a.portal_user?.role?.name === 'franchisee',
      locations: a.franchisee?.locations ?? [],
    }),
  });
});

applicantRoutes.get('/applicants/application-detail', viewers, async (c) => {
  const { db } = c.get('deps');
  if (roleName(c) === 'franchisee') abort(403, 'You cannot access this list.');
  const v = await validate(db, c.req.query(), { folder: ['nullable', 'in:active,approved,rejected'] });
  const folder = v.folder ?? 'approved';
  const search = c.req.query('search');
  const q = c.req.query();

  const filterFor = (name: string) => {
    const f = new Filter();
    if (name === 'active') f.add(`a.archived_at is null and a.status in ('converted','qualified','scheduled','loi_submitted','payment_submitted','for_approval')`);
    if (name === 'approved') f.add(`(a.archived_at is null or a.status = 'active_franchisee') and a.status in ('approved','active_franchisee')`);
    if (name === 'rejected') f.add(`a.status = 'rejected'`);
    applyDateRange(f, q, DATE_BASIS('a'), name === 'approved' ? 'approved' : name === 'rejected' ? 'rejected' : 'applied');
    if (q.status) f.add('a.status = ?', q.status);
    if (q.brand_id) f.add('a.preferred_brand_id = ?', intParam(q.brand_id));
    if (q.assigned_sales_user_id === 'unassigned') f.add('a.assigned_sales_user_id is null');
    else if (q.assigned_sales_user_id) f.add('a.assigned_sales_user_id = ?', intParam(q.assigned_sales_user_id));
    if (search) {
      const t = `%${search}%`;
      f.add(`(a.full_name ilike ? or a.email ilike ? or a.applicant_code ilike ? or (select fi.lead_code from franchise_inquiries fi where fi.id = a.inquiry_id) ilike ?
        or exists (select 1 from franchisees x where x.applicant_id = a.id and x.business_name ilike ?))`, t, t, t, t, t);
    }
    return f;
  };
  const f = filterFor(folder);
  const order: Row = { active: 'a.updated_at desc nulls last', approved: 'a.approved_at desc nulls last', rejected: 'a.rejected_at desc nulls last' };
  const page = await paginate(c, db, {
    columns: `a.*, (select b.name from brands b where b.id = a.preferred_brand_id) as brand_name, ${STAGE_DAYS_SQL('a')} as days_in_stage,
      (select fi.lead_code from franchise_inquiries fi where fi.id = a.inquiry_id) as lead_code,
      ${NAME('a.assigned_sales_user_id')} as assigned_sales,
      (select x.business_name from franchisees x where x.applicant_id = a.id limit 1) as business_name,
      (select l.name from franchisees x join franchise_locations l on l.franchisee_id = x.id where x.applicant_id = a.id order by l.id limit 1) as location_name,
      (select to_jsonb(p) from applicant_payment_plans p where p.applicant_id = a.id limit 1) as plan,
      (select jsonb_build_object('remarks', h.remarks, 'created_at', h.created_at, 'by', (select u.full_name from users u where u.id = h.changed_by_user_id))
       from applicant_status_histories h where h.applicant_id = a.id and h.to_status = 'rejected' order by h.id desc limit 1) as rejection`,
    from: 'applicants a', where: f.clauses, params: f.params, orderBy: `${order[folder]}, a.id desc`, perPage: perPage(c, 15),
  });
  const body = await page.json();
  const steps = STAGE_ORDER.filter((s) => s !== 'active_franchisee');
  const data = [];
  for (const a of body.data) {
    const stepIndex = steps.indexOf(a.status);
    const required = Number(a.plan?.total_required_amount ?? a.total_required_amount ?? 0);
    const business = a.business_name && a.business_name.trim().toLowerCase() !== a.full_name.trim().toLowerCase() ? a.business_name : null;
    const rejection = a.status === 'rejected' ? a.rejection : null;
    data.push({
      id: a.id, applicant_code: a.applicant_code, lead: a.inquiry_id && a.lead_code ? { id: a.inquiry_id, lead_code: a.lead_code } : null,
      full_name: a.full_name, email: a.email, phone: a.phone, status: a.status, status_label: stageLabel(a.status),
      assigned_sales: a.assigned_sales ?? null,
      ...applicantMonitor(a),
      rejected_on: a.rejected_at ? iso(a.rejected_at) : null,
      business_name: business, location: a.location_name, brand: a.brand_name, application_date: a.application_date,
      approved_at: iso(a.approved_at), updated_at: iso(a.updated_at), step: stepIndex < 0 ? null : stepIndex + 1, step_total: steps.length,
      payment_percent: await paymentPercent(db, a),
      payment_required_amount: required > 0 ? required : null,
      payment_plan: a.plan ? {
        package_name: a.plan.package_name,
        total_required_amount: a.plan.total_required_amount !== null ? Number(a.plan.total_required_amount) : null,
        original_total_required_amount: a.plan.total_required_original_amount !== null ? Number(a.plan.total_required_original_amount) : null,
        discount_percent: Number(a.plan.total_required_discount_percent ?? 0),
        promo_name: a.plan.promo_name,
      } : null,
      rejected_at: iso(a.rejected_at) ?? iso(rejection?.created_at),
      rejected_by: rejection?.by ?? null,
      rejection_remarks: rejection?.remarks ?? null,
    });
  }
  const counts: Row = {};
  for (const name of ['active', 'approved', 'rejected']) {
    const g = filterFor(name);
    counts[name] = (await db.query(`select count(*)::int as n from applicants a ${g.where}`, g.params))[0].n;
  }
  return c.json({ ...body, data, meta: { ...body.meta, folder, folder_counts: counts } });
});

applicantRoutes.get('/applicants/by-code/:code', viewers, async (c) => {
  const { db } = c.get('deps');
  const [a] = await db.query(`select * from applicants where lower(applicant_code) = $1`, [c.req.param('code')!.trim().toLowerCase()]);
  requireFound(a);
  authorize(c, a);
  const [inquiry] = a.inquiry_id ? await db.query(`select id, lead_code from franchise_inquiries where id = $1`, [a.inquiry_id]) : [];
  return ok(c, { id: a.id, applicant_code: a.applicant_code, full_name: a.full_name, status: a.status, archived: a.archived_at !== null, lead: inquiry ?? null });
});

// ---- schedule state ----
async function scheduleState(db: Db, a: Row): Promise<Row> {
  const milestones = a.milestones ?? {};
  const done = await activityDoneState(db, a);
  const schedules = await db.query(`select * from activity_schedules where applicant_id = $1 order by id desc`, [a.id]);
  const now = Date.now();
  const state: Row = {};
  for (const [type, key] of Object.entries(TRACKED_ACTIVITY_MILESTONES)) {
    const rows = schedules.filter((s) => s.activity_type === type);
    const attended = Boolean(milestones[key]);
    const liveRows = rows.filter((s) => ['pending', 'confirmed'].includes(s.status) && s.approval_status !== 'rejected');
    const live = liveRows[0];
    const counted = rows.filter((s) => s.approval_status !== 'rejected' && !['cancelled', 'no_show'].includes(s.status));
    const completedRows = rows.filter((s) => s.status === 'completed');
    let name = 'not_scheduled';
    if (counted.some((s) => ['pending', 'confirmed'].includes(s.status) && s.approval_status === 'pending_admin')) name = 'pending_admin';
    else if (counted.some((s) => ['pending', 'confirmed'].includes(s.status))) name = 'scheduled';
    else if (attended) name = 'attended';
    else if (counted.some((s) => s.status === 'completed')) name = 'completed';
    const liveEnd = live ? (live.ends_at ? new Date(live.ends_at).getTime() : new Date(live.starts_at).getTime() + Number(live.duration_minutes ?? 0) * 60000) : null;
    const latestCompleted = completedRows.map((s) => s.completed_at).filter(Boolean).sort((x, y) => new Date(y).getTime() - new Date(x).getTime())[0];
    state[type] = {
      state: name,
      overdue: liveEnd !== null && live.starts_at ? liveEnd < now : false,
      starts_at: iso(live?.starts_at),
      ends_at: iso(live?.ends_at),
      scheduled: counted.length > 0,
      active: liveRows.length > 0,
      completed_at: latestCompleted ?? null,
      completed: completedRows.length > 0,
      attended,
      done: Boolean(done[type]),
    };
  }
  return { schedule_complete: await scheduledChecked(db, a), activity_state: state };
}

applicantRoutes.get('/applicants/:applicant', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a);
  const user = c.get('user');
  const name = roleName(c);
  const id = a.id;
  const person = (col: string) => NAME(`a.${col}`);
  const [row] = await db.query(
    `select a.*, (select to_jsonb(b) from brands b where b.id = a.preferred_brand_id) as preferred_brand,
       (select to_jsonb(fi) from franchise_inquiries fi where fi.id = a.inquiry_id) as inquiry,
       (select jsonb_build_object('id', u.id, 'full_name', u.full_name, 'email', u.email, 'phone', u.phone) from users u where u.id = a.user_id) as "user",
       (select to_jsonb(p) from applicant_payment_plans p where p.applicant_id = a.id limit 1) as payment_plan,
       ${HISTORY('a.id')} as status_history,
       ${person('assigned_sales_user_id')} as assigned_sales,
       ${person('assigned_sales_by_user_id')} as assigned_sales_by,
       ${person('total_required_set_by_user_id')} as total_set_by,
       ${person('payment_turned_over_by_user_id')} as payment_turned_over_by,
       ${person('payment_returned_by_user_id')} as payment_returned_by,
       (select u.full_name from users u where u.id = a.approved_by_user_id) as approved_by,
       (select to_jsonb(x) || jsonb_build_object('locations', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('brand', (select to_jsonb(b) from brands b where b.id = l.brand_id)) order by l.id) from franchise_locations l where l.franchisee_id = x.id), '[]'::jsonb))
        from franchisees x where x.applicant_id = a.id limit 1) as franchisee
     from applicants a where a.id = $1`,
    [id],
  );
  const schedules = await db.query(
    `select s.*, ${NAME('s.assigned_to_user_id')} as assigned_to, ${NAME('s.completion_submitted_by_user_id')} as completion_submitted_by,
       ${NAME('s.reviewed_by_user_id')} as reviewed_by, (select b.name from brands b where b.id = s.tasted_brand_id) as tasted_brand_name,
       coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'original_name', d.original_name, 'mime_type', d.mime_type, 'created_at', d.created_at, 'replaced_at', d.replaced_at) order by d.id)
         from documents d where d.documentable_type = 'App\\Models\\ActivitySchedule' and d.documentable_id = s.id and d.type = 'attendance_proof'), '[]'::jsonb) as proof_documents
     from activity_schedules s where s.applicant_id = $1 order by s.id`, [id],
  );
  const paymentRows = await db.query(
    `select p.*, coalesce((select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.documentable_type = 'App\\Models\\Payment' and d.documentable_id = p.id), '[]'::jsonb) as documents,
       ${NAME('p.recorded_by_user_id')} as recorded_by, ${NAME('p.verified_by_user_id')} as verified_by, ${NAME('p.received_by_user_id')} as received_by
     from payments p where p.applicant_id = $1 order by p.id`, [id],
  );
  const documents = await db.query(
    `select d.*, ${NAME('d.uploaded_by_user_id')} as uploaded_by, ${NAME('d.removed_by_user_id')} as removed_by,
       case when d.removed_at is not null then 'removed' when d.replaced_at is not null then 'replaced' else 'current' end as file_state
     from documents d where d.documentable_type = $1 and d.documentable_id = $2 order by d.id`, [APPLICANT_MODEL, id],
  );
  const payload: Row = {
    ...applicantJson(row),
    schedules: schedules.map(scheduleJson),
    payments: paymentRows,
    documents,
    milestone_state: milestoneState(a),
    lead: row.inquiry ? { id: row.inquiry.id, lead_code: row.inquiry.lead_code } : null,
    status_label: await statusLabel(db, a),
    ...(await scheduleState(db, a)),
    brand_confirmation: await brandPayload(db, a),
    requirements: name === 'franchisee' ? null : await requirementsPayload(db, a, user),
    follow_ups: name === 'franchisee' ? [] : await followUpsOf(db, 'applicant', id),
    ...(name === 'franchisee' ? {} : applicantMonitor({ ...a, days_in_stage: (await db.query(`select ${STAGE_DAYS_SQL('x')} as d from applicants x where x.id = $1`, [id]))[0].d })),
  };
  if (name !== 'franchisee') payload.schedule_sessions = await sessionsFor(db, id);
  payload.assessment_log = (await db.query(
    `select l.assessment_key, l.is_checked, l.checked_at, (select u.full_name from users u where u.id = l.checked_by_user_id) as checked_by
     from applicant_assessment_logs l where l.applicant_id = $1 order by l.id desc limit 50`, [id],
  )).map((l) => ({ ...l, checked_at: iso(l.checked_at) }));
  if (name === 'sales') payload.has_assessment_request = (await unreadApplicantIds(db, user.id, 'assessment_pending')).has(id);

  if (['admin', 'sales'].includes(name)) {
    const plan = row.payment_plan;
    payload.has_pending_payment_request = paymentRows.some((p) => p.status === 'pending');
    payload.payment_confirmed = a.payment_confirmed_at !== null;
    const latest = paymentRows[paymentRows.length - 1];
    payload.payment_request = paymentRequestDetails(latest && { ...latest, documents: latest.documents.map((d: Row) => ({ id: d.id, original_name: d.original_name })) });
    const required = Number(plan?.total_required_amount ?? a.total_required_amount ?? 0);
    let initial = Number(plan?.initial_payment_amount ?? a.initial_payment_amount ?? 0);
    if (initial <= 0 && required > 0) initial = Math.round(required * PAYMENT_INITIAL_PERCENT) / 100;
    const verified = await verifiedPaymentTotal(db, a, plan);
    payload.payment_summary = {
      package_name: plan?.package_name ?? a.package_name,
      total_required_amount: required,
      initial_payment_amount: initial,
      other_fees: Number(plan?.other_fees ?? a.other_fees ?? 0),
      verified_amount: verified,
      remaining_balance: Math.max(0, required - verified),
      payment_percent: await paymentPercent(db, a),
      payment_terms: plan?.payment_terms ?? null,
    };
    payload.payment_stage = await payments.stagePayload(db, a, user);
    payload.payment_record = await recordPayload(db, a, user, paymentAdvanced(c), canSeeRequirementFiles(user, a));
    if (!paymentAdvanced(c)) {
      // The advanced features are off: their fields are left out (existing discounts stay readable in payment_record).
      for (const key of ['installment', 'can_set_schedule', 'installment_percent', 'downpayment_amount', 'installment_amount', 'can_use_downpayment', 'promo_name', 'discount_percent', 'discount_set_at', 'discount_set_by']) delete payload.payment_stage[key];
      payload.payment_stage.can_submit_report = false;
      payload.payment_stage.can_add_entry = false;
    }
    payload.payment_history = paymentRows.map((p) => ({
      id: p.id, payment_type: p.payment_type, payment_method: p.payment_method, amount: Number(p.amount), payment_date: p.payment_date, status: p.status, remarks: p.remarks,
      recorded_by: p.recorded_by?.full_name ?? null, received_by: p.received_by?.full_name ?? null, received_by_user_id: p.received_by_user_id,
      received_by_role_id: p.received_by_role_id, verified_by: p.verified_by?.full_name ?? null,
      documents: p.documents.map((d: Row) => ({ id: d.id, original_name: d.original_name })),
    }));
    const [legacy] = await db.query(`select * from applicant_payments where applicant_id = $1 and is_legacy_baseline = true limit 1`, [id]);
    if (legacy && !paymentRows.some((p) => p.payment_type === 'legacy_fully_paid')) {
      payload.payment_history.push({
        id: `legacy-${legacy.id}`, payment_type: 'legacy_fully_paid', amount: Number(legacy.amount), payment_date: legacy.payment_date,
        status: 'verified', remarks: legacy.remarks, verified_by: 'System baseline', documents: [],
      });
    }
  }
  return ok(c, payload);
});

/** ActivitySchedule's $appends. */
export function scheduleJson(s: Row): Row {
  const started = s.starts_at ? new Date(s.starts_at).getTime() : null;
  const live = ['pending', 'confirmed'].includes(s.status);
  const end = started === null ? null : s.ends_at ? new Date(s.ends_at).getTime() : started + Number(s.duration_minutes ?? 0) * 60000;
  const rejected = s.approval_status === 'rejected';
  return {
    ...s,
    is_overdue: !rejected && started !== null && live && end! < Date.now(),
    is_missed: !rejected && started !== null && (s.status === 'cancelled'
      ? Boolean(s.cancelled_at) && new Date(s.cancelled_at).getTime() > started
      : (live || s.status === 'no_show') && started < Date.now()),
    session_id: String(s.session_key ?? ''),
    // Older completions saved before the start time are left as they are, only flagged.
    completed_before_schedule: s.status === 'completed' && Boolean(s.completed_at) && started !== null && new Date(s.completed_at).getTime() < started,
    legacy_completion: s.status === 'completed' && !s.completion_submitted_at,
    available_at: started === null ? null : new Date(started).toISOString(),
  };
}

applicantRoutes.get('/applicants/:applicant/report', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const user = c.get('user');
  const showFiles = canSeeRequirementFiles(user, a);
  // The seven Application Detail pages read everything below from the database.
  const schedules = await db.query(
    `select s.id, s.activity_type, s.title, s.starts_at, s.ends_at, s.venue, s.status, s.approval_status, s.completed_at, s.attended, s.actual_started_at, s.handler_name,
       s.result_notes, s.no_show_reason, s.completion_submitted_at, s.review_status, s.reviewed_at, s.return_reason,
       ${NAME('s.completion_submitted_by_user_id')} as completion_submitted_by, ${NAME('s.reviewed_by_user_id')} as reviewed_by,
       ${NAME('s.scheduled_by_user_id')} as scheduled_by, ${NAME('s.approved_by_user_id')} as approved_by,
       (select b.name from brands b where b.id = s.tasted_brand_id) as tasted_brand_name,
       coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'original_name', d.original_name, 'mime_type', d.mime_type, 'replaced_at', d.replaced_at) order by d.id)
         from documents d where d.documentable_type = 'App\\Models\\ActivitySchedule' and d.documentable_id = s.id and d.type = 'attendance_proof'), '[]'::jsonb) as proof_documents
     from activity_schedules s where s.applicant_id = $1 order by s.starts_at, s.id`, [a.id],
  );
  const loiDocuments = await db.query(
    `select d.id, d.original_name, d.mime_type, d.created_at, d.replaced_at, d.removed_at, d.removed_reason, ${NAME('d.uploaded_by_user_id')} as uploaded_by, ${NAME('d.removed_by_user_id')} as removed_by
     from documents d where d.documentable_type = $1 and d.documentable_id = $2 and d.type = 'loi' order by d.id`, [APPLICANT_MODEL, a.id],
  );
  const [people] = await db.query(
    `select ${NAME('a.assigned_sales_user_id')} as assigned_sales, ${NAME('a.qualified_by_user_id')} as qualified_by, ${NAME('a.reviewed_by_user_id')} as reviewed_by,
       ${NAME('a.approved_by_user_id')} as approved_by, ${NAME('a.loi_confirmed_by_user_id')} as loi_confirmed_by, ${NAME('a.loi_completed_by_user_id')} as loi_completed_by,
       ${NAME('a.payment_confirmed_by_user_id')} as payment_confirmed_by, ${STAGE_DAYS_SQL('a')} as days_in_stage,
       (select to_jsonb(b) from brands b where b.id = a.preferred_brand_id) as brand
     from applicants a where a.id = $1`, [a.id],
  );
  const base = await reportPayload(db, a);
  return ok(c, {
    ...base,
    files_visible: showFiles,
    people: {
      ...people,
      // Who prepared (the assigned Sales user) and who approved (Admin) must be different people.
      prepared_and_approved_by_different_people: a.approved_by_user_id ? Number(a.approved_by_user_id) !== Number(a.assigned_sales_user_id ?? 0) : null,
    },
    monitor: applicantMonitor({ ...a, days_in_stage: people.days_in_stage }),
    requirements: await requirementsPayload(db, a, user),
    brand_confirmation: await brandPayload(db, a),
    activity_rows: schedules.map((s) => ({ ...scheduleJson(s), proof_documents: showFiles ? s.proof_documents : null })),
    loi_documents: showFiles ? loiDocuments : null,
    payment_record: await recordPayload(db, a, user, paymentAdvanced(c), showFiles),
    follow_ups: await followUpsOf(db, 'applicant', a.id),
    history: await applicantHistory(db, a.id, showFiles),
  });
});

/** The History page: every action in time order, optionally one report page (stage) only. */
applicantRoutes.get('/applicants/:applicant/history', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const page = c.req.query('page') || null;
  if (page && !(REPORT_PAGES as readonly string[]).includes(page)) fail('page', `Choose one of: ${REPORT_PAGES.join(', ')}.`);
  return ok(c, await applicantHistory(db, a.id, canSeeRequirementFiles(c.get('user'), a), page));
});

async function reportPayload(db: Db, a: Row): Promise<Row> {
  const id = a.id;
  const milestones = a.milestones ?? {};
  const details = a.milestone_details ?? {};
  const plan = await loadPlan(db, id);
  const history = await db.query(`select h.*, (select u.full_name from users u where u.id = h.changed_by_user_id) as by_name from applicant_status_histories h where h.applicant_id = $1 order by h.id`, [id]);
  const schedules = await db.query(`select s.*, (select u.full_name from users u where u.id = s.assigned_to_user_id) as assigned_name from activity_schedules s where s.applicant_id = $1 order by s.starts_at`, [id]);
  const paymentRows = await db.query(
    `select p.*, ${PAYMENT_DOCS('p.id')} as documents, (select full_name from users where id = p.recorded_by_user_id) as recorded_name,
       (select full_name from users where id = p.verified_by_user_id) as verified_name from payments p where p.applicant_id = $1 order by p.id`, [id],
  );
  const [loi] = await db.query(
    `select id, original_name, mime_type from documents where documentable_type = $1 and documentable_id = $2 and type = 'loi' and removed_at is null and replaced_at is null order by id desc limit 1`,
    [APPLICANT_MODEL, id],
  );
  const assignedSales = await db.query(`select full_name from users where id = $1`, [a.assigned_sales_user_id ?? null]);
  const [names] = await db.query(
    `select (select full_name from users where id = $1) as reviewed, (select full_name from users where id = $2) as loi_by, (select full_name from users where id = $3) as approved,
       (select name from brands where id = $4) as brand, (select lead_code from franchise_inquiries where id = $5) as lead_code, (select full_name from users where id = $6) as discount_by`,
    [a.reviewed_by_user_id, a.loi_confirmed_by_user_id, a.approved_by_user_id, a.preferred_brand_id, a.inquiry_id, plan?.discount_set_by_user_id ?? null],
  );
  const qualified = history.find((h) => h.to_status === 'qualified');
  const approvedHistory = history.find((h) => h.to_status === 'approved');
  const activities = ACTIVITY_ORDER.map((type) => {
    const key = TRACKED_ACTIVITY_MILESTONES[type];
    const rows = schedules.filter((s) => s.activity_type === type);
    const schedule = rows[rows.length - 1];
    const completed = rows.filter((s) => s.status === 'completed').sort((x, y) => new Date(y.completed_at ?? 0).getTime() - new Date(x.completed_at ?? 0).getTime())[0];
    return {
      key: type, label: activityLabel(type), scheduled_at: iso(schedule?.starts_at), schedule_status: schedule?.status ?? null, completed: Boolean(milestones[key]),
      completed_at: iso(completed?.completed_at), recorded_by: completed?.assigned_name ?? details[key]?.by ?? null, recorded_at: details[key]?.on ?? null,
    };
  });
  const required = Number(plan?.total_required_amount ?? a.total_required_amount ?? 0);
  let initial = Number(plan?.initial_payment_amount ?? a.initial_payment_amount ?? 0);
  if (initial <= 0 && required > 0) initial = Math.round(required * PAYMENT_INITIAL_PERCENT) / 100;
  const verified = paymentRows.filter((p) => p.status === 'verified');
  const percent = await paymentPercent(db, a);
  let paidDate: string | null = null;
  let running = 0;
  for (const p of verified) {
    running += Number(p.amount);
    if (!paidDate && required > 0 && running >= required) paidDate = p.payment_date;
  }
  const verifiedTotal = verified.reduce((sum, p) => sum + Number(p.amount), 0);
  const final = plan?.total_required_amount ?? a.total_required_amount;
  return {
    applicant: {
      id, applicant_code: a.applicant_code, lead_code: names.lead_code ?? null, full_name: a.full_name, email: a.email, phone: a.phone, address: a.address, notes: a.notes,
      status: a.status, status_label: await statusLabel(db, a), application_date: a.application_date, approved_at: iso(a.approved_at),
      assigned_sales: a.assigned_sales_user_id ? { id: a.assigned_sales_user_id, full_name: assignedSales[0]?.full_name ?? null } : null, preferred_brand: a.preferred_brand_id && names.brand ? { id: a.preferred_brand_id, name: names.brand } : null,
    },
    qualification: {
      items: QUALIFICATION_KEYS.map((key) => ({ key, label: MILESTONES[key], completed: Boolean(milestones[key]), completed_at: details[key]?.on ?? null, recorded_by: details[key]?.by ?? null })),
      status: qualificationChecked(a) ? 'Qualified' : 'In progress',
      qualified_at: iso(qualified?.created_at),
      qualified_by: qualified?.by_name ?? null,
    },
    activities: {
      items: activities,
      all_completed: await scheduledChecked(db, a),
      completed_at: activities.map((x) => x.completed_at).filter(Boolean).sort().pop() ?? null,
    },
    loi: {
      submission_date: a.loi_submission_date, received_by: a.loi_received_by, submission_type: a.loi_submission_type, verification_status: a.loi_verification_status,
      status: a.loi_status, verified_at: iso(a.loi_confirmed_at), verified_by: names.loi_by ?? null, remarks: a.loi_remarks, document: loi ?? null,
    },
    payment: {
      plan: {
        package_name: plan?.package_name ?? a.package_name,
        total_required_amount: required > 0 ? required : null,
        initial_payment_amount: initial > 0 ? initial : null,
        other_fees: Number(plan?.other_fees ?? a.other_fees ?? 0),
        payment_terms: plan?.payment_terms ?? null,
        discount: final === null || final === undefined ? null : {
          original_amount: Number(plan?.total_required_original_amount ?? a.total_required_original_amount ?? final),
          discount_percent: Number(plan?.total_required_discount_percent ?? a.total_required_discount_percent ?? 0),
          promo_name: plan?.promo_name ?? null, final_amount: Number(final), set_by: names.discount_by ?? null, set_at: iso(plan?.discount_set_at),
        },
        installment: await payments.installmentPayload(db, a),
      },
      summary: {
        verified_amount: verifiedTotal,
        pending_amount: paymentRows.filter((p) => ['pending', 'for_revision'].includes(p.status)).reduce((sum, p) => sum + Number(p.amount), 0),
        remaining_balance: required > 0 ? Math.max(0, required - verifiedTotal) : null,
        payment_percent: percent,
        fully_paid_at: paidDate,
        transaction_count: paymentRows.length,
      },
      history: paymentRows.map((p) => ({
        id: p.id, payment_type: p.payment_type, payment_method: p.payment_method, amount: Number(p.amount), payment_date: p.payment_date, submitted_at: iso(p.requested_at),
        status: p.status, department: p.department, remarks: p.remarks, recorded_by: p.recorded_name, verified_by: p.verified_name, verified_at: iso(p.verified_at), documents: p.documents,
      })),
    },
    approval: {
      checkpoints: [
        { key: 'qualification', label: 'Qualification verified', done: qualificationChecked(a) },
        { key: 'activities', label: 'Activities verified', done: await scheduledChecked(db, a) },
        { key: 'loi', label: 'LOI verified', done: a.loi_verification_status === 'verified' || a.loi_confirmed_at !== null },
        { key: 'payment', label: 'Payment verified', done: await hasVerifiedInitialPayment(db, a) },
      ],
      reviewed_at: iso(a.reviewed_at), reviewed_by: names.reviewed ?? null, review_remarks: a.review_remarks, approved_at: iso(a.approved_at),
      approved_by: names.approved ?? approvedHistory?.by_name ?? null, approved_by_user_id: a.approved_by_user_id, remarks: approvedHistory?.remarks ?? null,
    },
  };
}

// ---- create / update ----
applicantRoutes.post('/applicants', admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    full_name: ['required', 'string', 'max:255'],
    email: ['nullable', 'email', 'max:255'],
    phone: ['nullable', 'string', 'max:50'],
    address: ['nullable', 'string'],
    preferred_brand_id: ['nullable', 'exists:brands,id'],
    status: ['nullable', `in:${STATUSES}`],
    application_date: ['nullable', 'date'],
    notes: ['nullable', 'string'],
    assigned_sales_user_id: ['nullable', 'integer'],
  });
  const { assigned_sales_user_id: salesId, ...fields } = v;
  const salesUser = salesId ? await activeSalesUser(db, salesId, 'assigned_sales_user_id') : null;
  const assignment = salesUser ? { assigned_sales_user_id: salesUser.id, assigned_sales_at: new Date(), assigned_sales_by_user_id: c.get('user').id } : {};
  const a = await db.tx(async (tx) => {
    const row = await insertRow(tx, 'applicants', { ...fields, ...assignment, status: fields.status ?? 'converted', application_date: fields.application_date ?? manilaToday() });
    row.applicant_code = await assignPublicCode(tx, 'applicants', 'applicant_code', 'APL', row.id);
    await tx.query(`insert into applicant_status_histories (applicant_id, from_status, to_status, remarks, changed_by_user_id) values ($1, null, $2, 'Applicant created directly.', $3)`, [row.id, row.status, c.get('user').id]);
    await logStageChange(tx, row.id, null, row.status, c.get('user').id, 'Applicant created directly.', 'created', {}, { step: 'creation', new_values: { status: row.status } });
    if (salesUser) {
      await logStageChange(tx, row.id, row.status, row.status, c.get('user').id, `Assigned to ${salesUser.full_name}.`, 'sales_assigned', {}, {
        step: 'assignment', old_values: { assigned_sales_user_id: null }, new_values: { assigned_sales_user_id: salesUser.id, assigned_sales: salesUser.full_name },
      });
    }
    return row;
  });
  if (salesUser) {
    await notifyAssignedSales(db, a, 'assessment_pending', 'Applicant assigned to you', `${a.applicant_code} (${a.full_name}) is assigned to you for the qualification assessment.`, {}, c.get('user'));
  }
  await audit(c, db, 'applicant.created', { type: APPLICANT_MODEL, id: a.id }, null, a);
  const [brand] = await db.query(`select * from brands where id = $1`, [a.preferred_brand_id]);
  return ok(c, { ...applicantJson(a), preferred_brand: brand ?? null }, 'Applicant created.', 201);
});

applicantRoutes.put('/applicants/:applicant', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const v = await validate(db, await readInput(c), {
    full_name: ['sometimes', 'required', 'string', 'max:255'],
    email: ['nullable', 'email', 'max:255'],
    phone: ['nullable', 'string', 'max:50'],
    address: ['nullable', 'string'],
    preferred_brand_id: ['nullable', 'exists:brands,id'],
    notes: ['nullable', 'string'],
  });
  const brandChanging = 'preferred_brand_id' in v && Number(v.preferred_brand_id ?? 0) !== Number(a.preferred_brand_id ?? 0);
  if (brandChanging) {
    await assertBrandUnlocked(db, a);
    const completed = await db.query(`select 1 from activity_schedules where applicant_id = $1 and activity_type = 'product_tasting' and status = 'completed' limit 1`, [a.id]);
    if ((a.milestones ?? {}).product_tasting_attended || completed.length) fail('preferred_brand_id', 'Locked after Product Tasting completion.');
    await assertNoSessionOfOtherBrand(db, a.id, v.preferred_brand_id ?? null);
  }
  const saved = (await updateRow(db, 'applicants', a.id, v))!;
  if (brandChanging) {
    const [names] = await db.query(`select (select name from brands where id = $1) as from_name, (select name from brands where id = $2) as to_name`, [a.preferred_brand_id, saved.preferred_brand_id]);
    await logEvent(db, saved, 'brand_changed', c.get('user').id, { from_brand_id: a.preferred_brand_id, from_brand: names.from_name, to_brand_id: saved.preferred_brand_id, to_brand: names.to_name });
  }
  if ('full_name' in v) await renameParticipantName(db, a.id, a.full_name, saved.full_name);
  await audit(c, db, 'applicant.updated', { type: APPLICANT_MODEL, id: a.id }, a, saved);
  const [brand] = await db.query(`select * from brands where id = $1`, [saved.preferred_brand_id]);
  return ok(c, { ...applicantJson(saved), preferred_brand: brand ?? null }, 'Applicant updated.');
});

/** Admin assigns, or reassigns with a required reason, the Sales user who handles the applicant. */
applicantRoutes.post('/applicants/:applicant/assign-sales', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { assigned_sales_user_id: ['nullable', 'integer'], reason: ['nullable', 'string', 'max:2000'] });
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be reassigned.');
  if (['active_franchisee', 'rejected'].includes(a.status)) fail('applicant', 'A closed applicant cannot be reassigned.');
  const next = await activeSalesUser(db, v.assigned_sales_user_id, 'assigned_sales_user_id');
  if (Number(a.assigned_sales_user_id) === Number(next.id)) fail('assigned_sales_user_id', `${next.full_name} is already the assigned Sales user.`);
  const reassigning = Boolean(a.assigned_sales_user_id);
  // A first assignment may carry a note; changing an existing assignment needs a reason.
  const reason = reassigning ? requireReason(v.reason, 'reason', 'a reassignment reason') : optionalReason(v.reason, 'reason');
  const [previous] = reassigning ? await db.query(`select id, full_name from users where id = $1`, [a.assigned_sales_user_id]) : [];
  const saved = await db.tx(async (tx) => {
    const row = (await updateRow(tx, 'applicants', a.id, { assigned_sales_user_id: next.id, assigned_sales_at: new Date(), assigned_sales_by_user_id: user.id }))!;
    await logEvent(tx, row, reassigning ? 'sales_reassigned' : 'sales_assigned', user.id, {}, reason ?? `Assigned to ${next.full_name}.`, {
      step: 'assignment',
      old_values: { assigned_sales_user_id: previous?.id ?? null, assigned_sales: previous?.full_name ?? null },
      new_values: { assigned_sales_user_id: next.id, assigned_sales: next.full_name },
    });
    await audit(c, tx, reassigning ? 'applicant.sales_reassigned' : 'applicant.sales_assigned', { type: APPLICANT_MODEL, id: a.id },
      { assigned_sales_user_id: previous?.id ?? null }, { assigned_sales_user_id: next.id, reason });
    return row;
  });
  await notifyAssignedSales(db, saved, 'applicant_assigned', 'Applicant assigned to you', `${a.applicant_code} (${a.full_name}) is now assigned to you.${reason ? ` Reason: ${reason}` : ''}`, {}, user);
  if (previous) await notifyUser(db, previous.id, 'applicant_unassigned', 'Applicant reassigned', `${a.applicant_code} (${a.full_name}) was reassigned to ${next.full_name}. Reason: ${reason}`, { applicant_id: a.id }, user);
  return ok(c, await freshWithAssignment(db, a.id), reassigning ? `Reassigned to ${next.full_name}.` : `Assigned to ${next.full_name}.`);
});

const freshWithAssignment = async (db: Db, id: number) => applicantJson((await db.query(
  `select a.*, ${NAME('a.assigned_sales_user_id')} as assigned_sales, ${NAME('a.assigned_sales_by_user_id')} as assigned_sales_by from applicants a where a.id = $1`, [id],
))[0]);

const moved = async (db: Db, id: number, extra: Row = {}) => {
  const row = await fresh(db, id);
  return { ...row, milestone_state: milestoneState(row), ...(await scheduleState(db, row)), brand_confirmation: await brandPayload(db, row), ...extra };
};

// ---- Brand Confirmation (between Product Tasting and Training) ----
const BRAND_NAME = (expr: string) => `(select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = ${expr})`;

async function brandPayload(db: Db, a: Row): Promise<Row> {
  const state = await brandState(db, a);
  const rows = await db.query(
    `select c.*, ${BRAND_NAME('c.final_brand_id')} as final_brand, ${BRAND_NAME('c.tasted_brand_id')} as tasted_brand,
       ${NAME('c.submitted_by_user_id')} as submitted_by, ${NAME('c.reviewed_by_user_id')} as reviewed_by
     from applicant_brand_confirmations c where c.applicant_id = $1 order by c.id`, [a.id],
  );
  const [lockedBy] = a.brand_locked_by_user_id ? await db.query(`select full_name from users where id = $1`, [a.brand_locked_by_user_id]) : [];
  const tastingDone = await activityDone(db, a, 'product_tasting');
  const latest = rows[rows.length - 1] ?? null;
  let blocked: string | null = null;
  if (state.locked) blocked = state.legacy ? 'Legacy - brand confirmation not captured.' : 'The brand is confirmed and locked.';
  else if (!tastingDone) blocked = 'Available after Product Tasting is Done (Sales marked it Complete and Admin marked it Attended).';
  else if (latest?.status === 'submitted') blocked = 'Waiting for Admin to confirm or return the submission.';
  return {
    locked: state.locked, legacy: state.legacy, confirmed: state.confirmed,
    locked_at: iso(a.brand_locked_at), locked_by: lockedBy?.full_name ?? null,
    tasted_brand_id: await tastedBrandId(db, a),
    retasting_required: state.retasting_required, retasting_done: state.retasting_done,
    can_submit: !blocked && !a.archived_at && a.status === 'scheduled',
    blocked_reason: blocked,
    current: latest, history: rows,
  };
}

/** Step 1: the assigned Sales user submits the applicant's final brand. */
applicantRoutes.post('/applicants/:applicant/brand-confirmation', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  if (roleName(c) !== 'sales') abort(403, 'Only the assigned Sales user submits the Brand Confirmation. Admin reviews and confirms it.');
  await assertAssignedSales(c, a);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    final_brand_id: ['required', 'integer', 'exists:brands,id'],
    confirmation_method: ['required', `in:${Object.keys(BRAND_METHODS).join(',')}`],
    confirmed_on: ['required', 'date', 'before_or_equal:today'],
    notes: ['nullable', 'string', 'max:2000'],
    change_reason: ['nullable', 'string', 'max:2000'],
  });
  if (a.archived_at || a.status !== 'scheduled') fail('applicant', 'Brand Confirmation is done at the Scheduling stage.');
  await assertBrandUnlocked(db, a, 'final_brand_id');
  if (!(await activityDone(db, a, 'product_tasting'))) {
    fail('brand_confirmation', 'Brand Confirmation is available only after Product Tasting is Done (Sales marked it Complete and Admin marked it Attended).');
  }
  const latest = await latestBrandConfirmation(db, a.id);
  if (latest?.status === 'submitted') fail('brand_confirmation', 'A Brand Confirmation is already waiting for Admin. Admin must confirm or return it first.');
  const notes = requireReason(v.notes, 'notes', 'notes');
  const tasted = await tastedBrandId(db, a);
  const finalBrand = Number(v.final_brand_id);
  const differs = tasted !== null && finalBrand !== tasted;
  const changeReason = differs ? requireReason(v.change_reason, 'change_reason', 'a reason for choosing a brand other than the one tasted') : null;

  const row = await db.tx(async (tx) => {
    const saved = await insertRow(tx, 'applicant_brand_confirmations', {
      applicant_id: a.id, tasted_brand_id: tasted, final_brand_id: finalBrand, confirmation_method: v.confirmation_method, confirmed_on: v.confirmed_on,
      notes, change_reason: changeReason, retasting_required: differs, status: 'submitted', submitted_by_user_id: user.id, submitted_at: new Date(),
    });
    if (differs) {
      // The new brand must be tasted before Admin can confirm it: the applicant's brand follows the choice now.
      await assertNoSessionOfOtherBrand(tx, a.id, finalBrand);
      await releaseCompletedTastingKeys(tx, a.id);
      await updateRow(tx, 'applicants', a.id, { preferred_brand_id: finalBrand });
      await logEvent(tx, a, 'brand_changed', user.id, { brand_confirmation_id: saved.id }, changeReason, {
        step: 'brand_confirmation', old_values: { preferred_brand_id: a.preferred_brand_id }, new_values: { preferred_brand_id: finalBrand },
      });
    }
    await logEvent(tx, a, 'brand_confirmation_submitted', user.id, { brand_confirmation_id: saved.id }, notes, {
      step: 'brand_confirmation',
      new_values: { final_brand_id: finalBrand, tasted_brand_id: tasted, confirmation_method: v.confirmation_method, confirmed_on: v.confirmed_on, change_reason: changeReason, retasting_required: differs },
    });
    await audit(c, tx, 'applicant.brand_confirmation_submitted', { type: APPLICANT_MODEL, id: a.id }, null, saved);
    return saved;
  });
  await notifyRoles(db, ['admin'], 'brand_confirmation_submitted', 'Brand Confirmation submitted',
    `${user.full_name} submitted the final brand for ${a.full_name}.${differs ? ' It differs from the tasted brand: Product Tasting must be done again for it first.' : ''}`, { applicant_id: a.id }, user);
  return ok(c, { ...row, brand_confirmation: await brandPayload(db, (await loadApplicant(db, a.id))!) },
    differs ? 'Submitted. The brand differs from the tasted one, so Product Tasting must be done again for it before Admin can confirm.' : 'Brand Confirmation sent to Admin.', 201);
});

/** Step 2: Admin confirms (the brand is locked for good) — the UI asks twice before calling this. */
applicantRoutes.post('/applicants/:applicant/brand-confirmation/confirm', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  if (roleName(c) !== 'admin') abort(403, 'Only Admin can confirm the brand.');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { confirmed: ['required', 'accepted'], remarks: ['nullable', 'string', 'max:2000'] });
  const latest = await latestBrandConfirmation(db, a.id);
  if (!latest || latest.status !== 'submitted') fail('brand_confirmation', 'There is no Brand Confirmation waiting for Admin.');
  await assertBrandUnlocked(db, a, 'brand_confirmation');
  if (latest.retasting_required && !(await retastingDone(db, a.id, Number(latest.final_brand_id), latest.submitted_at))) {
    const [brand] = await db.query(`select name from brands where id = $1`, [latest.final_brand_id]);
    fail('brand_confirmation', `${brand?.name ?? 'The new brand'} was not tasted yet. Product Tasting must be done again for it (Sales Complete + Admin Attended) before the brand can be confirmed.`);
  }
  await db.tx(async (tx) => {
    await updateRow(tx, 'applicant_brand_confirmations', latest.id, { status: 'confirmed', reviewed_by_user_id: user.id, reviewed_at: new Date() });
    await updateRow(tx, 'applicants', a.id, { brand_locked_at: new Date(), brand_locked_by_user_id: user.id });
    await logEvent(tx, a, 'brand_confirmed', user.id, { brand_confirmation_id: latest.id }, v.remarks ?? null, {
      step: 'brand_confirmation', old_values: { brand_locked: false }, new_values: { brand_locked: true, preferred_brand_id: latest.final_brand_id },
    });
    await audit(c, tx, 'applicant.brand_confirmed', { type: APPLICANT_MODEL, id: a.id }, { brand_locked_at: null }, { brand_locked_at: new Date().toISOString(), final_brand_id: latest.final_brand_id });
  });
  await notifyAssignedSales(db, a, 'brand_confirmed', 'Brand confirmed', `Admin confirmed and locked the brand for ${a.full_name}. Training can now be scheduled.`, {}, user);
  return ok(c, await moved(db, a.id), 'Brand confirmed and locked. Training can now be scheduled.');
});

/** Admin returns the submission to Sales with a reason. */
applicantRoutes.post('/applicants/:applicant/brand-confirmation/return', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  if (roleName(c) !== 'admin') abort(403, 'Only Admin can return the Brand Confirmation.');
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  const latest = await latestBrandConfirmation(db, a.id);
  if (!latest || latest.status !== 'submitted') fail('brand_confirmation', 'There is no Brand Confirmation waiting for Admin.');
  const reason = requireReason(v.reason, 'reason', 'a return reason');
  await db.tx(async (tx) => {
    await updateRow(tx, 'applicant_brand_confirmations', latest.id, { status: 'returned', reviewed_by_user_id: user.id, reviewed_at: new Date(), return_reason: reason });
    await logEvent(tx, a, 'brand_confirmation_returned', user.id, { brand_confirmation_id: latest.id }, reason, {
      step: 'brand_confirmation', old_values: { status: 'submitted' }, new_values: { status: 'returned' },
    });
    await audit(c, tx, 'applicant.brand_confirmation_returned', { type: APPLICANT_MODEL, id: a.id }, { status: 'submitted' }, { status: 'returned', reason });
  });
  await notifyAssignedSales(db, a, 'brand_confirmation_returned', 'Brand Confirmation returned', `Admin returned the Brand Confirmation for ${a.full_name}: ${reason}`, {}, user);
  return ok(c, await moved(db, a.id), 'Brand Confirmation returned to Sales.');
});

applicantRoutes.patch('/applicants/:applicant/milestones', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const input = await readInput(c);
  const v = await validate(db, input, { milestones: ['present', 'array_or_object'], milestone_details: ['nullable'] });
  const sent = (v.milestones ?? {}) as Row;
  for (const value of Object.values(sent)) {
    if (![true, false, 0, 1, '0', '1'].includes(value as never)) fail('milestones', 'The milestones field must be true or false.');
  }
  const submitted = (v.milestone_details ?? {}) as Row;
  for (const [key, value] of Object.entries(submitted)) {
    if (!value?.on || Number.isNaN(Date.parse(value.on))) fail(`milestone_details.${key}.on`, 'A valid date is required.');
  }
  const truthy = (x: unknown) => x === true || x === 1 || x === '1';
  const stored = a.milestones ?? {};
  const milestones: Row = Object.fromEntries(REQUIRED_MILESTONES.map((k) => [k, truthy(sent[k])]));
  // The qualification assessments belong to Sales: Admin's save never overwrites them.
  for (const key of QUALIFICATION_KEYS) milestones[key] = Boolean(stored[key]);

  const completedTypes = (await db.query(`select activity_type from activity_schedules where applicant_id = $1 and status = 'completed'`, [a.id])).map((r) => r.activity_type);
  const working = { ...milestones };
  for (const [index, type] of ACTIVITY_ORDER.entries()) {
    const key = TRACKED_ACTIVITY_MILESTONES[type];
    const alreadySaved = Boolean(stored[key]);
    if (!milestones[key]) { working[key] = alreadySaved; continue; } // a saved Attended can never be cleared
    if (alreadySaved) { working[key] = true; continue; }
    const label = activityLabel(type);
    if (!completedTypes.includes(type)) fail('milestones', `You cannot mark ${label} as attended yet — Sales must mark it Complete first.`);
    if (index > 0) {
      const previous = ACTIVITY_ORDER[index - 1];
      if (!completedTypes.includes(previous) || !working[TRACKED_ACTIVITY_MILESTONES[previous]]) {
        fail('milestones', `${activityLabel(previous)} must be Done before ${label} can be marked attended.`);
      }
    }
    working[key] = true;
  }

  const user = c.get('user');
  const previous = a.milestone_details ?? {};
  const details: Row = {};
  const marker = `${user.full_name} (${String(user.role?.name ?? '').replace(/_/g, ' ').replace(/\b\w/g, (m: string) => m.toUpperCase())})`.trim();
  for (const key of REQUIRED_MILESTONES) {
    if (!working[key]) continue;
    const existing = previous[key];
    const given = submitted[key];
    if (!given && !existing) continue;
    details[key] = {
      on: given ? localMinute(given.on) : existing.on,
      by: existing?.by ?? marker,
      by_user_id: existing?.by_user_id ?? user.id,
    };
  }
  const saved = (await updateRow(db, 'applicants', a.id, { milestones: working, milestone_details: details }))!;
  // Newly Attended activities: Admin's review of the latest completion is recorded too.
  for (const type of ACTIVITY_ORDER) {
    const key = TRACKED_ACTIVITY_MILESTONES[type];
    if (!working[key] || stored[key]) continue;
    const [latest] = await db.query(
      `select id, review_status from activity_schedules where applicant_id = $1 and activity_type = $2 and status = 'completed' order by coalesce(completed_at, starts_at) desc limit 1`, [a.id, type],
    );
    if (latest && latest.review_status !== 'accepted') {
      await db.query(`update activity_schedules set review_status = 'accepted', reviewed_by_user_id = $1, reviewed_at = now() where id = $2`, [user.id, latest.id]);
    }
    await logEvent(db, saved, 'activity_attended', user.id, { activity_id: latest?.id ?? null, activity_type: type }, null, {
      step: type, old_values: { [key]: false }, new_values: { [key]: true },
    });
  }
  await syncApplicantAttendance(db, saved, user.id);
  await audit(c, db, 'applicant.milestones_updated', { type: APPLICANT_MODEL, id: a.id }, { milestones: a.milestones, milestone_details: previous }, { milestones: working, milestone_details: details });
  return ok(c, await moved(db, a.id), 'Applicant activities updated.');
});

/** Carbon::parse(...)->format('Y-m-d\TH:i') in the business timezone. */
function localMinute(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

applicantRoutes.put('/applicants/:applicant/assessments', sales, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be assessed.');
  await assertAssignedSales(c, a);
  // Replaced by the Qualification requirements (the old checklist log stays as history).
  fail('milestones', 'The qualification checklist was replaced by the Qualification requirements. Submit each requirement with its details and files instead.');
  if (!['converted', 'qualified'].includes(a.status)) fail('applicant', 'The qualification assessment is only editable at the Qualification stage.');
  const input = await readInput(c);
  const v = await validate(db, input, { milestones: ['present', 'array_or_object'] });
  const sent = (v.milestones ?? {}) as Row;
  const previous = a.milestones ?? {};
  const milestones = { ...previous };
  const changes: Row = {};
  for (const key of QUALIFICATION_KEYS) {
    const value = sent[key] === true || sent[key] === 1 || sent[key] === '1';
    milestones[key] = value;
    if (Boolean(previous[key]) !== value) changes[key] = value;
  }
  const user = c.get('user');
  await db.tx(async (tx) => {
    await updateRow(tx, 'applicants', a.id, { milestones });
    for (const [key, checked] of Object.entries(changes)) {
      await tx.query(`insert into applicant_assessment_logs (applicant_id, assessment_key, is_checked, checked_by_user_id, checked_at) values ($1, $2, $3, $4, now())`, [a.id, key, checked, user.id]);
    }
    await audit(c, tx, 'applicant.assessments_saved', { type: APPLICANT_MODEL, id: a.id }, { milestones: previous }, { milestones, changed: Object.keys(changes) });
    if (Object.keys(changes).length) {
      await logEvent(tx, a, 'assessment_saved', user.id, {}, null, {
        step: 'qualification',
        old_values: Object.fromEntries(Object.keys(changes).map((k) => [k, Boolean(previous[k])])),
        new_values: changes,
      });
    }
  });
  const row = await fresh(db, a.id);
  return ok(c, await moved(db, a.id, { assessment_complete: qualificationChecked(row) }), 'Applicant assessments saved.');
});

const stampQualified = (db: Db, a: Row, userId: number) => (a.qualified_at ? null : updateRow(db, 'applicants', a.id, { qualified_at: new Date(), qualified_by_user_id: userId }));

applicantRoutes.post('/applicants/:applicant/confirm-qualified', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { confirmed: ['required', 'accepted'], remarks: ['nullable', 'string'] });
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be confirmed.');
  const respond = async (message: string) => {
    const [row] = await db.query(`select a.*, ${HISTORY('a.id')} as status_history, ${NAME('a.qualified_by_user_id')} as qualified_by from applicants a where a.id = $1`, [a.id]);
    return ok(c, { ...applicantJson(row), milestone_state: milestoneState(row) }, message);
  };
  if (a.status === 'qualified') {
    await stampQualified(db, a, user.id);
    return respond('Applicant is already Qualified.');
  }
  if (a.status !== 'converted') fail('status', 'Only an applicant at the Converted stage can be confirmed as Qualified.');
  await assertStageRequirements(db, a.id, 'qualification');
  const remarks = requireReason(v.remarks, 'remarks', 'Confirm Qualified remarks');
  // The accepted requirements stand in for the old checklist flags, so approval, progress and
  // reports read them as before.
  const milestones = { ...(a.milestones ?? {}) };
  const milestoneDetails = { ...(a.milestone_details ?? {}) };
  for (const key of QUALIFICATION_KEYS) {
    milestones[key] = true;
    milestoneDetails[key] ??= { on: localMinute(new Date().toISOString()), by: `${user.full_name} (Admin, requirements accepted)`, by_user_id: user.id };
  }
  const saved = await transition(c, db, a, 'qualified', user, remarks, 'applicant.qualified', { milestones, milestone_details: milestoneDetails });
  await stampQualified(db, saved, user.id);
  return respond('Applicant confirmed as Qualified.');
});

applicantRoutes.post('/applicants/:applicant/set-schedule', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be moved forward.');
  const didMove = await db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from applicants where id = $1 for update`, [a.id]);
    if (locked.status === 'scheduled') return false;
    if (locked.status !== 'qualified') fail('status', 'Set Schedule is only available at the Qualified stage. Confirm the applicant as Qualified first.');
    assertQualificationChecked(locked);
    await assertTransition(tx, locked, 'scheduled', c.get('user'), null, true);
    await transition(c, tx, locked, 'scheduled', c.get('user'), 'Set Schedule by Admin — Schedule Activity unlocked.', 'applicant.set_schedule');
    return true;
  });
  return ok(c, await moved(db, a.id), didMove ? 'Applicant moved to Scheduling — Schedule Activity is unlocked.' : 'Applicant is already at the Scheduling stage.');
});

applicantRoutes.post('/applicants/:applicant/archive', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const hasFranchisee = (await db.query(`select 1 from franchisees where applicant_id = $1 limit 1`, [a.id])).length > 0;
  if (a.status === 'active_franchisee' || hasFranchisee) fail('applicant', 'An active franchisee cannot be archived.');
  if (a.archived_at) return ok(c, applicantJson(a), 'Applicant is already archived.');
  const saved = await updateRow(db, 'applicants', a.id, { archived_at: new Date(), archived_by_user_id: c.get('user').id });
  await audit(c, db, 'applicant.archived', { type: APPLICANT_MODEL, id: a.id }, a, saved);
  return ok(c, applicantJson(saved!), 'Applicant archived.');
});

applicantRoutes.delete('/applicants/:applicant', admin, async (c) => {
  const { db, files } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const hasFranchisee = (await db.query(`select 1 from franchisees where applicant_id = $1 limit 1`, [a.id])).length > 0;
  if (a.status === 'active_franchisee' || hasFranchisee) fail('applicant', 'An active franchisee cannot be removed. Archive the record instead.');
  const documents = await db.query(
    `select disk, path from documents where path is not null and ((documentable_type = $1 and documentable_id = $2)
       or (documentable_type = $3 and documentable_id in (select id from payments where applicant_id = $2)))`,
    [APPLICANT_MODEL, a.id, PAYMENT_MODEL],
  );
  await db.tx(async (tx) => {
    await tx.query(`delete from documents where documentable_type = $1 and documentable_id in (select id from payments where applicant_id = $2)`, [PAYMENT_MODEL, a.id]);
    await tx.query(`delete from payments where applicant_id = $1`, [a.id]);
    await tx.query(`delete from documents where documentable_type = $1 and documentable_id = $2`, [APPLICANT_MODEL, a.id]);
    await tx.query(`delete from applicant_status_histories where applicant_id = $1`, [a.id]);
    for (const { id } of await tx.query(`select id from activity_schedules where applicant_id = $1`, [a.id])) await forgetActivity(tx, id, c.get('user').id);
    await tx.query(`delete from activity_schedules where applicant_id = $1`, [a.id]);
    await tx.query(`delete from applicants where id = $1`, [a.id]);
  });
  // Files go after the transaction: a failed delete must not lose them, and a missing file is fine.
  for (const disk of new Set(documents.map((d) => d.disk))) {
    await files.remove(disk, documents.filter((d) => d.disk === disk).map((d) => d.path)).catch(() => {});
  }
  await audit(c, db, 'applicant.deleted', { type: APPLICANT_MODEL, id: a.id }, a);
  return ok(c, null, 'Applicant permanently deleted.');
});

// ---- stage moves ----
function assertLoiOptions(a: Row, type: unknown, verification: unknown) {
  if (type === 'other' && a.loi_submission_type !== 'other') fail('submission_type', '"Other" is no longer available. Choose Hard copy, Soft copy or Email.');
  if (verification === 'rejected' && a.loi_verification_status !== 'rejected') fail('verification_status', 'Use the Reject action to reject an applicant. Verification can only be Not verified or Verified.');
}

applicantRoutes.patch('/applicants/:applicant/status', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    status: ['required', `in:${STATUSES}`],
    remarks: ['nullable', 'string'],
    loi_submission_date: ['nullable', 'date', 'before_or_equal:today'],
    loi_received_by: ['nullable', 'string', 'max:255'],
    loi_submission_type: ['nullable', 'in:physical,email,digital,other'],
    loi_verification_status: ['nullable', 'in:not_verified,verified,rejected'],
    loi_remarks: ['nullable', 'string'],
  });
  assertLoiOptions(a, v.loi_submission_type, v.loi_verification_status);
  // Verification is its own Admin step at the LOI stage, after Sales uploads the scan.
  if (v.status === 'loi_submitted' && v.loi_verification_status === 'verified') {
    fail('loi_verification_status', 'The LOI is verified at the LOI stage, after the assigned Sales user uploads the scan.');
  }
  await assertTransition(db, a, v.status, user, v.remarks ?? null);
  let attributes: Row = {};
  if (v.status === 'loi_submitted') {
    attributes = {
      loi_confirmed_at: new Date(), loi_confirmed_by_user_id: user.id, loi_remarks: v.loi_remarks ?? v.remarks ?? null,
      loi_submission_date: v.loi_submission_date ?? manilaToday(), loi_received_by: v.loi_received_by ?? user.full_name,
      loi_submission_type: v.loi_submission_type ?? 'physical', loi_verification_status: v.loi_verification_status ?? 'not_verified',
    };
  } else if (a.status === 'loi_submitted') {
    attributes = { loi_confirmed_at: null, loi_confirmed_by_user_id: null, loi_remarks: null };
  }
  await transition(c, db, a, v.status, user, v.remarks ?? null, 'applicant.status_changed', attributes);
  if (a.user_id) await notifyUser(db, a.user_id, 'applicant_status', 'Application status updated', `Your application is now ${v.status}.`, { applicant_id: a.id, status: v.status });
  return ok(c, await freshWithHistory(db, a.id), 'Applicant status updated.');
});

applicantRoutes.post('/applicants/:applicant/revise', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const v = await validate(db, await readInput(c), {
    stage: ['required', 'in:qualified,scheduled,loi_submitted,payment_submitted'],
    remarks: ['required', 'string', 'max:2000'],
  });
  if (a.status !== 'for_approval') fail('stage', 'Revision can only be requested while the applicant is at the For Approval stage.');
  const reason = requireReason(v.remarks, 'remarks', 'a return reason');
  await transition(c, db, a, v.stage, c.get('user'), `Returned to ${stageLabel(v.stage)} for revision: ${reason}`, 'applicant.revision_requested', { reviewed_at: null, reviewed_by_user_id: null, review_remarks: null });
  return ok(c, await fresh(db, a.id), 'Applicant returned for revision.');
});

applicantRoutes.post('/applicants/:applicant/review', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  if (a.status !== 'for_approval') fail('status', 'The Review step is only available at the "For Approval" stage.');
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string'] });
  const saved = await updateRow(db, 'applicants', a.id, { reviewed_at: new Date(), reviewed_by_user_id: c.get('user').id, review_remarks: v.remarks ?? null });
  await audit(c, db, 'applicant.reviewed', { type: APPLICANT_MODEL, id: a.id }, { reviewed_at: iso(a.reviewed_at) }, { reviewed_at: iso(saved!.reviewed_at), remarks: v.remarks ?? null });
  return ok(c, applicantJson(saved!), 'Review confirmed. Approval is now checked.');
});

applicantRoutes.post('/applicants/:applicant/approve', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string'] });
  const remarks = v.remarks ?? 'Approved by Admin.';
  await assertTransition(db, a, 'approved', c.get('user'), remarks, true);
  await transition(c, db, a, 'approved', c.get('user'), remarks, 'applicant.approved');
  return ok(c, await freshWithHistory(db, a.id), 'Applicant approved.');
});

applicantRoutes.post('/applicants/:applicant/activate', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const user = c.get('user');
  if (a.status === 'approved') await assertStageRequirements(db, a.id, 'activation');
  await assertTransition(db, a, 'active_franchisee', user, 'Marked as active franchisee.', true);
  const [owner] = a.user_id ? await db.query(`select u.account_status, r.name as role_name from users u join roles r on r.id = u.role_id where u.id = $1`, [a.user_id]) : [];
  if (!owner || owner.role_name !== 'franchisee' || owner.account_status !== 'active') {
    fail('account', 'Create an active Franchisee branch account before marking this applicant as an Active Franchisee.');
  }
  const v = await validate(db, await readInput(c), { business_name: ['nullable', 'string', 'max:255'] });
  const franchisee = await db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from applicants where id = $1 for update`, [a.id]);
    const [existing] = await tx.query(`select * from franchisees where applicant_id = $1 limit 1`, [a.id]);
    const fields = {
      user_id: locked.user_id, business_name: v.business_name ?? existing?.business_name ?? locked.full_name, franchise_status: 'active',
      approval_date: locked.approved_at ? new Date(locked.approved_at).toISOString().slice(0, 10) : manilaToday(),
    };
    const row = existing ? await updateRow(tx, 'franchisees', existing.id, fields) : await insertRow(tx, 'franchisees', { applicant_id: a.id, ...fields });
    if (locked.status !== 'active_franchisee') await transition(c, tx, locked, 'active_franchisee', user, 'Marked as active franchisee.', 'applicant.activated');
    await provisionBranch(tx, row!.id);
    return row!;
  });
  const [appRow] = await db.query(`select * from applicants where id = $1`, [a.id]);
  const [owned] = await db.query(`select * from users where id = $1`, [franchisee.user_id]);
  const locations = await db.query(`select l.*, (select to_jsonb(b) from brands b where b.id = l.brand_id) as brand from franchise_locations l where l.franchisee_id = $1 order by l.id`, [franchisee.id]);
  return ok(c, { ...franchisee, applicant: applicantJson(appRow), user: owned ? publicUser(owned) : null, locations }, 'Applicant marked as an active franchisee.');
});

applicantRoutes.post('/applicants/:applicant/portal-user', admin, async (c) => {
  const { db, auth } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const actor = c.get('user');
  if (!['approved', 'active_franchisee'].includes(a.status)) fail('applicant', 'A branch account can only be created for an approved applicant or an active franchisee.');
  if (a.user_id) return c.json({ message: 'The applicant already has a portal account.' }, 422);
  // The password is generated by the system (services/credentials.ts) and returned once;
  // a password sent by an older client is ignored.
  const v = await validate(db, await readInput(c), {
    email: ['required', 'email', 'max:255', 'unique:users,email'],
    phone: ['nullable'],
  });
  const phone = cleanOptionalPhone(v.phone);
  const email = String(v.email).toLowerCase();
  const [roleRow] = await db.query(`select id from roles where name = 'franchisee'`);
  const { password, delivery } = issueInitialCredentials(c, email);
  // The sign-in is created first; if the business rules then refuse, it is removed again.
  const user = await createAccount(c, { role_id: roleRow.id, full_name: a.full_name, email, phone, account_status: 'active', must_change_password: true }, password);
  try {
    await db.tx(async (tx) => {
      const [locked] = await tx.query(`select * from applicants where id = $1 for update`, [a.id]);
      if (!['approved', 'active_franchisee'].includes(locked.status) || locked.user_id) fail('applicant', 'The applicant must still be approved and must not already have a portal account.');
      const [existing] = await tx.query(`select * from franchisees where applicant_id = $1 limit 1`, [a.id]);
      if (existing?.user_id) fail('applicant', 'A franchise account is already linked to another portal account; contact an administrator.');
      await updateRow(tx, 'applicants', a.id, { user_id: user.id, email, ...(phone ? { phone } : {}) });
      const approval = locked.approved_at ? new Date(locked.approved_at).toISOString().slice(0, 10) : manilaToday();
      const franchisee = existing
        ? await updateRow(tx, 'franchisees', existing.id, { user_id: user.id, franchise_status: 'active' })
        : await insertRow(tx, 'franchisees', { applicant_id: a.id, business_name: locked.full_name, approval_date: approval, user_id: user.id, franchise_status: 'active' });
      if (locked.status === 'approved') {
        await assertStageRequirements(tx, a.id, 'activation');
        await assertTransition(tx, locked, 'active_franchisee', actor, 'Branch portal account created.', true);
        await transition(c, tx, locked, 'active_franchisee', actor, 'Branch portal account created.', 'applicant.activated');
      }
      await provisionBranch(tx, franchisee!.id);
    });
  } catch (error) {
    await db.query(`delete from users where id = $1`, [user.id]).catch(() => {});
    await auth.deleteUser(user.auth_user_id).catch(() => {});
    throw error;
  }
  await audit(c, db, 'applicant.portal_user_created', { type: APPLICANT_MODEL, id: a.id }, null, { user_id: user.id });
  await audit(c, db, 'user.created', { type: 'App\\Models\\User', id: user.id }, null,
    accountAuditValues(user, 'franchisee', delivery, { applicant_id: a.id, applicant_code: a.applicant_code ?? null }));
  const [roleJson] = await db.query(`select * from roles where id = $1`, [user.role_id]);
  return ok(c, { ...publicUser(user), role: roleJson, credentials: delivery }, 'Applicant portal account created.', 201);
});

// ---- LOI ----
applicantRoutes.post('/applicants/:applicant/loi', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), {
    file: ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png', `max:${MAX_UPLOAD_KB}`],
    submission_date: ['nullable', 'date', 'before_or_equal:today'],
    received_by: ['nullable', 'string', 'max:255'],
    submission_type: ['nullable', 'in:physical,email,digital,other'],
    verification_status: ['nullable', 'in:not_verified,verified,rejected'],
    remarks: ['nullable', 'string'],
  });
  assertLoiOptions(a, v.submission_type, v.verification_status);
  const name = roleName(c);
  if (name === 'franchisee') abort(403, 'Branch accounts cannot change LOI data.');
  if (a.archived_at) fail('applicant', 'An archived applicant cannot change its LOI.');
  if (!loiStageOpen(a)) fail('loi', 'LOI data can only be changed at the LOI stage (or for a Pending LOI at the Payment stage).');

  const DETAILS = { submission_date: 'loi_submission_date', received_by: 'loi_received_by', submission_type: 'loi_submission_type' } as const;
  const sameDay = (x: unknown, y: unknown) => String(x ?? '').slice(0, 10) === String(y ?? '').slice(0, 10);
  const changedDetails = (Object.entries(DETAILS) as [keyof typeof DETAILS, string][])
    .filter(([key, column]) => v[key] !== undefined && v[key] !== null && !(key === 'submission_date' ? sameDay(v[key], a[column]) : String(v[key]) === String(a[column] ?? '')));
  const verificationChange = v.verification_status !== undefined && v.verification_status !== null && v.verification_status !== (a.loi_verification_status ?? 'not_verified');

  if (name === 'admin') {
    // Admin only verifies: the scan and the LOI details come from the assigned Sales user.
    if (v.file || changedDetails.length) abort(403, 'Only the assigned Sales user records the LOI details and uploads the scan. Admin only verifies the LOI.');
    if (verificationChange && v.verification_status === 'verified') {
      const loi = await loiRequirement(db, a);
      if (!loi.scan) fail('verification_status', 'There is no LOI scan to verify yet. The assigned Sales user must upload it first.');
      if (loi.status === 'returned') fail('verification_status', 'This scan was returned. Wait for the corrected scan from Sales.');
    }
  } else {
    await assertAssignedSales(c, a);
    if (verificationChange) abort(403, 'Only Admin can set the LOI verification.');
    if (v.file && (a.loi_verification_status === 'verified' || a.loi_status === 'complete')) {
      fail('file', 'The LOI is already verified. Admin must set it back to Not verified before the scan can be replaced.');
    }
  }

  const earlier = await db.query(
    `select id, original_name, type from documents where documentable_type = $1 and documentable_id = $2 and type = 'loi' and removed_at is null and replaced_at is null`,
    [APPLICANT_MODEL, a.id],
  );
  const changes: Row = {};
  for (const [key, column] of Object.entries(DETAILS)) if (changedDetails.some(([k]) => k === key)) changes[column] = v[key];
  if (name === 'sales') {
    // The first save by Sales fills the defaults the old record may not have.
    changes.loi_submission_date ??= a.loi_submission_date ?? manilaToday();
    changes.loi_received_by ??= a.loi_received_by ?? user.full_name;
    changes.loi_submission_type ??= a.loi_submission_type ?? 'physical';
  }
  if (verificationChange) changes.loi_verification_status = v.verification_status;
  if (v.remarks !== undefined && v.remarks !== null && v.remarks !== a.loi_remarks) changes.loi_remarks = v.remarks;

  const { document, saved } = await db.tx(async (tx) => {
    const stored = v.file
      ? await storeDocument(c, tx, v.file, `applicants/${a.id}/loi`, { type: APPLICANT_MODEL, id: a.id }, 'loi', { submission_date: changes.loi_submission_date ?? a.loi_submission_date ?? manilaToday() })
      : null;
    if (stored && earlier.length) {
      // A replacement keeps the old file, marked Replaced.
      await tx.query(`update documents set replaced_at = now(), replaced_by_document_id = $1 where id = any($2::bigint[])`, [stored.id, `{${earlier.map((d) => d.id).join(',')}}`]);
    }
    const row = Object.keys(changes).length ? (await updateRow(tx, 'applicants', a.id, changes))! : a;
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, a[k] ?? null]));
    if (Object.keys(changes).filter((k) => k !== 'loi_verification_status').length || stored) {
      await logEvent(tx, row, stored ? (earlier.length ? 'loi_replaced' : 'loi_uploaded') : 'loi_details_saved', user.id,
        { loi_status: row.loi_status, replaces_document_ids: earlier.map((d) => d.id) },
        stored ? (earlier.length ? 'LOI scan replaced.' : 'LOI scan uploaded.') : 'LOI details saved.', {
          step: 'loi',
          old_values: Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'loi_verification_status')),
          new_values: Object.fromEntries(Object.entries(changes).filter(([k]) => k !== 'loi_verification_status')),
          attachments: [fileRef(stored), ...earlier.map((d) => ({ ...fileRef(d), state: 'replaced' }))].filter(Boolean) as Row[],
        });
    }
    if (verificationChange) {
      await logEvent(tx, row, 'loi_verification_changed', user.id, {}, v.remarks ?? null, {
        step: 'loi', old_values: { loi_verification_status: a.loi_verification_status ?? 'not_verified' }, new_values: { loi_verification_status: v.verification_status },
      });
    }
    return { document: stored, saved: row };
  });
  if (document) {
    await notifyRoles(db, ['admin'], 'loi_uploaded', 'LOI scan uploaded', `${user.full_name} uploaded the Letter of Intent scan for ${a.full_name}. Review and verify it.`, { applicant_id: a.id, document_id: document.id }, user);
  }
  if (verificationChange) {
    await notifyAssignedSales(db, saved, 'loi_verification', 'LOI verification updated', `Admin set the LOI of ${a.full_name} to ${String(v.verification_status).replace('_', ' ')}.`, {}, user);
  }
  await audit(c, db, 'applicant.loi_recorded', { type: APPLICANT_MODEL, id: a.id }, pick(a, Object.keys(changes)), {
    document_id: document?.id ?? null, ...pick(saved, ['loi_submission_date', 'loi_received_by', 'loi_submission_type', 'loi_verification_status']),
  });
  return ok(c, document ?? applicantJson(saved), document ? 'LOI record saved with attachment.' : 'LOI record saved.', document ? 201 : 200);
});

/** The LOI is open at the LOI stage, and for a Pending LOI at the Payment stage. */
const loiStageOpen = (a: Row) => a.status === 'loi_submitted' || (a.status === 'payment_submitted' && loiPending(a));

/** Admin returns the LOI scan to Sales with a reason (the LOI requirement becomes Returned). */
applicantRoutes.post('/applicants/:applicant/loi/return', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  if (a.archived_at || !loiStageOpen(a)) fail('loi', 'The LOI can only be returned at the LOI stage (or for a Pending LOI at the Payment stage).');
  const loi = await loiRequirement(db, a);
  if (loi.status !== 'submitted') fail('loi', loi.status === 'accepted' ? 'The LOI is already verified.' : 'There is no LOI scan waiting for review.');
  const reason = requireReason(v.reason, 'reason', 'a return reason');
  await db.tx(async (tx) => {
    const saved = (await updateRow(tx, 'applicants', a.id, {
      loi_verification_status: 'not_verified', loi_returned_at: new Date(), loi_returned_by_user_id: user.id, loi_return_reason: reason,
    }))!;
    await logEvent(tx, saved, 'loi_returned', user.id, { document_id: loi.scan?.id ?? null }, reason, {
      step: 'loi', old_values: { loi_verification_status: a.loi_verification_status, requirement: 'submitted' }, new_values: { loi_verification_status: 'not_verified', requirement: 'returned' },
      attachments: loi.scan ? [{ document_id: loi.scan.id, original_name: loi.scan.original_name, type: 'loi', state: 'returned' }] : [],
    });
    await audit(c, tx, 'applicant.loi_returned', { type: APPLICANT_MODEL, id: a.id }, { loi_verification_status: a.loi_verification_status }, { reason });
  });
  await notifyAssignedSales(db, a, 'loi_returned', 'LOI returned', `Admin returned the LOI scan of ${a.full_name}: ${reason}`, {}, user);
  return ok(c, await freshWithHistory(db, a.id), 'LOI returned to Sales.');
});

applicantRoutes.post('/applicants/:applicant/loi/complete', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string', 'max:2000'] });
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be moved forward.');

  if (a.status === 'payment_submitted' && loiPending(a)) {
    await assertLoiCompletable(db, a);
    await db.tx(async (tx) => {
      const saved = await updateRow(tx, 'applicants', a.id, { loi_status: 'complete', loi_completed_at: new Date(), loi_completed_by_user_id: user.id });
      await logEvent(tx, saved!, 'loi_completed', user.id, { submission_type: a.loi_submission_type, completed_after_proceed: true }, 'Pending LOI completed at the Payment Record stage.');
      await audit(c, tx, 'applicant.loi_completed', { type: APPLICANT_MODEL, id: a.id }, { loi_status: 'pending' }, { loi_status: 'complete' });
    });
    return ok(c, await freshWithHistory(db, a.id), 'LOI Complete — For Approval is no longer blocked by the LOI.');
  }
  if (a.status !== 'loi_submitted') fail('status', 'Only an applicant at LOI Submission (or a Pending LOI at the Payment Record stage) can be completed.');
  await assertLoiCompletable(db, a);
  const remarks = String(v.remarks ?? '').trim() ? v.remarks : 'LOI verified and confirmed by Admin.';
  await assertTransition(db, a, 'payment_submitted', user, remarks, true);
  const saved = await transition(c, db, a, 'payment_submitted', user, remarks, 'applicant.loi_completed', {
    payment_stage_state: a.payment_stage_state ?? 'waiting_total', loi_status: 'complete', loi_completed_at: new Date(), loi_completed_by_user_id: user.id,
  });
  await logEvent(db, saved, 'loi_completed', user.id, { submission_type: a.loi_submission_type }, 'LOI Complete.');
  if (a.user_id) await notifyUser(db, a.user_id, 'applicant_status', 'Application status updated', 'Your Letter of Intent has been verified. Submit your payment requirements next.', { applicant_id: a.id, status: 'payment_submitted' });
  return ok(c, await freshWithHistory(db, a.id), 'LOI verified — the applicant is now at the Payment Record stage.');
});

applicantRoutes.post('/applicants/:applicant/loi/proceed', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string', 'max:2000'] });
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be moved forward.');
  if (a.status !== 'loi_submitted') fail('status', '[Proceed] is only available at the LOI Submission stage.');
  assertLoiProceedable(a);
  const remarks = String(v.remarks ?? '').trim() ? v.remarks : 'LOI Pending — soft copy to follow. Proceeded to Payment Record by Admin.';
  await assertTransition(db, a, 'payment_submitted', user, remarks, true);
  await db.tx(async (tx) => {
    const saved = await transition(c, tx, a, 'payment_submitted', user, remarks, 'applicant.loi_proceeded', {
      payment_stage_state: a.payment_stage_state ?? 'waiting_total', loi_status: 'pending', loi_proceeded_at: new Date(), loi_proceeded_by_user_id: user.id,
    });
    const hasImage = (await tx.query(`select 1 from documents where documentable_type = $1 and documentable_id = $2 and type = 'loi' limit 1`, [APPLICANT_MODEL, a.id])).length > 0;
    await logEvent(tx, saved, 'loi_proceeded', user.id, { submission_type: a.loi_submission_type, has_image: hasImage, verification_status: a.loi_verification_status }, 'LOI Pending — must be completed before For Approval.');
  });
  if (a.user_id) await notifyUser(db, a.user_id, 'applicant_status', 'Application status updated', 'You can now submit your payment requirements. Please send the soft copy of your Letter of Intent as well.', { applicant_id: a.id, status: 'payment_submitted' });
  return ok(c, await freshWithHistory(db, a.id), 'Moved to Payment Record with the LOI Pending. Come back to the LOI section to upload the image, verify it and click Complete — For Approval stays blocked until then.');
});

// ---- documents ----
const loadDocument = async (c: Context<AppEnv>, type: string, ownerId: number): Promise<Row> => {
  const [d] = await c.get('deps').db.query(`select * from documents where id = $1 and documentable_type = $2 and documentable_id = $3`, [routeId(c, 'document'), type, ownerId]);
  return requireFound(d);
};

applicantRoutes.get('/applicants/:applicant/documents/:document/download', viewers, async (c) => {
  const a = await load(c);
  authorize(c, a);
  if (!canSeeRequirementFiles(c.get('user'), a)) abort(403, 'Only Admin and the assigned Sales user can open applicant files.');
  return downloadDocument(c, await loadDocument(c, APPLICANT_MODEL, a.id));
});

applicantRoutes.delete('/applicants/:applicant/documents/:document', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  requireRole(c, ['admin']);
  const d = await loadDocument(c, APPLICANT_MODEL, a.id);
  if (d.removed_at) return ok(c, null, 'Document was already removed.');
  if (d.type === 'loi' && (a.loi_verification_status === 'verified' || a.loi_status === 'complete' || !loiStageOpen(a))) {
    fail('document', 'The LOI scan is locked: it is verified, complete, or the applicant is past the LOI stage. Upload a replacement instead; the old file stays in the history.');
  }
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  const reason = optionalReason(v.reason, 'reason');
  // Never hard-deleted while linked to the applicant: the row and the stored file stay, marked Removed.
  await db.query(`update documents set removed_at = now(), removed_by_user_id = $1, removed_reason = $2 where id = $3`, [c.get('user').id, reason, d.id]);
  await logEvent(db, a, d.type === 'loi' ? 'loi_image_removed' : 'document_removed', c.get('user').id, {}, reason, {
    step: d.type === 'loi' ? 'loi' : 'documents',
    old_values: { document_id: d.id, uploaded_by_user_id: d.uploaded_by_user_id, uploaded_at: iso(d.created_at) },
    attachments: [{ ...fileRef(d), state: 'removed' }],
  });
  await audit(c, db, 'applicant.document_removed', { type: APPLICANT_MODEL, id: a.id }, { document_id: d.id, original_name: d.original_name, type: d.type }, { reason });
  return ok(c, null, 'Document removed.');
});

applicantRoutes.get('/applicants/:applicant/payments/:payment/documents/:document/download', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a);
  if (!canSeeRequirementFiles(c.get('user'), a)) abort(403, 'Only Admin and the assigned Sales user can open payment receipts.');
  const [p] = await db.query(`select id from payments where id = $1 and applicant_id = $2`, [routeId(c, 'payment'), a.id]);
  requireFound(p);
  return downloadDocument(c, await loadDocument(c, PAYMENT_MODEL, p.id));
});

// ---- payments ----
const entryRules = {
  amount: ['required', 'numeric', 'gt:0'],
  payment_date: ['required', 'date'],
  payment_type: ['nullable', `in:${PAYMENT_TYPE_VALUES}`],
  payment_method: ['nullable', `in:${payments.PAYMENT_METHODS.join(',')}`],
  remarks: ['nullable', 'string', 'max:2000'],
};
const REQUEST_MODEL = 'App\\Models\\PaymentRequest';

applicantRoutes.post('/applicants/:applicant/payments', sales, async (c) => {
  if (!paymentAdvanced(c)) fail('payments', 'Record each payment with Add payment entry (date, amount, method, OR/AR number, reference number and receipt).');
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  await assertAssignedSales(c, a);
  const user = c.get('user');
  const input = await readInput(c);
  if (a.payment_stage_state !== null) {
    const v = await validate(db, input, entryRules);
    const request = await payments.submitReport(db, a.id, user, [v]);
    await audit(c, db, 'payment.report_submitted', { type: REQUEST_MODEL, id: request.id }, null, request);
    return ok(c, request, 'Sales Report sent to Admin for confirmation.', 201);
  }
  // Records from before the Payment Record state machine.
  if (!['loi_submitted', 'for_approval', 'approved'].includes(a.status)) fail('status', 'Payments may be recorded after LOI submission.');
  if ((await db.query(`select 1 from payments where applicant_id = $1 and status in ('pending', 'for_revision') limit 1`, [a.id])).length) fail('status', 'A payment report is already awaiting Admin review.');
  const v = await validate(db, input, {
    payment_type: ['required', 'string', 'max:50'],
    payment_method: ['nullable', 'string', 'max:100'],
    amount: ['required', 'numeric', 'gt:0'],
    payment_date: ['required', 'date'],
    department: ['nullable', 'string', 'in:Sales'],
    remarks: ['nullable', 'string'],
    receipt: ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png', `max:${MAX_UPLOAD_KB}`],
  });
  const first = a.status === 'loi_submitted';
  if (first) await assertTransition(db, a, 'payment_submitted', user, v.remarks ?? null, true);
  const payment = await db.tx(async (tx) => {
    const row = await insertRow(tx, 'payments', {
      applicant_id: a.id, payment_type: v.payment_type, department: v.department ?? 'Sales', requested_at: new Date(), payment_method: v.payment_method ?? null,
      amount: v.amount, payment_date: v.payment_date, status: 'pending', recorded_by_user_id: user.id, remarks: v.remarks ?? null,
    });
    await payments.syncLedger(tx, row);
    if (v.receipt) await storeDocument(c, tx, v.receipt, `applicants/${a.id}/payments`, { type: PAYMENT_MODEL, id: row.id }, 'payment_receipt');
    return row;
  });
  if (first) await transition(c, db, a, 'payment_submitted', user, v.remarks ?? 'Payment confirmation requested by Sales.', 'applicant.payment_requested');
  await notifyRoles(db, ['admin'], 'payment_submitted', 'Payment confirmation requested', `Sales submitted a payment report for ${a.full_name}.`, { applicant_id: a.id, payment_id: payment.id });
  await audit(c, db, 'applicant.payment_recorded', { type: PAYMENT_MODEL, id: payment.id }, null, payment);
  return ok(c, { ...payment, documents: await paymentDocuments(db, payment.id) }, 'Payment report sent to Admin.', 201);
});

const paymentDocuments = (db: Db, id: number) => db.query(`select * from documents where documentable_type = $1 and documentable_id = $2 order by id`, [PAYMENT_MODEL, id]);

applicantRoutes.put('/applicants/:applicant/payments/:payment', sales, async (c) => {
  if (!paymentAdvanced(c)) fail('payments', 'A payment entry cannot be edited after it is submitted. Admin returns it and Sales records a corrected entry.');
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  await assertAssignedSales(c, a);
  const user = c.get('user');
  if (a.payment_stage_state !== null) fail('payment', 'This payment belongs to the Payment Record stage — use Edit or Delete on the payment record instead.');
  const [p] = await db.query(`select * from payments where id = $1`, [routeId(c, 'payment')]);
  requireFound(p);
  if (p.applicant_id !== a.id) abort(404, 'Record not found.');
  if (p.status !== 'for_revision' || p.recorded_by_user_id !== user.id) fail('payment', 'Only your own payment returned For Revision can be edited.');
  const v = await validate(db, await readInput(c), {
    payment_type: ['sometimes', 'required', 'string', 'max:50'],
    payment_method: ['sometimes', 'nullable', 'string', 'max:100'],
    amount: ['sometimes', 'required', 'numeric', 'gt:0'],
    payment_date: ['sometimes', 'required', 'date'],
    remarks: ['sometimes', 'nullable', 'string'],
    receipt: ['sometimes', 'nullable', 'file', 'mimes:pdf,jpg,jpeg,png', `max:${MAX_UPLOAD_KB}`],
  });
  const { receipt, ...changes } = v;
  const saved = await db.tx(async (tx) => {
    const row = await updateRow(tx, 'payments', p.id, { ...changes, status: 'pending', verified_by_user_id: null, verified_at: null, requested_at: new Date() });
    await payments.syncLedger(tx, row!);
    if (receipt) await storeDocument(c, tx, receipt, `applicants/${a.id}/payments`, { type: PAYMENT_MODEL, id: p.id }, 'payment_receipt');
    return row!;
  });
  await audit(c, db, 'applicant.payment_revised', { type: PAYMENT_MODEL, id: p.id }, p, saved);
  return ok(c, { ...saved, documents: await paymentDocuments(db, p.id) }, 'Payment revision resubmitted to Admin.');
});

applicantRoutes.patch('/applicants/:applicant/payments/:payment/verify', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  const user = c.get('user');
  const [p] = await db.query(`select * from payments where id = $1`, [routeId(c, 'payment')]);
  requireFound(p);
  if (p.applicant_id !== a.id) abort(404, 'Record not found.');
  if (a.payment_stage_state !== null) fail('payment', 'Use Confirm payment or Return to Sales in the Payment Record stage.');
  const v = await validate(db, await readInput(c), {
    status: ['required', 'in:verified,for_revision,rejected'],
    remarks: ['required_if:status,for_revision,rejected', 'nullable', 'string'],
  });
  if (['for_revision', 'rejected'].includes(v.status)) v.remarks = requireReason(v.remarks, 'remarks', 'a return reason');
  // With the advanced features off, this older review only marks the entry: it never moves the stage.
  // The applicant then finishes through the Payment Record (Agreed Package Amount, then COMPLETED when Fully Paid).
  const moveStage = paymentAdvanced(c);
  if (!moveStage && v.status === 'rejected') fail('status', `${OFF_MESSAGE} Return the entry (For revision) instead of rejecting the payment request.`);
  if (!['pending', 'for_revision'].includes(p.status)) fail('payment', 'Only payments awaiting verification can be reviewed.');
  if (v.status === 'rejected' && a.status !== 'payment_submitted') fail('status', 'Only an initial payment request at the "Payment Submitted" stage can be rejected; later installments remain at their current stage.');
  await db.tx(async (tx) => {
    const saved = await updateRow(tx, 'payments', p.id, { status: v.status, verified_by_user_id: user.id, verified_at: new Date(), remarks: v.remarks ?? p.remarks });
    await payments.syncLedger(tx, saved!);
    await logEvent(tx, a, 'payment_entry_reviewed', user.id, { payment_id: p.id }, v.remarks ?? null, {
      step: 'payment_record', old_values: { payment_id: p.id, status: p.status }, new_values: { payment_id: p.id, status: v.status },
    });
    if (moveStage && v.status === 'verified' && a.status === 'payment_submitted') {
      const remarks = v.remarks ?? 'Payment verified by Admin.';
      await assertTransition(tx, a, 'for_approval', user, remarks, true);
      await transition(c, tx, a, 'for_approval', user, remarks, 'applicant.payment_confirmed', { payment_confirmed_at: new Date(), payment_confirmed_by_user_id: user.id, payment_remarks: v.remarks ?? null });
    } else if (v.status === 'rejected') {
      await transition(c, tx, a, 'loi_submitted', user, `Payment request rejected. ${v.remarks ?? 'Sales may submit a new request.'}`, 'applicant.payment_request_rejected');
    }
    await audit(c, tx, 'payment.verified', { type: PAYMENT_MODEL, id: p.id }, p, saved);
  });
  const [row] = await db.query(`select p.*, ${NAME('p.verified_by_user_id')} as verified_by from payments p where p.id = $1`, [p.id]);
  return ok(c, { ...row, documents: await paymentDocuments(db, p.id) }, 'Payment review saved.');
});

applicantRoutes.patch('/applicants/:applicant/payments/:payment', sales, async (c) => {
  if (!paymentAdvanced(c)) fail('payments', 'A payment entry cannot be edited after it is submitted. Admin returns it and Sales records a corrected entry.');
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  await assertAssignedSales(c, a);
  const id = routeId(c, 'payment');
  const [p] = await db.query(`select * from payments where id = $1`, [id]);
  requireFound(p);
  const v = await validate(db, await readInput(c), {
    amount: ['sometimes', 'required', 'numeric', 'gt:0'],
    payment_date: ['sometimes', 'required', 'date'],
    payment_type: ['sometimes', 'required', `in:${PAYMENT_TYPE_VALUES}`],
    remarks: ['sometimes', 'nullable', 'string', 'max:2000'],
  });
  const request = await payments.requestChange(db, a.id, id, c.get('user'), 'update', v);
  await audit(c, db, 'payment.change_requested', { type: REQUEST_MODEL, id: request.id }, p, request);
  return ok(c, request, 'Edit request sent to Admin for approval.', 202);
});

applicantRoutes.delete('/applicants/:applicant/payments/:payment', sales, async (c) => {
  if (!paymentAdvanced(c)) fail('payments', 'A payment entry cannot be deleted. Admin returns it and Sales records a corrected entry.');
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  await assertAssignedSales(c, a);
  const id = routeId(c, 'payment');
  const [p] = await db.query(`select * from payments where id = $1`, [id]);
  requireFound(p);
  const request = await payments.requestChange(db, a.id, id, c.get('user'), 'delete');
  await audit(c, db, 'payment.delete_requested', { type: REQUEST_MODEL, id: request.id }, p, request);
  return ok(c, request, 'Delete request sent to Admin for approval.', 202);
});

applicantRoutes.post('/applicants/:applicant/payments/report', sales, async (c) => {
  if (!paymentAdvanced(c)) fail('payments', OFF_MESSAGE);
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  await assertAssignedSales(c, a);
  const input = await readInput(c);
  const list = await validate(db, input, { entries: ['required', 'array', 'min:1', 'max:20'] });
  const entries = await validateEach(db, list.entries, 'entries', entryRules);
  const request = await payments.submitReport(db, a.id, c.get('user'), entries);
  await audit(c, db, 'payment.report_submitted', { type: REQUEST_MODEL, id: request.id }, null, request);
  return ok(c, request, 'Sales Report sent to Admin. The payment is not saved until Admin clicks SAVE APPLICANT.', 201);
});

applicantRoutes.post('/applicants/:applicant/payments/apply-report', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string', 'max:2000'] });
  const saved = await payments.applyReport(db, a.id, c.get('user'), v.remarks ?? null);
  await audit(c, db, 'payment.report_applied', { type: APPLICANT_MODEL, id: a.id }, a, saved);
  return ok(c, await freshWithHistory(db, a.id), 'Sales Report confirmed and saved to the applicant record.');
});

applicantRoutes.post('/applicants/:applicant/payments/complete', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const user = c.get('user');
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string', 'max:2000'] });
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be moved forward.');
  if (a.status === 'payment_submitted' && loiPending(a)) fail('loi', LOI_PENDING_BLOCK);
  const already = a.payment_stage_state === 'confirmed';
  const confirmed = await payments.completePayment(db, a.id, user, v.remarks ?? null, async (tx, locked) => {
    if (locked.status !== 'payment_submitted') return;
    const remarks = String(v.remarks ?? '').trim() ? v.remarks : 'Payment confirmed by Admin.';
    await assertTransition(tx, locked, 'for_approval', user, remarks, true);
    await transition(c, tx, locked, 'for_approval', user, remarks, 'applicant.payment_confirmed', { payment_remarks: v.remarks ?? null });
  });
  await audit(c, db, 'payment.completed', { type: APPLICANT_MODEL, id: a.id }, null, confirmed);
  return ok(c, await freshWithHistory(db, a.id), already ? 'Payment was already confirmed — nothing changed.' : 'Payment completed — the applicant is now at For Approval.');
});

applicantRoutes.post('/applicants/:applicant/payments/return', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const v = await validate(db, await readInput(c), { note: ['required', 'string', 'max:2000'] });
  const saved = await payments.returnToSales(db, a.id, c.get('user'), v.note);
  await audit(c, db, 'payment.returned', { type: APPLICANT_MODEL, id: a.id }, a, saved);
  return ok(c, applicantJson(saved), 'Payment returned to Sales.');
});

applicantRoutes.patch('/applicants/:applicant/payment-plan', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  if (!paymentAdvanced(c)) {
    const input = await readInput(c);
    const hidden = ['discount_percent', 'promo_name', 'initial_payment_amount', 'original_total_required_amount', 'other_fees', 'payment_terms'].filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '');
    if (hidden.length) fail(hidden[0], OFF_MESSAGE);
    const saved = await setAgreedAmount(db, a.id, c.get('user'), { ...input, agreed_amount: input.agreed_amount ?? input.total_required_amount });
    await audit(c, db, 'applicant.agreed_amount_set', { type: APPLICANT_MODEL, id: a.id }, { total_required_amount: a.total_required_amount }, { total_required_amount: saved.total_required_amount, reason: input.reason ?? null });
    const [row] = await db.query(`select a.*, (select to_jsonb(p) from applicant_payment_plans p where p.applicant_id = a.id limit 1) as payment_plan from applicants a where a.id = $1`, [a.id]);
    return ok(c, applicantJson(row), 'Agreed Package Amount saved.');
  }
  const v = await validate(db, await readInput(c), {
    package_name: ['sometimes', 'nullable', 'string', 'max:255'],
    total_required_amount: ['sometimes', 'required', 'numeric', 'gt:0'],
    original_total_required_amount: ['sometimes', 'required', 'numeric', 'gt:0'],
    discount_percent: ['sometimes', 'nullable', 'integer', 'between:0,100'],
    initial_payment_amount: ['sometimes', 'nullable', 'numeric', 'min:0'],
    other_fees: ['sometimes', 'numeric', 'min:0'],
    payment_terms: ['sometimes', 'nullable', 'string', 'max:2000'],
    promo_name: ['sometimes', 'nullable', 'string', 'max:120'],
  });
  const saved = await payments.setTotal(db, a.id, c.get('user'), v);
  await audit(c, db, 'applicant.payment_plan_updated', { type: APPLICANT_MODEL, id: a.id }, a, saved);
  const [row] = await db.query(`select a.*, (select to_jsonb(p) from applicant_payment_plans p where p.applicant_id = a.id limit 1) as payment_plan, ${NAME('a.total_required_set_by_user_id')} as total_set_by from applicants a where a.id = $1`, [a.id]);
  return ok(c, applicantJson(row), 'Payment plan updated.');
});

applicantRoutes.patch('/applicants/:applicant/payment-schedule', admin, async (c) => {
  if (!paymentAdvanced(c)) fail('payments', OFF_MESSAGE);
  const { db } = c.get('deps');
  const a = await load(c);
  authorize(c, a, true);
  const v = await validate(db, await readInput(c), {
    frequency: ['required', 'string', `in:${Object.keys(payments.FREQUENCIES).join(',')}`],
    custom_days: ['nullable', 'integer', 'between:1,365'],
    first_due_date: ['required', 'date'],
  });
  await payments.setSchedule(db, a.id, c.get('user'), v);
  return ok(c, { payment_stage: await payments.stagePayload(db, a, c.get('user')) }, 'Installment plan saved.');
});

export { isPaymentFullyDiscounted };
