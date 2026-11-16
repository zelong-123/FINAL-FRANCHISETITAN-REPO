// Payment Record: the system RECORDS and VERIFIES payments that already happened outside it.
// No billing and no computation: there is no target amount, no amount per entry, no sum and no
// balance. Admin sets the applicant's required payments (names only); the assigned Sales user
// records one entry per required payment (date, method, OR/AR, reference, receipt); Admin
// verifies or rejects each entry. The stage is complete when every required payment is Verified.
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, insertRow, manilaToday, updateRow, ValidationError } from '../lib/http.ts';
import { MAX_UPLOAD_KB, sniffFileType, storeDocument } from '../lib/files.ts';
import { APPLICANT_MODEL, loadPlan } from './applicantModel.ts';
import { fileRef, logEvent } from './applicantStage.ts';
import { actionLabel } from './applicationDetail.ts';
import { notifyAssignedSales, requireReason } from './accountability.ts';
import { notifyRoles, notifyUser } from './notifications.ts';
import { lock, syncLedger } from './paymentStage.ts';
import {
  CUSTOM_PRESET, ENTRY_STATUS_LABELS, entryStatus, legacySatisfied, paymentProgress, PLAN_PRESETS, requiredItems, requiredPaymentsBlocker, withoutMoney,
} from './requiredPayments.ts';

export const PAYMENT_MODEL = 'App\\Models\\Payment';
export const RECORD_METHODS: Record<string, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', gcash: 'GCash', check: 'Check' };
export const RECEIPT_RULE = { accept: ['pdf', 'jpg', 'jpeg', 'png'], max_kb: MAX_UPLOAD_KB };
const STEP = 'payment_record';
const MAX_ITEMS = 20;
const MAX_NAME = 80;
const MAX_NOTE = 500;
const BADGE_LABELS: Record<string, string> = { unpaid: 'Unpaid', for_verification: 'For verification', completed: 'Completed' };
export const RECORD_NOTE = 'Records payments made outside the system. No billing or computation: the stage status comes only from Admin verification.';

/** The advanced billing features (Sales Reports, installments, discounts, due dates) are permanently off. */
export const OFF_MESSAGE = 'Billing and payment computation are not part of this system. The Payment Record only records payments made outside the system: one entry per required payment, verified by Admin.';

const normalized = (value: unknown) => String(value ?? '').trim();
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** The Payment Record is open for changes only at its own stage. */
function assertOpen(a: Row) {
  if (a.archived_at) fail('applicant', 'An archived applicant cannot change its Payment Record.');
  if (a.status !== 'payment_submitted') fail('payments', 'The Payment Record can only be changed at the Payment Record stage.');
}

// ---------------------------------------------------------------- required payments (Admin)

type ItemInput = { id?: number | null; name: string };

function cleanName(value: unknown, index: number): string {
  const name = normalized(value).replace(/\s+/g, ' ');
  if (!name) fail(`items.${index}.name`, 'Enter a name for every required payment.');
  if (name.length > MAX_NAME) fail(`items.${index}.name`, `A required payment name can have at most ${MAX_NAME} characters.`);
  if (/^[\d\s.,₱$-]+$/.test(name)) fail(`items.${index}.name`, 'A required payment is a name (e.g. "Reservation Fee"), not an amount.');
  return name;
}

/**
 * Admin saves the required payments: a preset fills the list, custom items can be added, and items
 * without an entry can be renamed, reordered or removed. Items with an entry (any status) are locked.
 * Body: { preset?, items?: [{ id?, name }], basis_note? }. With a preset and no items, the preset's
 * names are added after the locked items (switching plan never removes a locked item).
 */
export function setRequiredPayments(db: Db, applicantId: number, actor: Row, input: Row): Promise<Row> {
  return db.tx(async (tx) => {
    const a = await lock(tx, applicantId);
    assertOpen(a);
    const plan = await loadPlan(tx, applicantId);
    const current = await requiredItems(tx, applicantId);
    const locked = current.filter((i) => i.entry_count > 0);

    const preset = input.preset === undefined || input.preset === null || input.preset === '' ? null : String(input.preset);
    if (preset !== null && preset !== CUSTOM_PRESET && !PLAN_PRESETS[preset]) {
      fail('preset', `Choose a payment plan: ${Object.values(PLAN_PRESETS).map((p) => p.label).join(', ')} or Custom.`);
    }

    let wanted: ItemInput[];
    if (Array.isArray(input.items)) {
      wanted = input.items.map((item: Row, index: number) => ({ id: item?.id ? Number(item.id) : null, name: cleanName(item?.name, index) }));
    } else if (preset && PLAN_PRESETS[preset]) {
      const kept = locked.map((i) => ({ id: Number(i.id), name: String(i.name) }));
      const taken = new Set(kept.map((i) => i.name.toLowerCase()));
      wanted = [...kept, ...PLAN_PRESETS[preset].items.filter((n) => !taken.has(n.toLowerCase())).map((name) => ({ id: null, name }))];
    } else {
      wanted = current.map((i) => ({ id: Number(i.id), name: String(i.name) }));
    }
    if (wanted.length > MAX_ITEMS) fail('items', `An applicant can have at most ${MAX_ITEMS} required payments.`);
    const seen = new Set<string>();
    wanted.forEach((item, index) => {
      const key = item.name.toLowerCase();
      if (seen.has(key)) fail(`items.${index}.name`, `"${item.name}" is listed twice.`);
      seen.add(key);
    });
    const byId = new Map(current.map((i) => [Number(i.id), i]));
    for (const item of wanted) if (item.id && !byId.has(item.id)) fail('items', 'A required payment in the list no longer exists. Reload and try again.');

    // Locked items: never removed, never renamed.
    for (const item of locked) {
      const kept = wanted.find((w) => w.id === Number(item.id));
      if (!kept) fail('items', `"${item.name}" already has a payment entry, so it can't be removed.`);
      if (kept!.name !== item.name) fail('items', `"${item.name}" already has a payment entry, so it can't be renamed.`);
    }

    const note = 'basis_note' in input ? (normalized(input.basis_note) || null) : (plan?.basis_note ?? null);
    if (note && note.length > MAX_NOTE) fail('basis_note', `The Package or basis note can have at most ${MAX_NOTE} characters.`);
    const storedPreset = preset ?? plan?.payment_plan_preset ?? null;

    const before = { preset: plan?.payment_plan_preset ?? null, items: current.map((i) => i.name), basis_note: plan?.basis_note ?? null };
    const after = { preset: storedPreset, items: wanted.map((i) => i.name), basis_note: note };
    if (JSON.stringify(before) === JSON.stringify(after)) fail('items', 'Nothing changed.');

    // Removed: soft delete, so the record of what was required stays.
    const keepIds = new Set(wanted.filter((w) => w.id).map((w) => w.id));
    for (const item of current) {
      if (!keepIds.has(Number(item.id))) await updateRow(tx, 'applicant_required_payments', Number(item.id), { removed_at: new Date(), removed_by_user_id: actor.id });
    }
    // Renamed/reordered first move out of the way of the unique name index.
    for (const [index, item] of wanted.entries()) {
      if (item.id && byId.get(item.id)!.name !== item.name) await updateRow(tx, 'applicant_required_payments', item.id, { position: 1000 + index, name: `~renaming~${item.id}` });
    }
    for (const [index, item] of wanted.entries()) {
      if (item.id) await updateRow(tx, 'applicant_required_payments', item.id, { position: index + 1, name: item.name });
      else await insertRow(tx, 'applicant_required_payments', { applicant_id: applicantId, name: item.name, position: index + 1, created_by_user_id: actor.id });
    }
    const planFields = { payment_plan_preset: storedPreset, basis_note: note, required_set_at: new Date(), required_set_by_user_id: actor.id };
    if (plan) await updateRow(tx, 'applicant_payment_plans', plan.id, planFields);
    else await insertRow(tx, 'applicant_payment_plans', { applicant_id: applicantId, ...planFields });

    await logEvent(tx, a, 'payment_required_updated', actor.id, {}, null, {
      step: STEP,
      old_values: before,
      new_values: { ...after, basis_note_changed: before.basis_note !== after.basis_note },
    });
    await notifyAssignedSales(tx, a, 'payment_required_updated', 'Required payments updated',
      `Admin updated the required payments for ${a.full_name}: ${after.items.join(', ') || 'none'}.`, {}, actor);
    return { before, after };
  });
}

// ---------------------------------------------------------------- entries (assigned Sales)

/** A payment entry carries 1 or 2 receipt files (PDF, JPG or PNG, up to 10 MB each). */
export const MAX_RECEIPTS = 2;

type EntryFields = {
  payment_date: string; payment_method: string; or_number: string; reference_number: string | null; remarks: string | null;
  /** New receipt files in this request. */
  receipts: File[];
  /** Ids of receipts already on record to keep (null = not sent). */
  keep: number[] | null;
};

/** The receipt files of a request: \`receipt\` (one or several) or \`receipt[]\`. */
function receiptFiles(input: Row): File[] {
  const raw = input.receipt ?? input['receipt[]'];
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  return list.filter((f) => f instanceof File && f.size > 0) as File[];
}

/** keep_receipt_ids: "12,13" or repeated fields; an empty value means "keep none". */
function keepIds(input: Row): number[] | null {
  // Present but empty (normalized to null) means "keep none"; absent means "not sent".
  if (!('keep_receipt_ids' in input) && !('keep_receipt_ids[]' in input)) return null;
  const raw = input.keep_receipt_ids ?? input['keep_receipt_ids[]'];
  if (raw === undefined || raw === null) return [];
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(list)];
}

async function assertReceipt(file: File) {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!RECEIPT_RULE.accept.includes(ext)) fail('receipt', 'The receipt must be a PDF, JPG or PNG file.');
  if (file.size / 1024 > RECEIPT_RULE.max_kb) fail('receipt', `The receipt may not be larger than ${RECEIPT_RULE.max_kb / 1024} MB.`);
  // The contents must really be what the name says (a renamed file is refused).
  const real = await sniffFileType(file);
  const expected = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg';
  if (real !== expected) fail('receipt', 'The receipt file is not a real PDF, JPG or PNG (its contents do not match its type).');
}

async function readEntry(input: Row): Promise<EntryFields> {
  const date = normalized(input.payment_date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('payment_date', 'Enter the date the payment was made.');
  if (date > manilaToday()) fail('payment_date', 'The payment date cannot be in the future.');
  const method = normalized(input.payment_method);
  if (!RECORD_METHODS[method]) fail('payment_method', 'Choose Cash, Bank transfer, GCash or Check.');
  const orNumber = normalized(input.or_number);
  if (!orNumber) fail('or_number', 'Enter the OR or AR number.');
  if (orNumber.length > 60) fail('or_number', 'The OR/AR number is too long.');
  // Cash has no reference number: whatever is sent is ignored and stored as null.
  const reference = method === 'cash' ? '' : normalized(input.reference_number);
  if (method !== 'cash' && !reference) fail('reference_number', 'Enter the reference number (required for every payment that is not cash).');
  if (reference.length > 100) fail('reference_number', 'The reference number is too long.');
  const receipts = receiptFiles(input);
  if (receipts.length > MAX_RECEIPTS) fail('receipt', `A payment entry can have at most ${MAX_RECEIPTS} receipt files.`);
  for (const file of receipts) await assertReceipt(file);
  return {
    payment_date: date, payment_method: method, or_number: orNumber, reference_number: reference || null,
    remarks: normalized(input.remarks).slice(0, 2000) || null, receipts, keep: keepIds(input),
  };
}

/** 1 or 2 receipts in total (kept + new). */
function assertReceiptCount(total: number) {
  if (total < 1) fail('receipt', 'Attach the receipt (PDF, JPG or PNG).');
  if (total > MAX_RECEIPTS) fail('receipt', `A payment entry can have at most ${MAX_RECEIPTS} receipt files. Remove one first.`);
}

const liveReceipts = (db: Db, paymentId: number): Promise<Row[]> => db.query(
  `select * from documents where documentable_type = $1 and documentable_id = $2 and removed_at is null order by id`, [PAYMENT_MODEL, paymentId],
);

/** Copies a kept receipt of a rejected entry to the new entry (the rejected one keeps its own file as history). */
async function copyReceipt(c: Context<AppEnv>, db: Db, doc: Row, applicantId: number, paymentId: number, actor: Row): Promise<Row> {
  const { files } = c.get('deps');
  const bytes = await files.get(doc.disk, doc.path);
  if (!bytes) fail('keep_receipt_ids', `The receipt "${doc.original_name}" could not be found in storage. Attach it again.`);
  const ext = String(doc.original_name ?? '').split('.').pop() || 'bin';
  const storedName = `${crypto.randomUUID()}.${ext}`;
  const path = `applicants/${applicantId}/payments/${storedName}`;
  await files.put(doc.disk, path, bytes!, doc.mime_type || 'application/octet-stream');
  return insertRow(db, 'documents', {
    documentable_type: PAYMENT_MODEL, documentable_id: paymentId, type: 'payment_receipt', original_name: doc.original_name, stored_name: storedName,
    disk: doc.disk, path, mime_type: doc.mime_type, size_bytes: doc.size_bytes, uploaded_by_user_id: actor.id, metadata: { copied_from_document_id: doc.id },
  });
}

/** Turns the database's unique-index refusal into the clear message the user sees. */
function duplicateNumber(error: unknown): never {
  const e = error as Row;
  const where = `${e?.constraint_name ?? e?.constraint ?? ''} ${e?.message ?? ''}`;
  if (where.includes('one_live_entry')) throw new ValidationError({ required_payment_id: ['This required payment already has an entry waiting for verification or verified.'] });
  if (where.includes('reference_number')) throw new ValidationError({ reference_number: ['This reference number is already recorded.'] });
  throw new ValidationError({ or_number: ['This OR/AR number is already recorded.'] });
}

/** Rejected (returned) entries never block a number: the corrected entry may reuse it. */
async function assertNumbersFree(db: Db, fields: EntryFields, exceptId: number | null) {
  const [usedOr] = await db.query(
    `select 1 from payments where lower(btrim(or_number)) = lower($1) and status not in ('returned', 'rejected') and ($2::bigint is null or id <> $2) limit 1`,
    [fields.or_number, exceptId],
  );
  if (usedOr) fail('or_number', 'This OR/AR number is already recorded.');
  if (fields.reference_number) {
    const [usedRef] = await db.query(
      `select 1 from payments where lower(btrim(reference_number)) = lower($1) and status not in ('returned', 'rejected') and ($2::bigint is null or id <> $2) limit 1`,
      [fields.reference_number, exceptId],
    );
    if (usedRef) fail('reference_number', 'This reference number is already recorded.');
  }
}

const entryValues = (row: Row) => ({
  payment_id: row.id, required_payment_id: row.required_payment_id, payment_date: row.payment_date, payment_method: row.payment_method,
  or_number: row.or_number, reference_number: row.reference_number, remarks: row.remarks, status: entryStatus(row.status), revision: row.revision,
});
const receiptJson = (d: Row) => ({ id: d.id, original_name: d.original_name, mime_type: d.mime_type });

async function loadRequired(db: Db, applicantId: number, requiredId: unknown): Promise<Row> {
  const id = Number(requiredId);
  if (!Number.isInteger(id) || id <= 0) fail('required_payment_id', 'Choose which required payment this entry records.');
  const [item] = await db.query(`select * from applicant_required_payments where id = $1 and applicant_id = $2 and removed_at is null for update`, [id, applicantId]);
  if (!item) fail('required_payment_id', 'That required payment does not exist for this applicant. Reload and try again.');
  return item;
}

/**
 * The assigned Sales user records the entry of one required payment: new, or a resubmission after a
 * rejection. On a resubmission, keep_receipt_ids lists receipts of the rejected entry to carry over.
 */
export async function submitEntry(c: Context<AppEnv>, db: Db, applicantId: number, actor: Row, input: Row): Promise<Row> {
  const fields = await readEntry(input);
  let saved: Row;
  try {
    saved = await db.tx(async (tx) => {
      const a = await lock(tx, applicantId);
      assertOpen(a);
      const item = await loadRequired(tx, applicantId, input.required_payment_id);
      const [latest] = await tx.query(`select * from payments where required_payment_id = $1 order by id desc limit 1`, [item.id]);
      if (latest && entryStatus(latest.status) === 'verified') fail('required_payment_id', `${item.name} is already Verified and locked.`);
      if (latest && entryStatus(latest.status) === 'for_verification') fail('required_payment_id', `${item.name} is already waiting for Admin to verify it. Edit that entry instead.`);
      const keepable = latest ? await liveReceipts(tx, latest.id) : [];
      const keep = fields.keep ?? [];
      const kept = keep.map((id) => keepable.find((d) => Number(d.id) === id));
      if (kept.some((d) => !d)) fail('keep_receipt_ids', 'Only receipts of the rejected entry can be kept. Reload and try again.');
      assertReceiptCount(kept.length + fields.receipts.length);
      await assertNumbersFree(tx, fields, null);
      const row = await insertRow(tx, 'payments', {
        applicant_id: applicantId, required_payment_id: item.id, payment_type: 'payment_record', amount: null, payment_date: fields.payment_date,
        payment_method: fields.payment_method, or_number: fields.or_number, reference_number: fields.reference_number, status: 'pending',
        department: 'Sales', requested_at: new Date(), recorded_by_user_id: actor.id, received_by_user_id: actor.id, remarks: fields.remarks, revision: 1,
      });
      await syncLedger(tx, row);
      const docs: Row[] = [];
      for (const doc of kept) docs.push(await copyReceipt(c, tx, doc!, applicantId, row.id, actor));
      for (const file of fields.receipts) docs.push(await storeDocument(c, tx, file, `applicants/${applicantId}/payments`, { type: PAYMENT_MODEL, id: row.id }, 'payment_receipt'));
      await logEvent(tx, a, latest ? 'payment_entry_resubmitted' : 'payment_entry_submitted', actor.id, { payment_id: row.id }, fields.remarks, {
        step: STEP, new_values: { ...entryValues(row), required_payment: item.name, receipts: docs.length, kept_receipts: kept.length },
        attachments: docs.map((d) => fileRef(d)!),
      });
      return { ...row, receipts: docs, required_payment: item.name, applicant: a, resubmitted: Boolean(latest) };
    });
  } catch (error) {
    if ((error as Row)?.code === '23505') duplicateNumber(error);
    throw error;
  }
  await notifyRoles(db, ['admin'], 'payment_entry_submitted', 'Payment entry to verify',
    `${actor.full_name} ${saved.resubmitted ? 'resubmitted' : 'recorded'} the ${saved.required_payment} (OR/AR ${saved.or_number}) for ${saved.applicant.full_name}. Verify or reject it.`,
    { applicant_id: applicantId, payment_id: saved.id }, actor);
  return {
    ...entryValues(saved), id: saved.id, required_payment: saved.required_payment, recorded_by_user_id: saved.recorded_by_user_id,
    receipt: receiptJson(saved.receipts[0]), receipts: saved.receipts.map(receiptJson),
  };
}

/**
 * The encoder edits an entry that is still For verification. keep_receipt_ids lists the receipts to
 * keep (absent = keep all); receipts not kept are deleted, row and stored file. Each edit raises the revision.
 */
export async function editEntry(c: Context<AppEnv>, db: Db, applicantId: number, paymentId: number, actor: Row, input: Row): Promise<Row> {
  const fields = await readEntry(input);
  let result: { before: Row; saved: Row; dropped: Row[] };
  try {
    result = await db.tx(async (tx) => {
      const a = await lock(tx, applicantId);
      assertOpen(a);
      const [p] = await tx.query(`select * from payments where id = $1 and applicant_id = $2 for update`, [paymentId, applicantId]);
      if (!p || !p.required_payment_id) fail('payment', 'Payment entry not found.');
      if (Number(p.recorded_by_user_id) !== Number(actor.id)) abort(403, 'You can only edit a payment entry that you recorded yourself.');
      if (entryStatus(p.status) === 'verified') fail('payment', 'This payment is Verified and locked: its receipts can no longer change.');
      if (entryStatus(p.status) === 'rejected') fail('payment', 'This entry was rejected. Submit a corrected entry instead; the rejected one stays in the history.');
      const current = await liveReceipts(tx, p.id);
      const keep = fields.keep ?? current.map((d) => Number(d.id));
      if (keep.some((id) => !current.some((d) => Number(d.id) === id))) fail('keep_receipt_ids', 'Only receipts of this entry can be kept. Reload and try again.');
      assertReceiptCount(keep.length + fields.receipts.length);
      await assertNumbersFree(tx, fields, p.id);
      const { receipts, keep: _keep, ...values } = fields;
      const saved = (await updateRow(tx, 'payments', p.id, { ...values, revision: Number(p.revision ?? 1) + 1, requested_at: new Date() }))!;
      await syncLedger(tx, saved);
      // Not yet reviewed, so a removed or replaced receipt leaves no trace: row and file are deleted.
      const dropped = current.filter((d) => !keep.includes(Number(d.id)));
      if (dropped.length) await tx.query(`delete from documents where id = any($1::bigint[])`, [`{${dropped.map((d) => d.id).join(',')}}`]);
      const added: Row[] = [];
      for (const file of receipts) added.push(await storeDocument(c, tx, file, `applicants/${applicantId}/payments`, { type: PAYMENT_MODEL, id: p.id }, 'payment_receipt'));
      await logEvent(tx, a, 'payment_entry_edited', actor.id, { payment_id: p.id }, null, {
        step: STEP, old_values: { ...entryValues(p), receipts: current.length }, new_values: { ...entryValues(saved), receipts: keep.length + added.length },
        attachments: [...added.map((d) => fileRef(d)!), ...dropped.map((d) => ({ ...fileRef(d)!, state: 'removed' }))],
      });
      return { before: p, saved, dropped };
    });
  } catch (error) {
    if ((error as Row)?.code === '23505') duplicateNumber(error);
    throw error;
  }
  // Files go after the commit, so a failed edit never loses a file. A path another row still uses is kept.
  const { files } = c.get('deps');
  for (const d of result.dropped) {
    const [other] = await db.query(`select 1 from documents where disk = $1 and path = $2 limit 1`, [d.disk, d.path]);
    if (!other) await files.remove(d.disk, [d.path]).catch(() => {});
  }
  return { before: result.before, saved: result.saved };
}

// ---------------------------------------------------------------- verification (Admin)

function readRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) fail('revision', 'Reload the Payment Record before verifying or rejecting (the entry version is missing).');
  return revision;
}

async function loadForReview(db: Db, applicantId: number, paymentId: number, actor: Row, revisionInput: unknown, verb: string): Promise<{ a: Row; p: Row; item: Row | null }> {
  const revision = readRevision(revisionInput);
  const a = await lock(db, applicantId);
  if (a.archived_at) fail('applicant', 'An archived applicant cannot change its Payment Record.');
  const [p] = await db.query(`select * from payments where id = $1 and applicant_id = $2 for update`, [paymentId, applicantId]);
  if (!p) fail('payment', 'Payment entry not found.');
  if (Number(p.recorded_by_user_id) === Number(actor.id)) abort(403, `You cannot ${verb} a payment entry that you encoded yourself.`);
  if (entryStatus(p.status) !== 'for_verification') fail('payment', `Only an entry that is For verification can be ${verb === 'verify' ? 'verified' : 'rejected'}.`);
  if (Number(p.revision ?? 1) !== revision) {
    fail('revision', 'Sales changed this entry after you opened it. Reload the Payment Record and review the latest details before you decide.');
  }
  const [item] = p.required_payment_id ? await db.query(`select * from applicant_required_payments where id = $1`, [p.required_payment_id]) : [];
  return { a, p, item: item ?? null };
}

export async function verifyEntry(db: Db, applicantId: number, paymentId: number, actor: Row, revision: unknown): Promise<Row> {
  const result = await db.tx(async (tx) => {
    const { a, p, item } = await loadForReview(tx, applicantId, paymentId, actor, revision, 'verify');
    const saved = (await updateRow(tx, 'payments', p.id, { status: 'verified', verified_by_user_id: actor.id, verified_at: new Date() }))!;
    await syncLedger(tx, saved);
    const progress = await paymentProgress(tx, applicantId);
    await logEvent(tx, a, 'payment_entry_verified', actor.id, { payment_id: p.id }, null, {
      step: STEP, old_values: { payment_id: p.id, status: 'for_verification' },
      new_values: { payment_id: p.id, status: 'verified', required_payment: item?.name ?? null, verified_count: progress.verified, required_count: progress.required },
    });
    return { a, p, saved, name: item?.name ?? 'payment' };
  });
  await notifyUser(db, Number(result.p.recorded_by_user_id), 'payment_entry_verified', 'Payment verified',
    `Admin verified the ${result.name} (OR/AR ${result.p.or_number ?? '—'}) for ${result.a.full_name}.`, { applicant_id: applicantId, payment_id: paymentId }, actor);
  return result.saved;
}

export async function rejectEntry(db: Db, applicantId: number, paymentId: number, actor: Row, reasonInput: unknown, revision: unknown): Promise<Row> {
  const reason = requireReason(reasonInput, 'reason', 'a rejection reason');
  const result = await db.tx(async (tx) => {
    const { a, p, item } = await loadForReview(tx, applicantId, paymentId, actor, revision, 'reject');
    const saved = (await updateRow(tx, 'payments', p.id, { status: 'returned', returned_reason: reason, returned_at: new Date(), returned_by_user_id: actor.id }))!;
    await syncLedger(tx, saved);
    await logEvent(tx, a, 'payment_entry_rejected', actor.id, { payment_id: p.id }, reason, {
      step: STEP, old_values: { payment_id: p.id, status: 'for_verification' }, new_values: { payment_id: p.id, status: 'rejected', required_payment: item?.name ?? null },
    });
    return { a, p, saved, name: item?.name ?? 'payment' };
  });
  await notifyUser(db, Number(result.p.recorded_by_user_id), 'payment_entry_rejected', 'Payment rejected',
    `Admin rejected the ${result.name} (OR/AR ${result.p.or_number ?? '—'}) for ${result.a.full_name}: ${reason}. Correct it and resubmit.`,
    { applicant_id: applicantId, payment_id: paymentId, reason }, actor);
  return result.saved;
}

/** Admin moves the applicant to For Approval. onMove shares the transaction (the stage transition). */
export function moveToForApproval(db: Db, applicantId: number, actor: Row, remarks: string | null, onMove: (tx: Db, a: Row) => Promise<void>): Promise<Row> {
  return db.tx(async (tx) => {
    const a = await lock(tx, applicantId);
    if (a.archived_at) fail('applicant', 'An archived applicant cannot move forward.');
    if (a.status !== 'payment_submitted') fail('payments', 'Only an applicant at the Payment Record stage can move to For Approval.');
    const blocker = await requiredPaymentsBlocker(tx, a);
    if (blocker) fail('payments', blocker);
    const fresh = (await updateRow(tx, 'applicants', applicantId, {
      payment_stage_state: 'confirmed', payment_confirmed_at: new Date(), payment_confirmed_by_user_id: actor.id, payment_remarks: remarks ?? a.payment_remarks,
    }))!;
    await onMove(tx, fresh);
    await notifyAssignedSales(tx, fresh, 'payment_confirmed', 'Payment Record completed',
      `All required payments of ${fresh.full_name} are Verified. Admin moved the applicant to For Approval.`, {}, actor);
    return (await tx.query(`select * from applicants where id = $1`, [applicantId]))[0];
  });
}

// ---------------------------------------------------------------- what the page shows

function entryJson(p: Row, user: Row, isAdmin: boolean, isAssigned: boolean, open: boolean, filesVisible: boolean): Row {
  const status = entryStatus(p.status);
  return {
    id: p.id, required_payment_id: p.required_payment_id, revision: Number(p.revision ?? 1),
    payment_date: p.payment_date, payment_method: p.payment_method,
    payment_method_label: RECORD_METHODS[p.payment_method] ?? (p.payment_method ? String(p.payment_method) : '—'),
    or_number: p.or_number, reference_number: p.reference_number, remarks: p.remarks,
    status, status_label: ENTRY_STATUS_LABELS[status],
    recorded_by: p.recorded_by_name, recorded_by_user_id: p.recorded_by_user_id, recorded_at: iso(p.requested_at ?? p.created_at),
    verified_by: status === 'verified' ? p.verified_by_name : null, verified_at: status === 'verified' ? iso(p.verified_at) : null,
    rejected_by: status === 'rejected' ? (p.returned_by_name ?? p.verified_by_name) : null,
    rejected_at: status === 'rejected' ? iso(p.returned_at ?? p.verified_at) : null,
    rejected_reason: status === 'rejected' ? (p.returned_reason ?? null) : null,
    receipts: filesVisible ? p.receipts : null,
    legacy_no_receipt: (p.receipts ?? []).length === 0,
    reviewable: isAdmin && status === 'for_verification' && Number(p.recorded_by_user_id) !== Number(user.id) && !p.archived,
    editable: isAssigned && open && status === 'for_verification' && Number(p.recorded_by_user_id) === Number(user.id),
  };
}

/** The Payment Record payload. It carries no amount, total, balance or percentage. */
export async function recordPayload(db: Db, a: Row, user: Row, filesVisible: boolean): Promise<Row> {
  const plan = await loadPlan(db, a.id);
  const isAdmin = user.role?.name === 'admin';
  const isAssigned = user.role?.name === 'sales' && Number(a.assigned_sales_user_id) === Number(user.id);
  const open = a.status === 'payment_submitted' && !a.archived_at;
  const progress = await paymentProgress(db, a.id);
  const rows = await db.query(
    `select p.id, p.required_payment_id, p.revision, p.payment_date, p.payment_method, p.or_number, p.reference_number, p.remarks, p.status,
       p.recorded_by_user_id, p.requested_at, p.created_at, p.verified_at, p.returned_at, p.returned_reason,
       (select full_name from users where id = p.recorded_by_user_id) as recorded_by_name,
       (select full_name from users where id = p.verified_by_user_id) as verified_by_name,
       (select full_name from users where id = p.returned_by_user_id) as returned_by_name,
       coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'original_name', d.original_name, 'mime_type', d.mime_type) order by d.id)
         from documents d where d.documentable_type = 'App\\Models\\Payment' and d.documentable_id = p.id and d.removed_at is null), '[]'::jsonb) as receipts
     from payments p where p.applicant_id = $1 order by p.id`, [a.id],
  );
  const json = (p: Row) => entryJson({ ...p, archived: Boolean(a.archived_at) }, user, isAdmin, isAssigned, open, filesVisible);
  const required = progress.items.map((item) => {
    const own = rows.filter((p) => Number(p.required_payment_id) === Number(item.id));
    const latest = own[own.length - 1] ?? null;
    const locked = own.length > 0;
    return {
      id: item.id, name: item.name, position: item.position, status: item.status, status_label: ENTRY_STATUS_LABELS[item.status],
      locked, lock_label: !locked ? null : item.status === 'verified' ? 'Verified · locked' : 'Has entry · locked',
      entry: latest ? json(latest) : null,
      history: own.slice(0, -1).map(json),
      can_record: isAssigned && open && ['not_yet_paid', 'rejected'].includes(item.status),
    };
  });
  const [loi] = await db.query(
    `select id, original_name, mime_type from documents where documentable_type = $1 and documentable_id = $2 and type = 'loi' and removed_at is null and replaced_at is null order by id desc limit 1`,
    [APPLICANT_MODEL, a.id],
  );
  const blocker = await requiredPaymentsBlocker(db, a);
  const loiPending = a.loi_status === 'pending';
  const history = await db.query(
    `select h.id, h.event, h.from_stage, h.to_stage, h.remarks, h.changed_at, h.actor_role, h.old_values, h.new_values, h.attachments, (select full_name from users where id = h.changed_by_user_id) as by_name
     from applicant_stage_histories h where h.applicant_id = $1 and (h.step = $2 or h.event like 'payment%' or h.step like 'applicant.payment%') order by h.id`, [a.id, STEP],
  );
  return {
    stage_label: 'Payment Record',
    note: RECORD_NOTE,
    badge: progress.badge,
    badge_label: BADGE_LABELS[progress.badge],
    preset: plan?.payment_plan_preset ?? null,
    preset_options: [
      ...Object.entries(PLAN_PRESETS).map(([value, p]) => ({ value, label: p.label, items: p.items })),
      { value: CUSTOM_PRESET, label: 'Custom', items: [] },
    ],
    basis_note: plan?.basis_note ?? null,
    required_set_at: iso(plan?.required_set_at),
    required,
    required_count: progress.required,
    verified_count: progress.verified,
    all_verified: progress.all_verified,
    legacy_confirmed: progress.required === 0 && legacySatisfied(a),
    // Entries recorded before required payments existed: read-only, and without amounts.
    earlier_entries: rows.filter((p) => !p.required_payment_id).map((p) => ({ ...json(p), reviewable: false, editable: false })),
    loi_document: filesVisible && loi ? loi : null,
    // Older applicants past LOI Submission may have no file: the card says so instead of a broken link.
    loi_file_missing: filesVisible && !loi,
    can_edit_required: isAdmin && open,
    can_record: isAssigned && open,
    can_review: isAdmin,
    can_move: isAdmin && open && !blocker && !loiPending,
    move_blocker: open ? (blocker ?? (loiPending ? 'The LOI is still Pending. Complete it in the LOI section first.' : null)) : null,
    methods: RECORD_METHODS,
    receipt_rule: { accept: RECEIPT_RULE.accept, max_mb: RECEIPT_RULE.max_kb / 1024, max_files: MAX_RECEIPTS },
    history: history.map((h) => ({ ...h, action: actionLabel(h), old_values: withoutMoney(h.old_values), new_values: withoutMoney(h.new_values) })),
  };
}
