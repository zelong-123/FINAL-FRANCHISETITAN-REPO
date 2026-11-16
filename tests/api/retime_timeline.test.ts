// The one-time timeline re-time (logged exception to the append-only history): the guard refuses rows
// of another applicant, the history triggers are always enabled again (also after an error), and the
// exception is logged with a snapshot of the old values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../support/harness.ts';
import { assertTriggersEnabled, ceejayPlan, M, retimeTimeline, type Change } from '../../supabase/scripts/retime_ceejay_timeline.ts';

const { pg, db } = await setup();
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];

async function applicantWithHistory(name: string) {
  const [a] = await q(`insert into applicants (full_name, status, application_date) values ($1, 'qualified', '2026-11-03') returning id`, [name]);
  const [h] = await q(`insert into applicant_status_histories (applicant_id, from_status, to_status, created_at) values ($1, 'converted', 'qualified', '2026-11-03T14:48:40Z') returning id`, [a.id]);
  const [s] = await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_at, created_at) values ($1, 'converted', 'qualified', '2026-11-03T14:48:40Z', '2026-11-03T14:48:40Z') returning id`, [a.id]);
  return { id: a.id as number, status: h.id as number, stage: s.id as number };
}
const refusedUpdate = (id: number) => q(`update applicant_status_histories set remarks = 'x' where id = $1`, [id]);

test('guard: a plan that would change another applicant\'s row is refused and nothing changes', async () => {
  const mine = await applicantWithHistory('Mine');
  const other = await applicantWithHistory('Other');
  const plan: Change[] = [
    { stage: 's', label: 'mine', table: 'applicant_status_histories', id: mine.status, column: 'created_at', value: M('2026-10-28 10:00') },
    { stage: 's', label: 'other', table: 'applicant_status_histories', id: other.status, column: 'created_at', value: M('2026-10-28 10:00') },
  ];
  await assert.rejects(retimeTimeline(db, mine.id, plan, { apply: true, approvedBy: 'test' }), /Guard: applicant_status_histories #\d+\.created_at belongs to applicant #\d+, not #\d+/);
  const rows = await q(`select applicant_id, created_at from applicant_status_histories where id = any($1::bigint[])`, [`{${mine.status},${other.status}}`]);
  assert.ok(rows.every((r) => new Date(r.created_at).toISOString() === '2026-11-03T14:48:40.000Z'), 'nothing changed');
  // A session shared with another applicant is not "owned" either.
  const [u] = await q(`select id from users order by id limit 1`);
  const act = (applicant: number) => q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, scheduled_by_user_id) values ($1, 'orientation', 'a', now(), now(), 'scheduled', $2) returning id`, [applicant, u.id]);
  const [act1] = await act(mine.id);
  const [act2] = await act(other.id);
  const [sess] = await q(`insert into schedule_sessions (activity_type, start_at, end_at, max_capacity) values ('orientation', now(), now() + interval '1 hour', 5) returning id`);
  for (const [act, who] of [[act1, mine.id], [act2, other.id]] as const) await q(`insert into schedule_session_participants (session_id, activity_schedule_id, applicant_id) values ($1, $2, $3)`, [sess.id, act.id, who]);
  await assert.rejects(retimeTimeline(db, mine.id, [{ stage: 's', label: 'session', table: 'schedule_sessions', id: sess.id, column: 'start_at', value: M('2026-10-30 09:00') }], { apply: false }), /Guard/);
});

test('apply: history rows of the applicant change, the exception is logged, and the triggers are enabled again', async () => {
  const mine = await applicantWithHistory('Retimed');
  const plan: Change[] = [
    { stage: 's', label: 'status', table: 'applicant_status_histories', id: mine.status, column: 'created_at', value: M('2026-10-28 10:00') },
    { stage: 's', label: 'stage', table: 'applicant_stage_histories', id: mine.stage, column: 'changed_at', value: M('2026-10-28 10:00') },
    { stage: 's', label: 'date', table: 'applicants', id: mine.id, column: 'application_date', value: '2026-10-27', kind: 'date' },
  ];
  await assert.rejects(refusedUpdate(mine.status), /append-only/, 'history is append-only before');
  await assert.rejects(retimeTimeline(db, mine.id, plan, { apply: true }), /--approved-by is required/);
  const res = await retimeTimeline(db, mine.id, plan, { apply: true, approvedBy: 'Test owner' });
  assert.equal(res.pending.length, 3);
  const [h] = await q(`select created_at from applicant_status_histories where id = $1`, [mine.status]);
  assert.equal(new Date(h.created_at).toISOString(), M('2026-10-28 10:00'));
  await assertTriggersEnabled(db);
  await assert.rejects(refusedUpdate(mine.status), /append-only/, 'still append-only after');
  const [log] = await q(`select old_values, new_values from audit_logs where action = 'data.timeline_retimed_exception' and auditable_id = $1`, [mine.id]);
  assert.equal(log.new_values.approved_by, 'Test owner');
  assert.deepEqual(log.new_values.triggers_disabled, ['applicant_status_histories.applicant_status_histories_append_only', 'applicant_stage_histories.applicant_stage_histories_append_only']);
  assert.equal(new Date(log.old_values.snapshot[0].value).toISOString(), '2026-11-03T14:48:40.000Z', 'old values snapshotted');
  assert.equal((await retimeTimeline(db, mine.id, plan, { apply: false })).pending.length, 0, 'a second run has nothing left');
});

test('an error part-way rolls everything back, including the trigger change and the audit row', async () => {
  const mine = await applicantWithHistory('Rollback');
  const plan: Change[] = [
    { stage: 's', label: 'status', table: 'applicant_status_histories', id: mine.status, column: 'created_at', value: M('2026-10-28 10:00') },
    { stage: 's', label: 'bad', table: 'applicants', id: mine.id, column: 'application_date', value: 'not-a-date', kind: 'date' },
  ];
  await assert.rejects(retimeTimeline(db, mine.id, plan, { apply: true, approvedBy: 'x' }));
  await assertTriggersEnabled(db);
  const [h] = await q(`select created_at from applicant_status_histories where id = $1`, [mine.status]);
  assert.equal(new Date(h.created_at).toISOString(), '2026-11-03T14:48:40.000Z', 'rolled back');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'data.timeline_retimed_exception' and auditable_id = $1`, [mine.id]))[0].n, 0);
});

test('failed rule checks refuse the apply', async () => {
  const mine = await applicantWithHistory('Checks');
  const plan: Change[] = [{ stage: 's', label: 'status', table: 'applicant_status_histories', id: mine.status, column: 'created_at', value: M('2026-10-28 10:00') }];
  await assert.rejects(retimeTimeline(db, mine.id, plan, { apply: true, approvedBy: 'x', checks: async () => [{ rule: 'nothing in the future', ok: false, detail: '' }] }), /Rule checks failed: nothing in the future/);
});

test('Ceejay\'s plan: every planned time is Manila business hours on a weekday, in the past, and in stage order', () => {
  const plan = ceejayPlan({ orientation_attended: { by: 'ADMIN (Admin)' }, training_completed: { by: 'ADMIN (Admin)' } }, { interviewer: 'Sales User' });
  const times = plan.filter((c) => c.kind === 'time').map((c) => new Date(c.value as string));
  assert.ok(times.length > 100);
  for (const t of times) {
    const m = new Date(t.getTime() + 8 * 3600e3);
    assert.ok(m.getUTCHours() >= 9 && (m.getUTCHours() < 18 || (m.getUTCHours() === 18 && m.getUTCMinutes() === 0)), `${t.toISOString()} in business hours`);
    assert.ok(m.getUTCDay() >= 1 && m.getUTCDay() <= 5, `${t.toISOString()} on a weekday`);
    assert.ok(t.getTime() < Date.parse('2026-11-15T00:00:00Z'));
  }
  const statusTimes = plan.filter((c) => c.table === 'applicant_status_histories' && c.column === 'created_at').map((c) => Date.parse(c.value as string));
  assert.deepEqual([...statusTimes].sort((a, b) => a - b), statusTimes, 'stages in order');
});
