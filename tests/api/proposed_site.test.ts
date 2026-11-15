// The Proposed site moved from Qualification to LOI Submission; the LOI file is required; Complete
// LOI needs the LOI and the Proposed site verified; early Proposed site data is removed by a script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN, SALES, setup } from '../support/harness.ts';
import { completeStage, requirementForm } from '../support/requirements.ts';
import { removeEarlyProposedSite } from '../../supabase/scripts/remove_early_proposed_site.ts';

const { pg, db, files, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
let n = 0;

async function applicant(status: string, extra: Record<string, unknown> = {}) {
  n += 1;
  const cols = ['full_name', 'status', 'application_date', 'assigned_sales_user_id', ...Object.keys(extra)];
  const vals = [`Site Person ${n}`, status, '2026-01-01', salesUser.id, ...Object.values(extra)];
  const [a] = await q(`insert into applicants (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals);
  return a.id as number;
}
const detail = async (id: number, token = admin) => (await call('GET', `/applicants/${id}`, { token })).json.data;
const site = (id: number, form = requirementForm('proposed_site', 'loi'), token = sales) => call('POST', `/applicants/${id}/requirements/proposed_site`, { token, form });
const loiFile = (name = 'loi.pdf') => {
  const f = new FormData();
  f.set('file', new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' }));
  f.set('submission_type', 'physical');
  f.set('submission_date', '2026-11-01');
  return f;
};
const verifyLoi = (id: number) => { const f = new FormData(); f.set('verification_status', 'verified'); return call('POST', `/applicants/${id}/loi`, { token: admin, form: f }); };
const complete = (id: number) => call('POST', `/applicants/${id}/loi/complete`, { token: admin, body: {} });

test('Qualification has 4 requirements; Confirm Qualified passes with those 4 Accepted', async () => {
  const id = await applicant('converted');
  const req = (await detail(id)).requirements;
  assert.deepEqual(req.config.requirements.filter((r: any) => r.stage === 'qualification').map((r: any) => r.key),
    ['application_form', 'government_id', 'proof_of_funds', 'initial_interview']);
  assert.equal(req.config.requirements.find((r: any) => r.key === 'proposed_site').stage, 'loi');
  assert.equal(req.summary.qualification.missing.length, 4, 'the Proposed site is no longer counted');
  assert.match((await site(id)).json.errors.requirement[0], /submitted at the LOI Submission stage/);
  await completeStage(call, sales, admin, id, 'qualification');
  const confirmed = await call('POST', `/applicants/${id}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'All four requirements accepted.' } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.data.status, 'qualified');
});

test('an applicant at Qualification with the 4 Accepted is eligible but not moved automatically', async () => {
  const id = await applicant('converted');
  await completeStage(call, sales, admin, id, 'qualification');
  const view = await detail(id);
  assert.equal(view.status, 'converted', 'no auto-advance');
  assert.equal(view.requirements.summary.qualification.complete, true);
});

test('the LOI cannot be submitted or verified without a file', async () => {
  const id = await applicant('loi_submitted', { loi_confirmed_at: new Date() });
  const noFile = new FormData();
  noFile.set('submission_type', 'physical');
  noFile.set('submission_date', '2026-11-01');
  assert.match((await call('POST', `/applicants/${id}/loi`, { token: sales, form: noFile })).json.errors.file[0], /cannot be submitted without it/);
  assert.match((await verifyLoi(id)).json.errors.verification_status[0], /no LOI scan to verify/);
  assert.equal((await call('POST', `/applicants/${id}/loi`, { token: sales, form: loiFile() })).status, 201);
  assert.equal((await call('POST', `/applicants/${id}/loi`, { token: sales, form: noFile })).status, 200, 'details can be saved once a file is on record');
  assert.equal((await verifyLoi(id)).status, 200);
});

test('Proposed site at LOI Submission: save, reload, Admin return with reason, resubmit, verify, then read-only', async () => {
  const id = await applicant('loi_submitted', { loi_confirmed_at: new Date() });
  assert.equal((await site(id, requirementForm('proposed_site', 'loi', { site_photos: null }))).json.errors.site_photos[0], 'Attach the site photos.');
  assert.match((await site(id, requirementForm('proposed_site', 'loi', { location: null }))).json.errors['location.province_code'][0], /Choose a Province/);
  assert.match((await site(id, requirementForm('proposed_site', 'loi', { 'location.city_code': '' }))).json.errors['location.city_code'][0], /Choose a City\/Municipality/,'City/Municipality is required');
  assert.match((await site(id, requirementForm('proposed_site', 'loi', { 'location.city_code': '0402103000' }))).json.errors['location.city_code'][0], /is not in Metro Manila/, 'a city outside the province is refused');
  assert.ok((await site(id, requirementForm('proposed_site', 'loi', { ownership: 'rented' }))).json.errors.ownership);
  assert.equal((await site(id, requirementForm('proposed_site', 'loi'), admin)).status, 403, 'Admin does not encode it');
  const sent = await site(id);
  assert.equal(sent.status, 201);

  for (const token of [admin, sales]) {
    const item = (await detail(id, token)).requirements.items.find((i: any) => i.key === 'proposed_site');
    assert.equal(item.status, 'submitted');
    assert.equal(item.data.address, 'Talon Uno, Las Piñas City, Metro Manila (NCR)', 'saved and shown again on reload');
    assert.deepEqual([item.data.location.province, item.data.location.city, item.data.location.barangay], ['Metro Manila (NCR)', 'Las Piñas City', 'Talon Uno']);
    assert.equal(item.location_text, 'Talon Uno, Las Piñas City, Metro Manila (NCR)', 'Admin sees the formatted location');
    assert.equal(item.data.ownership, 'leased');
    assert.equal(item.files.length, 1);
  }
  const path = `/applicants/${id}/requirements/proposed_site`;
  assert.ok((await call('POST', `${path}/return`, { token: admin, body: { reason: 'no' } })).json.errors.reason, 'a reason is required');
  assert.equal((await call('POST', `${path}/return`, { token: admin, body: { reason: 'The photos do not show the frontage.' } })).status, 200);
  const returned = (await detail(id, sales)).requirements.items.find((i: any) => i.key === 'proposed_site');
  assert.equal(returned.status, 'returned');
  assert.equal(returned.return_reason, 'The photos do not show the frontage.');
  const [alert] = await q(`select message from system_notifications where user_id = $1 and type = 'requirement_returned' and (data->>'applicant_id')::bigint = $2`, [salesUser.id, id]);
  assert.match(alert.message, /frontage/);

  assert.equal((await site(id, requirementForm('proposed_site', 'loi'))).status, 201, 'the encoder corrects and resubmits');
  assert.equal((await call('POST', `${path}/accept`, { token: sales, body: {} })).status, 403, 'Sales cannot verify');
  assert.equal((await call('POST', `${path}/accept`, { token: admin, body: {} })).status, 200);
  assert.match((await site(id)).json.errors.requirement[0], /already Accepted/, 'verified data is read-only for the encoder');
  const history = (await call('GET', `/applicants/${id}/history?page=loi`, { token: admin })).json.data.map((h: any) => h.event);
  assert.deepEqual(history.filter((e: string) => e.startsWith('requirement_')), ['requirement_submitted', 'requirement_returned', 'requirement_resubmitted', 'requirement_accepted'],
    'the Proposed site history shows on the LOI page');
});

test('LOI → Payment Record is blocked unless both the LOI and the Proposed site are verified, in any order', async () => {
  // Proposed site first.
  const a = await applicant('loi_submitted', { loi_confirmed_at: new Date() });
  await site(a);
  await call('POST', `/applicants/${a}/requirements/proposed_site/accept`, { token: admin, body: {} });
  const onlySite = await complete(a);
  assert.equal(onlySite.status, 422);
  assert.match(onlySite.json.errors.loi[0], /Missing: .*Mark the LOI as Verified/);
  assert.doesNotMatch(onlySite.json.errors.loi[0], /Proposed site must be verified/);
  await call('POST', `/applicants/${a}/loi`, { token: sales, form: loiFile() });
  await verifyLoi(a);
  assert.equal((await complete(a)).json.data.status, 'payment_submitted');

  // LOI first.
  const b = await applicant('loi_submitted', { loi_confirmed_at: new Date() });
  await call('POST', `/applicants/${b}/loi`, { token: sales, form: loiFile() });
  await verifyLoi(b);
  const onlyLoi = await complete(b);
  assert.match(onlyLoi.json.errors.loi[0], /Proposed site must be verified by Admin \(it has not been submitted yet\)/);
  assert.doesNotMatch(onlyLoi.json.errors.loi[0], /Mark the LOI/);
  await site(b);
  assert.match((await complete(b)).json.errors.loi[0], /waiting for Admin review/);
  await call('POST', `/applicants/${b}/requirements/proposed_site/accept`, { token: admin, body: {} });
  assert.equal((await complete(b)).status, 200);

  assert.match((await call('POST', `/applicants/${b}/loi/proceed`, { token: admin, body: {} })).json.errors.loi[0], /was removed/);
  const c = await applicant('loi_submitted', { loi_confirmed_at: new Date() });
  assert.equal((await call('PATCH', `/applicants/${c}/status`, { token: admin, body: { status: 'payment_submitted', remarks: 'Skip it please.' } })).status, 422, 'no direct stage change');
});

test('applicants already past LOI Submission are not blocked, even with no LOI file or Proposed site', async () => {
  const id = await applicant('payment_submitted', { loi_status: 'complete', loi_verification_status: 'verified', loi_confirmed_at: new Date() });
  const view = await detail(id);
  assert.equal(view.requirements.summary.loi.legacy, true, 'shown as not captured, never required');
  assert.equal(view.payment_record.loi_document, null);
  assert.equal(view.payment_record.loi_file_missing, true, 'the card says "No LOI file on record"');
  assert.equal((await call('PUT', `/applicants/${id}/required-payments`, { token: admin, body: { preset: 'full' } })).status, 200);
  const [item] = (await call('GET', `/applicants/${id}/payment-record`, { token: admin })).json.data.required;
  const form = new FormData();
  form.set('required_payment_id', String(item.id));
  form.set('payment_date', '2026-11-01');
  form.set('payment_method', 'cash');
  form.set('or_number', 'OR-PAST-LOI-1');
  form.set('receipt', new File([new TextEncoder().encode('%PDF-1.4 r')], 'r.pdf', { type: 'application/pdf' }));
  const entry = (await call('POST', `/applicants/${id}/payment-entries`, { token: sales, form })).json.data.entry;
  await call('POST', `/applicants/${id}/payment-entries/${entry.id}/verify`, { token: admin, body: { revision: entry.revision } });
  const moved = await call('POST', `/applicants/${id}/payments/complete`, { token: admin, body: {} });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal(moved.json.data.status, 'for_approval');
});

test('existing data: Proposed site removed only before LOI Submission (rows, files, history, audited); kept at or after it', async () => {
  const addSite = async (id: number, stage: string, file: string) => {
    const [r] = await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at)
      values ($1, 'proposed_site', $2, 'accepted', '{"address": "Old St", "ownership": "owned"}', $3, now(), $4, now()) returning id`, [id, stage, salesUser.id, adminUser.id]);
    const [d] = await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, uploaded_by_user_id)
      values ('App\\Models\\ApplicantRequirement', $1, 'site_photos', 'site.png', 'x.png', 'private', $2, $3) returning id`, [r.id, file, salesUser.id]);
    await files.put('private', file, new Uint8Array([9]), 'image/png');
    await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, event, step, changed_at) values ($1, 'converted', 'converted', 'requirement_accepted', 'proposed_site', now())`, [id]);
    return { requirement: r.id as number, document: d.id as number };
  };
  const early = await applicant('scheduled');
  const shared = await applicant('converted');
  const kept = await applicant('payment_submitted');
  const e = await addSite(early, 'qualification', 'applicants/e/site-early.png');
  const s1 = await addSite(shared, 'qualification', 'applicants/k/site-shared.png');
  const k = await addSite(kept, 'qualification', 'applicants/k/site-shared.png'); // the kept record points to the same file
  await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data) values ($1, 'application_form', 'qualification', 'accepted', '{}')`, [early]);

  // The migration re-labels the kept row; the early ones stay as they are until the script runs.
  await pg.exec(readFileSync(new URL('../../supabase/migrations/20261115000001_proposed_site_to_loi.sql', import.meta.url), 'utf8'));
  assert.equal((await q(`select stage from applicant_requirements where id = $1`, [k.requirement]))[0].stage, 'loi');
  assert.equal((await q(`select stage from applicant_requirements where id = $1`, [e.requirement]))[0].stage, 'qualification');

  const dry = await removeEarlyProposedSite(db, files, [early, shared, kept], false);
  assert.deepEqual(dry.map((p) => p.action), ['delete', 'delete', 'refused']);
  assert.deepEqual(dry[1].shared_files, ['private/applicants/k/site-shared.png']);
  assert.equal((await q(`select count(*)::int c from applicant_requirements where requirement_key = 'proposed_site' and applicant_id = any($1::bigint[])`, [`{${early},${shared}}`]))[0].c, 2, 'dry run changes nothing');

  await removeEarlyProposedSite(db, files, [early, shared, kept], true);
  const left = await q(`select applicant_id from applicant_requirements where requirement_key = 'proposed_site' and applicant_id = any($1::bigint[]) order by applicant_id`, [`{${early},${shared},${kept}}`]);
  assert.deepEqual(left.map((r) => Number(r.applicant_id)), [kept]);
  assert.equal((await q(`select count(*)::int c from documents where id = any($1::bigint[])`, [`{${e.document},${s1.document}}`]))[0].c, 0);
  assert.equal((await q(`select count(*)::int c from documents where id = $1`, [k.document]))[0].c, 1, 'the kept record keeps its photo row');
  assert.equal(await files.get('private', 'applicants/e/site-early.png'), null, 'the early file is gone from storage');
  assert.ok(await files.get('private', 'applicants/k/site-shared.png'), 'a file still used by a kept record stays in storage');
  assert.equal((await q(`select count(*)::int c from applicant_stage_histories where step = 'proposed_site' and applicant_id = $1`, [early]))[0].c, 0);
  assert.equal((await q(`select count(*)::int c from applicant_stage_histories where step = 'proposed_site' and applicant_id = $1`, [kept]))[0].c, 1);
  assert.equal((await q(`select count(*)::int c from applicant_requirements where applicant_id = $1 and requirement_key = 'application_form'`, [early]))[0].c, 1, 'other requirements are untouched');
  assert.equal((await q(`select status from applicants where id = $1`, [early]))[0].status, 'scheduled', 'the applicant is untouched');
  const audits = await q(`select auditable_id, old_values from audit_logs where action = 'applicant.proposed_site_removed' order by id`);
  assert.deepEqual(audits.map((a) => Number(a.auditable_id)), [early, shared]);
  assert.equal(audits[0].old_values.address, 'Old St');
});
