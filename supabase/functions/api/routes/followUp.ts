// Applicant follow-up actions (rules in services/followUp.ts):
//   Admin: send a reminder to the assigned Sales user (max 1 per applicant per 24h), put on hold / release,
//          close (archive with a reason), the follow-up thresholds, the per-Sales counts.
//   Sales: their "Needs attention" list (the Log follow-up itself is POST /applicants/:id/follow-ups).
// Registered before the applicant routes so /applicants/needs-attention is not read as an applicant id.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, ok, routeId } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { audit } from '../services/users.ts';
import { notifyUser } from '../services/notifications.ts';
import { APPLICANT_MODEL } from '../services/applicantModel.ts';
import { logEvent } from '../services/applicantStage.ts';
import { requireReason } from '../services/accountability.ts';
import { stageLabel } from '../services/pipeline.ts';
import {
  FOLLOW_UP_COLUMNS, followUpJoin, followUpSettings, followUpView, loadFollowUp, NO_FOLLOW_UP_STAGES, REMINDER_COOLDOWN_HOURS, reminderDraft,
} from '../services/followUp.ts';

export const followUpRoutes = new Hono<AppEnv>();

const admin = role('admin');
const staff = role('admin', 'sales');
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const when = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const manilaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());

const loadOpen = async (c: Context<AppEnv>): Promise<Row> => {
  const a = requireFound((await c.get('deps').db.query(`select * from applicants where id = $1`, [routeId(c, 'applicant')]))[0]);
  if (a.archived_at) fail('applicant', 'This applicant is archived.');
  if (NO_FOLLOW_UP_STAGES.includes(a.status)) fail('applicant', `${stageLabel(a.status)} applicants are not followed up.`);
  return a;
};

/** What changed, for the event snapshot and the audit. */
const snapshotOf = (view: Row, a: Row) => ({
  state: view.state, days: view.days, stage: a.status, stage_label: view.stage_label, last_update: view.last_update, assigned_sales_user_id: a.assigned_sales_user_id ?? null,
});

const fresh = async (db: Db, id: number) => {
  const row = await loadFollowUp(db, id);
  return { id: row.id, follow_up: followUpView(row) };
};

// ---- lists ----

/** Sales: their Overdue / Stalled applicants, the most days first ("Needs attention"). Admin may pass sales_user_id. */
followUpRoutes.get('/applicants/needs-attention', staff, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const salesId = roleName(c) === 'sales' ? user.id : (c.req.query('sales_user_id') ? Number(c.req.query('sales_user_id')) : null);
  const rows = await db.query(
    `select a.id, a.full_name, a.applicant_code, a.status, a.assigned_sales_user_id, a.on_hold_until, a.on_hold_reason, a.on_hold_at, ${FOLLOW_UP_COLUMNS}
     from applicants a ${followUpJoin('a')}
     where a.archived_at is null and fu.state in ('overdue', 'stalled') and ($1::bigint is null or a.assigned_sales_user_id = $1::bigint)
     order by fu.idle_days desc, a.id limit 50`,
    [salesId],
  );
  return ok(c, rows.map((r) => ({ id: r.id, full_name: r.full_name, applicant_code: r.applicant_code, status: r.status, status_label: stageLabel(r.status), follow_up: followUpView(r) })));
});

/** Executive dashboard: Overdue / Stalled / On hold per Sales user (plus unassigned). */
followUpRoutes.get('/applicants/follow-up-by-sales', admin, async (c) => {
  const { db } = c.get('deps');
  const counts = await db.query(
    `select a.assigned_sales_user_id as sales_id, fu.state, count(*)::int as n
     from applicants a ${followUpJoin('a')}
     where a.archived_at is null and fu.state is not null group by 1, 2`,
  );
  const sales = await db.query(
    `select u.id, u.full_name from users u join roles r on r.id = u.role_id
     where r.name = 'sales' and u.account_status = 'active' and u.archived_at is null order by u.full_name`,
  );
  const rows = sales.map((u) => ({ sales_user_id: u.id, full_name: u.full_name, overdue: 0, stalled: 0, on_hold: 0 }));
  const byId = new Map(rows.map((r) => [String(r.sales_user_id), r]));
  let unassigned: Row | null = null;
  for (const c2 of counts) {
    let target = c2.sales_id ? byId.get(String(c2.sales_id)) : null;
    if (!target) {
      if (c2.sales_id) {
        const [u] = await db.query(`select id, full_name from users where id = $1`, [c2.sales_id]);
        target = { sales_user_id: c2.sales_id, full_name: u?.full_name ?? 'Former Sales user', overdue: 0, stalled: 0, on_hold: 0 };
        byId.set(String(c2.sales_id), target);
        rows.push(target);
      } else {
        unassigned ??= { sales_user_id: null, full_name: 'Unassigned', overdue: 0, stalled: 0, on_hold: 0 };
        target = unassigned;
      }
    }
    target[c2.state] = Number(c2.n);
  }
  if (unassigned) rows.push(unassigned);
  rows.sort((x, y) => (y.stalled - x.stalled) || (y.overdue - x.overdue) || String(x.full_name).localeCompare(String(y.full_name)));
  return ok(c, { rows, totals: rows.reduce((t, r) => ({ overdue: t.overdue + r.overdue, stalled: t.stalled + r.stalled }), { overdue: 0, stalled: 0 }) });
});

// ---- settings ----

followUpRoutes.get('/applicants/follow-up-settings', admin, async (c) => ok(c, await followUpSettings(c.get('deps').db)));

followUpRoutes.put('/applicants/follow-up-settings', admin, async (c) => {
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    overdue_days: ['required', 'integer', 'min:1', 'max:60'],
    stalled_days: ['required', 'integer', 'min:2', 'max:120'],
  });
  if (Number(v.stalled_days) <= Number(v.overdue_days)) fail('stalled_days', 'Stalled must be more days than Overdue.');
  const before = await followUpSettings(db);
  const [existing] = await db.query(`select id from follow_up_settings order by id desc limit 1`);
  if (existing) {
    await db.query(`update follow_up_settings set overdue_days = $2, stalled_days = $3, updated_by_user_id = $4, updated_at = now() where id = $1`,
      [existing.id, v.overdue_days, v.stalled_days, c.get('user').id]);
  } else {
    await db.query(`insert into follow_up_settings (overdue_days, stalled_days, updated_by_user_id) values ($1, $2, $3)`, [v.overdue_days, v.stalled_days, c.get('user').id]);
  }
  await audit(c, db, 'settings.follow_up_updated', null,
    { overdue_days: before.overdue_days, stalled_days: before.stalled_days }, { overdue_days: Number(v.overdue_days), stalled_days: Number(v.stalled_days) });
  return ok(c, await followUpSettings(db), 'Follow-up rules saved.');
});

// ---- reminders ----

/** The Send reminder modal: the summary and the prefilled message. */
followUpRoutes.get('/applicants/:applicant/reminder-draft', admin, async (c) => {
  const { db } = c.get('deps');
  const a = await loadOpen(c);
  const view = followUpView(await loadFollowUp(db, a.id));
  const [sales] = a.assigned_sales_user_id ? await db.query(`select id, full_name from users where id = $1`, [a.assigned_sales_user_id]) : [];
  return ok(c, {
    applicant: { id: a.id, full_name: a.full_name, applicant_code: a.applicant_code, status: a.status, status_label: view.stage_label },
    assigned_sales: sales ?? null, follow_up: view, message: reminderDraft(a, view),
  });
});

followUpRoutes.post('/applicants/:applicant/reminders', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const a = await loadOpen(c);
  const v = await validate(db, await readInput(c), { message: ['required', 'string', 'max:2000'] });
  const message = String(v.message).trim();
  if (message.length < 5) fail('message', 'Write a message of at least 5 characters.');
  if (!a.assigned_sales_user_id) fail('applicant', 'Assign a Sales user first: there is nobody to remind.');
  const sent = await db.tx(async (tx) => {
    // One reminder per applicant per 24h, also when two Admins click at the same moment.
    await tx.query(`select id from applicants where id = $1 for update`, [a.id]);
    const view = followUpView(await loadFollowUp(tx, a.id));
    if (!['overdue', 'stalled'].includes(view.state)) fail('applicant', 'Only an Overdue or Stalled applicant can be reminded.');
    const [last] = await tx.query(
      `select created_at from applicant_follow_up_events where applicant_id = $1 and kind = 'reminder' order by created_at desc, id desc limit 1`, [a.id],
    );
    if (last) {
      const next = new Date(new Date(last.created_at).getTime() + REMINDER_COOLDOWN_HOURS * 3600e3);
      if (next.getTime() > Date.now()) fail('applicant', `A reminder was already sent in the last 24 hours. Next reminder available at ${when.format(next)}.`);
    }
    const [event] = await tx.query(
      `insert into applicant_follow_up_events (applicant_id, kind, user_id, to_user_id, message, snapshot) values ($1, 'reminder', $2, $3, $4, $5) returning *`,
      [a.id, user.id, a.assigned_sales_user_id, message, JSON.stringify(snapshotOf(view, a))],
    );
    await logEvent(tx, a, 'follow_up_reminder_sent', user.id, { event_id: event.id }, message, {
      step: 'follow_up', new_values: { to_user_id: a.assigned_sales_user_id, state: view.state, days: view.days },
    });
    await audit(c, tx, 'applicant.reminder_sent', { type: APPLICANT_MODEL, id: a.id }, null,
      { to_user_id: a.assigned_sales_user_id, state: view.state, days: view.days, message });
    return event;
  });
  const [sales] = await db.query(`select full_name from users where id = $1`, [a.assigned_sales_user_id]);
  await notifyUser(db, Number(a.assigned_sales_user_id), 'applicant_reminder', `Reminder from Admin: ${a.full_name}`, message, { applicant_id: a.id, event_id: sent.id }, user);
  return ok(c, await fresh(db, a.id), `Reminder sent to ${sales?.full_name ?? 'the assigned Sales user'}.`, 201);
});

// ---- hold ----

followUpRoutes.post('/applicants/:applicant/hold', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const a = await loadOpen(c);
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'], until: ['nullable', 'string'] });
  const reason = requireReason(v.reason, 'reason', 'a reason for the hold');
  const until = String(v.until ?? '').trim();
  if (!until) fail('until', 'Choose until when the applicant is on hold.');
  if (!DAY.test(until) || Number.isNaN(Date.parse(until))) fail('until', 'Use a valid date (YYYY-MM-DD).');
  if (until <= manilaToday()) fail('until', 'The hold must end after today.');
  const untilAt = new Date(`${until}T23:59:59+08:00`);
  await db.tx(async (tx) => {
    const view = followUpView(await loadFollowUp(tx, a.id));
    await tx.query(
      `update applicants set on_hold_until = $2, on_hold_reason = $3, on_hold_at = now(), on_hold_by_user_id = $4, hold_ended_at = null where id = $1`,
      [a.id, untilAt, reason, user.id],
    );
    await tx.query(
      `insert into applicant_follow_up_events (applicant_id, kind, user_id, to_user_id, reason, until_at, snapshot) values ($1, 'hold', $2, $3, $4, $5, $6)`,
      [a.id, user.id, a.assigned_sales_user_id ?? null, reason, untilAt, JSON.stringify(snapshotOf(view, a))],
    );
    await logEvent(tx, a, 'put_on_hold', user.id, {}, reason, { step: 'follow_up', old_values: { on_hold_until: iso(a.on_hold_until) }, new_values: { on_hold_until: untilAt.toISOString() } });
    await audit(c, tx, 'applicant.put_on_hold', { type: APPLICANT_MODEL, id: a.id }, { on_hold_until: iso(a.on_hold_until) }, { on_hold_until: untilAt.toISOString(), reason });
  });
  if (a.assigned_sales_user_id) {
    await notifyUser(db, Number(a.assigned_sales_user_id), 'applicant_on_hold', `On hold: ${a.full_name}`,
      `${a.full_name} is on hold until ${when.format(untilAt)}. Reason: ${reason}`, { applicant_id: a.id }, user);
  }
  return ok(c, await fresh(db, a.id), `On hold until ${when.format(untilAt)}.`);
});

followUpRoutes.post('/applicants/:applicant/hold/release', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const a = await loadOpen(c);
  if (!a.on_hold_until || new Date(a.on_hold_until).getTime() <= Date.now()) fail('applicant', 'This applicant is not on hold.');
  await db.tx(async (tx) => {
    await tx.query(`update applicants set on_hold_until = null, hold_ended_at = now() where id = $1`, [a.id]);
    await tx.query(`insert into applicant_follow_up_events (applicant_id, kind, user_id, to_user_id, until_at) values ($1, 'hold_released', $2, $3, $4)`,
      [a.id, user.id, a.assigned_sales_user_id ?? null, a.on_hold_until]);
    await logEvent(tx, a, 'hold_released', user.id, {}, null, { step: 'follow_up', old_values: { on_hold_until: iso(a.on_hold_until) }, new_values: { on_hold_until: null } });
    await audit(c, tx, 'applicant.hold_released', { type: APPLICANT_MODEL, id: a.id }, { on_hold_until: iso(a.on_hold_until) }, { on_hold_until: null });
  });
  return ok(c, await fresh(db, a.id), 'Hold released: the follow-up timer runs again.');
});

// ---- close ----

/** Close a stalled applicant: the existing archive (same rules), plus the reason. */
followUpRoutes.post('/applicants/:applicant/close', admin, async (c) => {
  const { db } = c.get('deps');
  const user = c.get('user');
  const a = requireFound((await db.query(`select * from applicants where id = $1`, [routeId(c, 'applicant')]))[0]);
  const v = await validate(db, await readInput(c), { reason: ['nullable', 'string', 'max:2000'] });
  const reason = requireReason(v.reason, 'reason', 'a reason for closing');
  const hasFranchisee = (await db.query(`select 1 from franchisees where applicant_id = $1 limit 1`, [a.id])).length > 0;
  if (a.status === 'active_franchisee' || hasFranchisee) fail('applicant', 'An active franchisee cannot be archived.');
  if (a.archived_at) abort(422, 'Applicant is already archived.');
  await db.tx(async (tx) => {
    const view = followUpView(await loadFollowUp(tx, a.id));
    await tx.query(`update applicants set archived_at = now(), archived_by_user_id = $2, archive_reason = $3 where id = $1`, [a.id, user.id, reason]);
    await tx.query(`insert into applicant_follow_up_events (applicant_id, kind, user_id, to_user_id, reason, snapshot) values ($1, 'closed', $2, $3, $4, $5)`,
      [a.id, user.id, a.assigned_sales_user_id ?? null, reason, JSON.stringify(snapshotOf(view, a))]);
    await logEvent(tx, a, 'closed', user.id, {}, reason, { step: 'follow_up', old_values: { archived_at: null }, new_values: { archived: true, reason } });
    await audit(c, tx, 'applicant.archived', { type: APPLICANT_MODEL, id: a.id }, { archived_at: null }, { archived: true, archive_reason: reason, via: 'follow_up_close' });
  });
  return ok(c, { id: a.id, archived: true }, 'Applicant closed and archived.');
});
