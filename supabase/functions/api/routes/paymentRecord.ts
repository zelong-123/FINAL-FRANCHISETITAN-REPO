// Payment Record routes: Admin sets the required payments and verifies or rejects entries; the
// assigned Sales user records one entry per required payment. No amounts anywhere.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Row } from '../lib/db.ts';
import { abort, ok, routeId } from '../lib/http.ts';
import { readInput } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { assertAssignedSales } from '../services/accountability.ts';
import { APPLICANT_MODEL } from '../services/applicantModel.ts';
import { editEntry, PAYMENT_MODEL, recordPayload, rejectEntry, setRequiredPayments, submitEntry, verifyEntry } from '../services/paymentRecord.ts';
import { canSeeRequirementFiles } from './requirements.ts';

export const paymentRecordRoutes = new Hono<AppEnv>();
const staff = role('admin', 'sales');

const loadApplicant = async (c: Context<AppEnv>): Promise<Row> => {
  const [a] = await c.get('deps').db.query(`select * from applicants where id = $1`, [routeId(c, 'applicant')]);
  requireFound(a);
  if (roleName(c) === 'sales' && a.archived_at) abort(404, 'Record not found.');
  return a;
};
const payload = async (c: Context<AppEnv>, applicantId: number) => {
  const { db } = c.get('deps');
  const [a] = await db.query(`select * from applicants where id = $1`, [applicantId]);
  return recordPayload(db, a, c.get('user'), canSeeRequirementFiles(c.get('user'), a));
};
const adminOnly = (c: Context<AppEnv>, message: string) => { if (roleName(c) !== 'admin') abort(403, message); };

paymentRecordRoutes.get('/applicants/:applicant/payment-record', staff, async (c) => {
  const a = await loadApplicant(c);
  return ok(c, await payload(c, a.id));
});

/** Admin: payment plan preset, required payment names (no amounts) and the Package or basis note. */
paymentRecordRoutes.put('/applicants/:applicant/required-payments', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  adminOnly(c, 'Only Admin can set the required payments. Sales sees them read-only.');
  const { before, after } = await setRequiredPayments(db, a.id, c.get('user'), await readInput(c));
  await audit(c, db, 'payment.required_updated', { type: APPLICANT_MODEL, id: a.id }, before, after);
  return ok(c, await payload(c, a.id), 'Required payments saved.');
});

/** The assigned Sales user records (or, after a rejection, resubmits) one required payment. */
paymentRecordRoutes.post('/applicants/:applicant/payment-entries', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  if (roleName(c) !== 'sales') abort(403, 'Only the assigned Sales user records payments. Admin verifies them.');
  await assertAssignedSales(c, a);
  const entry = await submitEntry(c, db, a.id, c.get('user'), await readInput(c));
  await audit(c, db, 'payment.entry_submitted', { type: PAYMENT_MODEL, id: entry.id }, null, { ...entry, receipt: undefined, receipts: (entry.receipts ?? []).map((r: Row) => r.id) });
  return ok(c, { entry, payment_record: await payload(c, a.id) }, 'Submitted for verification.', 201);
});

/** The encoder edits an entry that is still For verification. */
paymentRecordRoutes.put('/applicants/:applicant/payment-entries/:payment', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  if (roleName(c) !== 'sales') abort(403, 'Only the assigned Sales user edits payment entries.');
  await assertAssignedSales(c, a);
  const { before, saved } = await editEntry(c, db, a.id, routeId(c, 'payment'), c.get('user'), await readInput(c));
  const pick = (p: Row) => ({ payment_date: p.payment_date, payment_method: p.payment_method, or_number: p.or_number, reference_number: p.reference_number, remarks: p.remarks, revision: p.revision });
  await audit(c, db, 'payment.entry_edited', { type: PAYMENT_MODEL, id: saved.id }, pick(before), pick(saved));
  return ok(c, await payload(c, a.id), 'Entry updated — still waiting for Admin to verify it.');
});

paymentRecordRoutes.post('/applicants/:applicant/payment-entries/:payment/verify', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  adminOnly(c, 'Only Admin can verify a payment.');
  const input = await readInput(c);
  const saved = await verifyEntry(db, a.id, routeId(c, 'payment'), c.get('user'), input.revision);
  await audit(c, db, 'payment.entry_verified', { type: PAYMENT_MODEL, id: saved.id }, { status: 'for_verification' }, { status: 'verified' });
  return ok(c, await payload(c, a.id), 'Payment verified.');
});

const reject = async (c: Context<AppEnv>) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  adminOnly(c, 'Only Admin can reject a payment.');
  const input = await readInput(c);
  const saved = await rejectEntry(db, a.id, routeId(c, 'payment'), c.get('user'), input.reason, input.revision);
  await audit(c, db, 'payment.entry_rejected', { type: PAYMENT_MODEL, id: saved.id }, { status: 'for_verification' }, { status: 'rejected', reason: saved.returned_reason });
  return ok(c, await payload(c, a.id), 'Payment rejected — Sales was told why.');
};
paymentRecordRoutes.post('/applicants/:applicant/payment-entries/:payment/reject', staff, reject);
/** Older name of the same action. */
paymentRecordRoutes.post('/applicants/:applicant/payment-entries/:payment/return', staff, reject);
