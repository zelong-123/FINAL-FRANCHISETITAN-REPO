// Walks one applicant through the whole pipeline, plus the rules around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { completeStage, requirementForm } from '../support/requirements.ts';
import { createStaff, firstSignIn } from '../support/accounts.ts';

const { pg, call, login, files } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);

// Every test lead gets its own phone: the API now refuses an unexplained duplicate.
let phoneSeq = 0;
const nextPhone = () => `0918${String(1000000 + (phoneSeq += 1)).slice(1)}`;
const lead = (name: string, phone = nextPhone()) => ({
  lead_name: name, first_name: name, last_name: 'Tester', phone, source: 'facebook', preferred_brand_id: brand.id,
});
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

// A second Sales account: only the assigned Sales user may act for an applicant.
const otherSalesEmail = 'second.sales@example.test';
const otherSales = await createStaff(call, admin, { full_name: 'Second Sales', email: otherSalesEmail, phone: '09179990001', role: 'sales' });
const [otherSalesUser] = await q(`select id from users where email = $1`, [otherSalesEmail]);
const convert = (inquiryId: number, salesId = salesUser.id) => call('POST', `/inquiries/${inquiryId}/convert`, { token: admin, body: { assigned_sales_user_id: salesId } });

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

test('an endorsed inquiry shows an unread dot for the receiving admin until it is opened', async () => {
  const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
  const { json } = await call('POST', '/inquiries', { token: marketing, body: { ...lead('Macky Velasco') } });
  const inquiryId = json.data.id;
  await call('POST', `/inquiries/${inquiryId}/endorse`, { token: marketing, body: { endorsed_to_user_id: adminUser.id } });

  const list = async () => (await call('GET', '/inquiries', { token: admin })).json.data as any[];
  assert.equal((await list()).find((row) => row.id === inquiryId)?.has_unread, true, 'the endorsed lead shows a dot');

  await call('POST', '/notifications/mark-seen', { token: admin, body: { record_type: 'inquiry', record_id: inquiryId } });
  assert.equal((await list()).find((row) => row.id === inquiryId)?.has_unread, false, 'opening the lead clears the dot');
});

test('full pipeline: endorse, convert, qualify, schedule, LOI, payment, approve, activate', async () => {
  const { json } = await call('POST', '/inquiries', { token: marketing, body: { ...lead('Juan Dela Cruz'), preferred_franchise_location: '  Las   Pinas ' } });
  const inquiryId = json.data.id;
  assert.equal((await call('POST', `/inquiries/${inquiryId}/endorse`, { token: marketing, body: { endorsed_to_user_id: salesUser.id } })).json.data.status, 'endorsed');
  const again = await call('POST', `/inquiries/${inquiryId}/endorse`, { token: admin, body: {} });
  assert.equal(again.status, 403);

  // Conversion now needs an active Sales user: without one (or with a non-Sales account) it is refused.
  const noSales = await call('POST', `/inquiries/${inquiryId}/convert`, { token: admin, body: {} });
  assert.equal(noSales.status, 422);
  assert.match(noSales.json.errors.assigned_sales_user_id[0], /Choose the Sales user/);
  const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
  assert.match((await convert(inquiryId, adminUser.id)).json.errors.assigned_sales_user_id[0], /active Sales user/);
  const converted = await convert(inquiryId);
  assert.equal(converted.status, 201);
  assert.equal(converted.json.data.assigned_sales_user_id, salesUser.id);
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
  // Confirm Qualified lists exactly which Qualification requirements are not Accepted yet.
  const notReady = await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'Trying too early.' } });
  assert.equal(notReady.status, 422);
  assert.match(notReady.json.errors.requirements[0], /Missing: Application form, Valid government ID, Proof of funds, Initial interview\./);
  // The old five-checkbox assessment is replaced.
  const keys = ['profile_reviewed', 'financial_capability_assessed', 'initial_interview_completed', 'preferred_location_evaluated', 'investment_understood'];
  const milestones = Object.fromEntries(keys.map((k) => [`qualification_${k}`, true]));
  assert.match((await call('PUT', `${path}/assessments`, { token: sales, body: { milestones } })).json.errors.milestones[0], /replaced by the Qualification requirements/);
  // Only the assigned Sales user submits; Admin does not upload proof for Sales.
  assert.equal((await call('POST', `${path}/requirements/initial_interview`, { token: admin, form: requirementForm('initial_interview') })).status, 403);
  const notMine = await call('POST', `${path}/requirements/initial_interview`, { token: otherSales, form: requirementForm('initial_interview') });
  assert.equal(notMine.status, 403, 'only the assigned Sales user submits');
  assert.match(notMine.json.message, /Only the assigned Sales user/);
  await completeStage(call, sales, admin, applicantId);
  assert.equal((await call('POST', `${path}/confirm-qualified`, { token: admin, body: {} })).status, 422, 'bare request refused');
  // Confirm Qualified now needs remarks of at least 5 characters.
  assert.match((await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true } })).json.errors.remarks[0], /at least 5 characters/);
  assert.match((await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'ok' } })).json.errors.remarks[0], /at least 5 characters/);
  assert.equal((await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'All five items checked.' } })).json.data.status, 'qualified');
  assert.equal((await call('POST', `${path}/set-schedule`, { token: admin, body: {} })).json.data.status, 'scheduled');
  assert.match((await call('POST', `${path}/set-schedule`, { token: admin, body: {} })).json.message, /already/, 'double click is harmless');

  // Attended requires Sales' Complete, in order.
  const attended = await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: { orientation_attended: true } } });
  assert.match(attended.json.errors.milestones[0], /Sales must mark it Complete first/);
  for (const type of ['orientation', 'training']) {
    await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, completed_at, approval_status, scheduled_by_user_id) values ($1, $2, $3, now() - interval '2 days', now() - interval '2 days', 'completed', now(), 'approved', $4)`, [applicantId, type, type, salesUser.id]);
  }
  const skipOrder = await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: { training_completed: true } } });
  assert.match(skipOrder.json.errors.milestones[0], /must be Done before/);
  // Orientation/Tasting is verified only from its review card (files opened); here it is set as Verify would.
  assert.match((await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: { orientation_attended: true } } })).json.errors.milestones[0], /verified from its review card/);
  await q(`update applicants set milestones = milestones || '{"orientation_attended": true}'::jsonb where id = $1`, [applicantId]);
  const all = await call('PATCH', `${path}/milestones`, {
    token: admin,
    body: { milestones: { orientation_attended: true, training_completed: true }, milestone_details: { training_completed: { on: '2026-11-01' } } },
  });
  assert.equal(all.status, 200, JSON.stringify(all.json));
  assert.equal(all.json.data.schedule_complete, true);
  assert.equal(all.json.data.activity_state.training.done, true);
  assert.equal(all.json.data.milestone_details.training_completed.on, '2026-11-01T00:00');
  assert.match(all.json.data.milestone_details.training_completed.by, /\(Admin\)$/);
  // A saved Attended can never be cleared.
  const cleared = await call('PATCH', `${path}/milestones`, { token: admin, body: { milestones: {} } });
  assert.equal(cleared.json.data.milestones.training_completed, true);

  // LOI: remarks required, an upload alone moves nothing, a future date is refused.
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'loi_submitted' } })).json.errors.remarks[0], /Remarks are required/);
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'loi_submitted', remarks: 'Received' } })).json.data.status, 'loi_submitted');
  const future = new FormData();
  future.set('submission_date', '2999-01-01');
  assert.equal((await call('POST', `${path}/loi`, { token: sales, form: future })).status, 422);
  const loiForm = () => {
    const f = new FormData();
    f.set('file', new File([new Uint8Array([1, 2, 3])], 'loi.pdf', { type: 'application/pdf' }));
    f.set('submission_type', 'digital');
    f.set('submission_date', '2026-11-01');
    return f;
  };
  // Admin no longer uploads the LOI, and another Sales user cannot either.
  const adminUpload = await call('POST', `${path}/loi`, { token: admin, form: loiForm() });
  assert.equal(adminUpload.status, 403);
  assert.match(adminUpload.json.message, /Only the assigned Sales user records the LOI details/);
  assert.equal((await call('POST', `${path}/loi`, { token: otherSales, form: loiForm() })).status, 403);
  // Sales cannot verify its own upload.
  const selfVerify = loiForm();
  selfVerify.set('verification_status', 'verified');
  const salesVerify = await call('POST', `${path}/loi`, { token: sales, form: selfVerify });
  assert.equal(salesVerify.status, 403);
  assert.match(salesVerify.json.message, /Only Admin can set the LOI verification/);
  const filesBefore = files.store.size;
  const upload = await call('POST', `${path}/loi`, { token: sales, form: loiForm() });
  assert.equal(upload.status, 201);
  assert.equal(files.store.size, filesBefore + 1);
  assert.equal((await q(`select status from applicants where id = $1`, [applicantId]))[0].status, 'loi_submitted');
  const download = await call('GET', `${path}/documents/${upload.json.data.id}/download`, { token: admin });
  assert.equal(download.status, 200);
  assert.deepEqual([...new Uint8Array(await download.res.arrayBuffer())], [1, 2, 3]);
  assert.match(download.res.headers.get('content-disposition')!, /loi\.pdf/);
  const wrongType = new FormData();
  wrongType.set('file', new File(['x'], 'virus.exe'));
  assert.ok((await call('POST', `${path}/loi`, { token: sales, form: wrongType })).json.errors.file);
  // A replacement keeps the old file, marked Replaced.
  const replacement = await call('POST', `${path}/loi`, { token: sales, form: loiForm() });
  assert.equal(replacement.status, 201);
  const [old] = await q(`select replaced_at, replaced_by_document_id from documents where id = $1`, [upload.json.data.id]);
  assert.ok(old.replaced_at, 'old LOI kept, marked replaced');
  assert.equal(Number(old.replaced_by_document_id), replacement.json.data.id);
  assert.equal(files.store.size, filesBefore + 2, 'both files stay in storage');
  // Proceed is gone: Complete LOI is the only way on, and it needs the LOI AND the Proposed site verified.
  assert.match((await call('POST', `${path}/loi/proceed`, { token: admin, body: {} })).json.errors.loi[0], /Proceed] was removed/);
  const notYet = (await call('POST', `${path}/loi/complete`, { token: admin, body: {} })).json.errors.loi[0];
  assert.match(notYet, /Mark the LOI as Verified/);
  assert.match(notYet, /Proposed site must be verified by Admin \(it has not been submitted yet\)/);
  const verify = new FormData();
  verify.set('verification_status', 'verified');
  assert.equal((await call('POST', `${path}/loi`, { token: admin, form: verify })).status, 200);
  assert.equal((await call('POST', `/applicants/${applicantId}/requirements/proposed_site`, { token: sales, form: requirementForm('proposed_site', 'loi') })).status, 201);
  const siteWaiting = await call('POST', `${path}/loi/complete`, { token: admin, body: {} });
  assert.equal(siteWaiting.status, 422);
  assert.match(siteWaiting.json.errors.loi[0], /Proposed site must be verified by Admin \(it is waiting for Admin review\)/);
  assert.equal((await call('POST', `/applicants/${applicantId}/requirements/proposed_site/accept`, { token: admin, body: {} })).status, 200);
  const completed = await call('POST', `${path}/loi/complete`, { token: admin, body: {} });
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  assert.equal(completed.json.data.status, 'payment_submitted');
  assert.equal(completed.json.data.loi_status, 'complete');

  // Payment Record: required payments (names only), one entry each, verified by Admin. No amounts.
  const entry = (requiredId: number, or: string, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('required_payment_id', String(requiredId));
    form.set('payment_date', '2026-11-01');
    form.set('payment_method', 'bank_transfer');
    form.set('or_number', or);
    form.set('reference_number', `REF-${or}`);
    form.set('receipt', new File([new TextEncoder().encode('%PDF-1.4 receipt')], 'receipt.pdf', { type: 'application/pdf' }));
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return form;
  };
  assert.match((await call('PATCH', `${path}/payment-plan`, { token: admin, body: { agreed_amount: 80000 } })).json.errors.payments[0], /Agreed Package Amount was removed/);
  assert.match((await call('POST', `${path}/payments/report`, { token: sales, body: { entries: [{ amount: 100, payment_date: '2026-11-01' }] } })).json.errors.payments[0], /not part of this system/, 'no Sales Report batching');
  assert.equal((await call('PUT', `${path}/required-payments`, { token: sales, body: { preset: 'reservation_full' } })).status, 403, 'Sales cannot set the list');
  const plan = await call('PUT', `${path}/required-payments`, { token: admin, body: { preset: 'reservation_full', basis_note: 'Kiosk package, per signed LOI' } });
  assert.equal(plan.status, 200, JSON.stringify(plan.json));
  const [reservationId, fullId] = plan.json.data.required.map((r: any) => r.id);
  assert.equal((await call('POST', `${path}/payment-entries`, { token: sales, form: entry(reservationId, 'OR-1001', { payment_date: '2999-11-01' }) })).json.errors.payment_date[0].includes('future'), true);
  assert.equal((await call('POST', `${path}/payment-entries`, { token: otherSales, form: entry(reservationId, 'OR-1001') })).status, 403, 'only the assigned Sales user records payments');
  const noReceipt = entry(reservationId, 'OR-1001');
  noReceipt.delete('receipt');
  assert.match((await call('POST', `${path}/payment-entries`, { token: sales, form: noReceipt })).json.errors.receipt[0], /Attach the receipt/);
  const first = await call('POST', `${path}/payment-entries`, { token: sales, form: entry(reservationId, 'OR-1001') });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.data.entry.status, 'for_verification');
  const firstId = first.json.data.entry.id;
  assert.equal((await call('POST', `${path}/payment-entries/${firstId}/verify`, { token: sales, body: { revision: 1 } })).status, 403, 'Sales cannot verify');
  const verified = await call('POST', `${path}/payment-entries/${firstId}/verify`, { token: admin, body: { revision: 1 } });
  assert.equal(verified.json.data.verified_count, 1);
  assert.equal(verified.json.data.required_count, 2);
  const [payment] = await q(`select * from payments where applicant_id = $1`, [applicantId]);
  assert.equal(payment.status, 'verified');
  assert.equal((await q(`select count(*)::int c from applicant_payments where legacy_payment_id = $1`, [payment.id]))[0].c, 1, 'ledger mirrors the payment');
  assert.equal((await call('POST', `${path}/payments/complete`, { token: admin, body: {} })).status, 422, 'not every required payment is Verified');
  assert.match((await call('PATCH', `${path}/payments/${payment.id}`, { token: sales, body: { amount: 1 } })).json.errors.payments[0], /not part of this system/);

  const rest = await call('POST', `${path}/payment-entries`, { token: sales, form: entry(fullId, 'OR-1002') });
  assert.equal(rest.status, 201);
  await call('POST', `${path}/payment-entries/${rest.json.data.entry.id}/verify`, { token: admin, body: { revision: 1 } });
  assert.equal((await call('GET', path, { token: admin })).json.data.payment_record.badge_label, 'Completed');

  // A complete LOI's scan can no longer be removed.
  const locked = await call('DELETE', `${path}/documents/${replacement.json.data.id}`, { token: admin, body: { reason: 'Wrong file' } });
  assert.equal(locked.status, 422);
  assert.match(locked.json.errors.document[0], /LOI scan is locked/);
  const complete = await call('POST', `${path}/payments/complete`, { token: admin, body: {} });
  assert.equal(complete.json.data.status, 'for_approval');
  assert.equal(complete.json.data.payment_stage_state, 'confirmed');
  assert.equal((await call('PUT', `${path}/required-payments`, { token: admin, body: { preset: 'full' } })).status, 422, 'the list is locked past the Payment Record');

  // Approval needs the review; activation needs the account.
  assert.match((await call('POST', `${path}/approve`, { token: admin, body: {} })).json.errors.status[0], /review must be confirmed/);
  await call('POST', `${path}/review`, { token: admin, body: {} });
  assert.equal((await call('POST', `${path}/approve`, { token: admin, body: {} })).json.data.status, 'approved');
  assert.match((await call('POST', `${path}/activate`, { token: admin, body: {} })).json.errors.requirements[0], /Missing: Signed franchise agreement/);
  // Activation needs the signed franchise agreement Accepted — including the activation the branch account triggers.
  const noAgreement = await call('POST', `${path}/portal-user`, { token: admin, body: { email: 'Juan@Branch.Test', phone: '09170000000' } });
  assert.equal(noAgreement.status, 422);
  assert.match(noAgreement.json.errors.requirements[0], /Missing: Signed franchise agreement\./);
  assert.equal((await q(`select count(*)::int c from users where email = 'juan@branch.test'`))[0].c, 0, 'the refused account is removed again');
  await completeStage(call, sales, admin, applicantId, 'activation');
  assert.match((await call('POST', `${path}/activate`, { token: admin, body: {} })).json.errors.account[0], /Create an active Franchisee/);
  const portal = await call('POST', `${path}/portal-user`, { token: admin, body: { email: 'Juan@Branch.Test', phone: '09170000000' } });
  assert.equal(portal.status, 201);
  assert.equal(portal.json.data.role.name, 'franchisee');
  assert.ok(!('auth_user_id' in portal.json.data));
  assert.equal((await q(`select status from applicants where id = $1`, [applicantId]))[0].status, 'active_franchisee');
  const [branch] = await q(`select l.* from franchise_locations l join franchisees f on f.id = l.franchisee_id where f.applicant_id = $1`, [applicantId]);
  assert.match(branch.name, / Las Piñas City – Talon Uno$/, 'a new branch is named "<Brand> <City> – <Barangay/St>" from the verified Proposed site, never the person');
  assert.equal(branch.address, 'Talon Uno, Las Piñas City, Metro Manila (NCR)');
  assert.equal(branch.province, 'Metro Manila (NCR)');
  assert.ok((await q(`select archived_at from franchise_inquiries where id = $1`, [inquiryId]))[0].archived_at, 'active franchisee archives its lead');
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'rejected' } })).status, 422, 'terminal stage');
  assert.equal((await call('DELETE', path, { token: admin })).status, 422);

  // The branch account signs in through the branch portal.
  await firstSignIn(call, 'juan@branch.test', portal.json.data.credentials.temporary_password, 'branch');
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
  assert.equal(report.json.data.payment.progress.verified_count, 2);
  assert.equal(report.json.data.payment.progress.all_verified, true);
  assert.ok(!('plan' in report.json.data.payment), 'no billing plan in the report');
  assert.equal(report.json.data.approval.checkpoints.every((x: any) => x.done), true);
  const folders = await call('GET', '/applicants/application-detail?folder=approved', { token: admin });
  const row = folders.json.data.find((a: any) => a.id === applicantId);
  assert.equal(row.payments_verified, 2);
  assert.equal(row.payments_required, 2);
  assert.ok(!('payment_percent' in row));
  assert.equal(typeof folders.json.meta.folder_counts.rejected, 'number');
  assert.equal((await call('GET', '/applicants/active-franchisees?search=juan', { token: admin })).json.data[0].has_portal_account, true);

  const { json } = await call('POST', '/inquiries', { token: marketing, body: lead('Reject Me') });
  await call('POST', `/inquiries/${json.data.id}/endorse`, { token: marketing, body: {} });
  const applicant = (await convert(json.data.id)).json.data;
  // A rejection needs a reason of at least 5 characters.
  assert.match((await call('PATCH', `/applicants/${applicant.id}/status`, { token: admin, body: { status: 'rejected' } })).json.errors.remarks[0], /at least 5 characters/);
  assert.equal((await call('PATCH', `/applicants/${applicant.id}/status`, { token: admin, body: { status: 'rejected', remarks: 'no' } })).status, 422);
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

test('a converted lead cannot be undone, and purge needs a reason', async () => {
  const { json } = await call('POST', '/inquiries', { token: marketing, body: lead('Undo Me') });
  const id = json.data.id;
  await call('POST', `/inquiries/${id}/endorse`, { token: marketing, body: {} });
  assert.equal((await convert(id)).status, 201);
  assert.equal((await call('POST', `/inquiries/${id}/unconvert`, { token: admin, body: {} })).status, 404);
  assert.equal((await q(`select count(*)::int c from applicants where inquiry_id = $1`, [id]))[0].c, 1);

  await call('POST', `/inquiries/${id}/archive`, { token: admin });
  assert.equal((await call('POST', `/archive/inquiries/${id}/purge`, { token: admin, body: { reason: 'Duplicate record' } })).status, 422);
  assert.equal((await q(`select count(*)::int c from franchise_inquiries where id = $1`, [id]))[0].c, 1);
});
