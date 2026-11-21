// App\Services\Scheduling\ScheduleSessionService. Every change locks the days it touches, re-runs
// the rules inside that lock, applies the user's explicit choice, mirrors and records history.
// An applicant's stage is never moved back by a merge, move or cancel.
import type { Db, Row } from '../../lib/db.ts';
import { insertRow, updateRow, abort, RawError } from '../../lib/http.ts';
import { logEvent } from '../applicantStage.ts';
import { notifyUser } from '../notifications.ts';
import { activityDone, activityLabel } from '../pipeline.ts';
import { defaultHandlerId, evaluate, isAdmin, isLive, mergeReasons, SESSION_RELATIONS } from './conflict.ts';
import { acquireDayLocks, addMinutes, iso8601, longDateTime, MINUTE, parseLocal, sessionCapacity } from './rules.ts';
import { mirror, updateActivity } from './sync.ts';

/** ScheduleRuleViolation: a validation-shaped refusal that also carries the evaluation. */
export function violation(message: string, reasons: string[] = [], evaluation: Row | null = null, status = 422): never {
  throw new RawError(status, { message, errors: { schedule: reasons.length ? reasons : [message] }, evaluation });
}

const lockRow = async (tx: Db, id: number): Promise<Row> => {
  const [row] = await tx.query(`select * from schedule_sessions where id = $1 for update`, [id]);
  if (!row) abort(404, 'Record not found.');
  return row;
};
const activeParticipants = (db: Db, id: number) => db.query(`select * from schedule_session_participants where session_id = $1 and attendance_status not in ('cancelled', 'removed') order by id`, [id]);
const withRelations = async (db: Db, id: number) => (await db.query(`select s.*, ${SESSION_RELATIONS('s')} from schedule_sessions s where s.id = $1`, [id]))[0];
const applicantOf = async (db: Db, id: number) => (await db.query(`select * from applicants where id = $1`, [id]))[0];
const assertLive = (s: Row) => { if (!isLive(s)) violation('Only a Pending or Confirmed session can be changed.'); };

function snapshot(s: Row): Row {
  return {
    activity_type: s.activity_type, brand_id: s.brand_id, start_at: iso8601(s.start_at), end_at: iso8601(s.end_at), handler_id: s.handler_id,
    venue: s.venue, status: s.status, max_capacity: s.max_capacity,
  };
}

const history = (db: Db, sessionId: number, action: string, from: Row | null, to: Row | null, actor: Row, remarks: string | null = null) => db.query(
  `insert into schedule_session_history (session_id, action, from_value, to_value, performed_by, performed_by_role, remarks) values ($1, $2, $3, $4, $5, $6, $7)`,
  [sessionId, action, from ? JSON.stringify(from) : null, to ? JSON.stringify(to) : null, actor.id, actor.role?.name ?? null, remarks],
);

function locked<T>(db: Db, moments: unknown[], fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.tx(async (tx) => {
    await acquireDayLocks(tx, moments);
    return fn(tx);
  });
}

function proposalFrom(data: Row, applicantIds: number[]): Row {
  const type = String(data.activity_type);
  return {
    activity_type: type, brand_id: data.brand_id ?? null, start_at: parseLocal(data.start_at), end_at: data.end_at ? parseLocal(data.end_at) : null,
    handler_id: data.handler_id ?? null, venue: data.venue ?? null, applicant_ids: applicantIds.map(Number), max_capacity: Number(data.max_capacity ?? sessionCapacity(type)),
  };
}

function resolveChoice(evaluation: Row, data: Row, actor: Row) {
  if (evaluation.status === 'blocked') violation('This schedule breaks a scheduling rule.', evaluation.reasons, evaluation);
  const admin = isAdmin(actor);
  let declined: number[] = [];
  let mergeSuggested = false;
  if (evaluation.merge_targets.length) {
    if (!data.create_separate) {
      violation(admin
        ? 'An overlapping session can take these applicants. Choose "Add to existing session" or "Create separate session".'
        : 'An overlapping session can take these applicants. Choose "Create separate session (Pending — Admin will review)" or another time.', [], evaluation);
    }
    if (!evaluation.separate_allowed) violation('A separate session is not allowed here.', evaluation.separate_blockers, evaluation);
    declined = evaluation.merge_targets.map((t: Row) => t.session_id);
    mergeSuggested = !admin;
  }
  let overridden = false;
  if (evaluation.warnings.length) {
    if (!admin) violation('Near conflict for the handler. Pick another time or handler, or ask an Admin.', evaluation.warnings, evaluation);
    if (!String(data.override_remarks ?? '').trim()) violation('Remarks are required to override this warning.', evaluation.warnings, evaluation);
    overridden = true;
  }
  return { merge_suggested: mergeSuggested, declined, overridden, warnings: evaluation.warnings as string[] };
}

async function writeDecisions(tx: Db, session: Row, choice: ReturnType<typeof resolveChoice>, actor: Row, data: Row) {
  const role = actor.role?.name;
  if (choice.declined.length) await history(tx, session.id, 'merge_suggestion_declined', null, { choice: 'separate_session', merge_target_ids: choice.declined, role }, actor);
  if (data.declined_merge_session_ids?.length) {
    await history(tx, session.id, 'merge_suggestion_declined', null, { choice: 'other_time', merge_target_ids: data.declined_merge_session_ids.map(Number), role }, actor);
  }
  if (data.from_suggestion) await history(tx, session.id, 'suggested_time_used', null, { start_at: iso8601(session.start_at), end_at: iso8601(session.end_at) }, actor);
  if (choice.overridden) {
    await history(tx, session.id, 'warning_overridden', null, { warnings: choice.warnings }, actor, data.override_remarks);
    for (const p of await activeParticipants(tx, session.id)) {
      await logEvent(tx, await applicantOf(tx, p.applicant_id), 'conflict_override', actor.id, { session_id: session.id, warnings: choice.warnings }, data.override_remarks);
    }
  }
}

const ACTIVITY_MODEL = 'App\\Models\\ActivitySchedule';
const isLiveActivity = (a: Row | null | undefined) => Boolean(a && ['pending', 'confirmed'].includes(a.status) && a.approval_status !== 'rejected');
const ATTENDANCE_RESET = { sales_completed_by: null, sales_completed_at: null, admin_attended_by: null, admin_attended_by_name: null, admin_attended_at: null };

/**
 * THE one way an applicant takes a seat in a session (create, join, Join this session, Add to existing
 * session, merge, Set Again). Seating == scheduling: the seat always ends linked to ONE live activity
 * record that mirrors the session (type, time, handler, venue, approval), exactly as Schedule activity.
 *  - An earlier seat row of this applicant in this session (cancelled / removed) is reused, because a
 *    session holds one row per applicant.
 *  - `activityId`: the live record that moves with the seat (merge, Set Again). Without it, the seat's
 *    record is reused only while it is live; a cancelled / No Show / rejected record stays as history
 *    and a new record is created (never revived, so old history is not rewritten).
 *  - A new record is audited (activity.created), logged in the stage history and notified, like a
 *    normal schedule.
 * Runs inside the caller's transaction (which holds the day locks): if any write fails, the seat,
 * the record and the logs are all rolled back together.
 */
export async function addApplicantToSession(
  tx: Db, session: Row, applicantId: number, actor: Row,
  options: { activityId?: number | null; fields?: Row; event?: string | null; context?: Row } = {},
): Promise<{ participant: Row; activity: Row; created: boolean }> {
  const [existing] = await tx.query(`select * from schedule_session_participants where session_id = $1 and applicant_id = $2`, [session.id, applicantId]);
  let linkId: number | null = options.activityId ?? null;
  if (linkId === null && existing?.activity_schedule_id) {
    const [linked] = await tx.query(`select status, approval_status from activity_schedules where id = $1`, [existing.activity_schedule_id]);
    if (isLiveActivity(linked)) linkId = Number(existing.activity_schedule_id);
  }
  const changed = existing && Number(existing.activity_schedule_id ?? 0) !== Number(linkId ?? 0);
  const seatFields = { attendance_status: 'scheduled', ...(changed && !options.fields ? ATTENDANCE_RESET : {}), ...(options.fields ?? {}), activity_schedule_id: linkId };
  const participant = existing
    ? (await updateRow(tx, 'schedule_session_participants', existing.id, seatFields))!
    : await insertRow(tx, 'schedule_session_participants', { session_id: session.id, applicant_id: applicantId, ...seatFields });
  const activity = await mirror(tx, participant, session, actor.id);
  const created = linkId === null;
  // The invariant every caller relies on; a breach aborts the whole transaction.
  if (!isLiveActivity(activity) || Number(participant.activity_schedule_id) !== Number(activity.id)) {
    throw new Error(`Seat ${participant.id} in session ${session.id} has no live activity record.`);
  }
  const applicant = await applicantOf(tx, applicantId);
  const context = { session_id: session.id, activity_id: activity.id, activity_type: session.activity_type, start_at: iso8601(session.start_at), ...(options.context ?? {}) };
  if (created) {
    await tx.query(
      `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values ($1, 'activity.created', $2, $3, null, $4, now())`,
      [actor.id, ACTIVITY_MODEL, activity.id, JSON.stringify({ ...activity, via_session_id: session.id })],
    );
    if (applicant?.user_id) {
      await notifyUser(tx, applicant.user_id, 'schedule_created', 'Activity scheduled', `${activity.title} is scheduled for ${longDateTime(new Date(activity.starts_at))}.`, { activity_id: activity.id }, actor);
    }
  }
  const event = options.event === undefined ? 'scheduled' : options.event;
  if (event) await logEvent(tx, applicant, event, actor.id, context);
  return { participant, activity, created };
}

async function addApplicants(tx: Db, session: Row, ids: number[], actor: Row) {
  const active = await activeParticipants(tx, session.id);
  // A session without a handler takes the assigned Sales user of everyone in it.
  if (!session.handler_id) {
    const handler = await defaultHandlerId(tx, session.activity_type, [...active.map((p: Row) => Number(p.applicant_id)), ...ids.map(Number)]);
    if (handler) session = (await updateRow(tx, 'schedule_sessions', session.id, { handler_id: handler }))!;
  }
  // Joining takes a seat in a session that already holds its facility: the facility limit is not re-counted.
  const evaluation = await evaluate(tx, {
    activity_type: session.activity_type, brand_id: session.brand_id, start_at: session.start_at, end_at: session.end_at, handler_id: session.handler_id, venue: session.venue,
    applicant_ids: ids, existing_count: active.length, max_capacity: session.max_capacity, ignore_session_ids: [session.id], check_applicant_gates: true, check_window: false,
    check_facility: false,
  }, actor, false);
  const reasons = [...evaluation.reasons];
  if (new Date(session.start_at).getTime() <= Date.now()) reasons.unshift('This session has already started.');
  for (const p of active.filter((r) => ids.includes(r.applicant_id))) reasons.push(`Applicant #${p.applicant_id} is already in this session.`);
  if (reasons.length) violation('This applicant cannot be added to the session.', reasons, evaluation);
  if (!isAdmin(actor) && session.status === 'confirmed') {
    await updateRow(tx, 'schedule_sessions', session.id, { status: 'pending' });
    session.status = 'pending';
  }
  for (const id of ids) {
    // Joining is scheduling: the stage history records it as 'scheduled', like a new session.
    await addApplicantToSession(tx, session, Number(id), actor, { context: { via: 'join' } });
    await history(tx, session.id, 'participant_added', null, { applicant_id: Number(id) }, actor);
  }
}

async function createSessionRow(tx: Db, fields: Row): Promise<Row> {
  const row = await insertRow(tx, 'schedule_sessions', fields);
  return (await updateRow(tx, 'schedule_sessions', row.id, { legacy_session_key: `session-${row.id}` }))!;
}

export function createSession(db: Db, data: Row, actor: Row) {
  const proposal = proposalFrom(data, data.applicant_ids);
  return locked(db, [proposal.start_at], async (tx) => {
    if (data.join_session_id) {
      if (!isAdmin(actor)) violation('Only Admin can add applicants to an existing session from here. Use "Join this session" in the Sessions list.', [], null, 403);
      const evaluation = await evaluate(tx, { ...proposal, check_applicant_gates: true }, actor, false);
      if (!evaluation.merge_targets.some((t) => t.session_id === Number(data.join_session_id))) {
        violation('That session can no longer be joined at this time.', evaluation.reasons, evaluation);
      }
      const target = await lockRow(tx, Number(data.join_session_id));
      await addApplicants(tx, target, data.applicant_ids, actor);
      await history(tx, target.id, 'merge_suggestion_accepted', null, { applicant_ids: data.applicant_ids }, actor);
      return { session: await withRelations(tx, target.id), joined: true };
    }
    const evaluation = await evaluate(tx, { ...proposal, check_applicant_gates: true }, actor);
    const choice = resolveChoice(evaluation, data, actor);
    const session = await createSessionRow(tx, {
      activity_type: proposal.activity_type, brand_id: evaluation.proposal.brand_id, start_at: parseLocal(evaluation.proposal.start_at), end_at: parseLocal(evaluation.proposal.end_at),
      handler_id: evaluation.proposal.handler_id, venue: proposal.venue, meeting_link: data.meeting_link ?? null, status: isAdmin(actor) ? 'confirmed' : 'pending',
      merge_suggested: choice.merge_suggested, max_capacity: proposal.max_capacity, remarks: data.remarks ?? null, created_by: actor.id,
    });
    await history(tx, session.id, 'created', null, snapshot(session), actor, data.remarks ?? null);
    for (const id of data.applicant_ids) await addApplicantToSession(tx, session, Number(id), actor);
    await writeDecisions(tx, session, choice, actor, data);
    return { session: await withRelations(tx, session.id), joined: false };
  });
}

export function updateSession(db: Db, current: Row, data: Row, actor: Row, action = 'edited'): Promise<Row> {
  assertLive(current);
  const moments: unknown[] = [current.start_at];
  if (data.start_at) moments.push(parseLocal(data.start_at));
  return locked(db, moments, async (tx) => {
    const session = await lockRow(tx, current.id);
    assertLive(session);
    const before = snapshot(session);
    const active = await activeParticipants(tx, session.id);
    const capacity = Number(data.max_capacity ?? session.max_capacity);
    if (capacity < active.length) violation(`Max capacity cannot be lower than the current participants (${active.length}).`);
    const oldStart = new Date(session.start_at);
    const oldEnd = new Date(session.end_at);
    const start = data.start_at ? parseLocal(data.start_at) : oldStart;
    const end = data.end_at ? parseLocal(data.end_at) : data.start_at ? addMinutes(start, Math.round((oldEnd.getTime() - oldStart.getTime()) / MINUTE)) : oldEnd;
    const timeChanged = start.getTime() !== oldStart.getTime() || end.getTime() !== oldEnd.getTime();
    const handlerId = 'handler_id' in data ? data.handler_id : session.handler_id;
    const venue = 'venue' in data ? data.venue : session.venue;
    const evaluation = await evaluate(tx, {
      activity_type: session.activity_type, brand_id: 'brand_id' in data ? data.brand_id : session.brand_id, start_at: start, end_at: end, handler_id: handlerId, venue,
      applicant_ids: active.map((p) => p.applicant_id), max_capacity: capacity, ignore_session_ids: [session.id], check_window: timeChanged,
    }, actor);
    const choice = resolveChoice(evaluation, data, actor);
    const saved = (await updateRow(tx, 'schedule_sessions', session.id, {
      brand_id: evaluation.proposal.brand_id, start_at: start, end_at: end, handler_id: evaluation.proposal.handler_id ?? handlerId, venue,
      meeting_link: 'meeting_link' in data ? data.meeting_link : session.meeting_link, max_capacity: capacity,
      remarks: 'remarks' in data ? data.remarks : session.remarks, status: isAdmin(actor) ? session.status : 'pending',
      merge_suggested: session.merge_suggested || choice.merge_suggested,
    }))!;
    await history(tx, session.id, action, before, snapshot(saved), actor, data.remarks ?? null);
    if (timeChanged && action === 'edited') {
      await history(tx, session.id, 'rescheduled', { start_at: before.start_at, end_at: before.end_at }, { start_at: iso8601(saved.start_at), end_at: iso8601(saved.end_at) }, actor);
    }
    await writeDecisions(tx, saved, choice, actor, data);
    for (const p of active) {
      await mirror(tx, p, saved, actor.id);
      if (timeChanged) await logEvent(tx, await applicantOf(tx, p.applicant_id), 'rescheduled', actor.id, { session_id: session.id, from: before.start_at, to: iso8601(saved.start_at) });
    }
    return withRelations(tx, session.id);
  });
}

const MOVE_KEYS = ['start_at', 'end_at', 'override_remarks', 'create_separate', 'from_suggestion', 'declined_merge_session_ids'];
export function moveSession(db: Db, session: Row, data: Row, actor: Row) {
  return updateSession(db, session, Object.fromEntries(Object.entries(data).filter(([k]) => MOVE_KEYS.includes(k))), actor, 'rescheduled');
}

export function confirmSession(db: Db, current: Row, actor: Row) {
  return locked(db, [current.start_at], async (tx) => {
    const session = await lockRow(tx, current.id);
    if (session.status !== 'pending') violation('Only a Pending session can be confirmed.');
    const saved = (await updateRow(tx, 'schedule_sessions', session.id, { status: 'confirmed' }))!;
    await history(tx, session.id, 'confirmed', { status: 'pending' }, { status: 'confirmed' }, actor);
    for (const p of await activeParticipants(tx, session.id)) {
      await mirror(tx, p, saved, actor.id, { approved_by_user_id: actor.id, approved_at: new Date(), proposed_changes: null });
    }
    return withRelations(tx, session.id);
  });
}

async function cancelMirror(tx: Db, participant: Row) {
  if (!participant.activity_schedule_id) return;
  const [activity] = await tx.query(`select * from activity_schedules where id = $1`, [participant.activity_schedule_id]);
  if (activity) await updateActivity(tx, activity, { status: 'cancelled', cancelled_at: new Date(), proposed_changes: null });
}

export function cancelSession(db: Db, current: Row, actor: Row, remarks: string | null) {
  return locked(db, [current.start_at], async (tx) => {
    const session = await lockRow(tx, current.id);
    assertLive(session);
    await updateRow(tx, 'schedule_sessions', session.id, { status: 'cancelled' });
    await history(tx, session.id, 'cancelled', { status: session.status }, { status: 'cancelled' }, actor, remarks);
    for (const p of await activeParticipants(tx, session.id)) {
      await updateRow(tx, 'schedule_session_participants', p.id, { attendance_status: 'cancelled' });
      await cancelMirror(tx, p);
      await logEvent(tx, await applicantOf(tx, p.applicant_id), 'schedule_cancelled', actor.id, { session_id: session.id }, remarks);
    }
    return withRelations(tx, session.id);
  });
}

/**
 * Moves a seat and its live record to another session (merge, Set Again); the old row stays as
 * 'removed' history. The seat lands through addApplicantToSession, so it ends linked to one live record.
 */
async function placeInto(tx: Db, participant: Row, target: Row, actor: Row) {
  if (participant.session_id === target.id) {
    await mirror(tx, participant, target, actor.id);
    return;
  }
  const scheduleId = participant.activity_schedule_id ? Number(participant.activity_schedule_id) : null;
  const [record] = scheduleId ? await tx.query(`select status, approval_status from activity_schedules where id = $1`, [scheduleId]) : [];
  await updateRow(tx, 'schedule_session_participants', participant.id, { attendance_status: 'removed', activity_schedule_id: null });
  const { id: _id, created_at: _c, updated_at: _u, session_id: _s, applicant_id: _a, activity_schedule_id: _x, ...carry } = participant;
  // The callers log their own stage event ('merged', 'set_again').
  await addApplicantToSession(tx, target, Number(participant.applicant_id), actor, { activityId: isLiveActivity(record) ? scheduleId : null, fields: carry, event: null });
}

export function mergeSessions(db: Db, sourceId: number, targetId: number, actor: Row, applicantIds: number[] | null = null) {
  if (!isAdmin(actor)) violation('Only Admin can merge sessions.', [], null, 403);
  return db.tx(async (tx) => {
    const [s, t] = await tx.query(`select id, start_at from schedule_sessions where id in ($1, $2) order by id`, [sourceId, targetId]);
    await acquireDayLocks(tx, [s?.start_at, t?.start_at]);
    if (sourceId === targetId) violation('A session cannot be merged into itself.');
    await lockRow(tx, sourceId);
    await lockRow(tx, targetId);
    const source = await withRelations(tx, sourceId);
    const target = await withRelations(tx, targetId);
    const reasons = await mergeReasons(tx, source, target);
    if (reasons.length) violation('These sessions cannot be merged.', reasons);
    const active = await activeParticipants(tx, sourceId);
    const moving = applicantIds ? active.filter((p) => applicantIds.includes(p.applicant_id)) : active;
    if (!moving.length) violation('Choose at least one applicant to merge.');
    for (const p of moving) {
      await placeInto(tx, p, target, actor);
      await logEvent(tx, await applicantOf(tx, p.applicant_id), 'merged', actor.id, { from_session_id: sourceId, to_session_id: targetId });
    }
    // Only the whole session becomes 'merged'; a partial merge leaves the remaining applicants in the source.
    if (moving.length === active.length) await updateRow(tx, 'schedule_sessions', sourceId, { status: 'merged', merged_into_session_id: targetId, merge_suggested: false });
    const ids = moving.map((p) => p.applicant_id);
    await history(tx, sourceId, 'merged', { status: source.status }, { status: moving.length === active.length ? 'merged' : source.status, merged_into_session_id: targetId, applicant_ids: ids }, actor);
    await history(tx, targetId, 'merged', null, { merged_from_session_id: sourceId, applicant_ids: ids }, actor);
    await history(tx, targetId, 'merge_suggestion_accepted', null, { source_session_id: sourceId, applicant_ids: ids }, actor);
    return withRelations(tx, targetId);
  });
}

export function addParticipant(db: Db, current: Row, applicantId: number, actor: Row) {
  return locked(db, [current.start_at], async (tx) => {
    const session = await lockRow(tx, current.id);
    assertLive(session);
    await addApplicants(tx, session, [applicantId], actor);
    return withRelations(tx, session.id);
  });
}

async function activeParticipant(db: Db, sessionId: number, applicantId: number): Promise<Row> {
  const [p] = await db.query(`select * from schedule_session_participants where session_id = $1 and applicant_id = $2 and attendance_status not in ('cancelled', 'removed')`, [sessionId, applicantId]);
  if (!p) violation('This applicant is not an active participant of the session.');
  return p;
}

export function removeParticipant(db: Db, current: Row, applicantId: number, actor: Row, remarks: string | null) {
  return locked(db, [current.start_at], async (tx) => {
    const session = await lockRow(tx, current.id);
    assertLive(session);
    const p = await activeParticipant(tx, session.id, applicantId);
    await updateRow(tx, 'schedule_session_participants', p.id, { attendance_status: 'removed' });
    await cancelMirror(tx, p);
    await history(tx, session.id, 'participant_removed', { applicant_id: applicantId }, null, actor, remarks);
    await logEvent(tx, await applicantOf(tx, applicantId), 'participant_removed', actor.id, { session_id: session.id }, remarks);
    return { session: await withRelations(tx, session.id), empty_session: !(await activeParticipants(tx, session.id)).length };
  });
}

/** Only this applicant leaves for a new session; alone in it, the session itself moves. */
export async function setAgain(db: Db, current: Row, applicantId: number, data: Row, actor: Row) {
  assertLive(current);
  const participant = await activeParticipant(db, current.id, applicantId);
  const applicant = await applicantOf(db, applicantId);
  if (participant.attendance_status === 'attended' || (applicant && await activityDone(db, applicant, current.activity_type))) {
    violation(`${activityLabel(current.activity_type)} is already Done for this applicant — Set Again is not available.`);
  }
  if ((await activeParticipants(db, current.id)).length === 1) {
    const moved = await moveSession(db, current, data, actor);
    await logEvent(db, applicant, 'set_again', actor.id, { session_id: moved.id });
    return { session: moved, previous_session: moved, empty_session: false };
  }
  return locked(db, [current.start_at, parseLocal(data.start_at)], async (tx) => {
    const session = await lockRow(tx, current.id);
    const seated = await activeParticipant(tx, session.id, applicantId);
    const proposal: Row = {
      ...proposalFrom({
        activity_type: session.activity_type, brand_id: session.brand_id, start_at: data.start_at, end_at: data.end_at ?? null,
        handler_id: 'handler_id' in data ? data.handler_id : session.handler_id, venue: 'venue' in data ? data.venue : session.venue, max_capacity: session.max_capacity,
      }, [applicantId]),
      detach: { session_id: session.id, applicant_id: applicantId },
    };
    const evaluation = await evaluate(tx, proposal, actor);
    const choice = resolveChoice(evaluation, data, actor);
    const fresh = await createSessionRow(tx, {
      activity_type: session.activity_type, brand_id: session.brand_id, start_at: parseLocal(evaluation.proposal.start_at), end_at: parseLocal(evaluation.proposal.end_at),
      handler_id: evaluation.proposal.handler_id, venue: proposal.venue, meeting_link: session.meeting_link, status: isAdmin(actor) ? 'confirmed' : 'pending',
      merge_suggested: choice.merge_suggested, max_capacity: sessionCapacity(session.activity_type), remarks: data.remarks ?? null, created_by: actor.id,
    });
    await history(tx, fresh.id, 'created', null, { ...snapshot(fresh), split_from_session_id: session.id }, actor, 'Set Again');
    await placeInto(tx, seated, fresh, actor);
    await history(tx, session.id, 'participant_removed', { applicant_id: applicantId }, { moved_to_session_id: fresh.id }, actor, 'Set Again');
    await writeDecisions(tx, fresh, choice, actor, data);
    await logEvent(tx, await applicantOf(tx, applicantId), 'set_again', actor.id, { from_session_id: session.id, to_session_id: fresh.id });
    return {
      session: await withRelations(tx, fresh.id),
      previous_session: await withRelations(tx, session.id),
      empty_session: !(await activeParticipants(tx, session.id)).length,
    };
  });
}
