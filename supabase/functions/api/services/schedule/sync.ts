// App\Services\Scheduling\ScheduleSessionSync: keeps activity_schedules (one row per applicant
// and activity, read by the pipeline gates) in step with schedule_sessions (the group model).
// Laravel used a model hook with a "muted" flag; here writes call the sync explicitly, so a
// session-API write simply does not call syncActivity and nothing can echo back.
import type { Db, Row } from '../../lib/db.ts';
import { insertRow, updateRow } from '../../lib/http.ts';
import { activityLabel, TRACKED_ACTIVITY_MILESTONES } from '../pipeline.ts';
import { addMinutes, DEFAULT_DURATION, MINUTE, parseLocal, sessionCapacity, TRACKED_TYPES } from './rules.ts';

const DONE_STATUSES = ['completed', 'attended', 'no_show'];
const INACTIVE_STATUSES = ['cancelled', 'removed'];
export const ACTIVITY_TYPES = TRACKED_TYPES;

/** ActivitySchedule::liveSlotKey: a partial-unique guard against a second live record. */
function liveKey(a: Row): string | null {
  // A No Show gives up its slot (Set Again reschedules it), like a cancellation.
  if (a.approval_status === 'rejected' || ['cancelled', 'no_show'].includes(a.status)) return null;
  if (!TRACKED_TYPES.includes(a.activity_type)) return null;
  // A completed Product Tasting keeps its own key, so a re-tasting for a newly chosen brand can be booked.
  if (a.activity_type === 'product_tasting' && a.status === 'completed' && a.id) return `${a.applicant_id}:product_tasting:completed:${a.id}`;
  return `${a.applicant_id}:${a.activity_type}`;
}

/** Older completed tastings still hold the plain key: release it before a re-tasting is booked. */
export const releaseCompletedTastingKeys = (db: Db, applicantId: number) => db.query(
  `update activity_schedules set live_key = applicant_id || ':product_tasting:completed:' || id
   where applicant_id = $1 and activity_type = 'product_tasting' and status = 'completed' and live_key = applicant_id || ':product_tasting'`,
  [applicantId],
);

export async function insertActivity(db: Db, fields: Row): Promise<Row> {
  return insertRow(db, 'activity_schedules', { ...fields, live_key: liveKey({ approval_status: 'immediate', status: 'pending', ...fields }) });
}

export async function updateActivity(db: Db, current: Row, changes: Row): Promise<Row> {
  return (await updateRow(db, 'activity_schedules', current.id, { ...changes, live_key: liveKey({ ...current, ...changes }) }))!;
}

export const activeCountExcept = async (db: Db, sessionId: number, exceptId: number | null | undefined): Promise<number> => (await db.query<{ n: number }>(
  `select count(*)::int as n from schedule_session_participants where session_id = $1 and attendance_status not in ('cancelled', 'removed') and ($2::bigint is null or id <> $2::bigint)`,
  [sessionId, exceptId ?? null],
))[0].n;

const sessionById = async (db: Db, id: number): Promise<Row | null> => (await db.query(`select * from schedule_sessions where id = $1`, [id]))[0] ?? null;
const sameTime = (a: unknown, b: Date) => new Date(a as string).getTime() === b.getTime();

export interface Resolved { type: string; applicant: Row; key: string; fields: Row; participant: Row | null; previous: Row | null; target: Row | null }

async function targetSession(db: Db, key: string, fields: Row, applicantId: number, previous: Row | null): Promise<Row | null> {
  if (key.startsWith('session-')) {
    const session = await sessionById(db, Number(key.slice(8)));
    if (session && session.activity_type === fields.activity_type && sameTime(session.start_at, fields.start_at) && !['merged', 'rescheduled'].includes(session.status)) return session;
    return null;
  }
  if (previous && previous.activity_type === fields.activity_type && sameTime(previous.start_at, fields.start_at) && Number(previous.brand_id ?? 0) === Number(fields.brand_id ?? 0)
    && String(previous.legacy_session_key ?? '') === key && !['merged', 'rescheduled'].includes(previous.status)) return previous;
  const [match] = await db.query(
    `select * from schedule_sessions where activity_type = $1 and start_at = $2 and legacy_session_key = $3 and brand_id is not distinct from $4::bigint
     and status not in ('merged', 'rescheduled') order by id limit 1`,
    [fields.activity_type, fields.start_at, key, fields.brand_id],
  );
  if (match && match.id !== previous?.id) {
    const seated = await db.query(`select 1 from schedule_session_participants where session_id = $1 and applicant_id = $2 limit 1`, [match.id, applicantId]);
    if (seated.length) return null;
  }
  return match ?? null;
}

/** READ-ONLY: where would this activity row live? The guard and the write agree through this. */
export async function resolveActivity(db: Db, activity: Row): Promise<Resolved | null> {
  const type = activity.activity_type;
  if (!ACTIVITY_TYPES.includes(type) || !activity.starts_at) return null;
  const [applicant] = await db.query(`select * from applicants where id = $1`, [activity.applicant_id]);
  if (!applicant) return null;
  const start = parseLocal(activity.starts_at);
  const end = activity.ends_at ? parseLocal(activity.ends_at) : addMinutes(start, Number(activity.duration_minutes) || DEFAULT_DURATION[type] || 120);
  const key = String(activity.session_key ?? '');
  const [participant] = activity.id ? await db.query(`select * from schedule_session_participants where activity_schedule_id = $1`, [activity.id]) : [];
  const previous = participant ? await sessionById(db, participant.session_id) : null;
  const fields = {
    activity_type: type, brand_id: type === 'orientation' ? null : applicant.preferred_brand_id, start_at: start, end_at: end,
    handler_id: activity.assigned_to_user_id ?? null, venue: activity.venue ?? null, meeting_link: activity.meeting_link ?? null,
  };
  return { type, applicant, key, fields, participant: participant ?? null, previous, target: await targetSession(db, key, fields, applicant.id, previous) };
}

function attendanceFrom(activity: Row, applicant: Row, current: Row | null, actorId: number | null): Row {
  if (current?.attendance_status === 'removed') return {};
  const milestone = TRACKED_ACTIVITY_MILESTONES[activity.activity_type];
  const milestones = applicant.milestones ?? {};
  const details = applicant.milestone_details ?? {};
  const status = activity.approval_status === 'rejected' || activity.status === 'cancelled' ? 'cancelled'
    : activity.status === 'no_show' ? 'no_show' : activity.status === 'completed' ? 'completed' : 'scheduled';
  const result: Row = { attendance_status: status };
  if (activity.status === 'completed') {
    result.sales_completed_at = activity.completed_at ?? current?.sales_completed_at ?? null;
    result.sales_completed_by = current?.sales_completed_by ?? (current?.sales_completed_at ? null : actorId);
    if (milestone && milestones[milestone]) {
      const on = details[milestone]?.on;
      result.attendance_status = 'attended';
      result.admin_attended_at = current?.admin_attended_at ?? (on ? parseLocal(on) : null);
      result.admin_attended_by_name = current?.admin_attended_by_name ?? details[milestone]?.by ?? null;
      result.admin_attended_by = current?.admin_attended_by ?? details[milestone]?.by_user_id ?? null;
    }
  }
  return result;
}

const logHistory = (db: Db, sessionId: number, action: string, from: Row | null, to: Row | null, actorId: number | null, remarks: string | null, role: string | null = null) => db.query(
  `insert into schedule_session_history (session_id, action, from_value, to_value, performed_by, performed_by_role, remarks) values ($1, $2, $3, $4, $5, $6, $7)`,
  [sessionId, action, from ? JSON.stringify(from) : null, to ? JSON.stringify(to) : null, actorId, role, remarks],
);

/** An activity_schedules row was written: copy it into its session. Idempotent. */
export async function syncActivity(db: Db, activity: Row, actorId: number | null = null): Promise<void> {
  const resolved = await resolveActivity(db, activity);
  if (!resolved) return;
  const { type, applicant, key, fields, participant, previous } = resolved;
  let session = resolved.target;
  if (!session) {
    if (previous && (await activeCountExcept(db, previous.id, participant?.id)) === 0) {
      session = await updateRow(db, 'schedule_sessions', previous.id, { ...fields, legacy_session_key: key.startsWith('session-') ? `session-${previous.id}` : key });
    } else {
      session = await insertRow(db, 'schedule_sessions', { ...fields, status: 'confirmed', max_capacity: sessionCapacity(type), legacy_session_key: key, created_by: activity.scheduled_by_user_id });
      if (key.startsWith('session-')) {
        session = await updateRow(db, 'schedule_sessions', session!.id, { legacy_session_key: `session-${session!.id}` });
        await db.query(`update activity_schedules set session_key = $1 where id = $2`, [`session-${session!.id}`, activity.id]);
      }
      await logHistory(db, session!.id, 'created', null, { activity_schedule_id: activity.id }, actorId ?? activity.scheduled_by_user_id, 'Created from the activity schedule.');
    }
  } else if (previous && previous.id === session.id && (await activeCountExcept(db, session.id, participant?.id)) === 0) {
    session = await updateRow(db, 'schedule_sessions', session.id, { end_at: fields.end_at, handler_id: fields.handler_id, venue: fields.venue, meeting_link: fields.meeting_link });
  }
  const seat = { session_id: session!.id, applicant_id: applicant.id, ...attendanceFrom(activity, applicant, participant, actorId) };
  if (participant) await updateRow(db, 'schedule_session_participants', participant.id, seat);
  else await insertRow(db, 'schedule_session_participants', { activity_schedule_id: activity.id, ...seat });

  await recomputeStatus(db, session!.id, actorId);
  if (previous && previous.id !== session!.id) await recomputeStatus(db, previous.id, actorId);
}

/** Admin's Attended marks were saved: re-read them into the participant rows. */
export async function syncApplicantAttendance(db: Db, applicant: Row, actorId: number | null): Promise<void> {
  const rows = await db.query(`select * from activity_schedules where applicant_id = $1 and activity_type = any($2::text[])`, [applicant.id, `{${ACTIVITY_TYPES.join(',')}}`]);
  for (const activity of rows) await syncActivity(db, activity, actorId);
}

export async function forgetActivity(db: Db, activityId: number, actorId: number | null): Promise<void> {
  const [participant] = await db.query(`select * from schedule_session_participants where activity_schedule_id = $1`, [activityId]);
  if (!participant) return;
  await updateRow(db, 'schedule_session_participants', participant.id, { attendance_status: 'cancelled', activity_schedule_id: null });
  await recomputeStatus(db, participant.session_id, actorId);
}

/** Never touches merged/rescheduled, and never cancels a session whose participants were REMOVED. */
export async function recomputeStatus(db: Db, sessionId: number, actorId: number | null = null): Promise<void> {
  const session = await sessionById(db, sessionId);
  if (!session || ['merged', 'rescheduled'].includes(session.status)) return;
  const participants = await db.query(
    `select p.attendance_status, (select s.approval_status from activity_schedules s where s.id = p.activity_schedule_id) as approval_status
     from schedule_session_participants p where p.session_id = $1`, [sessionId],
  );
  const active = participants.filter((r) => !INACTIVE_STATUSES.includes(r.attendance_status));
  let status = session.status;
  if (!active.length) {
    if (participants.length && participants.every((r) => r.attendance_status === 'cancelled')) status = 'cancelled';
  } else if (active.every((r) => DONE_STATUSES.includes(r.attendance_status))) status = 'completed';
  else if (active.some((r) => r.approval_status === 'pending_admin')) status = 'pending';
  else if (session.status !== 'cancelled') status = 'confirmed';
  if (status === session.status) return;
  await updateRow(db, 'schedule_sessions', sessionId, { status });
  if (['completed', 'cancelled'].includes(status)) {
    await logHistory(db, sessionId, status, { status: session.status }, { status }, actorId, status === 'completed' ? 'Every participant was marked.' : 'Every participant was cancelled.');
  }
}

/** Create or update the activity_schedules row that mirrors a participant. */
export async function mirror(db: Db, participant: Row, session: Row, actorId: number, extra: Row = {}): Promise<Row> {
  const start = new Date(session.start_at);
  const end = new Date(session.end_at);
  const attributes = {
    applicant_id: participant.applicant_id,
    activity_type: session.activity_type,
    title: activityLabel(session.activity_type),
    starts_at: start,
    ends_at: end,
    duration_minutes: Math.round((end.getTime() - start.getTime()) / MINUTE),
    venue: session.venue,
    meeting_link: session.meeting_link,
    assigned_to_user_id: session.handler_id,
    session_key: session.legacy_session_key ?? `session-${session.id}`,
    approval_status: session.status === 'pending' ? 'pending_admin' : 'immediate',
    ...extra,
  };
  const [current] = participant.activity_schedule_id ? await db.query(`select * from activity_schedules where id = $1`, [participant.activity_schedule_id]) : [];
  if (current) return updateActivity(db, current, attributes);
  const activity = await insertActivity(db, { ...attributes, status: 'confirmed', participants: [], scheduled_by_user_id: actorId });
  await db.query(`update schedule_session_participants set activity_schedule_id = $1 where id = $2`, [activity.id, participant.id]);
  participant.activity_schedule_id = activity.id;
  return activity;
}
