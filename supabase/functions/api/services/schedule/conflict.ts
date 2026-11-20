// App\Services\Scheduling\ScheduleConflictService: plain if-then rules that never change data.
// Overlap: new_start < end AND new_end > start. Only pending and confirmed sessions count.
//  HARD  H1 applicant twice
//        H2 handler availability: the same Sales user (handler) never has two overlapping sessions of ANY
//           activity and keeps a 1-hour gap between sessions on the same day
//        H4 facility limit: at most N sessions of an activity at the same time across all Sales users
//           (Admin settings; Orientation/Tasting 5, Training 2)
//        H5 capacity per session (Admin settings; Orientation/Tasting 5, Training 1)
//        H6 brand match (Training; Orientation/Tasting is any brand)
//        H7 the handler must be every applicant's assigned Sales user
//  JOIN  an overlapping session of the SAME Sales user and activity with a free seat is offered as a
//        join target (merge_targets); the overlap itself is still refused.
//  Different Sales users may run sessions at the same time, up to the facility limit.
import type { Db, Row } from '../../lib/db.ts';
import { fail, ValidationError } from '../../lib/http.ts';
import { activityLabel, isSchedulable, NOT_SCHEDULABLE } from '../pipeline.ts';
import {
  addMinutes, assertNoOtherActiveSchedule, assertNotPreviouslyCompleted, assertPrerequisiteDone, assertSlotFree, atLocal, capacityOf, DEFAULT_DURATION, formatRange,
  HANDLER_BUFFER_MINUTES, iso8601, isoDay, occupancyLabel, localDay, localMinutes, MINUTE, monthDay, parseLocal, resolveWindow, scheduleWindow, sessionCapacity, TRACKED_TYPES, weekdayMonthDay,
  windowLabel,
} from './rules.ts';
import { facilityLimit, loadScheduleLimits } from './settings.ts';

export const BRANDED_TYPES = ['training'];
export const LIVE_STATUSES = ['pending', 'confirmed'];
const SUGGESTION_LIMIT = 3;
const SUGGESTION_STEP = 30;
const SUGGESTION_DAYS = 14;

export const isAdmin = (actor: Row | null | undefined) => actor?.role?.name === 'admin';
export const isLive = (s: Row) => LIVE_STATUSES.includes(s.status);
const inactive = `('cancelled', 'removed')`;

export const SESSION_RELATIONS = (alias: string) => `
  (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = ${alias}.brand_id) as brand,
  (select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = ${alias}.handler_id) as handler,
  coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('applicant', (select jsonb_build_object('id', a.id, 'applicant_code', a.applicant_code, 'full_name', a.full_name, 'status', a.status, 'preferred_brand_id', a.preferred_brand_id, 'assigned_sales_user_id', a.assigned_sales_user_id,
      'preferred_brand', (select jsonb_build_object('id', b2.id, 'name', b2.name) from brands b2 where b2.id = a.preferred_brand_id)) from applicants a where a.id = p.applicant_id)) order by p.id)
    from schedule_session_participants p where p.session_id = ${alias}.id and p.attendance_status not in ${inactive}), '[]'::jsonb) as active_participants`;

export async function loadSession(db: Db, id: number): Promise<Row | null> {
  return (await db.query(`select s.*, ${SESSION_RELATIONS('s')} from schedule_sessions s where s.id = $1`, [id]))[0] ?? null;
}

export const liveSessions = (db: Db, from: Date, to: Date) => db.query(
  `select s.*, ${SESSION_RELATIONS('s')} from schedule_sessions s where s.status in ('pending', 'confirmed') and s.start_at < $1 and s.end_at > $2 order by s.start_at`,
  [to, from],
);

const startOf = (s: Row) => new Date(s.start_at);
const endOf = (s: Row) => new Date(s.end_at);
export const overlaps = (start: Date, end: Date, s: Row) => start < endOf(s) && end > startOf(s);
export const timeRange = (s: Row) => `${monthDay(startOf(s))} ${formatRange(startOf(s), endOf(s))}`;
export const describe = (s: Row) => `${activityLabel(s.activity_type)}${s.brand?.name ? ` (${s.brand.name})` : ''} at ${timeRange(s)}`;

/** True when two windows on the same day are closer than the handler gap (an overlap included). */
function tooClose(start: Date, end: Date, session: Row): boolean {
  if (localDay(startOf(session)) !== localDay(start)) return false;
  return start.getTime() < endOf(session).getTime() + HANDLER_BUFFER_MINUTES * MINUTE
    && end.getTime() > startOf(session).getTime() - HANDLER_BUFFER_MINUTES * MINUTE;
}

const roundUpToStep = (minutes: number) => Math.ceil(minutes / 30) * 30;

/**
 * The handler's earliest start on `day`, at or after `fromMinutes`, that keeps the 1-hour gap from
 * every one of the handler's sessions and still ends by closing time. null = nothing left that day.
 */
export function nextFreeStart(handlerSessions: Row[], day: string, fromMinutes: number, duration: number): number | null {
  let t = roundUpToStep(Math.max(fromMinutes, scheduleWindow.opens));
  for (let guard = 0; guard < 48; guard += 1) {
    if (t + duration > scheduleWindow.closes) return null;
    const start = atLocal(day, t);
    const blocker = handlerSessions.find((s) => tooClose(start, addMinutes(start, duration), s));
    if (!blocker) return t;
    t = roundUpToStep(Math.max(t + 30, localMinutes(endOf(blocker)) + HANDLER_BUFFER_MINUTES));
  }
  return null;
}

/**
 * H2 handler availability, one reason per clashing session:
 * "Ana Cruz already has Orientation/Tasting 9:00–11:00 AM on Nov 21. Next free start: 12:00 PM (1-hour gap)."
 */
export function handlerAvailabilityReasons(p: { handler_id: number | null; start_at: Date; end_at: Date; activity_type: string }, sessions: Row[], ignore: number[] = []): string[] {
  if (p.handler_id === null) return [];
  const mine = sessions.filter((s) => !ignore.includes(s.id) && isLive(s) && Number(s.handler_id ?? 0) === p.handler_id);
  const clashes = mine.filter((s) => tooClose(p.start_at, p.end_at, s));
  if (!clashes.length) return [];
  const day = localDay(p.start_at);
  const duration = Math.round((p.end_at.getTime() - p.start_at.getTime()) / MINUTE);
  const next = nextFreeStart(mine, day, localMinutes(p.start_at), duration);
  const tail = next !== null
    ? `Next free start: ${windowLabel(next)} (${HANDLER_BUFFER_MINUTES / 60}-hour gap).`
    : `No later start is free that day for a ${duration / 60}-hour ${activityLabel(p.activity_type)} (${HANDLER_BUFFER_MINUTES / 60}-hour gap between sessions).`;
  return clashes.map((s) => `${s.handler?.full_name ?? 'This Sales user'} already has ${activityLabel(s.activity_type)} ${formatRange(startOf(s), endOf(s))} on ${monthDay(startOf(s))}. ${tail}`);
}

/**
 * H4 facility limit: "All 2 Training facilities are in use 2:00–3:00 PM on Nov 21." Counts the live
 * sessions of the same activity at every moment of the proposal (different Sales users included).
 */
export function facilityReason(type: string, start: Date, end: Date, sessions: Row[], ignore: number[] = []): string | null {
  const limit = facilityLimit(type);
  if (!Number.isFinite(limit)) return null;
  const same = sessions.filter((s) => s.activity_type === type && isLive(s) && !ignore.includes(s.id) && overlaps(start, end, s));
  if (same.length < limit) return null;
  const moments = [start, ...same.map(startOf).filter((t) => t > start && t < end)].sort((a, b) => a.getTime() - b.getTime());
  for (const t of moments) {
    const active = same.filter((s) => startOf(s) <= t && endOf(s) > t);
    if (active.length < limit) continue;
    const until = new Date(Math.min(end.getTime(), ...active.map((s) => endOf(s).getTime())));
    const what = limit === 1 ? `The only ${activityLabel(type)} facility is` : `All ${limit} ${activityLabel(type)} facilities are`;
    return `${what} in use ${formatRange(t, until)} on ${monthDay(t)}.`;
  }
  return null;
}

/** The one assigned Sales user shared by every applicant (null when any is unassigned or they differ). */
export function commonSalesUser(type: string, applicants: Row[]): number | null {
  if (!TRACKED_TYPES.includes(type) || !applicants.length || applicants.some((a) => !a.assigned_sales_user_id)) return null;
  const owners = new Set(applicants.map((a) => Number(a.assigned_sales_user_id)));
  return owners.size === 1 ? [...owners][0] : null;
}

/** The default handler for these applicants (see commonSalesUser). */
export async function defaultHandlerId(db: Db, type: string, applicantIds: number[]): Promise<number | null> {
  if (!applicantIds.length) return null;
  const rows = await db.query(`select id, assigned_sales_user_id from applicants where id = any($1::bigint[])`, [`{${[...new Set(applicantIds.map(Number))].join(',')}}`]);
  return rows.length === new Set(applicantIds.map(Number)).size ? commonSalesUser(type, rows) : null;
}

/** H7: a session belongs to one Sales user, and only that user's applicants can be in it. */
export function handlerReasons(type: string, handlerId: number | null, applicants: Row[]): string[] {
  if (!TRACKED_TYPES.includes(type)) return [];
  const reasons: string[] = [];
  for (const a of applicants) {
    if (!a.assigned_sales_user_id) reasons.push(`${a.full_name} has no assigned Sales user. Assign one before scheduling.`);
    else if (handlerId !== null && Number(a.assigned_sales_user_id) !== handlerId) {
      reasons.push(`${a.full_name} is assigned to another Sales user. A session belongs to the applicant's assigned Sales user: reassign the applicant first (Reassign) to use this one.`);
    }
  }
  return reasons;
}

/** H6: a Training session has one brand and takes only applicants who selected that brand. */
export function brandReasons(type: string, brandId: number | null, applicants: Row[], brandName: string | null = null): string[] {
  if (!BRANDED_TYPES.includes(type)) return [];
  const reasons: string[] = [];
  if (brandId === null) reasons.push(`Brand is required for ${activityLabel(type)}.`);
  for (const a of applicants) {
    const who = applicants.length > 1 ? a.full_name : 'the applicant';
    if (a.preferred_brand_id === null || a.preferred_brand_id === undefined) {
      reasons.push(`${a.full_name} has no selected brand yet. Set the applicant's brand before scheduling ${activityLabel(type)}.`);
    } else if (brandId !== null && Number(a.preferred_brand_id) !== brandId) {
      reasons.push(`This ${activityLabel(type)} session is for ${brandName ?? 'another brand'}; ${who} selected ${a.preferred_brand?.name ?? 'another brand'}.`);
    }
  }
  return reasons;
}

/** H5: "This session is full (5/5)." for a join, or the per-session limit for a new session. */
export function capacityReason(type: string, existing: number, adding: number, capacity: number): string | null {
  if (capacity < 1) return 'Capacity must be at least 1.';
  if (existing + adding <= capacity) return null;
  if (existing >= capacity) return `This session is full (${existing}/${capacity}).`;
  if (existing > 0) return `This session has ${capacity - existing} seat(s) left (${existing}/${capacity}); ${adding} applicants were selected.`;
  return `${activityLabel(type)} takes ${capacity} applicant${capacity === 1 ? '' : 's'} per session (${existing + adding} selected).`;
}

function normalize(p: Row) {
  const type = String(p.activity_type);
  const start = parseLocal(p.start_at);
  const end = p.end_at ? parseLocal(p.end_at) : addMinutes(start, DEFAULT_DURATION[type] || 120);
  if (end <= start) fail('end_at', 'The end time must be after the start time.');
  return {
    activity_type: type,
    brand_id: type === 'orientation' || !p.brand_id ? null : Number(p.brand_id),
    start_at: start,
    end_at: end,
    handler_id: p.handler_id ? Number(p.handler_id) : null,
    venue: p.venue ?? null,
    applicant_ids: [...new Set<number>((p.applicant_ids ?? []).map(Number))],
    // The current capacity rule wins over a larger stored capacity (older sessions).
    max_capacity: Math.min(Number(p.max_capacity ?? sessionCapacity(type)), sessionCapacity(type) || Number(p.max_capacity ?? 0)),
    existing_count: Number(p.existing_count ?? 0),
    ignore_session_ids: (p.ignore_session_ids ?? []).map(Number) as number[],
    detach: p.detach ?? null,
    check_applicant_gates: Boolean(p.check_applicant_gates),
    check_window: p.check_window === undefined ? true : Boolean(p.check_window),
    // Joining an existing session uses no extra facility, so the facility limit is not re-checked.
    check_facility: p.check_facility === undefined ? true : Boolean(p.check_facility),
    brand_name: (p.brand_name ?? null) as string | null,
  };
}
type Proposal = ReturnType<typeof normalize>;

function windowReasons(p: Proposal): string[] {
  try {
    resolveWindow(p.start_at, null, p.end_at, p.activity_type);
    return [];
  } catch (error) {
    if (error instanceof ValidationError) return Object.values(error.errors).flat();
    throw error;
  }
}

async function gateReasons(db: Db, p: Proposal, applicants: Row[]): Promise<string[]> {
  const reasons: string[] = [];
  for (const a of applicants) {
    if (!isSchedulable(a)) { reasons.push(`${a.full_name}: ${NOT_SCHEDULABLE}`); continue; }
    for (const gate of [
      () => assertPrerequisiteDone(db, a.id, p.activity_type),
      () => assertSlotFree(db, a.id, p.activity_type),
      () => assertNotPreviouslyCompleted(db, a.id, p.activity_type),
      () => assertNoOtherActiveSchedule(db, a.id),
    ]) {
      try {
        await gate();
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        for (const message of Object.values(error.errors).flat()) reasons.push(`${a.full_name}: ${message}`);
      }
    }
  }
  return reasons;
}

/** An overlapping session these applicants could join instead: same Sales user and activity, a seat, the brand. */
function isJoinCandidate(p: Proposal, session: Row, participants: Row[], applicants: Row[]): boolean {
  if (session.activity_type !== p.activity_type || !p.applicant_ids.length) return false;
  if (p.handler_id !== null && Number(session.handler_id ?? 0) !== p.handler_id) return false;
  if (applicants.some((a) => Number(a.assigned_sales_user_id ?? 0) !== Number(session.handler_id ?? -1))) return false;
  if (BRANDED_TYPES.includes(session.activity_type) && applicants.some((a) => Number(a.preferred_brand_id ?? 0) !== Number(session.brand_id ?? -1))) return false;
  return capacityOf(session) - participants.length >= p.applicant_ids.length;
}

function checkAgainst(p: Proposal, applicants: Row[], sessions: Row[]) {
  const hard: string[] = [];
  const warnings: string[] = [];
  const targets: Row[] = [];
  for (const session of sessions) {
    if (p.ignore_session_ids.includes(session.id) || !overlaps(p.start_at, p.end_at, session)) continue;
    let participants: Row[] = session.active_participants;
    if (p.detach && p.detach.session_id === session.id) participants = participants.filter((r) => r.applicant_id !== p.detach.applicant_id);
    const clashes = participants.filter((r) => p.applicant_ids.includes(r.applicant_id));
    for (const clash of clashes) hard.push(`${clash.applicant?.full_name ?? 'Applicant'} already has ${describe(session)}.`);
    if (!clashes.length && isJoinCandidate(p, session, participants, applicants)) {
      targets.push({
        session_id: session.id, activity_type: session.activity_type, start_at: iso8601(session.start_at), end_at: iso8601(session.end_at), time: timeRange(session),
        brand: session.brand?.name ?? null, handler: session.handler?.full_name ?? null, venue: session.venue, status: session.status,
        occupancy: occupancyLabel(participants.length, capacityOf(session)),
        why: `Same Sales user, ${capacityOf(session) - participants.length} seat(s) left`,
      });
    }
  }
  // H2: any session of this Sales user (any activity) that overlaps or is less than 1 hour away.
  hard.push(...handlerAvailabilityReasons(p, sessions, p.ignore_session_ids));
  // H4: the facility limit for this activity at the same time.
  if (p.check_facility) {
    const facility = facilityReason(p.activity_type, p.start_at, p.end_at, sessions, p.ignore_session_ids);
    if (facility) hard.push(facility);
  }
  // A separate session is never allowed while the same Sales user is busy: join instead.
  return { hard, merge_targets: targets, separate_blockers: [] as string[], warnings };
}

async function suggestTimes(db: Db, p: Proposal, applicants: Row[]) {
  const duration = Math.round((p.end_at.getTime() - p.start_at.getTime()) / MINUTE);
  const now = new Date();
  const firstDay = localDay(p.start_at > now ? p.start_at : now);
  const first = atLocal(firstDay, 0);
  const sessions = await liveSessions(db, addMinutes(first, -1440), addMinutes(first, (SUGGESTION_DAYS + 1) * 1440));
  const found: Row[] = [];
  for (let d = 0; d < SUGGESTION_DAYS && found.length < SUGGESTION_LIMIT; d++) {
    const dayStart = addMinutes(first, d * 1440);
    if (!scheduleWindow.workingDays.includes(isoDay(dayStart))) continue;
    const day = localDay(dayStart);
    for (let m = scheduleWindow.opens; m + duration <= scheduleWindow.closes; m += SUGGESTION_STEP) {
      const start = atLocal(day, m);
      const end = addMinutes(start, duration);
      if (start <= now || start.getTime() === p.start_at.getTime()) continue;
      const candidate = { ...p, start_at: start, end_at: end };
      if (windowReasons(candidate).length) continue;
      const check = checkAgainst(candidate, applicants, sessions);
      if (!check.hard.length && !check.merge_targets.length && !check.warnings.length) {
        found.push({ start_at: iso8601(start), end_at: iso8601(end), label: `${weekdayMonthDay(start)} · ${formatRange(start, end)}` });
        if (found.length >= SUGGESTION_LIMIT) break;
      }
    }
  }
  return found;
}

export const applicantsWithBrand = async (db: Db, ids: number[]): Promise<Row[]> => (ids.length ? db.query(
  `select a.*, (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = a.preferred_brand_id) as preferred_brand from applicants a where a.id = any($1::bigint[])`,
  [`{${ids.join(',')}}`],
) : []);

/** Every live session of the proposal's day (the handler gap, the next free start and the facility count need the whole day). */
export const daySessions = (db: Db, start: Date) => {
  const dayStart = atLocal(localDay(start), 0);
  return liveSessions(db, dayStart, addMinutes(dayStart, 1440));
};

export async function evaluate(db: Db, proposal: Row, actor: Row | null, withSuggestions = true) {
  // The Admin limits are read first: the capacity below and the facility rule use them.
  await loadScheduleLimits(db);
  const p = normalize(proposal);
  const applicants = await applicantsWithBrand(db, p.applicant_ids);
  // No handler given: the applicants' assigned Sales user is the handler, so the capacity, the
  // 1-hour buffer and the handler rules always apply (and the write saves this handler).
  if (p.handler_id === null) p.handler_id = commonSalesUser(p.activity_type, applicants);
  if (p.brand_id !== null && p.brand_name === null) p.brand_name = (await db.query(`select name from brands where id = $1`, [p.brand_id]))[0]?.name ?? null;
  const fixed: string[] = [];
  if (p.check_window) fixed.push(...windowReasons(p));
  fixed.push(...brandReasons(p.activity_type, p.brand_id, applicants, p.brand_name));
  fixed.push(...handlerReasons(p.activity_type, p.handler_id, applicants));
  const full = capacityReason(p.activity_type, p.existing_count, p.applicant_ids.length, p.max_capacity);
  if (full) fixed.push(full);
  if (p.check_applicant_gates) fixed.push(...(await gateReasons(db, p, applicants)));

  const sessions = await daySessions(db, p.start_at);
  const timed = checkAgainst(p, applicants, sessions);
  const hard = [...fixed, ...timed.hard];
  const status = hard.length ? 'blocked' : timed.merge_targets.length ? 'mergeable' : timed.warnings.length ? 'warning' : 'ok';
  // Other times are offered only when the time is the problem.
  const suggestions = withSuggestions && status !== 'ok' && !fixed.length ? await suggestTimes(db, p, applicants) : [];
  return {
    status,
    reasons: [...new Set(hard)],
    warnings: [...new Set(timed.warnings)],
    merge_targets: timed.merge_targets,
    separate_allowed: !hard.length && !timed.separate_blockers.length,
    separate_blockers: [...new Set(timed.separate_blockers)],
    suggested_times: suggestions,
    can_merge: isAdmin(actor),
    can_override: isAdmin(actor),
    proposal: { activity_type: p.activity_type, brand_id: p.brand_id, start_at: iso8601(p.start_at), end_at: iso8601(p.end_at), handler_id: p.handler_id, venue: p.venue },
  };
}

/** Every reason the source may NOT merge into the target (empty = mergeable). */
export async function mergeReasons(db: Db, source: Row, target: Row, context?: Row[]): Promise<string[]> {
  if (!isLive(target) || !isLive(source)) return ['Only Pending or Confirmed sessions can be merged.'];
  if (source.activity_type !== target.activity_type) return [`Different activities (${activityLabel(source.activity_type)} and ${activityLabel(target.activity_type)}) cannot be merged.`];
  if (target.activity_type === 'training') return ['Training sessions are never merged.'];
  // Only a future session can merge (business time): a source that is today or past cannot merge.
  if (localDay(startOf(source)) <= localDay(new Date())) return ['A session that is today or already past cannot be merged.'];
  const reasons: string[] = [];
  const moving: Row[] = source.active_participants.map((r: Row) => r.applicant).filter(Boolean);
  if (Number(source.handler_id ?? 0) !== Number(target.handler_id ?? -1)) reasons.push('Different Sales users: a session belongs to one Sales user. Reassign the applicants first.');
  reasons.push(...handlerReasons(target.activity_type, target.handler_id === null || target.handler_id === undefined ? null : Number(target.handler_id), moving));
  const taken = target.active_participants.length;
  const capacity = capacityOf(target);
  if (moving.length > capacity - taken) reasons.push(`Merging would put ${taken + moving.length} applicants in a session of ${capacity} (now ${taken}/${capacity}).`);
  const movingIds = moving.map((a) => a.id);
  for (const r of target.active_participants.filter((x: Row) => movingIds.includes(x.applicant_id))) {
    reasons.push(`${moving.find((a) => a.id === r.applicant_id)?.full_name ?? 'Applicant'} is already in this session.`);
  }
  const around = context ?? await liveSessions(db, startOf(target), endOf(target));
  for (const other of around) {
    if ([source.id, target.id].includes(other.id) || !overlaps(startOf(target), endOf(target), other)) continue;
    for (const clash of other.active_participants.filter((x: Row) => movingIds.includes(x.applicant_id))) {
      reasons.push(`${clash.applicant?.full_name ?? 'Applicant'} already has ${describe(other)}.`);
    }
  }
  return [...new Set(reasons)];
}

export async function evaluateDrag(db: Db, source: Row, from: Date, to: Date, actor: Row) {
  const sessions = await liveSessions(db, from, to);
  const out: Row[] = [];
  // Past or same-day targets are not offered at all; only future sessions can be shown (and locked when not allowed).
  const today = localDay(new Date());
  for (const target of sessions.filter((s) => s.id !== source.id && localDay(startOf(s)) > today)) {
    const reasons = await mergeReasons(db, source, target, sessions);
    out.push({ session_id: target.id, status: reasons.length ? 'blocked' : isAdmin(actor) ? 'mergeable' : 'neutral', reasons });
  }
  return out;
}
