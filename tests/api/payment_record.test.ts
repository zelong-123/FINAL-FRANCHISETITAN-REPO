// Phase 4: Payment Record — recording payments that happened outside the system (no billing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { createStaff } from '../support/accounts.ts';

const { pg, call, login, deps } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
const otherSales = await createStaff(call, admin, { full_name: 'Pay Other Sales', email: 'pay.other@example.test', phone: '09179990004', role: 'sales' });

// Real file signatures: the receipt is checked by its contents, not only its name.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode('%PDF-1.4 receipt');
let n = 0;
let orSeq = 5000;
const nextOr = () => `OR-${(orSeq += 1)}`;
/** An applicant at the Payment Record stage with the LOI complete. */
async function atPayment(agreed: number | null = 50000) {
  n += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, application_date, assigned_sales_user_id, payment_stage_state, loi_status, loi_verification_status)
     values ($1, 'payment_submitted', '2026-01-01', $2, 'waiting_total', 'complete', 'verified') returning id`, [`Pay Person ${n}`, salesUser.id],
  );
  if (agreed) assert.equal((await call('PATCH', `/applicants/${a.id}/payment-plan`, { token: admin, body: { agreed_amount: agreed } })).status, 200);
  return a.id as number;
}
function entry(amount: number, extra: Record<string, string | null> = {}) {
  const form = new FormData();
  const values: Record<string, string | null> = { payment_date: '2026-11-01', amount: String(amount), payment_method: 'gcash', or_number: nextOr(), reference_number: `GC-${orSeq}`, ...extra };
  for (const [k, v] of Object.entries(values)) if (v !== null) form.set(k, v);
  if (extra.receipt !== null) form.set('receipt', new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }));
  return form;
}
const submit = (id: number, form: FormData, token = sales) => call('POST', `/applicants/${id}/payment-entries`, { token, form });
const verify = (id: number, entryId: number) => call('POST', `/applicants/${id}/payment-entries/${entryId}/verify`, { token: admin, body: {} });
const events = (id: number, event: string) => q(`select * from applicant_stage_histories where applicant_id = $1 and event = $2 order by id`, [id, event]);

test('each entry needs a date (not future), amount > 0, method, OR/AR, reference (non-cash) and a receipt', async () => {
  const id = await atPayment();
  assert.ok((await submit(id, entry(0))).json.errors.amount);
  assert.ok((await submit(id, entry(100, { payment_method: 'credit_card' }))).json.errors.payment_method);
  assert.ok((await submit(id, entry(100, { or_number: '' }))).json.errors.or_number);
  assert.match((await submit(id, entry(100, { reference_number: null }))).json.errors.reference_number[0], /required for every payment that is not cash/);
  assert.equal((await submit(id, entry(100, { payment_method: 'cash', reference_number: null }))).status, 201, 'cash needs no reference number');
  assert.match((await submit(id, entry(100, { receipt: null }))).json.errors.receipt[0], /Attach the receipt/);
  const wrongType = entry(100);
  wrongType.set('receipt', new File(['x'], 'receipt.docx'));
  assert.match((await submit(id, wrongType)).json.errors.receipt[0], /PDF, JPG or PNG/);
  const huge = entry(100);
  huge.set('receipt', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }));
  assert.match((await submit(id, huge)).json.errors.receipt[0], /may not be larger than 10 MB/);
  assert.match((await submit(id, entry(100, { payment_date: '2999-01-01' }))).json.errors.payment_date[0], /future/);
  assert.match((await submit(id, entry(60000))).json.errors.amount[0], /exceed the Agreed Package Amount/);
  assert.equal((await submit(id, entry(100), admin)).status, 403, 'Admin does not record payments for Sales');
  assert.equal((await submit(id, entry(100), otherSales)).status, 403);
});

test('the same OR/AR or reference number is refused — by the database too, even at the same moment', async () => {
  const a = await atPayment();
  const b = await atPayment();
  const or = 'OR-DUP-1';
  const twice = await Promise.all([
    submit(a, entry(1000, { or_number: or, reference_number: 'REF-A1' })),
    submit(b, entry(1000, { or_number: ` or-dup-1 `, reference_number: 'REF-B1' })),
  ]);
  assert.deepEqual(twice.map((r) => r.status).sort(), [201, 422], 'only one of the two is accepted');
  assert.equal(twice.find((r) => r.status === 422)!.json.errors.or_number[0], 'This OR/AR number is already recorded.');
  assert.equal((await q(`select count(*)::int c from payments where lower(btrim(or_number)) = 'or-dup-1'`))[0].c, 1);

  // The database itself refuses a second live row (no API in between).
  const [live] = await q(`select * from payments where lower(btrim(or_number)) = 'or-dup-1'`);
  await assert.rejects(() => q(`insert into payments (applicant_id, payment_type, amount, payment_date, status, recorded_by_user_id, or_number) values ($1, 'payment_record', 1, '2026-11-01', 'pending', $2, 'OR-DUP-1 ')`, [b, salesUser.id]), /payments_or_number_unique/);
  await assert.rejects(() => q(`insert into payments (applicant_id, payment_type, amount, payment_date, status, recorded_by_user_id, or_number, reference_number) values ($1, 'payment_record', 1, '2026-11-01', 'pending', $2, 'OR-OTHER', 'ref-a1')`, [b, salesUser.id]), /payments_reference_number_unique/);
  assert.match((await submit(b, entry(1000, { reference_number: 'REF-A1' }))).json.errors.reference_number[0], /This reference number is already recorded/);

  // A Returned entry frees its number for the corrected entry.
  assert.equal((await call('POST', `/applicants/${live.applicant_id}/payment-entries/${live.id}/return`, { token: admin, body: { reason: 'Amount is wrong.' } })).status, 200);
  assert.equal((await submit(Number(live.applicant_id), entry(1200, { or_number: 'OR-DUP-1', reference_number: 'REF-A1' }))).status, 201);
});

test('Admin verifies or returns (with a reason, the Sales user is told); no edits after submission', async () => {
  const id = await atPayment();
  const sent = await submit(id, entry(10000));
  const entryId = sent.json.data.entry.id;
  assert.ok((await q(`select 1 from system_notifications where user_id = $1 and type = 'payment_entry_submitted' and (data->>'applicant_id')::bigint = $2`, [adminUser.id, id])).length, 'Admin is notified');
  assert.ok((await call('POST', `/applicants/${id}/payment-entries/${entryId}/return`, { token: admin, body: { reason: 'no' } })).json.errors.reason);
  const returned = await call('POST', `/applicants/${id}/payment-entries/${entryId}/return`, { token: admin, body: { reason: 'Receipt photo is unreadable.' } });
  assert.equal(returned.json.data.entries[0].status, 'returned');
  const [alert] = await q(`select message from system_notifications where user_id = $1 and type = 'payment_entry_returned' and (data->>'applicant_id')::bigint = $2`, [salesUser.id, id]);
  assert.match(alert.message, /Receipt photo is unreadable/);
  assert.equal((await verify(id, entryId)).status, 422, 'a returned entry stays returned');
  for (const [method, path] of [['PUT', `/applicants/${id}/payments/${entryId}`], ['PATCH', `/applicants/${id}/payments/${entryId}`], ['DELETE', `/applicants/${id}/payments/${entryId}`]] as const) {
    assert.equal((await call(method, path, { token: sales, body: { amount: 1 } })).status, 422, `${method} is refused`);
  }
});

test('status comes only from Verified entries, Fully Paid notifies both sides, Complete needs it', async () => {
  const id = await atPayment(30000);
  const view = async () => (await call('GET', `/applicants/${id}`, { token: admin })).json.data.payment_record;
  assert.equal((await view()).status_label, 'Unpaid');
  const one = (await submit(id, entry(10000))).json.data.entry.id;
  assert.equal((await view()).status_label, 'Unpaid', 'a pending entry does not count');
  await verify(id, one);
  assert.equal((await view()).status_label, 'Partially Paid');
  const two = (await submit(id, entry(20000))).json.data.entry.id;
  assert.match((await call('POST', `/applicants/${id}/payments/complete`, { token: admin, body: {} })).json.errors.payments[0], /awaiting review|Remaining/);
  await verify(id, two);
  assert.equal((await view()).status_label, 'Fully Paid');
  const told = await q(`select user_id from system_notifications where type = 'payment_fully_paid' and (data->>'applicant_id')::bigint = $1`, [id]);
  assert.ok(told.some((r) => Number(r.user_id) === salesUser.id) && told.some((r) => Number(r.user_id) === adminUser.id), 'Admin and the assigned Sales user');
  const done = await call('POST', `/applicants/${id}/payments/complete`, { token: admin, body: {} });
  assert.equal(done.json.data.status, 'for_approval');
});

test('the Agreed Package Amount: reason after payments, logged, never below Verified, locked when Fully Paid or confirmed', async () => {
  const id = await atPayment(40000);
  const set = (body: any) => call('PATCH', `/applicants/${id}/payment-plan`, { token: admin, body });
  assert.equal((await set({ agreed_amount: 45000 })).status, 200, 'no payments yet: no reason needed');
  const e = (await submit(id, entry(20000))).json.data.entry.id;
  await verify(id, e);
  assert.match((await set({ agreed_amount: 50000 })).json.errors.reason[0], /at least 5 characters/);
  assert.match((await set({ agreed_amount: 15000, reason: 'Package downgraded.' })).json.errors.agreed_amount[0], /cannot be lower than the Verified payments \(₱20,000\.00\)/);
  assert.equal((await set({ agreed_amount: 50000, reason: 'Signed LOI says 50,000.' })).status, 200);
  const [log] = await events(id, 'payment_agreed_amount_changed').then((rows) => rows.slice(-1));
  assert.equal(log.old_values.agreed_amount, 45000);
  assert.equal(log.new_values.agreed_amount, 50000);
  assert.equal(log.remarks, 'Signed LOI says 50,000.');
  assert.equal(log.actor_role, 'admin');
  assert.ok(log.changed_at);
  assert.equal((await set({ agreed_amount: 50000, reason: 'same', discount_percent: 10 })).status, 422, 'no discount while the features are off');

  const rest = (await submit(id, entry(30000))).json.data.entry.id;
  await verify(id, rest);
  assert.match((await set({ agreed_amount: 60000, reason: 'Added an equipment fee.' })).json.errors.agreed_amount[0], /Fully Paid and locked/);
  await call('POST', `/applicants/${id}/payments/complete`, { token: admin, body: {} });
  assert.match((await set({ agreed_amount: 60000, reason: 'Added an equipment fee.' })).json.errors.agreed_amount[0], /confirmed and locked/);
});

test('every action leaves an append-only history record with who, role, values, reason and file', async () => {
  const id = await atPayment(10000);
  const sent = await submit(id, entry(4000, { or_number: 'OR-HIST-1', reference_number: 'GC-HIST-1' }));
  await call('POST', `/applicants/${id}/payment-entries/${sent.json.data.entry.id}/return`, { token: admin, body: { reason: 'Wrong amount on the slip.' } });
  const fixed = await submit(id, entry(10000, { or_number: 'OR-HIST-1', reference_number: 'GC-HIST-1' }));
  await verify(id, fixed.json.data.entry.id);
  await call('POST', `/applicants/${id}/payments/complete`, { token: admin, body: {} });

  const [setLog] = await events(id, 'payment_agreed_amount_set');
  assert.equal(setLog.new_values.agreed_amount, 10000);
  const [submitted] = await events(id, 'payment_entry_submitted');
  assert.equal(submitted.actor_role, 'sales');
  assert.equal(submitted.step, 'payment_record');
  assert.equal(submitted.new_values.or_number, 'OR-HIST-1');
  assert.equal(submitted.attachments[0].type, 'payment_receipt');
  const [returnedLog] = await events(id, 'payment_entry_returned');
  assert.equal(returnedLog.remarks, 'Wrong amount on the slip.');
  assert.deepEqual([returnedLog.old_values.status, returnedLog.new_values.status], ['pending', 'returned']);
  const [verifiedLog] = await events(id, 'payment_entry_verified');
  assert.equal(verifiedLog.new_values.payment_status, 'fully_paid');
  const [completed] = await q(`select * from applicant_stage_histories where applicant_id = $1 and to_stage = 'for_approval' and from_stage = 'payment_submitted'`, [id]);
  assert.equal(Number(completed.changed_by_user_id), adminUser.id);
  const record = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.payment_record;
  assert.ok(record.history.length >= 5, 'the Payment Record page carries these records');
  await assert.rejects(() => q(`update applicant_stage_histories set remarks = 'x' where id = $1`, [returnedLog.id]), /append-only/);
});

test('receipts are private, and older entries without one show "Legacy - no receipt captured"', async () => {
  const id = await atPayment();
  const sent = await submit(id, entry(5000));
  const doc = sent.json.data.entry.receipt.id;
  const url = `/applicants/${id}/payments/${sent.json.data.entry.id}/documents/${doc}/download`;
  assert.equal((await call('GET', url, { token: admin })).status, 200);
  assert.equal((await call('GET', url, { token: sales })).status, 200);
  assert.equal((await call('GET', url, { token: otherSales })).status, 403);
  assert.equal((await call('GET', url, { token: marketing })).status, 403);
  assert.equal((await call('GET', `/applicants/${id}`, { token: otherSales })).json.data.payment_record.entries[0].receipts, null);

  await q(`insert into payments (applicant_id, payment_type, amount, payment_date, status, recorded_by_user_id) values ($1, 'downpayment', 1000, '2026-01-05', 'verified', $2)`, [id, salesUser.id]);
  const legacy = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.payment_record.entries.find((e: any) => e.payment_type === undefined && !e.or_number);
  assert.equal(legacy.legacy_no_receipt, true);
});

test('approval needs Fully Paid (100%); the old 80% rule is gone', async () => {
  const id = await atPayment(10000);
  const e = (await submit(id, entry(9000))).json.data.entry.id;
  await verify(id, e);
  await q(`update applicants set status = 'for_approval', payment_stage_state = 'confirmed', reviewed_at = now(),
           milestones = '{"qualification_profile_reviewed": true, "qualification_financial_capability_assessed": true, "qualification_initial_interview_completed": true, "qualification_preferred_location_evaluated": true, "qualification_investment_understood": true, "orientation_attended": true, "product_tasting_attended": true, "training_completed": true}'
           where id = $1`, [id]);
  await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, uploaded_by_user_id) values ('App\\Models\\Applicant', $1, 'loi', 'loi.pdf', 'x.pdf', 'private', 'x', $2)`, [id, salesUser.id]);
  const refused = await call('POST', `/applicants/${id}/approve`, { token: admin, body: {} });
  assert.equal(refused.status, 422, '90% is no longer enough');
  assert.match(refused.json.errors.status[0], /Fully Paid/);
});

test('with FEATURE_PAYMENT_ADVANCED on, the hidden features still work; a pending Sales Report survives turning it off', async () => {
  deps.paymentAdvanced = true;
  try {
    const id = await atPayment(null);
    const plan = await call('PATCH', `/applicants/${id}/payment-plan`, { token: admin, body: { total_required_amount: 100000, discount_percent: 20, promo_name: 'Launch' } });
    assert.equal(plan.json.data.total_required_amount, '80000.00', 'discount applies');
    assert.match((await call('POST', `/applicants/${id}/payments/report`, { token: sales, body: { entries: [{ amount: 100, payment_date: '2026-11-01' }] } })).json.errors.amount[0], /downpayment must be at least/);
    assert.equal((await call('POST', `/applicants/${id}/payments/report`, { token: sales, body: { entries: [{ amount: 20000, payment_date: '2026-11-01' }] } })).status, 201);
    const me = await call('GET', '/auth/me', { token: admin });
    assert.equal(me.json.data.features.payment_advanced, true);

    // Turned off with that report still waiting: Admin can still apply it, nobody is stuck.
    deps.paymentAdvanced = false;
    assert.equal((await call('POST', `/applicants/${id}/payments/apply-report`, { token: admin, body: {} })).status, 200);
    const record = (await call('GET', `/applicants/${id}`, { token: admin })).json.data;
    assert.equal(record.payment_record.agreed_amount, 80000, 'the stored total after discount is the agreed amount');
    assert.equal(record.payment_record.legacy_discount.discount_percent, 20, 'the old discount stays readable');
    assert.equal(record.payment_stage.installment, undefined, 'hidden fields are left out');
  } finally {
    deps.paymentAdvanced = false;
  }
});

test('the receipt is checked by its real contents, not only its name', async () => {
  const id = await atPayment();
  const renamed = entry(100);
  renamed.set('receipt', new File([new TextEncoder().encode('just some text')], 'receipt.pdf', { type: 'application/pdf' }));
  assert.match((await submit(id, renamed)).json.errors.receipt[0], /not a real PDF, JPG or PNG/);
  const mismatch = entry(100);
  mismatch.set('receipt', new File([PNG], 'receipt.jpg', { type: 'image/jpeg' }));
  assert.match((await submit(id, mismatch)).json.errors.receipt[0], /contents do not match/);
  const png = entry(100);
  png.set('receipt', new File([PNG], 'receipt.png', { type: 'image/png' }));
  assert.equal((await submit(id, png)).status, 201);
  const pdf = entry(100);
  pdf.set('receipt', new File([PDF], 'receipt.pdf', { type: 'application/pdf' }));
  assert.equal((await submit(id, pdf)).status, 201);
});

test('a legacy applicant (no payment state) with a partial verified payment cannot reach For Approval through any path', async () => {
  const legacy = async () => {
    n += 1;
    const [a] = await q(
      `insert into applicants (full_name, status, application_date, assigned_sales_user_id, payment_stage_state, loi_status, loi_verification_status, total_required_amount)
       values ($1, 'payment_submitted', '2026-01-01', $2, null, 'complete', 'verified', 10000) returning id`, [`Legacy Pay ${n}`, salesUser.id],
    );
    const [p] = await q(`insert into payments (applicant_id, payment_type, amount, payment_date, status, recorded_by_user_id) values ($1, 'downpayment', 4000, '2026-01-05', 'pending', $2) returning id`, [a.id, salesUser.id]);
    return { id: a.id as number, paymentId: p.id as number };
  };
  const status = async (id: number) => (await q(`select status from applicants where id = $1`, [id]))[0].status;

  // Advanced features off (the default): the older review only marks the entry.
  const off = await legacy();
  const reviewed = await call('PATCH', `/applicants/${off.id}/payments/${off.paymentId}/verify`, { token: admin, body: { status: 'verified' } });
  assert.equal(reviewed.status, 200);
  assert.equal(await status(off.id), 'payment_submitted', 'verifying one payment no longer moves the stage');
  assert.match((await call('PATCH', `/applicants/${off.id}/payments/${off.paymentId}/verify`, { token: admin, body: { status: 'rejected', remarks: 'Not valid.' } })).json.errors.status[0], /turned off/);
  assert.equal((await call('PATCH', `/applicants/${off.id}/status`, { token: admin, body: { status: 'for_approval', remarks: 'Skip it please.' } })).status, 422, 'no direct stage change');
  assert.equal((await call('POST', `/applicants/${off.id}/payments/complete`, { token: admin, body: {} })).status, 422, 'COMPLETED is refused');
  // The record continues as a Payment Record: setting the agreed amount does not make it Fully Paid.
  assert.equal((await call('PATCH', `/applicants/${off.id}/payment-plan`, { token: admin, body: { agreed_amount: 10000 } })).status, 200);
  assert.match((await call('POST', `/applicants/${off.id}/payments/complete`, { token: admin, body: {} })).json.errors.payments[0], /Remaining: ₱6,000\.00/);
  assert.equal(await status(off.id), 'payment_submitted');
  const [log] = await events(off.id, 'payment_entry_reviewed');
  assert.equal(log.new_values.status, 'verified');

  // Advanced features on: the older review would move the stage, but only when Fully Paid.
  deps.paymentAdvanced = true;
  try {
    const on = await legacy();
    const refused = await call('PATCH', `/applicants/${on.id}/payments/${on.paymentId}/verify`, { token: admin, body: { status: 'verified' } });
    assert.equal(refused.status, 422);
    assert.match(refused.json.errors.status[0], /Fully Paid/);
    assert.equal(await status(on.id), 'payment_submitted');
    assert.equal((await q(`select status from payments where id = $1`, [on.paymentId]))[0].status, 'pending', 'nothing was saved');
  } finally {
    deps.paymentAdvanced = false;
  }
});
