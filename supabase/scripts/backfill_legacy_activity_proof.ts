// TEST DATA backfill: legacy Orientation/Tasting and Training records of a few applicants get proof
// files (copies of existing sample images), a selected brand and a normal "Sales completed + Admin
// verified" state under the new flow. Their scheduled slots move to end before the existing Sales
// completion, so they no longer read "Completed before schedule (legacy)": business hours on the same
// date, Orientation/Tasting 09:00–12:00 (Sales 12:30, Admin 13:00), Training 14:00–15:00 (Sales 15:30,
// Admin 16:00). A slot that does not fit (after the applicant left Scheduling, a clash with the same
// Sales user's 1-hour buffer or another Training) is refused, never guessed. Every change is logged in
// audit_logs as schedule.legacy_proof_backfilled (sample/test data).
//
//   node --no-warnings supabase/scripts/backfill_legacy_activity_proof.ts --ids=6,9,23 --dry-run
//   node --no-warnings supabase/scripts/backfill_legacy_activity_proof.ts --ids=6,9,23 --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const ACTIVITY_MODEL = 'App\\Models\\ActivitySchedule';
const APPLICANT_MODEL = 'App\\Models\\Applicant';
const MIN = 60_000;
const NOTE = 'Sample/test data: legacy record backfilled with proof under the new flow.';
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export type Files = { copy(fromPath: string, toPath: string): Promise<void>; remove(paths: string[]): Promise<void> };
export type Actors = { salesId: number; salesName: string; adminId: number; adminName: string };
type Copy = { source: Row; type: string; path: string; stored_name: string };
export type ActivityPlan = {
  id: number; type: string; applicant_id: number; old: Row; next: Row; session: Row | null; create_session: boolean;
  participant: Row | null; copies: Copy[]; notes: string[]; handler_id: number | null;
};
export type ApplicantPlan = { id: number; code: string; name: string; refused?: string; applicant: Row; activities: ActivityPlan[]; brand_lock: Row; notes: string[]; assign_sales?: boolean };
export type Slot = { day: string; start: string; end: string; sales: string; admin: string };
export type Options = { assignSales?: number[]; slots?: Record<number, Slot> };

/** Sample images: existing jpg/png documents, each copied to a new object (never shared). */
async function sampleImages(db: Db): Promise<Row[]> {
  return db.query(
    `select distinct on (path) id, original_name, mime_type, size_bytes, disk, path from documents
     where mime_type in ('image/jpeg', 'image/png') and removed_at is null and disk = 'private' order by path, id`,
  );
}

export async function backfillLegacyProof(db: Db, ids: number[], actors: Actors, apply: boolean, files?: Files, options: Options = {}): Promise<ApplicantPlan[]> {
  const images = (await sampleImages(db)).sort((a, b) => Number(a.id) - Number(b.id));
  if (!images.length) throw new Error('No sample jpg/png documents to copy.');
  let next = 0;
  const pick = () => images[next++ % images.length];
  const plans: ApplicantPlan[] = [];
  for (const id of ids) {
    const [a] = await db.query(`select * from applicants where id = $1`, [id]);
    const base = { id, code: a?.applicant_code ?? '—', name: a?.full_name ?? '—', applicant: a ?? {}, activities: [] as ActivityPlan[], brand_lock: {}, notes: [] as string[], assign_sales: false };
    if (!a) { plans.push({ ...base, refused: 'applicant not found' }); continue; }
    const rows = await db.query(
      `select s.*, p.id as p_id, p.session_id, p.sales_completed_at as p_sales, p.admin_attended_at as p_admin, p.attendance_status as p_status
       from activity_schedules s left join schedule_session_participants p on p.activity_schedule_id = s.id
       where s.applicant_id = $1 and s.activity_type in ('orientation', 'training') and s.status = 'completed' and s.approval_status <> 'rejected' order by s.id`, [id],
    );
    const orientation = rows.filter((r: Row) => r.activity_type === 'orientation').at(-1);
    const training = rows.filter((r: Row) => r.activity_type === 'training').at(-1);
    if (!orientation || !training) { plans.push({ ...base, refused: 'needs one completed Orientation/Tasting and one completed Training' }); continue; }
    if (orientation.completion_submitted_at || training.completion_submitted_at) { plans.push({ ...base, refused: 'already submitted under the new flow' }); continue; }
    const inquiryBrand = a.inquiry_brand_id ?? a.preferred_brand_id;
    if (!inquiryBrand) { plans.push({ ...base, refused: 'no inquiry brand' }); continue; }
    const assign = options.assignSales?.includes(id) && !a.assigned_sales_user_id;
    if (assign) base.assign_sales = true;
    else if (!a.assigned_sales_user_id) base.notes.push(`no assigned Sales user: "Sales completed by" is ${actors.salesName} (#${actors.salesId}); the assignment and the (empty) handler are left as they are`);
    const handlerId = assign ? actors.salesId : (a.assigned_sales_user_id ? Number(a.assigned_sales_user_id) : null);

    // When the applicant entered Scheduling and when it left it (the activities must fit in between).
    const [stage] = await db.query(
      `select (select max(created_at) from applicant_status_histories where applicant_id = $1 and to_status = 'scheduled') as entered,
              (select min(created_at) from applicant_status_histories where applicant_id = $1 and from_status = 'scheduled' and to_status <> 'scheduled') as left_at`, [id],
    );
    // Business hours on the SAME date as the existing Sales completion (Manila time):
    //   Orientation/Tasting 09:00–12:00, Sales completed 12:30, Admin 13:00
    //   Training            14:00–15:00, Sales completed 15:30, Admin 16:00
    const SLOT: Record<string, [string, string, string, string]> = { orientation: ['09:00', '12:00', '12:30', '13:00'], training: ['14:00', '15:00', '15:30', '16:00'] };
    const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+08:00`).getTime();
    const slotOf = (r: Row) => {
      const given = options.slots?.[Number(r.id)];
      const day = given?.day ?? new Date(new Date(r.completed_at).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
      const [s, e, sales, admin] = given ? [given.start, given.end, given.sales, given.admin] : SLOT[r.activity_type];
      return { day, start: at(day, s), end: at(day, e), sales: at(day, sales), admin: at(day, admin), adminLabel: admin };
    };
    const os = slotOf(orientation);
    const ts = slotOf(training);
    const fits: string[] = [];
    if (os.end + 60 * MIN > ts.start) fits.push('Orientation/Tasting would not end 1 hour before Training starts');
    for (const [r, start, end, d] of [[orientation, os.start, os.end, os], [training, ts.start, ts.end, ts]] as const) {
      const notes: string[] = [...fits];
      if (stage?.left_at && d.admin >= new Date(stage.left_at).getTime()) {
        notes.push(`DOES NOT FIT: Admin attended ${d.day} ${d.adminLabel} is after the applicant left Scheduling (${iso(stage.left_at)})`);
      }
      if (stage?.entered && start < new Date(stage.entered).getTime()) notes.push(`warning: starts before the applicant entered Scheduling (${iso(stage.entered)})`);
      if (r.p_sales && Math.abs(new Date(r.p_sales).getTime() - new Date(r.completed_at).getTime()) > MIN) notes.push(`the session seat said Sales completed ${iso(r.p_sales)}: aligned to the new time`);
      const [session] = r.session_id ? await db.query(`select * from schedule_sessions where id = $1`, [r.session_id]) : [];
      if (session) {
        const [others] = await db.query(`select count(*)::int as n from schedule_session_participants where session_id = $1 and id <> $2 and attendance_status not in ('cancelled', 'removed')`, [session.id, r.p_id]);
        if (others.n) { plans.push({ ...base, refused: `session #${session.id} seats other applicants` }); continue; }
      } else notes.push('no Master Schedule session: one is created (completed) so it shows there');
      const copies: Copy[] = [];
      const add = (type: string, folder: string) => {
        const src = pick();
        const ext = String(src.original_name).split('.').pop()?.toLowerCase() || 'png';
        const stored = `${crypto.randomUUID()}.${ext}`;
        copies.push({ source: src, type, path: `activities/${r.id}/${folder}/${stored}`, stored_name: stored });
      };
      if (r.activity_type === 'orientation') { add('attendance_proof', 'proof'); add('attendance_proof', 'proof'); add('brand_selection', 'brand'); } else add('attendance_proof', 'proof');
      base.activities.push({
        id: Number(r.id), type: r.activity_type, applicant_id: id, session: session ?? null, create_session: !session, participant: r.p_id ? { id: r.p_id } : null, copies, notes, handler_id: handlerId,
        old: { starts_at: iso(r.starts_at), ends_at: iso(r.ends_at), duration_minutes: r.duration_minutes, completed_at: iso(r.completed_at), review_status: r.review_status, selected_brand_id: r.selected_brand_id,
          session_start: iso(session?.start_at), session_end: iso(session?.end_at) },
        next: {
          starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), duration_minutes: Math.round((end - start) / MIN), completed_at: new Date(d.sales).toISOString(),
          completion_submitted_at: new Date(d.sales).toISOString(), reviewed_at: new Date(d.admin).toISOString(), review_status: 'accepted',
          selected_brand_id: r.activity_type === 'orientation' ? Number(inquiryBrand) : null,
        },
      });
    }
    const orientationPlan = base.activities.find((x) => x.type === 'orientation');
    base.brand_lock = { brand_locked_at: orientationPlan?.next.reviewed_at, brand_locked_by_user_id: actors.adminId, preferred_brand_id: Number(inquiryBrand) };
    plans.push(base);
  }
  // Same Sales user 1-hour buffer and no overlapping Training (other sessions, not the ones moved here).
  const moving = plans.flatMap((p) => p.activities);
  for (const act of moving) {
    const movedIds = moving.map((m) => m.session?.id).filter(Boolean);
    const handler = act.handler_id ?? act.session?.handler_id ?? null;
    const clashes = await db.query(
      `select id, activity_type, start_at from schedule_sessions where status <> 'cancelled' and id <> all($1::bigint[])
         and ((activity_type = 'training' and $2 = 'training' and start_at < $4 and end_at > $3)
           or ($5::bigint is not null and handler_id = $5 and start_at < $4::timestamptz + interval '60 minutes' and end_at > $3::timestamptz - interval '60 minutes'))`,
      [`{${movedIds.join(',') || 0}}`, act.type, act.next.starts_at, act.next.ends_at, handler],
    );
    if (clashes.length) act.notes.push(`DOES NOT FIT: clashes with session #${clashes.map((c: Row) => `${c.id} (${c.activity_type})`).join(', #')} (same Sales user within 1 hour, or another Training)`);
  }
  if (!apply) return plans;
  if (plans.some((p) => p.refused) || moving.some((m) => m.notes.some((n) => n.startsWith('DOES NOT FIT')))) throw new Error('Refused or not-fitting rows: nothing applied.');
  if (!files) throw new Error('Apply needs the storage client.');

  const copied: string[] = [];
  try {
    for (const act of moving) for (const c of act.copies) { await files.copy(c.source.path, c.path); copied.push(c.path); }
    await db.tx(async (tx) => {
      for (const p of plans) {
        if (p.assign_sales) {
          // Assigned Sales user, as the Reassign action writes it (stage history + audit).
          await tx.query(`update applicants set assigned_sales_user_id = $2, assigned_sales_at = now(), assigned_sales_by_user_id = $3 where id = $1 and assigned_sales_user_id is null`, [p.id, actors.salesId, actors.adminId]);
          await tx.query(
            `insert into applicant_stage_histories (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, step, old_values, new_values, actor_role)
             values ($1, $2, $2, $3, $4, now(), 'sales_assigned', 'assignment', $5, $6, 'admin')`,
            [p.id, p.applicant.status, `Assigned to ${actors.salesName} (sample/test data backfill).`, actors.adminId,
              JSON.stringify({ assigned_sales_user_id: null, assigned_sales: null }), JSON.stringify({ assigned_sales_user_id: actors.salesId, assigned_sales: actors.salesName })],
          );
          await tx.query(
            `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'applicant.sales_assigned', $1, $2, $3, $4, now())`,
            [APPLICANT_MODEL, p.id, JSON.stringify({ assigned_sales_user_id: null }), JSON.stringify({ assigned_sales_user_id: actors.salesId, handler_sessions: p.activities.map((x) => x.session?.id ?? 'new'), note: 'Sample/test data backfill.', script: 'backfill_legacy_activity_proof' })],
          );
        }
        for (const act of p.activities) {
          const n = act.next;
          await tx.query(
            `update activity_schedules set starts_at = $2, ends_at = $3, duration_minutes = $11, attended = true, actual_started_at = $2, completed_at = $6,
               assigned_to_user_id = coalesce($12, assigned_to_user_id),
               handler_name = coalesce(handler_name, $4), result_notes = coalesce(nullif(result_notes, ''), $5),
               completion_submitted_at = $6, completion_submitted_by_user_id = $7, review_status = 'accepted', reviewed_at = $8, reviewed_by_user_id = $9,
               return_reason = null, selected_brand_id = coalesce($10, selected_brand_id) where id = $1`,
            [act.id, n.starts_at, n.ends_at, actors.salesName, NOTE, n.completion_submitted_at, actors.salesId, n.reviewed_at, actors.adminId, n.selected_brand_id, n.duration_minutes, act.handler_id],
          );
          let sessionId = act.session?.id ?? null;
          if (act.create_session) {
            const [s] = await tx.query(
              `insert into schedule_sessions (activity_type, brand_id, start_at, end_at, handler_id, venue, status, max_capacity, created_by)
               values ($1, $2, $3, $4, $5, 'Main Office (In-person)', 'completed', $6, $7) returning id`,
              [act.type, act.type === 'training' ? p.applicant.preferred_brand_id : null, n.starts_at, n.ends_at, act.handler_id, act.type === 'training' ? 10 : 5, actors.adminId],
            );
            sessionId = s.id;
            await tx.query(`update schedule_sessions set legacy_session_key = $2 where id = $1`, [sessionId, `session-${sessionId}`]);
            await tx.query(`update activity_schedules set session_key = $2 where id = $1`, [act.id, `session-${sessionId}`]);
            await tx.query(`insert into schedule_session_participants (session_id, applicant_id, activity_schedule_id, attendance_status) values ($1, $2, $3, 'attended')`, [sessionId, p.id, act.id]);
            await tx.query(`insert into schedule_session_history (session_id, action, from_value, to_value, performed_by, performed_by_role, remarks) values ($1, 'created', null, $2, null, 'system', $3)`,
              [sessionId, JSON.stringify({ activity_schedule_id: act.id }), NOTE]);
          } else {
            await tx.query(`update schedule_sessions set start_at = $2, end_at = $3, handler_id = coalesce($4, handler_id) where id = $1`, [sessionId, n.starts_at, n.ends_at, act.handler_id]);
            await tx.query(`insert into schedule_session_history (session_id, action, from_value, to_value, performed_by, performed_by_role, remarks) values ($1, 'rescheduled', $2, $3, null, 'system', $4)`,
              [sessionId, JSON.stringify({ start_at: act.old.session_start, end_at: act.old.session_end, handler_id: act.session?.handler_id ?? null }), JSON.stringify({ start_at: n.starts_at, end_at: n.ends_at, handler_id: act.handler_id }), NOTE]);
          }
          await tx.query(
            `update schedule_session_participants set attendance_status = 'attended', sales_completed_at = $2, sales_completed_by = $3,
               admin_attended_at = $4, admin_attended_by = $5, admin_attended_by_name = $6 where activity_schedule_id = $1`,
            [act.id, n.completion_submitted_at, actors.salesId, n.reviewed_at, actors.adminId, actors.adminName],
          );
          const docIds: number[] = [];
          for (const c of act.copies) {
            const [d] = await tx.query(
              `insert into documents (documentable_type, documentable_id, type, original_name, stored_name, disk, path, mime_type, size_bytes, uploaded_by_user_id, metadata, created_at, updated_at)
               values ($1, $2, $3, $4, $5, 'private', $6, $7, $8, $9, $10, $11, $11) returning id`,
              [ACTIVITY_MODEL, act.id, c.type, `sample-${c.type === 'brand_selection' ? 'brand-selection' : 'attendance'}-${c.source.original_name}`, c.stored_name, c.path,
                c.source.mime_type, c.source.size_bytes, actors.salesId, JSON.stringify({ sample_test_data: true, copied_from_document_id: Number(c.source.id) }), n.completion_submitted_at],
            );
            docIds.push(Number(d.id));
            await tx.query(`insert into activity_document_views (document_id, user_id, first_viewed_at, last_viewed_at) values ($1, $2, $3, $3) on conflict do nothing`, [d.id, actors.adminId, n.reviewed_at]);
          }
          await tx.query(
            `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.legacy_proof_backfilled', $1, $2, $3, $4, now())`,
            [ACTIVITY_MODEL, act.id, JSON.stringify(act.old), JSON.stringify({ ...n, session_id: sessionId, created_session: act.create_session, document_ids: docIds,
              copied_from_document_ids: act.copies.map((c) => Number(c.source.id)), note: 'Files are sample/test data copied from existing uploads.', script: 'backfill_legacy_activity_proof' })],
          );
        }
        // The applicant: brand locked at the verify, milestone details (who and when) as Verify writes them.
        const [a] = await tx.query(`select milestone_details, brand_locked_at from applicants where id = $1 for update`, [p.id]);
        const details = { ...(a.milestone_details ?? {}) };
        for (const act of p.activities) {
          const key = act.type === 'orientation' ? 'orientation_attended' : 'training_completed';
          details[key] = { on: new Date(new Date(act.next.reviewed_at).getTime() + 8 * 3600e3).toISOString().slice(0, 16), by: `${actors.adminName} (Admin)`, by_user_id: actors.adminId };
        }
        await tx.query(`update applicants set milestone_details = $2, brand_locked_at = coalesce(brand_locked_at, $3), brand_locked_by_user_id = coalesce(brand_locked_by_user_id, $4), inquiry_brand_id = coalesce(inquiry_brand_id, $5) where id = $1`,
          [p.id, JSON.stringify(details), p.brand_lock.brand_locked_at, actors.adminId, p.brand_lock.preferred_brand_id]);
        await tx.query(
          `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.legacy_proof_backfilled', $1, $2, $3, $4, now())`,
          [APPLICANT_MODEL, p.id, JSON.stringify({ milestone_details: a.milestone_details, brand_locked_at: a.brand_locked_at }),
            JSON.stringify({ milestone_details: details, ...p.brand_lock, note: 'Sample/test data backfill.', script: 'backfill_legacy_activity_proof' })],
        );
      }
    });
  } catch (error) {
    // Nothing in the database changed: drop the copied objects too.
    if (copied.length) await files.remove(copied).catch(() => {});
    throw error;
  }
  return plans;
}

export type AssignPlan = { id: number; code: string; name: string; refused?: string; sessions: Row[]; activities: number[]; clashes: string[] };

/** Assigns the Sales user (where none) and sets the handler of the applicant's Orientation/Tasting and Training. */
export async function assignSalesOnly(db: Db, ids: number[], actors: Actors, apply: boolean): Promise<AssignPlan[]> {
  const plans: AssignPlan[] = [];
  for (const id of ids) {
    const [a] = await db.query(`select id, applicant_code, full_name, status, assigned_sales_user_id from applicants where id = $1`, [id]);
    const base = { id, code: a?.applicant_code ?? '—', name: a?.full_name ?? '—', sessions: [] as Row[], activities: [] as number[], clashes: [] as string[] };
    if (!a) { plans.push({ ...base, refused: 'applicant not found' }); continue; }
    if (a.assigned_sales_user_id) { plans.push({ ...base, refused: `already assigned to user #${a.assigned_sales_user_id}` }); continue; }
    const acts = await db.query(`select id from activity_schedules where applicant_id = $1 and activity_type in ('orientation', 'training') and assigned_to_user_id is null order by id`, [id]);
    const sessions = await db.query(
      `select distinct s.id, s.activity_type, s.status, s.start_at, s.end_at from schedule_sessions s join schedule_session_participants p on p.session_id = s.id
       where p.applicant_id = $1 and s.activity_type in ('orientation', 'training') and s.handler_id is null order by s.id`, [id],
    );
    for (const s of sessions) {
      const near = await db.query(
        `select id, activity_type, start_at, end_at from schedule_sessions where id <> $1 and handler_id = $2 and status <> 'cancelled'
           and start_at < $4::timestamptz + interval '60 minutes' and end_at > $3::timestamptz - interval '60 minutes'`,
        [s.id, actors.salesId, s.start_at, s.end_at],
      );
      for (const n of near) base.clashes.push(`session #${s.id} (${s.activity_type}) would be within 1 hour of ${actors.salesName}'s session #${n.id} (${n.activity_type})`);
    }
    plans.push({ ...base, sessions, activities: acts.map((r: Row) => Number(r.id)) });
  }
  if (!apply) return plans;
  if (plans.some((p) => p.refused)) throw new Error('Refused rows: nothing applied.');
  await db.tx(async (tx) => {
    for (const p of plans) {
      const [a] = await tx.query(`select status from applicants where id = $1 for update`, [p.id]);
      await tx.query(`update applicants set assigned_sales_user_id = $2, assigned_sales_at = now(), assigned_sales_by_user_id = $3 where id = $1 and assigned_sales_user_id is null`, [p.id, actors.salesId, actors.adminId]);
      await tx.query(
        `insert into applicant_stage_histories (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, step, old_values, new_values, actor_role)
         values ($1, $2, $2, $3, $4, now(), 'sales_assigned', 'assignment', $5, $6, 'admin')`,
        [p.id, a.status, `Assigned to ${actors.salesName} (sample/test data).`, actors.adminId,
          JSON.stringify({ assigned_sales_user_id: null, assigned_sales: null }), JSON.stringify({ assigned_sales_user_id: actors.salesId, assigned_sales: actors.salesName })],
      );
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'applicant.sales_assigned', $1, $2, $3, $4, now())`,
        [APPLICANT_MODEL, p.id, JSON.stringify({ assigned_sales_user_id: null }), JSON.stringify({ assigned_sales_user_id: actors.salesId, note: 'Sample/test data.', script: 'backfill_legacy_activity_proof --assign-only' })],
      );
      for (const s of p.sessions) {
        await tx.query(`update schedule_sessions set handler_id = $2 where id = $1 and handler_id is null`, [s.id, actors.salesId]);
        await tx.query(
          `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.handler_backfilled', 'App\\Models\\ScheduleSession', $1, $2, $3, now())`,
          [s.id, JSON.stringify({ handler_id: null }), JSON.stringify({ handler_id: actors.salesId, handler: actors.salesName, applicant_id: p.id, script: 'backfill_legacy_activity_proof --assign-only' })],
        );
      }
      for (const id of p.activities) {
        await tx.query(`update activity_schedules set assigned_to_user_id = $2 where id = $1 and assigned_to_user_id is null`, [id, actors.salesId]);
        await tx.query(
          `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'schedule.handler_backfilled', $1, $2, $3, $4, now())`,
          [ACTIVITY_MODEL, id, JSON.stringify({ assigned_to_user_id: null }), JSON.stringify({ assigned_to_user_id: actors.salesId, handler: actors.salesName, applicant_id: p.id, script: 'backfill_legacy_activity_proof --assign-only' })],
        );
      }
    }
  });
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/backfill_legacy_activity_proof.ts'));
if (isMain) {
  const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=')[1];
  const ids = String(arg('ids') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const apply = process.argv.includes('--apply');
  if (!ids.length || apply === process.argv.includes('--dry-run')) { console.error('Usage: --ids=6,9,23 and exactly one of --dry-run or --apply'); process.exit(2); }
  if (ids.includes(22)) { console.error('Christian Lopez (22) is excluded.'); process.exit(2); }
  const { openScriptDb, readEnv, readOnly } = await import('./lib/scriptDb.ts');
  const env = await readEnv();
  const db = await openScriptDb();
  const local = (d: unknown) => (d ? new Date(new Date(d as string).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—');
  try {
    const [sales] = await db.query(`select u.id, u.full_name from users u join roles r on r.id = u.role_id where u.id = 3 and r.name = 'sales'`);
    const [admin] = await db.query(`select u.id, u.full_name from users u join roles r on r.id = u.role_id where r.name = 'admin' and u.account_status = 'active' order by u.id limit 1`);
    const actors = { salesId: Number(sales.id), salesName: sales.full_name, adminId: Number(admin.id), adminName: admin.full_name };
    let files: Files | undefined;
    if (apply) {
      const { createClient } = await import('@supabase/supabase-js');
      const storage = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from('private');
      files = {
        copy: async (from, to) => { const { error } = await storage.copy(from, to); if (error) throw new Error(`storage copy ${from}: ${error.message}`); },
        remove: async (paths) => { await storage.remove(paths); },
      };
    }
    if (process.argv.includes('--assign-only')) {
      const res = apply ? await assignSalesOnly(db, ids, actors, true) : await readOnly(db, (tx) => assignSalesOnly(tx, ids, actors, false));
      console.log(apply ? '== APPLIED (assign only)' : '== DRY RUN (assign only, nothing changed)');
      for (const p of res) {
        console.log(`${p.code} ${p.name}${p.refused ? ` — REFUSED: ${p.refused}` : `: assigned Sales user -> ${actors.salesName} (#${actors.salesId})`}`);
        for (const s of p.sessions) console.log(`  session #${s.id} ${s.activity_type} ${s.status} ${local(s.start_at)}–${local(s.end_at)}: handler -> ${actors.salesName}`);
        if (p.activities.length) console.log(`  activities #${p.activities.join(', #')}: handler -> ${actors.salesName}`);
        for (const c of p.clashes) console.log(`  note: ${c}`);
      }
      process.exit(0);
    }
    const assignSales = String(arg('assign-sales') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const slots: Record<number, Slot> = {};
    for (const part of String(arg('slots') ?? '').split(',').filter(Boolean)) {
      const aid = part.slice(0, part.indexOf(':'));
      const rest = part.slice(part.indexOf(':') + 1);
      const [day, start, end, sales, admin] = rest.split('/');
      slots[Number(aid)] = { day, start, end, sales, admin };
    }
    const plans = apply ? await backfillLegacyProof(db, ids, actors, true, files, { assignSales, slots })
      : await readOnly(db, (tx) => backfillLegacyProof(tx, ids, actors, false, undefined, { assignSales, slots }));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)', `· Sales completed by ${actors.salesName} (#${actors.salesId}) · Admin verified by ${actors.adminName} (#${actors.adminId})`);
    for (const p of plans) {
      console.log(`\n${p.code} ${p.name}${p.refused ? ` — REFUSED: ${p.refused}` : ''}`);
      if (p.assign_sales) console.log(`  assign: ${actors.salesName} (#${actors.salesId}) becomes the assigned Sales user; the handler of the Orientation/Tasting and Training sessions is set to them (audit + stage history)`);
      for (const n of p.notes) console.log(`  note: ${n}`);
      for (const a of p.activities) {
        console.log(`  #${a.id} ${a.type === 'orientation' ? 'Orientation/Tasting' : 'Training'}: scheduled ${local(a.old.starts_at)}–${local(a.old.ends_at)} -> ${local(a.next.starts_at)}–${local(a.next.ends_at)} · session ${a.session ? `#${a.session.id} (${local(a.old.session_start)} -> same new slot)` : 'NEW'}`);
        console.log(`     Sales completed ${local(a.next.completion_submitted_at)} · Admin verified ${local(a.next.reviewed_at)} · review ${a.old.review_status ?? '-'} -> accepted${a.next.selected_brand_id ? ` · selected brand #${a.next.selected_brand_id}` : ''}`);
        console.log(`     files: ${a.copies.map((c) => `${c.type} <- copy of doc #${c.source.id} "${c.source.original_name}"`).join('; ')} (+ Admin viewed rows)`);
        for (const n of a.notes) console.log(`     note: ${n}`);
      }
      if (!p.refused) console.log(`  brand: selected = inquiry brand #${p.brand_lock.preferred_brand_id}; locked at ${local(p.brand_lock.brand_locked_at)} by Admin`);
    }
  } finally {
    await db.close();
  }
}
