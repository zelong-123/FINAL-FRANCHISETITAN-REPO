// TEST DATA — one-time, logged exception: re-times Ceejay Francisco's WHOLE pipeline (applicant #6,
// inquiry #1), which was done in ~26 minutes on Nov 3 2026, onto a realistic timeline that follows
// every rule (activities completed after they start, Orientation/Tasting verified before Training is
// scheduled, the Sales handler's 1-hour buffer, no overlapping Training, records inside their stage,
// business hours, weekdays, nothing in the future).
//
// The append-only history tables (applicant_status_histories, applicant_stage_histories) are changed
// for this applicant ONLY. Everything runs in ONE transaction:
//   1. a "data.timeline_retimed_exception" audit row with a snapshot of every old value;
//   2. the append-only triggers are disabled;
//   3. only rows that belong to the applicant are updated (a guard aborts otherwise);
//   4. the triggers are re-enabled and checked before commit; any error rolls everything back.
// audit_logs and follow_ups are never edited. Payment amounts are not touched. Rows that record
// today's data maintenance (stage history "orientation_tasting_merged" and "sales_assigned",
// assigned_sales_at) keep their real time.
//
//   node --no-warnings supabase/scripts/retime_ceejay_timeline.ts --dry-run
//   node --no-warnings supabase/scripts/retime_ceejay_timeline.ts --apply --approved-by="<name>"
import type { Db, Row } from '../functions/api/lib/db.ts';

export const HISTORY_TRIGGERS: [string, string][] = [
  ['applicant_status_histories', 'applicant_status_histories_append_only'],
  ['applicant_stage_histories', 'applicant_stage_histories_append_only'],
];
/** Manila wall time "2026-10-27 09:30" -> ISO (UTC). */
export const M = (s: string) => new Date(`${s.replace(' ', 'T')}:00+08:00`).toISOString();

export type Change = { stage: string; label: string; table: string; id: string | number; column: string; value: unknown; kind?: 'time' | 'date' | 'json' | 'text' };

/** Who owns a row: always resolves to an applicant id. */
const OWNER: Record<string, string> = {
  applicants: `t.id`,
  franchise_inquiries: `(select a.id from applicants a where a.inquiry_id = t.id limit 1)`,
  applicant_status_histories: `t.applicant_id`, applicant_stage_histories: `t.applicant_id`, applicant_requirements: `t.applicant_id`,
  activity_schedules: `t.applicant_id`, applicant_payment_plans: `t.applicant_id`, applicant_required_payments: `t.applicant_id`,
  payments: `t.applicant_id`, applicant_payments: `t.applicant_id`, payment_requests: `t.applicant_id`, franchisees: `t.applicant_id`,
  documents: `case t.documentable_type
      when 'App\\Models\\Applicant' then t.documentable_id
      when 'App\\Models\\ApplicantRequirement' then (select r.applicant_id from applicant_requirements r where r.id = t.documentable_id)
      when 'App\\Models\\ActivitySchedule' then (select s.applicant_id from activity_schedules s where s.id = t.documentable_id)
      when 'App\\Models\\Payment' then (select p.applicant_id from payments p where p.id = t.documentable_id) end`,
  schedule_session_participants: `(select s.applicant_id from activity_schedules s where s.id = t.activity_schedule_id)`,
  // A session belongs to the applicant only when every seat is theirs.
  schedule_sessions: `(select case when count(distinct s.applicant_id) = 1 then min(s.applicant_id) end from schedule_session_participants p join activity_schedules s on s.id = p.activity_schedule_id where p.session_id = t.id)`,
  schedule_session_history: `(select case when count(distinct s.applicant_id) = 1 then min(s.applicant_id) end from schedule_session_participants p join activity_schedules s on s.id = p.activity_schedule_id where p.session_id = t.session_id)`,
  franchise_locations: `(select f.applicant_id from franchisees f where f.id = t.franchisee_id)`,
  users: `(select a.id from applicants a where a.user_id = t.id limit 1)`,
  system_notifications: `coalesce((t.data->>'applicant_id')::bigint, (select a.id from applicants a where a.inquiry_id = (t.data->>'inquiry_id')::bigint limit 1))`,
};
/** activity_document_views has no id: "documentId:userId". */
const whereOf = (table: string, id: string | number) => (table === 'activity_document_views'
  ? { sql: `t.document_id = $1 and t.user_id = $2`, params: String(id).split(':').map(Number) }
  : { sql: `t.id = $1`, params: [id] });

/** Throws unless the row exists and belongs to the applicant (the guard). */
export async function assertOwned(db: Db, applicantId: number, c: Change) {
  const w = whereOf(c.table, c.id);
  const owner = c.table === 'activity_document_views'
    ? (await db.query(`select ${OWNER.documents} as owner from documents t where t.id = $1`, [w.params[0]]))[0]?.owner
    : OWNER[c.table] ? (await db.query(`select ${OWNER[c.table]} as owner from ${c.table} t where ${w.sql}`, w.params))[0]?.owner : undefined;
  if (owner === undefined) throw new Error(`Guard: ${c.table} #${c.id} not found or not allowed.`);
  if (Number(owner) !== applicantId) throw new Error(`Guard: ${c.table} #${c.id}.${c.column} belongs to applicant #${owner ?? '?'}, not #${applicantId}: nothing applied.`);
}

const same = (kind: string | undefined, a: unknown, b: unknown) => {
  if (a === null || a === undefined || b === null || b === undefined) return a == b; // eslint-disable-line eqeqeq
  if (kind === 'date') return String(a).slice(0, 10) === String(b).slice(0, 10);
  if (kind === 'json') return JSON.stringify(a) === JSON.stringify(b);
  if (kind === 'text') return String(a) === String(b);
  return new Date(a as string).getTime() === new Date(b as string).getTime();
};

async function current(db: Db, c: Change) {
  const w = whereOf(c.table, c.id);
  const [r] = await db.query(`select "${c.column}" as v from ${c.table} t where ${w.sql}`, w.params);
  if (!r) throw new Error(`${c.table} #${c.id} not found.`);
  return r.v;
}

export type Result = { rows: Row[]; pending: (Change & { old: unknown })[]; checks: { rule: string; ok: boolean; detail: string }[] };

/** Dry-run (apply = false) or apply the plan for one applicant. */
export async function retimeTimeline(db: Db, applicantId: number, plan: Change[], opts: { apply: boolean; approvedBy?: string; reason?: string; checks?: (db: Db) => Promise<Result['checks']> }): Promise<Result> {
  const rows: Row[] = [];
  const pending: Result['pending'] = [];
  for (const c of plan) {
    await assertOwned(db, applicantId, c);
    const old = await current(db, c);
    const changed = !same(c.kind, old, c.value);
    if (changed) pending.push({ ...c, old });
    rows.push({ stage: c.stage, record: c.label, field: `${c.table}.${c.column}`, old, new: c.value, change: changed ? 'change' : 'same' });
  }
  const checks = opts.checks ? await opts.checks(db) : [];
  if (!opts.apply || !pending.length) return { rows, pending, checks };
  if (checks.some((x) => !x.ok)) throw new Error(`Rule checks failed: ${checks.filter((x) => !x.ok).map((x) => x.rule).join('; ')}. Nothing applied.`);
  if (!opts.approvedBy) throw new Error('--approved-by is required to apply.');

  await db.tx(async (tx) => {
    // 1. The logged exception, with the old values.
    await tx.query(
      `insert into audit_logs (user_id, action, auditable_type, auditable_id, old_values, new_values, created_at) values (null, 'data.timeline_retimed_exception', 'App\\Models\\Applicant', $1, $2, $3, now())`,
      [applicantId, JSON.stringify({ snapshot: pending.map((p) => ({ table: p.table, id: p.id, column: p.column, value: p.old })) }),
        JSON.stringify({
          applicant_id: applicantId, scope: `applicant #${applicantId} only`, test_data: true, approved_by: opts.approvedBy,
          reason: opts.reason ?? 'Compressed test timeline: re-timed onto a realistic timeline that follows the system rules.',
          triggers_disabled: HISTORY_TRIGGERS.map(([t, g]) => `${t}.${g}`), changes: pending.map((p) => ({ table: p.table, id: p.id, column: p.column, value: p.value })),
          note: 'One-time, logged exception to the append-only history (TEST DATA). audit_logs and follow_ups were not edited.', script: 'retime_ceejay_timeline',
        })],
    );
    // 2. Disable the append-only triggers (inside the transaction: rolled back on any error).
    for (const [table, trigger] of HISTORY_TRIGGERS) await tx.query(`alter table public."${table}" disable trigger "${trigger}"`);
    // 3. Guarded updates: each one must touch exactly one row of this applicant.
    for (const p of pending) {
      await assertOwned(tx, applicantId, p);
      const w = whereOf(p.table, p.id);
      const value = p.kind === 'json' ? JSON.stringify(p.value) : p.value;
      const updated = await tx.query(`update ${p.table} t set "${p.column}" = $${w.params.length + 1} where ${w.sql} returning 1`, [...w.params, value]);
      if (updated.length !== 1) throw new Error(`Guard: ${p.table} #${p.id} updated ${updated.length} rows.`);
    }
    // 4. Re-enable and check before commit.
    for (const [table, trigger] of HISTORY_TRIGGERS) await tx.query(`alter table public."${table}" enable trigger "${trigger}"`);
    await assertTriggersEnabled(tx);
  });
  return { rows, pending, checks };
}

export async function assertTriggersEnabled(db: Db) {
  for (const [table, trigger] of HISTORY_TRIGGERS) {
    const [t] = await db.query(`select tgenabled from pg_trigger where tgname = $1 and tgrelid = $2::regclass`, [trigger, `public.${table}`]);
    if (t?.tgenabled !== 'O') throw new Error(`${table}.${trigger} is not enabled (${t?.tgenabled ?? 'missing'}).`);
  }
}

// ---------- Ceejay's plan (applicant #6, inquiry #1). All times Manila, weekdays, 09:00–18:00. ----------
export function ceejayPlan(milestones: Row, interview: Row): Change[] {
  const p: Change[] = [];
  const add = (stage: string, label: string, table: string, id: string | number, cols: Record<string, unknown>, kind: Change['kind'] = 'time') => {
    for (const [column, value] of Object.entries(cols)) p.push({ stage, label, table, id, column, value, kind: column.endsWith('_date') || column === 'payments_fully_paid_on' ? 'date' : kind });
  };
  // Inquiry — Mon Oct 26
  add('1 Inquiry', 'Inquiry LD-2026-00001', 'franchise_inquiries', 1, { inquiry_date: '2026-10-26', created_at: M('2026-10-26 10:00'), status_changed_at: M('2026-10-27 09:30') });
  add('1 Inquiry', 'Notification: inquiry created', 'system_notifications', 1, { created_at: M('2026-10-26 10:00'), read_at: M('2026-10-26 10:20') });
  add('1 Inquiry', 'Notification: inquiry endorsed', 'system_notifications', 2, { created_at: M('2026-10-26 14:00'), read_at: M('2026-10-26 14:20') });
  // Converted + Qualification requirements — Tue Oct 27
  add('2 Converted', 'Applicant APL-2026-00006', 'applicants', 6, { application_date: '2026-10-27', created_at: M('2026-10-27 09:30') });
  add('2 Converted', 'Status: → Converted', 'applicant_status_histories', 2, { created_at: M('2026-10-27 09:30'), updated_at: M('2026-10-27 09:30') });
  const q: [number, number, string, string][] = [[25, 34, '10:00', '10:30'], [26, 35, '11:00', '11:30'], [27, 36, '13:00', '13:30'], [28, 37, '14:00', '14:30']];
  for (const [req, doc, sub, acc] of q) {
    add('2 Converted', `Requirement #${req}`, 'applicant_requirements', req, { submitted_at: M(`2026-10-27 ${sub}`), created_at: M(`2026-10-27 ${sub}`), reviewed_at: M(`2026-10-27 ${acc}`) });
    add('2 Converted', `Requirement file #${doc}`, 'documents', doc, { created_at: M(`2026-10-27 ${sub}`) });
  }
  p.push({ stage: '2 Converted', label: 'Initial interview date', table: 'applicant_requirements', id: 28, column: 'data', value: { ...interview, interview_date: '2026-10-27' }, kind: 'json' });
  // Qualified + Scheduling — Wed Oct 28
  add('3 Qualified', 'Status: → Qualified', 'applicant_status_histories', 3, { created_at: M('2026-10-28 10:00'), updated_at: M('2026-10-28 10:00') });
  add('3 Qualified', 'Stage: → Qualified', 'applicant_stage_histories', 1, { changed_at: M('2026-10-28 10:00'), created_at: M('2026-10-28 10:00') });
  add('4 Scheduling', 'Status: → Scheduling', 'applicant_status_histories', 4, { created_at: M('2026-10-28 10:30'), updated_at: M('2026-10-28 10:30') });
  add('4 Scheduling', 'Stage: → Scheduling', 'applicant_stage_histories', 2, { changed_at: M('2026-10-28 10:30'), created_at: M('2026-10-28 10:30') });
  // Orientation/Tasting — scheduled Wed Oct 28 10:45, held Fri Oct 30 09:00–12:00
  add('4 Scheduling', 'Orientation/Tasting #1', 'activity_schedules', 1, {
    created_at: M('2026-10-28 10:45'), starts_at: M('2026-10-30 09:00'), ends_at: M('2026-10-30 12:00'), actual_started_at: M('2026-10-30 09:00'),
    completed_at: M('2026-10-30 12:30'), completion_submitted_at: M('2026-10-30 12:30'), reviewed_at: M('2026-10-30 13:30'),
  });
  p.push({ stage: '4 Scheduling', label: 'Orientation/Tasting #1', table: 'activity_schedules', id: 1, column: 'duration_minutes', value: 180, kind: 'text' });
  p.push({ stage: '4 Scheduling', label: 'Orientation/Tasting #1', table: 'activity_schedules', id: 1, column: 'title', value: 'Orientation — Ceejay Francisco (2026-10-30)', kind: 'text' });
  add('4 Scheduling', 'Session #13', 'schedule_sessions', 13, { created_at: M('2026-10-28 10:45'), start_at: M('2026-10-30 09:00'), end_at: M('2026-10-30 12:00') });
  add('4 Scheduling', 'Seat #11', 'schedule_session_participants', 11, { created_at: M('2026-10-28 10:45'), sales_completed_at: M('2026-10-30 12:30'), admin_attended_at: M('2026-10-30 13:30') });
  add('4 Scheduling', 'Session #13 history: created', 'schedule_session_history', 18, { created_at: M('2026-10-28 10:45') });
  add('4 Scheduling', 'Session #13 history: completed', 'schedule_session_history', 19, { created_at: M('2026-10-30 13:30') });
  for (const doc of [38, 39, 40]) add('4 Scheduling', `Orientation file #${doc}`, 'documents', doc, { created_at: M('2026-10-30 12:30') });
  for (const doc of [38, 39]) add('4 Scheduling', `Admin viewed #${doc}`, 'activity_document_views', `${doc}:1`, { first_viewed_at: M('2026-10-30 13:15') });
  add('4 Scheduling', 'Admin viewed #40', 'activity_document_views', '40:1', { first_viewed_at: M('2026-10-30 13:15'), last_viewed_at: M('2026-10-30 13:15') });
  add('4 Scheduling', 'Brand lock', 'applicants', 6, { brand_locked_at: M('2026-10-30 13:30') });
  // Training — scheduled Fri Oct 30 14:00 (after the Orientation/Tasting was verified), held Tue Nov 3 14:00–15:00
  add('4 Scheduling', 'Training #3', 'activity_schedules', 3, {
    created_at: M('2026-10-30 14:00'), starts_at: M('2026-11-03 14:00'), ends_at: M('2026-11-03 15:00'), actual_started_at: M('2026-11-03 14:00'),
    completed_at: M('2026-11-03 15:15'), completion_submitted_at: M('2026-11-03 15:15'), reviewed_at: M('2026-11-03 15:45'),
  });
  p.push({ stage: '4 Scheduling', label: 'Training #3', table: 'activity_schedules', id: 3, column: 'duration_minutes', value: 60, kind: 'text' });
  p.push({ stage: '4 Scheduling', label: 'Training #3', table: 'activity_schedules', id: 3, column: 'title', value: 'Training — Ceejay Francisco (2026-11-03)', kind: 'text' });
  add('4 Scheduling', 'Session #15', 'schedule_sessions', 15, { created_at: M('2026-10-30 14:00'), start_at: M('2026-11-03 14:00'), end_at: M('2026-11-03 15:00') });
  add('4 Scheduling', 'Seat #13', 'schedule_session_participants', 13, { created_at: M('2026-10-30 14:00'), sales_completed_at: M('2026-11-03 15:15'), admin_attended_at: M('2026-11-03 15:45') });
  add('4 Scheduling', 'Session #15 history: created', 'schedule_session_history', 22, { created_at: M('2026-10-30 14:00') });
  add('4 Scheduling', 'Session #15 history: completed', 'schedule_session_history', 23, { created_at: M('2026-11-03 15:45') });
  add('4 Scheduling', 'Training file #41', 'documents', 41, { created_at: M('2026-11-03 15:15') });
  add('4 Scheduling', 'Admin viewed #41', 'activity_document_views', '41:1', { first_viewed_at: M('2026-11-03 15:40'), last_viewed_at: M('2026-11-03 15:40') });
  p.push({ stage: '4 Scheduling', label: 'Milestone details', table: 'applicants', id: 6, column: 'milestone_details', kind: 'json', value: {
    ...milestones,
    orientation_attended: { ...(milestones.orientation_attended ?? {}), on: '2026-10-30T13:30' },
    training_completed: { ...(milestones.training_completed ?? {}), on: '2026-11-03T15:45' },
  } });
  // LOI Submission — Wed Nov 4
  add('5 LOI', 'Status: → LOI Submission', 'applicant_status_histories', 5, { created_at: M('2026-11-04 10:00'), updated_at: M('2026-11-04 10:00') });
  add('5 LOI', 'Stage: → LOI Submission', 'applicant_stage_histories', 3, { changed_at: M('2026-11-04 10:00'), created_at: M('2026-11-04 10:00') });
  add('5 LOI', 'Applicant LOI', 'applicants', 6, { loi_confirmed_at: M('2026-11-04 10:00'), loi_submission_date: '2026-11-04', loi_completed_at: M('2026-11-04 15:00') });
  add('5 LOI', 'LOI file #42', 'documents', 42, { created_at: M('2026-11-04 10:30') });
  add('5 LOI', 'Proposed site #29', 'applicant_requirements', 29, { submitted_at: M('2026-11-04 11:00'), created_at: M('2026-11-04 11:00'), reviewed_at: M('2026-11-04 14:00') });
  add('5 LOI', 'Site photo #43', 'documents', 43, { created_at: M('2026-11-04 11:00') });
  // Payment Record — Wed Nov 4 15:00 → Fri Nov 6 11:00
  add('6 Payment Record', 'Status: → Payment Record', 'applicant_status_histories', 6, { created_at: M('2026-11-04 15:00'), updated_at: M('2026-11-04 15:00') });
  add('6 Payment Record', 'Stage: → Payment Record', 'applicant_stage_histories', 4, { changed_at: M('2026-11-04 15:00'), created_at: M('2026-11-04 15:00') });
  add('6 Payment Record', 'Payment plan #1 (Downpayment + Balance)', 'applicant_payment_plans', 1, { created_at: M('2026-11-05 10:00'), discount_set_at: M('2026-11-05 10:00'), required_set_at: M('2026-11-05 10:05') });
  add('6 Payment Record', 'Applicant: required set', 'applicants', 6, { total_required_set_at: M('2026-11-05 10:00') });
  for (const rp of [3, 4]) add('6 Payment Record', `Required payment #${rp}`, 'applicant_required_payments', rp, { created_at: M('2026-11-05 10:05') });
  add('6 Payment Record', 'Notification: required set', 'system_notifications', 3, { created_at: M('2026-11-05 10:00'), read_at: M('2026-11-05 10:15') });
  add('6 Payment Record', 'Notification: required set', 'system_notifications', 4, { created_at: M('2026-11-05 10:05'), read_at: M('2026-11-05 10:15') });
  const entries: [number, string, string, string, number, number, number][] = [[1, '2026-11-05', '11:00', '11:30', 44, 5, 6], [2, '2026-11-06', '10:00', '10:30', 45, 7, 8]];
  for (const [id, day, asked, verified, receipt, nSub, nOk] of entries) {
    const name = id === 1 ? 'Downpayment' : 'Balance';
    add('6 Payment Record', `${name} entry #${id}`, 'payments', id, { payment_date: day, requested_at: M(`${day} ${asked}`), created_at: M(`${day} ${verified}`), verified_at: M(`${day} ${verified}`) });
    add('6 Payment Record', `${name} receipt #${receipt}`, 'documents', receipt, { created_at: M(`${day} ${verified}`) });
    add('6 Payment Record', `${name} (older table) #${id}`, 'applicant_payments', id, { payment_date: day, created_at: M(`${day} ${verified}`), verified_at: M(`${day} ${verified}`) });
    add('6 Payment Record', `${name} request #${id}`, 'payment_requests', id, { created_at: M(`${day} ${asked}`), reviewed_at: M(`${day} ${verified}`) });
    add('6 Payment Record', `Notification: ${name} submitted`, 'system_notifications', nSub, { created_at: M(`${day} ${asked}`), read_at: M(`${day} ${asked.replace(':00', ':20')}`) });
    add('6 Payment Record', `Notification: ${name} verified`, 'system_notifications', nOk, { created_at: M(`${day} ${verified}`), read_at: M(`${day} ${verified.replace(':30', ':45')}`) });
  }
  add('6 Payment Record', 'Applicant: fully paid / confirmed', 'applicants', 6, { payments_fully_paid_on: '2026-11-06', payment_confirmed_at: M('2026-11-06 11:00') });
  add('6 Payment Record', 'Notification: payment confirmed', 'system_notifications', 9, { created_at: M('2026-11-06 11:00'), read_at: M('2026-11-06 11:15') });
  // For Approval — Fri Nov 6 11:00; Approved — Mon Nov 9 10:00
  add('7 For Approval', 'Status: → For Approval', 'applicant_status_histories', 7, { created_at: M('2026-11-06 11:00'), updated_at: M('2026-11-06 11:00') });
  add('7 For Approval', 'Stage: → For Approval', 'applicant_stage_histories', 5, { changed_at: M('2026-11-06 11:00'), created_at: M('2026-11-06 11:00') });
  add('7 For Approval', 'Applicant: Admin review', 'applicants', 6, { reviewed_at: M('2026-11-09 09:55') });
  add('8 Approved', 'Applicant: approved', 'applicants', 6, { approved_at: M('2026-11-09 10:00') });
  add('8 Approved', 'Status: → Approved', 'applicant_status_histories', 8, { created_at: M('2026-11-09 10:00'), updated_at: M('2026-11-09 10:00') });
  add('8 Approved', 'Stage: → Approved', 'applicant_stage_histories', 6, { changed_at: M('2026-11-09 10:00'), created_at: M('2026-11-09 10:00') });
  add('8 Approved', 'Signed franchise agreement #30', 'applicant_requirements', 30, { submitted_at: M('2026-11-10 10:00'), created_at: M('2026-11-10 10:00'), reviewed_at: M('2026-11-10 11:00') });
  add('8 Approved', 'Agreement file #46', 'documents', 46, { created_at: M('2026-11-10 10:00') });
  // Active Franchisee — Tue Nov 10 14:00 (branch account created = activation), branch at first sign-in 14:30
  add('9 Active', 'Status: → Active Franchisee', 'applicant_status_histories', 9, { created_at: M('2026-11-10 14:00'), updated_at: M('2026-11-10 14:00') });
  add('9 Active', 'Stage: → Active Franchisee', 'applicant_stage_histories', 7, { changed_at: M('2026-11-10 14:00'), created_at: M('2026-11-10 14:00') });
  add('9 Active', 'Franchisee #6', 'franchisees', 6, { approval_date: '2026-11-09', created_at: M('2026-11-10 14:00') });
  add('9 Active', 'Branch account (user #10)', 'users', 10, { created_at: M('2026-11-10 14:00') });
  add('9 Active', 'Branch #7 provisioned', 'franchise_locations', 7, { created_at: M('2026-11-10 14:30') });
  return p;
}

/** The rules, checked against the database as it is (dry-run: the old times; after apply: the new ones). */
export async function ceejayChecks(db: Db, plan: Change[]): Promise<Result['checks']> {
  const out: Result['checks'] = [];
  const check = (rule: string, ok: boolean, detail = '') => out.push({ rule, ok, detail });
  const v = (table: string, id: string | number, column: string) => plan.find((c) => c.table === table && String(c.id) === String(id) && c.column === column)?.value as string;
  const ms = (s: string) => new Date(s).getTime();
  const o = { start: v('activity_schedules', 1, 'starts_at'), end: v('activity_schedules', 1, 'ends_at'), done: v('activity_schedules', 1, 'completed_at'), ok: v('activity_schedules', 1, 'reviewed_at') };
  const t = { made: v('activity_schedules', 3, 'created_at'), start: v('activity_schedules', 3, 'starts_at'), end: v('activity_schedules', 3, 'ends_at'), done: v('activity_schedules', 3, 'completed_at'), ok: v('activity_schedules', 3, 'reviewed_at') };
  check('Orientation/Tasting completed after it ends; verified after that', ms(o.done) >= ms(o.end) && ms(o.ok) > ms(o.done), `${o.start} → done ${o.done} → verified ${o.ok}`);
  check('Training completed after it ends; verified after that', ms(t.done) >= ms(t.end) && ms(t.ok) > ms(t.done));
  check('Orientation/Tasting verified before Training is scheduled', ms(o.ok) < ms(t.made) && ms(t.made) < ms(t.start));
  check('Orientation/Tasting ends ≥ 1 hour before Training starts', ms(t.start) - ms(o.end) >= 3600e3);
  for (const [label, s, e, type] of [['Orientation/Tasting', o.start, o.end, 'orientation'], ['Training', t.start, t.end, 'training']] as const) {
    const clash = await db.query(
      `select ss.id from schedule_sessions ss where ss.id not in (13, 15)
         and ((ss.handler_id = 3 and ss.start_at < $2::timestamptz + interval '1 hour' and ss.end_at > $1::timestamptz - interval '1 hour')
           or ($3 = 'training' and ss.activity_type = 'training' and ss.start_at < $2::timestamptz and ss.end_at > $1::timestamptz))`, [s, e, type]);
    check(`${label}: Sales User 1-hour buffer${type === 'training' ? ' + no overlapping Training' : ''} against all other live sessions`, !clash.length, clash.map((c: Row) => `session #${c.id}`).join(', '));
  }
  const [seats] = await db.query(`select count(*)::int n from schedule_session_participants where session_id = 13`);
  check('Orientation/Tasting session holds at most 5', seats.n <= 5, `${seats.n}/5`);
  const [locks] = await db.query(`select count(*)::int n from schedule_day_locks where day in ('2026-10-30', '2026-11-03')`);
  check('Activity days are not locked', locks.n === 0);
  // Stage windows (from the new status history) and order.
  const st = (id: number) => ms(v('applicant_status_histories', id, 'created_at'));
  const windows: [string, number, number][] = [['2 Converted', st(2), st(3)], ['3 Qualified', st(3), st(4) + 1], ['4 Scheduling', st(4), st(5)], ['5 LOI', st(5), st(6)], ['6 Payment Record', st(6), st(7)], ['7 For Approval', st(7), st(8) + 1], ['8 Approved', st(8), st(9)], ['9 Active', st(9), st(9) + 3600e3]];
  check('Stage transitions in order', [2, 3, 4, 5, 6, 7, 8, 9].every((id, i, a) => i === 0 || st(id) > st(a[i - 1])) && ms(v('franchise_inquiries', 1, 'created_at')) < st(2));
  const outside = plan.filter((c) => c.kind === 'time' && c.table !== 'applicant_status_histories' && c.table !== 'applicant_stage_histories' && !c.column.startsWith('read_at') && c.column !== 'last_viewed_at')
    .filter((c) => { const w = windows.find((x) => x[0] === c.stage); return w && !(ms(c.value as string) >= w[1] && ms(c.value as string) <= w[2]); })
    .filter((c) => !(c.table === 'activity_schedules' && c.column === 'created_at') || c.stage !== '4 Scheduling');
  check('Every record falls inside its stage window', !outside.length, outside.map((c) => `${c.label}.${c.column}`).join(', '));
  check('Files uploaded at their submission; Admin viewed after upload and before verify',
    ms(v('activity_document_views', '38:1', 'first_viewed_at')) > ms(o.done) && ms(v('activity_document_views', '38:1', 'first_viewed_at')) < ms(o.ok)
    && ms(v('activity_document_views', '41:1', 'first_viewed_at')) > ms(t.done) && ms(v('activity_document_views', '41:1', 'first_viewed_at')) < ms(t.ok));
  const times = plan.filter((c) => c.kind === 'time').map((c) => c.value as string);
  const manila = (s: string) => new Date(ms(s) + 8 * 3600e3);
  check('Business hours 09:00–18:00, weekdays', times.every((s) => { const d = manila(s); const h = d.getUTCHours() + d.getUTCMinutes() / 60; return h >= 9 && h <= 18 && d.getUTCDay() >= 1 && d.getUTCDay() <= 5; }));
  check('Nothing in the future', times.every((s) => ms(s) < Date.now()) && plan.filter((c) => c.kind === 'date').every((c) => String(c.value) <= new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)));
  return out;
}

// ---- CLI ----
const isMain = Boolean(process.argv[1]?.split('\\').join('/').endsWith('supabase/scripts/retime_ceejay_timeline.ts'));
if (isMain) {
  const apply = process.argv.includes('--apply');
  if (apply === process.argv.includes('--dry-run')) { console.error('Usage: exactly one of --dry-run or --apply [--approved-by="name"]'); process.exit(2); }
  const approvedBy = process.argv.find((x) => x.startsWith('--approved-by='))?.slice('--approved-by='.length);
  const { openScriptDb, readOnly } = await import('./lib/scriptDb.ts');
  const db = await openScriptDb();
  const show = (x: unknown) => (x === null || x === undefined ? '—' : typeof x === 'object' && !(x instanceof Date) ? JSON.stringify(x).slice(0, 60)
    : typeof x === 'number' || (!(x instanceof Date) && Number.isNaN(Date.parse(String(x)))) ? String(x)
    : /^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : new Date(new Date(x as string).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '));
  try {
    const run = async (tx: Db, doApply: boolean) => {
      const [a] = await tx.query(`select milestone_details from applicants where id = 6`);
      const [r] = await tx.query(`select data from applicant_requirements where id = 28 and applicant_id = 6`);
      const plan = ceejayPlan(a.milestone_details ?? {}, r.data ?? {});
      return retimeTimeline(tx, 6, plan, { apply: doApply, approvedBy, checks: (d) => ceejayChecks(d, plan) });
    };
    const result = apply ? await run(db, true) : await readOnly(db, (tx) => run(tx, false));
    console.log(apply ? '== APPLIED' : '== DRY RUN (nothing changed)');
    console.table(result.rows.map((x) => ({ stage: x.stage, record: x.record, field: x.field, old: show(x.old), new: show(x.new), change: x.change })));
    console.table(result.checks.map((c) => ({ rule: c.rule, result: c.ok ? 'pass' : 'FAIL', detail: c.detail })));
    console.log(`${result.pending.length} value(s) ${apply ? 'changed' : 'to change'}; ${result.rows.length - result.pending.length} already as planned.`);
  } finally {
    await db.close();
  }
}
