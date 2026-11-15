// One-off: Orientation and Product Tasting become ONE activity, "Orientation/Tasting" (stored key
// 'orientation'). For the listed applicants only:
//  - every Product Tasting schedule is removed, with its session participants and its Product Tasting
//    sessions; its proof files move onto the applicant's Orientation/Tasting record (nothing is lost);
//  - an applicant still AT Scheduling whose Orientation was done under the old flow is REOPENED, so Sales
//    submits attendance proof + brand document + selected brand and Admin verifies under the new flow;
//    the old completion and attended values are kept in applicant_stage_histories and audit_logs;
//  - applicants past Scheduling are legacy and keep their Orientation as it is.
// Every removed row is written in full to audit_logs first (session history cascades with a session).
//
// Usage (from the project root, reads .env):
//   node --no-warnings supabase/scripts/merge_product_tasting.ts --ids=6,8,9,10,19,22,23 --dry-run
//   node --no-warnings supabase/scripts/merge_product_tasting.ts --ids=6,8,9,10,19,22,23 --apply
import type { Db, Row } from '../functions/api/lib/db.ts';

const ACTIVITY_MODEL = 'App\\Models\\ActivitySchedule';
const APPLICANT_MODEL = 'App\\Models\\Applicant';
const PAST_SCHEDULING = ['loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee', 'rejected'];
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export type MergePlan = {
  id: number; code: string | null; name: string; stage: string; action: 'merge' | 'refused' | 'nothing to do'; reason?: string;
  orientation: Row | null; legacy: boolean; reopen: boolean;
  remove_activities: Row[]; remove_participants: Row[]; remove_sessions: Row[]; move_documents: Row[]; notes: string[];
};

export async function mergeProductTasting(db: Db, ids: number[], apply: boolean): Promise<MergePlan[]> {
  const plans: MergePlan[] = [];
  for (const id of ids) {
    const [a] = await db.query(`select id, applicant_code, full_name, status, archived_at, milestones, milestone_details from applicants where id = $1`, [id]);
    const base = { id, code: a?.applicant_code ?? null, name: a?.full_name ?? '—', stage: a ? `${a.status}${a.archived_at ? ' (archived)' : ''}` : '—', orientation: null, legacy: false, reopen: false, remove_activities: [], remove_participants: [], remove_sessions: [], move_documents: [], notes: [] as string[] };
    if (!a) { plans.push({ ...base, action: 'refused', reason: 'applicant not found' }); continue; }
    const orientations = await db.query(`select * from activity_schedules where applicant_id = $1 and activity_type = 'orientation' and status <> 'cancelled' and approval_status <> 'rejected' order by id`, [id]);
    const tastings = await db.query(`select * from activity_schedules where applicant_id = $1 and activity_type = 'product_tasting' order by id`, [id]);
    const orientation = orientations.at(-1) ?? null;
    if (!tastings.length && !orientation) { plans.push({ ...base, action: 'nothing to do' }); continue; }
    if (tastings.length && !orientation) {
      plans.push({ ...base, action: 'refused', reason: 'Product Tasting with no Orientation: convert by hand (none were found in Step 0)' });
      continue;
    }
    const tastingIds = tastings.map((t: Row) => Number(t.id));
    const participants = tastingIds.length ? await db.query(
      `select p.* from schedule_session_participants p join schedule_sessions s on s.id = p.session_id
       where s.activity_type = 'product_tasting' and p.applicant_id = $1 order by p.id`, [id],
    ) : [];
    const sessionIds = [...new Set(participants.map((p: Row) => Number(p.session_id)))];
    const sessions: Row[] = [];
    const notes: string[] = [];
    for (const sid of sessionIds) {
      const [s] = await db.query(`select * from schedule_sessions where id = $1`, [sid]);
      const [others] = await db.query(`select count(*)::int as n from schedule_session_participants where session_id = $1 and applicant_id <> all($2::bigint[])`, [sid, `{${ids.join(',')}}`]);
      if (others.n > 0) { notes.push(`session #${sid} also seats applicants outside this list: only this applicant's seat is removed`); continue; }
      sessions.push(s);
    }
    const documents = tastingIds.length ? await db.query(
      `select id, documentable_id, type, original_name from documents where documentable_type = $1 and documentable_id = any($2::bigint[]) order by id`, [ACTIVITY_MODEL, `{${tastingIds.join(',')}}`],
    ) : [];
    const oldDone = orientation.status === 'completed';
    const legacy = oldDone && PAST_SCHEDULING.includes(a.status);
    // Only an old-flow completion reopens: one done under the new flow carries a selected brand
    // (so running the script again never reopens a verified Orientation/Tasting).
    const reopen = oldDone && a.status === 'scheduled' && !orientation.selected_brand_id;
    // No tasting and nothing to reopen: Orientation/Tasting is only a new label on the same record.
    if (!tastings.length && !reopen) { plans.push({ ...base, orientation, action: 'nothing to do', reason: 'label only (same Orientation record)' }); continue; }
    if (oldDone && !legacy && !reopen) notes.push(`stage ${a.status}: Orientation kept as it is`);
    plans.push({
      ...base, action: 'merge', orientation, legacy, reopen,
      remove_activities: tastings, remove_participants: participants, remove_sessions: sessions, move_documents: documents, notes,
    });
  }
  if (!apply) return plans;

  for (const plan of plans.filter((p) => p.action === 'merge')) {
    await db.tx(async (tx) => {
      const [a] = await tx.query(`select * from applicants where id = $1 for update`, [plan.id]);
      const o = plan.orientation!;
      const snapshot = {
        removed_product_tastings: plan.remove_activities, removed_participants: plan.remove_participants, removed_sessions: plan.remove_sessions,
        moved_documents: plan.move_documents.map((d) => ({ id: d.id, from_activity_id: d.documentable_id, original_name: d.original_name })),
        orientation_before: plan.reopen ? o : { id: o.id, status: o.status, review_status: o.review_status },
        milestones_before: a.milestones, milestone_details_before: a.milestone_details,
      };
      await tx.query(
        `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, $1, $2, $3, $4, $5, now())`,
        ['applicant.orientation_tasting_merged', APPLICANT_MODEL, plan.id, JSON.stringify(snapshot),
          JSON.stringify({ legacy: plan.legacy, reopened: plan.reopen, orientation_id: o.id, script: 'merge_product_tasting' })],
      );
      if (plan.move_documents.length) {
        await tx.query(`update documents set documentable_id = $1 where documentable_type = $2 and id = any($3::bigint[])`,
          [o.id, ACTIVITY_MODEL, `{${plan.move_documents.map((d) => d.id).join(',')}}`]);
      }
      if (plan.remove_participants.length) await tx.query(`delete from schedule_session_participants where id = any($1::bigint[])`, [`{${plan.remove_participants.map((p) => p.id).join(',')}}`]);
      if (plan.remove_sessions.length) {
        const sids = `{${plan.remove_sessions.map((s) => s.id).join(',')}}`;
        await tx.query(`update schedule_sessions set merged_into_session_id = null where merged_into_session_id = any($1::bigint[])`, [sids]);
        await tx.query(`delete from schedule_sessions where id = any($1::bigint[])`, [sids]);
      }
      if (plan.remove_activities.length) await tx.query(`delete from activity_schedules where id = any($1::bigint[])`, [`{${plan.remove_activities.map((t) => t.id).join(',')}}`]);

      const milestones = { ...(a.milestones ?? {}) };
      const details = { ...(a.milestone_details ?? {}) };
      if (plan.reopen) {
        // Back to a live, already-started Orientation/Tasting: Sales submits under the new flow.
        await tx.query(
          `update activity_schedules set status = 'confirmed', completed_at = null, attended = null, actual_started_at = null, handler_name = null, no_show_reason = null,
             completion_submitted_at = null, completion_submitted_by_user_id = null, review_status = null, reviewed_by_user_id = null, reviewed_at = null, return_reason = null
           where id = $1`, [o.id],
        );
        await tx.query(
          `update schedule_session_participants set attendance_status = 'scheduled', sales_completed_by = null, sales_completed_at = null,
             admin_attended_by = null, admin_attended_by_name = null, admin_attended_at = null where activity_schedule_id = $1`, [o.id],
        );
        delete milestones.orientation_attended;
        delete details.orientation_attended;
      }
      // Product Tasting is no longer an activity: its milestone flag goes (kept in the audit snapshot).
      delete milestones.product_tasting_attended;
      delete details.product_tasting_attended;
      await tx.query(`update applicants set milestones = $2, milestone_details = $3 where id = $1`, [plan.id, JSON.stringify(milestones), JSON.stringify(details)]);
      await tx.query(
        `insert into applicant_stage_histories (applicant_id, from_stage, to_stage, remarks, changed_by_user_id, changed_at, event, step, old_values, new_values, actor_role)
         values ($1, $2, $2, $3, null, now(), $4, 'orientation', $5, $6, 'system')`,
        [plan.id, a.status,
          plan.reopen ? 'Orientation and Product Tasting merged into Orientation/Tasting: reopened for proof, brand document and selected brand under the new flow.'
            : 'Orientation and Product Tasting merged into Orientation/Tasting (legacy record kept as completed).',
          plan.reopen ? 'orientation_tasting_reopened' : 'orientation_tasting_merged',
          JSON.stringify({
            orientation: { id: o.id, status: o.status, review_status: o.review_status, completed_at: iso(o.completed_at), reviewed_at: iso(o.reviewed_at), actual_started_at: iso(o.actual_started_at) },
            product_tastings: plan.remove_activities.map((t) => ({ id: t.id, status: t.status, starts_at: iso(t.starts_at), completed_at: iso(t.completed_at) })),
          }),
          JSON.stringify({ orientation: { id: o.id, status: plan.reopen ? 'confirmed' : o.status }, moved_documents: plan.move_documents.map((d) => d.id) })],
      );
    });
  }
  return plans;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/merge_product_tasting.ts'));
if (isMain) {
  const { readFileSync } = await import('node:fs');
  const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=')[1];
  const ids = String(arg('ids') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const apply = process.argv.includes('--apply');
  if (!ids.length || apply === process.argv.includes('--dry-run')) { console.error('Usage: --ids=6,8,… and exactly one of --dry-run or --apply'); process.exit(2); }
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const { default: postgres } = await import('postgres');
  const sql = postgres(env.SUPABASE_DB_URL, { ssl: 'require', max: 1 });
  const wrap = (runner: any): Db => ({ query: async (text: string, params: unknown[] = []) => (await runner.unsafe(text, params)) as any, tx: (fn) => sql.begin((t: any) => fn(wrap(t))) as any });
  const t = (d: unknown) => (d ? new Date(new Date(d as string).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '');
  try {
    const plans = await mergeProductTasting(wrap(sql), ids, apply);
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(plans.map((p) => ({
      id: p.id, code: p.code, name: p.name, stage: p.stage, action: p.action + (p.reason ? `: ${p.reason}` : ''),
      orientation: p.orientation ? `#${p.orientation.id} ${p.orientation.status}` : '—',
      result: p.action !== 'merge' ? '' : p.reopen ? 'REOPEN (new-flow proof + brand)' : p.legacy ? 'legacy, kept done' : `kept ${p.orientation?.status}`,
      remove_tastings: p.remove_activities.map((x) => `#${x.id} ${x.status}`).join(', ') || '—',
      remove_sessions: p.remove_sessions.map((s) => `#${s.id}`).join(', ') || '—',
      seats: p.remove_participants.length, move_files: p.move_documents.length,
    })));
    for (const p of plans) {
      if (p.reopen) {
        const o = p.orientation!;
        console.log(`  ${p.code} reopen: Orientation #${o.id} ${o.status}/${o.review_status ?? '-'} (Sales done ${t(o.completed_at)}, Admin ${t(o.reviewed_at)}) -> confirmed, not submitted; orientation_attended cleared. Old values kept in history + audit.`);
      }
      for (const d of p.move_documents) console.log(`  ${p.code} file "${d.original_name}" (#${d.id}): tasting #${d.documentable_id} -> Orientation/Tasting #${p.orientation?.id}`);
      for (const n of p.notes) console.log(`  ${p.code} note: ${n}`);
    }
  } finally {
    await sql.end();
  }
}
