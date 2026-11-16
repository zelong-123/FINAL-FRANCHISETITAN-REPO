// TEST DATA: re-times an applicant's activity rows and their Master Schedule sessions (never the
// append-only stage history). For each activity: the slot, Sales completed and Admin verified times;
// its proof files' submitted time, Admin viewed time, the brand lock (Orientation/Tasting) and the
// milestone details move with it. Refused when a time falls outside the applicant's real Scheduling
// window, the order is wrong, or the same Sales user's 1-hour buffer / no-overlapping-Training rule
// breaks against any other live session. Every change is audited (schedule.activity_retimed).
//
//   node --no-warnings supabase/scripts/retime_activities.ts --applicant=9 \
//     --slot=5:2026-11-04/03:30/06:30/07:00/07:30 --slot=7:2026-11-04/08:30/09:30/09:45/10:00 --dry-run | --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const MODELS = { activity: 'App\\Models\\ActivitySchedule', session: 'App\\Models\\ScheduleSession', applicant: 'App\\Models\\Applicant' };
const MIN = 60_000;
const iso = (d: unknown) => (d ? new Date(d as string | number).toISOString() : null);
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+08:00`).getTime();

export type SlotSpec = { activityId: number; day: string; start: string; end: string; sales: string; admin: string };
export type RetimePlan = {
  activity: Row; session: Row | null; old: Row; next: Row; files: number; views: number; problems: string[];
};

export async function retimeActivities(db: Db, applicantId: number, specs: SlotSpec[], actors: { salesId: number; salesName: string; adminId: number; adminName: string }, apply: boolean) {
  const [a] = await db.query(`select * from applicants where id = $1`, [applicantId]);
  if (!a) throw new Error('applicant not found');
  const [stage] = await db.query(
    `select (select max(created_at) from applicant_status_histories where applicant_id = $1 and to_status = 'scheduled') as entered,
            (select min(created_at) from applicant_status_histories where applicant_id = $1 and from_status = 'scheduled' and to_status <> 'scheduled') as left_at`, [applicantId],
  );
  const win = stage.entered && stage.left_at ? [new Date(stage.entered).getTime(), new Date(stage.left_at).getTime()] : null;
  const plans: RetimePlan[] = [];
  for (const spec of specs) {
    const [act] = await db.query(`select * from activity_schedules where id = $1`, [spec.activityId]);
    const problems: string[] = [];
    if (!act || Number(act.applicant_id) !== applicantId) { plans.push({ activity: act ?? { id: spec.activityId }, session: null, old: {}, next: {}, files: 0, views: 0, problems: ['not an activity of this applicant'] }); continue; }
    const [seat] = await db.query(`select * from schedule_session_participants where activity_schedule_id = $1`, [act.id]);
    const [session] = seat ? await db.query(`select * from schedule_sessions where id = $1`, [seat.session_id]) : [];
    const t = { start: at(spec.day, spec.start), end: at(spec.day, spec.end), sales: at(spec.day, spec.sales), admin: at(spec.day, spec.admin) };
    if (!(t.start < t.end && t.end <= t.sales && t.sales < t.admin)) problems.push('the order must be start < end <= Sales completed < Admin verified');
    if (!win) problems.push('no Scheduling window in the status history');
    else if (t.start <= win[0] || t.admin >= win[1]) problems.push(`outside the Scheduling window ${iso(win[0])} → ${iso(win[1])}`);
    if (session) {
      const [others] = await db.query(`select count(*)::int as n from schedule_session_participants where session_id = $1 and id <> $2 and attendance_status not in ('cancelled', 'removed')`, [session.id, seat.id]);
      if (others.n) problems.push(`session #${session.id} seats other applicants`);
    }
    const [files] = await db.query(`select count(*)::int as n from documents where documentable_type = $1 and documentable_id = $2 and removed_at is null`, [MODELS.activity, act.id]);
    const [views] = await db.query(`select count(*)::int as n from activity_document_views v join documents d on d.id = v.document_id where d.documentable_type = $1 and d.documentable_id = $2`, [MODELS.activity, act.id]);
    plans.push({
      activity: act, session: session ?? null, files: files.n, views: views.n, problems,
      old: { starts_at: iso(act.starts_at), ends_at: iso(act.ends_at), completed_at: iso(act.completed_at), reviewed_at: iso(act.reviewed_at), session_start: iso(session?.start_at), session_end: iso(session?.end_at), handler_id: session?.handler_id ?? null },
      next: { starts_at: iso(t.start), ends_at: iso(t.end), completed_at: iso(t.sales), reviewed_at: iso(t.admin), viewed_at: iso(t.admin - MIN), duration_minutes: Math.round((t.end - t.start) / MIN), handler_id: actors.salesId },
    });
  }
  // Orientation/Tasting ends an hour before Training starts (same Sales user, same applicant).
  const o = plans.find((p) => p.activity.activity_type === 'orientation');
  const tr = plans.find((p) => p.activity.activity_type === 'training');
  if (o && tr && new Date(o.next.ends_at).getTime() + 60 * MIN > new Date(tr.next.starts_at).getTime()) tr.problems.push('Training must start at least 1 hour after Orientation/Tasting ends');
  // Against every other live session: the same Sales user's 1-hour buffer, and no overlapping Training.
  const moving = plans.map((p) => p.session?.id).filter(Boolean);
  for (const p of plans) {
    if (!p.next.starts_at) continue;
    const clashes = await db.query(
      `select id, activity_type, start_at, end_at, handler_id from schedule_sessions where status <> 'cancelled' and id <> all($1::bigint[])
         and ((handler_id = $2 and start_at < $4::timestamptz + interval '60 minutes' and end_at > $3::timestamptz - interval '60 minutes')
           or ($5 = 'training' and activity_type = 'training' and start_at < $4 and end_at > $3))`,
      [`{${moving.join(',') || 0}}`, actors.salesId, p.next.starts_at, p.next.ends_at, p.activity.activity_type],
    );
    for (const c of clashes) p.problems.push(`clashes with session #${c.id} (${c.activity_type}, ${iso(c.start_at)}–${iso(c.end_at)}, handler #${c.handler_id ?? '-'})`);
  }
  if (!apply) return plans;
  if (plans.some((p) => p.problems.length)) throw new Error('Refused: nothing applied.');

  await db.tx(async (tx) => {
    const details = { ...((await tx.query(`select milestone_details from applicants where id = $1 for update`, [applicantId]))[0].milestone_details ?? {}) };
    for (const p of plans) {
      const n = p.next;
      await tx.query(
        `update activity_schedules set starts_at = $2, ends_at = $3, duration_minutes = $4, actual_started_at = $2, completed_at = $5, completion_submitted_at = $5,
           reviewed_at = $6, assigned_to_user_id = $7 where id = $1`,
        [p.activity.id, n.starts_at, n.ends_at, n.duration_minutes, n.completed_at, n.reviewed_at, n.handler_id],
      );
      if (p.session) {
        await tx.query(`update schedule_sessions set start_at = $2, end_at = $3, handler_id = $4 where id = $1`, [p.session.id, n.starts_at, n.ends_at, n.handler_id]);
        await tx.query(`insert into schedule_session_history (session_id, action, from_value, to_value, performed_by, performed_by_role, remarks) values ($1, 'rescheduled', $2, $3, null, 'system', $4)`,
          [p.session.id, JSON.stringify({ start_at: p.old.session_start, end_at: p.old.session_end, handler_id: p.old.handler_id }), JSON.stringify({ start_at: n.starts_at, end_at: n.ends_at, handler_id: n.handler_id }),
            'Sample/test data: re-timed inside the applicant\'s real Scheduling window.']);
        await tx.query(
          `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.activity_retimed', $1, $2, $3, $4, now())`,
          [MODELS.session, p.session.id, JSON.stringify({ start_at: p.old.session_start, end_at: p.old.session_end, handler_id: p.old.handler_id }), JSON.stringify({ start_at: n.starts_at, end_at: n.ends_at, handler_id: n.handler_id, note: 'Sample/test data.', script: 'retime_activities' })],
        );
      }
      await tx.query(`update schedule_session_participants set sales_completed_at = $2, admin_attended_at = $3 where activity_schedule_id = $1`, [p.activity.id, n.completed_at, n.reviewed_at]);
      await tx.query(`update documents set created_at = $3, updated_at = $3 where documentable_type = $1 and documentable_id = $2 and removed_at is null`, [MODELS.activity, p.activity.id, n.completed_at]);
      await tx.query(
        `update activity_document_views v set first_viewed_at = $3, last_viewed_at = $3 from documents d where d.id = v.document_id and d.documentable_type = $1 and d.documentable_id = $2`,
        [MODELS.activity, p.activity.id, n.viewed_at],
      );
      const key = p.activity.activity_type === 'orientation' ? 'orientation_attended' : 'training_completed';
      details[key] = { ...(details[key] ?? {}), on: new Date(new Date(n.reviewed_at).getTime() + 8 * 3600e3).toISOString().slice(0, 16), by: `${actors.adminName} (Admin)`, by_user_id: actors.adminId };
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.activity_retimed', $1, $2, $3, $4, now())`,
        [MODELS.activity, p.activity.id, JSON.stringify(p.old), JSON.stringify({ ...n, files_moved: p.files, views_moved: p.views, note: 'Sample/test data: re-timed inside the real Scheduling window; history untouched.', script: 'retime_activities' })],
      );
    }
    const lockAt = o?.next.reviewed_at ?? null;
    await tx.query(`update applicants set milestone_details = $2, brand_locked_at = coalesce($3, brand_locked_at) where id = $1`, [applicantId, JSON.stringify(details), lockAt]);
    await tx.query(
      `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.activity_retimed', $1, $2, $3, $4, now())`,
      [MODELS.applicant, applicantId, JSON.stringify({ brand_locked_at: iso(a.brand_locked_at) }), JSON.stringify({ brand_locked_at: lockAt, milestone_details: details, note: 'Sample/test data.', script: 'retime_activities' })],
    );
  });
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/retime_activities.ts'));
if (isMain) {
  const applicantId = Number(process.argv.find((x) => x.startsWith('--applicant='))?.split('=')[1]);
  const specs: SlotSpec[] = process.argv.filter((x) => x.startsWith('--slot=')).map((x) => {
    const v = x.slice('--slot='.length);
    const aid = Number(v.slice(0, v.indexOf(':')));
    const [day, start, end, sales, admin] = v.slice(v.indexOf(':') + 1).split('/');
    return { activityId: aid, day, start, end, sales, admin };
  });
  const apply = process.argv.includes('--apply');
  if (!applicantId || !specs.length || apply === process.argv.includes('--dry-run')) { console.error('Usage: --applicant=N --slot=ID:YYYY-MM-DD/HH:MM/HH:MM/HH:MM/HH:MM ... and exactly one of --dry-run or --apply'); process.exit(2); }
  const { openScriptDb, readOnly } = await import('./lib/scriptDb.ts');
  const db = await openScriptDb();
  const local = (d: unknown) => (d ? new Date(new Date(d as string).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—');
  try {
    const [sales] = await db.query(`select u.id, u.full_name from users u join roles r on r.id = u.role_id where u.id = 3 and r.name = 'sales'`);
    const [admin] = await db.query(`select u.id, u.full_name from users u join roles r on r.id = u.role_id where r.name = 'admin' and u.account_status = 'active' order by u.id limit 1`);
    const actors = { salesId: Number(sales.id), salesName: sales.full_name, adminId: Number(admin.id), adminName: admin.full_name };
    const plans = apply ? await retimeActivities(db, applicantId, specs, actors, true) : await readOnly(db, (tx) => retimeActivities(tx, applicantId, specs, actors, false));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(plans.map((p) => ({
      activity: `#${p.activity.id} ${p.activity.activity_type}`, slot: `${local(p.old.starts_at)}–${local(p.old.ends_at).slice(11)} -> ${local(p.next.starts_at)}–${local(p.next.ends_at).slice(11)}`,
      sales: `${local(p.old.completed_at)} -> ${local(p.next.completed_at)}`, admin: `${local(p.old.reviewed_at)} -> ${local(p.next.reviewed_at)}`,
      session: p.session ? `#${p.session.id} handler #${p.old.handler_id ?? '-'} -> #${p.next.handler_id}` : '—', 'files / views': `${p.files} / ${p.views} -> ${local(p.next.completed_at).slice(11)} / ${local(p.next.viewed_at).slice(11)}`,
      check: p.problems.length ? `NO: ${p.problems.join('; ')}` : 'ok',
    })));
    const o = plans.find((p) => p.activity.activity_type === 'orientation');
    if (o) console.log(`brand lock -> ${local(o.next.reviewed_at)}; milestone details follow the Admin verified times; label "Completed before schedule" gone: ${plans.every((p) => p.next.completed_at && p.next.completed_at >= p.next.starts_at)}`);
  } finally {
    await db.close();
  }
}
