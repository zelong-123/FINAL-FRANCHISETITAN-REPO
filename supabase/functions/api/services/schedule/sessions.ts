// App\Services\Scheduling\ScheduleSessionService. Every change locks the days it touches, re-runs
// the rules inside that lock, applies the user's explicit choice, mirrors and records history.
// An applicant's stage is never moved back by a merge, move or cancel.
import type { Db, Row } from '../../lib/db.ts';
import { insertRow, updateRow, abort, RawError } from '../../lib/http.ts';
import { logEvent } from '../applicantStage.ts';
import { activityDone, activityLabel } from '../pipeline.ts';
import { evaluate, isAdmin, isLive, mergeReasons, SESSION_RELATIONS } from './conflict.ts';
import { acquireDayLocks, addMinutes, iso8601, MINUTE, parseLocal, sessionCapacity } from './rules.ts';
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

async function seat(tx: Db, session: Row, applicantId: number, actor: Row, event: string) {
  const [existing] = await tx.query(`select * from schedule_session_participants where session_id = $1 and applicant_id = $2`, [session.id, applicantId]);
  const participant = existing
    ? (await updateRow(tx, 'schedule_session_participants', existing.id, { attendance_status: 'scheduled' }))!
    : await insertRow(tx, 'schedule_session_participants', { session_id: session.id, applicant_id: applicantId, attendance_status: 'scheduled' });
  await mirror(tx, participant, session, actor.id);
  await logEvent(tx, await applicantOf(tx, applicantId), event, actor.id, { session_id: session.id, activity_type: session.activity_type, start_at: iso8601(session.start_at) });
  return participant;
}

async function addApplicants(tx: Db, session: Row, ids: number[], actor: Row) {
  const active = await activeParticipants(tx, session.id);
  const evaluation = await evaluate(tx, {
    activity_type: session.activity_type, brand_id: session.brand_id, start_at: session.start_at, end_at: session.end_at, handler_id: session.handler_id, venue: session.venue,
    applicant_ids: ids, existing_count: active.length, max_capacity: session.max_capacity, ignore_session_ids: [session.id], check_applicant_gates: true, check_window: false,
  }, actor, false);
  const reasons = [...evaluation.reasons];
  for (const p of active.filter((r) => ids.includes(r.applicant_id))) reasons.push(`Applicant #${p.applicant_id} is already in this session.`);
  if (reasons.length) violation('This applicant cannot be added to the session.', reasons, evaluation);
  if (!isAdmin(actor) && session.status === 'confirmed') {
    await updateRow(tx, 'schedule_sessions', session.id, { status: 'pending' });
    session.status = 'pending';
  }
  for (const id of ids) {
    await seat(tx, session, Number(id), actor, 'participant_added');
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
      if (!isAdmin(actor)) violation('Admin lang ang puwedeng mag-merge sa existing session.', [], null, 403);
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
      handler_id: proposal.handler_id, venue: proposal.venue, meeting_link: data.meeting_link ?? null, status: isAdmin(actor) ? 'confirmed' : 'pending',
      merge_suggested: choice.merge_suggested, max_capacity: proposal.max_capacity, remarks: data.remarks ?? null, created_by: actor.id,
    });
    await history(tx, session.id, 'created', null, snapshot(session), actor, data.remarks ?? null);
    for (const id of data.applicant_ids) await seat(tx, session, Number(id), actor, 'scheduled');
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
      brand_id: evaluation.proposal.brand_id, start_at: start, end_at: end, handler_id: handlerId, venue,
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

/** Moves a seat (and its mirror row) to another session; the old row stays as 'removed' history. */
async function placeInto(tx: Db, participant: Row, target: Row, actor: Row) {
  const [existing] = await tx.query(`select * from schedule_session_participants where session_id = $1 and applicant_id = $2`, [target.id, participant.applicant_id]);
  const scheduleId = participant.activity_schedule_id;
  let seated = participant;
  if (existing) {
    await updateRow(tx, 'schedule_session_participants', participant.id, { attendance_status: 'removed', activity_schedule_id: null });
    seated = (await updateRow(tx, 'schedule_session_participants', existing.id, { attendance_status: 'scheduled', activity_schedule_id: scheduleId }))!;
  } else if (participant.session_id !== target.id) {
    await updateRow(tx, 'schedule_session_participants', participant.id, { attendance_status: 'removed', activity_schedule_id: null });
    const { id: _id, created_at: _c, updated_at: _u, ...copy } = participant;
    seated = await insertRow(tx, 'schedule_session_participants', { ...copy, session_id: target.id, activity_schedule_id: scheduleId });
  }
  await mirror(tx, seated, target, actor.id);
}

export function mergeSessions(db: Db, sourceId: number, targetId: number, actor: Row) {
  if (!isAdmin(actor)) violation('Admin lang ang puwedeng mag-merge ng sessions.', [], null, 403);
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
    const moving = await activeParticipants(tx, sourceId);
    for (const p of moving) {
      await placeInto(tx, p, target, actor);
      await logEvent(tx, await applicantOf(tx, p.applicant_id), 'merged', actor.id, { from_session_id: sourceId, to_session_id: targetId });
    }
    await updateRow(tx, 'schedule_sessions', sourceId, { status: 'merged', merged_into_session_id: targetId, merge_suggested: false });
    const ids = moving.map((p) => p.applicant_id);
    await history(tx, sourceId, 'merged', { status: source.status }, { status: 'merged', merged_into_session_id: targetId, applicant_ids: ids }, actor);
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
      handler_id: proposal.handler_id, venue: proposal.venue, meeting_link: session.meeting_link, status: isAdmin(actor) ? 'confirmed' : 'pending',
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
