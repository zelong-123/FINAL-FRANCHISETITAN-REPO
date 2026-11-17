// Applicant follow-up: Overdue / Stalled / Waiting on Admin / On hold, reminders (1 per 24h), automatic
// alerts once per episode, Log follow-up (reason + next action date), hold, close, lists and permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';
import { createStaff } from '../support/accounts.ts';
import { runFollowUpAlerts } from '../../supabase/functions/api/services/followUp.ts';

const { pg, db, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brand] = await q(`select id from brands order by id limit 1`);
const [salesUser] = await q(`select id, full_name from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
const otherSales = await createStaff(call, admin, { full_name: 'Fu Other Sales', email: 'fu.other@example.test', role: 'sales' });
const [otherSalesUser] = await q(`select id from users where email = 'fu.other@example.test'`);

const ago = (days: number) => new Date(Date.now() - days * 86400e3).toISOString();
const manilaDay = (offsetDays: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + offsetDays * 86400e3));
const firstError = (res: { json: any }) => Object.values(res.json?.errors ?? {}).flat()[0] as string;

let n = 0;
/** An applicant that entered `status` `daysInStage` days ago (by Admin), assigned to the seeded Sales user. */
async function applicant(daysInStage: number, status = 'scheduled', extra: Record<string, unknown> = {}) {
  n += 1;
  const cols = { full_name: `Fu Person ${n}`, applicant_code: `APL-FU-${n}`, status, application_date: '2026-05-01', assigned_sales_user_id: salesUser.id, preferred_brand_id: brand.id, ...extra };
  const keys = Object.keys(cols);
  const [a] = await q(`insert into applicants (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, Object.values(cols));
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_by_user_id, changed_at, actor_role) values ($1, 'converted', $2, $3, $4, 'admin')`,
    [a.id, status, adminUser.id, ago(daysInStage)]);
  return Number(a.id);
}
const salesAction = (id: number, daysAgo: number) =>
  q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_by_user_id, changed_at, actor_role, event)
     select id, status, status, $2, $3, 'sales', 'assessment_saved' from applicants where id = $1`, [id, salesUser.id, ago(daysAgo)]);
const state = async (id: number, token = admin) => (await call('GET', `/applicants/${id}`, { token })).json.data.follow_up;
const notes = async (token: string, type: string, id: number) =>
  ((await call('GET', '/notifications?per_page=200', { token })).json.data as any[]).filter((x) => x.type === type && Number(x.data?.applicant_id) === id);

test('Overdue at 7+ days and Stalled at 14+ days without a Sales update; a Sales action restarts the timer', async () => {
  assert.equal((await state(await applicant(3))).state, null, 'on track');
  const overdue = await applicant(7);
  const view = await state(overdue);
  assert.equal(view.state, 'overdue');
  assert.equal(view.days, 7);
  assert.match(view.tooltip, /^7 days in Scheduled, last update [A-Z][a-z]{2} \d+ by System Administrator$/);
  const stalled = await applicant(15);
  assert.equal((await state(stalled)).state, 'stalled');
  // The existing Overdue flag follows the new rule.
  assert.equal((await call('GET', `/applicants/${stalled}`, { token: admin })).json.data.overdue, true);
  await salesAction(stalled, 2);
  const after = await state(stalled);
  assert.equal(after.state, null, 'a Sales action restarts the timer');
  assert.match(after.last_update.by, /Sales/);
  // An activity a Sales user requested counts as an update too.
  const requested = await applicant(9);
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id, created_at)
    values ($1, 'training', 'Training', now() - interval '1 day', now() - interval '1 day', 'completed', 'immediate', $2, now() - interval '1 day')`, [requested, salesUser.id]);
  assert.equal((await state(requested)).state, null);
});

test('not Overdue with an upcoming activity or while waiting for Admin review (silently, no state); Approved and closed are excluded', async () => {
  const upcoming = await applicant(20);
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id)
    values ($1, 'training', 'Training', now() + interval '2 days', now() + interval '2 days 2 hours', 'confirmed', 'immediate', $2)`, [upcoming, adminUser.id]);
  assert.equal((await state(upcoming)).state, null, 'an upcoming activity keeps it on track');

  const requirement = await applicant(20, 'loi_submitted');
  await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_at) values ($1, 'proposed_site', 'loi', 'submitted', '{}', now() - interval '3 days')`, [requirement]);
  const waiting = await state(requirement);
  assert.deepEqual([waiting.state, waiting.tooltip, 'waiting' in waiting], [null, null, false], 'no Waiting on Admin state or text');

  const payment = await applicant(20, 'payment_submitted');
  await q(`insert into payments (applicant_id, payment_type, payment_date, payment_method, or_number, status, recorded_by_user_id) values ($1, 'payment_record', '2026-11-01', 'cash', 'OR-FU-1', 'pending', $2)`, [payment, salesUser.id]);
  assert.equal((await state(payment)).state, null);

  const approval = await applicant(20, 'scheduled');
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id)
    values ($1, 'training', 'Training', now() - interval '1 day', now() - interval '1 day', 'pending', 'pending_admin', $2)`, [approval, adminUser.id]);
  assert.equal((await state(approval)).state, null);

  assert.equal((await state(await applicant(20, 'for_approval'))).state, null);
  assert.ok(firstError(await call('GET', '/applicants?follow_up=waiting_admin', { token: admin })), 'no Waiting on Admin filter');
  assert.equal((await state(await applicant(20, 'approved'))).state, null, 'Approved (waiting for the franchisee) is not followed up');
  const archived = await applicant(20, 'scheduled', { archived_at: new Date().toISOString() });
  assert.equal((await state(archived)).state, null);
});

test('retired requirement rows (not in the requirement config) never count as waiting for Admin', async () => {
  const id = await applicant(9, 'scheduled');
  await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_at) values ($1, 'business_background', 'qualification', 'submitted', '{}', now() - interval '5 days')`, [id]);
  assert.equal((await state(id)).state, 'overdue', 'the legacy row is ignored');
});

test('a past activity never marked complete makes it Overdue (as for Susan Enriquez), until Sales updates it', async () => {
  // Scheduling for 4 days (under 7), Orientation/Tasting confirmed for 2 days ago and never completed.
  const id = await applicant(4, 'scheduled');
  await q(`insert into applicant_requirements (applicant_id, requirement_key, stage, status, data, submitted_at) values ($1, 'business_background', 'qualification', 'submitted', '{}', now() - interval '5 days')`, [id]);
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id)
    values ($1, 'orientation', 'Orientation/Tasting', now() - interval '2 days 2 hours', now() - interval '2 days', 'confirmed', 'immediate', $2)`, [id, adminUser.id]);
  const view = await state(id);
  assert.deepEqual([view.state, view.days], ['overdue', 4]);
  assert.match(view.tooltip, /^Orientation\/Tasting on .* was not marked complete · 4 days in Scheduled/);
  await salesAction(id, 1);
  assert.equal((await state(id)).state, null, 'a Sales update after the missed activity clears it');
  // Completed (or submitted for Admin review) activities are not missed.
  const done = await applicant(4, 'scheduled');
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id, review_status)
    values ($1, 'orientation', 'Orientation/Tasting', now() - interval '2 days 2 hours', now() - interval '2 days', 'confirmed', 'immediate', $2, 'submitted')`, [done, adminUser.id]);
  assert.equal((await state(done)).state, null);
});

test('thresholds come from Admin settings (Admin only, validated, audited)', async () => {
  assert.equal((await call('GET', '/applicants/follow-up-settings', { token: sales })).status, 403);
  assert.deepEqual(
    [(await call('GET', '/applicants/follow-up-settings', { token: admin })).json.data.overdue_days, (await call('GET', '/applicants/follow-up-settings', { token: admin })).json.data.stalled_days],
    [7, 14],
  );
  assert.match(firstError(await call('PUT', '/applicants/follow-up-settings', { token: admin, body: { overdue_days: 5, stalled_days: 5 } })), /more days than Overdue/);
  assert.equal((await call('PUT', '/applicants/follow-up-settings', { token: sales, body: { overdue_days: 3, stalled_days: 5 } })).status, 403);
  const id = await applicant(4);
  assert.equal((await state(id)).state, null);
  try {
    assert.equal((await call('PUT', '/applicants/follow-up-settings', { token: admin, body: { overdue_days: 3, stalled_days: 5 } })).status, 200);
    assert.equal((await state(id)).state, 'overdue');
    assert.equal((await q(`select count(*)::int c from audit_logs where action = 'settings.follow_up_updated'`))[0].c, 1);
  } finally {
    await call('PUT', '/applicants/follow-up-settings', { token: admin, body: { overdue_days: 7, stalled_days: 14 } });
  }
});

test('On hold: shows On hold until …, pauses the timer, and release lets it run again', async () => {
  const id = await applicant(10);
  assert.equal((await call('POST', `/applicants/${id}/hold`, { token: sales, body: { reason: 'Applicant abroad', until: manilaDay(10) } })).status, 403, 'Admin only');
  assert.ok((await call('POST', `/applicants/${id}/hold`, { token: admin, body: { reason: 'Applicant abroad', until: manilaDay(0) } })).json.errors.until, 'must end after today');
  assert.ok((await call('POST', `/applicants/${id}/hold`, { token: admin, body: { reason: '', until: manilaDay(10) } })).json.errors.reason, 'reason required');
  const held = await call('POST', `/applicants/${id}/hold`, { token: admin, body: { reason: 'Applicant abroad until December', until: manilaDay(10) } });
  assert.equal(held.status, 200, JSON.stringify(held.json));
  assert.equal(held.json.data.follow_up.state, 'on_hold');
  assert.match(held.json.data.follow_up.tooltip, /^On hold until .*: Applicant abroad until December$/);
  assert.equal((await notes(sales, 'applicant_on_hold', id)).length, 1);
  const released = await call('POST', `/applicants/${id}/hold/release`, { token: admin });
  assert.equal(released.status, 200, JSON.stringify(released.json));
  assert.equal(released.json.data.follow_up.state, 'overdue', 'the 10 days before the hold still count');
  assert.deepEqual((await q(`select kind from applicant_follow_up_events where applicant_id = $1 order by id`, [id])).map((e) => e.kind), ['hold', 'hold_released']);
  assert.equal((await q(`select count(*)::int c from audit_logs where action in ('applicant.put_on_hold', 'applicant.hold_released') and auditable_id = $1`, [id]))[0].c, 2);

  // The time on hold does not count: 16 days in stage, of which 5 on hold -> 11 days -> Overdue, not Stalled.
  const paused = await applicant(16);
  await q(`update applicants set on_hold_at = $2, hold_ended_at = $3, on_hold_reason = 'x' where id = $1`, [paused, ago(6), ago(1)]);
  const view = await state(paused);
  assert.deepEqual([view.state, view.days], ['overdue', 11]);
});

test('Log follow-up: only the assigned Sales user, reason + next action date; clears Overdue until that date; Admin is notified', async () => {
  const id = await applicant(8);
  const path = `/applicants/${id}/follow-ups`;
  const body = { kind: 'overdue', reason: 'not_responding', notes: 'Called twice, no answer.', next_action_date: manilaDay(2) };
  assert.equal((await call('POST', path, { token: admin, body })).status, 403);
  assert.equal((await call('POST', path, { token: otherSales, body })).status, 403);
  assert.ok((await call('POST', path, { token: sales, body: { ...body, reason: '' } })).json.errors.reason);
  assert.ok((await call('POST', path, { token: sales, body: { ...body, next_action_date: '' } })).json.errors.next_action_date);
  assert.match(firstError(await call('POST', path, { token: sales, body: { ...body, next_action_date: manilaDay(-1) } })), /cannot be in the past/);
  assert.match(firstError(await call('POST', path, { token: sales, body: { ...body, reason: 'other', notes: '' } })), /when you choose Other/);
  const saved = await call('POST', path, { token: sales, body });
  assert.equal(saved.status, 201, JSON.stringify(saved.json));
  assert.equal(saved.json.data.follow_up_state.state, null, 'cleared until the next action date');
  assert.equal(saved.json.data.follow_ups[0].kind, 'overdue');
  assert.equal(saved.json.data.follow_ups[0].reason, 'not_responding');
  const [alert] = await notes(admin, 'applicant_follow_up_logged', id);
  assert.match(alert.title, /^Follow-up logged: Fu Person/);
  assert.match(alert.message, /Applicant not responding — Called twice, no answer\. Next action:/);
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'applicant.follow_up_logged' and auditable_id = $1`, [id]))[0].c, 1);
  // The existing contact follow-up still works as before.
  const contact = await call('POST', path, { token: sales, body: { contacted_at: ago(0.01), channel: 'call', outcome: 'reached', notes: 'Talked about the packages.' } });
  assert.equal(contact.status, 201, JSON.stringify(contact.json));
  assert.deepEqual(contact.json.data.follow_ups.map((f: any) => f.kind).sort(), ['contact', 'overdue']);

  // The next action date passes with no further update -> Overdue again.
  const later = await applicant(20);
  await salesAction(later, 3);
  await q(`insert into follow_ups (followable_type, followable_id, user_id, actor_role, contacted_at, notes, next_follow_up_at, kind, reason, created_at)
    values ('applicant', $1, $2, 'sales', $3, '', $4, 'overdue', 'still_deciding', $3)`, [later, salesUser.id, ago(3), ago(1)]);
  const view = await state(later);
  assert.equal(view.state, 'overdue');
  assert.match(view.tooltip, /next action date .* passed/);
});

test('Send reminder: Admin only, Overdue/Stalled only, 1 per applicant per 24h, notifies the assigned Sales user, logged and audited', async () => {
  const id = await applicant(9);
  const draft = await call('GET', `/applicants/${id}/reminder-draft`, { token: admin });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.match(draft.json.data.message, /please follow up with Fu Person \d+ \(APL-FU-\d+\)\. They have been 9 day\(s\) in Scheduled/);
  assert.equal(draft.json.data.assigned_sales.full_name, salesUser.full_name);
  const path = `/applicants/${id}/reminders`;
  assert.equal((await call('POST', path, { token: sales, body: { message: 'Please call them.' } })).status, 403);
  assert.ok((await call('POST', path, { token: admin, body: { message: 'Hi' } })).json.errors.message);
  const sent = await call('POST', path, { token: admin, body: { message: 'Please call them today.' } });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  assert.equal(sent.json.message, `Reminder sent to ${salesUser.full_name}.`);
  assert.equal(sent.json.data.follow_up.last_reminder.by, 'System Administrator');
  assert.ok(sent.json.data.follow_up.next_reminder_at, 'the next reminder time is known');
  assert.equal(sent.json.data.follow_up.reminded, true, 'the chip reads Reminder sent / Reminder from Admin');
  assert.equal(sent.json.data.follow_up.state, 'overdue', 'still Overdue underneath');
  const [bell] = await notes(sales, 'applicant_reminder', id);
  assert.match(bell.title, /^Reminder from Admin: Fu Person \d+$/);
  assert.equal(bell.message, 'Please call them today.');
  assert.equal((await notes(otherSales, 'applicant_reminder', id)).length, 0, 'only the assigned Sales user');
  const again = await call('POST', path, { token: admin, body: { message: 'Please call them today.' } });
  assert.equal(again.status, 422);
  assert.match(firstError(again), /Next reminder available at/);
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'applicant.reminder_sent' and auditable_id = $1`, [id]))[0].c, 1);
  assert.equal((await q(`select count(*)::int c from applicant_stage_histories where event = 'follow_up_reminder_sent' and applicant_id = $1`, [id]))[0].c, 1);
  const events = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.follow_up_events;
  assert.equal(events[0].kind, 'reminder');
  // "Reminder sent" lasts until Sales updates or the stage changes (both start a new timer).
  const bySales = await applicant(9);
  await call('POST', `/applicants/${bySales}/reminders`, { token: admin, body: { message: 'Please call them today.' } });
  assert.equal((await state(bySales)).reminded, true);
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_by_user_id, changed_at, actor_role, event)
    select id, status, status, $2, now() + interval '1 second', 'sales', 'assessment_saved' from applicants where id = $1`, [bySales, salesUser.id]);
  assert.deepEqual([(await state(bySales)).state, (await state(bySales)).reminded], [null, false], 'a Sales update ends it');
  await q(`insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_by_user_id, changed_at, actor_role) values ($1, 'converted', 'scheduled', $2, now() + interval '1 second', 'admin')`, [id, adminUser.id]);
  assert.equal((await state(id)).reminded, false, 'a stage change ends it');

  // After 24 hours another reminder may be sent.
  const old = await applicant(9);
  await q(`insert into applicant_follow_up_events (applicant_id, kind, user_id, to_user_id, message, created_at) values ($1, 'reminder', $2, $3, 'old', $4)`, [old, adminUser.id, salesUser.id, ago(1.05)]);
  assert.equal((await call('POST', `/applicants/${old}/reminders`, { token: admin, body: { message: 'Second reminder.' } })).status, 201);
  // Not for an applicant on track, nor one without a Sales user.
  assert.match(firstError(await call('POST', `/applicants/${await applicant(2)}/reminders`, { token: admin, body: { message: 'Please call.' } })), /Only an Overdue or Stalled/);
  assert.match(firstError(await call('POST', `/applicants/${await applicant(9, 'scheduled', { assigned_sales_user_id: null })}/reminders`, { token: admin, body: { message: 'Please call.' } })), /Assign a Sales user first/);
});

test('automatic alerts: Overdue -> the assigned Sales user, Stalled -> Admins, once per episode; a new episode alerts again', async () => {
  const id = await applicant(8);
  await runFollowUpAlerts(db, { force: true });
  await runFollowUpAlerts(db, { force: true });
  const overdue = await notes(sales, 'applicant_overdue', id);
  assert.equal(overdue.length, 1, 'once');
  assert.match(overdue[0].title, /^Applicant overdue: Fu Person/);
  assert.equal((await notes(admin, 'applicant_stalled', id)).length, 0);

  // The same episode reaches Stalled (here by lowering the Stalled threshold to 8 days).
  await call('PUT', '/applicants/follow-up-settings', { token: admin, body: { overdue_days: 7, stalled_days: 8 } });
  try {
    await runFollowUpAlerts(db, { force: true });
    assert.equal((await notes(admin, 'applicant_stalled', id)).length, 1, 'Admins at Stalled');
    assert.equal((await notes(sales, 'applicant_overdue', id)).length, 1, 'Sales is not alerted twice in one episode');
  } finally {
    await call('PUT', '/applicants/follow-up-settings', { token: admin, body: { overdue_days: 7, stalled_days: 14 } });
  }
  // Jumping straight to Stalled alerts both.
  const jump = await applicant(15);
  await runFollowUpAlerts(db, { force: true });
  assert.equal((await notes(sales, 'applicant_overdue', jump)).length, 1);
  assert.equal((await notes(admin, 'applicant_stalled', jump)).length, 1);

  // A Sales update starts a new episode; when that one goes Overdue the Sales user is alerted again.
  await salesAction(id, 7.5);
  await runFollowUpAlerts(db, { force: true });
  assert.equal((await notes(sales, 'applicant_overdue', id)).length, 2);

  // Waiting on Admin and On hold never alert.
  const held = await applicant(30, 'for_approval');
  await runFollowUpAlerts(db, { force: true });
  assert.equal((await notes(sales, 'applicant_overdue', held)).length, 0);
  // Throttled when not forced.
  assert.equal((await runFollowUpAlerts(db)).ran, false);
});

test('lists: follow-up filter, Sales pinned group, Needs attention, per-Sales counts', async () => {
  const mine = await applicant(16);
  const theirs = await applicant(20, 'scheduled', { assigned_sales_user_id: otherSalesUser.id });
  const fine = await applicant(1);
  const ids = (res: any) => (res.json.data as any[]).map((a) => Number(a.id));
  const stalledList = await call('GET', '/applicants?follow_up=stalled&per_page=100', { token: admin });
  assert.equal(stalledList.status, 200, JSON.stringify(stalledList.json));
  assert.ok(ids(stalledList).includes(mine) && ids(stalledList).includes(theirs) && !ids(stalledList).includes(fine));
  assert.ok(stalledList.json.data.every((a: any) => a.follow_up.state === 'stalled'));
  assert.ok(!('fu_state' in stalledList.json.data[0]), 'helper columns stay internal');
  assert.ok(firstError(await call('GET', '/applicants?follow_up=sleepy', { token: admin })));

  // Sales: their own Overdue / Stalled first, most days first (another Sales user's are not pinned).
  const list = (await call('GET', '/applicants?per_page=100', { token: sales })).json.data as any[];
  const pinned = list.findIndex((a) => !(['overdue', 'stalled'].includes(a.follow_up?.state) && Number(a.assigned_sales_user_id) === salesUser.id));
  const top = list.slice(0, pinned);
  assert.ok(top.some((a) => Number(a.id) === mine));
  assert.ok(!top.some((a) => Number(a.id) === theirs));
  assert.deepEqual(top.map((a) => a.follow_up.idle_days), [...top.map((a) => a.follow_up.idle_days)].sort((x, y) => y - x));

  const attention = await call('GET', '/applicants/needs-attention', { token: sales });
  assert.equal(attention.status, 200, JSON.stringify(attention.json));
  assert.ok(attention.json.data.some((a: any) => a.id === mine));
  assert.ok(!attention.json.data.some((a: any) => a.id === theirs), 'only their own');
  assert.ok(attention.json.data.every((a: any) => ['overdue', 'stalled'].includes(a.follow_up.state)));

  assert.equal((await call('GET', '/applicants/follow-up-by-sales', { token: sales })).status, 403);
  const bySales = (await call('GET', '/applicants/follow-up-by-sales', { token: admin })).json.data;
  const other = bySales.rows.find((r: any) => r.sales_user_id === otherSalesUser.id);
  assert.ok(other.stalled >= 1);
  assert.ok(!('waiting_admin' in other), 'no Waiting on Admin count');
  assert.ok(bySales.totals.stalled >= 2);
});

test('Close: Admin only, needs a reason, archives with the reason (existing archive rules), logged and audited', async () => {
  const id = await applicant(20);
  assert.equal((await call('POST', `/applicants/${id}/close`, { token: sales, body: { reason: 'No longer interested' } })).status, 403);
  assert.ok((await call('POST', `/applicants/${id}/close`, { token: admin, body: { reason: '' } })).json.errors.reason);
  const closed = await call('POST', `/applicants/${id}/close`, { token: admin, body: { reason: 'Applicant no longer interested' } });
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  const [row] = await q(`select archived_at, archive_reason from applicants where id = $1`, [id]);
  assert.ok(row.archived_at);
  assert.equal(row.archive_reason, 'Applicant no longer interested');
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'applicant.archived' and auditable_id = $1`, [id]))[0].c, 1);
  assert.equal((await call('GET', `/applicants/${id}`, { token: sales })).status, 404, 'Sales no longer sees it, as with any archived applicant');
  // Reassign stays the existing Admin-only action.
  const other = await applicant(20);
  assert.equal((await call('POST', `/applicants/${other}/assign-sales`, { token: sales, body: { assigned_sales_user_id: otherSalesUser.id, reason: 'Workload' } })).status, 403);
  assert.equal((await call('POST', `/applicants/${other}/assign-sales`, { token: admin, body: { assigned_sales_user_id: otherSalesUser.id, reason: 'Workload balancing' } })).status, 200);
});
