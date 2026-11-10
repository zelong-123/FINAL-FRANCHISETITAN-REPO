// Phase 5: monitoring — follow-up log, days in stage / Overdue, due reminders, date filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brandA, brandB] = await q(`select id from brands order by id limit 2`);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

assert.equal((await call('POST', '/users', {
  token: admin, body: { full_name: 'Mon Other Sales', email: 'mon.other@example.test', phone: '09179990005', password: 'Passw0rd!', confirm_password: 'Passw0rd!', role: 'sales' },
})).status, 201);
const otherSales = (await call('POST', '/auth/login', { body: { email: 'mon.other@example.test', password: 'Passw0rd!', portal: 'staff' } })).json.data.token as string;

let phoneSeq = 0;
const lead = (name: string) => ({ lead_name: name, first_name: name, last_name: 'Mon', phone: `0920${String(1000000 + (phoneSeq += 1)).slice(1)}`, source: 'facebook', preferred_brand_id: brandA.id });
const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const followUp = (extra: any = {}) => ({ contacted_at: ago(0.01), channel: 'call', outcome: 'reached', notes: 'Talked about the franchise packages.', ...extra });
let n = 0;
async function applicant(status = 'converted', extra: Record<string, unknown> = {}) {
  n += 1;
  const cols = { full_name: `Mon Person ${n}`, status, application_date: '2026-05-01', assigned_sales_user_id: salesUser.id, preferred_brand_id: brandA.id, ...extra };
  const keys = Object.keys(cols);
  const [a] = await q(`insert into applicants (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, Object.values(cols));
  return a.id as number;
}
const notifications = async (token: string, type: string) => ((await call('GET', '/notifications?per_page=100', { token })).json.data as any[]).filter((x) => x.type === type);

test('inquiry follow-ups: Marketing logs them, the first one marks the inquiry Contacted, rules are checked', async () => {
  const created = await call('POST', '/inquiries', { token: marketing, body: lead('Follow Lead') });
  const id = created.json.data.id;
  const path = `/inquiries/${id}/follow-ups`;
  assert.equal((await call('POST', path, { token: admin, body: followUp() })).status, 403);
  assert.ok((await call('POST', path, { token: marketing, body: followUp({ notes: 'ok' }) })).json.errors.notes);
  assert.ok((await call('POST', path, { token: marketing, body: followUp({ contacted_at: new Date(Date.now() + 86400000).toISOString() }) })).json.errors.contacted_at, 'not in the future');
  assert.ok((await call('POST', path, { token: marketing, body: followUp({ outcome: 'rescheduled' }) })).json.errors.next_follow_up_at, 'rescheduled needs a next date');
  assert.ok((await call('POST', path, { token: marketing, body: followUp({ next_follow_up_at: ago(1) }) })).json.errors.next_follow_up_at, 'the next date is after this one');
  assert.ok((await call('POST', path, { token: marketing, body: followUp({ channel: 'carrier_pigeon' }) })).json.errors.channel);

  const first = await call('POST', path, { token: marketing, body: followUp({ outcome: 'no_answer', next_follow_up_at: new Date(Date.now() + 2 * 86400000).toISOString() }) });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.data.inquiry.status, 'contacted');
  const second = await call('POST', path, { token: marketing, body: followUp() });
  assert.equal(second.json.data.follow_ups.length, 2);
  assert.equal(second.json.data.follow_ups[0].actor_role, 'marketing');
  const [log] = await q(`select * from audit_logs where action = 'inquiry.contacted' and auditable_id = $1`, [id]);
  assert.equal(log.old_values.status, 'new');
  assert.equal((await call('GET', `/inquiries/${id}`, { token: marketing })).json.data.follow_ups.length, 2);
  await assert.rejects(() => q(`update follow_ups set notes = 'edited' where followable_id = $1`, [id]), /append-only/);
});

test('applicant follow-ups: only the assigned Sales user, recorded in the applicant history', async () => {
  const id = await applicant();
  const path = `/applicants/${id}/follow-ups`;
  assert.equal((await call('POST', path, { token: otherSales, body: followUp() })).status, 403);
  assert.equal((await call('POST', path, { token: admin, body: followUp() })).status, 403);
  const saved = await call('POST', path, { token: sales, body: followUp({ channel: 'viber', outcome: 'rescheduled', next_follow_up_at: new Date(Date.now() + 86400000).toISOString() }) });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  const [log] = await q(`select * from applicant_stage_histories where applicant_id = $1 and event = 'follow_up_logged'`, [id]);
  assert.equal(log.actor_role, 'sales');
  assert.equal(log.new_values.outcome, 'rescheduled');
  assert.equal((await call('GET', `/applicants/${id}`, { token: admin })).json.data.follow_ups.length, 1);
});

test('days in the current stage and the Overdue badge (7 days by default)', async () => {
  const old = await applicant('converted');
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_at, event) values ($1, null, 'converted', now() - interval '10 days', 'converted')`, [old]);
  const fresh = await applicant('converted');
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_at, event) values ($1, null, 'converted', now() - interval '3 days', 'converted')`, [fresh]);
  const rows = (await call('GET', '/applicants?per_page=100', { token: admin })).json.data;
  const a = rows.find((r: any) => r.id === old);
  const b = rows.find((r: any) => r.id === fresh);
  assert.equal(a.days_in_stage, 10);
  assert.equal(a.overdue, true);
  assert.equal(a.overdue_after_days, 7);
  assert.equal(b.days_in_stage, 3);
  assert.equal(b.overdue, false);
  // A stage history entry for an earlier stage does not count: only entering the current one.
  await q(`update applicants set status = 'qualified' where id = $1`, [old]);
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_at) values ($1, 'converted', 'qualified', now() - interval '1 day')`, [old]);
  assert.equal((await call('GET', '/applicants?per_page=100', { token: admin })).json.data.find((r: any) => r.id === old).days_in_stage, 1);

  const inquiry = await call('POST', '/inquiries', { token: marketing, body: lead('Stale Lead') });
  await q(`update franchise_inquiries set status_changed_at = now() - interval '9 days' where id = $1`, [inquiry.json.data.id]);
  const listed = (await call('GET', '/inquiries?per_page=100', { token: marketing })).json.data.find((r: any) => r.id === inquiry.json.data.id);
  assert.equal(listed.days_in_status, 9);
  assert.equal(listed.overdue, true);
});

test('a due follow-up reminds the responsible user once, when notifications or lists load', async () => {
  // Inquiry: the Marketing user who logged it.
  const inquiry = (await call('POST', '/inquiries', { token: marketing, body: lead('Due Lead') })).json.data;
  await call('POST', `/inquiries/${inquiry.id}/follow-ups`, { token: marketing, body: followUp({ contacted_at: ago(3), next_follow_up_at: ago(1) }) });
  const first = await notifications(marketing, 'follow_up_due');
  assert.equal(first.filter((x) => Number(x.data?.inquiry_id) === inquiry.id).length, 1);
  await call('GET', '/inquiries', { token: marketing });
  assert.equal((await notifications(marketing, 'follow_up_due')).filter((x) => Number(x.data?.inquiry_id) === inquiry.id).length, 1, 'never twice');

  // A newer follow-up replaces the old due date.
  const superseded = (await call('POST', '/inquiries', { token: marketing, body: lead('Superseded Lead') })).json.data;
  await call('POST', `/inquiries/${superseded.id}/follow-ups`, { token: marketing, body: followUp({ contacted_at: ago(5), next_follow_up_at: ago(2) }) });
  await call('POST', `/inquiries/${superseded.id}/follow-ups`, { token: marketing, body: followUp({ contacted_at: ago(1), next_follow_up_at: new Date(Date.now() + 5 * 86400000).toISOString() }) });
  assert.equal((await notifications(marketing, 'follow_up_due')).filter((x) => Number(x.data?.inquiry_id) === superseded.id).length, 0);

  // Applicant: the assigned Sales user, reminded when the applicant list loads.
  const id = await applicant();
  await call('POST', `/applicants/${id}/follow-ups`, { token: sales, body: followUp({ contacted_at: ago(4), next_follow_up_at: ago(1) }) });
  await call('GET', '/applicants', { token: otherSales });
  assert.equal((await notifications(otherSales, 'follow_up_due')).filter((x) => Number(x.data?.applicant_id) === id).length, 0, 'not another Sales user');
  await call('GET', '/applicants', { token: sales });
  const [reminder] = await q(`select * from system_notifications where type = 'follow_up_due' and (data->>'applicant_id')::bigint = $1`, [id]);
  assert.equal(Number(reminder.user_id), salesUser.id);
  assert.equal((await q(`select count(*)::int c from follow_up_reminders r join follow_ups f on f.id = r.follow_up_id where f.followable_id = $1 and f.followable_type = 'applicant'`, [id]))[0].c, 1);
});

test('date range filters run on the server, on any date basis, and page correctly', async () => {
  const ids: number[] = [];
  for (const day of ['2025-03-01', '2025-03-10', '2025-03-20', '2025-04-05']) ids.push(await applicant('converted', { application_date: day }));
  const page1 = await call('GET', '/applicants?from=2025-03-01&to=2025-03-31&date_basis=applied&per_page=2&page=1', { token: admin });
  assert.equal(page1.json.meta.total, 3, 'the three March applicants');
  assert.equal(page1.json.data.length, 2);
  const page2 = await call('GET', '/applicants?from=2025-03-01&to=2025-03-31&date_basis=applied&per_page=2&page=2', { token: admin });
  assert.equal(page2.json.data.length, 1);
  assert.deepEqual([...page1.json.data, ...page2.json.data].map((r: any) => r.id).sort(), ids.slice(0, 3).sort());
  assert.equal((await call('GET', '/applicants?from=2025-03-15&to=2025-03-01', { token: admin })).status, 422, 'To before From');
  assert.equal((await call('GET', '/applicants?from=03/01/2025', { token: admin })).status, 422);
  assert.equal((await call('GET', '/applicants?date_basis=birthday', { token: admin })).status, 422);
  // Brand and assigned Sales combine with the range.
  await q(`update applicants set preferred_brand_id = $1, assigned_sales_user_id = null where id = $2`, [brandB.id, ids[1]]);
  assert.deepEqual((await call('GET', `/applicants?from=2025-03-01&to=2025-03-31&brand_id=${brandB.id}`, { token: admin })).json.data.map((r: any) => r.id), [ids[1]]);
  assert.deepEqual((await call('GET', '/applicants?from=2025-03-01&to=2025-03-31&assigned_sales_user_id=unassigned', { token: admin })).json.data.map((r: any) => r.id), [ids[1]]);

  // Approved / Rejected / Last Updated bases (Application Detail folders).
  const approved = await applicant('approved', { application_date: '2025-01-01', approved_at: '2025-06-15T03:00:00Z' });
  const rejected = await applicant('rejected', { application_date: '2025-01-01', rejected_at: '2025-06-20T03:00:00Z' });
  const approvedRows = (await call('GET', '/applicants/application-detail?folder=approved&from=2025-06-01&to=2025-06-30&date_basis=approved', { token: admin })).json;
  assert.ok(approvedRows.data.some((r: any) => r.id === approved));
  assert.equal(approvedRows.meta.folder_counts.approved, approvedRows.meta.total);
  assert.equal((await call('GET', '/applicants/application-detail?folder=approved&from=2025-07-01&date_basis=approved', { token: admin })).json.data.some((r: any) => r.id === approved), false);
  assert.ok((await call('GET', '/applicants/application-detail?folder=rejected&from=2025-06-01&to=2025-06-30&date_basis=rejected', { token: admin })).json.data.some((r: any) => r.id === rejected));
  assert.ok((await call('GET', `/applicants/application-detail?folder=active&date_basis=updated&from=${new Date().toISOString().slice(0, 10)}`, { token: admin })).json.data.some((r: any) => ids.includes(r.id)));

  // Inquiries: From / To by inquiry date, with the existing filters and pagination.
  for (const day of ['2025-02-01', '2025-02-15']) {
    const made = await call('POST', '/inquiries', { token: marketing, body: { ...lead(`Feb Lead ${day}`), inquiry_date: day } });
    assert.equal(made.status, 201);
  }
  const feb = await call('GET', '/inquiries?from=2025-02-01&to=2025-02-28&per_page=1', { token: marketing });
  assert.equal(feb.json.meta.total, 2);
  assert.equal(feb.json.data.length, 1);
  assert.equal((await call('GET', '/inquiries?from=2025-02-28&to=2025-02-01', { token: marketing })).status, 422);
});
