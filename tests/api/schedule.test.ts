// Activities and the Master Schedule, including both directions of the sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brandA, brandB] = await q(`select id from brands order by id limit 2`);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

/** A weekday at the given Manila time, safely in the future. */
function slot(days: number, hour: string): string {
  const d = new Date(Date.now() + days * 86400000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)}T${hour}:00+08:00`;
}
const DAY1 = (h: string) => slot(10, h);

let counter = 0;
async function schedulable(brandId = brandA.id) {
  counter += 1;
  const [a] = await q(`insert into applicants (full_name, status, preferred_brand_id, application_date) values ($1, 'scheduled', $2, '2026-01-01') returning id`, [`Person ${counter}`, brandId]);
  return a.id as number;
}
const session = (applicantIds: number[], start: string, extra: any = {}) => ({
  activity_type: 'orientation', start_at: start, end_at: start.replace(/T(\d{2})/, (_m, h) => `T${String(Number(h) + 1).padStart(2, '0')}`), applicant_ids: applicantIds, ...extra,
});

test('config and handlers', async () => {
  const config = await call('GET', '/schedule-sessions/config', { token: admin });
  assert.equal(config.json.data.opens_at, '09:00');
  assert.equal(config.json.data.days_label, 'Monday to Friday');
  assert.equal((await call('GET', '/schedule-sessions/handlers', { token: sales })).json.data.length >= 2, true);
  assert.equal((await call('GET', '/schedule-sessions/handlers', { token: await login('logistics@franchisetitan.local') })).status, 403);
});

test('window rules: grid, working hours, weekends and the past', async () => {
  const id = await schedulable();
  const blocked = async (start: string, end: string) => (await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'orientation', start_at: start, end_at: end, applicant_ids: [id] } })).json.data;
  assert.match((await blocked(DAY1('09:15'), DAY1('10:15'))).reasons.join(), /on the hour or on the half hour/);
  assert.match((await blocked(DAY1('17:30'), DAY1('18:30'))).reasons.join(), /No whole-hour duration/);
  assert.match((await blocked(DAY1('07:00'), DAY1('08:00'))).reasons.join(), /must start between/);
  assert.match((await blocked('2020-01-06T09:00:00+08:00', '2020-01-06T10:00:00+08:00')).reasons.join(), /in the past/);
  assert.match((await blocked(DAY1('09:00'), DAY1('10:30'))).reasons.join(), /whole number of hours/);
  assert.equal((await blocked(DAY1('09:00'), DAY1('10:00'))).status, 'ok');
});

test('Admin session is confirmed, mirrored to activity_schedules and logged', async () => {
  const id = await schedulable();
  const created = await call('POST', '/schedule-sessions', { token: admin, body: session([id], slot(11, '09:00'), { handler_id: adminUser.id }) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const s = created.json.data.session;
  assert.equal(s.status, 'confirmed');
  assert.equal(s.occupancy, '1/30 applicants');
  assert.match(s.start_at, /\+08:00$/);
  const [mirror] = await q(`select * from activity_schedules where applicant_id = $1`, [id]);
  assert.equal(mirror.session_key, `session-${s.id}`);
  assert.equal(mirror.live_key, `${id}:orientation`);
  const detail = await call('GET', `/schedule-sessions/${s.id}`, { token: admin });
  assert.equal(detail.json.data.history[0].action, 'created');
  assert.equal(detail.json.data.history[0].performed_by_name, 'System Administrator');
  assert.equal((await q(`select count(*)::int c from applicant_stage_histories where applicant_id = $1 and event = 'scheduled'`, [id]))[0].c, 1);
  const listed = await call('GET', `/schedule-sessions?from=${encodeURIComponent(slot(11, '00:00'))}&to=${encodeURIComponent(slot(12, '00:00'))}`, { token: admin });
  assert.ok(listed.json.data.some((x: any) => x.id === s.id));
  const shown = await call('GET', `/applicants/${id}`, { token: admin });
  assert.equal(shown.json.data.schedule_sessions[0].id, s.id);
  assert.equal(shown.json.data.activity_state.orientation.state, 'scheduled');
});

test('H1 applicant twice and H2 handler twice are hard blocks, with suggested times', async () => {
  const a = await schedulable();
  const b = await schedulable();
  const start = slot(12, '10:00');
  await call('POST', '/schedule-sessions', { token: admin, body: session([a], start, { handler_id: adminUser.id, venue: 'Virtual' }) });
  const same = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: session([b], start, { handler_id: adminUser.id }) });
  assert.equal(same.json.data.status, 'mergeable', 'an orientation with seats is a merge candidate');
  assert.equal(same.json.data.separate_allowed, false, 'same handler cannot run a separate session');
  assert.equal(same.json.data.suggested_times.length, 3);

  const refused = await call('POST', '/schedule-sessions', { token: admin, body: session([b], start, { handler_id: adminUser.id }) });
  assert.equal(refused.status, 422);
  assert.ok(refused.json.evaluation, 'the refusal carries the evaluation');
  assert.match(refused.json.message, /overlapping session can take these applicants/);

  // Warning: only Admin may override, and only with remarks.
  const near = session([b], slot(12, '11:00'), { handler_id: adminUser.id });
  assert.match((await call('POST', '/schedule-sessions', { token: sales, body: near })).json.message, /Near conflict/);
  assert.match((await call('POST', '/schedule-sessions', { token: admin, body: near })).json.message, /Remarks are required/);
  const overridden = await call('POST', '/schedule-sessions', { token: admin, body: { ...near, override_remarks: 'Handler agreed' } });
  assert.equal(overridden.status, 201, JSON.stringify(overridden.json));
  assert.ok(overridden.json.data.session);
});

test('H6 brand match, H3 tastings and H5 capacity', async () => {
  // Product tasting needs orientation done first, so the gate reasons appear with brand reasons.
  const a = await schedulable(brandA.id);
  const start = slot(13, '09:00');
  const wrong = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: session([a], start, { activity_type: 'product_tasting', brand_id: brandB.id }) });
  assert.match(wrong.json.data.reasons.join(), /hindi tugma sa brand/);
  const none = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: session([a], start, { activity_type: 'product_tasting' }) });
  assert.match(none.json.data.reasons.join(), /Brand is required/);
  const cap = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: session([a, await schedulable()], start, { max_capacity: 1 }) });
  assert.match(cap.json.data.reasons.join(), /Lalampas sa max capacity \(2\/1/);
});

test('Sales sessions wait for Admin; merge, confirm, cancel and Set Again', async () => {
  const a = await schedulable();
  const b = await schedulable();
  const start = slot(14, '09:00');
  const first = (await call('POST', '/schedule-sessions', { token: admin, body: session([a], start, { handler_id: adminUser.id, venue: 'Virtual' }) })).json.data.session;
  const pending = await call('POST', '/schedule-sessions', { token: sales, body: session([b], start, { handler_id: salesUser.id, venue: 'Main Office (In-person)', create_separate: true }) });
  assert.equal(pending.status, 201, JSON.stringify(pending.json));
  const second = pending.json.data.session;
  assert.equal(second.status, 'pending');
  assert.equal(second.merge_suggested, true);
  assert.equal((await q(`select approval_status from activity_schedules where applicant_id = $1`, [b]))[0].approval_status, 'pending_admin');

  assert.equal((await call('POST', `/schedule-sessions/${second.id}/merge`, { token: sales, body: { target_session_id: first.id } })).status, 403);
  const drag = await call('POST', `/schedule-sessions/${second.id}/evaluate-drag`, { token: admin, body: { from: slot(14, '00:00'), to: slot(14, '23:00') } });
  assert.equal(drag.json.data.targets.find((t: any) => t.session_id === first.id).status, 'mergeable');
  const merged = await call('POST', `/schedule-sessions/${second.id}/merge`, { token: admin, body: { target_session_id: first.id } });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  assert.equal(merged.json.data.active_participants.length, 2);
  assert.equal((await q(`select status from schedule_sessions where id = $1`, [second.id]))[0].status, 'merged');
  const [moved] = await q(`select session_key, approval_status from activity_schedules where applicant_id = $1`, [b]);
  assert.equal(moved.session_key, `session-${first.id}`, 'the mirror follows the seat');
  assert.equal(moved.approval_status, 'immediate');

  // Set Again moves only this applicant, the rest of the group is untouched.
  const again = await call('POST', `/schedule-sessions/${first.id}/participants/${b}/set-again`, { token: admin, body: { start_at: slot(14, '14:00'), end_at: slot(14, '15:00') } });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.data.previous_session.active_participants.length, 1);
  assert.equal(again.json.data.session.active_participants[0].applicant_id, b);

  // Removing the last person asks about the session, it never cancels on its own.
  const removed = await call('DELETE', `/schedule-sessions/${first.id}/participants/${a}`, { token: admin, body: {} });
  assert.equal(removed.json.data.empty_session, true);
  assert.equal(removed.json.data.session.status, 'confirmed');
  assert.equal((await q(`select status from activity_schedules where applicant_id = $1`, [a]))[0].status, 'cancelled');

  const moving = await call('POST', `/schedule-sessions/${again.json.data.session.id}/move`, { token: admin, body: { start_at: slot(14, '15:00') } });
  assert.equal(moving.status, 200, JSON.stringify(moving.json));
  const [stage] = await q(`select status from applicants where id = $1`, [b]);
  assert.equal(stage.status, 'scheduled', 'a move never changes the stage');
  const cancelled = await call('POST', `/schedule-sessions/${again.json.data.session.id}/cancel`, { token: admin, body: {} });
  assert.equal(cancelled.json.data.status, 'cancelled');
  assert.equal((await q(`select live_key from activity_schedules where applicant_id = $1`, [b]))[0].live_key, null, 'a cancelled row gives up its slot');
});

test('Activities API: Sales booking waits for approval, the Complete and Attended halves, and order', async () => {
  const id = await schedulable();
  const body = (hour: string, days = 15) => ({ applicant_id: id, activity_type: 'orientation', title: 'Orientation', starts_at: slot(days, hour), duration_minutes: 60, venue: 'Virtual' });
  const created = await call('POST', '/activities', { token: sales, body: body('09:00') });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const activity = created.json.data;
  assert.equal(activity.approval_status, 'pending_admin');
  assert.equal(activity.applicant.id, id);
  assert.equal((await q(`select count(*)::int c from schedule_session_participants where activity_schedule_id = $1`, [activity.id]))[0].c, 1, 'an activity write becomes a session seat');

  const second = await call('POST', '/activities', { token: sales, body: { ...body('13:00'), title: 'Again' } });
  assert.match(second.json.errors.activity_type[0], /already has a confirmed record/);
  const skip = await call('POST', '/activities', { token: admin, body: { ...body('13:00'), activity_type: 'training', title: 'Training' } });
  assert.match(skip.json.errors.activity_type[0], /comes after Product Tasting/);

  assert.match((await call('POST', `/activities/${activity.id}/complete`, { token: sales, body: { result_notes: 'x', confirm_early: true } })).json.errors.status[0], /cannot be completed until it is approved/);
  assert.equal((await call('POST', `/activities/${activity.id}/approve`, { token: sales })).status, 403);

  // A Sales adjustment is only a proposal until Admin approves it.
  await call('POST', `/activities/${activity.id}/approve`, { token: admin });
  const adjust = await call('PUT', `/activities/${activity.id}`, { token: sales, body: { starts_at: slot(15, '11:00'), duration_minutes: 60 } });
  assert.equal(adjust.status, 200, JSON.stringify(adjust.json));
  assert.equal(adjust.json.data.approval_status, 'pending_admin');
  assert.equal(new Date(adjust.json.data.starts_at).getTime(), new Date(slot(15, '09:00')).getTime(), 'the time holds until approved');
  await call('POST', `/activities/${activity.id}/reject`, { token: admin });
  const reverted = await call('GET', `/activities/${activity.id}`, { token: admin });
  assert.equal(reverted.json.data.approval_status, 'immediate', 'a rejected adjustment keeps the approved schedule');
  assert.equal((await call('GET', `/activities/grouped?applicant_id=${id}&include_completed=1`, { token: admin })).json.data[0].activities.some((x: any) => x.approval_status === 'rejected'), true);

  const early = await call('POST', `/activities/${activity.id}/complete`, { token: sales, body: { result_notes: 'Went well' } });
  assert.ok(early.json.errors.confirm_early);
  const done = await call('POST', `/activities/${activity.id}/complete`, { token: sales, body: { result_notes: 'Went well', confirm_early: true } });
  assert.equal(done.json.data.status, 'completed');
  assert.equal((await q(`select attendance_status from schedule_session_participants where activity_schedule_id = $1`, [activity.id]))[0].attendance_status, 'completed');
  assert.equal((await call('GET', '/applicants', { token: admin })).json.data.find((a: any) => a.id === id).has_activity_update, true, 'blue dot for Admin');

  const attended = await call('PATCH', `/applicants/${id}/milestones`, { token: admin, body: { milestones: { orientation_attended: true } } });
  assert.equal(attended.json.data.activity_state.orientation.done, true);
  assert.equal((await q(`select attendance_status from schedule_session_participants where activity_schedule_id = $1`, [activity.id]))[0].attendance_status, 'attended', 'Attended reaches the Master Schedule');

  // Now Set Again targets the next step, never the same one.
  const next = await call('POST', `/applicants/${id}/activities/set-again`, { token: admin, body: { starts_at: slot(16, '09:00'), duration_minutes: 60 } });
  assert.equal(next.status, 201, JSON.stringify(next.json));
  assert.equal(next.json.data.activity_type, 'product_tasting');
  const groupedDone = await call('DELETE', `/activities/${next.json.data.id}`, { token: admin });
  assert.equal(groupedDone.status, 200);
  assert.equal((await q(`select status from activity_schedules where id = $1`, [next.json.data.id]))[0].status, 'cancelled');
  const preview = await call('GET', `/activities/session-preview?activity_type=orientation&starts_at=${encodeURIComponent(slot(15, '09:00'))}`, { token: admin });
  assert.equal(preview.json.data.capacity, 30);
});
