// Payment Record: the system RECORDS payments that already happened outside it. It never bills,
// discounts or computes fees. Admin enters the Agreed Package Amount as a reference, the assigned
// Sales user records each payment with its OR/AR number, reference number and receipt, and Admin
// verifies or returns each entry. The status is computed only from Verified entries.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { fail, insertRow, manilaToday, updateRow, ValidationError } from '../lib/http.ts';
import { MAX_UPLOAD_KB, sniffFileType, storeDocument } from '../lib/files.ts';
import { loadPlan } from './applicantModel.ts';
import { fileRef, logEvent } from './applicantStage.ts';
import { notifyAssignedSales, requireReason } from './accountability.ts';
import { notifyRoles } from './notifications.ts';
import { decimal, lock, money2, pendingRequest, state, syncLedger, toCents, totals } from './paymentStage.ts';

export const PAYMENT_MODEL = 'App\\Models\\Payment';
export const RECORD_METHODS: Record<string, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', gcash: 'GCash', check: 'Check' };
export const RECEIPT_RULE = { accept: ['pdf', 'jpg', 'jpeg', 'png'], max_kb: MAX_UPLOAD_KB };
const STATUS_LABELS: Record<string, string> = { unpaid: 'Unpaid', partially_paid: 'Partially Paid', fully_paid: 'Fully Paid' };
const ENTRY_LABELS: Record<string, string> = { pending: 'Pending review', verified: 'Verified', returned: 'Returned', for_revision: 'For revision (legacy)', rejected: 'Rejected (legacy)' };
const STEP = 'payment_record';
const MAX_AMOUNT_CENTS = 50_000_000;

export const paymentAdvanced = (c: Context<AppEnv>) => Boolean(c.get('deps').paymentAdvanced);
export const OFF_MESSAGE = 'This feature is turned off. The Payment Record only records payments: one entry at a time, verified by Admin.';

const normalized = (value: unknown) => String(value ?? '').trim();

/** Fully Paid or confirmed: the agreed amount can no longer change. */
async function lockReason(db: Db, a: Row, plan: Row | null): Promise<string | null> {
  if (state(a) === 'confirmed' || a.payment_confirmed_at) return 'The Payment Record is confirmed and locked: the Agreed Package Amount can no longer change.';
  const t = await totals(db, a, plan);
  if (t.total_cents > 0 && t.verified_cents >= t.total_cents) return 'The Payment Record is Fully Paid and locked: the Agreed Package Amount can no longer change.';
  return null;
}

/** Admin sets (or, with a reason, changes) the Agreed Package Amount. No computation. */
export function setAgreedAmount(db: Db, id: number, actor: Row, data: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const a = await lock(tx, id);
    if (a.archived_at) fail('applicant', 'An archived applicant cannot change its Payment Record.');
    if (a.status !== 'payment_submitted' && state(a) === null) fail('agreed_amount', 'The Agreed Package Amount is set at the Payment Record stage.');
    const plan = await loadPlan(tx, id);
    const locked = await lockReason(tx, a, plan);
    if (locked) fail('agreed_amount', locked);
    const cents = toCents(data.agreed_amount);
    if (cents <= 0) fail('agreed_amount', 'Enter an Agreed Package Amount greater than zero.');
    if (cents > MAX_AMOUNT_CENTS) fail('agreed_amount', `The Agreed Package Amount cannot exceed ${money2(MAX_AMOUNT_CENTS)}.`);
    const t = await totals(tx, a, plan);
    const previous = t.total_cents;
    const entries = (await tx.query(`select count(*)::int as n from payments where applicant_id = $1 and status not in ('returned', 'rejected')`, [id]))[0].n;
    const changing = previous > 0;
    // An older record without the payment state may confirm its stored amount to start the Payment Record.
    const activatingLegacy = state(a) === null;
    if (changing && !activatingLegacy && previous === cents && normalized(data.package_name || (plan?.package_name ?? a.package_name ?? '')) === normalized(plan?.package_name ?? a.package_name)) {
      fail('agreed_amount', 'Nothing changed.');
    }
    // Changing it once payments exist needs a reason, and never goes below what is Verified.
    const reason = changing && previous !== cents && entries > 0 ? requireReason(data.reason, 'reason', 'a reason for changing the Agreed Package Amount') : (normalized(data.reason) || null);
    if (cents < t.verified_cents) fail('agreed_amount', `The Agreed Package Amount cannot be lower than the Verified payments (${money2(t.verified_cents)}).`);

    const packageName = normalized(data.package_name) || plan?.package_name || a.package_name || null;
    const source = normalized(data.source) || plan?.agreed_amount_source || null;
    const planFields: Row = {
      package_name: packageName, agreed_amount_source: source,
      total_required_amount: decimal(cents), total_required_original_amount: decimal(cents), total_required_discount_percent: 0, promo_name: null,
    };
    if (plan) await updateRow(tx, 'applicant_payment_plans', plan.id, planFields);
    else await insertRow(tx, 'applicant_payment_plans', { applicant_id: id, ...planFields });
    const fresh = (await updateRow(tx, 'applicants', id, {
      package_name: packageName, total_required_amount: decimal(cents), total_required_original_amount: decimal(cents), total_required_discount_percent: 0,
      total_required_set_at: new Date(), total_required_set_by_user_id: actor.id,
      ...(state(a) === 'waiting_total' || state(a) === null ? { payment_stage_state: 'collecting' } : {}),
    }))!;
    await logEvent(tx, a, changing ? 'payment_agreed_amount_changed' : 'payment_agreed_amount_set', actor.id, {}, reason, {
      step: STEP,
      old_values: changing ? { agreed_amount: previous / 100, package_name: plan?.package_name ?? a.package_name ?? null, discount_percent: Number(plan?.total_required_discount_percent ?? 0) } : { agreed_amount: null },
      new_values: { agreed_amount: cents / 100, package_name: packageName, source },
    });
    await notifyAssignedSales(tx, fresh, 'payment_total_set', changing ? 'Agreed amount changed' : 'Agreed amount set',
      `Admin ${changing ? 'changed' : 'set'} the Agreed Package Amount for ${a.full_name} to ${money2(cents)}.${reason ? ` Reason: ${reason}` : ''} You can record payments.`, {}, actor);
    return fresh;
  });
}

/** Turns the database's unique-index refusal into the clear message the user sees. */
function duplicateNumber(error: unknown): never {
  const e = error as Row;
  const where = `${e?.constraint_name ?? e?.constraint ?? ''} ${e?.message ?? ''}`;
  if (where.includes('reference_number')) throw new ValidationError({ reference_number: ['This reference number is already recorded.'] });
  throw new ValidationError({ or_number: ['This OR/AR number is already recorded.'] });
}

/** The assigned Sales user records one payment that already happened. It cannot be edited after. */
export async function submitEntry(c: Context<AppEnv>, db: Db, applicantId: number, actor: Row, input: Row): Promise<Row> {
  const date = normalized(input.payment_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('payment_date', 'Enter the date the payment was made.');
  if (date > manilaToday()) fail('payment_date', 'The payment date cannot be in the future.');
  const cents = toCents(input.amount);
  if (!(cents > 0)) fail('amount', 'The amount must be greater than zero.');
  const method = normalized(input.payment_method);
  if (!RECORD_METHODS[method]) fail('payment_method', 'Choose Cash, Bank transfer, GCash or Check.');
  const orNumber = normalized(input.or_number);
  if (!orNumber) fail('or_number', 'Enter the OR or AR number.');
  if (orNumber.length > 60) fail('or_number', 'The OR/AR number is too long.');
  const reference = normalized(input.reference_number);
  if (method !== 'cash' && !reference) fail('reference_number', 'Enter the reference number (required for every payment that is not cash).');
  if (reference.length > 100) fail('reference_number', 'The reference number is too long.');
  const receipt = input.receipt;
  if (!(receipt instanceof File)) fail('receipt', 'Attach the receipt (PDF, JPG or PNG).');
  const ext = (receipt.name.split('.').pop() ?? '').toLowerCase();
  if (!RECEIPT_RULE.accept.includes(ext)) fail('receipt', 'The receipt must be a PDF, JPG or PNG file.');
  if (receipt.size / 1024 > RECEIPT_RULE.max_kb) fail('receipt', `The receipt may not be larger than ${RECEIPT_RULE.max_kb / 1024} MB.`);
  // The contents must really be what the name says (a renamed file is refused).
  const real = await sniffFileType(receipt);
  const expected = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg';
  if (real !== expected) fail('receipt', 'The receipt file is not a real PDF, JPG or PNG (its contents do not match its type).');
  const remarks = normalized(input.remarks).slice(0, 2000) || null;

  let saved: Row;
  try {
    saved = await db.tx(async (tx) => {
      const a = await lock(tx, applicantId);
      if (a.archived_at) fail('applicant', 'An archived applicant cannot change its Payment Record.');
      if (state(a) === 'waiting_total' || (state(a) === null && a.status === 'payment_submitted')) fail('payments', 'Admin must set the Agreed Package Amount before payments can be recorded.');
      if (state(a) === 'confirmed') fail('payments', 'This Payment Record is confirmed and locked.');
      if (state(a) !== 'collecting') fail('payments', 'Payments are recorded at the Payment Record stage.');
      if (await pendingRequest(tx, a)) fail('payments', 'An older Sales Report is still waiting for Admin. Admin must apply or return it first.');
      const plan = await loadPlan(tx, applicantId);
      const t = await totals(tx, a, plan);
      // Entries never add up to more than the agreed amount (verified + waiting + this one).
      if (t.verified_cents + t.legacy_pending_cents + cents > t.total_cents) {
        fail('amount', `This would exceed the Agreed Package Amount: ${money2(Math.max(0, t.total_cents - t.verified_cents - t.legacy_pending_cents))} is left to record.`);
      }
      // The friendly check; the unique indexes catch the same number submitted at the same moment.
      const [usedOr] = await tx.query(`select 1 from payments where lower(btrim(or_number)) = lower($1) and status not in ('returned', 'rejected') limit 1`, [orNumber]);
      if (usedOr) fail('or_number', 'This OR/AR number is already recorded.');
      if (reference) {
        const [usedRef] = await tx.query(`select 1 from payments where lower(btrim(reference_number)) = lower($1) and status not in ('returned', 'rejected') limit 1`, [reference]);
        if (usedRef) fail('reference_number', 'This reference number is already recorded.');
      }
      const row = await insertRow(tx, 'payments', {
        applicant_id: applicantId, payment_type: 'payment_record', amount: decimal(cents), payment_date: date, payment_method: method,
        or_number: orNumber, reference_number: reference || null, status: 'pending', department: 'Sales', requested_at: new Date(),
        recorded_by_user_id: actor.id, received_by_user_id: actor.id, remarks,
      });
      await syncLedger(tx, row);
      const doc = await storeDocument(c, tx, receipt as File, `applicants/${applicantId}/payments`, { type: PAYMENT_MODEL, id: row.id }, 'payment_receipt');
      await logEvent(tx, a, 'payment_entry_submitted', actor.id, { payment_id: row.id }, remarks, {
        step: STEP,
        new_values: { payment_id: row.id, amount: cents / 100, payment_date: date, payment_method: method, or_number: orNumber, reference_number: reference || null, status: 'pending' },
        attachments: [fileRef(doc)!],
      });
      return { ...row, receipt: doc };
    });
  } catch (error) {
    if ((error as Row)?.code === '23505') duplicateNumber(error);
    throw error;
  }
  const [a] = await db.query(`select * from applicants where id = $1`, [applicantId]);
  await notifyRoles(db, ['admin'], 'payment_entry_submitted', 'Payment entry to verify',
    `${actor.full_name} recorded a payment of ${money2(cents)} (OR/AR ${orNumber}) for ${a.full_name}. Verify it or return it.`, { applicant_id: applicantId, payment_id: saved.id }, actor);
  return saved;
}

const loadEntry = async (db: Db, applicantId: number, paymentId: number): Promise<Row> => {
  const [p] = await db.query(`select * from payments where id = $1 and applicant_id = $2`, [paymentId, applicantId]);
  if (!p) fail('payment', 'Payment entry not found.');
  return p;
};

/** Admin verifies one entry. Fully Paid notifies Admin and the assigned Sales user. */
export async function verifyEntry(db: Db, applicantId: number, paymentId: number, actor: Row): Promise<Row> {
  const result = await db.tx(async (tx) => {
    const a = await lock(tx, applicantId);
    const p = await loadEntry(tx, applicantId, paymentId);
    if (p.status !== 'pending') fail('payment', 'Only a payment entry waiting for review can be verified.');
    const plan = await loadPlan(tx, applicantId);
    const before = await totals(tx, a, plan);
    const saved = (await updateRow(tx, 'payments', p.id, { status: 'verified', verified_by_user_id: actor.id, verified_at: new Date() }))!;
    await syncLedger(tx, saved);
    const after = await totals(tx, a, plan);
    await logEvent(tx, a, 'payment_entry_verified', actor.id, { payment_id: p.id }, null, {
      step: STEP, old_values: { payment_id: p.id, status: 'pending' }, new_values: { payment_id: p.id, status: 'verified', verified_total: after.verified_cents / 100, payment_status: after.status },
    });
    return { a, saved, becameFullyPaid: before.status !== 'fully_paid' && after.status === 'fully_paid', amount: toCents(p.amount) };
  });
  await notifyAssignedSales(db, result.a, 'payment_entry_verified', 'Payment verified', `Admin verified the payment of ${money2(result.amount)} for ${result.a.full_name}.`, { payment_id: paymentId }, actor);
  if (result.becameFullyPaid) {
    const message = `The Payment Record of ${result.a.full_name} is Fully Paid. Admin can now complete it and move the applicant to For Approval.`;
    await notifyAssignedSales(db, result.a, 'payment_fully_paid', 'Fully Paid', message, {}, null);
    await notifyRoles(db, ['admin'], 'payment_fully_paid', 'Fully Paid', message, { applicant_id: applicantId }, null);
  }
  return result.saved;
}

/** Admin returns one entry with a reason; Sales submits a corrected entry (the number may be reused). */
export async function returnEntry(db: Db, applicantId: number, paymentId: number, actor: Row, reasonInput: unknown): Promise<Row> {
  const reason = requireReason(reasonInput, 'reason', 'a return reason');
  const result = await db.tx(async (tx) => {
    const a = await lock(tx, applicantId);
    const p = await loadEntry(tx, applicantId, paymentId);
    if (p.status !== 'pending') fail('payment', 'Only a payment entry waiting for review can be returned.');
    const saved = (await updateRow(tx, 'payments', p.id, { status: 'returned', returned_reason: reason, returned_at: new Date(), returned_by_user_id: actor.id }))!;
    await syncLedger(tx, saved);
    await logEvent(tx, a, 'payment_entry_returned', actor.id, { payment_id: p.id }, reason, {
      step: STEP, old_values: { payment_id: p.id, status: 'pending' }, new_values: { payment_id: p.id, status: 'returned' },
    });
    return { a, saved, amount: toCents(p.amount), orNumber: p.or_number };
  });
  await notifyAssignedSales(db, result.a, 'payment_entry_returned', 'Payment returned',
    `Admin returned the payment of ${money2(result.amount)} (OR/AR ${result.orNumber ?? '—'}) for ${result.a.full_name}: ${reason}. Submit a corrected entry.`, { payment_id: paymentId }, actor);
  return result.saved;
}

/** What the Payment Record page shows. Receipts only for Admin and the assigned Sales user. */
export async function recordPayload(db: Db, a: Row, user: Row, advanced: boolean, filesVisible: boolean): Promise<Row> {
  const plan = await loadPlan(db, a.id);
  const t = await totals(db, a, plan);
  const isAdmin = user.role?.name === 'admin';
  const isAssigned = user.role?.name === 'sales' && Number(a.assigned_sales_user_id) === Number(user.id);
  const rows = await db.query(
    `select p.*, (select full_name from users where id = p.recorded_by_user_id) as recorded_by_name,
       (select full_name from users where id = p.verified_by_user_id) as verified_by_name,
       (select full_name from users where id = p.returned_by_user_id) as returned_by_name,
       coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'original_name', d.original_name, 'mime_type', d.mime_type) order by d.id)
         from documents d where d.documentable_type = 'App\\Models\\Payment' and d.documentable_id = p.id and d.removed_at is null), '[]'::jsonb) as receipts
     from payments p where p.applicant_id = $1 order by p.payment_date, p.id`, [a.id],
  );
  const pendingCents = rows.filter((p) => ['pending', 'for_revision'].includes(p.status)).reduce((sum, p) => sum + toCents(p.amount), 0);
  const locked = await lockReason(db, a, plan);
  const report = await pendingRequest(db, a);
  const st = state(a);
  const history = await db.query(
    `select h.id, h.event, h.remarks, h.changed_at, h.actor_role, h.old_values, h.new_values, h.attachments, (select full_name from users where id = h.changed_by_user_id) as by_name
     from applicant_stage_histories h where h.applicant_id = $1 and (h.step = $2 or h.event like 'payment%' or h.step like 'applicant.payment%') order by h.id`, [a.id, STEP],
  );
  const discount = Number(plan?.total_required_discount_percent ?? a.total_required_discount_percent ?? 0);
  return {
    advanced,
    stage_label: 'Payment Record',
    state: st,
    agreed_amount: t.total_cents > 0 ? t.total_cents / 100 : null,
    package_name: plan?.package_name ?? a.package_name ?? null,
    source: plan?.agreed_amount_source ?? null,
    // An older record keeps its discount, read-only (the agreed amount is its total after discount).
    legacy_discount: discount > 0 ? {
      original_amount: toCents(plan?.total_required_original_amount ?? a.total_required_original_amount) / 100, discount_percent: discount, promo_name: plan?.promo_name ?? null,
    } : null,
    status: t.status, status_label: STATUS_LABELS[t.status] ?? 'Unpaid',
    verified_amount: t.verified_cents / 100, pending_amount: pendingCents / 100,
    remaining_amount: Math.max(0, t.total_cents - t.verified_cents) / 100, progress: t.progress,
    locked, has_entries: rows.some((p) => !['returned', 'rejected'].includes(p.status)),
    can_set_amount: isAdmin && !locked && !a.archived_at && (st !== null || a.status === 'payment_submitted'),
    can_add_entry: isAssigned && st === 'collecting' && !report && t.total_cents > 0 && !a.archived_at,
    can_review: isAdmin,
    can_complete: isAdmin && st === 'collecting' && t.total_cents > 0 && t.status === 'fully_paid' && pendingCents === 0 && !report && a.loi_status !== 'pending' && !a.archived_at,
    pending_sales_report: Boolean(report),
    methods: RECORD_METHODS,
    receipt_rule: { accept: RECEIPT_RULE.accept, max_mb: RECEIPT_RULE.max_kb / 1024 },
    entries: rows.map((p) => ({
      id: p.id, payment_date: p.payment_date, amount: toCents(p.amount) / 100, payment_method: p.payment_method,
      payment_method_label: RECORD_METHODS[p.payment_method] ?? (p.payment_method ? String(p.payment_method) : '—'),
      or_number: p.or_number, reference_number: p.reference_number, status: p.status, status_label: ENTRY_LABELS[p.status] ?? p.status,
      remarks: p.remarks, recorded_by: p.recorded_by_name, recorded_at: p.requested_at ?? p.created_at,
      verified_by: p.verified_by_name, verified_at: p.verified_at, returned_by: p.returned_by_name, returned_at: p.returned_at, returned_reason: p.returned_reason,
      receipts: filesVisible ? p.receipts : null,
      legacy_no_receipt: (p.receipts ?? []).length === 0,
      reviewable: isAdmin && p.status === 'pending' && p.payment_type === 'payment_record',
    })),
    history,
  };
}
