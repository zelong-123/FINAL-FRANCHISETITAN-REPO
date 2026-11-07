// App\Services\Scheduling\ScheduleConflictService: plain if-then rules that never change data.
// Overlap: new_start < end AND new_end > start. Only pending and confirmed sessions count.
//  HARD  H1 applicant twice, H2 handler twice, H3 tastings of different brands, H4 trainings, H5 capacity, H6 brand match
//  MERGE M1 orientation with seats, M2 tasting of the same brand with seats (Admin only, never automatic)
//  WARN  W1 same handler closer than the near-conflict gap
import type { Db, Row } from '../../lib/db.ts';
import { fail, ValidationError } from '../../lib/http.ts';
import { activityLabel, isSchedulable, NOT_SCHEDULABLE } from '../pipeline.ts';
import {
  addMinutes, assertNoOtherActiveSchedule, assertNotPreviouslyCompleted, assertPrerequisiteDone, assertSlotFree, atLocal, DEFAULT_DURATION, formatRange,
  iso8601, isoDay, localDay, MINUTE, monthDay, NEAR_GAP_MINUTES, parseLocal, resolveWindow, scheduleWindow, sessionCapacity, weekdayMonthDay,
} from './rules.ts';

export const BRANDED_TYPES = ['product_tasting', 'training'];
export const LIVE_STATUSES = ['pending', 'confirmed'];
const NO_BRAND_PREFERENCE = 'Itakda muna ang brand preference ng applicant.';
const SUGGESTION_LIMIT = 3;
const SUGGESTION_STEP = 30;
const SUGGESTION_DAYS = 14;

export const isAdmin = (actor: Row | null | undefined) => actor?.role?.name === 'admin';
export const isLive = (s: Row) => LIVE_STATUSES.includes(s.status);
const inactive = `('cancelled', 'removed')`;

export const SESSION_RELATIONS = (alias: string) => `
  (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = ${alias}.brand_id) as brand,
  (select jsonb_build_object('id', u.id, 'full_name', u.full_name) from users u where u.id = ${alias}.handler_id) as handler,
  coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('applicant', (select jsonb_build_object('id', a.id, 'applicant_code', a.applicant_code, 'full_name', a.full_name, 'status', a.status, 'preferred_brand_id', a.preferred_brand_id,
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

export function brandReasons(type: string, brandId: number | null, applicants: Row[]): string[] {
  if (!BRANDED_TYPES.includes(type)) return [];
  const reasons: string[] = [];
  if (brandId === null) reasons.push(`Brand is required for ${activityLabel(type)}.`);
  for (const a of applicants) {
    if (a.preferred_brand_id === null || a.preferred_brand_id === undefined) reasons.push(`${a.full_name}: ${NO_BRAND_PREFERENCE}`);
    else if (brandId !== null && Number(a.preferred_brand_id) !== brandId) {
      reasons.push(`${a.full_name}: brand preference is ${a.preferred_brand?.name ?? 'another brand'} — hindi tugma sa brand ng session.`);
    }
  }
  return reasons;
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
    max_capacity: Number(p.max_capacity ?? sessionCapacity(type)),
    existing_count: Number(p.existing_count ?? 0),
    ignore_session_ids: (p.ignore_session_ids ?? []).map(Number) as number[],
    detach: p.detach ?? null,
    check_applicant_gates: Boolean(p.check_applicant_gates),
    check_window: p.check_window === undefined ? true : Boolean(p.check_window),
  };
}
type Proposal = ReturnType<typeof normalize>;

function windowReasons(p: Proposal): string[] {
  try {
    resolveWindow(p.start_at, null, p.end_at);
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

function isMergeCandidate(p: Proposal, session: Row, participants: Row[], applicants: Row[]): boolean {
  if (session.activity_type !== p.activity_type || !p.applicant_ids.length) return false;
  if (p.activity_type === 'training') return false;
  if (p.activity_type === 'product_tasting') {
    if (Number(session.brand_id ?? 0) !== Number(p.brand_id ?? 0) || brandReasons('product_tasting', session.brand_id, applicants).length) return false;
  }
  return session.max_capacity - participants.length >= p.applicant_ids.length;
}

function checkAgainst(p: Proposal, applicants: Row[], sessions: Row[]) {
  const hard: string[] = [];
  const warnings: string[] = [];
  const targets: Row[] = [];
  const separateBlockers: string[] = [];
  for (const session of sessions) {
    if (p.ignore_session_ids.includes(session.id)) continue;
    let participants: Row[] = session.active_participants;
    if (p.detach && p.detach.session_id === session.id) participants = participants.filter((r) => r.applicant_id !== p.detach.applicant_id);

    if (!overlaps(p.start_at, p.end_at, session)) {
      if (p.handler_id !== null && session.handler_id === p.handler_id) {
        const gap = endOf(session) <= p.start_at ? (p.start_at.getTime() - endOf(session).getTime()) / MINUTE : (startOf(session).getTime() - p.end_at.getTime()) / MINUTE;
        if (gap < NEAR_GAP_MINUTES) {
          warnings.push(`Near conflict: handler ${session.handler?.full_name ?? `#${session.handler_id}`} has ${describe(session)} — only ${Math.trunc(gap)} min apart (minimum ${NEAR_GAP_MINUTES} min).`);
        }
      }
      continue;
    }
    const sessionHard: string[] = [];
    for (const clash of participants.filter((r) => p.applicant_ids.includes(r.applicant_id))) {
      sessionHard.push(`${clash.applicant?.full_name ?? 'Applicant'} already has ${describe(session)}.`);
    }
    if (p.activity_type === 'product_tasting' && session.activity_type === 'product_tasting' && Number(session.brand_id ?? 0) !== Number(p.brand_id ?? 0)) {
      sessionHard.push(`Overlaps with ${describe(session)}; ibang brand.`);
    }
    if (p.activity_type === 'training' && session.activity_type === 'training') {
      sessionHard.push(`Overlaps with ${describe(session)} — Training sessions cannot overlap.`);
    }
    const mergeable = !sessionHard.length && isMergeCandidate(p, session, participants, applicants);
    const sameHandler = p.handler_id !== null && session.handler_id === p.handler_id;
    const handlerMessage = `Handler ${session.handler?.full_name ?? `#${session.handler_id}`} is already booked at ${timeRange(session)} (${activityLabel(session.activity_type)}).`;
    if (mergeable) {
      targets.push({
        session_id: session.id, activity_type: session.activity_type, start_at: iso8601(session.start_at), end_at: iso8601(session.end_at), time: timeRange(session),
        brand: session.brand?.name ?? null, handler: session.handler?.full_name ?? null, venue: session.venue, status: session.status,
        occupancy: `${participants.length}/${session.max_capacity} applicants`,
        why: `${session.activity_type === 'orientation' ? 'Orientation (any brand)' : 'Parehong brand'}, may ${session.max_capacity - participants.length} slot(s) pa`,
      });
      if (sameHandler) separateBlockers.push(`${handlerMessage} Merge into that session or pick another handler.`);
      else if (session.handler_id === p.handler_id && String(session.venue ?? '') === String(p.venue ?? '')) {
        separateBlockers.push(`A separate session at the same time needs another handler or venue than ${describe(session)}.`);
      }
      continue;
    }
    if (sameHandler) sessionHard.push(handlerMessage);
    hard.push(...sessionHard);
  }
  return { hard, merge_targets: targets, separate_blockers: separateBlockers, warnings };
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

export async function evaluate(db: Db, proposal: Row, actor: Row | null, withSuggestions = true) {
  const p = normalize(proposal);
  const applicants = await applicantsWithBrand(db, p.applicant_ids);
  const fixed: string[] = [];
  if (p.check_window) fixed.push(...windowReasons(p));
  fixed.push(...brandReasons(p.activity_type, p.brand_id, applicants));
  const total = p.existing_count + p.applicant_ids.length;
  if (p.max_capacity < 1) fixed.push('Capacity must be at least 1.');
  else if (total > p.max_capacity) fixed.push(`Lalampas sa max capacity (${total}/${p.max_capacity} applicants).`);
  if (p.check_applicant_gates) fixed.push(...(await gateReasons(db, p, applicants)));

  const sessions = await liveSessions(db, addMinutes(p.start_at, -NEAR_GAP_MINUTES), addMinutes(p.end_at, NEAR_GAP_MINUTES));
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
  if (!isLive(target) || !isLive(source)) return ['Pending o Confirmed na session lang ang puwedeng pagsamahin.'];
  if (source.activity_type !== target.activity_type) return [`Ibang activity (${activityLabel(source.activity_type)} vs ${activityLabel(target.activity_type)}) — hindi puwedeng pagsamahin.`];
  if (target.activity_type === 'training') return ['Training sessions are never merged.'];
  const reasons: string[] = [];
  const moving: Row[] = source.active_participants.map((r: Row) => r.applicant).filter(Boolean);
  if (target.activity_type === 'product_tasting') {
    if (Number(source.brand_id ?? 0) !== Number(target.brand_id ?? 0)) reasons.push(`Ibang brand (${source.brand?.name ?? 'walang brand'} vs ${target.brand?.name ?? 'walang brand'}) — hindi puwedeng pagsamahin.`);
    reasons.push(...brandReasons('product_tasting', target.brand_id, moving));
  }
  const taken = target.active_participants.length;
  if (moving.length > target.max_capacity - taken) reasons.push(`Puno na ang session (${taken}/${target.max_capacity} applicants) — ${moving.length} applicant(s) ang ililipat.`);
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
  for (const target of sessions.filter((s) => s.id !== source.id)) {
    const reasons = await mergeReasons(db, source, target, sessions);
    out.push({ session_id: target.id, status: reasons.length ? 'blocked' : isAdmin(actor) ? 'mergeable' : 'neutral', reasons });
  }
  return out;
}
