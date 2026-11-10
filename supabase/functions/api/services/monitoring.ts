// Monitoring: follow-up log, days in the current stage (Overdue), due follow-up reminders and the
// server-side date filters. The thresholds are set here, in one place.
import type { Db, Row } from '../lib/db.ts';
import { fail, Filter } from '../lib/http.ts';
import { notifyUser } from './notifications.ts';

/** Days an applicant may stay in a stage (or an inquiry in a status) before it shows Overdue. */
export const OVERDUE_DAYS = {
  default: 7,
  applicant: { converted: 7, qualified: 7, scheduled: 7, loi_submitted: 7, payment_submitted: 7, for_approval: 7, approved: 7 } as Record<string, number>,
  inquiry: { new: 7, contacted: 7, endorsed: 7 } as Record<string, number>,
};
/** Closed stages are never Overdue. */
const CLOSED_APPLICANT = ['active_franchisee', 'rejected'];
const CLOSED_INQUIRY = ['converted', 'rejected', 'closed'];

export const FOLLOW_UP_CHANNELS: Record<string, string> = { call: 'Call', text: 'Text', viber: 'Viber', email: 'Email', in_person: 'In person', other: 'Other' };
export const FOLLOW_UP_OUTCOMES: Record<string, string> = { reached: 'Reached', no_answer: 'No answer', rescheduled: 'Rescheduled', not_interested: 'Not interested' };

const days = (since: string) => `greatest(0, floor(extract(epoch from (now() - ${since})) / 86400))::int`;

/** When the applicant entered its current stage: the stage history, then the older status history. */
export const STAGE_ENTERED_SQL = (alias: string) => `coalesce(
  (select max(h.changed_at) from applicant_stage_histories h where h.applicant_id = ${alias}.id and h.to_stage = ${alias}.status and h.from_stage is distinct from h.to_stage),
  (select max(sh.created_at) from applicant_status_histories sh where sh.applicant_id = ${alias}.id and sh.to_status = ${alias}.status),
  ${alias}.application_date::timestamptz, ${alias}.created_at)`;
export const STAGE_DAYS_SQL = (alias: string) => days(STAGE_ENTERED_SQL(alias));
export const INQUIRY_DAYS_SQL = (alias: string) => days(`coalesce(${alias}.status_changed_at, ${alias}.created_at)`);

export function applicantMonitor(row: Row): Row {
  const limit = OVERDUE_DAYS.applicant[row.status] ?? OVERDUE_DAYS.default;
  const inStage = Number(row.days_in_stage ?? 0);
  return { days_in_stage: inStage, overdue_after_days: limit, overdue: !CLOSED_APPLICANT.includes(row.status) && !row.archived_at && inStage > limit };
}
export function inquiryMonitor(row: Row): Row {
  const limit = OVERDUE_DAYS.inquiry[row.status] ?? OVERDUE_DAYS.default;
  const inStatus = Number(row.days_in_status ?? 0);
  return { days_in_status: inStatus, overdue_after_days: limit, overdue: !CLOSED_INQUIRY.includes(row.status) && !row.archived_at && inStatus > limit };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** From / To on a date basis, compared as Manila calendar days; refused when invalid or reversed. */
export function applyDateRange(f: Filter, q: Row, columns: Record<string, string>, fallback: string) {
  const basis = q.date_basis || fallback;
  const column = columns[basis];
  if (!column) fail('date_basis', `Choose a date basis: ${Object.keys(columns).join(', ')}.`);
  const from = q.from ? String(q.from) : '';
  const to = q.to ? String(q.to) : '';
  for (const [key, value] of [['from', from], ['to', to]]) if (value && (!DAY.test(value) || Number.isNaN(Date.parse(value)))) fail(key, 'Use a valid date (YYYY-MM-DD).');
  if (from && to && from > to) fail('to', 'The To date cannot be before the From date.');
  const day = `(${column} at time zone 'Asia/Manila')::date`;
  const plainDate = column.endsWith('application_date') || column.endsWith('inquiry_date');
  const expr = plainDate ? column : day;
  if (from) f.add(`${expr} >= ?::date`, from);
  if (to) f.add(`${expr} <= ?::date`, to);
}

/** One follow-up entry, checked. Returns the saved row. */
export async function createFollowUp(db: Db, type: 'inquiry' | 'applicant', id: number, actor: Row, input: Row): Promise<Row> {
  const contacted = input.contacted_at ? new Date(String(input.contacted_at)) : new Date();
  if (Number.isNaN(contacted.getTime())) fail('contacted_at', 'Enter a valid date and time.');
  if (contacted.getTime() > Date.now() + 60_000) fail('contacted_at', 'The follow-up date and time cannot be in the future.');
  const channel = String(input.channel ?? '');
  if (!FOLLOW_UP_CHANNELS[channel]) fail('channel', 'Choose how the person was contacted.');
  const outcome = String(input.outcome ?? '');
  if (!FOLLOW_UP_OUTCOMES[outcome]) fail('outcome', 'Choose the outcome: reached, no answer, rescheduled or not interested.');
  const notes = String(input.notes ?? '').trim();
  if (notes.length < 5) fail('notes', 'Write notes of at least 5 characters.');
  let next: Date | null = null;
  if (input.next_follow_up_at) {
    next = new Date(String(input.next_follow_up_at));
    if (Number.isNaN(next.getTime())) fail('next_follow_up_at', 'Enter a valid next follow-up date.');
    if (next.getTime() <= contacted.getTime()) fail('next_follow_up_at', 'The next follow-up must be after this follow-up.');
  }
  if (outcome === 'rescheduled' && !next) fail('next_follow_up_at', 'A rescheduled follow-up needs the next follow-up date.');
  const [row] = await db.query(
    `insert into follow_ups (followable_type, followable_id, user_id, actor_role, contacted_at, channel, outcome, notes, next_follow_up_at)
     values ($1, $2, $3, (select r.name from users u join roles r on r.id = u.role_id where u.id = $3), $4, $5, $6, $7, $8) returning *`,
    [type, id, actor.id, contacted, channel, outcome, notes.slice(0, 5000), next],
  );
  return row;
}

export const followUpsOf = (db: Db, type: string, id: number) => db.query(
  `select f.*, (select full_name from users where id = f.user_id) as by_name from follow_ups f where f.followable_type = $1 and f.followable_id = $2 order by f.contacted_at desc, f.id desc`,
  [type, id],
);

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Due follow-ups become reminders when the responsible user's notifications or lists load (no
 * scheduled job). Only the latest follow-up of a record counts, and each is reminded once.
 */
export async function deliverDueReminders(db: Db, user: Row): Promise<number> {
  const role = user.role?.name;
  if (!['marketing', 'sales'].includes(role)) return 0;
  const due = await db.query(
    `select f.*, coalesce(i.lead_name, a.full_name) as person, coalesce(i.lead_code, a.applicant_code) as code
     from follow_ups f
     left join franchise_inquiries i on f.followable_type = 'inquiry' and i.id = f.followable_id
     left join applicants a on f.followable_type = 'applicant' and a.id = f.followable_id
     where f.next_follow_up_at <= now()
       and not exists (select 1 from follow_up_reminders r where r.follow_up_id = f.id)
       and not exists (select 1 from follow_ups n where n.followable_type = f.followable_type and n.followable_id = f.followable_id and n.id > f.id)
       and ((f.followable_type = 'inquiry' and f.user_id = $1 and i.archived_at is null and i.status not in ('converted', 'rejected', 'closed'))
         or (f.followable_type = 'applicant' and a.assigned_sales_user_id = $1 and a.archived_at is null and a.status not in ('active_franchisee', 'rejected')))
     order by f.next_follow_up_at limit 50`,
    [user.id],
  );
  let sent = 0;
  for (const f of due) {
    const [claimed] = await db.query(`insert into follow_up_reminders (follow_up_id, user_id) values ($1, $2) on conflict do nothing returning follow_up_id`, [f.id, user.id]);
    if (!claimed) continue;
    sent += 1;
    await notifyUser(db, user.id, 'follow_up_due', 'Follow-up due', `Follow up with ${f.person}${f.code ? ` (${f.code})` : ''}: it was due ${fmt.format(new Date(f.next_follow_up_at))}.`,
      f.followable_type === 'inquiry' ? { inquiry_id: f.followable_id } : { applicant_id: f.followable_id });
  }
  return sent;
}
