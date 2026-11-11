// Overdue alerts (working days) to the role that owns the next step, once per overdue state, and
// the branch's receipt reminder one day after the POD. Branch receipt itself is never overdue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, LOGISTICS, PASSWORD, setup } from '../support/harness.ts';

const { pg, call, login, auth } = await setup();
const admin = await login(ADMIN);
const logistics = await login(LOGISTICS);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const [warehouse] = await q(`select id from franchise_locations where type = 'warehouse' order by id limit 1`);
const [roleRow] = await q(`select id from roles where name = 'franchisee'`);
const uid = await auth.addUser('alerts.branch@test.local', PASSWORD);
const [user] = await q(`insert into users (role_id, full_name, email, account_status, auth_user_id) values ($1, 'Alerts Owner', 'alerts.branch@test.local', 'active', $2::uuid) returning id`, [roleRow.id, uid]);
const [applicant] = await q(`insert into applicants (full_name, status, user_id, preferred_brand_id, application_date) values ('Alerts Owner', 'active_franchisee', $1, $2, '2026-01-01') returning id`, [user.id, brand.id]);
const [franchisee] = await q(`insert into franchisees (applicant_id, user_id, business_name, franchise_status, approval_date) values ($1, $2, 'Alerts Co', 'active', '2026-01-01') returning id`, [applicant.id, user.id]);
const [location] = await q(`insert into franchise_locations (franchisee_id, brand_id, name, type, address, is_active) values ($1, $2, 'Alerts Branch', 'franchise', 'Addr', true) returning id`, [franchisee.id, brand.id]);
const branch = (await call('POST', '/auth/login', { body: { email: 'alerts.branch@test.local', password: PASSWORD, portal: 'branch' } })).json.data.token;
const [product] = await q(`insert into products (brand_id, sku, name, unit) values ($1, 'ALR-1', 'Alert beans', 'kg') returning id`, [brand.id]);
await q(`insert into inventories (location_id, product_id, current_stock, reorder_level, critical_level) values ($1, $2, 100, 1, 0)`, [warehouse.id, product.id]);

const create = async () => (await call('POST', '/supply-requests', { token: branch, body: { location_id: location.id, delivery_address: 'Addr', items: [{ product_id: product.id, quantity_requested: 2 }] } })).json.data;
const notes = async (type: string, id: number) => (await q(`select r.name as role from system_notifications n join users u on u.id = n.user_id join roles r on r.id = u.role_id where n.type = $1 and (n.data ->> 'supply_request_id')::bigint = $2 order by n.id`, [type, id])).map((r) => r.role);
const run = async () => (await call('POST', '/supply-requests/alerts/run', { token: admin })).json.data;

test('Admin is told once when a request waits too long, again only for a new overdue state', async () => {
  const sr = await create();
  assert.equal((await call('POST', '/supply-requests/alerts/run', { token: logistics })).status, 403, 'Admin only');
  assert.equal((await run()).overdue, 0, 'a fresh request is not overdue');
  await q(`update supply_requests set status_changed_at = now() - interval '7 days' where id = $1`, [sr.id]);
  assert.equal((await run()).overdue, 1);
  assert.deepEqual(await notes('supply_request_overdue', sr.id), ['admin']);
  await run();
  assert.deepEqual(await notes('supply_request_overdue', sr.id), ['admin'], 'not repeated');

  // Admin endorses (no longer overdue for Admin); then Logistics sits on it for a week.
  await call('POST', `/supply-requests/${sr.id}/start-review`, { token: admin });
  await call('POST', `/supply-requests/${sr.id}/endorse`, { token: admin });
  await run();
  assert.equal((await q(`select overdue_notified_key from supply_requests where id = $1`, [sr.id]))[0].overdue_notified_key, null, 'cleared once on time');
  await q(`update supply_requests set status_changed_at = now() - interval '7 days' where id = $1`, [sr.id]);
  await run();
  assert.deepEqual(await notes('supply_request_overdue', sr.id), ['admin', 'logistics'], 'now Logistics owns it');
});

test('the branch is reminded once, a day after the POD, and is never "overdue"', async () => {
  const sr = await create();
  await call('POST', `/supply-requests/${sr.id}/start-review`, { token: admin });
  await call('POST', `/supply-requests/${sr.id}/endorse`, { token: admin });
  await call('POST', `/supply-requests/${sr.id}/accept-schedule`, { token: logistics });
  await call('POST', `/supply-requests/${sr.id}/prepare`, { token: logistics });
  const sent = await call('POST', `/supply-requests/${sr.id}/dispatch`, { token: logistics, body: { driver_name: 'Juan Cruz', driver_contact: '09171234567', plate_number: 'ABC 1234', departed_at: new Date(Date.now() - 3600_000).toISOString(), eta_at: new Date().toISOString() } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  const form = new FormData();
  form.set('file', new File(['pod'], 'pod.pdf', { type: 'application/pdf' }));
  form.set('received_by', 'Crew');
  form.set('actual_delivered_at', new Date(Date.now() - 60_000).toISOString());
  assert.equal((await call('POST', `/supply-requests/${sr.id}/pod`, { token: logistics, form })).status, 201);
  assert.equal((await run()).reminders, 0, 'not before a day has passed');
  await q(`update deliveries set pod_encoded_at = now() - interval '25 hours' where supply_request_id = $1`, [sr.id]);
  assert.equal((await run()).reminders, 1);
  assert.deepEqual(await notes('supply_request_receipt_reminder', sr.id), ['franchisee']);
  const [{ title }] = await q(`select title from system_notifications where type = 'supply_request_receipt_reminder'`);
  assert.equal(title, 'Please confirm the delivery you received.');
  await q(`update supply_requests set status_changed_at = now() - interval '30 days' where id = $1`, [sr.id]);
  await run();
  assert.deepEqual(await notes('supply_request_receipt_reminder', sr.id), ['franchisee'], 'once');
  assert.deepEqual(await notes('supply_request_overdue', sr.id), [], 'waiting for the branch is never overdue');
});

test('the lists run the check on their own, at most every 10 minutes', async () => {
  const sr = await create();
  await q(`update supply_requests set status_changed_at = now() - interval '7 days' where id = $1`, [sr.id]);
  await call('GET', '/supply-requests', { token: admin });
  assert.deepEqual(await notes('supply_request_overdue', sr.id), [], 'the forced run a moment ago counts');
  await q(`update supply_job_runs set last_run_at = now() - interval '11 minutes'`);
  await call('GET', '/supply-requests/counts', { token: logistics });
  assert.deepEqual(await notes('supply_request_overdue', sr.id), ['admin']);
  assert.ok((await q(`select last_run_at > now() - interval '1 minute' as fresh from supply_job_runs`))[0].fresh);
});
