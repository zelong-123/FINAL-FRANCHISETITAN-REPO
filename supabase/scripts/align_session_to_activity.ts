// Aligns a Master Schedule session with the live activity it seats (test-data fix, e.g. Christian
// Lopez: session #24 "completed" on Nov 20 vs his reopened Orientation/Tasting #14 "confirmed" on Nov 5).
// The session gets the activity's date/time, status confirmed and the activity's handler; the
// participant row goes back to scheduled. Logged in schedule_session_history and audit_logs.
//
//   node --no-warnings supabase/scripts/align_session_to_activity.ts --session=24 --activity=14 --dry-run
//   node --no-warnings supabase/scripts/align_session_to_activity.ts --session=24 --activity=14 --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const SESSION_MODEL = 'App\\Models\\ScheduleSession';
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export type AlignPlan = { ok: boolean; refused?: string; session: Row; activity: Row; participant: Row | null; before: Row; after: Row; others_in_session: number; buffer_clashes: Row[] };

export async function alignSessionToActivity(db: Db, sessionId: number, activityId: number, apply: boolean): Promise<AlignPlan> {
  const [session] = await db.query(`select * from schedule_sessions where id = $1`, [sessionId]);
  const [activity] = await db.query(`select * from activity_schedules where id = $1`, [activityId]);
  const [participant] = await db.query(`select * from schedule_session_participants where session_id = $1 and activity_schedule_id = $2`, [sessionId, activityId]);
  const [others] = await db.query(`select count(*)::int as n from schedule_session_participants where session_id = $1 and activity_schedule_id is distinct from $2 and attendance_status not in ('cancelled', 'removed')`, [sessionId, activityId]);
  const end = activity?.ends_at ?? (activity ? new Date(new Date(activity.starts_at).getTime() + Number(activity.duration_minutes || 120) * 60000) : null);
  const before = session ? { status: session.status, start_at: iso(session.start_at), end_at: iso(session.end_at), handler_id: session.handler_id, participant_status: participant?.attendance_status ?? null } : {};
  const after = activity ? { status: 'confirmed', start_at: iso(activity.starts_at), end_at: iso(end), handler_id: activity.assigned_to_user_id, participant_status: 'scheduled' } : {};
  // The same Sales user's other live sessions within an hour of the new time (the buffer rule).
  const clashes = activity?.assigned_to_user_id ? await db.query(
    `select id, activity_type, status, start_at, end_at from schedule_sessions where id <> $1 and handler_id = $2 and status in ('pending', 'confirmed')
       and start_at < $4::timestamptz + interval '60 minutes' and end_at > $3::timestamptz - interval '60 minutes'`,
    [sessionId, activity.assigned_to_user_id, activity.starts_at, end],
  ) : [];
  const plan: AlignPlan = { ok: true, session, activity, participant: participant ?? null, before, after, others_in_session: others?.n ?? 0, buffer_clashes: clashes };
  const refuse = (why: string) => ({ ...plan, ok: false, refused: why });
  if (!session || !activity) return refuse('session or activity not found');
  if (!participant) return refuse('the activity is not seated in this session');
  if (session.activity_type !== activity.activity_type) return refuse('different activity types');
  if (!['pending', 'confirmed'].includes(activity.status) || activity.approval_status === 'rejected') return refuse(`the activity is ${activity.status}, not live`);
  if (plan.others_in_session > 0) return refuse('other applicants are in this session: move only this seat instead');
  if (!activity.assigned_to_user_id) return refuse('the activity has no handler');
  if (clashes.length) return refuse(`the handler has another session within 1 hour: #${clashes.map((c: Row) => c.id).join(', #')}`);
  if (!apply) return plan;

  await db.tx(async (tx) => {
    await tx.query(`update schedule_sessions set status = 'confirmed', start_at = $2, end_at = $3, handler_id = $4, updated_at = now() where id = $1`, [sessionId, activity.starts_at, end, activity.assigned_to_user_id]);
    await tx.query(
      `update schedule_session_participants set attendance_status = 'scheduled', sales_completed_by = null, sales_completed_at = null,
         admin_attended_by = null, admin_attended_by_name = null, admin_attended_at = null where id = $1`, [participant.id],
    );
    await tx.query(
      `insert into schedule_session_history (session_id, action, from_value, to_value, performed_by, performed_by_role, remarks) values ($1, 'rescheduled', $2, $3, null, 'system', $4)`,
      [sessionId, JSON.stringify(before), JSON.stringify(after), `Aligned with activity #${activityId} (reopened Orientation/Tasting): same date/time, confirmed, not completed.`],
    );
    await tx.query(
      `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.session_aligned_to_activity', $1, $2, $3, $4, now())`,
      [SESSION_MODEL, sessionId, JSON.stringify({ ...before, participant_id: participant.id }), JSON.stringify({ ...after, activity_id: activityId, script: 'align_session_to_activity' })],
    );
  });
  return plan;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/align_session_to_activity.ts'));
if (isMain) {
  const arg = (name: string) => Number(process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=')[1]);
  const apply = process.argv.includes('--apply');
  const sessionId = arg('session');
  const activityId = arg('activity');
  if (!sessionId || !activityId || apply === process.argv.includes('--dry-run')) { console.error('Usage: --session=N --activity=N and exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readOnly } = await import('./lib/scriptDb.ts');
  const db = await openScriptDb();
  const local = (d: unknown) => (d ? new Date(new Date(d as string).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—');
  try {
    const plan = apply ? await alignSessionToActivity(db, sessionId, activityId, true)
      : await readOnly(db, (tx) => alignSessionToActivity(tx, sessionId, activityId, false));
    console.log(plan.ok ? (apply ? '== APPLIED' : '== DRY RUN (nothing changed)') : `== REFUSED: ${plan.refused}`);
    const show = (r: Row) => ({ status: r.status, start: local(r.start_at), end: local(r.end_at), handler_id: r.handler_id, participant: r.participant_status });
    console.table({ [`session #${sessionId} before`]: show(plan.before), [`session #${sessionId} after`]: show(plan.after) });
    console.log(`activity #${activityId}: ${plan.activity?.status} ${local(plan.activity?.starts_at)}–${local(plan.activity?.ends_at)}, handler #${plan.activity?.assigned_to_user_id}; other applicants in the session: ${plan.others_in_session}; buffer clashes: ${plan.buffer_clashes.length}`);
  } finally {
    await db.close();
  }
}
