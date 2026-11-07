// ActivitySchedule::save and ScheduleConflictService::assertActivityAllowed: the ONE rule gate for
// every write of a live schedule row, taken under the same day lock as the Master Schedule.
import type { Db, Row } from '../../lib/db.ts';
import { ValidationError } from '../../lib/http.ts';
import { evaluate } from './conflict.ts';
import { acquireDayLocks, sessionCapacity, TRACKED_TYPES } from './rules.ts';
import { activeCountExcept, insertActivity, resolveActivity, syncActivity, updateActivity } from './sync.ts';

const WATCHED = ['starts_at', 'ends_at', 'duration_minutes', 'assigned_to_user_id', 'venue', 'activity_type', 'session_key', 'status', 'approval_status', 'applicant_id'];
const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date || (typeof a === 'string' && typeof b === 'string' && /^\d{4}-/.test(a))
  ? new Date(a as string).getTime() === new Date(b as string).getTime()
  : String(a ?? '') === String(b ?? ''));

function needsRuleCheck(current: Row | null, next: Row): boolean {
  if (!TRACKED_TYPES.includes(next.activity_type) || next.approval_status === 'rejected' || !['pending', 'confirmed'].includes(next.status)) return false;
  return !current || WATCHED.some((k) => !same(current[k], next[k]));
}

export async function assertActivityAllowed(db: Db, activity: Row, actor: Row | null) {
  const resolved = await resolveActivity(db, activity);
  if (!resolved) return;
  const { applicant, fields, participant, previous, target } = resolved;
  const alone = previous !== null && (await activeCountExcept(db, previous.id, participant?.id)) === 0;
  let reasons: string[] = [];
  if (target && ['pending', 'confirmed'].includes(target.status) && target.id !== previous?.id) {
    const seated = await db.query(`select applicant_id from schedule_session_participants where session_id = $1 and attendance_status not in ('cancelled', 'removed')`, [target.id]);
    if (seated.some((r) => r.applicant_id === applicant.id)) reasons.push(`${applicant.full_name} is already in this session.`);
    const evaluation = await evaluate(db, {
      activity_type: target.activity_type, brand_id: target.brand_id, start_at: target.start_at, end_at: target.end_at, handler_id: target.handler_id, venue: target.venue,
      applicant_ids: [applicant.id], existing_count: seated.length, max_capacity: target.max_capacity,
      ignore_session_ids: [target.id, ...(alone ? [previous!.id] : [])],
      detach: previous && !alone ? { session_id: previous.id, applicant_id: applicant.id } : null, check_window: false,
    }, actor, false);
    reasons.push(...evaluation.reasons);
  } else if (target && target.id === previous?.id && !alone) {
    return; // A group member whose slot did not change: nothing new to check.
  } else {
    const evaluation = await evaluate(db, {
      ...fields, applicant_ids: [applicant.id], max_capacity: previous?.max_capacity ?? sessionCapacity(fields.activity_type),
      ignore_session_ids: previous && alone ? [previous.id] : [],
      detach: previous && !alone ? { session_id: previous.id, applicant_id: applicant.id } : null, check_window: false,
    }, actor, false);
    reasons = [...evaluation.reasons];
    if (evaluation.status === 'mergeable' && !evaluation.separate_allowed) reasons.push(...evaluation.separate_blockers);
    for (const warning of evaluation.warnings) reasons.push(`${warning} Open the Master schedule to save it with Admin override remarks, or pick another time or handler.`);
  }
  if (reasons.length) throw new ValidationError({ starts_at: [...new Set(reasons)] });
}

/** Writes one row: guard, then the write, then the copy into its session. Needs a transaction. */
export async function saveActivity(tx: Db, current: Row | null, changes: Row, actor: Row): Promise<Row> {
  const next: Row = { status: 'pending', approval_status: 'immediate', session_key: '', ...(current ?? {}), ...changes };
  if (needsRuleCheck(current, next)) {
    await acquireDayLocks(tx, [next.starts_at, current?.starts_at]);
    await assertActivityAllowed(tx, next, actor);
  }
  const saved = current ? await updateActivity(tx, current, changes) : await insertActivity(tx, changes);
  await syncActivity(tx, saved, actor.id);
  return saved;
}
