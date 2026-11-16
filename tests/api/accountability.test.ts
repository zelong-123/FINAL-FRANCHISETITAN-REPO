// Phase 1: access and accountability. Every rule is checked through the API, and every action
// must leave an append-only history record (who, role, when, step, old/new values, reason, files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { completeStage, requirementForm } from '../support/requirements.ts';
import { createStaff } from '../support/accounts.ts';

const { pg, call, login, files } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

let phoneSeq = 0;
const nextPhone = () => `0919${String(1000000 + (phoneSeq += 1)).slice(1)}`;
const lead = (name: string, extra: any = {}) => ({
  lead_name: name, first_name: name, last_name: 'Tester', phone: nextPhone(), source: 'facebook', preferred_brand_id: brand.id, ...extra,
});

const backup = await createStaff(call, admin, { full_name: 'Backup Sales', email: 'backup.sales@example.test', phone: '09179990002', role: 'sales' });
const [backupUser] = await q(`select id from users where email = 'backup.sales@example.test'`);

/** An endorsed inquiry converted with the seeded Sales user. */
async function convertedApplicant(name: string) {
  const created = await call('POST', '/inquiries', { token: marketing, body: lead(name) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await call('POST', `/inquiries/${created.json.data.id}/endorse`, { token: marketing, body: {} });
  const converted = await call('POST', `/inquiries/${created.json.data.id}/convert`, { token: admin, body: { assigned_sales_user_id: salesUser.id } });
  assert.equal(converted.status, 201, JSON.stringify(converted.json));
  return converted.json.data;
}
const history = (applicantId: number, event: string) => q(
  `select * from applicant_stage_histories where applicant_id = $1 and event = $2 order by id`, [applicantId, event],
);

test('duplicate inquiries: 409 with the matches, saved only with a reason that is kept and logged', async () => {
  const first = await call('POST', '/inquiries', { token: marketing, body: lead('Ana Reyes', { phone: '0917 555 0101', email: 'Ana.Reyes@Mail.test' }) });
  assert.equal(first.status, 201);

  // Same phone in another format: +63 917 555 0101.
  const byPhone = await call('POST', '/inquiries', { token: marketing, body: lead('Ana R.', { phone: '+63 917 555 0101' }) });
  assert.equal(byPhone.status, 409);
  assert.equal(byPhone.json.matches[0].id, first.json.data.id);
  assert.deepEqual(byPhone.json.matches[0].matched_on, ['phone']);
  assert.ok(byPhone.json.errors.duplicate_reason);

  // Same email, different case.
  const byEmail = await call('POST', '/inquiries', { token: marketing, body: lead('Ana Again', { email: ' ana.reyes@mail.TEST ' }) });
  assert.equal(byEmail.status, 409);
  assert.deepEqual(byEmail.json.matches[0].matched_on, ['email']);

  assert.equal((await call('POST', '/inquiries', { token: marketing, body: lead('Ana R.', { phone: '+639175550101', duplicate_reason: 'ok' }) })).status, 422, 'a too-short reason is refused');
  const saved = await call('POST', '/inquiries', { token: marketing, body: lead('Ana R.', { phone: '+639175550101', duplicate_reason: 'Same person, new branch location.' }) });
  assert.equal(saved.status, 201);
  const [row] = await q(`select duplicate_reason, duplicate_matches from franchise_inquiries where id = $1`, [saved.json.data.id]);
  assert.equal(row.duplicate_reason, 'Same person, new branch location.');
  assert.equal(row.duplicate_matches[0].id, first.json.data.id);
  const [log] = await q(`select * from audit_logs where action = 'inquiry.duplicate_confirmed' and auditable_id = $1`, [saved.json.data.id]);
  assert.equal(log.new_values.duplicate_reason, 'Same person, new branch location.');

  // A rejected inquiry no longer counts as an active match.
  const other = await call('POST', '/inquiries', { token: marketing, body: lead('Rejected Lead', { phone: '09175550202' }) });
  await call('POST', `/inquiries/${other.json.data.id}/endorse`, { token: marketing, body: {} });
  assert.equal((await call('POST', `/inquiries/${other.json.data.id}/reject`, { token: admin, body: { reason: 'Not reachable' } })).status, 200);
  assert.equal((await call('POST', '/inquiries', { token: marketing, body: lead('Fresh Lead', { phone: '09175550202' }) })).status, 201);
});

test('inquiry reject needs a reason of at least 5 characters, which is stored', async () => {
  const { json } = await call('POST', '/inquiries', { token: marketing, body: lead('Reject Reason') });
  await call('POST', `/inquiries/${json.data.id}/endorse`, { token: marketing, body: {} });
  assert.match((await call('POST', `/inquiries/${json.data.id}/reject`, { token: admin, body: {} })).json.errors.reason[0], /at least 5 characters/);
  assert.equal((await call('POST', `/inquiries/${json.data.id}/reject`, { token: admin, body: { reason: '   no ' } })).status, 422);
  const ok = await call('POST', `/inquiries/${json.data.id}/reject`, { token: admin, body: { reason: 'Budget below the minimum package.' } });
  assert.equal(ok.status, 200);
  const [row] = await q(`select status, rejected_reason, rejected_by_user_id, rejected_at from franchise_inquiries where id = $1`, [json.data.id]);
  assert.equal(row.status, 'rejected');
  assert.equal(row.rejected_reason, 'Budget below the minimum package.');
  assert.equal(Number(row.rejected_by_user_id), adminUser.id);
  assert.ok(row.rejected_at);
});

test('conversion alerts only the assigned Sales user, and the assignment is recorded', async () => {
  const applicant = await convertedApplicant('Assigned Alert');
  const alerts = await q(`select user_id from system_notifications where type = 'assessment_pending' and (data->>'applicant_id')::bigint = $1`, [applicant.id]);
  assert.deepEqual(alerts.map((r) => Number(r.user_id)), [salesUser.id], 'the assigned Sales user, nobody else');
  const [assigned] = await history(applicant.id, 'sales_assigned');
  assert.equal(Number(assigned.changed_by_user_id), adminUser.id);
  assert.equal(assigned.actor_role, 'admin');
  assert.equal(Number(assigned.new_values.assigned_sales_user_id), salesUser.id);
  const listed = (await call('GET', '/applicants', { token: admin })).json.data.find((a: any) => a.id === applicant.id);
  assert.equal(listed.assigned_sales.id, salesUser.id);
  assert.equal((await call('GET', `/applicants?assigned_sales_user_id=unassigned`, { token: admin })).json.data.some((a: any) => a.id === applicant.id), false);
});

test('reassignment: Admin only, needs a reason, moves every Sales right and is logged', async () => {
  const applicant = await convertedApplicant('Reassign Me');
  const path = `/applicants/${applicant.id}`;
  assert.equal((await call('POST', `${path}/assign-sales`, { token: sales, body: { assigned_sales_user_id: backupUser.id, reason: 'Taking over' } })).status, 403);
  assert.match((await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: backupUser.id } })).json.errors.reason[0], /at least 5 characters/);
  assert.match((await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: adminUser.id, reason: 'Wrong role' } })).json.errors.assigned_sales_user_id[0], /active Sales user/);
  const moved = await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: backupUser.id, reason: 'Original Sales on leave.' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.data.assigned_sales.id, backupUser.id);

  const submit = (token: string) => call('POST', `${path}/requirements/application_form`, { token, form: requirementForm('application_form') });
  assert.equal((await submit(sales)).status, 403, 'the old Sales user lost the applicant');
  assert.equal((await submit(backup)).status, 201, 'the new one has it');

  const [row] = await history(applicant.id, 'sales_reassigned');
  assert.equal(row.remarks, 'Original Sales on leave.');
  assert.equal(Number(row.old_values.assigned_sales_user_id), salesUser.id);
  assert.equal(Number(row.new_values.assigned_sales_user_id), backupUser.id);
  const notified = await q(`select user_id, type from system_notifications where (data->>'applicant_id')::bigint = $1 and type in ('applicant_assigned', 'applicant_unassigned') order by id`, [applicant.id]);
  assert.deepEqual(notified.map((r) => [Number(r.user_id), r.type]), [[backupUser.id, 'applicant_assigned'], [salesUser.id, 'applicant_unassigned']]);
});

test('an unassigned (legacy) applicant blocks every Sales action until Admin assigns one', async () => {
  const [legacy] = await q(`insert into applicants (full_name, status, application_date) values ('Legacy Person', 'converted', '2026-01-01') returning id`);
  const path = `/applicants/${legacy.id}`;
  const blocked = await call('POST', `${path}/requirements/application_form`, { token: sales, form: requirementForm('application_form') });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.message, 'Admin must assign a Sales user first.');
  assert.equal((await call('GET', `/applicants?assigned_sales_user_id=unassigned`, { token: admin })).json.data.some((a: any) => a.id === legacy.id), true);
  // A first assignment does not need a reason.
  assert.equal((await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: salesUser.id } })).status, 200);
  assert.equal((await call('POST', `${path}/requirements/application_form`, { token: sales, form: requirementForm('application_form') })).status, 201);
});

test('LOI: stage-gated, franchisee refused, Admin only verifies, files locked once verified', async () => {
  // The seeded branch account already owns an applicant: it may read it, never change its LOI.
  const franchisee = await login('franchisee@franchisetitan.local');
  const [own] = await q(`select a.id from applicants a join users u on u.id = a.user_id where u.email = 'franchisee@franchisetitan.local'`);
  const [a] = await q(
    `insert into applicants (full_name, status, application_date, assigned_sales_user_id, loi_verification_status) values ('LOI Person', 'loi_submitted', '2026-01-01', $1, 'not_verified') returning id`,
    [salesUser.id],
  );
  const path = `/applicants/${a.id}`;
  const scan = () => {
    const f = new FormData();
    f.set('file', new File([new Uint8Array([9, 9])], 'scan.png', { type: 'image/png' }));
    f.set('submission_type', 'physical');
    return f;
  };
  const branchTry = await call('POST', `/applicants/${own.id}/loi`, { token: franchisee, form: scan() });
  assert.equal(branchTry.status, 403);
  assert.equal(branchTry.json.message, 'Branch accounts cannot change LOI data.');
  assert.equal((await call('POST', `${path}/loi`, { token: franchisee, form: scan() })).status, 403, 'nor anyone else’s');
  const upload = await call('POST', `${path}/loi`, { token: sales, form: scan() });
  assert.equal(upload.status, 201);

  // Admin may remove an unverified scan at the LOI stage: it is only marked Removed.
  const before = files.store.size;
  const removed = await call('DELETE', `${path}/documents/${upload.json.data.id}`, { token: admin, body: { reason: 'Blurry, ask again.' } });
  assert.equal(removed.status, 200);
  const [doc] = await q(`select removed_at, removed_reason, removed_by_user_id from documents where id = $1`, [upload.json.data.id]);
  assert.ok(doc.removed_at);
  assert.equal(doc.removed_reason, 'Blurry, ask again.');
  assert.equal(files.store.size, before, 'the stored file is kept');
  const [removedLog] = await history(a.id, 'loi_image_removed');
  assert.equal(removedLog.attachments[0].state, 'removed');

  const second = await call('POST', `${path}/loi`, { token: sales, form: scan() });
  const verify = new FormData();
  verify.set('verification_status', 'verified');
  assert.equal((await call('POST', `${path}/loi`, { token: admin, form: verify })).status, 200);
  const [verified] = await history(a.id, 'loi_verification_changed');
  assert.equal(verified.old_values.loi_verification_status, 'not_verified');
  assert.equal(verified.new_values.loi_verification_status, 'verified');
  assert.equal(verified.actor_role, 'admin');
  // Verified: neither removal nor a Sales replacement is allowed.
  assert.equal((await call('DELETE', `${path}/documents/${second.json.data.id}`, { token: admin })).status, 422);
  assert.match((await call('POST', `${path}/loi`, { token: sales, form: scan() })).json.errors.file[0], /already verified/);

  // Outside the LOI stage nothing changes.
  const [early] = await q(`insert into applicants (full_name, status, application_date, assigned_sales_user_id) values ('Too Early', 'converted', '2026-01-01', $1) returning id`, [salesUser.id]);
  assert.match((await call('POST', `/applicants/${early.id}/loi`, { token: sales, form: scan() })).json.errors.loi[0], /only be changed at the LOI stage/);
});

test('required reasons: Undo LOI, Return for revision and payment Return need at least 5 characters', async () => {
  const [a] = await q(`insert into applicants (full_name, status, application_date, assigned_sales_user_id) values ('Reasons', 'loi_submitted', '2026-01-01', $1) returning id`, [salesUser.id]);
  const path = `/applicants/${a.id}`;
  assert.match((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'scheduled' } })).json.errors.remarks[0], /Remarks are required for "Undo LOI"/);
  assert.equal((await call('PATCH', `${path}/status`, { token: admin, body: { status: 'scheduled', remarks: 'Wrong applicant LOI.' } })).json.data.status, 'scheduled');

  await q(`update applicants set status = 'for_approval' where id = $1`, [a.id]);
  assert.match((await call('POST', `${path}/revise`, { token: admin, body: { stage: 'qualified', remarks: 'no' } })).json.errors.remarks[0], /at least 5 characters/);

  await q(`update applicants set status = 'payment_submitted', payment_stage_state = 'for_review' where id = $1`, [a.id]);
  assert.match((await call('POST', `${path}/payments/return`, { token: admin, body: { note: 'bad' } })).json.errors.note[0], /at least 5 characters/);
});

test('the report header shows the real stage, not "Approved applicant"', async () => {
  const applicant = await convertedApplicant('Header Stage');
  const report = await call('GET', `/applicants/${applicant.id}/report`, { token: admin });
  assert.equal(report.json.data.applicant.status, 'converted');
  assert.equal(report.json.data.applicant.status_label, 'Converted');
  assert.equal(report.json.data.applicant.assigned_sales.id, salesUser.id);
});

test('every action leaves an append-only record with user, role, time, step, values and reason', async () => {
  const applicant = await convertedApplicant('History Walk');
  const path = `/applicants/${applicant.id}`;
  const started = Date.now() - 5000;
  await completeStage(call, sales, admin, applicant.id);
  assert.equal((await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'Checklist complete.' } })).status, 200);
  await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: backupUser.id, reason: 'Load balancing.' } });

  const rows = await q(`select * from applicant_stage_histories where applicant_id = $1 order by id`, [applicant.id]);
  const find = (event: string | null, to?: string) => rows.find((r) => r.event === event && (to === undefined || r.to_stage === to));
  const expectRow = (row: any, userId: number, role: string) => {
    assert.ok(row, 'record exists');
    assert.equal(Number(row.changed_by_user_id), userId);
    assert.equal(row.actor_role, role);
    assert.ok(new Date(row.changed_at).getTime() >= started, 'timestamped');
    assert.ok(row.step, 'has a step');
  };
  expectRow(find('converted'), adminUser.id, 'admin');
  const assessed = rows.find((r) => r.event === 'requirement_submitted' && r.step === 'initial_interview');
  expectRow(assessed, salesUser.id, 'sales');
  assert.equal(assessed.new_values.data.interviewer, 'Sales User');
  assert.equal(assessed.attachments[0].type, 'interview_sheet');
  expectRow(rows.find((r) => r.event === 'requirement_accepted' && r.step === 'initial_interview'), adminUser.id, 'admin');
  const qualified = find(null, 'qualified');
  expectRow(qualified, adminUser.id, 'admin');
  assert.equal(qualified.remarks, 'Checklist complete.');
  assert.equal(qualified.old_values.status, 'converted');
  assert.equal(qualified.new_values.status, 'qualified');
  const reassigned = find('sales_reassigned');
  expectRow(reassigned, adminUser.id, 'admin');
  assert.equal(reassigned.remarks, 'Load balancing.');

  // History rows cannot be rewritten.
  await assert.rejects(() => q(`update applicant_stage_histories set remarks = 'edited' where id = $1`, [qualified.id]), /append-only/);
  await assert.rejects(() => q(`update audit_logs set action = 'edited' where id = (select max(id) from audit_logs)`), /append-only/);
});
