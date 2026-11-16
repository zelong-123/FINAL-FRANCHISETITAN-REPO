// Overdue alerts and the branch's receipt reminder (Objective 3, SLA rules). There is no scheduler:
// the API runs this when the supply lists are read, at most once every few minutes (one atomic
// upsert on supply_job_runs decides who runs it), and Admin can run it on demand.
//
// - Overdue (working days, see overdueReason): the role that owns the next step is notified once
//   per overdue state (supply_requests.overdue_notified_key); a new overdue state notifies again.
// - Receipt reminder: the POD exists and the branch has not confirmed after 1 day: the branch is
//   reminded once (receipt_reminded_at). Branch receipt is never "overdue".
import type { Db, Row } from '../lib/db.ts';
import { notifyRoles, notifyUser } from './notifications.ts';
import * as S from './supplyStatus.ts';
import { overdueReason } from './supplyWorkflow.ts';
import { manilaDate } from './workingDays.ts';

export const ALERT_INTERVAL_MINUTES = 10;
const ROLE_OF: Record<string, string> = { admin: 'admin', logistics: 'logistics' };

/** True when this caller may run now (and records the run); false when it ran recently. */
async function claim(db: Db, force: boolean): Promise<boolean> {
  const rows = await db.query(
    `insert into supply_job_runs (name, last_run_at) values ('supply_alerts', now())
     on conflict (name) do update set last_run_at = now()
     where $1::boolean or supply_job_runs.last_run_at < now() - make_interval(mins => $2::int)
     returning name`,
    [force, ALERT_INTERVAL_MINUTES],
  );
  return rows.length > 0;
}

export async function runSupplyAlerts(db: Db, { force = false, now = new Date() } = {}): Promise<Row> {
  if (!(await claim(db, force))) return { ran: false, overdue: 0, reminders: 0 };
  const today = manilaDate(now);
  const open = await db.query(
    `select sr.id, sr.request_number, sr.status, sr.status_changed_at, sr.updated_at, sr.created_at, sr.expected_restock_date, sr.branch_received_at,
       sr.overdue_notified_key, sr.requested_by_user_id, sr.receipt_reminded_at,
       (select r.created_at from supply_request_date_revisions r where r.supply_request_id = sr.id and r.status = 'pending' and r.proposed_by_role = 'logistics' order by r.id desc limit 1) as pending_date_at,
       (select s.created_at from supply_shortage_reports s where s.supply_request_id = sr.id and s.status = 'pending' order by s.id desc limit 1) as pending_shortage_at,
       d.eta_at, d.pod_encoded_at
     from supply_requests sr left join deliveries d on d.supply_request_id = sr.id
     where sr.status in (${S.sqlList(S.SUBMITTED_OPEN)})`,
  );
  let overdue = 0;
  let reminders = 0;
  for (const sr of open) {
    const reason = overdueReason(sr, { pendingDateAt: sr.pending_date_at, pendingShortageAt: sr.pending_shortage_at, etaAt: sr.eta_at, pod: Boolean(sr.pod_encoded_at) }, today);
    const key = reason ? `${sr.status}:${reason}` : null;
    if (key !== (sr.overdue_notified_key ?? null)) {
      if (reason) {
        const owners = S.ownersOf(sr.status, { pod: Boolean(sr.pod_encoded_at), received: Boolean(sr.branch_received_at), pendingDate: Boolean(sr.pending_date_at), pendingShortage: Boolean(sr.pending_shortage_at) })
          .map((o) => ROLE_OF[o]).filter(Boolean);
        await notifyRoles(db, owners.length ? owners : ['admin'], 'supply_request_overdue', 'Supply request overdue', `${sr.request_number}: ${reason}`, { supply_request_id: sr.id });
        overdue += 1;
      }
      await db.query(`update supply_requests set overdue_notified_key = $2, overdue_notified_at = $3 where id = $1`, [sr.id, key, reason ? now : null]);
    }
    // The POD is in, the branch has not confirmed after a day: remind it once.
    if (sr.pod_encoded_at && !sr.branch_received_at && !sr.receipt_reminded_at && now.getTime() - new Date(sr.pod_encoded_at).getTime() >= 86_400_000) {
      await notifyUser(db, sr.requested_by_user_id, 'supply_request_receipt_reminder', 'Please confirm the delivery you received.', `${sr.request_number} was delivered. Please confirm the delivery you received (good, damaged and short per item).`, { supply_request_id: sr.id });
      await db.query(`update supply_requests set receipt_reminded_at = $2 where id = $1`, [sr.id, now]);
      reminders += 1;
    }
  }
  return { ran: true, overdue, reminders };
}

/** The lazy trigger used by the list endpoints: never lets an alert problem break the page. */
export async function maybeRunSupplyAlerts(db: Db): Promise<void> {
  try {
    await runSupplyAlerts(db);
  } catch (error) {
    console.error('supply alerts failed', error instanceof Error ? error.message : error);
  }
}
