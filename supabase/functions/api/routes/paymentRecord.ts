// Payment Record routes: the assigned Sales user records entries, Admin verifies or returns them.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Row } from '../lib/db.ts';
import { abort, ok, routeId } from '../lib/http.ts';
import { readInput } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { assertAssignedSales } from '../services/accountability.ts';
import { PAYMENT_MODEL, paymentAdvanced, recordPayload, returnEntry, submitEntry, verifyEntry } from '../services/paymentRecord.ts';
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
  return recordPayload(db, a, c.get('user'), paymentAdvanced(c), canSeeRequirementFiles(c.get('user'), a));
};

paymentRecordRoutes.get('/applicants/:applicant/payment-record', staff, async (c) => {
  const a = await loadApplicant(c);
  return ok(c, await payload(c, a.id));
});

/** The assigned Sales user records one payment (date, amount, method, OR/AR, reference, receipt). */
paymentRecordRoutes.post('/applicants/:applicant/payment-entries', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  if (roleName(c) !== 'sales') abort(403, 'Only the assigned Sales user records payments. Admin verifies them.');
  await assertAssignedSales(c, a);
  const entry = await submitEntry(c, db, a.id, c.get('user'), await readInput(c));
  await audit(c, db, 'payment.entry_submitted', { type: PAYMENT_MODEL, id: entry.id }, null, entry);
  return ok(c, { entry, payment_record: await payload(c, a.id) }, 'Payment recorded — waiting for Admin to verify it.', 201);
});

paymentRecordRoutes.post('/applicants/:applicant/payment-entries/:payment/verify', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  if (roleName(c) !== 'admin') abort(403, 'Only Admin can verify a payment. Sales cannot verify its own entry.');
  const saved = await verifyEntry(db, a.id, routeId(c, 'payment'), c.get('user'));
  await audit(c, db, 'payment.entry_verified', { type: PAYMENT_MODEL, id: saved.id }, { status: 'pending' }, { status: 'verified' });
  return ok(c, await payload(c, a.id), 'Payment verified.');
});

paymentRecordRoutes.post('/applicants/:applicant/payment-entries/:payment/return', staff, async (c) => {
  const { db } = c.get('deps');
  const a = await loadApplicant(c);
  if (roleName(c) !== 'admin') abort(403, 'Only Admin can return a payment.');
  const input = await readInput(c);
  const saved = await returnEntry(db, a.id, routeId(c, 'payment'), c.get('user'), input.reason);
  await audit(c, db, 'payment.entry_returned', { type: PAYMENT_MODEL, id: saved.id }, { status: 'pending' }, { status: 'returned', reason: saved.returned_reason });
  return ok(c, await payload(c, a.id), 'Payment returned to Sales.');
});
