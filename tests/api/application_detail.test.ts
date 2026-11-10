// Phase 6: the Application Detail reads every page from the database — including the History
// of every action, filterable by stage, with files only for Admin and the assigned Sales user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';
import { completeStage, requirementForm } from '../support/requirements.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
assert.equal((await call('POST', '/users', {
  token: admin, body: { full_name: 'Detail Other Sales', email: 'detail.other@example.test', phone: '09179990006', password: 'Passw0rd!', confirm_password: 'Passw0rd!', role: 'sales' },
})).status, 201);
const otherSales = (await call('POST', '/auth/login', { body: { email: 'detail.other@example.test', password: 'Passw0rd!', portal: 'staff' } })).json.data.token as string;

/** An applicant walked through a few recorded actions. */
let walks = 0;
async function walked() {
  walks += 1;
  const created = await call('POST', '/inquiries', { token: marketing, body: { lead_name: 'Detail Person', first_name: 'Detail', last_name: 'Person', phone: `092112345${String(walks).padStart(2, '0')}`, source: 'facebook', preferred_brand_id: brand.id } });
  await call('POST', `/inquiries/${created.json.data.id}/endorse`, { token: marketing, body: {} });
  const a = (await call('POST', `/inquiries/${created.json.data.id}/convert`, { token: admin, body: { assigned_sales_user_id: salesUser.id } })).json.data;
  await call('POST', `/applicants/${a.id}/requirements/business_background`, { token: sales, form: requirementForm('business_background') });
  await call('POST', `/applicants/${a.id}/requirements/business_background/return`, { token: admin, body: { reason: 'Add the kiosk years.' } });
  await completeStage(call, sales, admin, a.id);
  await call('POST', `/applicants/${a.id}/confirm-qualified`, { token: admin, body: { confirmed: true, remarks: 'All requirements accepted.' } });
  await call('POST', `/applicants/${a.id}/follow-ups`, { token: sales, body: { channel: 'call', outcome: 'reached', notes: 'Explained the next stage.' } });
  return a.id as number;
}

test('the report carries every page: people, requirements, activities, LOI, payment, follow-ups and history', async () => {
  const id = await walked();
  const report = (await call('GET', `/applicants/${id}/report`, { token: admin })).json.data;
  assert.equal(report.applicant.status_label, 'Qualified');
  assert.equal(report.people.assigned_sales.id, salesUser.id);
  assert.equal(report.people.qualified_by.id, adminUser.id);
  assert.equal(report.requirements.summary.qualification.complete, true);
  assert.ok(Array.isArray(report.activity_rows));
  assert.ok('brand_confirmation' in report && 'payment_record' in report);
  assert.equal(report.follow_ups.length, 1);
  assert.equal(typeof report.monitor.days_in_stage, 'number');
  assert.equal(report.files_visible, true);
  // The older fields stay for the exports.
  assert.ok(report.qualification && report.payment && report.approval);
});

test('the History is every action in time order, tagged by page, filterable by stage', async () => {
  const id = await walked();
  const all = (await call('GET', `/applicants/${id}/history`, { token: admin })).json.data;
  assert.ok(all.length >= 8);
  const times = all.map((h: any) => new Date(h.at).getTime());
  assert.deepEqual(times, [...times].sort((x, y) => x - y), 'oldest first');
  const find = (event: string) => all.find((h: any) => h.event === event);
  assert.equal(find('converted').page, 'overview');
  assert.equal(find('sales_assigned').page, 'overview');
  assert.equal(find('requirement_returned').page, 'qualification');
  assert.equal(find('requirement_returned').reason, 'Add the kiosk years.');
  assert.equal(find('requirement_returned').role, 'admin');
  assert.equal(find('follow_up_logged').page, 'overview');
  const qualified = all.find((h: any) => h.from_stage === 'converted' && h.stage === 'qualified');
  assert.equal(qualified.page, 'qualification');
  assert.equal(qualified.action, 'Stage: Converted → Qualified');
  assert.equal(qualified.by, (await q(`select full_name from users where id = $1`, [adminUser.id]))[0].full_name);

  const onlyQualification = (await call('GET', `/applicants/${id}/history?page=qualification`, { token: admin })).json.data;
  assert.ok(onlyQualification.length > 0 && onlyQualification.every((h: any) => h.page === 'qualification'));
  assert.equal((await call('GET', `/applicants/${id}/history?page=nonsense`, { token: admin })).status, 422);
  assert.equal((await call('GET', `/applicants/${id}/history?page=history`, { token: admin })).json.data.length, all.length);
});

test('files only for Admin and the assigned Sales user; Marketing and branch accounts cannot open the report', async () => {
  const id = await walked();
  const mine = (await call('GET', `/applicants/${id}/history`, { token: sales })).json.data;
  assert.ok(mine.find((h: any) => h.event === 'requirement_submitted' && h.step === 'initial_interview').attachments[0].document_id, 'the assigned Sales user sees the file');
  const other = await call('GET', `/applicants/${id}/report`, { token: otherSales });
  assert.equal(other.status, 200, 'every Sales user may read the report');
  assert.equal(other.json.data.files_visible, false);
  assert.equal(other.json.data.requirements.items[0].files, null);
  assert.equal(other.json.data.loi_documents, null);
  assert.deepEqual(other.json.data.history.find((h: any) => h.event === 'requirement_submitted' && h.step === 'initial_interview').attachments[0], { hidden: true });
  assert.equal((await call('GET', `/applicants/${id}/report`, { token: marketing })).status, 403);
  assert.equal((await call('GET', `/applicants/${id}/history`, { token: marketing })).status, 403);
  const branch = await login('franchisee@franchisetitan.local');
  const [own] = await q(`select a.id from applicants a join users u on u.id = a.user_id where u.email = 'franchisee@franchisetitan.local'`);
  assert.equal((await call('GET', `/applicants/${own.id}/report`, { token: branch })).status, 403);
});

test('"prepared and approved by different people" is answered from the record', async () => {
  const id = await walked();
  assert.equal((await call('GET', `/applicants/${id}/report`, { token: admin })).json.data.people.prepared_and_approved_by_different_people, null, 'not approved yet');
  await q(`update applicants set approved_by_user_id = $1, approved_at = now() where id = $2`, [adminUser.id, id]);
  assert.equal((await call('GET', `/applicants/${id}/report`, { token: admin })).json.data.people.prepared_and_approved_by_different_people, true);
});
