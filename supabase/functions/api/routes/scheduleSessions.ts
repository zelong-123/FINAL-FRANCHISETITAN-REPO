// ScheduleSessionController + the session API resources.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/env.ts';
import type { Db, Row } from '../lib/db.ts';
import { abort, boolParam, ok, routeId } from '../lib/http.ts';
import { readInput, validate } from '../lib/validate.ts';
import { requireFound, role, roleName } from '../lib/middleware.ts';
import { PERMISSIONS } from '../config/roles.ts';
import { activityLabel } from '../services/pipeline.ts';
import { evaluate, evaluateDrag, isAdmin, loadSession, SESSION_RELATIONS } from '../services/schedule/conflict.ts';
import { iso8601, parseLocal, scheduleWindow, TRACKED_TYPES, VENUE_OPTIONS } from '../services/schedule/rules.ts';
import * as service from '../services/schedule/sessions.ts';

export const sessionRoutes = new Hono<AppEnv>();
const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled', 'rescheduled', 'merged'];
const VENUES = `in:${VENUE_OPTIONS.join(',')}`;
const can = (c: Context<AppEnv>, permission: string) => {
  if (!(PERMISSIONS[permission] ?? []).includes(roleName(c))) abort(403, 'Your role is not allowed to perform this action.');
};
const gate = role('admin', 'sales');

function participantJson(p: Row): Row {
  const a = p.applicant;
  return {
    id: p.id, session_id: p.session_id, applicant_id: p.applicant_id,
    ...(a !== undefined ? { applicant: a ? { id: a.id, applicant_code: a.applicant_code, full_name: a.full_name, status: a.status, preferred_brand_id: a.preferred_brand_id, preferred_brand: a.preferred_brand ?? null } : null } : {}),
    attendance_status: p.attendance_status, activity_done: p.attendance_status === 'attended', sales_completed_by: p.sales_completed_by,
    ...('sales_completed_by_name' in p ? { sales_completed_by_name: p.sales_completed_by_name } : {}),
    sales_completed_at: iso8601(p.sales_completed_at), admin_attended_by: p.admin_attended_by, admin_attended_by_name: p.admin_attended_by_name,
    admin_attended_at: iso8601(p.admin_attended_at), activity_schedule_id: p.activity_schedule_id,
  };
}

function present(s: Row, extra: Row = {}): Row {
  const active = s.active_participants ?? [];
  return {
    id: s.id, activity_type: s.activity_type, activity_label: activityLabel(s.activity_type), brand_id: s.brand_id, brand: s.brand ?? null,
    start_at: iso8601(s.start_at), end_at: iso8601(s.end_at), handler_id: s.handler_id, handler: s.handler ?? null, venue: s.venue, meeting_link: s.meeting_link, status: s.status,
    merged_into_session_id: s.merged_into_session_id, merge_suggested: Boolean(s.merge_suggested), max_capacity: s.max_capacity, remarks: s.remarks,
    participant_count: active.length, occupancy: `${active.length}/${s.max_capacity} applicants`, active_participants: active.map(participantJson),
    created_by: s.created_by, created_at: iso8601(s.created_at), updated_at: iso8601(s.updated_at), ...extra,
  };
}

const sessionRules = () => ({
  activity_type: ['required', `in:${TRACKED_TYPES.join(',')}`],
  brand_id: ['nullable', 'integer', 'exists:brands,id'],
  start_at: ['required', 'date'],
  end_at: ['nullable', 'date', 'after:start_at'],
  handler_id: ['nullable', 'integer', 'exists:users,id'],
  venue: ['nullable', VENUES],
  max_capacity: ['nullable', 'integer', 'min:1', 'max:500'],
});
const decisionRules = () => ({
  create_separate: ['nullable', 'boolean'],
  override_remarks: ['nullable', 'string', 'max:2000'],
  from_suggestion: ['nullable', 'boolean'],
  declined_merge_session_ids: ['nullable', 'array'],
});
async function assertApplicantsExist(db: Db, ids: unknown[]) {
  const unique = [...new Set(ids.map(Number))];
  if (!unique.every(Number.isSafeInteger)) abort(422, 'The selected applicant is invalid.');
  const found = unique.length ? await db.query(`select id from applicants where id = any($1::bigint[])`, [`{${unique.join(',')}}`]) : [];
  if (found.length !== unique.length) abort(422, 'The selected applicant is invalid.');
}

const load = async (c: Context<AppEnv>, name = 'session'): Promise<Row> => requireFound(await loadSession(c.get('deps').db, routeId(c, name)));

sessionRoutes.get('/schedule-sessions', gate, async (c) => {
  can(c, 'schedule_sessions.view');
  const { db } = c.get('deps');
  const url = new URL(c.req.url);
  const input = { ...c.req.query(), status: url.searchParams.getAll('status[]').length ? url.searchParams.getAll('status[]') : url.searchParams.getAll('status').length ? url.searchParams.getAll('status') : undefined };
  const v = await validate(db, input, {
    from: ['required', 'date'], to: ['required', 'date', 'after:from'], activity_type: ['nullable', `in:${TRACKED_TYPES.join(',')}`],
    brand_id: ['nullable', 'integer'], handler_id: ['nullable', 'integer'], status: ['nullable', 'array'], merge_suggested: ['nullable', 'boolean'],
  });
  const params: unknown[] = [parseLocal(v.to), parseLocal(v.from)];
  const where = ['s.start_at < $1', 's.end_at > $2'];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (v.activity_type) add('s.activity_type = ?', v.activity_type);
  if (v.brand_id) add('s.brand_id = ?', v.brand_id);
  if (v.handler_id) add('s.handler_id = ?', v.handler_id);
  if (v.status?.length) add('s.status = any(?::text[])', `{${v.status.filter((x: string) => STATUSES.includes(x)).join(',')}}`);
  if ('merge_suggested' in c.req.query()) add('s.merge_suggested = ?', boolParam(c.req.query('merge_suggested')));
  const rows = await db.query(`select s.*, ${SESSION_RELATIONS('s')} from schedule_sessions s where ${where.join(' and ')} order by s.start_at limit 1000`, params);
  return ok(c, rows.map((s) => present(s)));
});

sessionRoutes.get('/schedule-sessions/config', gate, (c) => {
  can(c, 'activities.schedule');
  return ok(c, scheduleWindow.toArray());
});

sessionRoutes.get('/schedule-sessions/handlers', gate, async (c) => {
  can(c, 'schedule_sessions.view');
  return ok(c, await c.get('deps').db.query(
    `select u.id, u.full_name, r.name as role from users u join roles r on r.id = u.role_id where u.account_status = 'active' and r.name in ('admin', 'sales') order by u.full_name`,
  ));
});

sessionRoutes.post('/schedule-sessions/evaluate', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    ...sessionRules(), applicant_ids: ['nullable', 'array'], session_id: ['nullable', 'integer', 'exists:schedule_sessions,id'], set_again_session_id: ['nullable', 'integer', 'exists:schedule_sessions,id'],
  });
  await assertApplicantsExist(db, v.applicant_ids ?? []);
  if (v.set_again_session_id) {
    const applicantId = Number((v.applicant_ids ?? [])[0] ?? 0);
    return ok(c, await evaluate(db, { ...v, applicant_ids: [applicantId], detach: { session_id: v.set_again_session_id, applicant_id: applicantId } }, c.get('user')));
  }
  const existing = v.session_id ? await loadSession(db, v.session_id) : null;
  const ids = existing ? [...new Set([...existing.active_participants.map((p: Row) => p.applicant_id), ...(v.applicant_ids ?? [])])] : (v.applicant_ids ?? []);
  return ok(c, await evaluate(db, { ...v, applicant_ids: ids, ignore_session_ids: existing ? [existing.id] : [], check_applicant_gates: existing === null }, c.get('user')));
});

sessionRoutes.post('/schedule-sessions', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    ...sessionRules(), applicant_ids: ['required', 'array', 'min:1'], remarks: ['nullable', 'string', 'max:2000'], meeting_link: ['nullable', 'string', 'max:500'],
    join_session_id: ['nullable', 'integer', 'exists:schedule_sessions,id'], ...decisionRules(),
  });
  await assertApplicantsExist(db, v.applicant_ids);
  v.applicant_ids = v.applicant_ids.map(Number);
  const result = await service.createSession(db, v, c.get('user'));
  return ok(c, { session: present(result.session), joined_existing: result.joined }, result.joined ? 'Added to the existing session.' : 'Session scheduled.', 201);
});

sessionRoutes.get('/schedule-sessions/:session', gate, async (c) => {
  can(c, 'schedule_sessions.view');
  const { db } = c.get('deps');
  const session = await load(c);
  const participants = await db.query(
    `select p.*, (select jsonb_build_object('id', a.id, 'applicant_code', a.applicant_code, 'full_name', a.full_name, 'status', a.status, 'preferred_brand_id', a.preferred_brand_id) from applicants a where a.id = p.applicant_id) as applicant,
       (select u.full_name from users u where u.id = p.sales_completed_by) as sales_completed_by_name
     from schedule_session_participants p where p.session_id = $1 order by p.id`, [session.id],
  );
  const history = await db.query(`select h.*, (select u.full_name from users u where u.id = h.performed_by) as performed_by_name from schedule_session_history h where h.session_id = $1 order by h.id`, [session.id]);
  return ok(c, present(session, {
    participants: participants.map(participantJson),
    history: history.map((h) => ({ id: h.id, action: h.action, from_value: h.from_value, to_value: h.to_value, performed_by: h.performed_by, performed_by_name: h.performed_by_name, performed_by_role: h.performed_by_role, remarks: h.remarks, created_at: iso8601(h.created_at) })),
  }));
});

sessionRoutes.put('/schedule-sessions/:session', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const session = await load(c);
  const v = await validate(db, await readInput(c), {
    brand_id: ['sometimes', 'nullable', 'integer', 'exists:brands,id'], start_at: ['sometimes', 'date'], end_at: ['sometimes', 'nullable', 'date'],
    handler_id: ['sometimes', 'nullable', 'integer', 'exists:users,id'], venue: ['sometimes', 'nullable', VENUES], meeting_link: ['sometimes', 'nullable', 'string', 'max:500'],
    max_capacity: ['sometimes', 'integer', 'min:1', 'max:500'], remarks: ['sometimes', 'nullable', 'string', 'max:2000'], ...decisionRules(),
  });
  return ok(c, present(await service.updateSession(db, session, v, c.get('user'))), 'Session updated.');
});

sessionRoutes.post('/schedule-sessions/:session/evaluate-drag', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const session = await load(c);
  const v = await validate(db, await readInput(c), { from: ['required', 'date'], to: ['required', 'date', 'after:from'] });
  return ok(c, { source_session_id: session.id, can_merge: isAdmin(c.get('user')), targets: await evaluateDrag(db, session, parseLocal(v.from), parseLocal(v.to), c.get('user')) });
});

sessionRoutes.post('/schedule-sessions/:session/move', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const session = await load(c);
  const v = await validate(db, await readInput(c), { start_at: ['required', 'date'], end_at: ['nullable', 'date', 'after:start_at'], ...decisionRules() });
  return ok(c, present(await service.moveSession(db, session, v, c.get('user'))), 'Session rescheduled.');
});

sessionRoutes.post('/schedule-sessions/:session/confirm', gate, async (c) => {
  can(c, 'schedule_sessions.confirm');
  return ok(c, present(await service.confirmSession(c.get('deps').db, await load(c), c.get('user'))), 'Session confirmed.');
});

sessionRoutes.post('/schedule-sessions/:session/cancel', gate, async (c) => {
  can(c, 'schedule_sessions.cancel');
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string', 'max:2000'] });
  return ok(c, present(await service.cancelSession(db, await load(c), c.get('user'), v.remarks ?? null)), 'Session cancelled.');
});

sessionRoutes.post('/schedule-sessions/:session/merge', gate, async (c) => {
  can(c, 'schedule_sessions.merge');
  const { db } = c.get('deps');
  const source = await load(c);
  const v = await validate(db, await readInput(c), { target_session_id: ['required', 'integer', 'exists:schedule_sessions,id'] });
  return ok(c, present(await service.mergeSessions(db, source.id, v.target_session_id, c.get('user'))), 'Sessions merged.');
});

sessionRoutes.post('/schedule-sessions/:session/participants', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { applicant_id: ['required', 'integer', 'exists:applicants,id'] });
  return ok(c, present(await service.addParticipant(db, await load(c), v.applicant_id, c.get('user'))), 'Participant added.');
});

sessionRoutes.delete('/schedule-sessions/:session/participants/:applicant', gate, async (c) => {
  can(c, 'schedule_sessions.remove_participant');
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), { remarks: ['nullable', 'string', 'max:2000'] });
  const result = await service.removeParticipant(db, await load(c), routeId(c, 'applicant'), c.get('user'), v.remarks ?? null);
  return ok(c, { session: present(result.session), empty_session: result.empty_session }, 'Participant removed.');
});

sessionRoutes.post('/schedule-sessions/:session/participants/:applicant/set-again', gate, async (c) => {
  can(c, 'schedule_sessions.schedule');
  const { db } = c.get('deps');
  const v = await validate(db, await readInput(c), {
    start_at: ['required', 'date'], end_at: ['nullable', 'date', 'after:start_at'], handler_id: ['sometimes', 'nullable', 'integer', 'exists:users,id'], venue: ['sometimes', 'nullable', VENUES],
    remarks: ['nullable', 'string', 'max:2000'], ...decisionRules(),
  });
  const result = await service.setAgain(db, await load(c), routeId(c, 'applicant'), v, c.get('user'));
  return ok(c, { session: present(result.session), previous_session: present(result.previous_session), empty_session: result.empty_session }, 'Applicant rescheduled.');
});
