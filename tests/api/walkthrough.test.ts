// Phase 7: one applicant from inquiry to Active Franchisee, with at least one FAILED attempt per
// stage (each must be blocked with a clear message), the role checks, the branch side and the
// dashboards. Schedule times are moved only by changing rows in this local test database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { requirementForm } from '../support/requirements.ts';
import { requirementsOf } from '../../supabase/functions/api/services/requirements.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const firstSales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id, name from brands order by id limit 1`);
const [firstSalesUser] = await q(`select id from users where email = $1`, [SALES]);
assert.equal((await call('POST', '/users', {
  token: admin, body: { full_name: 'Walk Sales Two', email: 'walk.sales2@example.test', phone: '09179990007', password: 'Passw0rd!', confirm_password: 'Passw0rd!', role: 'sales' },
})).status, 201);
const sales = (await call('POST', '/auth/login', { body: { email: 'walk.sales2@example.test', password: 'Passw0rd!', portal: 'staff' } })).json.data.token as string;
const [salesUser] = await q(`select id from users where email = 'walk.sales2@example.test'`);

/** Every refused attempt, with the message the user sees (printed at the end for the report). */
const refusals: string[] = [];
function blocked(label: string, res: { status: number; json: any }, status = 422) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.json)}`);
  const message = Object.values(res.json?.errors ?? {}).flat()[0] ?? res.json?.message;
  assert.ok(message, `${label}: a clear message`);
  refusals.push(`${label} -> ${status}: ${message}`);
}
const okay = (label: string, res: { status: number; json: any }, status = 200) => {
  assert.equal(res.status, status, `${label}: ${JSON.stringify(res.json)}`);
  return res.json;
};
const PDF = new TextEncoder().encode('%PDF-1.4 SAMPLE - NOT A REAL DOCUMENT');
const pdf = (name: string) => new File([PDF], name, { type: 'application/pdf' });
const past = (activityId: number) => q(`update activity_schedules set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [activityId]);
let day = 30;
function slot() {
  day += 1;
  const d = new Date();
  let left = day;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1; }
  return `${d.toISOString().slice(0, 10)}T09:00:00+08:00`;
}
function completion() {
  const f = new FormData();
  f.set('attended', 'yes');
  f.set('actual_started_at', new Date(Date.now() - 3600_000).toISOString());
  f.set('handler_name', 'Walk Sales Two');
  f.set('result_notes', 'Applicant attended the whole session.');
  f.set('proof', pdf('sample-attendance-sheet.pdf'));
  return f;
}
// Archived records included: becoming an Active Franchisee archives the source lead.
const overview = async (token: string, archived = false) => okay('overview', await call('GET', `/analytics/overview${archived ? '?include_archived=1' : ''}`, { token })).data.kpis;

test('one applicant from inquiry to Active Franchisee — every wrong step is blocked with a clear message', async () => {
  const before = await overview(admin, true);

  // ---- Inquiry (Marketing) ----
  const lead = { lead_name: 'Demo Applicant', first_name: 'Demo', last_name: 'Applicant', phone: '09170000101', email: 'demo.applicant@example.test', source: 'facebook', preferred_brand_id: brand.id };
  const inquiry = okay('create inquiry', await call('POST', '/inquiries', { token: marketing, body: lead }), 201).data;
  blocked('duplicate phone without a reason', await call('POST', '/inquiries', { token: marketing, body: { ...lead, first_name: 'Demo2' } }), 409);
  blocked('follow-up with too-short notes', await call('POST', `/inquiries/${inquiry.id}/follow-ups`, { token: marketing, body: { channel: 'call', outcome: 'reached', notes: 'ok' } }));
  assert.equal(okay('follow-up', await call('POST', `/inquiries/${inquiry.id}/follow-ups`, { token: marketing, body: { channel: 'call', outcome: 'reached', notes: 'Sent the brochure and price list.' } }), 201).data.inquiry.status, 'contacted');
  okay('endorse', await call('POST', `/inquiries/${inquiry.id}/endorse`, { token: marketing, body: {} }));

  // ---- Conversion (Admin) ----
  blocked('convert without a Sales user', await call('POST', `/inquiries/${inquiry.id}/convert`, { token: admin, body: {} }));
  const applicant = okay('convert', await call('POST', `/inquiries/${inquiry.id}/convert`, { token: admin, body: { assigned_sales_user_id: firstSalesUser.id } }), 201).data;
  const id = applicant.id;
  const path = `/applicants/${id}`;

  // ---- Role checks and reassignment ----
  blocked('a Sales user who is not assigned submits a requirement', await call('POST', `${path}/requirements/application_form`, { token: sales, form: requirementForm('application_form') }), 403);
  blocked('Marketing opens the Application Detail report', await call('GET', `${path}/report`, { token: marketing }), 403);
  blocked('reassign without a reason', await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: salesUser.id } }));
  okay('reassign with a reason', await call('POST', `${path}/assign-sales`, { token: admin, body: { assigned_sales_user_id: salesUser.id, reason: 'First Sales user moved to another territory.' } }));
  blocked('the previous Sales user acts after the reassignment', await call('POST', `${path}/requirements/application_form`, { token: firstSales, form: requirementForm('application_form') }), 403);

  // ---- Qualification (requirements) ----
  blocked('Admin uploads proof for Sales', await call('POST', `${path}/requirements/application_form`, { token: admin, form: requirementForm('application_form') }), 403);
  blocked('a requirement without its file', await call('POST', `${path}/requirements/initial_interview`, { token: sales, form: requirementForm('initial_interview', 'qualification', { interview_sheet: null }) }));
  blocked('Confirm Qualified while requirements are missing', await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'Trying too early.' } }));
  okay('submit the interview', await call('POST', `${path}/requirements/initial_interview`, { token: sales, form: requirementForm('initial_interview') }), 201);
  blocked('Sales accepts its own submission', await call('POST', `${path}/requirements/initial_interview/accept`, { token: sales, body: {} }), 403);
  blocked('Return without a reason', await call('POST', `${path}/requirements/initial_interview/return`, { token: admin, body: {} }));
  okay('Return with a reason', await call('POST', `${path}/requirements/initial_interview/return`, { token: admin, body: { reason: 'The interview sheet is not signed.' } }));
  const returnAlert = await q(`select user_id, message from system_notifications where type = 'requirement_returned' and (data->>'applicant_id')::bigint = $1`, [id]);
  assert.deepEqual(returnAlert.map((r) => Number(r.user_id)), [salesUser.id], 'the NEW Sales user receives the alert');
  for (const def of requirementsOf('qualification')) {
    okay(`submit ${def.key}`, await call('POST', `${path}/requirements/${def.key}`, { token: sales, form: requirementForm(def.key) }), 201);
    okay(`accept ${def.key}`, await call('POST', `${path}/requirements/${def.key}/accept`, { token: admin, body: {} }));
  }
  blocked('Confirm Qualified without remarks', await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true } }));
  okay('Confirm Qualified', await call('POST', `${path}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'All six requirements accepted.' } }));
  okay('Set Schedule', await call('POST', `${path}/set-schedule`, { token: admin, body: {} }));

  // ---- Scheduled Activities ----
  const book = async (type: string, title: string) => okay(`book ${type}`, await call('POST', '/activities', { token: admin, body: { applicant_id: id, activity_type: type, title, starts_at: slot(), duration_minutes: 60, venue: 'Virtual' } }), 201).data.id;
  const orientation = await book('orientation', 'Orientation');
  blocked('Complete before the scheduled start', await call('POST', `/activities/${orientation}/complete`, { token: sales, form: completion() }));
  await past(orientation);
  const noProof = completion();
  noProof.delete('proof');
  blocked('Complete without attendance proof', await call('POST', `/activities/${orientation}/complete`, { token: sales, form: noProof }));
  okay('Complete orientation', await call('POST', `/activities/${orientation}/complete`, { token: sales, form: completion() }));
  blocked('Sales marks its own completion Attended', await call('POST', `/activities/${orientation}/attended`, { token: sales }), 403);
  okay('Attended orientation', await call('POST', `/activities/${orientation}/attended`, { token: admin }));
  blocked('Brand Confirmation before Product Tasting is done', await call('POST', `${path}/brand-confirmation`, { token: sales, body: { final_brand_id: brand.id, confirmation_method: 'in_person', confirmed_on: '2026-11-01', notes: 'Too early.' } }));
  const tasting = await book('product_tasting', 'Product Tasting');
  await past(tasting);
  okay('Complete tasting', await call('POST', `/activities/${tasting}/complete`, { token: sales, form: completion() }));
  okay('Attended tasting', await call('POST', `/activities/${tasting}/attended`, { token: admin }));
  blocked('Training before the brand is confirmed', await call('POST', '/activities', { token: admin, body: { applicant_id: id, activity_type: 'training', title: 'Training', starts_at: slot(), duration_minutes: 60, venue: 'Virtual' } }));
  const brandBody = { final_brand_id: brand.id, confirmation_method: 'in_person', confirmed_on: new Date().toISOString().slice(0, 10), notes: 'Confirmed in person after the tasting.' };
  blocked('Admin submits the Brand Confirmation for Sales', await call('POST', `${path}/brand-confirmation`, { token: admin, body: brandBody }), 403);
  okay('Sales submits the final brand', await call('POST', `${path}/brand-confirmation`, { token: sales, body: brandBody }), 201);
  blocked('Sales confirms the brand', await call('POST', `${path}/brand-confirmation/confirm`, { token: sales, body: { confirmed: true } }), 403);
  okay('Admin confirms the brand', await call('POST', `${path}/brand-confirmation/confirm`, { token: admin, body: { confirmed: true } }));
  blocked('change a locked brand', await call('PUT', path, { token: admin, body: { preferred_brand_id: brand.id + 1 } }));
  const training = await book('training', 'Training');
  await past(training);
  okay('Complete training', await call('POST', `/activities/${training}/complete`, { token: sales, form: completion() }));
  okay('Attended training', await call('POST', `/activities/${training}/attended`, { token: admin }));

  // ---- LOI ----
  blocked('Confirm LOI without remarks', await call('PATCH', `${path}/status`, { token: admin, body: { status: 'loi_submitted' } }));
  okay('Confirm LOI', await call('PATCH', `${path}/status`, { token: admin, body: { status: 'loi_submitted', remarks: 'Signed LOI received at the office.' } }));
  blocked('Complete the LOI without a scan', await call('POST', `${path}/loi/complete`, { token: admin, body: {} }));
  const verify = () => { const f = new FormData(); f.set('verification_status', 'verified'); return f; };
  const selfVerify = new FormData();
  selfVerify.set('verification_status', 'verified');
  blocked('Sales verifies the LOI', await call('POST', `${path}/loi`, { token: sales, form: selfVerify }), 403);
  const scan = new FormData();
  scan.set('file', pdf('sample-loi.pdf'));
  scan.set('submission_type', 'physical');
  scan.set('submission_date', new Date().toISOString().slice(0, 10));
  okay('Sales uploads the scan', await call('POST', `${path}/loi`, { token: sales, form: scan }), 201);
  okay('Admin verifies', await call('POST', `${path}/loi`, { token: admin, form: verify() }));
  assert.equal(okay('Complete LOI', await call('POST', `${path}/loi/complete`, { token: admin, body: { remarks: 'LOI verified.' } })).data.status, 'payment_submitted');

  // ---- Payment Record ----
  const entry = (amount: number, or: string, withReceipt = true) => {
    const f = new FormData();
    f.set('payment_date', new Date().toISOString().slice(0, 10));
    f.set('amount', String(amount));
    f.set('payment_method', 'bank_transfer');
    f.set('or_number', or);
    f.set('reference_number', `BT-${or}`);
    if (withReceipt) f.set('receipt', pdf('sample-receipt.pdf'));
    return f;
  };
  blocked('record a payment before the Agreed Package Amount', await call('POST', `${path}/payment-entries`, { token: sales, form: entry(1000, 'OR-W-0') }));
  okay('Agreed Package Amount', await call('PATCH', `${path}/payment-plan`, { token: admin, body: { agreed_amount: 50000, package_name: 'Kiosk package', source: 'Signed LOI' } }));
  blocked('a payment without a receipt', await call('POST', `${path}/payment-entries`, { token: sales, form: entry(20000, 'OR-W-1', false) }));
  blocked('more than the Agreed Package Amount', await call('POST', `${path}/payment-entries`, { token: sales, form: entry(60000, 'OR-W-1') }));
  const first = okay('first payment', await call('POST', `${path}/payment-entries`, { token: sales, form: entry(20000, 'OR-W-1') }), 201).data.entry;
  blocked('the same OR number again', await call('POST', `${path}/payment-entries`, { token: sales, form: entry(10000, 'OR-W-1') }));
  blocked('Sales verifies its own payment', await call('POST', `${path}/payment-entries/${first.id}/verify`, { token: sales, body: {} }), 403);
  okay('verify first', await call('POST', `${path}/payment-entries/${first.id}/verify`, { token: admin, body: {} }));
  blocked('COMPLETED before Fully Paid', await call('POST', `${path}/payments/complete`, { token: admin, body: {} }));
  blocked('edit a submitted payment', await call('PATCH', `${path}/payments/${first.id}`, { token: sales, body: { amount: 1 } }));
  const second = okay('second payment', await call('POST', `${path}/payment-entries`, { token: sales, form: entry(30000, 'OR-W-2') }), 201).data.entry;
  okay('verify second', await call('POST', `${path}/payment-entries/${second.id}/verify`, { token: admin, body: {} }));
  const paidAlerts = await q(`select user_id from system_notifications where type = 'payment_fully_paid' and (data->>'applicant_id')::bigint = $1`, [id]);
  assert.ok(paidAlerts.some((r) => Number(r.user_id) === salesUser.id), 'Fully Paid reaches the (new) assigned Sales user');
  assert.equal(okay('COMPLETED', await call('POST', `${path}/payments/complete`, { token: admin, body: {} })).data.status, 'for_approval');

  // ---- Approval ----
  blocked('Reject without a reason', await call('PATCH', `${path}/status`, { token: admin, body: { status: 'rejected' } }));
  blocked('Approve before the review', await call('POST', `${path}/approve`, { token: admin, body: {} }));
  okay('Review', await call('POST', `${path}/review`, { token: admin, body: { remarks: 'Every stage checked.' } }));
  okay('Approve', await call('POST', `${path}/approve`, { token: admin, body: { remarks: 'Approved by Admin.' } }));

  // ---- Activation and the branch side ----
  blocked('activation without the signed agreement', await call('POST', `${path}/activate`, { token: admin, body: {} }));
  const agreement = new FormData();
  agreement.set('agreement', pdf('sample-franchise-agreement.pdf'));
  okay('submit the agreement', await call('POST', `${path}/requirements/franchise_agreement`, { token: sales, form: agreement }), 201);
  okay('accept the agreement', await call('POST', `${path}/requirements/franchise_agreement/accept`, { token: admin, body: {} }));
  okay('branch account', await call('POST', `${path}/portal-user`, { token: admin, body: { email: 'demo.branch@example.test', phone: '09170000102', password: 'Passw0rd!', confirm_password: 'Passw0rd!' } }), 201);
  assert.equal((await q(`select status from applicants where id = $1`, [id]))[0].status, 'active_franchisee');
  const [location] = await q(`select l.id, l.name from franchise_locations l join franchisees f on f.id = l.franchisee_id where f.applicant_id = $1`, [id]);
  assert.ok(location, 'the branch is created');
  blocked('the branch account signs in to the staff portal', await call('POST', '/auth/login', { body: { email: 'demo.branch@example.test', password: 'Passw0rd!', portal: 'staff' } }), 403);
  const branchLogin = okay('branch portal sign-in', await call('POST', '/auth/login', { body: { email: 'demo.branch@example.test', password: 'Passw0rd!', portal: 'branch' } }));
  const branchContext = okay('branch workspace', await call('GET', '/branch/context', { token: branchLogin.data.token })).data;
  assert.equal(Number(branchContext.location.id), Number(location.id), 'the new franchisee opens their own branch');

  // ---- The Application Detail tells the whole story ----
  const report = okay('Application Detail', await call('GET', `${path}/report`, { token: admin })).data;
  assert.equal(report.applicant.status, 'active_franchisee');
  assert.equal(report.people.prepared_and_approved_by_different_people, true);
  for (const page of ['overview', 'qualification', 'activities', 'loi', 'payment', 'approval']) {
    assert.ok(report.history.some((h: any) => h.page === page), `History has actions on the ${page} page`);
  }

  // ---- Dashboards load and the counts move as expected ----
  const after = await overview(admin, true);
  assert.equal(after.total_inquiries, before.total_inquiries + 1, 'one more inquiry');
  assert.equal(after.converted_inquiries, before.converted_inquiries + 1, 'one more converted inquiry');
  assert.equal(after.active_franchise_locations, before.active_franchise_locations + 1, 'one more active branch');
  for (const token of [marketing, sales]) assert.ok(await overview(token));
  for (const token of [admin, sales]) okay('franchising dashboard', await call('GET', '/analytics/franchising-dashboard?period=month', { token }));

  console.log(`\nBLOCKED ATTEMPTS (${refusals.length}):\n${refusals.map((r, i) => `${String(i + 1).padStart(2)}. ${r}`).join('\n')}`);
  console.log(`DASHBOARD admin before -> after: inquiries ${before.total_inquiries} -> ${after.total_inquiries}, converted ${before.converted_inquiries} -> ${after.converted_inquiries}, active branches ${before.active_franchise_locations} -> ${after.active_franchise_locations}`);
});
