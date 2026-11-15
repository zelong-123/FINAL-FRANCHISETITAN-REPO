// Payment Record without billing: required payments (names only), one entry per required payment,
// Admin verification, and the gate "every required payment Verified". No amounts anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { createStaff } from '../support/accounts.ts';

const { pg, call, login } = await setup();
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
let seq = 5000;

/** An applicant at the Payment Record stage with the LOI complete, optionally with a plan preset. */
async function atPayment(preset: string | null = 'reservation_full') {
  n += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, application_date, assigned_sales_user_id, payment_stage_state, loi_status, loi_verification_status)
     values ($1, 'payment_submitted', '2026-01-01', $2, 'waiting_total', 'complete', 'verified') returning id`, [`Pay Person ${n}`, salesUser.id],
  );
  if (preset) assert.equal((await setRequired(a.id, { preset })).status, 200);
  return a.id as number;
}
const setRequired = (id: number, body: any, token = admin) => call('PUT', `/applicants/${id}/required-payments`, { token, body });
const record = async (id: number, token = admin) => (await call('GET', `/applicants/${id}/payment-record`, { token })).json.data;
const itemId = async (id: number, name: string) => (await record(id)).required.find((r: any) => r.name === name).id as number;

function entry(requiredId: number, extra: Record<string, string | null> = {}) {
  seq += 1;
  const form = new FormData();
  const values: Record<string, string | null> = {
    required_payment_id: String(requiredId), payment_date: '2026-11-01', payment_method: 'gcash', or_number: `OR-${seq}`, reference_number: `GC-${seq}`, ...extra,
  };
  for (const [k, v] of Object.entries(values)) if (v !== null) form.set(k, v);
  if (extra.receipt !== null) form.set('receipt', new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }));
  return form;
}
const submit = (id: number, form: FormData, token = sales) => call('POST', `/applicants/${id}/payment-entries`, { token, form });
const entryOf = async (id: number, name: string) => (await record(id)).required.find((r: any) => r.name === name).entry;
const verify = async (id: number, entryId: number, token = admin, revision?: number) => {
  const rev = revision ?? (await q(`select revision from payments where id = $1`, [entryId]))[0].revision;
  return call('POST', `/applicants/${id}/payment-entries/${entryId}/verify`, { token, body: { revision: rev } });
};
const reject = async (id: number, entryId: number, reason: string, token = admin, revision?: number) => {
  const rev = revision ?? (await q(`select revision from payments where id = $1`, [entryId]))[0].revision;
  return call('POST', `/applicants/${id}/payment-entries/${entryId}/reject`, { token, body: { reason, revision: rev } });
};
const move = (id: number) => call('POST', `/applicants/${id}/payments/complete`, { token: admin, body: {} });
const events = (id: number, event: string) => q(`select * from applicant_stage_histories where applicant_id = $1 and event = $2 order by id`, [id, event]);
/** Records and verifies every required payment of the applicant. */
async function payAll(id: number) {
  for (const item of (await record(id)).required) {
    const sent = await submit(id, entry(item.id));
    assert.equal(sent.status, 201, JSON.stringify(sent.json));
    assert.equal((await verify(id, sent.json.data.entry.id)).status, 200);
  }
}
/** Every key in a JSON value, at any depth. */
function keys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keys(v, out); }
  return out;
}
const MONEY = /amount|total|remaining|balance|percent|discount|installment|package_name|other_fees|paid_cents/i;
/**
 * Keys that contain one of the words above but are not money: the applicant's pipeline progress
 * (milestones and stage position) and the record-folder step counter. Nothing else is allowed.
 */
const NOT_MONEY = new Set(['percent', 'milestone_percent', 'stage_percent', 'milestones_total', 'step_total']);
const moneyKeys = (value: unknown) => [...keys(value)].filter((k) => MONEY.test(k) && !NOT_MONEY.has(k));

test('a plan preset fills the list; custom items can be added; Sales cannot change the list', async () => {
  const id = await atPayment(null);
  assert.equal((await setRequired(id, { preset: 'full' })).status, 200);
  assert.deepEqual((await record(id)).required.map((r: any) => r.name), ['Full Payment']);
  assert.equal((await setRequired(id, { preset: 'downpayment_balance' })).status, 200, 'nothing locked yet: the plan is replaced');
  assert.deepEqual((await record(id)).required.map((r: any) => r.name), ['Downpayment', 'Balance']);
  assert.equal((await setRequired(id, { preset: 'reservation_full' })).status, 200);
  const view = await record(id);
  assert.deepEqual(view.required.map((r: any) => r.name), ['Reservation Fee', 'Full Payment']);
  assert.equal(view.preset, 'reservation_full');
  assert.deepEqual(view.preset_options.map((o: any) => o.value), ['full', 'reservation_full', 'downpayment_balance', 'custom']);

  // Custom: add "2nd Installment", reorder, and set the Package or basis note.
  const items = [...view.required.map((r: any) => ({ id: r.id, name: r.name })), { name: '2nd Installment' }].reverse();
  assert.equal((await setRequired(id, { preset: 'custom', items, basis_note: 'Package B, per signed LOI' })).status, 200);
  const custom = await record(id);
  assert.deepEqual(custom.required.map((r: any) => r.name), ['2nd Installment', 'Full Payment', 'Reservation Fee']);
  assert.equal(custom.basis_note, 'Package B, per signed LOI');
  assert.equal(custom.badge, 'unpaid');
  assert.match((await setRequired(id, { items: [{ name: '5000' }] })).json.errors['items.0.name'][0], /not an amount/);
  assert.match((await setRequired(id, { items: [{ name: 'A' }, { name: 'a' }] })).json.errors['items.1.name'][0], /listed twice/);

  // Sales sees the list read-only and cannot change it.
  assert.equal((await setRequired(id, { preset: 'full' }, sales)).status, 403);
  const salesView = await record(id, sales);
  assert.equal(salesView.can_edit_required, false);
  assert.equal(salesView.basis_note, 'Package B, per signed LOI', 'the note is shown to Sales as the amount reference');
  assert.equal((await call('GET', `/applicants/${id}/payment-record`, { token: marketing })).status, 403, 'other roles have no access');

  const [log] = (await events(id, 'payment_required_updated')).slice(-1);
  assert.deepEqual(log.new_values.items, ['2nd Installment', 'Full Payment', 'Reservation Fee']);
  assert.equal(log.new_values.basis_note, 'Package B, per signed LOI');
  assert.equal(log.actor_role, 'admin');
  assert.ok(log.old_values.items.length === 2);
  assert.ok((await q(`select 1 from audit_logs where action = 'payment.required_updated' and auditable_id = $1`, [id])).length, 'audited');
});

test('a required payment with an entry is locked: no rename, no removal, and switching plan keeps it', async () => {
  const id = await atPayment('reservation_full');
  const reservation = await itemId(id, 'Reservation Fee');
  const full = await itemId(id, 'Full Payment');
  assert.equal((await submit(id, entry(reservation))).status, 201);
  const view = await record(id);
  assert.equal(view.required.find((r: any) => r.id === reservation).lock_label, 'Has entry · locked');
  assert.equal(view.required.find((r: any) => r.id === full).locked, false);

  assert.match((await setRequired(id, { items: [{ id: full, name: 'Full Payment' }] })).json.errors.items[0], /can't be removed/);
  assert.match((await setRequired(id, { items: [{ id: reservation, name: 'Reservation' }, { id: full, name: 'Full Payment' }] })).json.errors.items[0], /can't be renamed/);
  assert.equal((await setRequired(id, { items: [{ id: reservation, name: 'Reservation Fee' }, { id: full, name: 'Balance Payment' }] })).status, 200, 'an item without an entry can be renamed');

  assert.equal((await setRequired(id, { preset: 'downpayment_balance' })).status, 200);
  assert.deepEqual((await record(id)).required.map((r: any) => r.name), ['Reservation Fee', 'Downpayment', 'Balance'], 'the locked item stays; the rest is the new plan');
  assert.ok((await q(`select removed_at from applicant_required_payments where id = $1`, [full]))[0].removed_at, 'removed items are soft-deleted, not erased');
});

test('each entry needs a date (not future), method, OR/AR, reference (non-cash) and a real receipt; only the assigned Sales user records', async () => {
  const id = await atPayment('full');
  const full = await itemId(id, 'Full Payment');
  assert.ok((await submit(id, entry(full, { payment_method: 'credit_card' }))).json.errors.payment_method);
  assert.ok((await submit(id, entry(full, { or_number: '' }))).json.errors.or_number);
  assert.match((await submit(id, entry(full, { reference_number: null }))).json.errors.reference_number[0], /required for every payment that is not cash/);
  assert.match((await submit(id, entry(full, { receipt: null }))).json.errors.receipt[0], /Attach the receipt/);
  const wrongType = entry(full);
  wrongType.set('receipt', new File(['x'], 'receipt.docx'));
  assert.match((await submit(id, wrongType)).json.errors.receipt[0], /PDF, JPG or PNG/);
  const huge = entry(full);
  huge.set('receipt', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }));
  assert.match((await submit(id, huge)).json.errors.receipt[0], /may not be larger than 10 MB/);
  const renamed = entry(full);
  renamed.set('receipt', new File([new TextEncoder().encode('just some text')], 'receipt.pdf', { type: 'application/pdf' }));
  assert.match((await submit(id, renamed)).json.errors.receipt[0], /not a real PDF, JPG or PNG/);
  const mismatch = entry(full);
  mismatch.set('receipt', new File([PNG], 'receipt.jpg', { type: 'image/jpeg' }));
  assert.match((await submit(id, mismatch)).json.errors.receipt[0], /contents do not match/);
  assert.match((await submit(id, entry(full, { payment_date: '2999-01-01' }))).json.errors.payment_date[0], /future/);
  assert.ok((await submit(id, entry(0))).json.errors.required_payment_id);
  assert.equal((await submit(id, entry(full), admin)).status, 403, 'Admin does not record payments for Sales');
  assert.equal((await submit(id, entry(full), otherSales)).status, 403, 'only the assigned Sales user');

  const amountIgnored = entry(full, { payment_method: 'cash', reference_number: null, amount: '50000' });
  const pdf = new File([PDF], 'receipt.pdf', { type: 'application/pdf' });
  amountIgnored.set('receipt', pdf);
  const sent = await submit(id, amountIgnored);
  assert.equal(sent.status, 201, 'cash needs no reference number; a PDF receipt works');
  const [row] = await q(`select amount, required_payment_id, status from payments where id = $1`, [sent.json.data.entry.id]);
  assert.equal(row.amount, null, 'no amount is stored, even if one is sent');
  assert.equal(Number(row.required_payment_id), full);
  assert.equal(row.status, 'pending');
  assert.match((await submit(id, entry(full))).json.errors.required_payment_id[0], /already waiting for Admin/, 'one active entry per required payment');
  const notified = await q(`select 1 from system_notifications where user_id = $1 and type = 'payment_entry_submitted' and (data->>'applicant_id')::bigint = $2`, [adminUser.id, id]);
  assert.ok(notified.length, 'Admin is notified when Sales submits');
});

test('Admin-only verify/reject, reject needs a reason, and nobody verifies or rejects an entry they encoded', async () => {
  const id = await atPayment('full');
  const full = await itemId(id, 'Full Payment');
  const sent = (await submit(id, entry(full))).json.data.entry.id;
  assert.equal((await verify(id, sent, sales)).status, 403);
  assert.equal((await reject(id, sent, 'Receipt unreadable.', sales)).status, 403);
  assert.ok((await reject(id, sent, 'no')).json.errors.reason, 'a reason of at least 5 characters');

  // Self-verification is refused server-side, whoever the encoder is.
  const [own] = await q(
    `insert into payments (applicant_id, required_payment_id, payment_type, payment_date, payment_method, or_number, status, recorded_by_user_id)
     values ($1, null, 'payment_record', '2026-11-01', 'cash', 'OR-SELF-1', 'pending', $2) returning id`, [id, adminUser.id],
  );
  assert.match((await verify(id, own.id)).json.message, /encoded yourself/);
  assert.equal((await verify(id, own.id)).status, 403);
  assert.equal((await reject(id, own.id, 'Trying my own entry.')).status, 403);
  await q(`delete from payments where id = $1`, [own.id]);

  const done = await verify(id, sent);
  assert.equal(done.status, 200);
  const item = done.json.data.required[0];
  assert.equal(item.status, 'verified');
  assert.equal(item.lock_label, 'Verified · locked');
  assert.ok(item.entry.verified_by);
  assert.ok(item.entry.verified_at && item.entry.recorded_at && item.entry.recorded_by);
  const [alert] = await q(`select message from system_notifications where user_id = $1 and type = 'payment_entry_verified' and (data->>'applicant_id')::bigint = $2`, [salesUser.id, id]);
  assert.match(alert.message, /verified the Full Payment/, 'the encoder is told');
});

test('a verified entry is locked for Sales', async () => {
  const id = await atPayment('full');
  const full = await itemId(id, 'Full Payment');
  const sent = (await submit(id, entry(full))).json.data.entry.id;
  await verify(id, sent);
  const view = await record(id, sales);
  assert.equal(view.required[0].can_record, false);
  assert.equal(view.required[0].entry.editable, false);
  assert.match((await submit(id, entry(full))).json.errors.required_payment_id[0], /Verified and locked/);
  const edit = await call('PUT', `/applicants/${id}/payment-entries/${sent}`, { token: sales, form: entry(full) });
  assert.match(edit.json.errors.payment[0], /Verified and locked/);
  assert.equal((await reject(id, sent, 'Changed my mind.')).status, 422, 'a verified entry cannot be rejected later');
});

test('rejected → Sales sees the reason, corrects and resubmits; the rejected entry stays as history; its numbers can be reused', async () => {
  const id = await atPayment('full');
  const full = await itemId(id, 'Full Payment');
  const first = (await submit(id, entry(full, { or_number: 'OR-REUSE-1', reference_number: 'REF-REUSE-1' }))).json.data.entry.id;
  const rejected = await reject(id, first, 'Receipt photo is unreadable.');
  assert.equal(rejected.status, 200);
  const salesView = await record(id, sales);
  assert.equal(salesView.required[0].status, 'rejected');
  assert.equal(salesView.required[0].entry.rejected_reason, 'Receipt photo is unreadable.');
  assert.equal(salesView.required[0].can_record, true);
  const [alert] = await q(`select message, data from system_notifications where user_id = $1 and type = 'payment_entry_rejected' and (data->>'applicant_id')::bigint = $2`, [salesUser.id, id]);
  assert.match(alert.message, /Receipt photo is unreadable/);
  assert.equal(alert.data.reason, 'Receipt photo is unreadable.');
  assert.equal((await verify(id, first)).status, 422, 'a rejected entry stays rejected');

  // The same OR/AR and reference number are accepted again after the rejection.
  const again = await submit(id, entry(full, { or_number: 'OR-REUSE-1', reference_number: 'REF-REUSE-1' }));
  assert.equal(again.status, 201, JSON.stringify(again.json));
  const view = await record(id);
  assert.equal(view.required[0].status, 'for_verification');
  assert.equal(view.required[0].history.length, 1, 'the rejected submission is kept');
  assert.equal(view.required[0].history[0].status, 'rejected');
  assert.equal((await q(`select status from payments where id = $1`, [first]))[0].status, 'returned', 'not overwritten');
  assert.equal((await events(id, 'payment_entry_resubmitted')).length, 1);
  // A live entry still blocks the same numbers elsewhere.
  const other = await atPayment('full');
  assert.match((await submit(other, entry(await itemId(other, 'Full Payment'), { or_number: 'or-reuse-1 ' }))).json.errors.or_number[0], /already recorded/);
  assert.match((await submit(other, entry(await itemId(other, 'Full Payment'), { reference_number: 'ref-reuse-1' }))).json.errors.reference_number[0], /already recorded/);
});

test('the same OR/AR or reference number is refused — by the database too, even at the same moment', async () => {
  const a = await atPayment('full');
  const b = await atPayment('full');
  const twice = await Promise.all([
    submit(a, entry(await itemId(a, 'Full Payment'), { or_number: 'OR-DUP-1', reference_number: 'REF-A1' })),
    submit(b, entry(await itemId(b, 'Full Payment'), { or_number: ' or-dup-1 ', reference_number: 'REF-B1' })),
  ]);
  assert.deepEqual(twice.map((r) => r.status).sort(), [201, 422], 'only one of the two is accepted');
  assert.equal(twice.find((r) => r.status === 422)!.json.errors.or_number[0], 'This OR/AR number is already recorded.');
  await assert.rejects(() => q(`insert into payments (applicant_id, payment_type, payment_date, status, recorded_by_user_id, or_number) values ($1, 'payment_record', '2026-11-01', 'pending', $2, 'OR-DUP-1 ')`, [b, salesUser.id]), /payments_or_number_unique/);
});

test('verify/reject refuse an entry that Sales changed after Admin loaded it', async () => {
  const id = await atPayment('full');
  const full = await itemId(id, 'Full Payment');
  const sent = (await submit(id, entry(full))).json.data.entry.id;
  const loaded = (await entryOf(id, 'Full Payment')).revision;
  assert.equal(loaded, 1);

  // Sales edits the entry (still For verification) after Admin opened it.
  const edit = await call('PUT', `/applicants/${id}/payment-entries/${sent}`, { token: sales, form: entry(full, { or_number: 'OR-EDITED-1', receipt: null }) });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(edit.json.data.required[0].entry.or_number, 'OR-EDITED-1');
  assert.equal(edit.json.data.required[0].entry.revision, 2);
  assert.equal((await call('PUT', `/applicants/${id}/payment-entries/${sent}`, { token: otherSales, form: entry(full) })).status, 403);

  const stale = await verify(id, sent, admin, loaded);
  assert.equal(stale.status, 422);
  assert.match(stale.json.errors.revision[0], /changed this entry after you opened it/);
  assert.match((await reject(id, sent, 'Receipt unreadable.', admin, loaded)).json.errors.revision[0], /changed this entry/);
  assert.match((await call('POST', `/applicants/${id}/payment-entries/${sent}/verify`, { token: admin, body: {} })).json.errors.revision[0], /Reload/);
  assert.equal((await q(`select status from payments where id = $1`, [sent]))[0].status, 'pending', 'nothing changed');
  assert.equal((await verify(id, sent, admin, 2)).status, 200, 'after reloading, the current version can be verified');
  const [log] = await events(id, 'payment_entry_edited');
  assert.equal(log.old_values.revision, 1);
  assert.equal(log.new_values.or_number, 'OR-EDITED-1');
});

test('gate: For Approval is blocked in the API until every required payment is Verified', async () => {
  const none = await atPayment(null);
  assert.match((await move(none)).json.errors.payments[0], /set the required payments first/);
  assert.equal((await call('PATCH', `/applicants/${none}/status`, { token: admin, body: { status: 'for_approval', remarks: 'Skip it please.' } })).status, 422, 'no direct stage change');

  const id = await atPayment('reservation_full');
  assert.equal((await record(id)).can_move, false);
  const reservation = (await submit(id, entry(await itemId(id, 'Reservation Fee')))).json.data.entry.id;
  assert.equal((await record(id)).badge, 'for_verification');
  await verify(id, reservation);
  const half = await record(id, sales);
  assert.equal(half.verified_count, 1);
  assert.equal(half.required_count, 2);
  assert.equal(half.badge, 'unpaid');
  assert.equal(half.can_move, false, 'Sales never has the Move button');
  const blocked = await move(id);
  assert.equal(blocked.status, 422);
  assert.match(blocked.json.errors.payments[0], /1 of 2 required payments verified\. Not yet verified: Full Payment/);
  assert.equal((await call('POST', `/applicants/${id}/payments/complete`, { token: sales, body: {} })).status, 403);

  const full = (await submit(id, entry(await itemId(id, 'Full Payment')))).json.data.entry.id;
  assert.match((await move(id)).json.errors.payments[0], /Not yet verified: Full Payment/, 'For verification is not Verified');
  await verify(id, full);
  const ready = await record(id);
  assert.equal(ready.badge, 'completed');
  assert.equal(ready.all_verified, true);
  assert.equal(ready.can_move, true);
  const moved = await move(id);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.data.status, 'for_approval');
  const [stage] = await q(`select * from applicant_stage_histories where applicant_id = $1 and to_stage = 'for_approval' and from_stage = 'payment_submitted'`, [id]);
  assert.equal(Number(stage.changed_by_user_id), adminUser.id);
  assert.equal((await setRequired(id, { preset: 'full' })).status, 422, 'the list is locked once past the stage');
});

test('approval and activation use the same gate; applicants confirmed under the old flow are not blocked', async () => {
  const milestones = '{"qualification_profile_reviewed": true, "qualification_financial_capability_assessed": true, "qualification_initial_interview_completed": true, "qualification_preferred_location_evaluated": true, "qualification_investment_understood": true, "orientation_attended": true, "product_tasting_attended": true, "training_completed": true}';
  const ready = async (id: number) => {
    await q(`update applicants set status = 'for_approval', reviewed_at = now(), milestones = $2 where id = $1`, [id, milestones]);
    await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, uploaded_by_user_id) values ('App\\Models\\Applicant', $1, 'loi', 'loi.pdf', 'x.pdf', 'private', 'x', $2)`, [id, salesUser.id]);
  };
  // A new-flow applicant pushed to For Approval with an unverified required payment cannot be approved.
  const id = await atPayment('full');
  await ready(id);
  const refused = await call('POST', `/applicants/${id}/approve`, { token: admin, body: {} });
  assert.equal(refused.status, 422);
  assert.match(refused.json.errors.status[0], /0 of 1 required payments verified/);

  // An older applicant already confirmed (no required payments) is not blocked by the new gate.
  n += 1;
  const [legacy] = await q(
    `insert into applicants (full_name, status, application_date, assigned_sales_user_id, payment_stage_state, payment_confirmed_at, loi_status, loi_verification_status, total_required_amount)
     values ($1, 'for_approval', '2026-01-01', $2, 'confirmed', now(), 'complete', 'verified', 10000) returning id`, [`Legacy Confirmed ${n}`, salesUser.id],
  );
  await ready(legacy.id);
  const approved = await call('POST', `/applicants/${legacy.id}/approve`, { token: admin, body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
});

test('older applicants at Payment Record: earlier entries are read-only and show no amounts; Admin picks a plan', async () => {
  n += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, application_date, assigned_sales_user_id, payment_stage_state, loi_status, loi_verification_status, total_required_amount, package_name)
     values ($1, 'payment_submitted', '2026-01-01', $2, 'collecting', 'complete', 'verified', 10000, 'Kiosk') returning id`, [`Legacy Pay ${n}`, salesUser.id],
  );
  await q(`insert into payments (applicant_id, payment_type, amount, payment_date, payment_method, or_number, status, recorded_by_user_id) values ($1, 'payment_record', 4000, '2026-01-05', 'cash', 'OR-OLD-1', 'verified', $2)`, [a.id, salesUser.id]);
  const view = await record(a.id);
  assert.equal(view.required_count, 0);
  assert.equal(view.earlier_entries.length, 1);
  assert.equal(view.earlier_entries[0].or_number, 'OR-OLD-1');
  assert.equal(view.earlier_entries[0].legacy_no_receipt, true);
  assert.equal(view.earlier_entries[0].reviewable, false);
  assert.ok(!('amount' in view.earlier_entries[0]));
  assert.match((await move(a.id)).json.errors.payments[0], /set the required payments first/, 'old entries do not count');
  assert.equal((await setRequired(a.id, { preset: 'full' })).status, 200);
  await payAll(a.id);
  assert.equal((await move(a.id)).status, 200);
});

test('the billing endpoints always refuse (advanced features permanently off)', async () => {
  const id = await atPayment('full');
  const refused = [
    ['PATCH', `/applicants/${id}/payment-plan`, { agreed_amount: 50000 }, admin],
    ['PATCH', `/applicants/${id}/payment-schedule`, { frequency: 'monthly', first_due_date: '2026-12-01' }, admin],
    ['POST', `/applicants/${id}/payments`, { amount: 100, payment_date: '2026-11-01' }, sales],
    ['POST', `/applicants/${id}/payments/report`, { entries: [{ amount: 100, payment_date: '2026-11-01' }] }, sales],
    ['POST', `/applicants/${id}/payments/apply-report`, {}, admin],
    ['POST', `/applicants/${id}/payments/return`, { note: 'Return this please.' }, admin],
    ['PATCH', `/applicants/${id}/payments/1/verify`, { status: 'verified' }, admin],
    ['PUT', `/applicants/${id}/payments/1`, { amount: 1 }, sales],
    ['PATCH', `/applicants/${id}/payments/1`, { amount: 1 }, sales],
    ['DELETE', `/applicants/${id}/payments/1`, null, sales],
  ] as const;
  for (const [method, path, body, token] of refused) {
    const res = await call(method, path, { token, ...(body ? { body } : {}) });
    assert.equal(res.status, 422, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/auth/me', { token: admin })).json.data.features.payment_advanced, false);
});

test('API responses carry no amount, total, balance or percentage', async () => {
  const id = await atPayment('reservation_full');
  await q(`update applicants set total_required_amount = 50000, package_name = 'Kiosk', initial_payment_amount = 1000 where id = $1`, [id]);
  await q(`update applicant_payment_plans set total_required_amount = 50000 where applicant_id = $1`, [id]);
  const sent = (await submit(id, entry(await itemId(id, 'Reservation Fee')))).json;
  assert.ok(sent.data.entry);
  assert.deepEqual(moneyKeys(sent), [], 'submit response');
  await verify(id, sent.data.entry.id);
  const responses = {
    detail: await call('GET', `/applicants/${id}`, { token: admin }),
    detailSales: await call('GET', `/applicants/${id}`, { token: sales }),
    record: await call('GET', `/applicants/${id}/payment-record`, { token: admin }),
    report: await call('GET', `/applicants/${id}/report`, { token: admin }),
    history: await call('GET', `/applicants/${id}/history`, { token: admin }),
    list: await call('GET', `/applicants?per_page=100`, { token: admin }),
    folders: await call('GET', `/applicants/application-detail?folder=active&per_page=100`, { token: admin }),
  };
  for (const [name, res] of Object.entries(responses)) {
    assert.equal(res.status, 200, name);
    assert.deepEqual(moneyKeys(res.json.data), [], name);
  }
  const row = responses.folders.json.data.find((r: any) => r.id === id);
  assert.equal(row.payments_verified, 1);
  assert.equal(row.payments_required, 2);
  assert.equal(responses.report.json.data.payment.progress.verified_count, 1);
  assert.ok(responses.record.json.data.history.length >= 3);
});

test('required payments have no due date, and the Package or basis note stays on the Payment Record card', async () => {
  const note = 'Package Z-NOTE-4471, per signed LOI';
  const id = await atPayment(null);
  assert.equal((await setRequired(id, { preset: 'full', basis_note: note })).status, 200);
  const columns = await q(`select column_name from information_schema.columns where table_name = 'applicant_required_payments'`);
  assert.ok(!columns.some((c) => /due|date|amount/.test(c.column_name) && c.column_name !== 'created_at' && c.column_name !== 'updated_at'), 'no due date or amount column');
  const view = await record(id);
  assert.ok(!keys(view.required).has('due_date'));
  assert.equal(view.basis_note, note, 'shown on the card (Admin and Sales)');
  assert.equal((await record(id, sales)).basis_note, note);
  await payAll(id);
  const leaks = {
    list: await call('GET', `/applicants?per_page=100`, { token: admin }),
    folders: await call('GET', `/applicants/application-detail?folder=active&per_page=100`, { token: admin }),
    report: await call('GET', `/applicants/${id}/report`, { token: admin }),
    history: await call('GET', `/applicants/${id}/history`, { token: admin }),
    dashboard: await call('GET', '/analytics/franchising-dashboard', { token: admin }),
  };
  for (const [name, res] of Object.entries(leaks)) {
    assert.equal(res.status, 200, name);
    assert.ok(!JSON.stringify(res.json).includes('Z-NOTE-4471'), `${name} must not contain the note`);
  }
  const notes = await q(`select title, message, data from system_notifications where (data->>'applicant_id')::bigint = $1`, [id]);
  assert.ok(notes.length > 0);
  assert.ok(!JSON.stringify(notes).includes('Z-NOTE-4471'), 'notifications must not contain the note');
  const [log] = (await events(id, 'payment_required_updated')).slice(-1);
  assert.equal(log.new_values.basis_note_changed, true, 'the change itself is still audited');
});

test('receipts and the LOI link are private to Admin and the assigned Sales user', async () => {
  const id = await atPayment('full');
  const sent = await submit(id, entry(await itemId(id, 'Full Payment')));
  const doc = sent.json.data.entry.receipt.id;
  const url = `/applicants/${id}/payments/${sent.json.data.entry.id}/documents/${doc}/download`;
  assert.equal((await call('GET', url, { token: admin })).status, 200);
  assert.equal((await call('GET', url, { token: sales })).status, 200);
  assert.equal((await call('GET', url, { token: otherSales })).status, 403);
  assert.equal((await call('GET', url, { token: marketing })).status, 403);
  assert.equal((await record(id, otherSales)).required[0].entry.receipts, null);

  const [loi] = await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, uploaded_by_user_id) values ('App\\Models\\Applicant', $1, 'loi', 'signed-loi.pdf', 'x.pdf', 'private', 'x', $2) returning id`, [id, salesUser.id]);
  assert.equal((await record(id, sales)).loi_document.id, loi.id, 'Sales can open the LOI to check the amount to collect');
  assert.equal((await record(id, otherSales)).loi_document, null);
});

test('every action leaves an append-only history record', async () => {
  const id = await atPayment('full');
  const full = await itemId(id, 'Full Payment');
  const first = (await submit(id, entry(full, { or_number: 'OR-HIST-1' }))).json.data.entry.id;
  await reject(id, first, 'Wrong account on the slip.');
  const fixed = (await submit(id, entry(full, { or_number: 'OR-HIST-1' }))).json.data.entry.id;
  await verify(id, fixed);
  await move(id);
  const [submitted] = await events(id, 'payment_entry_submitted');
  assert.equal(submitted.actor_role, 'sales');
  assert.equal(submitted.step, 'payment_record');
  assert.equal(submitted.new_values.or_number, 'OR-HIST-1');
  assert.equal(submitted.new_values.required_payment, 'Full Payment');
  assert.equal(submitted.attachments[0].type, 'payment_receipt');
  const [rejectedLog] = await events(id, 'payment_entry_rejected');
  assert.equal(rejectedLog.remarks, 'Wrong account on the slip.');
  assert.deepEqual([rejectedLog.old_values.status, rejectedLog.new_values.status], ['for_verification', 'rejected']);
  const [verifiedLog] = await events(id, 'payment_entry_verified');
  assert.equal(verifiedLog.new_values.verified_count, 1);
  await assert.rejects(() => q(`update applicant_stage_histories set remarks = 'x' where id = $1`, [rejectedLog.id]), /append-only/);

  // An older-flow event reads "Payment setup (old flow)", with no amount wording or values.
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, event, step, changed_at, new_values) values ($1, 'payment_submitted', 'payment_submitted', 'payment_agreed_amount_set', 'payment_record', now(), '{"agreed_amount": 50000, "package_name": "Kiosk"}')`, [id]);
  const old = (await record(id)).history.find((h: any) => h.event === 'payment_agreed_amount_set');
  assert.equal(old.action, 'Payment setup (old flow)');
  assert.deepEqual(old.new_values, {}, 'old amount values are not shown');
  const fromReport = (await call('GET', `/applicants/${id}/history`, { token: admin })).json.data.find((h: any) => h.event === 'payment_agreed_amount_set');
  assert.equal(fromReport.action, 'Payment setup (old flow)');
});
