// Phase 3: requirements per stage — details + proof, submitted by the assigned Sales user,
// Accepted or Returned (with a reason) by Admin, gating every move, private to Admin and
// the assigned Sales user, and recorded in the applicant history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { completeStage, requirementForm } from '../support/requirements.ts';
import { createStaff } from '../support/accounts.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
const otherSales = await createStaff(call, admin, { full_name: 'Other Sales', email: 'other.req@example.test', phone: '09179990003', role: 'sales' });

let n = 0;
async function applicant(status = 'converted', extra = '') {
  n += 1;
  const [a] = await q(`insert into applicants (full_name, status, application_date, assigned_sales_user_id${extra ? `, ${extra.split('=')[0]}` : ''}) values ($1, $2, '2026-01-01', $3${extra ? `, '${extra.split('=')[1]}'` : ''}) returning id`, [`Req Person ${n}`, status, salesUser.id]);
  return a.id as number;
}
const submit = (id: number, key: string, form: FormData, token = sales) => call('POST', `/applicants/${id}/requirements/${key}`, { token, form });
const events = (id: number, event: string) => q(`select * from applicant_stage_histories where applicant_id = $1 and event = $2 order by id`, [id, event]);

test('the requirement list comes from one config and is sent to the browser', async () => {
  const id = await applicant();
  const req = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.requirements;
  assert.deepEqual(req.config.requirements.filter((r: any) => r.stage === 'qualification').map((r: any) => r.key),
    ['application_form', 'government_id', 'proof_of_funds', 'initial_interview', 'proposed_site', 'business_background']);
  assert.equal(req.config.requirements.find((r: any) => r.key === 'franchise_agreement').stage, 'activation');
  assert.ok(req.items.every((i: any) => i.status === 'pending'));
  assert.equal(req.summary.qualification.complete, false);
  assert.equal(req.summary.qualification.open, true);
  assert.equal(req.loi.status, 'pending');
});

test('each requirement validates its details and its proof files', async () => {
  const id = await applicant();
  assert.ok((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_type: null }))).json.errors.id_type, 'ID type required');
  assert.ok((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_type: 'library_card' }))).json.errors.id_type, 'only listed ID types');
  assert.ok((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_copy: null }))).json.errors.id_copy, 'the ID file is required');
  assert.match((await submit(id, 'initial_interview', requirementForm('initial_interview', 'qualification', { interview_date: '2999-01-01' }))).json.errors.interview_date[0], /future/);
  assert.match((await submit(id, 'initial_interview', requirementForm('initial_interview', 'qualification', { notes: 'short' }))).json.errors.notes[0], /at least 10/);
  const wrongType = requirementForm('proof_of_funds');
  wrongType.set('bank_certificate', new File(['x'], 'statement.exe'));
  assert.match((await submit(id, 'proof_of_funds', wrongType)).json.errors.bank_certificate[0], /PDF, JPG, JPEG, PNG/);
  const twoForms = requirementForm('application_form');
  twoForms.append('form', new File([new Uint8Array([1])], 'b.pdf', { type: 'application/pdf' }));
  assert.ok((await submit(id, 'application_form', twoForms)).json.errors.form, 'one file only where one is expected');
  const photos = requirementForm('proposed_site');
  photos.append('site_photos', new File([new Uint8Array([1])], 'front.png', { type: 'image/png' }));
  const site = await submit(id, 'proposed_site', photos);
  assert.equal(site.status, 201, JSON.stringify(site.json));
  assert.equal(site.json.data.files.length, 2, 'several site photos');
  assert.match((await submit(id, 'franchise_agreement', requirementForm('franchise_agreement', 'activation'))).json.errors.requirement[0], /submitted at the Before Active Franchisee stage/);
});

test('Sales submits, Admin Accepts or Returns with a reason, Sales corrects and resubmits', async () => {
  const id = await applicant();
  const path = `/applicants/${id}/requirements/initial_interview`;
  assert.equal((await submit(id, 'initial_interview', requirementForm('initial_interview'), admin)).status, 403, 'Admin does not upload for Sales');
  assert.equal((await submit(id, 'initial_interview', requirementForm('initial_interview'), otherSales)).status, 403, 'only the assigned Sales user');
  const first = await submit(id, 'initial_interview', requirementForm('initial_interview'));
  assert.equal(first.status, 201);
  assert.ok((await q(`select 1 from system_notifications where user_id = $1 and type = 'requirement_submitted' and (data->>'applicant_id')::bigint = $2`, [adminUser.id, id])).length, 'Admin is notified');
  assert.equal((await submit(id, 'initial_interview', requirementForm('initial_interview'))).status, 422, 'waiting for review');
  assert.equal((await call('POST', `${path}/accept`, { token: sales, body: {} })).status, 403, 'Sales cannot verify its own submission');
  assert.ok((await call('POST', `${path}/return`, { token: admin, body: { reason: 'no' } })).json.errors.reason);
  const returned = await call('POST', `${path}/return`, { token: admin, body: { reason: 'The interview sheet is not signed.' } });
  assert.equal(returned.json.data.items.find((i: any) => i.key === 'initial_interview').status, 'returned');
  assert.ok((await q(`select 1 from system_notifications where user_id = $1 and type = 'requirement_returned' and (data->>'applicant_id')::bigint = $2`, [salesUser.id, id])).length, 'the assigned Sales user is notified');

  // A resubmission with a new file marks the old one Replaced.
  const again = await submit(id, 'initial_interview', requirementForm('initial_interview', 'qualification', { notes: 'Signed sheet attached this time, all answers recorded.' }));
  assert.equal(again.status, 201);
  const docs = await q(`select replaced_at from documents where documentable_type = 'App\\Models\\ApplicantRequirement' and documentable_id = $1 order by id`, [first.json.data.id]);
  assert.equal(docs.length, 2);
  assert.ok(docs[0].replaced_at, 'the old sheet is kept, marked Replaced');
  const accepted = await call('POST', `${path}/accept`, { token: admin, body: {} });
  assert.equal(accepted.json.data.items.find((i: any) => i.key === 'initial_interview').status, 'accepted');
  assert.equal((await submit(id, 'initial_interview', requirementForm('initial_interview'))).status, 422, 'an Accepted requirement is final');

  const [submitted, resubmitted] = [...await events(id, 'requirement_submitted'), ...await events(id, 'requirement_resubmitted')];
  assert.equal(submitted.actor_role, 'sales');
  assert.equal(submitted.attachments[0].type, 'interview_sheet');
  assert.equal(resubmitted.old_values.status, 'returned');
  assert.equal(resubmitted.attachments.find((x: any) => x.state === 'replaced').type, 'interview_sheet');
  const [returnLog] = await events(id, 'requirement_returned');
  assert.equal(returnLog.remarks, 'The interview sheet is not signed.');
  assert.equal(Number(returnLog.changed_by_user_id), adminUser.id);
});

test('a returned item may keep the files Admin did not object to', async () => {
  const id = await applicant();
  const path = `/applicants/${id}/requirements/government_id`;
  await submit(id, 'government_id', requirementForm('government_id'));
  await call('POST', `${path}/return`, { token: admin, body: { reason: 'Wrong ID type selected.' } });
  const fixed = await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_type: 'umid', id_copy: null }));
  assert.equal(fixed.status, 201, JSON.stringify(fixed.json));
  const item = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.requirements.items.find((i: any) => i.key === 'government_id');
  assert.equal(item.data.id_type, 'umid');
  assert.equal(item.files.length, 1, 'the earlier ID copy is still attached');
});

test('privacy: only Admin and the assigned Sales user see or download the files', async () => {
  const id = await applicant();
  const sent = await submit(id, 'application_form', requirementForm('application_form'));
  const doc = sent.json.data.files[0].id;
  const url = `/applicants/${id}/requirements/application_form/documents/${doc}/download`;
  assert.equal((await call('GET', url, { token: admin })).status, 200);
  assert.equal((await call('GET', url, { token: sales })).status, 200);
  assert.equal((await call('GET', url, { token: otherSales })).status, 403);
  assert.equal((await call('GET', url, { token: marketing })).status, 403);
  const otherView = (await call('GET', `/applicants/${id}`, { token: otherSales })).json.data.requirements;
  assert.equal(otherView.files_visible, false);
  assert.equal(otherView.items[0].files, null, 'another Sales user sees the status, not the files');
});

test('gates: Confirm Qualified and activation list exactly what is missing', async () => {
  const id = await applicant();
  await completeStage(call, sales, admin, id);
  const qualified = await call('POST', `/applicants/${id}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'All requirements accepted.' } });
  assert.equal(qualified.json.data.status, 'qualified');
  assert.equal(qualified.json.data.milestones.qualification_initial_interview_completed, true, 'the old flags follow the accepted requirements');

  const approved = await applicant('approved');
  assert.match((await call('POST', `/applicants/${approved}/activate`, { token: admin, body: {} })).json.errors.requirements[0], /Mark as Active Franchisee needs every Before Active Franchisee requirement Accepted\. Missing: Signed franchise agreement\./);
});

test('LOI: the scan is required for every LOI and Admin can return it', async () => {
  const id = await applicant('loi_submitted', "loi_submission_type=physical");
  await q(`update applicants set loi_submission_date = '2026-11-01', loi_verification_status = 'not_verified' where id = $1`, [id]);
  const path = `/applicants/${id}`;
  const verify = () => { const f = new FormData(); f.set('verification_status', 'verified'); return f; };
  assert.match((await call('POST', `${path}/loi`, { token: admin, form: verify() })).json.errors.verification_status[0], /no LOI scan to verify/);
  assert.match((await call('POST', `${path}/loi/complete`, { token: admin, body: {} })).json.errors.loi[0], /required for every LOI, hard copies included/);
  const scan = () => { const f = new FormData(); f.set('file', new File([new Uint8Array([3])], 'loi.pdf', { type: 'application/pdf' })); return f; };
  await call('POST', `${path}/loi`, { token: sales, form: scan() });
  assert.equal((await call('GET', path, { token: admin })).json.data.requirements.loi.status, 'submitted');
  assert.ok((await call('POST', `${path}/loi/return`, { token: admin, body: {} })).json.errors.reason);
  assert.equal((await call('POST', `${path}/loi/return`, { token: sales, body: { reason: 'Myself' } })).status, 403);
  assert.equal((await call('POST', `${path}/loi/return`, { token: admin, body: { reason: 'The scan is cut off at the bottom.' } })).status, 200);
  const view = (await call('GET', path, { token: admin })).json.data.requirements.loi;
  assert.equal(view.status, 'returned');
  assert.equal(view.return_reason, 'The scan is cut off at the bottom.');
  assert.match((await call('POST', `${path}/loi`, { token: admin, form: verify() })).json.errors.verification_status[0], /returned/);
  await call('POST', `${path}/loi`, { token: sales, form: scan() });
  assert.equal((await call('POST', `${path}/loi`, { token: admin, form: verify() })).status, 200);
  assert.equal((await call('GET', path, { token: admin })).json.data.requirements.loi.status, 'accepted');
  const [log] = await events(id, 'loi_returned');
  assert.equal(log.remarks, 'The scan is cut off at the bottom.');
});

test('legacy applicants already past a stage are not blocked and show "not captured"', async () => {
  const id = await applicant('scheduled');
  await q(`update applicants set milestones = '{"qualification_profile_reviewed": true, "qualification_financial_capability_assessed": true, "qualification_initial_interview_completed": true, "qualification_preferred_location_evaluated": true, "qualification_investment_understood": true}' where id = $1`, [id]);
  const req = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.requirements;
  assert.equal(req.summary.qualification.legacy, true);
  const active = await applicant('active_franchisee');
  assert.equal((await call('GET', `/applicants/${active}`, { token: admin })).json.data.requirements.summary.activation.legacy, true);
  const fresh = await applicant('converted');
  assert.equal((await call('GET', `/applicants/${fresh}`, { token: admin })).json.data.requirements.summary.qualification.legacy, false);
});
