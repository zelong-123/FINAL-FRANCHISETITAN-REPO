// Smart scheduling: handler availability (any activity + the 1-hour gap), capacity per session,
// facility limits, the Training brand, business hours 9:00–5:00, the calendar picker data, the
// Sessions panel (Join this session) and the Master Schedule counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';
import { createStaff } from '../support/accounts.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brandA, brandB] = await q(`select id, name from brands order by id limit 2`);
const [salesUser] = await q(`select id, full_name from users where email = $1`, [SALES]);
await createStaff(call, admin, { full_name: 'Smart Sales Two', email: 'smart.sales2@example.test', phone: '09179990031', role: 'sales' });
const [otherUser] = await q(`select id from users where email = 'smart.sales2@example.test'`);

/** The N-th weekday from today at a Manila time (different offsets never share a day). */
function slot(days: number, hour: string): string {
  const d = new Date();
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1;
  }
  return `${d.toISOString().slice(0, 10)}T${hour}:00+08:00`;
}
const plusHours = (iso: string, hours: number) => iso.replace(/T(\d{2})/, (_m, h) => `T${String(Number(h) + hours).padStart(2, '0')}`);

let counter = 0;
async function applicant(brandId = brandA.id, owner = salesUser.id) {
  counter += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, preferred_brand_id, application_date, assigned_sales_user_id) values ($1, 'scheduled', $2, '2026-01-01', $3) returning id`,
    [`Smart ${counter}`, brandId, owner],
  );
  return a.id as number;
}
/** A session row written straight to the table (another Sales user's load, a facility in use, …). */
async function rawSession(type: string, start: string, hours: number, handlerId: number | null, brandId: number | null = null, status = 'confirmed', capacity = 5) {
  const [s] = await q(
    `insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity, handler_id, brand_id) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [type, start, plusHours(start, hours), status, capacity, handlerId, brandId],
  );
  return s.id as number;
}
async function seat(sessionId: number, applicantId: number) {
  await q(`insert into schedule_session_participants (session_id, applicant_id, attendance_status) values ($1, $2, 'scheduled')`, [sessionId, applicantId]);
}
const evaluate = async (body: any) => (await call('POST', '/schedule-sessions/evaluate', { token: admin, body })).json.data;
const reasons = (e: any) => e.reasons.join(' | ');
const ot = (ids: number[], start: string, hours = 2, extra: any = {}) => ({ activity_type: 'orientation', start_at: start, end_at: plusHours(start, hours), applicant_ids: ids, handler_id: salesUser.id, ...extra });

test('handler availability: no overlap of ANY activity and the 1-hour gap, with the next free start', async () => {
  const start = slot(5, '09:00');
  await rawSession('training', start, 2, salesUser.id, brandA.id, 'confirmed', 1);
  const day = start.slice(0, 10);
  const overlapping = await evaluate(ot([await applicant()], `${day}T10:00:00+08:00`));
  assert.equal(overlapping.status, 'blocked', 'a Training of the same Sales user blocks an Orientation/Tasting');
  assert.match(reasons(overlapping), /Sales User already has Training 9:00–11:00 AM on [A-Z][a-z]{2} \d{1,2}\. Next free start: 12:00 PM \(1-hour gap\)\./);
  const touching = await evaluate(ot([await applicant()], `${day}T11:00:00+08:00`));
  assert.match(reasons(touching), /Next free start: 12:00 PM \(1-hour gap\)/, 'back-to-back is refused: the gap is 1 hour');
  const gapOk = await evaluate(ot([await applicant()], `${day}T12:00:00+08:00`));
  assert.doesNotMatch(reasons(gapOk), /already has/, 'one hour after the end is free');
  // Another Sales user is not affected by this Sales user's sessions.
  const other = await evaluate(ot([await applicant(brandA.id, otherUser.id)], `${day}T10:00:00+08:00`, 2, { handler_id: otherUser.id }));
  assert.doesNotMatch(reasons(other), /already has/);
});

test('business hours: start at 9:00 or later and end by 5:00 PM; the last start depends on the duration', async () => {
  const day = slot(6, '09:00').slice(0, 10);
  const late = await evaluate(ot([await applicant()], `${day}T15:30:00+08:00`));
  assert.match(reasons(late), /Sessions must end by 5:00 PM: a 2-hour Orientation\/Tasting can start at 3:00 PM at the latest\./);
  assert.doesNotMatch(reasons(await evaluate(ot([await applicant()], `${day}T15:00:00+08:00`))), /must end by/);
  const training = await evaluate({ activity_type: 'training', brand_id: brandA.id, start_at: `${day}T15:00:00+08:00`, end_at: `${day}T18:00:00+08:00`, applicant_ids: [await applicant()], handler_id: salesUser.id });
  assert.match(reasons(training), /a 3-hour Training can start at 2:00 PM at the latest/);
  const config = (await call('GET', '/schedule-sessions/config', { token: sales })).json.data;
  assert.equal(config.closes_at, '17:00');
  assert.equal(config.last_start, '16:00');
});

test('capacity: Orientation/Tasting 5 per session, Training 1 per session', async () => {
  const start = slot(7, '09:00');
  const five = [];
  for (let i = 0; i < 5; i += 1) five.push(await applicant());
  const created = await call('POST', '/schedule-sessions', { token: admin, body: ot(five, start) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.session.occupancy, '5/5 · Full');
  const sixth = await call('POST', `/schedule-sessions/${created.json.data.session.id}/participants`, { token: admin, body: { applicant_id: await applicant() } });
  assert.equal(sixth.status, 422);
  assert.match(JSON.stringify(sixth.json.errors), /This session is full \(5\/5\)\./);

  const trainingDay = slot(7, '13:00');
  const t = await rawSession('training', trainingDay, 3, salesUser.id, brandA.id, 'confirmed', 10);
  await seat(t, await applicant());
  const second = await call('POST', `/schedule-sessions/${t}/participants`, { token: admin, body: { applicant_id: await applicant() } });
  assert.equal(second.status, 422);
  assert.match(JSON.stringify(second.json.errors), /This session is full \(1\/1\)\./, 'an older Training stored with 10 seats now takes 1');
  const two = await evaluate({ activity_type: 'training', brand_id: brandA.id, start_at: slot(8, '09:00'), end_at: slot(8, '12:00'), applicant_ids: [await applicant(), await applicant()], handler_id: salesUser.id });
  assert.match(reasons(two), /Training takes 1 applicant per session \(2 selected\)/);
});

test('facility limits: the 6th Orientation/Tasting and the 3rd Training at the same time are refused; 2 Trainings by different Sales users are allowed', async () => {
  const start = slot(9, '10:00');
  for (let i = 0; i < 5; i += 1) await rawSession('orientation', start, 2, null);
  const sixth = await evaluate(ot([await applicant()], start));
  assert.match(reasons(sixth), /All 5 Orientation\/Tasting facilities are in use 10:00 AM–12:00 PM on [A-Z][a-z]{2} \d{1,2}\./);
  const refused = await call('POST', '/schedule-sessions', { token: admin, body: ot([await applicant()], start) });
  assert.equal(refused.status, 422);
  // Partly overlapping: only the busy part is named.
  const partly = await evaluate(ot([await applicant()], plusHours(start, 1), 2));
  assert.match(reasons(partly), /in use 11:00 AM–12:00 PM/);

  const tStart = slot(9, '13:00');
  await rawSession('training', tStart, 2, otherUser.id, brandA.id, 'confirmed', 1);
  const secondTraining = { activity_type: 'training', brand_id: brandA.id, start_at: tStart, end_at: plusHours(tStart, 2), applicant_ids: [await applicant()], handler_id: salesUser.id };
  assert.doesNotMatch(reasons(await evaluate(secondTraining)), /facilit/, 'two Trainings by different Sales users may overlap');
  await rawSession('training', tStart, 2, null, brandA.id, 'confirmed', 1);
  assert.match(reasons(await evaluate(secondTraining)), /All 2 Training facilities are in use 1:00–3:00 PM on [A-Z][a-z]{2} \d{1,2}\./);
  // A cancelled session frees its facility.
  await q(`update schedule_sessions set status = 'cancelled' where activity_type = 'training' and handler_id is null and start_at = $1`, [tStart]);
  assert.doesNotMatch(reasons(await evaluate(secondTraining)), /facilit/);
});

test('Admin settings: capacities and facility limits are configurable, audited and applied', async () => {
  assert.equal((await call('PUT', '/schedule-sessions/config', { token: sales, body: { orientation_capacity: 3, training_capacity: 1, orientation_facility_limit: 5, training_facility_limit: 2 } })).status, 403);
  const bad = await call('PUT', '/schedule-sessions/config', { token: admin, body: { orientation_capacity: 0, training_capacity: 1, orientation_facility_limit: 5, training_facility_limit: 2 } });
  assert.equal(bad.status, 422);
  const saved = await call('PUT', '/schedule-sessions/config', { token: admin, body: { orientation_capacity: 3, training_capacity: 1, orientation_facility_limit: 5, training_facility_limit: 2 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.data.capacity.orientation, 3);
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'settings.schedule_updated'`))[0].n, 1);
  const four = [await applicant(), await applicant(), await applicant(), await applicant()];
  assert.match(reasons(await evaluate(ot(four, slot(10, '09:00')))), /Orientation\/Tasting takes 3 applicants per session \(4 selected\)/);
  const restored = await call('PUT', '/schedule-sessions/config', { token: admin, body: { orientation_capacity: 5, training_capacity: 1, orientation_facility_limit: 5, training_facility_limit: 2 } });
  assert.equal(restored.json.data.capacity.orientation, 5);
});

test('picker data: only the applicant\'s Sales user and the selected activity; busy slots include the gap', async () => {
  const day = slot(11, '09:00').slice(0, 10);
  const mine = await rawSession('orientation', `${day}T09:00:00+08:00`, 2, salesUser.id);
  await rawSession('training', `${day}T13:00:00+08:00`, 1, salesUser.id, brandA.id, 'confirmed', 1);
  await rawSession('orientation', `${day}T15:00:00+08:00`, 2, otherUser.id);
  const who = await applicant();
  const before = (await q(`select count(*)::int n from activity_schedules where applicant_id = $1`, [who]))[0].n;
  const picker = await call('GET', `/schedule-sessions/availability?applicant_id=${who}&activity_type=orientation&month=${day.slice(0, 7)}&duration_minutes=120`, { token: sales });
  assert.equal(picker.status, 200, JSON.stringify(picker.json));
  const data = picker.json.data;
  assert.equal(data.handler.id, salesUser.id);
  assert.ok(data.days.every((d: any) => [1, 2, 3, 4, 5].includes(new Date(`${d.date}T12:00:00+08:00`).getUTCDay())), 'Mon–Fri only');
  const target = data.days.find((d: any) => d.date === day);
  assert.deepEqual(target.sessions.map((s: any) => s.id), [mine], 'dots: same activity and same Sales user only');
  const slotAt = (time: string) => target.slots.find((s: any) => s.time === time);
  assert.match(slotAt('10:00').reason, /already has Orientation\/Tasting 9:00–11:00 AM/);
  assert.match(slotAt('11:00').reason, /already has/, 'the gap after a session is busy');
  assert.match(slotAt('12:00').reason, /already has Training 1:00–2:00 PM/, 'busy with ANY activity, the gap before included');
  assert.equal(slotAt('15:00').available, true, 'another Sales user at 3:00 PM does not block this Sales user');
  assert.match(slotAt('16:00').reason, /Sessions must end by 5:00 PM/);
  assert.ok(data.next_available?.start_at, 'a Next available time is offered');
  assert.equal(data.capacity, 5);
  assert.equal(data.facility_limit, 5);
  // Looking at the picker (and closing the modal) never schedules the applicant.
  assert.equal((await q(`select count(*)::int n from activity_schedules where applicant_id = $1`, [who]))[0].n, before);
  assert.equal((await q(`select count(*)::int n from schedule_session_participants where applicant_id = $1`, [who]))[0].n, 0);
});

test('Sessions panel: Join this session allowed and refused with the reason', async () => {
  const start = slot(12, '09:00');
  const seated = await applicant();
  const open = await call('POST', '/schedule-sessions', { token: admin, body: ot([seated], start, 2, { venue: 'Virtual' }) });
  assert.equal(open.status, 201, JSON.stringify(open.json));
  const openId = open.json.data.session.id;
  const full = await rawSession('orientation', slot(13, '09:00'), 2, salesUser.id);
  for (let i = 0; i < 5; i += 1) await seat(full, await applicant());
  const cancelled = await rawSession('orientation', slot(13, '13:00'), 2, salesUser.id, null, 'cancelled');
  const foreign = await rawSession('orientation', slot(12, '13:00'), 2, otherUser.id);
  const trainingOther = await rawSession('training', slot(14, '09:00'), 2, salesUser.id, brandB.id, 'confirmed', 1);
  const who = await applicant();

  const panel = await call('GET', `/schedule-sessions/joinable?applicant_id=${who}&activity_type=orientation`, { token: sales });
  assert.equal(panel.status, 200, JSON.stringify(panel.json));
  const rows = panel.json.data.sessions;
  const row = (id: number) => rows.find((r: any) => r.id === id);
  assert.equal(row(foreign), undefined, 'another Sales user\'s sessions are not listed');
  assert.equal(row(openId).joinable, true, JSON.stringify(row(openId)));
  assert.equal(row(openId).occupancy, '1/5');
  assert.equal(row(full).joinable, false);
  assert.equal(row(full).reason, 'This session is full (5/5).');
  assert.equal(row(cancelled).reason, 'This session is Cancelled.');
  const trainingPanel = (await call('GET', `/schedule-sessions/joinable?applicant_id=${who}&activity_type=training`, { token: sales })).json.data.sessions;
  assert.equal(trainingPanel.find((r: any) => r.id === trainingOther).reason, `This Training session is for ${brandB.name}; the applicant selected ${brandA.name}.`);

  // Join via the existing participant API: Sales on a Confirmed session -> Pending for Admin, audited, Admin notified.
  const joined = await call('POST', `/schedule-sessions/${openId}/participants`, { token: sales, body: { applicant_id: who } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.equal(joined.json.data.status, 'pending');
  assert.equal(joined.json.data.participant_count, 2);
  assert.equal((await q(`select approval_status from activity_schedules where applicant_id = $1`, [who]))[0].approval_status, 'pending_admin');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'schedule_session.participant_added' and auditable_id = $1`, [openId]))[0].n, 1);
  assert.ok((await q(`select count(*)::int n from system_notifications where type = 'schedule_pending_approval' and data->>'session_id' = $1`, [String(openId)]))[0].n >= 1);
  const again = (await call('GET', `/schedule-sessions/joinable?applicant_id=${who}&activity_type=orientation`, { token: sales })).json.data.sessions;
  assert.equal(again.find((r: any) => r.id === openId).reason, 'The applicant is already in this session.');
  // A refused join leaves the applicant out.
  const refused = await call('POST', `/schedule-sessions/${full}/participants`, { token: sales, body: { applicant_id: await applicant() } });
  assert.equal(refused.status, 422);
});

test('Master Schedule form: an overlap of the same Sales user is refused, and Admin can add the applicant to that session instead', async () => {
  const start = slot(15, '10:00');
  const first = await call('POST', '/schedule-sessions', { token: admin, body: ot([await applicant()], start) });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const who = await applicant();
  const evaluation = await evaluate(ot([who], start));
  assert.equal(evaluation.status, 'blocked');
  assert.deepEqual(evaluation.merge_targets.map((t: any) => t.session_id), [first.json.data.session.id]);
  assert.equal((await call('POST', '/schedule-sessions', { token: sales, body: { ...ot([who], start), join_session_id: first.json.data.session.id } })).status, 403, 'Sales joins from the Sessions panel instead');
  const joined = await call('POST', '/schedule-sessions', { token: admin, body: { ...ot([who], start), join_session_id: first.json.data.session.id } });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  assert.equal(joined.json.data.joined_existing, true);
  assert.equal(joined.json.data.session.participant_count, 2);
});

test('Master Schedule summary: scoped to the range and the filters (status included)', async () => {
  const day = slot(16, '09:00').slice(0, 10);
  const nextDay = slot(17, '09:00').slice(0, 10);
  await rawSession('orientation', `${day}T09:00:00+08:00`, 2, salesUser.id);
  await rawSession('orientation', `${day}T13:00:00+08:00`, 2, salesUser.id, null, 'cancelled');
  await rawSession('training', `${nextDay}T09:00:00+08:00`, 2, salesUser.id, brandA.id, 'confirmed', 1);
  const range = (from: string, to: string) => `from=${from}T00:00:00%2B08:00&to=${to}T00:00:00%2B08:00`;
  const oneDay = (await call('GET', `/schedule-sessions/summary?${range(day, nextDay)}`, { token: admin })).json.data;
  assert.equal(oneDay.activity_counts.orientation, 2);
  assert.equal(oneDay.activity_counts.training, 0, 'the next day is outside the range');
  assert.equal(oneDay.status_counts.cancelled, 1);
  const cancelledOnly = (await call('GET', `/schedule-sessions/summary?${range(day, nextDay)}&status[]=cancelled`, { token: admin })).json.data;
  assert.equal(cancelledOnly.status_counts.confirmed, 0, 'the status filter applies');
  assert.equal(cancelledOnly.activity_counts.orientation, 1);
});
