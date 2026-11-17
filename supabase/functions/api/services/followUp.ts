// Applicant follow-up: Overdue / Stalled / Waiting on Admin / On hold, computed in one SQL join so the
// list, its filter and sort, the applicant detail and the dashboards all agree.
//
// The timer starts at the latest of: entering the current stage, the last Sales action on the applicant
// (any action record by a Sales user, or an activity a Sales user scheduled/requested), and it is paused
// for the latest hold. Then, in order:
//   closed (archived, Approved, Active Franchisee, Rejected) -> no state
//   on hold (until a future date)                            -> 'on_hold'
//   anything waiting for Admin                               -> 'waiting_admin' (counts against Admin)
//   an upcoming scheduled activity                           -> on track
//   the latest follow-up's next action date not reached      -> on track
//   >= stalled_days without an update                        -> 'stalled'
//   >= overdue_days, or that next action date passed         -> 'overdue'
// There is no scheduler: the automatic alerts run (throttled) when the bell or the applicant list loads.
import type { Db, Row } from '../lib/db.ts';
import { notifyRoles, notifyUser } from './notifications.ts';
import { OVERDUE_FOLLOW_UP_REASONS, STAGE_ENTERED_SQL } from './monitoring.ts';
import { activityLabel, stageLabel } from './pipeline.ts';
import { requirementDef } from './requirements.ts';

export const DEFAULT_THRESHOLDS = { overdue_days: 7, stalled_days: 14 };
export const REMINDER_COOLDOWN_HOURS = 24;
export const ALERT_INTERVAL_MINUTES = 5;
/** Stages that are never followed up (Approved waits for the franchisee to accept the invite). */
export const NO_FOLLOW_UP_STAGES = ['approved', 'active_franchisee', 'rejected'];
export const FOLLOW_UP_STATES = ['overdue', 'stalled', 'waiting_admin', 'on_hold'] as const;
export const FOLLOW_UP_REASONS = OVERDUE_FOLLOW_UP_REASONS;

const SETTINGS = `(select s from follow_up_settings s order by s.id desc limit 1)`;
const NAME_OF = (expr: string) => `(select full_name from users where id = ${expr})`;

/** `left join lateral (...) fu on true` for an applicants alias: fu.state, fu.idle_days, fu.clock_at, ... */
export function followUpJoin(a: string): string {
  return `left join lateral (
  select z.*,
    case
      when z.closed then null
      when z.hold_active then 'on_hold'
      when z.waiting is not null then 'waiting_admin'
      when z.upcoming_at is not null then null
      when z.next_action_at is not null and z.next_action_at > now() then null
      when z.idle_days >= z.stalled_days then 'stalled'
      when z.idle_days >= z.overdue_days or z.next_action_at is not null then 'overdue'
    end as state
  from (
    select y.*, greatest(0, floor(extract(epoch from (now() - y.clock_at)) / 86400))::int as idle_days,
      case when y.latest_follow_up_at is not null and y.latest_follow_up_at >= y.base_clock_at - interval '1 second' then y.latest_next_at end as next_action_at
    from (
      select x.*,
        x.base_clock_at + case
          when x.hold_end_at is not null and x.hold_start_at is not null and x.hold_end_at > x.base_clock_at
            then x.hold_end_at - greatest(x.hold_start_at, x.base_clock_at) else interval '0' end as clock_at
      from (
        select w.*, greatest(w.entered_at, coalesce(w.sales_at, w.entered_at)) as base_clock_at
        from (
          select
            (${a}.archived_at is not null or ${a}.status in (${NO_FOLLOW_UP_STAGES.map((s) => `'${s}'`).join(', ')})) as closed,
            (${a}.on_hold_until is not null and ${a}.on_hold_until > now()) as hold_active,
            ${a}.on_hold_at as hold_start_at,
            coalesce(${a}.hold_ended_at, case when ${a}.on_hold_until <= now() then ${a}.on_hold_until end) as hold_end_at,
            ${STAGE_ENTERED_SQL(a)} as entered_at,
            greatest(
              (select max(h.changed_at) from applicant_stage_histories h where h.applicant_id = ${a}.id and h.actor_role = 'sales'),
              (select max(s.created_at) from activity_schedules s join users su on su.id = s.scheduled_by_user_id join roles sr on sr.id = su.role_id
                where s.applicant_id = ${a}.id and sr.name = 'sales')
            ) as sales_at,
            coalesce(
              (select jsonb_build_object('kind', 'requirement', 'key', r.requirement_key, 'at', r.submitted_at) from applicant_requirements r
                where r.applicant_id = ${a}.id and r.status = 'submitted' order by r.submitted_at nulls last, r.id limit 1),
              (select jsonb_build_object('kind', 'activity_approval', 'key', s.activity_type, 'at', s.updated_at) from activity_schedules s
                where s.applicant_id = ${a}.id and s.approval_status = 'pending_admin' and s.status in ('pending', 'confirmed') order by s.updated_at, s.id limit 1),
              (select jsonb_build_object('kind', 'activity_review', 'key', s.activity_type, 'at', coalesce(s.completion_submitted_at, s.updated_at)) from activity_schedules s
                where s.applicant_id = ${a}.id and s.review_status = 'submitted' order by s.id limit 1),
              (select jsonb_build_object('kind', 'payment', 'key', p.payment_type, 'at', coalesce(p.requested_at, p.created_at)) from payments p
                where p.applicant_id = ${a}.id and p.status = 'pending' order by p.id limit 1),
              (select jsonb_build_object('kind', 'brand_confirmation', 'key', null, 'at', c.submitted_at) from applicant_brand_confirmations c
                where c.applicant_id = ${a}.id and c.status = 'submitted' order by c.id desc limit 1),
              case when ${a}.status = 'for_approval' then jsonb_build_object('kind', 'for_approval', 'key', null, 'at', ${STAGE_ENTERED_SQL(a)}) end
            ) as waiting,
            (select min(s.starts_at) from activity_schedules s where s.applicant_id = ${a}.id and s.starts_at > now()
              and s.status in ('pending', 'confirmed') and s.approval_status <> 'rejected') as upcoming_at,
            (select f.created_at from follow_ups f where f.followable_type = 'applicant' and f.followable_id = ${a}.id order by f.created_at desc, f.id desc limit 1) as latest_follow_up_at,
            (select f.next_follow_up_at from follow_ups f where f.followable_type = 'applicant' and f.followable_id = ${a}.id order by f.created_at desc, f.id desc limit 1) as latest_next_at,
            (select to_jsonb(e) from (
              select h.changed_at as at, ${NAME_OF('h.changed_by_user_id')} as by_name, coalesce(h.event, 'stage_change') as what
                from applicant_stage_histories h where h.applicant_id = ${a}.id
                  and (h.actor_role = 'sales' or (h.to_stage = ${a}.status and h.from_stage is distinct from h.to_stage))
              union all
              select s.created_at, ${NAME_OF('s.scheduled_by_user_id')}, 'activity_requested' from activity_schedules s
                join users su on su.id = s.scheduled_by_user_id join roles sr on sr.id = su.role_id where s.applicant_id = ${a}.id and sr.name = 'sales'
              order by 1 desc limit 1) e) as last_update,
            (select jsonb_build_object('id', ev.id, 'at', ev.created_at, 'by', ${NAME_OF('ev.user_id')}, 'to', ${NAME_OF('ev.to_user_id')}, 'message', ev.message)
              from applicant_follow_up_events ev where ev.applicant_id = ${a}.id and ev.kind = 'reminder' order by ev.created_at desc, ev.id desc limit 1) as last_reminder,
            (select jsonb_build_object('id', f.id, 'kind', f.kind, 'reason', f.reason, 'notes', f.notes, 'next_action_at', f.next_follow_up_at,
                'at', f.created_at, 'by', ${NAME_OF('f.user_id')}, 'outcome', f.outcome, 'channel', f.channel)
              from follow_ups f where f.followable_type = 'applicant' and f.followable_id = ${a}.id order by f.created_at desc, f.id desc limit 1) as last_follow_up,
            coalesce((${SETTINGS}).overdue_days, ${DEFAULT_THRESHOLDS.overdue_days})::int as overdue_days,
            coalesce((${SETTINGS}).stalled_days, ${DEFAULT_THRESHOLDS.stalled_days})::int as stalled_days
        ) w
      ) x
    ) y
  ) z
) fu on true`;
}

/** The columns a list adds next to applicants.* (prefixed fu_ so nothing collides). */
export const FOLLOW_UP_COLUMNS = `fu.state as fu_state, fu.idle_days as fu_idle_days, fu.clock_at as fu_clock_at, fu.entered_at as fu_entered_at,
  fu.waiting as fu_waiting, fu.upcoming_at as fu_upcoming_at, fu.next_action_at as fu_next_action_at, fu.last_update as fu_last_update,
  fu.last_reminder as fu_last_reminder, fu.last_follow_up as fu_last_follow_up, fu.overdue_days as fu_overdue_days, fu.stalled_days as fu_stalled_days`;

const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
const dayTime = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function waitingText(w: Row): string {
  const at = w.at ? ` ${day.format(new Date(w.at))}` : '';
  switch (w.kind) {
    case 'requirement': return `${requirementDef(w.key)?.label ?? String(w.key).replace(/_/g, ' ')} submitted${at}, waiting for Admin review`;
    case 'activity_approval': return `${activityLabel(String(w.key))} schedule requested${at}, waiting for Admin approval`;
    case 'activity_review': return `${activityLabel(String(w.key))} marked complete${at}, waiting for Admin to confirm attendance`;
    case 'payment': return `Payment entry submitted${at}, waiting for Admin verification`;
    case 'brand_confirmation': return `Brand Confirmation submitted${at}, waiting for Admin`;
    case 'for_approval': return 'For approval: waiting for Admin to approve';
    default: return 'Waiting for Admin';
  }
}

/** The API shape of an applicant's follow-up state, from a row carrying the fu_* columns. */
export function followUpView(row: Row): Row {
  const state = row.fu_state ?? null;
  const idle = Number(row.fu_idle_days ?? 0);
  const stage = stageLabel(row.status);
  const last = row.fu_last_update ?? null;
  const lastText = last?.at ? `last update ${day.format(new Date(last.at))}${last.by_name ? ` by ${last.by_name}` : ''}` : 'no update yet';
  const lastReminder = row.fu_last_reminder ?? null;
  const nextReminderAt = lastReminder?.at ? new Date(new Date(lastReminder.at).getTime() + REMINDER_COOLDOWN_HOURS * 3600e3) : null;
  let tooltip: string | null = null;
  let days: number | null = null;
  if (state === 'overdue' || state === 'stalled') {
    days = idle;
    const passed = row.fu_next_action_at && new Date(row.fu_next_action_at).getTime() <= Date.now()
      ? ` · next action date ${day.format(new Date(row.fu_next_action_at))} passed` : '';
    tooltip = `${plural(idle, 'day')} in ${stage}, ${lastText}${passed}`;
  } else if (state === 'waiting_admin') {
    days = row.fu_waiting?.at ? Math.max(0, Math.floor((Date.now() - new Date(row.fu_waiting.at).getTime()) / 86400e3)) : null;
    tooltip = `Waiting on Admin: ${waitingText(row.fu_waiting ?? {})}`;
  } else if (state === 'on_hold') {
    tooltip = `On hold until ${dayTime.format(new Date(row.on_hold_until))}${row.on_hold_reason ? `: ${row.on_hold_reason}` : ''}`;
  }
  return {
    state,
    days,
    idle_days: idle,
    tooltip,
    stage_label: stage,
    overdue_days: Number(row.fu_overdue_days ?? DEFAULT_THRESHOLDS.overdue_days),
    stalled_days: Number(row.fu_stalled_days ?? DEFAULT_THRESHOLDS.stalled_days),
    last_update: last?.at ? { at: iso(last.at), by: last.by_name ?? null, what: last.what ?? null } : null,
    waiting: row.fu_waiting ? { kind: row.fu_waiting.kind, text: waitingText(row.fu_waiting), at: iso(row.fu_waiting.at) } : null,
    upcoming_activity_at: iso(row.fu_upcoming_at),
    next_action_at: iso(row.fu_next_action_at),
    last_reminder: lastReminder ? { at: iso(lastReminder.at), by: lastReminder.by ?? null, to: lastReminder.to ?? null, message: lastReminder.message ?? null } : null,
    next_reminder_at: nextReminderAt && nextReminderAt.getTime() > Date.now() ? nextReminderAt.toISOString() : null,
    last_follow_up: row.fu_last_follow_up ? {
      ...row.fu_last_follow_up,
      reason_label: row.fu_last_follow_up.reason ? FOLLOW_UP_REASONS[row.fu_last_follow_up.reason] ?? row.fu_last_follow_up.reason : null,
      at: iso(row.fu_last_follow_up.at), next_action_at: iso(row.fu_last_follow_up.next_action_at),
    } : null,
    hold: row.on_hold_until && new Date(row.on_hold_until).getTime() > Date.now()
      ? { until: iso(row.on_hold_until), reason: row.on_hold_reason ?? null, at: iso(row.on_hold_at) } : null,
  };
}

/** One applicant with its follow-up columns. */
export async function loadFollowUp(db: Db, applicantId: number): Promise<Row> {
  const [row] = await db.query(`select a.*, ${FOLLOW_UP_COLUMNS} from applicants a ${followUpJoin('a')} where a.id = $1`, [applicantId]);
  return row;
}

export async function followUpSettings(db: Db): Promise<Row> {
  const [row] = await db.query(`select overdue_days, stalled_days, updated_at, ${NAME_OF('updated_by_user_id')} as updated_by from follow_up_settings order by id desc limit 1`);
  return {
    overdue_days: Number(row?.overdue_days ?? DEFAULT_THRESHOLDS.overdue_days),
    stalled_days: Number(row?.stalled_days ?? DEFAULT_THRESHOLDS.stalled_days),
    updated_at: iso(row?.updated_at), updated_by: row?.updated_by ?? null,
  };
}

/** The prefilled reminder text (Admin may edit it before sending). */
export function reminderDraft(a: Row, view: Row): string {
  const last = view.last_update?.at ? `${dayTime.format(new Date(view.last_update.at))}${view.last_update.by ? ` by ${view.last_update.by}` : ''}` : 'none recorded';
  return `Hi, please follow up with ${a.full_name}${a.applicant_code ? ` (${a.applicant_code})` : ''}. `
    + `They have been ${view.days ?? view.idle_days} day(s) in ${view.stage_label} without an update (last update: ${last}). `
    + 'Please contact them and log a follow-up with the next action date.';
}

// ---- automatic alerts ----
async function claim(db: Db, force: boolean): Promise<boolean> {
  const rows = await db.query(
    `insert into supply_job_runs (name, last_run_at) values ('follow_up_alerts', now())
     on conflict (name) do update set last_run_at = now()
     where $1::boolean or supply_job_runs.last_run_at < now() - make_interval(mins => $2::int)
     returning name`,
    [force, ALERT_INTERVAL_MINUTES],
  );
  return rows.length > 0;
}

/**
 * Entering Overdue notifies the assigned Sales user; entering Stalled notifies every Admin. Each once per
 * episode: the key is the state plus the start of the timer, so a Sales update (new timer) starts a new
 * episode. Jumping straight to Stalled notifies both.
 */
export async function runFollowUpAlerts(db: Db, { force = false } = {}): Promise<Row> {
  if (!(await claim(db, force))) return { ran: false, overdue: 0, stalled: 0 };
  const rows = await db.query(
    `select a.id, a.full_name, a.applicant_code, a.status, a.assigned_sales_user_id, a.on_hold_until, a.on_hold_reason,
       (select k.alert_key from applicant_follow_up_alerts k where k.applicant_id = a.id) as follow_up_alert_key, ${FOLLOW_UP_COLUMNS}
     from applicants a ${followUpJoin('a')}
     where a.archived_at is null and fu.state in ('overdue', 'stalled')`,
  );
  let overdue = 0;
  let stalled = 0;
  for (const row of rows) {
    const clock = new Date(row.fu_clock_at).toISOString();
    const previous = String(row.follow_up_alert_key ?? '');
    const split = previous.indexOf(':');
    const sameEpisode = split > 0 && previous.slice(split + 1) === clock;
    const previousState = sameEpisode ? previous.slice(0, split) : null;
    // Within one episode: Sales once (at Overdue, or at Stalled when it jumps there), Admins once (at Stalled),
    // also when the thresholds change and the state moves back and forth.
    const salesDone = sameEpisode;
    const adminsDone = previousState === 'stalled';
    const notifyAdmins = row.fu_state === 'stalled' && !adminsDone;
    if (salesDone && !notifyAdmins) continue;
    const key = `${adminsDone || row.fu_state === 'stalled' ? 'stalled' : 'overdue'}:${clock}`;
    const view = followUpView(row);
    const who = `${row.full_name}${row.applicant_code ? ` (${row.applicant_code})` : ''}`;
    if (!salesDone && row.assigned_sales_user_id) {
      await notifyUser(db, Number(row.assigned_sales_user_id), 'applicant_overdue', `Applicant overdue: ${row.full_name}`,
        `${who} needs a follow-up: ${view.tooltip}. Log a follow-up with the next action date.`, { applicant_id: row.id });
      overdue += 1;
    }
    if (notifyAdmins) {
      const [sales] = row.assigned_sales_user_id ? await db.query(`select full_name from users where id = $1`, [row.assigned_sales_user_id]) : [];
      await notifyRoles(db, ['admin'], 'applicant_stalled', `Applicant stalled: ${row.full_name}`,
        `${who} is stalled: ${view.tooltip}.${sales ? ` Assigned Sales: ${sales.full_name}.` : ' No Sales user assigned.'} Remind, reassign, put on hold or close it.`,
        { applicant_id: row.id });
      stalled += 1;
    }
    await db.query(
      `insert into applicant_follow_up_alerts (applicant_id, alert_key) values ($1, $2)
       on conflict (applicant_id) do update set alert_key = excluded.alert_key, notified_at = now()`,
      [row.id, key],
    );
  }
  return { ran: true, overdue, stalled };
}

/** The bell and the lists never fail because of the alerts. */
export async function runFollowUpAlertsQuietly(db: Db): Promise<void> {
  try {
    await runFollowUpAlerts(db);
  } catch (error) {
    console.error('follow-up alerts failed', error instanceof Error ? error.message : error);
  }
}
