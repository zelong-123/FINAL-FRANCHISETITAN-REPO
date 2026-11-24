// Verification proofs: Admin opens every file before Accept / Verify (requirements, LOI, payment
// receipts; Training is in orientation_tasting and walkthrough), uploads are checked by their contents,
// an applicant with verified records cannot be permanently deleted, and the Government ID carries its number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';
import { createStaff } from '../support/accounts.ts';
import { requirementForm } from '../support/requirements.ts';
import { openAll, openRequirement, realFile } from '../support/files.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const secondAdmin = await createStaff(call, admin, { full_name: 'Second Admin', email: 'second.admin.proofs@example.test', phone: '09179990061', role: 'admin' });
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

let n = 0;
async function applicant(status: string, extra: Record<string, unknown> = {}) {
  n += 1;
  const cols = ['full_name', 'status', 'application_date', 'assigned_sales_user_id', ...Object.keys(extra)];
  const vals = [`Proof Person ${n}`, status, '2026-01-01', salesUser.id, ...Object.values(extra)];
  const [a] = await q(`insert into applicants (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, vals);
  return a.id as number;
}
const submit = (id: number, key: string, form: FormData) => call('POST', `/applicants/${id}/requirements/${key}`, { token: sales, form });
const accept = (id: number, key: string, token = admin) => call('POST', `/applicants/${id}/requirements/${key}/accept`, { token, body: {} });
const itemOf = async (id: number, key: string, token = admin) => (await call('GET', `/applicants/${id}`, { token })).json.data.requirements.items.find((i: any) => i.key === key);

test('a requirement is accepted only after this Admin opened every current file', async () => {
  const id = await applicant('loi_submitted');
  const form = requirementForm('proposed_site', 'loi');
  form.append('site_photos', realFile('side.png'));
  const sent = await submit(id, 'proposed_site', form);
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  const [front, side] = sent.json.data.files;

  const refused = await accept(id, 'proposed_site');
  assert.equal(refused.status, 422);
  assert.match(refused.json.errors.requirement[0], /Open every submitted file before you accept Proposed site\. Not opened yet: site_photos\.jpg, side\.png\./);
  assert.deepEqual((await itemOf(id, 'proposed_site')).files.map((d: any) => d.viewed_by_me), [false, false]);

  await openRequirement(call, admin, id, 'proposed_site', [front]);
  assert.deepEqual((await itemOf(id, 'proposed_site')).files.map((d: any) => d.viewed_by_me), [true, false], 'each file says whether this Admin opened it');
  assert.match((await accept(id, 'proposed_site')).json.errors.requirement[0], /Not opened yet: side\.png\.$/);

  // Another Admin's open does not count for this Admin, and the other Admin still has to open everything.
  await openRequirement(call, secondAdmin, id, 'proposed_site', [side]);
  assert.match((await accept(id, 'proposed_site')).json.errors.requirement[0], /side\.png/);
  assert.match((await accept(id, 'proposed_site', secondAdmin)).json.errors.requirement[0], /Not opened yet: site_photos\.jpg\.$/);
  // Sales opening the files is not an Admin open, and gives Sales no flag.
  await openRequirement(call, sales, id, 'proposed_site', [front, side]);
  assert.equal((await itemOf(id, 'proposed_site', sales)).files.every((d: any) => d.viewed_by_me === undefined), true);

  await openRequirement(call, admin, id, 'proposed_site', [side]);
  assert.equal((await accept(id, 'proposed_site')).status, 200);
  const views = await q(`select count(*)::int n from activity_document_views where document_id = any($1::bigint[])`, [`{${front.id},${side.id}}`]);
  assert.equal(views[0].n, 3, 'one view row per file and per Admin (Sales opens are not recorded)');
});

test('a resubmission after a Return needs its new files opened again', async () => {
  const id = await applicant('converted');
  const first = await submit(id, 'application_form', requirementForm('application_form'));
  await openRequirement(call, admin, id, 'application_form', first.json.data.files);
  await call('POST', `/applicants/${id}/requirements/application_form/return`, { token: admin, body: { reason: 'Page two is missing.' } });
  const again = await submit(id, 'application_form', requirementForm('application_form'));
  assert.equal(again.status, 201);
  assert.match((await accept(id, 'application_form')).json.errors.requirement[0], /Not opened yet: form\.pdf/);
  await openRequirement(call, admin, id, 'application_form', again.json.data.files);
  assert.equal((await accept(id, 'application_form')).status, 200);
});

test('uploads are checked by their contents: a renamed file is refused', async () => {
  const id = await applicant('converted');
  const renamed = requirementForm('application_form');
  renamed.set('form', new File([new TextEncoder().encode('just some text')], 'form.pdf', { type: 'application/pdf' }));
  assert.match((await submit(id, 'application_form', renamed)).json.errors.form[0], /not a real PDF file/);
  const mismatch = requirementForm('government_id');
  mismatch.set('id_copy', new File([await realFile('x.png').arrayBuffer()], 'id.jpg', { type: 'image/jpeg' }));
  assert.match((await submit(id, 'government_id', mismatch)).json.errors.id_copy[0], /not a real JPG file/, 'a PNG named .jpg');

  const atLoi = await applicant('loi_submitted', { loi_verification_status: 'not_verified' });
  const loi = new FormData();
  loi.set('file', new File([new TextEncoder().encode('not a scan')], 'loi.pdf', { type: 'application/pdf' }));
  loi.set('submission_type', 'physical');
  assert.match((await call('POST', `/applicants/${atLoi}/loi`, { token: sales, form: loi })).json.errors.file[0], /not a real PDF, JPG or PNG/);
  assert.equal((await q(`select count(*)::int n from documents where documentable_id = $1 and type = 'loi'`, [atLoi]))[0].n, 0, 'nothing was stored');
});

test('the LOI is verified only after Admin opened the scan; a page thumbnail does not count', async () => {
  const id = await applicant('loi_submitted', { loi_verification_status: 'not_verified', loi_submission_date: '2026-11-01' });
  const scan = new FormData();
  scan.set('file', realFile('signed-loi.png'));
  scan.set('submission_type', 'physical');
  const upload = await call('POST', `/applicants/${id}/loi`, { token: sales, form: scan });
  assert.equal(upload.status, 201, JSON.stringify(upload.json));
  const verify = () => { const f = new FormData(); f.set('verification_status', 'verified'); return call('POST', `/applicants/${id}/loi`, { token: admin, form: f }); };
  assert.match((await verify()).json.errors.verification_status[0], /Open every submitted file before you verify the LOI\. Not opened yet: signed-loi\.png\./);

  const url = `/applicants/${id}/documents/${upload.json.data.id}/download`;
  assert.equal((await call('GET', `${url}?thumbnail=1`, { token: admin })).status, 200);
  assert.match((await verify()).json.errors.verification_status[0], /signed-loi\.png/, 'the thumbnail is not an open');
  const before = (await call('GET', `/applicants/${id}`, { token: admin })).json.data;
  assert.equal(before.documents.find((d: any) => d.id === upload.json.data.id).viewed_by_me, false);
  assert.equal(before.requirements.loi.scan.viewed_by_me, false);

  assert.equal((await call('GET', url, { token: admin })).status, 200);
  const after = (await call('GET', `/applicants/${id}`, { token: admin })).json.data;
  assert.equal(after.documents.find((d: any) => d.id === upload.json.data.id).viewed_by_me, true);
  assert.equal(after.requirements.loi.scan.viewed_by_me, true);
  assert.equal((await verify()).status, 200);
});

test('a payment is verified only after Admin opened every receipt', async () => {
  const id = await applicant('payment_submitted', { loi_status: 'complete', loi_verification_status: 'verified', loi_confirmed_at: new Date() });
  assert.equal((await call('PUT', `/applicants/${id}/required-payments`, { token: admin, body: { preset: 'full' } })).status, 200);
  const [item] = (await call('GET', `/applicants/${id}/payment-record`, { token: admin })).json.data.required;
  const form = new FormData();
  form.set('required_payment_id', String(item.id));
  form.set('payment_date', '2026-11-01');
  form.set('payment_method', 'gcash');
  form.set('or_number', 'OR-PROOF-1');
  form.set('reference_number', 'GC-PROOF-1');
  form.append('receipt', realFile('receipt-1.jpg'));
  form.append('receipt', realFile('receipt-2.pdf'));
  const entry = (await call('POST', `/applicants/${id}/payment-entries`, { token: sales, form })).json.data.entry;
  assert.equal(entry.receipts.length, 2);
  const verify = () => call('POST', `/applicants/${id}/payment-entries/${entry.id}/verify`, { token: admin, body: { revision: entry.revision } });

  const refused = await verify();
  assert.equal(refused.status, 422);
  assert.match(refused.json.errors.receipt[0], /Open every submitted file before you verify this payment\. Not opened yet: receipt-1\.jpg, receipt-2\.pdf\./);
  await call('GET', `/applicants/${id}/payments/${entry.id}/documents/${entry.receipts[0].id}/download`, { token: admin });
  const record = (await call('GET', `/applicants/${id}/payment-record`, { token: admin })).json.data;
  assert.deepEqual(record.required[0].entry.receipts.map((d: any) => d.viewed_by_me), [true, false]);
  assert.match((await verify()).json.errors.receipt[0], /Not opened yet: receipt-2\.pdf\.$/);
  await openAll(call, admin, id);
  assert.equal((await verify()).status, 200);
  assert.equal((await q(`select status from payments where id = $1`, [entry.id]))[0].status, 'verified');
});

test('an applicant with verified records cannot be permanently deleted; archive instead', async () => {
  const fresh = await applicant('converted');
  assert.equal((await call('DELETE', `/applicants/${fresh}`, { token: admin })).status, 200, 'nothing verified yet: a mistaken entry can go');
  assert.equal((await q(`select count(*)::int n from applicants where id = $1`, [fresh]))[0].n, 0);

  const withRequirement = await applicant('converted');
  const sent = await submit(withRequirement, 'application_form', requirementForm('application_form'));
  await openRequirement(call, admin, withRequirement, 'application_form', sent.json.data.files);
  await accept(withRequirement, 'application_form');
  const refused = await call('DELETE', `/applicants/${withRequirement}`, { token: admin });
  assert.equal(refused.status, 422);
  assert.match(refused.json.errors.applicant[0], /verified records \(1 accepted requirement\)\. Permanent delete would erase that proof, so archive the applicant instead\./);
  assert.equal((await q(`select count(*)::int n from documents where documentable_type = 'App\\Models\\ApplicantRequirement'
    and documentable_id in (select id from applicant_requirements where applicant_id = $1)`, [withRequirement]))[0].n, 1, 'the proof is kept');

  const verifiedLoi = await applicant('payment_submitted', { loi_status: 'complete', loi_verification_status: 'verified' });
  const message = (await call('DELETE', `/applicants/${verifiedLoi}`, { token: admin })).json.errors.applicant[0];
  assert.match(message, /a verified LOI/);

  const attended = await applicant('scheduled', { milestones: JSON.stringify({ orientation_attended: true }) });
  assert.match((await call('DELETE', `/applicants/${attended}`, { token: admin })).json.errors.applicant[0], /an attended activity/);
  assert.equal((await call('POST', `/applicants/${attended}/archive`, { token: admin, body: { reason: 'Duplicate record, kept for history.' } })).status, 200, 'archive still works');
});

test('Government ID: the ID number is required and checked', async () => {
  const id = await applicant('converted');
  const config = (await call('GET', `/applicants/${id}`, { token: sales })).json.data.requirements.config.requirements.find((r: any) => r.key === 'government_id');
  const field = config.fields.find((f: any) => f.key === 'id_number');
  assert.equal(field.required, true);
  assert.equal(field.max_length, 40);
  assert.match((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_number: null }))).json.errors.id_number[0], /ID number is required/);
  assert.match((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_number: 'AB' }))).json.errors.id_number[0], /at least 4/);
  assert.match((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_number: 'N01-<script>' }))).json.errors.id_number[0], /only letters, numbers, spaces and dashes/);
  assert.match((await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_number: 'X'.repeat(41) }))).json.errors.id_number[0], /longer than 40/);
  const ok = await submit(id, 'government_id', requirementForm('government_id', 'qualification', { id_number: ' N01-23-456789 ' }));
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await itemOf(id, 'government_id')).data.id_number, 'N01-23-456789', 'stored trimmed and shown with the requirement');
});
