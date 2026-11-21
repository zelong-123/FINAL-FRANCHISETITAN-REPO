// Joining a session is exactly scheduling: every path that seats an applicant leaves ONE live activity
// record linked to that seat (same type, the session's time, handler, venue, brand), visible to the
// applicant endpoints and the Activities table, in one transaction (all-or-nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brandA] = await q(`select id from brands order by id limit 1`);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);

function slot(days: number, hour: string): string {
  const d = new Date();
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1;
  }
  return `${d.toISOString().slice(0, 10)}T${hour}:00+08:00`;
}
const plusHours = (iso: string, h: number) => iso.replace(/T(\d{2})/, (_m, x) => `T${String(Number(x) + h).padStart(2, '0')}`);
let counter = 0;
async function applicant() {
  counter += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, preferred_brand_id, application_date, assigned_sales_user_id) values ($1, 'scheduled', $2, '2026-01-01', $3) returning id`,
    [`Join ${counter}`, brandA.id, salesUser.id],
  );
  return a.id as number;
}
const ot = (ids: number[], start: string, extra: any = {}) => ({ activity_type: 'orientation', start_at: start, end_at: plusHours(start, 2), applicant_ids: ids, handler_id: salesUser.id, venue: 'Virtual', ...extra });

/** The invariant: an active seat in a live session has exactly one live activity, linked and matching the session. */
async function assertLinked(applicantId: number, sessionId: number, state = 'scheduled') {
  const seats = await q(`select * from schedule_session_participants where applicant_id = $1 and session_id = $2 and attendance_status = 'scheduled'`, [applicantId, sessionId]);
  assert.equal(seats.length, 1, 'one active seat');
  const [s] = await q(`select * from schedule_sessions where id = $1`, [sessionId]);
  const live = await q(`select * from activity_schedules where applicant_id = $1 and activity_type = $2 and status in ('pending', 'confirmed') and approval_status <> 'rejected'`, [applicantId, s.activity_type]);
  assert.equal(live.length, 1, `exactly one live ${s.activity_type} record (found ${live.length})`);
  const a = live[0];
  assert.equal(Number(seats[0].activity_schedule_id), Number(a.id), 'the seat points at the live record');
  assert.equal(new Date(a.starts_at).getTime(), new Date(s.start_at).getTime(), 'the session time');
  assert.equal(new Date(a.ends_at).getTime(), new Date(s.end_at).getTime());
  assert.equal(Number(a.assigned_to_user_id), Number(s.handler_id), 'the session handler');
  assert.equal(a.venue, s.venue);
  assert.equal(a.live_key, `${applicantId}:${s.activity_type}`, 'it holds the live slot');
  // What the screens read: the applicant modal and the Activities table.
  const shown = (await call('GET', `/applicants/${applicantId}`, { token: admin })).json.data;
  assert.equal(shown.activity_state[s.activity_type].state, state, `Applicant modal: ${state}`);
  const grouped = (await call('GET', `/activities/grouped?applicant_id=${applicantId}`, { token: admin })).json.data;
  assert.ok(grouped.some((g: any) => g.activities.some((x: any) => Number(x.id) === Number(a.id) && ['pending', 'confirmed'].includes(x.status))), 'Activities table lists it');
  return a;
}

test('re-joining a session after the schedule was cancelled creates a new live record (the live bug)', async () => {
  const first = await applicant();
  const susan = await applicant();
  const start = slot(5, '09:00');
  const created = await call('POST', '/schedule-sessions', { token: admin, body: ot([first, susan], start) });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const sessionId = created.json.data.session.id;
  const [old] = await q(`select id from activity_schedules where applicant_id = $1`, [susan]);
  // Cancel schedule (Activities): the seat is cancelled with the record.
  assert.equal((await call('DELETE', `/activities/${old.id}`, { token: admin })).status, 200);
  // Join the same session again from the Sessions panel.
  const joined = await call('POST', `/schedule-sessions/${sessionId}/participants`, { token: admin, body: { applicant_id: susan } });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const live = await assertLinked(susan, sessionId);
  assert.notEqual(Number(live.id), Number(old.id), 'the cancelled record stays history; a new one is created');
  assert.equal((await q(`select status from activity_schedules where id = $1`, [old.id]))[0].status, 'cancelled', 'old history is not rewritten');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'activity.created' and auditable_id = $1`, [live.id]))[0].n, 1, 'audited like a normal schedule');
  assert.ok((await q(`select count(*)::int n from applicant_stage_histories where applicant_id = $1 and event = 'scheduled'`, [susan]))[0].n >= 2, 'stage history: scheduled again');
});

test('Remove, then add the same applicant again: the seat gets a fresh live record', async () => {
  const a = await applicant();
  const b = await applicant();
  const created = await call('POST', '/schedule-sessions', { token: admin, body: ot([a, b], slot(6, '09:00')) });
  const sessionId = created.json.data.session.id;
  assert.equal((await call('DELETE', `/schedule-sessions/${sessionId}/participants/${b}`, { token: admin, body: {} })).status, 200);
  const again = await call('POST', `/schedule-sessions/${sessionId}/participants`, { token: sales, body: { applicant_id: b } });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  const live = await assertLinked(b, sessionId, 'pending_admin');
  assert.equal(live.approval_status, 'pending_admin', 'Sales on a Confirmed session: waits for Admin, as before');
});

test('first join, Admin join from the Master Schedule form, and capacity counts agree with the records', async () => {
  const a = await applicant();
  const start = slot(7, '09:00');
  const sessionId = (await call('POST', '/schedule-sessions', { token: admin, body: ot([a], start) })).json.data.session.id;
  const viaPanel = await applicant();
  assert.equal((await call('POST', `/schedule-sessions/${sessionId}/participants`, { token: admin, body: { applicant_id: viaPanel } })).status, 200);
  await assertLinked(viaPanel, sessionId);
  const viaForm = await applicant();
  const joined = await call('POST', '/schedule-sessions', { token: admin, body: { ...ot([viaForm], start), join_session_id: sessionId } });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  await assertLinked(viaForm, sessionId);
  const seats = (await q(`select count(*)::int n from schedule_session_participants where session_id = $1 and attendance_status not in ('cancelled', 'removed')`, [sessionId]))[0].n;
  const records = (await q(`select count(*)::int n from activity_schedules x join schedule_session_participants p on p.activity_schedule_id = x.id where p.session_id = $1 and x.status in ('pending', 'confirmed')`, [sessionId]))[0].n;
  assert.equal(seats, 3);
  assert.equal(records, seats, 'capacity counted from seats equals the live records');
  const shown = (await call('GET', `/schedule-sessions/${sessionId}`, { token: admin })).json.data;
  assert.equal(shown.participant_count, 3);
});

test('merge and Set Again keep one live record per seat', async () => {
  const a = await applicant();
  const b = await applicant();
  const c = await applicant();
  const target = (await call('POST', '/schedule-sessions', { token: admin, body: ot([a], slot(8, '09:00')) })).json.data.session.id;
  const source = (await call('POST', '/schedule-sessions', { token: sales, body: ot([b, c], slot(8, '13:00')) })).json.data.session.id;
  const merged = await call('POST', `/schedule-sessions/${source}/merge`, { token: admin, body: { target_session_id: target } });
  assert.equal(merged.status, 200, JSON.stringify(merged.json));
  await assertLinked(b, target);
  await assertLinked(c, target);
  const again = await call('POST', `/schedule-sessions/${target}/participants/${c}/set-again`, { token: admin, body: { start_at: slot(9, '13:00'), end_at: slot(9, '15:00') } });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  await assertLinked(c, again.json.data.session.id);
  await assertLinked(b, target);
  // Merging back into a session where the applicant once had a (removed) seat reuses that seat row.
  const back = (await call('POST', '/schedule-sessions', { token: admin, body: ot([await applicant()], slot(9, '09:00')) })).json.data.session.id;
  const moved = await call('POST', `/schedule-sessions/${again.json.data.session.id}/merge`, { token: admin, body: { target_session_id: back } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  await assertLinked(c, back);
});

test('repair migration: a seat left on a cancelled record (the live state) gets a new linked record; nothing else changes', async () => {
  const a = await applicant();
  const broken = await applicant();
  const sessionId = (await call('POST', '/schedule-sessions', { token: admin, body: ot([a, broken], slot(11, '09:00')) })).json.data.session.id;
  // The state the old join left on live: an active seat pointing at a cancelled record.
  const [old] = await q(`select id from activity_schedules where applicant_id = $1`, [broken]);
  await q(`update activity_schedules set status = 'cancelled', live_key = null, cancelled_at = now() where id = $1`, [old.id]);
  const before = (await q(`select count(*)::int n from activity_schedules`))[0].n;
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(new URL('../../supabase/migrations/20261124000001_session_seat_activity_repair.sql', import.meta.url), 'utf8');
  await pg.exec(sql);
  assert.equal((await q(`select count(*)::int n from activity_schedules`))[0].n, before + 1, 'exactly one record created');
  const live = await assertLinked(broken, sessionId);
  assert.equal((await q(`select status from activity_schedules where id = $1`, [old.id]))[0].status, 'cancelled', 'the old record is not rewritten');
  assert.equal(Number(live.scheduled_by_user_id) > 0, true);
  const [log] = await q(`select * from audit_logs where action = 'activity.created' and auditable_id = $1`, [live.id]);
  assert.equal(log.new_values.session_id, sessionId);
  const [hist] = await q(`select * from applicant_stage_histories where applicant_id = $1 and context->>'via' = 'repair'`, [broken]);
  assert.match(hist.remarks, new RegExp(`session #${sessionId}`));
  // Running it again changes nothing.
  await pg.exec(sql);
  assert.equal((await q(`select count(*)::int n from activity_schedules`))[0].n, before + 1);
  // The live-only slot rule: a second LIVE record at the same time is still refused.
  await assert.rejects(q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, scheduled_by_user_id, status) select applicant_id, 'training', title, starts_at, ends_at, scheduled_by_user_id, 'pending' from activity_schedules where id = $1`, [live.id]), /activity_schedules_unique_live_slot/);
});

test('no seat without a live record and no live record without a seat (both directions)', async () => {
  const seatsWithout = await q(`select p.id from schedule_session_participants p join schedule_sessions s on s.id = p.session_id left join activity_schedules x on x.id = p.activity_schedule_id
    where p.attendance_status = 'scheduled' and s.status in ('pending', 'confirmed') and (x.id is null or x.status not in ('pending', 'confirmed') or x.approval_status = 'rejected')`);
  assert.deepEqual(seatsWithout, []);
  const recordsWithout = await q(`select x.id from activity_schedules x left join schedule_session_participants p on p.activity_schedule_id = x.id left join schedule_sessions s on s.id = p.session_id
    where x.status in ('pending', 'confirmed') and x.approval_status <> 'rejected' and x.activity_type in ('orientation', 'training')
      and (p.id is null or p.attendance_status <> 'scheduled' or s.status not in ('pending', 'confirmed'))`);
  assert.deepEqual(recordsWithout, []);
});

test('a join whose activity write fails saves nothing (one transaction)', async () => {
  const a = await applicant();
  const sessionId = (await call('POST', '/schedule-sessions', { token: admin, body: ot([a], slot(10, '09:00')) })).json.data.session.id;
  const victim = await applicant();
  await q(`create or replace function test_refuse_activity() returns trigger language plpgsql as $$ begin
    if new.applicant_id = ${victim} then raise exception 'activity write refused (test)'; end if; return new; end $$`);
  await q(`create trigger test_refuse_activity before insert or update on activity_schedules for each row execute function test_refuse_activity()`);
  try {
    const joined = await call('POST', `/schedule-sessions/${sessionId}/participants`, { token: admin, body: { applicant_id: victim } });
    assert.ok(joined.status >= 400, `refused: ${joined.status}`);
  } finally {
    await q(`drop trigger test_refuse_activity on activity_schedules`);
    await q(`drop function test_refuse_activity()`);
  }
  assert.equal((await q(`select count(*)::int n from schedule_session_participants where applicant_id = $1`, [victim]))[0].n, 0, 'no seat without its record');
  assert.equal((await q(`select count(*)::int n from applicant_stage_histories where applicant_id = $1`, [victim]))[0].n, 0, 'no history either');
  assert.equal((await q(`select count(*)::int n from schedule_session_history where session_id = $1 and action = 'participant_added'`, [sessionId]))[0].n, 0);
});
