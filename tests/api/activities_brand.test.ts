// Phase 2: strict Complete (time, attendance, proof), No Show + Set Again, Admin Attended /
// Return, the legacy early badge — and Addition A: Brand Confirmation and the brand lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, MARKETING, SALES, setup } from '../support/harness.ts';

const { pg, call, login } = await setup();
const admin = await login(ADMIN);
const sales = await login(SALES);
const marketing = await login(MARKETING);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const [brandA, brandB] = await q(`select id, name from brands order by id limit 2`);
const [salesUser] = await q(`select id from users where email = $1`, [SALES]);
const [adminUser] = await q(`select id from users where email = $1`, [ADMIN]);

/** A weekday at the given Manila time, safely in the future. */
let dayOffset = 20;
function nextSlot(hour = '09:00'): string {
  // The next unused weekday: every call gets its own day, whatever today's date is.
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
async function scheduled(brandId = brandA.id) {
  counter += 1;
  const [a] = await q(
    `insert into applicants (full_name, status, preferred_brand_id, application_date, assigned_sales_user_id) values ($1, 'scheduled', $2, '2026-01-01', $3) returning id`,
    [`Phase2 Person ${counter}`, brandId, salesUser.id],
  );
  return a.id as number;
}
function completion(overrides: Record<string, string> = {}) {
  const f = new FormData();
  f.set('attended', 'yes');
  f.set('actual_started_at', new Date(Date.now() - 3600_000).toISOString());
  f.set('handler_name', 'Sales User');
  f.set('result_notes', 'Attended the whole session and asked questions.');
  f.set('proof', new File([new Uint8Array([1])], 'sheet.pdf', { type: 'application/pdf' }));
  for (const [k, v] of Object.entries(overrides)) f.set(k, v);
  return f;
}
const label = (type: string) => ({ orientation: 'Orientation', product_tasting: 'Product Tasting', training: 'Training' } as any)[type];
/** Admin books the activity, then its start time is moved into the past (time passes). */
async function booked(applicantId: number, type: string) {
  const res = await call('POST', '/activities', { token: admin, body: { applicant_id: applicantId, activity_type: type, title: label(type), starts_at: nextSlot(), duration_minutes: 60, venue: 'Virtual' } });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await q(`update activity_schedules set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [res.json.data.id]);
  return res.json.data.id as number;
}
/** Booked, completed by Sales with proof, marked Attended by Admin. */
async function done(applicantId: number, type: string) {
  const id = await booked(applicantId, type);
  const completed = await call('POST', `/activities/${id}/complete`, { token: sales, form: completion() });
  assert.equal(completed.status, 200, JSON.stringify(completed.json));
  const attended = await call('POST', `/activities/${id}/attended`, { token: admin });
  assert.equal(attended.status, 200, JSON.stringify(attended.json));
  return id;
}
const events = (applicantId: number, event: string) => q(`select * from applicant_stage_histories where applicant_id = $1 and event = $2 order by id`, [applicantId, event]);

test('No Show needs a reason, frees the slot, and Set Again reschedules the same activity', async () => {
  const id = await scheduled();
  const activity = await booked(id, 'orientation');
  const noShow = new FormData();
  noShow.set('attended', 'no');
  assert.ok((await call('POST', `/activities/${activity}/complete`, { token: sales, form: noShow })).json.errors.no_show_reason);
  noShow.set('no_show_reason', 'Applicant did not arrive and did not answer calls.');
  const saved = await call('POST', `/activities/${activity}/complete`, { token: sales, form: noShow });
  assert.equal(saved.json.data.status, 'no_show');
  assert.equal((await q(`select attendance_status from schedule_session_participants where activity_schedule_id = $1`, [activity]))[0].attendance_status, 'no_show');
  assert.equal((await call('PATCH', `/applicants/${id}/milestones`, { token: admin, body: { milestones: { orientation_attended: true } } })).status, 422, 'a No Show cannot be marked Attended');

  const again = await call('POST', `/applicants/${id}/activities/set-again`, { token: sales, body: { starts_at: nextSlot(), duration_minutes: 60 } });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.equal(again.json.data.activity_type, 'orientation');
  const [log] = await events(id, 'activity_no_show');
  assert.equal(log.remarks, 'Applicant did not arrive and did not answer calls.');
  assert.equal(log.actor_role, 'sales');
});

test('Admin sees the proof, then marks Attended or Returns it; Sales corrects and resubmits', async () => {
  const id = await scheduled();
  const activity = await booked(id, 'orientation');
  await call('POST', `/activities/${activity}/complete`, { token: sales, form: completion() });

  const detail = (await call('GET', `/applicants/${id}`, { token: admin })).json.data;
  const row = detail.schedules.find((s: any) => s.id === activity);
  assert.equal(row.proof_documents.length, 1, 'Admin can see the proof before deciding');
  assert.equal(row.result_notes, 'Attended the whole session and asked questions.');
  assert.equal(row.handler_name, 'Sales User');
  const proofId = row.proof_documents[0].id;
  assert.equal((await call('GET', `/activities/${activity}/documents/${proofId}/download`, { token: admin })).status, 200);
  assert.equal((await call('GET', `/activities/${activity}/documents/${proofId}/download`, { token: marketing })).status, 403, 'Marketing cannot open the proof');

  assert.equal((await call('POST', `/activities/${activity}/return`, { token: sales, body: { reason: 'Myself' } })).status, 403);
  assert.ok((await call('POST', `/activities/${activity}/return`, { token: admin, body: { reason: 'no' } })).json.errors.reason);
  const returned = await call('POST', `/activities/${activity}/return`, { token: admin, body: { reason: 'The photo does not show the sign-in sheet.' } });
  assert.equal(returned.json.data.status, 'confirmed');
  assert.equal(returned.json.data.review_status, 'returned');
  assert.equal((await call('POST', `/activities/${activity}/attended`, { token: admin })).status, 422, 'nothing to accept until Sales resubmits');

  const again = await call('POST', `/activities/${activity}/complete`, { token: sales, form: completion() });
  assert.equal(again.json.data.review_status, 'submitted');
  assert.equal(again.json.data.proof_documents.length, 2);
  assert.ok(again.json.data.proof_documents[0].replaced_at, 'the first proof is kept, marked Replaced');

  assert.equal((await call('POST', `/activities/${activity}/attended`, { token: sales })).status, 403, 'Sales cannot accept its own completion');
  const accepted = await call('POST', `/activities/${activity}/attended`, { token: admin });
  assert.equal(accepted.json.data.review_status, 'accepted');
  assert.equal((await q(`select milestones from applicants where id = $1`, [id]))[0].milestones.orientation_attended, true);
  assert.equal((await call('POST', `/activities/${activity}/return`, { token: admin, body: { reason: 'Too late now' } })).status, 422, 'an accepted activity cannot be returned');

  const [returnLog] = await events(id, 'activity_returned');
  assert.equal(returnLog.remarks, 'The photo does not show the sign-in sheet.');
  assert.equal(returnLog.old_values.handler_name, 'Sales User');
  assert.equal(Number(returnLog.changed_by_user_id), adminUser.id);
  const completedLogs = await events(id, 'activity_completed');
  assert.equal(completedLogs.length, 2);
  assert.equal(completedLogs[1].new_values.resubmitted, true);
  assert.equal(completedLogs[1].attachments.length, 2, 'new file + the replaced one');
});

test('legacy completions before the schedule are kept and flagged', async () => {
  const id = await scheduled();
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, completed_at, approval_status, scheduled_by_user_id)
           values ($1, 'orientation', 'Orientation', now() + interval '1 day', now() + interval '1 day 1 hour', 'completed', now(), 'immediate', $2)`, [id, adminUser.id]);
  const row = (await call('GET', `/applicants/${id}`, { token: admin })).json.data.schedules[0];
  assert.equal(row.status, 'completed', 'not changed');
  assert.equal(row.completed_before_schedule, true);
  assert.equal(row.legacy_completion, true);
});

test('Brand Confirmation: only after tasting is Done, Sales submits, Admin confirms, Training gated', async () => {
  const id = await scheduled();
  const path = `/applicants/${id}`;
  const submit = (token: string, extra: any = {}) => call('POST', `${path}/brand-confirmation`, {
    token, body: { final_brand_id: brandA.id, confirmation_method: 'call', confirmed_on: '2026-11-01', notes: 'Confirmed by phone after the tasting.', ...extra },
  });
  await done(id, 'orientation');
  assert.match((await submit(sales)).json.errors.brand_confirmation[0], /only after Product Tasting is Done/);
  await done(id, 'product_tasting');

  // Training cannot be scheduled before Admin confirms the brand — through any path.
  const early = await call('POST', '/activities', { token: admin, body: { applicant_id: id, activity_type: 'training', title: 'Training', starts_at: nextSlot(), duration_minutes: 60, venue: 'Virtual' } });
  assert.match(early.json.errors.activity_type[0], /Training can be scheduled only after Admin confirms the brand/);
  assert.match((await call('POST', `${path}/activities/set-again`, { token: admin, body: { starts_at: nextSlot(), duration_minutes: 60 } })).json.errors.activity_type[0], /only after Admin confirms the brand/);
  const sessionTry = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'training', brand_id: brandA.id, start_at: nextSlot('10:00'), end_at: nextSlot('11:00').replace(/T\d{2}/, 'T11'), applicant_ids: [id] } });
  assert.match(sessionTry.json.data.reasons.join(), /only after Admin confirms the brand/, 'Master Schedule too');

  assert.equal((await submit(admin)).status, 403, 'Admin cannot submit for Sales');
  assert.ok((await submit(sales, { notes: '' })).json.errors.notes, 'notes are required');
  const submitted = await submit(sales);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.json));
  assert.equal((await submit(sales)).status, 422, 'one pending submission at a time');
  assert.equal((await call('POST', `${path}/brand-confirmation/confirm`, { token: sales, body: { confirmed: true } })).status, 403, 'Sales cannot confirm for Admin');
  assert.equal((await call('POST', `${path}/brand-confirmation/confirm`, { token: admin, body: {} })).status, 422, 'the second confirmation is required');
  const confirmed = await call('POST', `${path}/brand-confirmation/confirm`, { token: admin, body: { confirmed: true } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.data.brand_confirmation.locked, true);
  assert.equal(confirmed.json.data.brand_confirmation.locked_by, (await q(`select full_name from users where id = $1`, [adminUser.id]))[0].full_name);

  // Locked: no path changes the brand.
  assert.match((await call('PUT', path, { token: admin, body: { preferred_brand_id: brandB.id } })).json.errors.preferred_brand_id[0], /locked/);
  const otherBrandTraining = await call('POST', '/schedule-sessions/evaluate', { token: admin, body: { activity_type: 'training', brand_id: brandB.id, start_at: nextSlot('10:00'), end_at: nextSlot('11:00').replace(/T\d{2}/, 'T11'), applicant_ids: [id] } });
  assert.match(otherBrandTraining.json.data.reasons.join(), /hindi tugma sa brand/, 'a session for another brand is refused');
  assert.equal((await submit(sales)).status, 422, 'nothing to resubmit after the lock');

  // Training is now allowed.
  const training = await call('POST', '/activities', { token: admin, body: { applicant_id: id, activity_type: 'training', title: 'Training', starts_at: nextSlot(), duration_minutes: 60, venue: 'Virtual' } });
  assert.equal(training.status, 201, JSON.stringify(training.json));

  const [confirmedLog] = await events(id, 'brand_confirmed');
  assert.equal(confirmedLog.actor_role, 'admin');
  assert.equal(confirmedLog.new_values.brand_locked, true);
});

test('a final brand other than the tasted one needs a reason and a new Product Tasting first; Return needs a reason', async () => {
  const id = await scheduled(brandA.id);
  const path = `/applicants/${id}`;
  await done(id, 'orientation');
  await done(id, 'product_tasting');
  const body = { final_brand_id: brandB.id, confirmation_method: 'written', confirmed_on: '2026-11-01', notes: 'Applicant wrote that they prefer the other concept.' };
  assert.ok((await call('POST', `${path}/brand-confirmation`, { token: sales, body })).json.errors.change_reason, 'a reason is required for a different brand');
  const first = await call('POST', `${path}/brand-confirmation`, { token: sales, body: { ...body, change_reason: 'Better fit for the location.' } });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.retasting_required, true);

  // Return path, then resubmit.
  assert.ok((await call('POST', `${path}/brand-confirmation/return`, { token: admin, body: {} })).json.errors.reason);
  assert.equal((await call('POST', `${path}/brand-confirmation/return`, { token: admin, body: { reason: 'Attach the written note first.' } })).status, 200);
  const second = await call('POST', `${path}/brand-confirmation`, { token: sales, body: { ...body, change_reason: 'Better fit for the location.' } });
  assert.equal(second.status, 201);

  const blocked = await call('POST', `${path}/brand-confirmation/confirm`, { token: admin, body: { confirmed: true } });
  assert.match(blocked.json.errors.brand_confirmation[0], /was not tasted yet/);
  // Set Again now targets a new Product Tasting for the chosen brand.
  const retaste = await call('POST', `${path}/activities/set-again`, { token: admin, body: { starts_at: nextSlot(), duration_minutes: 60 } });
  assert.equal(retaste.status, 201, JSON.stringify(retaste.json));
  assert.equal(retaste.json.data.activity_type, 'product_tasting');
  await q(`update activity_schedules set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = $1`, [retaste.json.data.id]);
  assert.equal((await call('POST', `/activities/${retaste.json.data.id}/complete`, { token: sales, form: completion() })).status, 200);
  assert.equal((await call('POST', `/activities/${retaste.json.data.id}/attended`, { token: admin })).status, 200);
  const confirmed = await call('POST', `${path}/brand-confirmation/confirm`, { token: admin, body: { confirmed: true } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(Number((await q(`select preferred_brand_id from applicants where id = $1`, [id]))[0].preferred_brand_id), brandB.id);
});

test('the inquiry edit cannot overwrite a locked brand; legacy applicants are locked and not blocked', async () => {
  const created = await call('POST', '/inquiries', { token: marketing, body: { lead_name: 'Lock Lead', first_name: 'Lock', last_name: 'Lead', phone: '09185551234', source: 'facebook', preferred_brand_id: brandA.id } });
  await call('POST', `/inquiries/${created.json.data.id}/endorse`, { token: marketing, body: {} });
  const applicant = (await call('POST', `/inquiries/${created.json.data.id}/convert`, { token: admin, body: { assigned_sales_user_id: salesUser.id } })).json.data;
  await q(`update applicants set status = 'loi_submitted' where id = $1`, [applicant.id]);
  const edit = await call('PUT', `/inquiries/${created.json.data.id}`, {
    token: admin, body: { lead_name: 'Lock Lead', first_name: 'Lock', last_name: 'Lead', phone: '09185551234', source: 'facebook', preferred_brand_id: brandB.id },
  });
  assert.equal(edit.status, 422);
  assert.match(edit.json.errors.preferred_brand_id[0], /Legacy - brand confirmation not captured/);
  assert.equal(Number((await q(`select preferred_brand_id from franchise_inquiries where id = $1`, [created.json.data.id]))[0].preferred_brand_id), brandA.id, 'the inquiry was not saved either');
  const view = (await call('GET', `/applicants/${applicant.id}`, { token: admin })).json.data.brand_confirmation;
  assert.equal(view.legacy, true);
  assert.equal(view.locked, true);

  // A legacy applicant with a Training already on record is not blocked from rescheduling it.
  const id = await scheduled();
  await q(`update applicants set milestones = '{"orientation_attended": true, "product_tasting_attended": true}' where id = $1`, [id]);
  for (const type of ['orientation', 'product_tasting']) {
    await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, completed_at, approval_status, scheduled_by_user_id) values ($1, $2, $3, now() - interval '9 days', now() - interval '9 days', 'completed', now() - interval '9 days', 'immediate', $4)`, [id, type, label(type), adminUser.id]);
  }
  await q(`insert into activity_schedules (applicant_id, activity_type, title, starts_at, ends_at, status, approval_status, scheduled_by_user_id, cancelled_at) values ($1, 'training', 'Training', now() - interval '3 days', now() - interval '3 days', 'no_show', 'immediate', $2, null)`, [id, adminUser.id]);
  const again = await call('POST', `/applicants/${id}/activities/set-again`, { token: admin, body: { starts_at: nextSlot(), duration_minutes: 60 } });
  assert.equal(again.status, 201, JSON.stringify(again.json));
  assert.equal(again.json.data.activity_type, 'training');
});
