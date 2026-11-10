// ActivityController.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, fail, Filter, intParam, ok, paginate, perPage, routeId, updateRow } from '../lib/http.ts';
import { downloadDocument, MAX_UPLOAD_KB, storeDocument } from '../lib/files.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { notifyRoles, notifyUser } from '../services/notifications.ts';
import { applicantJson } from '../services/applicantModel.ts';
import { fileRef, logEvent, logStageChange } from '../services/applicantStage.ts';
import {
  ACTIVITY_ORDER, activityDone, activityLabel, isSchedulable, NOT_SCHEDULABLE, scheduledChecked, setAgainTarget, TRACKED_ACTIVITY_MILESTONES,
} from '../services/pipeline.ts';
import { syncActivity, syncApplicantAttendance, updateActivity } from '../services/schedule/sync.ts';
import * as rules from '../services/schedule/rules.ts';
import { acquireDayLocks, longDateTime, parseLocal, TRACKED_TYPES, VENUE_OPTIONS } from '../services/schedule/rules.ts';
import { assertActivityAllowed, saveActivity } from '../services/schedule/activities.ts';
import { assertAssignedSales, notifyAssignedSales, requireReason } from '../services/accountability.ts';
import { scheduleJson } from './applicants.ts';

export const activityRoutes = new Hono<AppEnv>();
const MODEL = 'App\\Models\\ActivitySchedule';
const viewers = role('admin', 'sales', 'franchisee');
const staff = role('admin', 'sales');
const admin = role('admin');
const STATUSES = 'pending,confirmed,completed,cancelled,no_show';
const VENUES = `in:${VENUE_OPTIONS.join(',')}`;
const TYPES = `in:${TRACKED_TYPES.join(',')}`;
const NAME = (expr: string) => `(select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = ${expr})`;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const SAME_DAY_END = (day: string) => new Date(`${day.slice(0, 10)}T23:59:59+08:00`);
const DAY_START = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00+08:00`);

/** ActivitySchedule::normalizeParticipants: trimmed, de-duplicated without regard to case. */
function normalizeParticipants(names: unknown[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function validateParticipants(input: Row) {
  if (!Array.isArray(input.participants)) return;
  input.participants.forEach((name: unknown, index: number) => {
    if (name !== null && (typeof name !== 'string' || name.length > 255)) fail(`participants.${index}`, 'The participant name must be a string of at most 255 characters.');
  });
}

const load = async (c: Context<AppEnv>): Promise<Row> => requireFound(
  (await c.get('deps').db.query(`select s.*, (select to_jsonb(a) from applicants a where a.id = s.applicant_id) as applicant from activity_schedules s where s.id = $1`, [routeId(c, 'activity')]))[0],
);
const stripRelation = ({ applicant: _a, ...row }: Row) => row;
const withPeople = async (db: Db, id: number, relations: 'applicant' | 'full' = 'applicant') => {
  const [row] = await db.query(
    `select s.*, (select to_jsonb(a) from applicants a where a.id = s.applicant_id) as applicant, ${NAME('s.assigned_to_user_id')} as assigned_to
       ${relations === 'full' ? `, ${NAME('s.scheduled_by_user_id')} as scheduled_by` : ''}
     from activity_schedules s where s.id = $1`, [id],
  );
  return { ...scheduleJson(row), applicant: row.applicant ? applicantJson(row.applicant) : null };
};
const plain = async (db: Db, id: number) => scheduleJson((await db.query(`select * from activity_schedules where id = $1`, [id]))[0]);

function listFilter(c: Context<AppEnv>): Filter {
  const q = c.req.query();
  const f = new Filter();
  if (boolParam(q.calendar)) f.add(`s.status in ('pending', 'confirmed') and s.approval_status <> 'rejected'`);
  if (q.status) f.add('s.status = ?', q.status);
  if (q.from) f.add('s.starts_at >= ?', DAY_START(q.from));
  if (q.to) f.add('s.starts_at <= ?', SAME_DAY_END(q.to));
  const name = roleName(c);
  if (name === 'franchisee') f.add('exists (select 1 from applicants a where a.id = s.applicant_id and a.user_id = ?)', c.get('user').id);
  if (name === 'sales') f.add('not exists (select 1 from applicants a where a.id = s.applicant_id and a.archived_at is not null)');
  return f;
}

activityRoutes.get('/activities', viewers, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  const f = listFilter(c);
  if (q.activity_type) f.add('s.activity_type = ?', q.activity_type);
  if (q.assigned_to_user_id) f.add('s.assigned_to_user_id = ?', intParam(q.assigned_to_user_id));
  const hideArchive = roleName(c) === 'sales';
  return paginate(c, db, {
    columns: `s.*, (select jsonb_build_object('id', a.id, 'full_name', a.full_name, 'email', a.email, 'user_id', a.user_id, 'status', a.status${hideArchive ? '' : `, 'archived_at', a.archived_at`}) from applicants a where a.id = s.applicant_id) as applicant,
      ${NAME('s.assigned_to_user_id')} as assigned_to, ${NAME('s.scheduled_by_user_id')} as scheduled_by`,
    from: 'activity_schedules s', where: f.clauses, params: f.params, orderBy: 's.starts_at', perPage: perPage(c, 30), map: scheduleJson,
  });
});

activityRoutes.get('/activities/grouped', viewers, async (c) => {
  const { db } = c.get('deps');
  const q = c.req.query();
  await validate(db, q, { from: ['nullable', 'date'], to: ['nullable', 'date', 'after_or_equal:from'] });
  const name = roleName(c);
  const hideArchive = name === 'sales';
  const f = listFilter(c);
  if (q.applicant_id) f.add('s.applicant_id = ?', intParam(q.applicant_id));
  f.add(`exists (select 1 from activity_schedules o where o.applicant_id = s.applicant_id and (o.status = 'completed' or (o.status in ('pending', 'confirmed') and o.approval_status <> 'rejected')))`);
  const activities = await db.query(
    `select s.*, (select jsonb_build_object('id', a.id, 'full_name', a.full_name, 'status', a.status${hideArchive ? '' : `, 'archived_at', a.archived_at`}, 'milestones', a.milestones) from applicants a where a.id = s.applicant_id) as applicant,
       ${NAME('s.assigned_to_user_id')} as assigned_to, ${NAME('s.scheduled_by_user_id')} as scheduled_by
     from activity_schedules s ${f.where} order by s.starts_at`, f.params,
  );
  const rejected: Record<number, Row[]> = {};
  if (!boolParam(q.calendar) && activities.length) {
    const events = await db.query(
      `select id, auditable_id, old_values from audit_logs where action = 'activity.rejected' and auditable_type = $1 and auditable_id = any($2::bigint[]) order by id`,
      [MODEL, `{${activities.map((a) => a.id).join(',')}}`],
    );
    for (const e of events) (rejected[e.auditable_id] ??= []).push(e);
  }
  const groups = new Map<string, Row>();
  const now = Date.now();
  for (const raw of activities) {
    const activity = scheduleJson(raw);
    const person = normalizeParticipants([raw.applicant?.full_name])[0];
    if (!person) continue;
    const key = person.toLowerCase();
    const isApplicant = raw.applicant && raw.applicant.full_name.toLowerCase() === key;
    const archivedAt = raw.applicant?.archived_at;
    if (!groups.has(key)) {
      groups.set(key, {
        person, applicant_id: isApplicant ? raw.applicant_id : null,
        ...(hideArchive ? {} : { is_archived: isApplicant ? Boolean(archivedAt) : false, archived_at: isApplicant ? iso(archivedAt) : null }),
        applicant_status: isApplicant ? raw.applicant.status : null, total: 0, completed: 0, upcoming: 0, activities: [],
      });
    }
    const group = groups.get(key)!;
    group.total += 1;
    if (raw.status === 'completed') group.completed += 1;
    if (!['completed', 'cancelled'].includes(raw.status) && new Date(raw.starts_at).getTime() > now) group.upcoming += 1;
    group.activities.push(activity);
    for (const event of rejected[raw.id] ?? []) {
      const proposal = event.old_values?.proposed_changes;
      if (!proposal) continue;
      const { _previous_approval_status: _p, ...rest } = proposal;
      group.activities.push({ ...activity, ...rest, id: `rejected-adjustment-${event.id}`, status: 'cancelled', approval_status: 'rejected', is_missed: false, result_notes: null, completed_at: null });
    }
  }
  // Read-time filter: an applicant with all three activities DONE leaves the Data panel.
  const hidden = new Set<number>();
  if (!boolParam(q.include_completed)) {
    const seen = new Map<number, Row>();
    for (const a of activities) if (a.applicant) seen.set(a.applicant.id, a.applicant);
    for (const applicant of seen.values()) {
      if (Object.values(TRACKED_ACTIVITY_MILESTONES).every((k) => applicant.milestones?.[k]) && await scheduledChecked(db, applicant)) hidden.add(applicant.id);
    }
  }
  return ok(c, [...groups.values()].filter((g) => !g.applicant_id || !hidden.has(g.applicant_id)));
});

activityRoutes.get('/activities/session-preview', viewers, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, c.req.query(), {
    activity_type: ['required', TYPES], starts_at: ['required', 'date'], applicant_id: ['nullable', 'exists:applicants,id'], ignore_activity_id: ['nullable', 'integer', 'min:1'],
  });
  const [applicant] = v.applicant_id ? await db.query(`select preferred_brand_id from applicants where id = $1`, [v.applicant_id]) : [];
  const occupancy = await rules.sessionOccupancy(db, v.activity_type, parseLocal(v.starts_at), applicant?.preferred_brand_id ?? null, v.ignore_activity_id ?? null);
  return ok(c, { ...occupancy, existing_session: v.activity_type === 'training' && occupancy.attending > 0 });
});

async function resolveSessionKey(db: Db, v: Row, startsAt: Date, brandId: number | null): Promise<string> {
  if (v.separate_session) return `separate-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const requested = String(v.session_id ?? '');
  if (!requested) return '';
  const found = await db.query(
    `select 1 from activity_schedules s where s.activity_type = $1 and s.starts_at = $2 and s.session_key = $3 and s.approval_status <> 'rejected'
       and ($1 <> 'product_tasting' or exists (select 1 from applicants a where a.id = s.applicant_id and a.preferred_brand_id = $4::bigint)) limit 1`,
    [v.activity_type, startsAt, requested, brandId],
  );
  if (!found.length) fail('session_id', 'That session no longer exists at this date/time. Join another session or create a separate one.');
  return requested;
}

activityRoutes.post('/activities', staff, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const input = await readInput(c);
  validateParticipants(input);
  const v = await validate(db, input, {
    applicant_id: ['required', 'exists:applicants,id'], activity_type: ['required', TYPES], title: ['required', 'string', 'max:255'], starts_at: ['required', 'date'],
    duration_minutes: ['nullable', 'integer', 'min:60', 'max:600'], ends_at: ['nullable', 'date'], venue: ['nullable', VENUES], meeting_link: ['nullable', 'string', 'max:500'],
    status: ['nullable', `in:${STATUSES}`], assigned_to_user_id: ['nullable', 'exists:users,id'], participants: ['nullable', 'array'], session_id: ['nullable', 'string', 'max:60'], separate_session: ['nullable', 'boolean'],
  });
  const applicantId = Number(v.applicant_id);
  const [applicant] = await db.query(`select * from applicants where id = $1`, [applicantId]);
  if (!isSchedulable(applicant)) fail('applicant_id', NOT_SCHEDULABLE);
  const window = rules.resolveWindow(parseLocal(v.starts_at), v.duration_minutes ?? null, v.ends_at ?? null);
  const sessionKey = await resolveSessionKey(db, v, window.starts_at, applicant.preferred_brand_id);
  await rules.assertCapacity(db, v.activity_type, window.starts_at, applicant.preferred_brand_id, null, sessionKey);
  await rules.assertNoConflict(db, applicantId, window.starts_at, window.ends_at);
  await rules.assertNoDuplicate(db, applicantId, v.title, window.starts_at);

  const activity = await db.tx(async (tx) => {
    await tx.query(`select id from applicants where id = $1 for update`, [applicantId]);
    await rules.assertPrerequisiteDone(tx, applicantId, v.activity_type);
    await rules.assertSlotFree(tx, applicantId, v.activity_type);
    await rules.assertNotPreviouslyCompleted(tx, applicantId, v.activity_type);
    await rules.assertNoOtherActiveSchedule(tx, applicantId);
    await rules.assertNoConflict(tx, applicantId, window.starts_at, window.ends_at);
    return saveActivity(tx, null, {
      applicant_id: applicantId, activity_type: v.activity_type, title: v.title, ...window, venue: v.venue ?? null, meeting_link: v.meeting_link ?? null,
      assigned_to_user_id: v.assigned_to_user_id ?? null, session_key: sessionKey, participants: normalizeParticipants(v.participants ?? []), status: 'confirmed',
      scheduled_by_user_id: user.id, approval_status: roleName(c) === 'sales' ? 'pending_admin' : 'immediate',
    }, user);
  });
  if (applicant.user_id) await notifyUser(db, applicant.user_id, 'schedule_created', 'Activity scheduled', `${activity.title} is scheduled for ${longDateTime(new Date(activity.starts_at))}.`, { activity_id: activity.id });
  if (activity.approval_status === 'pending_admin') {
    await notifyRoles(db, ['admin'], 'schedule_pending_approval', 'Activity awaiting approval', `Activity #${activity.id} for ${applicant.applicant_code} (${applicant.full_name}) is awaiting approval.`, { activity_id: activity.id, applicant_id: applicantId });
  }
  await audit(c, db, 'activity.created', { type: MODEL, id: activity.id }, null, activity);
  return ok(c, await withPeople(db, activity.id), 'Activity scheduled.', 201);
});

activityRoutes.post('/applicants/:applicant/activities/set-again', staff, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const id = routeId(c, 'applicant');
  const [applicant] = await db.query(`select * from applicants where id = $1`, [id]);
  requireFound(applicant);
  const firstTarget = await setAgainTarget(db, applicant);
  const input = await readInput(c);
  validateParticipants(input);
  const v = await validate(db, input, {
    starts_at: ['required', 'date'], duration_minutes: ['nullable', 'integer', 'min:60', 'max:600'], ends_at: ['nullable', 'date'], venue: ['nullable', VENUES],
    meeting_link: ['nullable', 'string', 'max:500'], assigned_to_user_id: ['nullable', 'exists:users,id'], participants: ['nullable', 'array'],
  });
  const window = rules.resolveWindow(parseLocal(v.starts_at), v.duration_minutes ?? null, v.ends_at ?? null);
  const isSales = roleName(c) === 'sales';
  await rules.assertCapacity(db, firstTarget, window.starts_at, applicant.preferred_brand_id);
  const activity = await db.tx(async (tx) => {
    const [locked] = await tx.query(`select * from applicants where id = $1 for update`, [id]);
    const target = await setAgainTarget(tx, locked);
    await rules.assertNoPendingRequest(tx, id);
    await rules.assertSlotFree(tx, id, target);
    await rules.assertNoOtherActiveSchedule(tx, id);
    await rules.assertNoDuplicate(tx, id, activityLabel(target), window.starts_at);
    await rules.assertNoConflict(tx, id, window.starts_at, window.ends_at);
    return saveActivity(tx, null, {
      applicant_id: id, activity_type: target, title: activityLabel(target), ...window, venue: v.venue ?? null, meeting_link: v.meeting_link ?? null,
      participants: normalizeParticipants(v.participants ?? []), status: 'confirmed', assigned_to_user_id: v.assigned_to_user_id ?? null, scheduled_by_user_id: user.id,
      approval_status: isSales ? 'pending_admin' : 'immediate',
    }, user);
  });
  if (applicant.user_id) await notifyUser(db, applicant.user_id, 'schedule_created', 'Activity scheduled', `${activity.title} is scheduled for ${longDateTime(new Date(activity.starts_at))}.`, { activity_id: activity.id });
  if (activity.approval_status === 'pending_admin') {
    await notifyRoles(db, ['admin'], 'schedule_pending_approval', 'Next activity awaiting approval', `Activity #${activity.id} for ${applicant.applicant_code} (${applicant.full_name}) is awaiting approval.`, { activity_id: activity.id, applicant_id: id });
  }
  await audit(c, db, 'activity.set_again', { type: MODEL, id: activity.id }, null, activity);
  return ok(c, await withPeople(db, activity.id), isSales ? 'Next activity requested; awaiting Admin approval.' : 'Next activity scheduled.', 201);
});

activityRoutes.get('/activities/:activity', viewers, async (c) => {
  const { db } = c.get('deps');
  const a = await load(c);
  if (roleName(c) === 'sales' && a.applicant?.archived_at) abort(404, 'Record not found.');
  if (roleName(c) === 'franchisee' && a.applicant?.user_id !== c.get('user').id) abort(403, 'This action is unauthorized.');
  return ok(c, await withPeople(db, a.id, 'full'));
});

async function assertNoActiveType(db: Db, applicantId: number, type: string, ignoreId: number) {
  const found = await db.query(`select 1 from activity_schedules where applicant_id = $1 and activity_type = $2 and status in ('pending', 'confirmed') and approval_status <> 'rejected' and id <> $3 limit 1`, [applicantId, type, ignoreId]);
  if (found.length) fail('activity_type', 'An active schedule already exists for this activity.');
}

async function adjust(c: Context<AppEnv>) {
  const { db } = c.get('deps');
  const user = c.get('user');
  const input = await readInput(c);
  validateParticipants(input);
  const v = await validate(db, input, {
    activity_type: ['sometimes', TYPES], title: ['sometimes', 'required', 'string', 'max:255'], starts_at: ['sometimes', 'date'], duration_minutes: ['nullable', 'integer', 'min:60', 'max:600'],
    ends_at: ['nullable', 'date'], venue: ['nullable', VENUES], meeting_link: ['nullable', 'string', 'max:500'], status: ['sometimes', `in:${STATUSES}`],
    assigned_to_user_id: ['nullable', 'exists:users,id'], participants: ['nullable', 'array'], result_notes: ['nullable', 'string'],
  });
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (applicant?.archived_at || activity.approval_status === 'rejected' || !['pending', 'confirmed'].includes(activity.status)) fail('status', 'Only an ongoing schedule can be adjusted.');
  delete v.status;
  const nextType = v.activity_type ?? activity.activity_type;
  if (nextType !== activity.activity_type) {
    await rules.assertPrerequisiteDone(db, activity.applicant_id, nextType);
    await rules.assertSlotFree(db, activity.applicant_id, nextType, activity.id);
  }
  await assertNoActiveType(db, activity.applicant_id, nextType, activity.id);
  await rules.assertNotPreviouslyCompleted(db, activity.applicant_id, nextType, activity.id);
  await rules.assertNoOtherActiveSchedule(db, activity.applicant_id, activity.id);
  const window = rules.resolveWindow(parseLocal(v.starts_at ?? activity.starts_at), 'duration_minutes' in v ? (v.duration_minutes || null) : null, v.ends_at ?? activity.ends_at);
  const assigned = 'assigned_to_user_id' in v ? (v.assigned_to_user_id ? Number(v.assigned_to_user_id) : null) : activity.assigned_to_user_id;
  await rules.assertNoConflict(db, activity.applicant_id, window.starts_at, window.ends_at, activity.id);
  await rules.assertCapacity(db, nextType, window.starts_at, applicant?.preferred_brand_id ?? null, activity.id, String(activity.session_key ?? ''));
  await rules.assertNoDuplicate(db, activity.applicant_id, v.title ?? activity.title, window.starts_at, activity.id);

  if (roleName(c) === 'sales') {
    // A Sales adjustment is only a proposal; the rules are checked on the proposed values now and again on approval.
    await db.tx(async (tx) => {
      await acquireDayLocks(tx, [window.starts_at, activity.starts_at]);
      await assertActivityAllowed(tx, { ...activity, ...(v.activity_type ? { activity_type: v.activity_type } : {}), ...('venue' in v ? { venue: v.venue } : {}), ...window, assigned_to_user_id: assigned }, user);
    });
    const proposal = { ...v, starts_at: rules.iso8601(window.starts_at), ends_at: rules.iso8601(window.ends_at), duration_minutes: window.duration_minutes, _previous_approval_status: activity.approval_status };
    const saved = await db.tx((tx) => saveActivity(tx, activity, { proposed_changes: proposal, approval_status: 'pending_admin' }, user));
    await notifyRoles(db, ['admin'], 'schedule_pending_approval', 'Schedule adjustment awaiting approval', `Activity #${activity.id} has a proposed adjustment.`, { activity_id: activity.id });
    await audit(c, db, 'activity.adjustment_requested', { type: MODEL, id: activity.id }, activity, saved);
    return ok(c, await plain(db, activity.id), 'Adjustment requested; awaiting Admin approval.');
  }
  const saved = await db.tx((tx) => saveActivity(tx, activity, {
    ...v, ...window, assigned_to_user_id: assigned, proposed_changes: null, approval_status: 'immediate',
    participants: 'participants' in v ? normalizeParticipants(v.participants ?? []) : activity.participants,
  }, user));
  if (applicant?.user_id) await notifyUser(db, applicant.user_id, 'schedule_updated', 'Activity schedule updated', `${saved.title} has been updated.`, { activity_id: activity.id });
  await audit(c, db, 'activity.updated', { type: MODEL, id: activity.id }, activity, saved);
  return ok(c, await withPeople(db, activity.id), 'Activity updated.');
}
activityRoutes.put('/activities/:activity', staff, adjust);
activityRoutes.put('/activities/:activity/move', admin, adjust);

const PROOF_MODEL = 'App\\Models\\ActivitySchedule';
const PROOF_TYPE = 'attendance_proof';
const proofDocuments = (db: Db, activityId: number) => db.query(
  `select id, original_name, mime_type, size_bytes, created_at, replaced_at, (select u.full_name from users u where u.id = d.uploaded_by_user_id) as uploaded_by
   from documents d where documentable_type = $1 and documentable_id = $2 and type = $3 order by id`, [PROOF_MODEL, activityId, PROOF_TYPE],
);

/**
 * Sales completes an activity: never before its exact start time (server time), with either the
 * attendance (actual time, handler, notes, proof file) or a No Show and its reason. A completion
 * Admin returned is corrected and submitted again here.
 */
activityRoutes.post('/activities/:activity/complete', role('sales'), async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (applicant?.archived_at || !['pending', 'confirmed'].includes(activity.status) || activity.approval_status !== 'immediate') {
    fail('status', `This activity has approval_status = ${activity.approval_status}. It cannot be completed until it is approved.`);
  }
  if (applicant) await assertAssignedSales(c, applicant);
  const startsAt = new Date(activity.starts_at);
  const now = new Date();
  if (now.getTime() < startsAt.getTime()) fail('complete', `Available on ${rules.availableLabel(startsAt)}.`);

  const v = await validate(db, await readInput(c), {
    attended: ['required', 'in:yes,no,true,false,1,0'],
    actual_started_at: ['nullable', 'date'],
    handler_name: ['nullable', 'string', 'max:255'],
    result_notes: ['nullable', 'string', 'max:5000'],
    no_show_reason: ['nullable', 'string', 'max:2000'],
    proof: ['nullable', 'file', 'mimes:pdf,jpg,jpeg,png', `max:${MAX_UPLOAD_KB}`],
  });
  const attended = ['yes', 'true', '1'].includes(String(v.attended));
  const type = activity.activity_type;
  const resubmitted = activity.review_status === 'returned';
  let changes: Row;
  let notes: string;
  if (attended) {
    if (!v.actual_started_at) fail('actual_started_at', 'Enter the actual date and time the activity started.');
    const actual = parseLocal(v.actual_started_at);
    // Compared to the minute: the form picks a minute, the schedule may carry seconds.
    if (actual.getTime() < Math.floor(startsAt.getTime() / 60000) * 60000) fail('actual_started_at', `The actual time cannot be before the scheduled start (${rules.availableLabel(startsAt)}).`);
    if (actual.getTime() > now.getTime()) fail('actual_started_at', 'The actual time cannot be in the future.');
    const handler = String(v.handler_name ?? '').trim();
    if (!handler) fail('handler_name', 'Enter who handled the activity.');
    notes = String(v.result_notes ?? '').trim();
    if (notes.length < 10) fail('result_notes', 'Write notes of at least 10 characters about what happened.');
    if (!v.proof) fail('proof', 'Attach the attendance proof (sign-in sheet or photo).');
    changes = {
      status: 'completed', attended: true, actual_started_at: actual, handler_name: handler, result_notes: notes, no_show_reason: null,
      ...(type === 'product_tasting' ? { tasted_brand_id: applicant?.preferred_brand_id ?? null } : {}),
    };
  } else {
    notes = requireReason(v.no_show_reason, 'no_show_reason', 'a No Show reason');
    changes = { status: 'no_show', attended: false, actual_started_at: null, handler_name: null, no_show_reason: notes };
  }
  Object.assign(changes, {
    completed_at: now, completion_submitted_at: now, completion_submitted_by_user_id: user.id,
    review_status: 'submitted', reviewed_by_user_id: null, reviewed_at: null, return_reason: null,
  });

  const { saved, proof, replaced } = await db.tx(async (tx) => {
    const previousProofs = attended ? await tx.query(
      `select id, original_name, type from documents where documentable_type = $1 and documentable_id = $2 and type = $3 and replaced_at is null and removed_at is null`,
      [PROOF_MODEL, activity.id, PROOF_TYPE],
    ) : [];
    const stored = attended ? await storeDocument(c, tx, v.proof, `activities/${activity.id}/proof`, { type: PROOF_MODEL, id: activity.id }, PROOF_TYPE) : null;
    if (stored && previousProofs.length) {
      await tx.query(`update documents set replaced_at = now(), replaced_by_document_id = $1 where id = any($2::bigint[])`, [stored.id, `{${previousProofs.map((d) => d.id).join(',')}}`]);
    }
    const row = await saveActivity(tx, activity, changes, user);
    if (applicant) {
      await logEvent(tx, applicant, attended ? 'activity_completed' : 'activity_no_show', user.id, { activity_id: activity.id, activity_type: type },
        notes, {
          step: type,
          old_values: { status: activity.status, review_status: activity.review_status ?? null },
          new_values: {
            status: changes.status, attended, actual_started_at: attended ? rules.iso8601(changes.actual_started_at) : null, handler_name: changes.handler_name ?? null,
            scheduled_start: rules.iso8601(startsAt), resubmitted,
          },
          attachments: [fileRef(stored), ...previousProofs.map((d) => ({ ...fileRef(d), state: 'replaced' }))].filter(Boolean) as Row[],
        });
    }
    return { saved: row, proof: stored, replaced: previousProofs };
  });
  if (applicant?.user_id && attended) await notifyUser(db, applicant.user_id, 'activity_result', 'Activity result recorded', `The result for ${activity.title} has been recorded.`, { activity_id: activity.id });
  if (applicant) {
    const what = attended ? `marked Complete with attendance proof${resubmitted ? ' (corrected and resubmitted)' : ''}` : `marked No Show: ${notes}`;
    await notifyRoles(db, ['admin'], 'applicant_activity_completed', attended ? 'Activity marked Complete' : 'Activity marked No Show',
      `${activityLabel(type)} for ${applicant.applicant_code} was ${what}. Review the proof and mark it Attended or Return it.`, { applicant_id: applicant.id, activity_id: activity.id }, user);
  }
  await audit(c, db, attended ? 'activity.completed' : 'activity.no_show', { type: MODEL, id: activity.id }, activity, { ...saved, proof_document_id: proof?.id ?? null, replaced_document_ids: replaced.map((d: Row) => d.id) });
  return ok(c, { ...(await plain(db, activity.id)), proof_documents: await proofDocuments(db, activity.id) }, attended ? 'Activity completed — waiting for Admin to review the proof.' : 'Activity marked No Show. Use Set Again to reschedule it.');
});

/** Admin reviewed the proof and notes: Attended (the milestone is saved) — the second half of Done. */
activityRoutes.post('/activities/:activity/attended', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (!applicant || applicant.archived_at) fail('applicant', 'An archived applicant cannot be updated.');
  if (activity.status !== 'completed') fail('status', 'Only an activity Sales marked Complete can be marked Attended.');
  if (activity.review_status === 'accepted') return ok(c, await plain(db, activity.id), 'Already marked Attended.');
  const type = activity.activity_type;
  const key = TRACKED_ACTIVITY_MILESTONES[type];
  if (!key) fail('activity_type', 'Only Orientation, Product Tasting and Training are tracked.');
  const index = ACTIVITY_ORDER.indexOf(type);
  if (index > 0) {
    const previous = ACTIVITY_ORDER[index - 1];
    if (!(await activityDone(db, applicant, previous))) fail('activity_type', `${activityLabel(previous)} must be Done before ${activityLabel(type)} can be marked Attended.`);
  }
  const milestones = { ...(applicant.milestones ?? {}) };
  const details = { ...(applicant.milestone_details ?? {}) };
  const firstTime = !milestones[key];
  if (firstTime) {
    milestones[key] = true;
    const at = activity.actual_started_at ?? activity.completed_at ?? activity.starts_at;
    details[key] = { on: rules.iso8601(at)?.slice(0, 16), by: `${user.full_name} (Admin)`, by_user_id: user.id };
  }
  await db.tx(async (tx) => {
    if (firstTime) await updateRow(tx, 'applicants', applicant.id, { milestones, milestone_details: details });
    await tx.query(`update activity_schedules set review_status = 'accepted', reviewed_by_user_id = $1, reviewed_at = now() where id = $2`, [user.id, activity.id]);
    const fresh = (await tx.query(`select * from applicants where id = $1`, [applicant.id]))[0];
    await syncApplicantAttendance(tx, fresh, user.id);
    await logEvent(tx, applicant, 'activity_attended', user.id, { activity_id: activity.id, activity_type: type }, null, {
      step: type, old_values: { review_status: activity.review_status ?? null, [key]: Boolean(applicant.milestones?.[key]) }, new_values: { review_status: 'accepted', [key]: true },
    });
    await audit(c, tx, 'activity.attended', { type: MODEL, id: activity.id }, { review_status: activity.review_status }, { review_status: 'accepted' });
  });
  await notifyAssignedSales(db, applicant, 'activity_attended', 'Activity accepted', `Admin marked ${activityLabel(type)} for ${applicant.full_name} as Attended.`, { activity_id: activity.id }, user);
  return ok(c, await plain(db, activity.id), `${activityLabel(type)} marked Attended.`);
});

/** Admin returns a completion (or No Show) to Sales with a reason; Sales corrects and submits again. */
activityRoutes.post('/activities/:activity/return', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (!applicant || applicant.archived_at) fail('applicant', 'An archived applicant cannot be updated.');
  if (!['completed', 'no_show'].includes(activity.status) || !activity.completion_submitted_at) fail('status', 'Only a completion Sales submitted can be returned.');
  if (activity.review_status === 'accepted') fail('status', 'This activity is already marked Attended and cannot be returned.');
  if (activity.status === 'no_show') {
    const [later] = await db.query(
      `select 1 from activity_schedules where applicant_id = $1 and activity_type = $2 and id <> $3 and status not in ('cancelled', 'no_show') and approval_status <> 'rejected' limit 1`,
      [activity.applicant_id, activity.activity_type, activity.id],
    );
    if (later) fail('status', 'This No Show was already rescheduled with Set Again, so it can no longer be returned.');
  }
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  const reason = requireReason(v.reason, 'reason', 'a return reason');
  await db.tx(async (tx) => {
    // Back to a live, already-started schedule so Sales can complete it again. The submitted
    // values stay in the history record and the activity log.
    const row = await updateActivity(tx, activity, {
      status: 'confirmed', completed_at: null, review_status: 'returned', reviewed_by_user_id: user.id, reviewed_at: new Date(), return_reason: reason,
    });
    await syncActivity(tx, row, user.id);
    await logEvent(tx, applicant, 'activity_returned', user.id, { activity_id: activity.id, activity_type: activity.activity_type }, reason, {
      step: activity.activity_type,
      old_values: { status: activity.status, review_status: activity.review_status, attended: activity.attended, actual_started_at: rules.iso8601(activity.actual_started_at), handler_name: activity.handler_name, result_notes: activity.result_notes, no_show_reason: activity.no_show_reason },
      new_values: { status: 'confirmed', review_status: 'returned' },
    });
    await audit(c, tx, 'activity.returned', { type: MODEL, id: activity.id }, activity, { review_status: 'returned', reason });
  });
  await notifyAssignedSales(db, applicant, 'activity_returned', 'Activity returned to Sales', `Admin returned ${activityLabel(activity.activity_type)} for ${applicant.full_name}: ${reason}`, { activity_id: activity.id }, user);
  return ok(c, await plain(db, activity.id), 'Returned to Sales.');
});

/** The attendance proof: Admin and the assigned Sales user only. */
activityRoutes.get('/activities/:activity/documents/:document/download', staff, async (c) => {
  const { db } = c.get('deps');
  const loaded = await load(c);
  const { applicant } = loaded;
  if (roleName(c) === 'sales') {
    if (!applicant || applicant.archived_at) abort(404, 'Record not found.');
    await assertAssignedSales(c, applicant);
  }
  const [d] = await db.query(`select * from documents where id = $1 and documentable_type = $2 and documentable_id = $3`, [routeId(c, 'document'), PROOF_MODEL, loaded.id]);
  return downloadDocument(c, requireFound(d));
});


activityRoutes.delete('/activities/:activity', admin, async (c) => {
  const { db } = c.get('deps');
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (applicant?.archived_at || applicant?.status === 'active_franchisee' || activity.approval_status === 'rejected' || !['pending', 'confirmed'].includes(activity.status)) {
    fail('status', 'Only an ongoing schedule for an active applicant can be cancelled.');
  }
  await db.tx(async (tx) => {
    await tx.query(`select id from applicants where id = $1 for update`, [activity.applicant_id]);
    const completed = await tx.query(`select 1 from activity_schedules where applicant_id = $1 and status = 'completed' limit 1`, [activity.applicant_id]);
    const schedules = completed.length ? [activity]
      : await tx.query(`select * from activity_schedules where applicant_id = $1 and status in ('pending', 'confirmed') and approval_status <> 'rejected' for update`, [activity.applicant_id]);
    for (const schedule of schedules) {
      const saved = await saveActivity(tx, schedule, { status: 'cancelled', cancelled_at: new Date(), proposed_changes: null }, c.get('user'));
      await audit(c, tx, 'activity.cancelled', { type: MODEL, id: schedule.id }, schedule, saved);
    }
  });
  return ok(c, null, 'Schedule cancelled.');
});

activityRoutes.post('/activities/:activity/approve', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (activity.approval_status !== 'pending_admin') fail('approval_status', 'Only schedules with approval_status = pending_admin can be approved.');
  if (applicant?.archived_at || !['pending', 'confirmed'].includes(activity.status)) fail('status', 'Only an ongoing schedule can be approved.');
  const { _previous_approval_status: _p, ...proposal } = activity.proposed_changes ?? {};
  const changes: Row = { ...proposal };
  if (Object.keys(proposal).length) {
    const type = proposal.activity_type ?? activity.activity_type;
    await rules.assertNoConflict(db, activity.applicant_id, parseLocal(proposal.starts_at), parseLocal(proposal.ends_at), activity.id);
    await rules.assertSlotFree(db, activity.applicant_id, type, activity.id);
    await rules.assertPrerequisiteDone(db, activity.applicant_id, type);
    await assertNoActiveType(db, activity.applicant_id, type, activity.id);
    await rules.assertNotPreviouslyCompleted(db, activity.applicant_id, type, activity.id);
    await rules.assertNoOtherActiveSchedule(db, activity.applicant_id, activity.id);
    changes.starts_at = parseLocal(proposal.starts_at);
    changes.ends_at = parseLocal(proposal.ends_at);
    if ('participants' in changes) changes.participants = normalizeParticipants(changes.participants ?? []);
  }
  const saved = await db.tx((tx) => saveActivity(tx, activity, { ...changes, proposed_changes: null, approval_status: 'immediate', approved_by_user_id: user.id, approved_at: new Date() }, user));
  if (applicant?.status === 'qualified') {
    await db.query(`update applicants set status = 'scheduled' where id = $1`, [applicant.id]);
    await db.query(`insert into applicant_status_histories (applicant_id, from_status, to_status, changed_by_user_id, remarks) values ($1, 'qualified', 'scheduled', $2, 'Schedule approved.')`, [applicant.id, user.id]);
    await logStageChange(db, applicant.id, 'qualified', 'scheduled', user.id, 'Schedule approved.', 'scheduled', { activity_id: activity.id });
  }
  if (applicant?.user_id) await notifyUser(db, applicant.user_id, 'activity_approved', 'Activity approved', `${activity.title} has been approved.`, { activity_id: activity.id });
  await audit(c, db, 'activity.approved', { type: MODEL, id: activity.id }, activity, saved);
  return ok(c, await plain(db, activity.id), 'Activity approved.');
});

activityRoutes.post('/activities/:activity/reject', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const loaded = await load(c);
  const { applicant } = loaded;
  const activity = stripRelation(loaded);
  if (activity.approval_status !== 'pending_admin') fail('approval_status', 'Only schedules with approval_status = pending_admin can be rejected.');
  // A rejected adjustment reverts to the approved schedule; a rejected new request stays rejected.
  const isAdjustment = activity.proposed_changes?._previous_approval_status === 'immediate';
  const saved = await db.tx((tx) => saveActivity(tx, activity, { approval_status: isAdjustment ? 'immediate' : 'rejected', proposed_changes: null, approved_by_user_id: user.id, approved_at: new Date() }, user));
  if (applicant?.user_id) await notifyUser(db, applicant.user_id, 'activity_rejected', 'Activity rejected', `${activity.title} has been rejected.`, { activity_id: activity.id });
  await audit(c, db, 'activity.rejected', { type: MODEL, id: activity.id }, activity, saved);
  return ok(c, await plain(db, activity.id), 'Activity rejected.');
});
