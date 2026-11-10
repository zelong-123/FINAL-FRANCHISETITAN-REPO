// App\Services\PaymentStageService, PaymentMoney, PaymentStageState and InstallmentRules.
//   waiting_total -> collecting -> for_review -> collecting -> confirmed
// Sales never writes a payment directly: a Sales Report waits as a payment_requests row until
// Admin's SAVE APPLICANT applies it. All money is integer centavos.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, manilaToday, updateRow } from '../lib/http.ts';
import { APPLICANT_MODEL, loadPlan } from './applicantModel.ts';
import { notifyRoles } from './notifications.ts';
import { notifyAssignedSales, requireReason } from './accountability.ts';

const MAX_TOTAL_CENTS = 50_000_000;
const MAX_ENTRY_CENTS = 99_999_900;
const MAX_REPORT_ENTRIES = 20;
const RULES_VERSION = 2;
const MIN_DOWNPAYMENT_PERCENT = 20;
const INSTALLMENT_PERCENT_OF_DOWNPAYMENT = 50;
const CUSTOM_DAYS_DEFAULT = 30;
export const FREQUENCIES: Record<string, string> = { monthly: 'Monthly', biweekly: 'Every 2 weeks', weekly: 'Weekly', custom: 'Custom (every N days)' };
export const PAYMENT_METHODS = ['cash', 'gcash', 'bank_transfer', 'check', 'other'];
const PAYMENT_TYPES = ['downpayment', 'installment_payment', 'full_payment'];
const LEGACY_TYPES: Record<string, string> = { initial_franchise_fee: 'installment_payment', installment: 'installment_payment', fully_paid: 'full_payment' };
const TYPE_ALIASES: Record<string, string[]> = {
  downpayment: ['downpayment'],
  installment_payment: ['installment_payment', 'initial_franchise_fee', 'installment'],
  full_payment: ['full_payment', 'fully_paid'],
};
const STATES = ['waiting_total', 'collecting', 'for_review', 'confirmed'];
const STATE_LABELS: Record<string, string> = { waiting_total: 'Waiting for Total required', collecting: 'Collecting payment', for_review: 'For Admin review', confirmed: 'Payment confirmed' };

// ---- PaymentMoney ----
export function toCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value * 100;
    value = value.toFixed(2);
  }
  let raw = String(value).trim();
  const negative = raw.startsWith('-');
  raw = raw.replace(/^[+-]+/, '');
  if (raw === '' || !/^\d*(?:\.\d*)?$/.test(raw)) throw new Error(`Not a money value: ${value}`);
  const [whole, fraction = ''] = raw.split('.');
  const padded = fraction.padEnd(3, '0');
  let cents = Number(whole || '0') * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}
export const decimal = (cents: number) => `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`;
export const toFloat = (cents: number) => cents / 100;
const applyDiscount = (originalCents: number, percent: number) => {
  const p = Math.max(0, Math.min(100, percent));
  return p === 0 ? originalCents : Math.trunc((originalCents * (100 - p) + 50) / 100);
};
export const money2 = (cents: number) => `₱${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyLabel = (cents: number) => (cents % 100 === 0 ? `₱${(cents / 100).toLocaleString('en-US')}` : money2(cents));

// ---- InstallmentRules ----
const minDownpaymentCents = (total: number) => Math.ceil((total * MIN_DOWNPAYMENT_PERCENT) / 100);
const minInstallmentCents = (down: number) => Math.round((down * INSTALLMENT_PERCENT_OF_DOWNPAYMENT) / 100);
const currentMinimumCents = (down: number, remaining: number) => Math.max(0, Math.min(minInstallmentCents(down), remaining));

function assertEntryRules(type: string, cents: number, remainingBefore: number, total: number, down: number | null, hasEarlier: boolean) {
  if (type === 'full_payment') return;
  if (type === 'downpayment') {
    const minimum = minDownpaymentCents(total);
    if (cents < minimum) fail('amount', `The downpayment must be at least ${moneyLabel(minimum)} (${MIN_DOWNPAYMENT_PERCENT}% of the final total ${moneyLabel(total)}).`);
    return;
  }
  if (down === null) {
    if (!hasEarlier) fail('amount', 'Record the downpayment first (or settle the whole balance as a Full Payment).');
    return;
  }
  const minimum = currentMinimumCents(down, remainingBefore);
  if (cents < minimum) {
    const why = minimum < minInstallmentCents(down) ? 'the remaining balance' : `${INSTALLMENT_PERCENT_OF_DOWNPAYMENT}% of the ${moneyLabel(down)} downpayment`;
    fail('amount', `An installment must be at least ${moneyLabel(minimum)} (${why}).`);
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonthsNoOverflow(date: string, months: number): string {
  const [y, m, day] = date.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return first.toISOString().slice(0, 10);
}
function addPeriods(date: string, frequency: string, customDays: number | null, periods: number): string {
  if (periods <= 0) return date;
  if (frequency === 'weekly') return addDays(date, 7 * periods);
  if (frequency === 'biweekly') return addDays(date, 14 * periods);
  if (frequency === 'custom') return addDays(date, Math.max(1, customDays || CUSTOM_DAYS_DEFAULT) * periods);
  return addMonthsNoOverflow(date, periods);
}

function schedule(total: number, saved: Row[], frequency: string | null, customDays: number | null, firstDue: string | null) {
  const paid = saved.reduce((sum, r) => sum + r.cents, 0);
  const remaining = Math.max(0, total - paid);
  const downIndex = saved.findIndex((r) => r.type === 'downpayment');
  const legacyBase = downIndex < 0 && saved.length > 0;
  const baseIndex = downIndex >= 0 ? downIndex : legacyBase ? 0 : null;
  const downpayment = baseIndex !== null ? saved[baseIndex].cents as number : null;
  const minInstallment = downpayment !== null ? minInstallmentCents(downpayment) : null;
  const nextMinimum = downpayment !== null && remaining > 0 ? currentMinimumCents(downpayment, remaining) : null;
  const installmentsPaid = baseIndex !== null ? Math.max(0, saved.length - 1) : 0;
  let nextDue: string | null = null;
  let lastDue: string | null = null;
  const estimated = remaining > 0 && minInstallment ? Math.ceil(remaining / minInstallment) : 0;
  if (firstDue && frequency && remaining > 0) {
    nextDue = addPeriods(firstDue, frequency, customDays, installmentsPaid);
    lastDue = estimated > 0 ? addPeriods(nextDue, frequency, customDays, estimated - 1) : nextDue;
  }
  return {
    min_downpayment_cents: minDownpaymentCents(total),
    downpayment_cents: downpayment,
    downpayment_is_legacy: legacyBase,
    minimum_installment_cents: minInstallment,
    next_minimum_cents: nextMinimum,
    remaining_cents: remaining,
    installments_paid: installmentsPaid,
    custom_days: frequency === 'custom' ? customDays : null,
    first_due_date: firstDue,
    next_due_date: nextDue,
    estimated_payments: estimated,
    estimated_last_due_date: lastDue,
    overdue: nextDue !== null && nextDue < manilaToday(),
  };
}

// ---- reads ----
export const state = (a: Row): string | null => (STATES.includes(a.payment_stage_state) ? a.payment_stage_state : null);
const canonicalType = (type: unknown): string | null => {
  const t = String(type ?? '').trim();
  return t === '' ? null : LEGACY_TYPES[t] ?? t;
};
const typeLabel = (type: unknown) => {
  switch (canonicalType(type)) {
    case 'downpayment': return 'Downpayment';
    case 'installment_payment': return 'Installment Payment';
    case 'full_payment': return 'Full Payment';
    default: return String(type ?? 'Payment');
  }
};
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
const fullName = async (db: Db, id: unknown) => (id ? (await db.query(`select full_name from users where id = $1`, [id]))[0]?.full_name ?? null : null);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

const totalCents = (a: Row, plan: Row | null) => toCents(plan?.total_required_amount ?? a.total_required_amount ?? 0);
const originalCents = (a: Row, plan: Row | null) => toCents(plan?.total_required_original_amount ?? a.total_required_original_amount ?? plan?.total_required_amount ?? a.total_required_amount ?? 0);
const discountPercent = (a: Row, plan: Row | null) => Math.max(0, Math.min(100, Number(plan?.total_required_discount_percent ?? a.total_required_discount_percent ?? 0)));

export async function totals(db: Db, a: Row, plan: Row | null) {
  const payments = await db.query(`select * from payments where applicant_id = $1 order by payment_date, id`, [a.id]);
  let verified = 0;
  let legacyPending = 0;
  for (const p of payments) {
    const cents = toCents(p.amount);
    if (p.status === 'verified') verified += cents;
    else if (['pending', 'for_revision'].includes(p.status)) legacyPending += cents;
  }
  const total = totalCents(a, plan);
  const balance = Math.max(0, total - verified);
  const original = originalCents(a, plan);
  let status = 'unpaid';
  if (verified > 0) status = total > 0 && balance === 0 ? 'fully_paid' : 'partially_paid';
  else if (total === 0 && original > 0) status = 'fully_paid';
  const first = payments[0];
  return {
    total_cents: total, verified_cents: verified, legacy_pending_cents: legacyPending, total_paid_cents: verified,
    balance_cents: balance, status,
    progress: total > 0 ? Math.min(100, Math.round((verified / total) * 10000) / 100) : original > 0 ? 100 : 0,
    entry_count: payments.length,
    initial_cents: first ? toCents(first.amount) : 0,
    initial_date: first?.payment_date ?? null,
  };
}

export const pendingRequest = async (db: Db, a: Row): Promise<Row | null> => (await db.query(
  `select pr.*, (select u.full_name from users u where u.id = pr.requested_by_user_id) as requested_by_name
   from payment_requests pr where pr.applicant_id = $1 and pr.status = 'pending' order by pr.id desc limit 1`, [a.id],
))[0] ?? null;

const savedRows = async (db: Db, a: Row): Promise<Row[]> => (await db.query(
  `select payment_type, amount, payment_date from payments where applicant_id = $1 and status = 'verified' order by payment_date, id`, [a.id],
)).map((p) => ({ type: canonicalType(p.payment_type), cents: toCents(p.amount), date: p.payment_date }));

async function savedDownpaymentCents(db: Db, a: Row, plan: Row | null): Promise<number | null> {
  return schedule(totalCents(a, plan), await savedRows(db, a), null, null, null).downpayment_cents;
}

async function requestDeltaCents(db: Db, a: Row, request: Row): Promise<number> {
  const payload = request.payload ?? {};
  if (request.action === 'create') return (payload.entries ?? []).reduce((sum: number, e: Row) => sum + Number(e.amount_cents ?? 0), 0);
  const [entry] = await db.query(`select amount from payments where applicant_id = $1 and id = $2`, [a.id, request.payment_id]);
  if (request.action === 'delete') return entry ? -toCents(entry.amount) : 0;
  if (request.action === 'update' && entry) return Number(payload.changes?.amount_cents ?? toCents(entry.amount)) - toCents(entry.amount);
  return 0;
}

export async function installmentPayload(db: Db, a: Row): Promise<Row> {
  const plan = await loadPlan(db, a.id);
  const frequency = plan?.installment_frequency ?? null;
  const s = schedule(totalCents(a, plan), await savedRows(db, a), frequency, plan?.installment_custom_days ?? null, plan?.first_due_date ?? null);
  const f = (cents: number | null) => (cents === null ? null : toFloat(cents));
  return {
    min_downpayment_percent: MIN_DOWNPAYMENT_PERCENT,
    installment_minimum_percent_of_downpayment: INSTALLMENT_PERCENT_OF_DOWNPAYMENT,
    min_downpayment_amount: f(s.min_downpayment_cents),
    has_downpayment: s.downpayment_cents !== null,
    downpayment_amount: f(s.downpayment_cents),
    downpayment_is_legacy: s.downpayment_is_legacy,
    minimum_installment: f(s.minimum_installment_cents),
    next_minimum: f(s.next_minimum_cents),
    remaining_balance: f(s.remaining_cents),
    installments_paid: s.installments_paid,
    frequency,
    frequency_label: frequency ? FREQUENCIES[frequency] ?? frequency : null,
    custom_days: s.custom_days,
    first_due_date: s.first_due_date,
    next_due_date: s.next_due_date,
    estimated_payments: s.estimated_payments,
    estimated_last_due_date: s.estimated_last_due_date,
    overdue: s.overdue,
    schedule_set_at: iso(plan?.schedule_set_at),
    schedule_set_by: await fullName(db, plan?.schedule_set_by_user_id),
    frequency_options: Object.entries(FREQUENCIES).map(([value, label]) => ({ value, label })),
    default_frequency: 'monthly',
    custom_days_default: CUSTOM_DAYS_DEFAULT,
  };
}

async function requestPayload(db: Db, request: Row, a: Row): Promise<Row> {
  const payload = request.payload ?? {};
  const [target] = request.payment_id ? await db.query(`select * from payments where applicant_id = $1 and id = $2`, [a.id, request.payment_id]) : [];
  const entries = (payload.entries ?? []).map((e: Row) => ({
    payment_date: e.payment_date ?? null,
    amount: toFloat(Number(e.amount_cents ?? 0)),
    payment_type: e.payment_type ?? null,
    payment_type_label: typeLabel(e.payment_type),
    remarks: e.remarks ?? null,
    payment_method: e.payment_method ?? null,
    payment_method_label: e.payment_method ? titleCase(e.payment_method) : null,
  }));
  const c = payload.changes;
  const labels: Row = { create: 'New payment report', update: 'Edit request', delete: 'Delete request' };
  return {
    id: request.id,
    action: request.action,
    action_label: labels[request.action] ?? 'Payment report',
    status: request.status,
    requested_by: request.requested_by_name ?? null,
    requested_by_user_id: request.requested_by_user_id,
    received_by: request.requested_by_name ?? null,
    received_by_user_id: request.requested_by_user_id,
    requested_at: iso(request.created_at),
    payment_id: request.payment_id,
    entries,
    changes: c && typeof c === 'object' ? {
      payment_date: c.payment_date ?? null, amount: toFloat(Number(c.amount_cents ?? 0)), payment_type: c.payment_type ?? null,
      payment_type_label: typeLabel(c.payment_type), remarks: c.remarks ?? null,
    } : null,
    target: target ? {
      id: target.id, payment_date: target.payment_date, amount: toFloat(toCents(target.amount)), payment_type: target.payment_type,
      payment_type_label: typeLabel(target.payment_type), remarks: target.remarks,
    } : null,
    total_amount: toFloat((payload.entries ?? []).reduce((sum: number, e: Row) => sum + Number(e.amount_cents ?? 0), 0)),
    delta_amount: toFloat(await requestDeltaCents(db, a, request)),
    note: request.note,
  };
}

/** What the Payment stage renders; flags are computed here so the UI never guesses. */
export async function stagePayload(db: Db, a: Row, user: Row): Promise<Row> {
  const plan = await loadPlan(db, a.id);
  const st = state(a);
  const t = await totals(db, a, plan);
  const isAdmin = user.role?.name === 'admin';
  const isSales = user.role?.name === 'sales';
  const collecting = st === 'collecting';
  const forReview = st === 'for_review';
  const request = await pendingRequest(db, a);
  const installment = await installmentPayload(db, a);
  const original = originalCents(a, plan);
  const delta = request ? await requestDeltaCents(db, a, request) : 0;
  const previewVerified = Math.max(0, t.verified_cents + delta);
  const entries = await db.query(
    `select p.*, (select full_name from users where id = p.recorded_by_user_id) as recorded_by_name,
       (select full_name from users where id = p.verified_by_user_id) as verified_by_name,
       (select full_name from users where id = p.received_by_user_id) as received_by_name,
       coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'original_name', d.original_name) order by d.id) from documents d
         where d.documentable_type = 'App\\Models\\Payment' and d.documentable_id = p.id), '[]'::jsonb) as docs
     from payments p where p.applicant_id = $1 order by p.payment_date, p.id`, [a.id],
  );
  const labels: Row = { fully_paid: 'Fully paid', partially_paid: 'Partially paid' };
  return {
    state: st,
    state_label: STATE_LABELS[st ?? ''] ?? 'Not in Payment yet',
    total_required_amount: toFloat(t.total_cents),
    original_total_required_amount: toFloat(original),
    discount_percent: discountPercent(a, plan),
    has_total_required: original > 0,
    total_paid_amount: toFloat(t.total_paid_cents),
    verified_amount: toFloat(t.verified_cents),
    pending_amount: toFloat(request ? Math.max(0, delta) : 0),
    pending_delta_amount: toFloat(delta),
    balance_including_pending: toFloat(t.balance_cents),
    remaining_balance: toFloat(t.balance_cents),
    preview_total_paid_amount: toFloat(previewVerified),
    preview_remaining_balance: toFloat(Math.max(0, t.total_cents - previewVerified)),
    payment_status: t.status,
    payment_status_label: labels[t.status] ?? 'Unpaid',
    payment_progress: t.progress,
    entry_count: t.entry_count,
    initial_payment_amount: toFloat(t.initial_cents),
    initial_payment_date: t.initial_date,
    package_name: plan?.package_name ?? a.package_name,
    fully_paid_on: a.payments_fully_paid_on,
    total_set_at: iso(a.total_required_set_at),
    total_set_by: await fullName(db, a.total_required_set_by_user_id),
    turned_over_at: iso(a.payment_turned_over_at),
    turned_over_by: await fullName(db, a.payment_turned_over_by_user_id),
    returned_at: iso(a.payment_returned_at),
    returned_by: await fullName(db, a.payment_returned_by_user_id),
    returned_note: a.payment_returned_note,
    can_set_total: isAdmin && st !== 'confirmed' && !a.archived_at,
    can_add_entry: isSales && collecting && !request && t.total_cents > 0,
    can_submit_report: isSales && collecting && !request && t.total_cents > 0,
    can_apply_report: isAdmin && forReview && Boolean(request),
    can_return: isAdmin && forReview && Boolean(request),
    can_complete: isAdmin && collecting && original > 0 && t.balance_cents === 0 && t.legacy_pending_cents === 0 && !request && a.loi_status !== 'pending',
    loi_pending: a.loi_status === 'pending',
    has_pending_request: Boolean(request),
    pending_request_id: request?.id ?? null,
    installment_percent: INSTALLMENT_PERCENT_OF_DOWNPAYMENT,
    downpayment_amount: installment.min_downpayment_amount,
    installment_amount: installment.next_minimum ?? 0,
    can_use_downpayment: t.entry_count === 0 && !request,
    installment,
    can_set_schedule: isAdmin && installment.has_downpayment && st !== 'confirmed' && !a.archived_at && t.balance_cents > 0,
    promo_name: plan?.promo_name ?? null,
    discount_set_at: iso(plan?.discount_set_at),
    discount_set_by: await fullName(db, plan?.discount_set_by_user_id),
    sales_report: request ? await requestPayload(db, request, a) : null,
    entries: entries.map((p) => ({
      id: p.id,
      payment_date: p.payment_date,
      amount: toFloat(toCents(p.amount)),
      payment_type: p.payment_type,
      payment_type_label: typeLabel(p.payment_type),
      remarks: p.remarks,
      payment_method: p.payment_method,
      payment_method_label: p.payment_method ? titleCase(p.payment_method) : null,
      status: p.status,
      recorded_by: p.recorded_by_name,
      recorded_by_user_id: p.recorded_by_user_id,
      received_by: p.received_by_name,
      received_by_user_id: p.received_by_user_id,
      received_by_role_id: p.received_by_role_id,
      verified_by: p.verified_by_name,
      verified_at: iso(p.verified_at),
      documents: p.docs,
      editable: isSales && collecting && !request && p.recorded_by_user_id === user.id,
    })),
  };
}

// ---- guards ----
export const lock = async (db: Db, id: number): Promise<Row> => {
  const [a] = await db.query(`select * from applicants where id = $1 for update`, [id]);
  if (!a) abort(404, 'Record not found.');
  return a;
};
const assertNotArchived = (a: Row) => { if (a.archived_at) fail('applicant', 'An archived applicant cannot change its payment record.'); };
function assertCollecting(a: Row) {
  const st = state(a);
  if (st === 'waiting_total') fail('payments', 'Admin must set the Total required before a payment can be recorded.');
  if (st === 'for_review') fail('payments', 'A Sales Report is awaiting Admin confirmation. It must be confirmed or returned first.');
  if (st === 'confirmed') fail('payments', 'This payment is confirmed and locked.');
  if (st === null) fail('payments', 'The applicant is not in the Payment stage yet.');
}
function assertAmount(cents: number, max: number) {
  if (cents <= 0) fail('amount', 'The amount must be greater than zero.');
  if (cents > max) fail('amount', `The amount cannot exceed the remaining balance of ${money2(max)}.`);
  if (cents > MAX_ENTRY_CENTS) fail('amount', 'A payment cannot exceed ₱999,999 (6 digits).');
}
function paymentType(value: unknown, cents: number, entryCount: number, remaining: number | null): string {
  let type = canonicalType(value);
  if (type !== null && !PAYMENT_TYPES.includes(type)) fail('payment_type', 'Choose Downpayment, Installment Payment or Full Payment.');
  if (remaining !== null && remaining > 0 && cents >= remaining) return 'full_payment';
  type ??= entryCount === 0 ? 'downpayment' : 'installment_payment';
  if (type === 'full_payment') fail('payment_type', 'Full Payment must settle the whole remaining balance.');
  if (type === 'downpayment' && entryCount > 0) fail('payment_type', 'Downpayment is only available on the first payment. Choose Installment Payment or Full Payment.');
  return type;
}
function paymentMethod(value: unknown): string | null {
  const method = String(value ?? '').trim();
  if (!method) return null;
  if (!PAYMENT_METHODS.includes(method)) fail('payment_method', 'Choose Cash, GCash, Bank Transfer, Check or Other.');
  return method;
}
const remarks = (value: unknown) => String(value ?? '').trim() || null;
function assertNotFuture(value: unknown): string {
  const today = manilaToday();
  if (value === null || value === undefined || value === '') return today;
  const date = String(value).slice(0, 10);
  if (date > today) fail('payment_date', 'The Date paid cannot be in the future.');
  return date;
}
async function assertNotDuplicate(db: Db, a: Row, type: string, cents: number, date: string, seen: Set<string> = new Set()) {
  if (seen.has(`${type}|${cents}|${date}`)) fail('entries', 'This same payment appears twice in the report.');
  const found = await db.query(
    `select 1 from payments where applicant_id = $1 and payment_type = any($2::text[]) and amount = $3::numeric and payment_date = $4::date limit 1`,
    [a.id, `{${(TYPE_ALIASES[type] ?? [type]).join(',')}}`, decimal(cents), date],
  );
  if (found.length) fail('entries', 'An identical payment (same type, amount and date) is already recorded for this applicant.');
}

/** Mirror a payment into the ledger table, exactly as the old endpoints did. */
export async function syncLedger(db: Db, p: Row) {
  const fields = [p.applicant_id, p.payment_type, p.payment_method, p.amount, p.payment_date, p.reference_number, p.paid_to_account, p.status, p.recorded_by_user_id, p.verified_by_user_id, p.verified_at, p.remarks];
  const updated = await db.query(
    `update applicant_payments set applicant_id=$2, payment_type=$3, payment_method=$4, amount=$5, payment_date=$6, reference_number=$7, paid_to_account=$8,
       status=$9, recorded_by_user_id=$10, verified_by_user_id=$11, verified_at=$12, remarks=$13, is_legacy_baseline=false where legacy_payment_id=$1 returning id`,
    [p.id, ...fields],
  );
  if (updated.length) return;
  await db.query(
    `insert into applicant_payments (legacy_payment_id, applicant_id, payment_type, payment_method, amount, payment_date, reference_number, paid_to_account, status,
       recorded_by_user_id, verified_by_user_id, verified_at, remarks, is_legacy_baseline) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)`,
    [p.id, ...fields],
  );
}

// Sales-facing alerts go to the applicant's assigned Sales user only.
const notifySales = (db: Db, a: Row, type: string, title: string, message: string, actor: Row) =>
  notifyAssignedSales(db, a, type, title, message, { by: actor.full_name }, actor);

const auditMoney = (db: Db, actor: Row, action: string, id: number, oldValues: Row, newValues: Row) => db.query(
  `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values ($1, $2, $3, $4, $5, $6, now())`,
  [actor.id, action, APPLICANT_MODEL, id, JSON.stringify(oldValues), JSON.stringify(newValues)],
);

// ---- mutations ----
export function setTotal(db: Db, id: number, actor: Row, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    const plan = await loadPlan(tx, id);
    const st = state(locked);
    const previousOriginal = originalCents(locked, plan);
    const previousDiscount = discountPercent(locked, plan);
    const previousFinal = totalCents(locked, plan);
    if (st === 'confirmed') fail('total_required_amount', 'This payment is confirmed and locked — the total can no longer change.');

    const t = await totals(tx, locked, plan);
    const request = await pendingRequest(tx, locked);
    const recorded = t.verified_cents + (request ? Math.max(0, await requestDeltaCents(tx, locked, request)) : 0);
    const hasInput = 'total_required_amount' in data || 'original_total_required_amount' in data;
    const original = hasInput ? toCents(data.original_total_required_amount ?? data.total_required_amount) : Math.max(previousOriginal, 0);
    if (original <= 0) fail('total_required_amount', 'Set a Total required amount greater than zero.');
    if (original > MAX_TOTAL_CENTS) fail('total_required_amount', `The Total required cannot exceed ${moneyLabel(MAX_TOTAL_CENTS)}.`);
    const discount = 'discount_percent' in data ? Number(data.discount_percent ?? 0) : previousDiscount;
    if (discount < 0 || discount > 100) fail('discount_percent', 'The discount must be a whole number from 0 to 100.');
    const total = applyDiscount(original, discount);
    if (total < recorded) fail('total_required_amount', `The Total required after discount (${money2(total)}) cannot be lower than the amount already paid (${money2(recorded)}).`);
    const initial = 'initial_payment_amount' in data ? toCents(data.initial_payment_amount) : toCents(plan?.initial_payment_amount ?? locked.initial_payment_amount ?? 0);
    if (initial > total) fail('initial_payment_amount', 'The initial payment cannot exceed the Total required amount.');

    const packageName = data.package_name ?? locked.package_name;
    const previousPromo = plan?.promo_name ?? null;
    const promo = 'promo_name' in data ? (String(data.promo_name ?? '').trim().slice(0, 120) || null) : previousPromo;
    const discountChanged = previousOriginal !== original || previousDiscount !== discount || previousPromo !== promo || !plan?.discount_set_at;
    const planFields: Row = {
      promo_name: promo,
      package_name: packageName,
      total_required_amount: decimal(total),
      total_required_original_amount: decimal(original),
      total_required_discount_percent: discount,
      initial_payment_amount: initial > 0 ? decimal(initial) : null,
      other_fees: data.other_fees ?? plan?.other_fees ?? 0,
      payment_terms: data.payment_terms ?? plan?.payment_terms ?? null,
      ...(discountChanged ? { discount_set_at: new Date(), discount_set_by_user_id: actor.id } : {}),
    };
    if (plan) await updateRow(tx, 'applicant_payment_plans', plan.id, planFields);
    else await insertRow(tx, 'applicant_payment_plans', { applicant_id: id, ...planFields });

    const attributes: Row = {
      ...(packageName !== null && packageName !== undefined ? { package_name: packageName } : {}),
      total_required_amount: decimal(total),
      total_required_original_amount: decimal(original),
      total_required_discount_percent: discount,
      initial_payment_amount: decimal(initial),
      ...('other_fees' in data && data.other_fees !== null ? { other_fees: data.other_fees } : {}),
      total_required_set_at: new Date(),
      total_required_set_by_user_id: actor.id,
    };
    if (st === 'waiting_total' || (st === null && locked.status === 'payment_submitted')) attributes.payment_stage_state = 'collecting';
    const fresh = (await updateRow(tx, 'applicants', id, attributes))!;

    if (previousOriginal !== original || previousDiscount !== discount) {
      await auditMoney(tx, actor, 'payment_total_updated', id,
        { original_total_required_amount: decimal(previousOriginal), discount_percent: previousDiscount, total_required_amount: decimal(previousFinal) },
        { original_total_required_amount: decimal(original), discount_percent: discount, total_required_amount: decimal(total) });
    }
    if (state(fresh) === 'collecting') {
      await notifySales(tx, fresh, 'payment_total_set', 'Payment total set', `Admin set the Total required for ${fresh.full_name} to ${money2(total)}. You can now record payments.`, actor);
    }
    return fresh;
  });
}

export function submitReport(db: Db, id: number, actor: Row, entries: Row[]): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    assertCollecting(locked);
    const plan = await loadPlan(tx, id);
    const t = await totals(tx, locked, plan);
    if (t.total_cents <= 0) {
      fail('entries', originalCents(locked, plan) > 0 ? 'The Total required is ₱0 after the discount — there is nothing left to collect.' : 'Admin must set the Total required before a payment can be recorded.');
    }
    if (await pendingRequest(tx, locked)) fail('entries', 'A Sales Report is already awaiting Admin confirmation. Save it before creating another.');
    if (!entries.length) fail('entries', 'Add at least one payment before saving the record.');
    if (entries.length > MAX_REPORT_ENTRIES) fail('entries', `A Sales Report can contain at most ${MAX_REPORT_ENTRIES} payments.`);

    let remaining = Math.max(0, t.balance_cents - t.legacy_pending_cents);
    let downpayment = await savedDownpaymentCents(tx, locked, plan);
    const normalized: Row[] = [];
    const seen = new Set<string>();
    let sum = 0;
    for (const [index, entry] of entries.entries()) {
      const cents = toCents(entry.amount ?? 0);
      assertAmount(cents, remaining);
      const date = assertNotFuture(entry.payment_date);
      const type = paymentType(entry.payment_type, cents, t.entry_count + index, remaining);
      assertEntryRules(type, cents, remaining, t.total_cents, downpayment, t.entry_count + index > 0);
      if (type === 'downpayment') downpayment = cents;
      await assertNotDuplicate(tx, locked, type, cents, date, seen);
      seen.add(`${type}|${cents}|${date}`);
      remaining -= cents;
      sum += cents;
      normalized.push({ payment_date: date, amount_cents: cents, payment_type: type, payment_method: paymentMethod(entry.payment_method), remarks: remarks(entry.remarks) });
    }
    const request = await insertRow(tx, 'payment_requests', {
      applicant_id: id, requested_by_user_id: actor.id, action: 'create', payload: { entries: normalized, rules: RULES_VERSION }, status: 'pending',
    });
    await updateRow(tx, 'applicants', id, {
      payment_stage_state: 'for_review', payment_turned_over_at: new Date(), payment_turned_over_by_user_id: actor.id,
      payment_returned_at: null, payment_returned_by_user_id: null, payment_returned_note: null,
    });
    await notifyRoles(tx, ['admin'], 'payment_report_submitted', 'New Sales Report',
      `Sales submitted a payment report for ${locked.full_name} (${money2(sum)}). Review and confirm it.`,
      { applicant_id: id, payment_request_id: request.id, amount: toFloat(sum) }, actor);
    return request;
  });
}

export function applyReport(db: Db, id: number, actor: Row, remarksText: string | null): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    if (state(locked) !== 'for_review') fail('payments', 'There is no Sales Report awaiting confirmation.');
    const request = await pendingRequest(tx, locked);
    if (!request) fail('payments', 'There is no Sales Report awaiting confirmation.');
    if (request!.action === 'create') await applyCreate(tx, locked, request!, actor);
    else if (request!.action === 'update') await applyUpdate(tx, locked, request!, actor);
    else if (request!.action === 'delete') await applyDelete(tx, locked, request!);
    else fail('payments', 'This Sales Report has an unknown action.');

    await updateRow(tx, 'payment_requests', request!.id, { status: 'applied', reviewed_by_user_id: actor.id, reviewed_at: new Date() });
    const fresh = (await updateRow(tx, 'applicants', id, {
      payment_stage_state: 'collecting', payment_turned_over_at: null, payment_turned_over_by_user_id: null,
      payment_returned_at: null, payment_returned_by_user_id: null, payment_returned_note: null,
      payment_remarks: remarksText ?? locked.payment_remarks,
    }))!;
    await notifySales(tx, fresh, 'payment_report_approved', 'Payment confirmed by Admin', `Admin confirmed the Sales Report of ${fresh.full_name}. The amount is now part of the payment record.`, actor);
    return fresh;
  });
}

async function applyCreate(db: Db, a: Row, request: Row, actor: Row) {
  const entries: Row[] = request.payload?.entries ?? [];
  if (!entries.length) fail('payments', 'This Sales Report contains no payments.');
  const plan = await loadPlan(db, a.id);
  const t = await totals(db, a, plan);
  const [receiver] = await db.query(`select id, role_id from users where id = $1`, [request.requested_by_user_id]);
  let remaining = t.balance_cents;
  const checkRules = Number(request.payload?.rules ?? 1) >= RULES_VERSION;
  let downpayment = await savedDownpaymentCents(db, a, plan);
  for (const [index, entry] of entries.entries()) {
    const cents = Number(entry.amount_cents ?? 0);
    assertAmount(cents, remaining);
    const date = entry.payment_date ?? manilaToday();
    const type = paymentType(entry.payment_type, cents, t.entry_count + index, remaining);
    if (checkRules) {
      assertEntryRules(type, cents, remaining, t.total_cents, downpayment, t.entry_count + index > 0);
      if (type === 'downpayment') downpayment = cents;
    }
    await assertNotDuplicate(db, a, type, cents, date);
    remaining -= cents;
    const payment = await insertRow(db, 'payments', {
      applicant_id: a.id, payment_type: type, department: 'Sales', requested_at: request.created_at ?? new Date(),
      payment_method: paymentMethod(entry.payment_method), amount: decimal(cents), payment_date: date, status: 'verified',
      recorded_by_user_id: request.requested_by_user_id, received_by_user_id: receiver?.id ?? null, received_by_role_id: receiver?.role_id ?? null,
      verified_by_user_id: actor.id, verified_at: new Date(), remarks: remarks(entry.remarks),
    });
    await syncLedger(db, payment);
  }
}

async function applyUpdate(db: Db, a: Row, request: Row, actor: Row) {
  const [entry] = await db.query(`select * from payments where applicant_id = $1 and id = $2 for update`, [a.id, request.payment_id]);
  if (!entry) abort(404, 'Record not found.');
  const changes = request.payload?.changes;
  if (!changes || typeof changes !== 'object') fail('payments', 'This Sales Report has no proposed changes.');
  const t = await totals(db, a, await loadPlan(db, a.id));
  const current = toCents(entry.amount);
  const cents = 'amount_cents' in changes ? Number(changes.amount_cents) : current;
  assertAmount(cents, t.balance_cents + current);
  const saved = await updateRow(db, 'payments', entry.id, {
    amount: decimal(cents), payment_date: changes.payment_date ?? entry.payment_date, payment_type: changes.payment_type ?? entry.payment_type,
    remarks: 'remarks' in changes ? remarks(changes.remarks) : entry.remarks, status: 'verified', verified_by_user_id: actor.id, verified_at: new Date(),
  });
  await syncLedger(db, saved!);
}

async function applyDelete(db: Db, a: Row, request: Row) {
  const [entry] = await db.query(`select id from payments where applicant_id = $1 and id = $2 for update`, [a.id, request.payment_id]);
  if (!entry) abort(404, 'Record not found.');
  await db.query(`delete from applicant_payments where legacy_payment_id = $1`, [entry.id]);
  await db.query(`delete from documents where documentable_type = 'App\\Models\\Payment' and documentable_id = $1`, [entry.id]);
  await db.query(`delete from payments where id = $1`, [entry.id]);
}

/** Admin COMPLETED. onConfirmed shares the transaction, so the stage and state move together. */
export function completePayment(db: Db, id: number, actor: Row, remarksText: string | null, onConfirmed: (tx: Db, a: Row) => Promise<void>): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    if (state(locked) === 'confirmed') return locked;
    if (state(locked) !== 'collecting' || (await pendingRequest(tx, locked))) fail('payments', 'Confirm the pending Sales Report before completing the payment stage.');
    const plan = await loadPlan(tx, id);
    const t = await totals(tx, locked, plan);
    if (originalCents(locked, plan) <= 0) fail('payments', 'Set the Total required before completing this stage.');
    if (t.legacy_pending_cents > 0) fail('payments', 'A payment is still awaiting review. Confirm it before completing the stage.');
    if (t.verified_cents < t.total_cents || t.balance_cents > 0) fail('payments', `COMPLETED unlocks only when the Payment Record is Fully Paid. Remaining: ${money2(t.balance_cents)}.`);
    const [latest] = await tx.query(`select max(payment_date) as day from payments where applicant_id = $1 and status = 'verified'`, [id]);
    const fresh = (await updateRow(tx, 'applicants', id, {
      payment_stage_state: 'confirmed', payments_fully_paid_on: latest?.day ?? manilaToday(), payment_confirmed_at: new Date(),
      payment_confirmed_by_user_id: actor.id, payment_remarks: remarksText ?? locked.payment_remarks,
    }))!;
    await onConfirmed(tx, fresh);
    await notifySales(tx, fresh, 'payment_confirmed', 'Payment confirmed', `Admin confirmed the payment of ${fresh.full_name}. The applicant now moves to For Approval.`, actor);
    return (await tx.query(`select * from applicants where id = $1`, [id]))[0];
  });
}

export function requestChange(db: Db, id: number, paymentId: number, actor: Row, action: 'update' | 'delete', data: Row = {}): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    const [entry] = await tx.query(`select * from payments where id = $1 for update`, [paymentId]);
    if (!entry || entry.applicant_id !== id) abort(404, 'Record not found.');
    // Ownership first, so another Sales user never learns whether the record is editable.
    if (entry.recorded_by_user_id !== actor.id) abort(403, 'You can only change a payment entry that you recorded yourself.');
    assertCollecting(locked);
    if (await pendingRequest(tx, locked)) fail('payments', 'A Sales Report is already awaiting Admin confirmation. Wait for Admin before requesting another change.');

    const plan = await loadPlan(tx, id);
    const t = await totals(tx, locked, plan);
    let payload: Row = { changes: null };
    if (action === 'update') {
      const current = toCents(entry.amount);
      const cents = 'amount' in data ? toCents(data.amount) : current;
      assertAmount(cents, t.balance_cents + current);
      const date = 'payment_date' in data ? assertNotFuture(data.payment_date) : entry.payment_date;
      const previous = Math.max(0, t.entry_count - 1);
      const type = paymentType('payment_type' in data ? data.payment_type : entry.payment_type, cents, previous, t.balance_cents + current);
      const savedDown = await savedDownpaymentCents(tx, locked, plan);
      const isDown = canonicalType(entry.payment_type) === 'downpayment';
      assertEntryRules(type, cents, t.balance_cents + current, t.total_cents, isDown ? null : savedDown, previous > 0 || !isDown);
      payload = { rules: RULES_VERSION, changes: { payment_date: date, amount_cents: cents, payment_type: type, remarks: 'remarks' in data ? remarks(data.remarks) : entry.remarks } };
    }
    const request = await insertRow(tx, 'payment_requests', { applicant_id: id, requested_by_user_id: actor.id, action, payment_id: entry.id, payload, status: 'pending' });
    await updateRow(tx, 'applicants', id, {
      payment_stage_state: 'for_review', payment_turned_over_at: new Date(), payment_turned_over_by_user_id: actor.id,
      payment_returned_at: null, payment_returned_by_user_id: null, payment_returned_note: null,
    });
    await notifyRoles(tx, ['admin'], 'payment_change_requested', 'Payment change request',
      `Sales requested a ${action === 'delete' ? 'deletion' : 'correction'} of a payment entry for ${locked.full_name}. Review and confirm it.`,
      { applicant_id: id, payment_request_id: request.id, payment_id: entry.id }, actor);
    return request;
  });
}

export function returnToSales(db: Db, id: number, actor: Row, note: string): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    if (state(locked) !== 'for_review') fail('payments', 'Only a Sales Report awaiting confirmation can be returned.');
    const text = requireReason(note, 'note', 'a return reason');
    const request = await pendingRequest(tx, locked);
    if (request) await updateRow(tx, 'payment_requests', request.id, { status: 'rejected', reviewed_by_user_id: actor.id, reviewed_at: new Date(), note: text });
    const fresh = (await updateRow(tx, 'applicants', id, {
      payment_stage_state: 'collecting', payment_returned_at: new Date(), payment_returned_by_user_id: actor.id, payment_returned_note: text,
      payment_turned_over_at: null, payment_turned_over_by_user_id: null,
    }))!;
    await notifySales(tx, fresh, 'payment_returned', 'Payment returned to Sales', `Admin returned the Sales Report of ${locked.full_name}: ${text}`, actor);
    return fresh;
  });
}

export function setSchedule(db: Db, id: number, actor: Row, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const locked = await lock(tx, id);
    assertNotArchived(locked);
    if (state(locked) === 'confirmed') fail('frequency', 'This payment is confirmed and locked.');
    const rows = await savedRows(tx, locked);
    const downpayment = rows.find((r) => r.type === 'downpayment') ?? rows[0] ?? null;
    if (!downpayment) fail('frequency', 'Save the downpayment first, then set the installment plan.');
    const frequency = String(data.frequency ?? '');
    if (!(frequency in FREQUENCIES)) fail('frequency', 'Choose a valid payment frequency.');
    const customDays = frequency === 'custom' ? Number(data.custom_days ?? 0) : null;
    if (frequency === 'custom' && (customDays! < 1 || customDays! > 365)) fail('custom_days', 'Enter the number of days between payments (1–365).');
    const firstDue = String(data.first_due_date ?? '').slice(0, 10);
    if (downpayment!.date && firstDue <= downpayment!.date) fail('first_due_date', `The first due date must be after the downpayment date (${downpayment!.date}).`);

    const plan = (await loadPlan(tx, id)) ?? await insertRow(tx, 'applicant_payment_plans', { applicant_id: id, total_required_amount: locked.total_required_amount });
    const fields = { installment_frequency: frequency, installment_custom_days: customDays, first_due_date: firstDue, schedule_set_at: new Date(), schedule_set_by_user_id: actor.id };
    await updateRow(tx, 'applicant_payment_plans', plan.id, fields);
    await auditMoney(tx, actor, 'payment_schedule_updated', id,
      { installment_frequency: plan.installment_frequency ?? null, installment_custom_days: plan.installment_custom_days ?? null, first_due_date: plan.first_due_date ?? null },
      { installment_frequency: frequency, installment_custom_days: customDays, first_due_date: firstDue });
    return locked;
  });
}
