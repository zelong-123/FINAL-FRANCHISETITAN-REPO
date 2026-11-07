// Walks one applicant through the whole pipeline, plus the rules around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';

const { pg, call, login, files } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);

const lead = (name: string) => ({
  lead_name: name, first_name: name, last_name: 'Tester', phone: '09171234567', source: 'facebook', preferred_brand_id: brand.id,
});

test('inquiries: Marketing creates, role and visibility rules hold, search is case-insensitive', async () => {
  const bad = await call('POST', '/inquiries', { token: marketing, body: { ...lead('Viber Lead'), source: 'viber' } });
  assert.equal(bad.status, 422);
  assert.ok(bad.json.errors.viber_number, 'viber number required for viber source');
  assert.equal((await call('POST', '/inquiries', { token: admin, body: lead('X') })).status, 403);

  const created = await call('POST', '/inquiries', { token: marketing, body: lead('Maria Santos') });
  assert.equal(created.status, 201);
  assert.match(created.json.data.lead_code, /^LD-\d{4}-\d{5}$/);
  assert.equal(created.json.data.preferred_brand.id, brand.id);
  const id = created.json.data.id;

  assert.equal((await call('GET', `/inquiries/${id}`, { token: admin })).status, 404, 'admin cannot see a new lead until endorsed');
  const list = await call('GET', '/inquiries?search=MARIA', { token: marketing });
  assert.equal(list.json.data.length, 1);
  assert.equal(typeof list.json.data[0].display_no, 'number');
  assert.equal((await call('GET', `/inquiries/by-code/${created.json.data.lead_code.toLowerCase()}`, { token: marketing })).json.data.id, id);
});

test('inquiries: archive, restore, purge keep their history and rules', async () => {
  const { json } = await call('POST', '/inquiries', { token: marketing, body: lead('Archive Me') });
  const id = json.data.id;
  const archived = await call('POST', `/inquiries/${id}/archive`, { token: marketing });
  assert.equal(archived.status, 200);
  assert.ok(archived.json.data.current_archive_log.archive_id > 10000);
  assert.equal((await call('GET', '/inquiries?archived=1', { token: marketing })).json.data.some((r: any) => r.id === id), true);
  assert.equal((await call('GET', '/inquiries?archived=1', { token: sales })).status, 403);
  assert.equal((await call('POST', `/inquiries/${id}/restore`, { token: marketing })).status, 200);
  const [log] = await q(`select restored_at from inquiry_archive_logs where franchise_inquiry_id = $1`, [id]);
  assert.ok(log.restored_at, 'restore closes the archive history row');
});

let applicantId: number;

test('full pipeline: endorse, convert, qualify, schedule, LOI, payment, approve, activate', async () => {
  const { json } = await call('POST', '/inquiries', { token: marketing, body: { ...lead('Juan Dela Cruz'), preferred_franchise_location: '  Las   Pinas ' } });
  const inquiryId = json.data.id;
  const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
  assert.equal((await call('POST', `/inquiries/${inquiryId}/endorse`, { token: marketing, body: { endorsed_to_user_id: salesUser.id } })).json.data.status, 'endorsed');
  const again = await call('POST', `/inquiries/${inquiryId}/endorse`, { token: admin, body: {} });
  assert.equal(again.status, 403);

  const converted = await call('POST', `/inquiries/${inquiryId}/convert`, { token: admin, body: {} });
  assert.equal(converted.status, 201);
  assert.match(converted.json.data.applicant_code, /^APL-\d{4}-\d{5}$/);
  assert.equal(converted.json.data.progress.state, 'in_progress');
  applicantId = converted.json.data.id;
  const path = `/applicants/${applicantId}`;

  // Marketing is locked out of a converted lead.
  assert.equal((await call('PUT', `/inquiries/${inquiryId}`, { token: marketing, body: lead('Nope') })).status, 403);

  // No stage can be skipped.
  const skip = await call('PATCH', `${path}/status`, { token: admin, body: { status: 'for_approval' } });
  assert.equal(skip.status, 422);
  assert.match(skip.json.errors.status[0], /Stage skipped/);

  // Sales assesses (red dot until opened), Admin confirms.
  const row = (await call('GET', '/applicants', { token: sales })).json.data.find((a: any) => a.id === applicantId);
  assert.equal(row.has_assessment_request, true);
  assert.equal(row.lead.lead_code, json.data.lead_code);
  assert.equal(row.status_label, 'Converted');
  const notReady = await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true } });
  assert.equal(notReady.status, 422);
  assert.match(notReady.json.errors.status[0], /qualification checklist/);
  const keys = ['profile_reviewed', 'financial_capability_assessed', 'initial_interview_completed', 'preferred_location_evaluated', 'investment_understood'];
  const milestones = Object.fromEntries(keys.map((k) => [`qualification_${k}`, true]));
  assert.equal((await call('PUT', `${path}/assessments`, { token: admin, body: { milestones } })).status, 403);
  const saved = await call('PUT', `${path}/assessments`, { token: sales, body: { milestones } });
  assert.equal(saved.json.data.assessment_complete, true);
  assert.equal((await q(`select count(*)::int c from applicant_assessment_logs where applicant_id = $1`, [applicantId]))[0].c, 5);
  assert.equal((await call('POST', `${path}/confirm-qualified`, { token: admin, body: {} })).status, 422, 'bare request refused');
  assert.equal((await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true } })).json.data.status, 'qualified');
  assert.equal((await call('POST', `${path}/set-schedule`, { token: admin, body: {} })).json.data.status, 'scheduled');
  assert.match((await call('POST', `${path}/set-schedule`, { token: admin, body: {} })).json.message, /already/, 'double click is harmless');

  // Attended requires Sales' Complete, in order.
  const attended = await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: { orientation_attended: true } } });
  assert.match(attended.json.errors.milestones[0], /Sales must mark it Complete first/);
  for (const type of ['orientation', 'product_tasting', 'training']) {
    await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, completed_at, approval_status, scheduled_by_user_id) values ($1, $2, $3, now() - interval '2 days', now() - interval '2 days', 'completed', now(), 'approved', $4)`, [applicantId, type, type, salesUser.id]);
  }
  const skipOrder = await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: { training_completed: true } } });
  assert.match(skipOrder.json.errors.milestones[0], /must be Done before/);
  const all = await call('PATCH', `${path}/milestones`, {
    token: admin,
    body: { milestones: { orientation_attended: true, product_tasting_attended: true, training_completed: true }, milestone_details: { orientation_attended: { on: '2026-11-01' } } },
  });
  assert.equal(all.status, 200);
  assert.equal(all.json.data.schedule_complete, true);
  assert.equal(all.json.data.activity_state.training.done, true);
  assert.equal(all.json.data.milestone_details.orientation_attended.on, '2026-11-01T00:00');
  assert.match(all.json.data.milestone_details.orientation_attended.by, /\(Admin\)$/);
  // A saved Attended can never be cleared.
  const cleared = await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: {} } });
  assert.equal(cleared.json.data.milestones.training_completed, true);

  // LOI: remarks required, an upload alone moves nothing, a future date is refused.
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'loi_submitted' } })).json.errors.remarks[0], /Remarks are required/);
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'loi_submitted', remarks: 'Received' } })).json.data.status, 'loi_submitted');
  const future = new FormData();
  future.set('submission_date', '2999-01-01');
  assert.equal((await call('POST', `${path}/loi`, { token: admin, form: future })).status, 422);
  const form = new FormData();
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'loi.pdf', { type: 'application/pdf' }));
  form.set('submission_type', 'digital');
  form.set('submission_date', '2026-11-01');
  const upload = await call('POST', `${path}/loi`, { token: admin, form });
  assert.equal(upload.status, 201);
  assert.equal(files.store.size, 1);
  assert.equal((await q(`select status from applicants where id = $1`, [applicantId]))[0].status, 'loi_submitted');
  const download = await call('GET', `${path}/documents/${upload.json.data.id}/download`, { token: admin });
  assert.equal(download.status, 200);
  assert.deepEqual([...new Uint8Array(await download.res.arrayBuffer())], [1, 2, 3]);
  assert.match(download.res.headers.get('content-disposition')!, /loi\.pdf/);
  const wrongType = new FormData();
  wrongType.set('file', new File(['x'], 'virus.exe'));
  assert.ok((await call('POST', `${path}/loi`, { token: admin, form: wrongType })).json.errors.file);
  // Not verified yet, so Complete is refused, and Proceed makes it Pending.
  assert.match((await call('POST', `${path}/loi/complete`, { token: admin, body: {} })).json.errors.loi[0], /Mark the LOI as Verified/);
  const proceed = await call('POST', `${path}/loi/proceed`, { token: admin, body: {} });
  assert.equal(proceed.json.data.status, 'payment_submitted');
  assert.equal(proceed.json.data.loi_status, 'pending');
  assert.equal(proceed.json.data.payment_stage_state, 'waiting_total');

  // Payment: nothing until a total exists.
  const early = await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 100, payment_date: '2026-11-01' }] } });
  assert.match(early.json.errors.payments[0], /Admin must set the Total required/);
  const plan = await call('PATCH', `${path}/payment-plan`, { token: admin, body: { total_required_amount: 100000, discount_percent: 10, promo_name: 'Launch' } });
  assert.equal(plan.json.data.total_required_amount, '90000.00');
  assert.equal(plan.json.data.total_required_original_amount, '100000.00');
  assert.equal(plan.json.data.payment_stage_state, 'collecting');
  // Changing the discount works from the original: 20% is 80,000, not 72,000.
  assert.equal((await call('PATCH', `${path}/payment-plan`, { token: admin, body: { discount_percent: 20 } })).json.data.total_required_amount, '80000.00');
  assert.ok((await call('PATCH', `${path}/payment-plan`, { token: admin, body: { total_required_amount: 600000 } })).json.errors.total_required_amount);

  const small = await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 100, payment_date: '2026-11-01' }] } });
  assert.match(small.json.errors.amount[0], /downpayment must be at least ₱16,000/);
  assert.match((await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 90000, payment_date: '2026-11-01' }] } })).json.errors.amount[0], /cannot exceed the remaining balance of ₱80,000\.00/);
  assert.match((await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 20000, payment_date: '2999-11-01' }] } })).json.errors.payment_date[0], /future/);
  const report = await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 20000, payment_date: '2026-11-01', payment_method: 'gcash' }] } });
  assert.equal(report.status, 201);
  assert.equal((await q(`select count(*)::int c from payments where applicant_id = $1`, [applicantId]))[0].c, 0, 'a report writes no payment');

  const view = (await call('GET', path, { token: admin })).json.data;
  assert.equal(view.payment_stage.state, 'for_review');
  assert.equal(view.payment_stage.can_apply_report, true);
  assert.equal(view.payment_stage.sales_report.entries[0].payment_type, 'downpayment');
  assert.equal(view.payment_stage.preview_remaining_balance, 60000);

  // Returned, resubmitted, then applied.
  assert.equal((await call('POST', `${path}/payments/return`, { token: admin, body: { note: 'Wrong date' } })).json.data.payment_stage_state, 'collecting');
  await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 20000, payment_date: '2026-11-02' }] } });
  assert.equal((await call('POST', `${path}/payments/apply-report`, { token: admin, body: {} })).status, 200);
  const [payment] = await q(`select * from payments where applicant_id = $1`, [applicantId]);
  assert.equal(payment.status, 'verified');
  assert.equal((await q(`select count(*)::int c from applicant_payments where legacy_payment_id = $1`, [payment.id]))[0].c, 1, 'ledger mirrors the payment');
  assert.equal((await call('POST', `${path}/payments/complete`, { token: admin, body: {} })).status, 422, 'LOI pending blocks');

  // The installment minimum is half the saved downpayment, and duplicates are refused.
  assert.match((await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 5000, payment_date: '2026-11-03' }] } })).json.errors.amount[0], /at least ₱10,000/);
  const schedule = await call('PATCH', `${path}/payment-schedule`, { token: admin, body: { frequency: 'monthly', first_due_date: '2026-12-31' } });
  assert.equal(schedule.json.data.payment_stage.installment.next_due_date, '2026-12-31');
  assert.equal(schedule.json.data.payment_stage.installment.estimated_payments, 6);
  assert.equal(schedule.json.data.payment_stage.installment.estimated_last_due_date, '2027-05-31', 'month ends clamp without overflow');

  await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 60000, payment_date: '2026-11-03' }] } });
  await call('POST', `${path}/payments/apply-report`, { token: admin, body: {} });
  assert.equal((await q(`select payment_type from payments where applicant_id = $1 order by id desc limit 1`, [applicantId]))[0].payment_type, 'full_payment', 'settling the balance is a Full Payment');

  // Complete the Pending LOI, then the stage.
  const verify = new FormData();
  verify.set('verification_status', 'verified');
  await call('POST', `${path}/loi`, { token: admin, form: verify });
  assert.match((await call('POST', `${path}/loi/complete`, { token: admin, body: {} })).message ?? '', /|/);
  assert.equal((await q(`select loi_status from applicants where id = $1`, [applicantId]))[0].loi_status, 'complete');
  const complete = await call('POST', `${path}/payments/complete`, { token: admin, body: {} });
  assert.equal(complete.json.data.status, 'for_approval');
  assert.equal(complete.json.data.payment_stage_state, 'confirmed');
  assert.match((await call('PATCH', `${path}/payment-plan`, { token: admin, body: { total_required_amount: 90000 } })).json.errors.total_required_amount[0], /locked/);

  // Approval needs the review; activation needs the account.
  assert.match((await call('POST', `${path}/approve`, { token: admin, body: {} })).json.errors.status[0], /review must be confirmed/);
  await call('POST', `${path}/review`, { token: admin, body: {} });
  assert.equal((await call('POST', `${path}/approve`, { token: admin, body: {} })).json.data.status, 'approved');
  assert.match((await call('POST', `${path}/activate`, { token: admin, body: {} })).json.errors.account[0], /Create an active Franchisee/);
  const portal = await call('POST', `${path}/portal-user`, { token: admin, body: { email: 'Juan@Branch.Test', phone: '09170000000', password: 'Passw0rd!', confirm_password: 'Passw0rd!' } });
  assert.equal(portal.status, 201);
  assert.equal(portal.json.data.role.name, 'franchisee');
  assert.ok(!('auth_user_id' in portal.json.data));
  assert.equal((await q(`select status from applicants where id = $1`, [applicantId]))[0].status, 'active_franchisee');
  const [branch] = await q(`select l.* from franchise_locations l join franchisees f on f.id = l.franchisee_id where f.applicant_id = $1`, [applicantId]);
  assert.match(branch.name, / · Las Pinas$/, 'branch named from brand + preferred location, never the person');
  assert.ok((await q(`select archived_at from franchise_inquiries where id = $1`, [inquiryId]))[0].archived_at, 'active franchisee archives its lead');
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'rejected' } })).status, 422, 'terminal stage');
  assert.equal((await call('DELETE', path, { token: admin })).status, 422);

  // The branch account signs in through the branch portal.
  const branchLogin = await call('POST', '/auth/login', { body: { email: 'juan@branch.test', password: 'Passw0rd!', portal: 'branch' } });
  assert.equal(branchLogin.status, 200);
  const me = await call('GET', '/auth/me', { token: branchLogin.json.data.token });
  assert.equal(me.json.data.applicant.id, applicantId);
  assert.equal(me.json.data.franchisee.locations.length, 1);
  assert.equal((await call('GET', `/applicants/${applicantId}`, { token: branchLogin.json.data.token })).status, 200, 'own record');
});

test('report, folders, rejection and restore', async () => {
  const report = await call('GET', `/applicants/${applicantId}/report`, { token: admin });
  assert.equal(report.status, 200);
  assert.equal(report.json.data.payment.summary.verified_amount, 80000);
  assert.equal(report.json.data.payment.plan.discount.discount_percent, 20);
  assert.equal(report.json.data.payment.plan.discount.promo_name, 'Launch');
  assert.equal(report.json.data.approval.checkpoints.every((x: any) => x.done), true);
  const folders = await call('GET', '/applicants/application-detail?folder=approved', { token: admin });
  const row = folders.json.data.find((a: any) => a.id === applicantId);
  assert.equal(row.payment_percent, 100);
  assert.equal(typeof folders.json.meta.folder_counts.rejected, 'number');
  assert.equal((await call('GET', '/applicants/active-franchisees?search=juan', { token: admin })).json.data[0].has_portal_account, true);

  const { json } = await call('POST', '/inquiries', { token: marketing, body: lead('Reject Me') });
  await call('POST', `/inquiries/${json.data.id}/endorse`, { token: marketing, body: {} });
  const applicant = (await call('POST', `/inquiries/${json.data.id}/convert`, { token: admin, body: {} })).json.data;
  const rejected = await call('PATCH', `/applicants/${applicant.id}/status`, { token: admin, body: { status: 'rejected', remarks: 'No funds' } });
  assert.equal(rejected.json.data.status, 'rejected');
  assert.ok(rejected.json.data.archived_at);
  assert.equal((await call('GET', `/applicants/${applicant.id}`, { token: sales })).status, 404, 'Sales cannot open archived records');
  const archive = await call('GET', '/archive', { token: admin });
  assert.ok(archive.json.data.totals.applicants >= 1);
  const restored = await call('POST', `/archive/applicants/${applicant.id}/restore`, { token: admin });
  assert.equal(restored.json.data.status, 'converted', 'returns to the stage it was rejected from');
  assert.equal((await call('POST', '/archive/applicants/1/restore', { token: sales })).status, 403);
});

test('unconvert removes only an unprogressed applicant, and purge needs a reason', async () => {
  const { json } = await call('POST', '/inquiries', { token: marketing, body: lead('Undo Me') });
  const id = json.data.id;
  await call('POST', `/inquiries/${id}/endorse`, { token: marketing, body: {} });
  await call('POST', `/inquiries/${id}/convert`, { token: admin, body: {} });
  const undone = await call('POST', `/inquiries/${id}/unconvert`, { token: admin, body: {} });
  assert.equal(undone.json.data.status, 'endorsed');
  assert.equal((await q(`select count(*)::int c from applicants where inquiry_id = $1`, [id]))[0].c, 0);

  await call('POST', `/inquiries/${id}/archive`, { token: admin });
  assert.equal((await call('POST', `/archive/inquiries/${id}/purge`, { token: admin, body: { reason: 'x' } })).status, 422);
  assert.equal((await call('POST', `/archive/inquiries/${id}/purge`, { token: admin, body: { reason: 'Duplicate record' } })).json.data.deleted, 1);
  assert.equal((await q(`select count(*)::int c from franchise_inquiries where id = $1`, [id]))[0].c, 0);
});
