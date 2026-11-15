// Orientation and Product Tasting are one activity: Orientation/Tasting (stored key 'orientation').
// Completion carries attendance proof (1–10), a brand selection document (1–2) and the selected
// brand; Admin opens every current file before Verify; legacy records and the merge script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, SALES, setup } from '../support/harness.ts';
import { createStaff } from '../support/accounts.ts';
import { orientationForm, pdf, viewAll } from '../support/orientation.ts';
import { mergeProductTasting } from '../../supabase/scripts/merge_product_tasting.ts';
import { fillMissingHandlers } from '../../supabase/scripts/fill_missing_handlers.ts';
import { alignSessionToActivity } from '../../supabase/scripts/align_session_to_activity.ts';
import { normalizeSessionCapacity } from '../../supabase/scripts/normalize_session_capacity.ts';

const { pg, db, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brandA, brandB] = await q(`select id, name from brands order by id limit 2`);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);
const otherSales = await createStaff(call, admin, { full_name: 'Tasting Sales Two', email: 'tasting.sales2@example.test', phone: '09179990027', role: 'sales' });
// A second Admin (User Management cannot create one): a staff account promoted in the test database.
const secondAdmin = await createStaff(call, admin, { full_name: 'Second Admin', email: 'tasting.admin2@example.test', phone: '09179990028', role: 'sales' });
await q(`update users set role_id = (select role_id from users where email = $1) where email = 'tasting.admin2@example.test'`, [ADMIN]);

let dayOffset = 40;
function nextSlot(hour = '09:00'): string {
  dayOffset += 1;
  const d = new Date();
  let left = dayOffset;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1;
  }
  return `${d.toISOString().slice(0, 10)}T${hour}:00+08:00`;
}
let counter = 0;
async function applicant(status = 'scheduled', brandId = brandA.id) {
  counter += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, preferred_brand_id, application_date, assigned_sales_user_id) values ($1, $2, $3, '2026-01-01', $4) returning id`,
    [`Tasting Person ${counter}`, status, brandId, salesUser.id],
  );
  return a.id as number;
}
/** Booked by Admin, then moved into the past (the start has passed). */
async function started(applicantId: number) {
  const res = await call('POST', '/activities', { token: admin, body: { applicant_id: applicantId, activity_type: 'orientation', title: 'Orientation/Tasting', starts_at: nextSlot(), duration_minutes: 60, venue: 'Virtual' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await q(`update activity_schedules set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [res.json.data.id]);
  return res.json.data.id as number;
}
const complete = (id: number, form: FormData, token = sales) => call('POST', `/activities/${id}/complete`, { token, form });
const notes = (type: string, applicantId: number) => q(`select user_id from system_notifications where type = $1 and (data->>'applicant_id')::bigint = $2 order by id`, [type, applicantId]);

test('completion rules: only the assigned Sales user, not before the start, 1–10 attendance files, 1–2 brand documents, a brand', async () => {
  const id = await applicant();
  const res = await call('POST', '/activities', { token: admin, body: { applicant_id: id, activity_type: 'orientation', title: 'Orientation/Tasting', starts_at: nextSlot(), duration_minutes: 60, venue: 'Virtual' } });
  const activity = res.json.data.id;
  assert.match((await complete(activity, orientationForm({ brandId: brandA.id }))).json.errors.complete[0], /^Available on/, 'not before the session start');
  await q(`update activity_schedules set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [activity]);

  assert.equal((await complete(activity, orientationForm({ brandId: brandA.id }), otherSales)).status, 403, 'another Sales user cannot complete it');
  assert.equal((await complete(activity, orientationForm({ brandId: brandA.id }), admin)).status, 403, 'Admin does not complete it');
  assert.ok((await complete(activity, orientationForm({ brandId: brandA.id, attendance: 0 }))).json.errors.attendance);
  assert.match((await complete(activity, orientationForm({ brandId: brandA.id, attendance: 11 }))).json.errors.attendance[0], /at most 10/);
  assert.ok((await complete(activity, orientationForm({ brandId: brandA.id, brandDocs: 0 }))).json.errors.brand_document);
  assert.match((await complete(activity, orientationForm({ brandId: brandA.id, brandDocs: 3 }))).json.errors.brand_document[0], /at most 2/);
  assert.ok((await complete(activity, orientationForm({ brandId: null }))).json.errors.selected_brand_id);
  assert.ok((await complete(activity, orientationForm({ brandId: 999999 }))).json.errors.selected_brand_id, 'the brand must exist');
  const fake = orientationForm({ brandId: brandA.id, attendance: 0 });
  fake.append('attendance', new File([new Uint8Array([1, 2, 3])], 'renamed.pdf', { type: 'application/pdf' }));
  assert.match((await complete(activity, fake)).json.errors.attendance[0], /not a real PDF/);
  const wrongType = orientationForm({ brandId: brandA.id, brandDocs: 0 });
  wrongType.append('brand_document', new File([new Uint8Array([1])], 'notes.docx'));
  assert.match((await complete(activity, wrongType)).json.errors.brand_document[0], /PDF, JPG or PNG/);

  const ok = await complete(activity, orientationForm({ brandId: brandB.id, attendance: 10, brandDocs: 2 }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.review_status, 'submitted');
  assert.equal(Number(ok.json.data.selected_brand_id), brandB.id);
  assert.equal(ok.json.data.proof_documents.filter((d: any) => d.type === 'attendance_proof').length, 10);
  assert.equal(ok.json.data.proof_documents.filter((d: any) => d.type === 'brand_selection').length, 2);
  assert.equal(Number((await q(`select preferred_brand_id from applicants where id = $1`, [id]))[0].preferred_brand_id), brandA.id, 'the brand changes only on Verify');
  assert.equal((await notes('applicant_activity_completed', id)).length >= 1, true, 'Admin is notified on submit');
});

test('Verify: every current file opened by THIS Admin after the latest submission; not by the encoder; Return needs a reason', async () => {
  const id = await applicant();
  const activity = await started(id);
  const first = await complete(activity, orientationForm({ brandId: brandA.id, attendance: 2 }));
  const docs = first.json.data.proof_documents;
  assert.equal(docs.every((d: any) => d.viewed_by_me === false), true);

  const blocked = await call('POST', `/activities/${activity}/attended`, { token: admin });
  assert.equal(blocked.status, 422);
  assert.match(blocked.json.errors.verify[0], /Open every submitted file before verifying. Not opened yet: attendance-1.pdf, attendance-2.pdf, brand-1.pdf/);
  // Two of three opened: still blocked, naming the one left.
  await viewAll(call, admin, activity, docs.slice(0, 2));
  assert.match((await call('POST', `/activities/${activity}/attended`, { token: admin })).json.errors.verify[0], /Not opened yet: brand-1.pdf\.$/);
  const detail = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.schedules.find((s: any) => s.id === activity);
  assert.deepEqual(detail.proof_documents.map((d: any) => d.viewed_by_me), [true, true, false], 'the Viewed marks come from the server');
  // Another Admin's views do not count for this one.
  await viewAll(call, secondAdmin, activity, docs);
  assert.match((await call('POST', `/activities/${activity}/attended`, { token: admin })).json.errors.verify[0], /brand-1.pdf/);

  // Return, then resubmit keeping one attendance file and replacing the rest: views must be done again.
  assert.ok((await call('POST', `/activities/${activity}/return`, { token: admin, body: {} })).json.errors.reason, 'Return needs a reason');
  assert.equal((await call('POST', `/activities/${activity}/return`, { token: admin, body: { reason: 'The brand document is not signed.' } })).status, 200);
  assert.deepEqual((await notes('activity_returned', id)).map((n) => Number(n.user_id)), [salesUser.id], 'Sales is notified on Return');
  const keep = docs.filter((d: any) => d.type === 'attendance_proof').slice(0, 1).map((d: any) => d.id);
  const badKeep = await complete(activity, orientationForm({ brandId: brandA.id, attendance: 0, keep: [999999] }));
  assert.ok(badKeep.json.errors.keep_document_ids, 'only files of this submission can be kept');
  const second = await complete(activity, orientationForm({ brandId: brandA.id, attendance: 0, brandDocs: 1, keep }));
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const current = second.json.data.proof_documents.filter((d: any) => !d.replaced_at);
  assert.equal(current.length, 2, 'the kept attendance file + the new brand document');
  assert.equal(current.every((d: any) => d.viewed_by_me === false), true, 'a resubmission needs every file opened again');
  assert.match((await call('POST', `/activities/${activity}/attended`, { token: admin })).json.errors.verify[0], /Not opened yet/);

  // The encoder cannot verify their own submission.
  await q(`update activity_schedules set completion_submitted_by_user_id = $1 where id = $2`, [adminUser.id, activity]);
  await viewAll(call, admin, activity, current);
  assert.match((await call('POST', `/activities/${activity}/attended`, { token: admin })).json.errors.verify[0], /another Admin must verify/);
  await q(`update activity_schedules set completion_submitted_by_user_id = $1 where id = $2`, [salesUser.id, activity]);

  const verified = await call('POST', `/activities/${activity}/attended`, { token: admin });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal(verified.json.message, 'Orientation/Tasting verified.');
  assert.ok((await notes('activity_attended', id)).some((n) => Number(n.user_id) === salesUser.id), 'Sales is notified on Verify');
  const [a] = await q(`select milestones, brand_locked_at from applicants where id = $1`, [id]);
  assert.equal(a.milestones.orientation_attended, true, 'Verify marks attended');
  assert.ok(a.brand_locked_at);

  // Verified is locked: no resubmission, no Return.
  assert.equal((await complete(activity, orientationForm({ brandId: brandB.id }))).status, 422);
  assert.equal((await call('POST', `/activities/${activity}/return`, { token: admin, body: { reason: 'Changed my mind.' } })).status, 422);
});

test('legacy: an Orientation done under the old flow by an applicant past Scheduling verifies without files', async () => {
  const id = await applicant('loi_submitted');
  const [row] = await q(
    `insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, attended, completed_at, completion_submitted_at, completion_submitted_by_user_id, review_status, approval_status, scheduled_by_user_id)
     values ($1, 'orientation', 'Orientation', now() - interval '9 days', now() - interval '9 days', 'completed', true, now() - interval '9 days', now() - interval '9 days', $2, 'submitted', 'immediate', $3) returning id`,
    [id, salesUser.id, adminUser.id],
  );
  const verified = await call('POST', `/activities/${row.id}/attended`, { token: admin });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  assert.equal(Number((await q(`select preferred_brand_id from applicants where id = $1`, [id]))[0].preferred_brand_id), brandA.id, 'the brand stays');

  // The same old-flow submission of an applicant still at Scheduling must go through the new flow.
  const current = await applicant('scheduled');
  const [old] = await q(
    `insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, attended, completed_at, completion_submitted_at, completion_submitted_by_user_id, review_status, approval_status, scheduled_by_user_id)
     values ($1, 'orientation', 'Orientation', now() - interval '2 days', now() - interval '2 days', 'completed', true, now() - interval '2 days', now() - interval '2 days', $2, 'submitted', 'immediate', $3) returning id`,
    [current, salesUser.id, adminUser.id],
  );
  assert.match((await call('POST', `/activities/${old.id}/attended`, { token: admin })).json.errors.verify[0], /Return it so Sales submits them/);
});

test('session rules on create and edit: 1-hour buffer for the same Sales user, Training H4 across Sales users', async () => {
  const a = await applicant();
  const b = await applicant();
  const day = nextSlot('09:00').slice(0, 10);
  const at = (h: string) => `${day}T${h}:00+08:00`;
  const first = await call('POST', '/activities', { token: admin, body: { applicant_id: a, activity_type: 'orientation', title: 'Orientation/Tasting', starts_at: at('09:00'), duration_minutes: 120, venue: 'Virtual' } });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const tooClose = await call('POST', '/activities', { token: admin, body: { applicant_id: b, activity_type: 'orientation', title: 'Orientation/Tasting', starts_at: at('11:30'), duration_minutes: 60, venue: 'Virtual', separate_session: true } });
  assert.equal(tooClose.status, 422);
  assert.match(JSON.stringify(tooClose.json), /next allowed start after it is 12:00 PM/);
  const later = await call('POST', '/activities', { token: admin, body: { applicant_id: b, activity_type: 'orientation', title: 'Orientation/Tasting', starts_at: at('12:00'), duration_minutes: 60, venue: 'Virtual', separate_session: true } });
  assert.equal(later.status, 201, JSON.stringify(later.json));
  // Editing the later one back inside the buffer is refused too.
  const edit = await call('PUT', `/activities/${later.json.data.id}`, { token: admin, body: { starts_at: at('11:00'), duration_minutes: 60 } });
  assert.equal(edit.status, 422);
  assert.match(JSON.stringify(edit.json), /1 hour between sessions/);

  // Training: two Sales users may not overlap (H4 kept).
  const t1 = await applicant('scheduled');
  const t2 = await applicant('scheduled');
  const [otherUser] = await q(`select id from users where email = 'tasting.sales2@example.test'`);
  await q(`update applicants set assigned_sales_user_id = $1 where id = $2`, [otherUser.id, t2]);
  const tStart = nextSlot('10:00');
  const tEnd = tStart.replace('T10', 'T11');
  const evalT = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'training', brand_id: brandA.id, start_at: tStart, end_at: tEnd, applicant_ids: [t1], handler_id: salesUser.id } });
  assert.ok(evalT.json.data, 'evaluated');
  await q(`insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity, handler_id, brand_id) values ('training', $1, $2, 'confirmed', 10, $3, $4)`, [tStart, tEnd, otherUser.id, brandA.id]);
  const overlap = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'training', brand_id: brandA.id, start_at: tStart, end_at: tEnd, applicant_ids: [t1], handler_id: salesUser.id } });
  assert.match(overlap.json.data.reasons.join(' '), /Training sessions cannot overlap/, 'another Sales user overlapping Training is refused (H4 kept)');
  void t2;
});

/** A Product Tasting seat as the old flow stored it. */
async function oldTasting(applicantId: number, status: string) {
  const [s] = await q(`insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity, handler_id, brand_id) values ('product_tasting', now() - interval '5 days', now() - interval '5 days' + interval '1 hour', 'confirmed', 15, $1, $2) returning id`, [salesUser.id, brandA.id]);
  const [t] = await q(
    `insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, completed_at, approval_status, scheduled_by_user_id, session_key)
     values ($1, 'product_tasting', 'Product Tasting', now() - interval '5 days', now() - interval '5 days' + interval '1 hour', $2, $3, 'immediate', $4, $5) returning id`,
    [applicantId, status, status === 'completed' ? new Date() : null, adminUser.id, `session-${s.id}`],
  );
  await q(`insert into schedule_session_participants (session_id, applicant_id, activity_schedule_id, attendance_status) values ($1, $2, $3, $4)`, [s.id, applicantId, t.id, status === 'completed' ? 'attended' : 'scheduled']);
  const [d] = await q(`insert into documents (documentable_type, documentable_id, type, original_name, stored_name, path, disk, mime_type, size_bytes, uploaded_by_user_id) values ('App\\Models\\ActivitySchedule', $1, 'attendance_proof', 'tasting.pdf', 'tasting.pdf', 'x/tasting.pdf', 'private', 'application/pdf', 10, $2) returning id`, [t.id, salesUser.id]);
  return { session: s.id as number, tasting: t.id as number, document: d.id as number };
}
async function oldOrientation(applicantId: number) {
  const [o] = await q(
    `insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, attended, completed_at, completion_submitted_at, completion_submitted_by_user_id, review_status, reviewed_at, reviewed_by_user_id, approval_status, scheduled_by_user_id)
     values ($1, 'orientation', 'Orientation', now() - interval '9 days', now() - interval '9 days' + interval '1 hour', 'completed', true, now() - interval '9 days', now() - interval '9 days', $2, 'accepted', now() - interval '8 days', $3, 'immediate', $3) returning id`,
    [applicantId, salesUser.id, adminUser.id],
  );
  await q(`update applicants set milestones = '{"orientation_attended": true, "product_tasting_attended": true}', milestone_details = '{"orientation_attended": {"on": "2026-11-01T09:00"}}' where id = $1`, [applicantId]);
  return o.id as number;
}

test('merge script: dry-run changes nothing; apply removes tastings, moves files, keeps legacy, reopens Scheduling', async () => {
  const legacy = await applicant('payment_submitted');
  const legacyOrientation = await oldOrientation(legacy);
  const legacyTasting = await oldTasting(legacy, 'completed');
  const reopen = await applicant('scheduled');
  const reopenOrientation = await oldOrientation(reopen);
  const reopenTasting = await oldTasting(reopen, 'confirmed');
  const labelOnly = await applicant('scheduled');
  const [live] = await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id) values ($1, 'orientation', 'Orientation', now() + interval '3 days', now() + interval '3 days 1 hour', 'confirmed', 'immediate', $2) returning id`, [labelOnly, adminUser.id]);

  const ids = [legacy, reopen, labelOnly];
  const dry = await mergeProductTasting(db, ids, false);
  assert.deepEqual(dry.map((p) => [p.id, p.action, p.legacy, p.reopen]), [[legacy, 'merge', true, false], [reopen, 'merge', false, true], [labelOnly, 'nothing to do', false, false]]);
  assert.equal((await q(`select count(*)::int n from activity_schedules where activity_type = 'product_tasting' and applicant_id = any($1::bigint[])`, [`{${ids.join(',')}}`]))[0].n, 2, 'the dry-run changes nothing');

  await mergeProductTasting(db, ids, true);
  assert.equal((await q(`select count(*)::int n from activity_schedules where activity_type = 'product_tasting' and applicant_id = any($1::bigint[])`, [`{${ids.join(',')}}`]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from schedule_sessions where id = any($1::bigint[])`, [`{${legacyTasting.session},${reopenTasting.session}}`]))[0].n, 0);
  assert.equal(Number((await q(`select documentable_id from documents where id = $1`, [legacyTasting.document]))[0].documentable_id), legacyOrientation, 'the tasting proof moved to the Orientation record');

  const [l] = await q(`select milestones from applicants where id = $1`, [legacy]);
  assert.equal(l.milestones.orientation_attended, true, 'legacy stays done');
  assert.equal('product_tasting_attended' in l.milestones, false);
  assert.equal((await q(`select status from activity_schedules where id = $1`, [legacyOrientation]))[0].status, 'completed');

  const [r] = await q(`select milestones, milestone_details from applicants where id = $1`, [reopen]);
  assert.equal('orientation_attended' in r.milestones, false, 'reopened: not attended any more');
  assert.equal('orientation_attended' in r.milestone_details, false);
  const [o] = await q(`select status, review_status, completion_submitted_at from activity_schedules where id = $1`, [reopenOrientation]);
  assert.deepEqual([o.status, o.review_status, o.completion_submitted_at], ['confirmed', null, null]);
  const [history] = await q(`select old_values, actor_role from applicant_stage_histories where applicant_id = $1 and event = 'orientation_tasting_reopened'`, [reopen]);
  assert.equal(history.actor_role, 'system');
  assert.equal(history.old_values.orientation.status, 'completed', 'the old dates stay in history');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'applicant.orientation_tasting_merged' and auditable_id = any($1::bigint[])`, [`{${ids.join(',')}}`]))[0].n, 2);
  assert.equal((await q(`select status from activity_schedules where id = $1`, [live.id]))[0].status, 'confirmed', 'label only: untouched');

  // The reopened applicant now completes under the new flow and Admin verifies it.
  const submitted = await complete(reopenOrientation, orientationForm({ brandId: brandA.id }));
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  await viewAll(call, admin, reopenOrientation, submitted.json.data.proof_documents);
  assert.equal((await call('POST', `/activities/${reopenOrientation}/attended`, { token: admin })).status, 200);

  // Running it again finds nothing left to remove.
  const again = await mergeProductTasting(db, ids, false);
  assert.equal(again.every((p) => p.action === 'nothing to do'), true, JSON.stringify(again.map((p) => p.action)));
  void pdf;
});

test('a handler is always set: sessions and activities default to the assigned Sales user, so the buffer applies', async () => {
  const a = await applicant();
  const b = await applicant();
  const day = nextSlot('09:00').slice(0, 10);
  const at = (h: string) => `${day}T${h}:00+08:00`;
  const created = await call('POST', '/schedule-sessions', { token: admin, body: { activity_type: 'orientation', start_at: at('09:00'), end_at: at('10:00'), applicant_ids: [a] } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(Number(created.json.data.session.handler_id), salesUser.id, 'no handler sent: the assigned Sales user');
  const [mirror] = await q(`select assigned_to_user_id from activity_schedules where applicant_id = $1`, [a]);
  assert.equal(Number(mirror.assigned_to_user_id), salesUser.id, 'the activity row carries the handler too');
  // Without a handler in the request the 1-hour buffer still applies.
  const near = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'orientation', start_at: at('10:30'), end_at: at('11:30'), applicant_ids: [b] } });
  assert.match(near.json.data.reasons.join(' '), /1 hour between sessions/);
  // An edit that clears the handler falls back to the assigned Sales user.
  const edited = await call('PUT', `/schedule-sessions/${created.json.data.session.id}`, { token: admin, body: { handler_id: null } });
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(Number((await q(`select handler_id from schedule_sessions where id = $1`, [created.json.data.session.id]))[0].handler_id), salesUser.id);
});

test('handler backfill script: sets the assigned Sales user, reports unassigned applicants, logs every change', async () => {
  const assigned = await applicant();
  const unassigned = await applicant();
  await q(`update applicants set assigned_sales_user_id = null where id = $1`, [unassigned]);
  const sessionFor = async (id: number) => {
    const [s] = await q(`insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity) values ('orientation', now() + interval '20 days', now() + interval '20 days 1 hour', 'confirmed', 5) returning id`);
    const [act] = await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id, session_key) values ($1, 'orientation', 'Orientation/Tasting', now() + interval '20 days', now() + interval '20 days 1 hour', 'confirmed', 'immediate', $2, $3) returning id`, [id, adminUser.id, `session-${s.id}`]);
    await q(`insert into schedule_session_participants (session_id, applicant_id, activity_schedule_id, attendance_status) values ($1, $2, $3, 'scheduled')`, [s.id, id, act.id]);
    return { session: Number(s.id), activity: Number(act.id) };
  };
  const ok = await sessionFor(assigned);
  const left = await sessionFor(unassigned);
  const dry = await fillMissingHandlers(db, false);
  const find = (kind: string, id: number, list = dry) => list.find((x) => x.kind === kind && x.id === id)!;
  assert.equal(find('session', ok.session).action, 'set');
  assert.equal(find('session', ok.session).handler_id, salesUser.id);
  assert.match(find('session', left.session).reason!, /no assigned Sales user/);
  assert.equal((await q(`select handler_id from schedule_sessions where id = $1`, [ok.session]))[0].handler_id, null, 'the dry-run changes nothing');

  await fillMissingHandlers(db, true);
  assert.equal(Number((await q(`select handler_id from schedule_sessions where id = $1`, [ok.session]))[0].handler_id), salesUser.id);
  assert.equal(Number((await q(`select assigned_to_user_id from activity_schedules where id = $1`, [ok.activity]))[0].assigned_to_user_id), salesUser.id);
  assert.equal((await q(`select handler_id from schedule_sessions where id = $1`, [left.session]))[0].handler_id, null, 'unassigned: left as it is');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'schedule.handler_backfilled' and ((auditable_type = 'App\\Models\\ScheduleSession' and auditable_id = $1) or (auditable_type = 'App\\Models\\ActivitySchedule' and auditable_id = $2))`, [ok.session, ok.activity]))[0].n, 2);
  const again = await fillMissingHandlers(db, false);
  assert.equal(again.some((x) => x.action === 'set' && [ok.session, ok.activity].includes(x.id)), false, 'a second run finds nothing to set for them');
});

test('align script: a completed session moves back to its reopened activity; Sales can then complete it', async () => {
  const id = await applicant();
  const [s] = await q(`insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity, handler_id) values ('orientation', now() + interval '5 days', now() + interval '5 days 1 hour', 'completed', 30, $1) returning id`, [salesUser.id]);
  const [act] = await q(
    `insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id, assigned_to_user_id) values ($1, 'orientation', 'Orientation', now() - interval '10 days', now() - interval '10 days' + interval '2 hours', 'confirmed', 'immediate', $2, $3) returning id, starts_at`,
    [id, adminUser.id, salesUser.id],
  );
  await q(`insert into schedule_session_participants (session_id, applicant_id, activity_schedule_id, attendance_status, sales_completed_at) values ($1, $2, $3, 'completed', now())`, [s.id, id, act.id]);
  const dry = await alignSessionToActivity(db, Number(s.id), Number(act.id), false);
  assert.equal(dry.ok, true, dry.refused);
  assert.equal((await q(`select status from schedule_sessions where id = $1`, [s.id]))[0].status, 'completed', 'the dry-run changes nothing');
  await alignSessionToActivity(db, Number(s.id), Number(act.id), true);
  const [after] = await q(`select status, start_at from schedule_sessions where id = $1`, [s.id]);
  assert.equal(after.status, 'confirmed');
  assert.equal(new Date(after.start_at).getTime(), new Date(act.starts_at).getTime());
  assert.equal((await q(`select attendance_status, sales_completed_at from schedule_session_participants where activity_schedule_id = $1`, [act.id]))[0].attendance_status, 'scheduled');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'schedule.session_aligned_to_activity' and auditable_id = $1`, [s.id]))[0].n, 1);
  // The Master Schedule lists it as confirmed on the activity's day.
  const day = new Date(new Date(act.starts_at).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const listed = (await call('GET', `/schedule-sessions?from=${day}T00:00:00%2B08:00&to=${day}T23:59:00%2B08:00`, { token: admin })).json.data.find((x: any) => x.id === Number(s.id));
  assert.equal(listed?.status, 'confirmed');
  // Sales completes it now (the start has passed).
  const done = await complete(Number(act.id), orientationForm({ brandId: brandA.id }));
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await q(`select attendance_status from schedule_session_participants where activity_schedule_id = $1`, [act.id]))[0].attendance_status, 'completed');
});

test('capacity: an older stored 30 shows as N/5 everywhere; the script sets 5 and reports sessions over 5', async () => {
  const a = await applicant();
  const start = nextSlot('09:00');
  const end = start.replace('T09', 'T10');
  const [s] = await q(`insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity, handler_id) values ('orientation', $1, $2, 'confirmed', 30, $3) returning id`, [start, end, salesUser.id]);
  await q(`insert into schedule_session_participants (session_id, applicant_id, attendance_status) values ($1, $2, 'scheduled')`, [s.id, a]);
  // Master Schedule list, session detail and the schedule modal's merge target all read N/5.
  const day = start.slice(0, 10);
  const listed = (await call('GET', `/schedule-sessions?from=${day}T00:00:00%2B08:00&to=${day}T23:59:00%2B08:00`, { token: admin })).json.data.find((x: any) => x.id === Number(s.id));
  assert.equal(listed.occupancy, '1/5');
  assert.equal(listed.max_capacity, 5);
  const detail = (await call('GET', `/schedule-sessions/${s.id}`, { token: admin })).json.data;
  assert.equal((detail.session ?? detail).occupancy, '1/5');
  const b = await applicant();
  const modal = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'orientation', start_at: start, end_at: end, applicant_ids: [b] } });
  assert.equal(modal.json.data.merge_targets.find((t: any) => t.session_id === Number(s.id))?.occupancy, '1/5');

  // Over 5 seated: reported, not changed.
  const [big] = await q(`insert into schedule_sessions (activity_type, start_at, end_at, status, max_capacity) values ('orientation', now() - interval '30 days', now() - interval '30 days' + interval '1 hour', 'completed', 30) returning id`);
  for (let i = 0; i < 6; i += 1) await q(`insert into schedule_session_participants (session_id, applicant_id, attendance_status) values ($1, $2, 'attended')`, [big.id, await applicant()]);
  const dry = await normalizeSessionCapacity(db, false);
  assert.equal(dry.find((p) => p.id === Number(s.id))?.action, 'set');
  assert.match(dry.find((p) => p.id === Number(big.id))!.reason!, /more than 5/);
  await normalizeSessionCapacity(db, true);
  assert.equal((await q(`select max_capacity from schedule_sessions where id = $1`, [s.id]))[0].max_capacity, 5);
  assert.equal((await q(`select max_capacity from schedule_sessions where id = $1`, [big.id]))[0].max_capacity, 30, 'over 5: left as it is');
  assert.equal((await q(`select count(*)::int n from audit_logs where action = 'schedule.capacity_normalized' and auditable_id = $1`, [s.id]))[0].n, 1);
});

test('History reads a value an older script stored as a JSON string as JSON', async () => {
  const id = await applicant();
  await q(
    `insert into applicant_stage_histories (applicant_id, from_stage, to_stage, changed_at, event, step, old_values, new_values, actor_role)
     values ($1, 'scheduled', 'scheduled', now(), 'orientation_tasting_merged', 'orientation', to_jsonb($2::text), to_jsonb($3::text), 'system')`,
    [id, JSON.stringify({ orientation: { id: 1, status: 'completed' } }), JSON.stringify({ orientation: { id: 1, status: 'confirmed' } })],
  );
  const body = (await call('GET', `/applicants/${id}/history`, { token: admin })).json;
  const list = Array.isArray(body.data) ? body.data : body.data?.items ?? [];
  const row = list.find((h: any) => h.event === 'orientation_tasting_merged');
  assert.equal(row.old_values.orientation.status, 'completed');
  assert.equal(row.new_values.orientation.status, 'confirmed');
});
