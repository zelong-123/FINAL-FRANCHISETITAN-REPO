// Read-only data for the Schedule activity modal: the calendar picker (days, hour slots, the next
// available time) and the Sessions panel (upcoming sessions the applicant could join). Both only look
// at the applicant's assigned Sales user (the handler) and the selected activity; the same rule
// helpers as the save check produce every reason, so the picker and the save never disagree.
import type { Db, Row } from '../../lib/db.ts';
import { activityLabel } from '../pipeline.ts';
import {
  brandReasons, capacityReason, evaluate, facilityReason, handlerAvailabilityReasons, isLive, liveSessions, SESSION_RELATIONS,
} from './conflict.ts';
import {
  addMinutes, atLocal, capacityOf, DEFAULT_DURATION, formatRange, iso8601, isoDay, localDay, monthDay, occupancyLabel, scheduleWindow, endByReason, weekdayMonthDay,
} from './rules.ts';
import { facilityLimit, loadScheduleLimits } from './settings.ts';

const HOUR = 60;
/** How far ahead "Next available" looks (business days are skipped over weekends). */
const NEXT_AVAILABLE_DAYS = 60;
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', rescheduled: 'Rescheduled', merged: 'Merged' };

const handlerOf = async (db: Db, applicant: Row) => (applicant.assigned_sales_user_id
  ? (await db.query(`select id, full_name from users where id = $1`, [applicant.assigned_sales_user_id]))[0] ?? null
  : null);

/** The reason one start time cannot be used (null = free). Busy = this handler (any activity, with the gap) or the facility limit. */
export function slotReason(type: string, handlerId: number | null, start: Date, duration: number, sessions: Row[], ignore: number[] = [], now = new Date(), requireHandler = true): string | null {
  const end = addMinutes(start, duration);
  if (start.getTime() <= now.getTime()) return 'This time has passed.';
  if (end.getTime() > atLocal(localDay(start), scheduleWindow.closes).getTime()) return endByReason(duration, type);
  // No handler picked in the session modal: sessions may be saved without one, so only the facility limit applies.
  if (handlerId === null) {
    if (requireHandler) return 'This applicant has no assigned Sales user. Assign one before scheduling.';
    return facilityReason(type, start, end, sessions, ignore);
  }
  const busy = handlerAvailabilityReasons({ handler_id: handlerId, start_at: start, end_at: end, activity_type: type }, sessions, ignore);
  if (busy.length) return busy[0];
  return facilityReason(type, start, end, sessions, ignore);
}

/** Mon–Fri days of a month ("2026-11") as YYYY-MM-DD. */
function weekdaysOf(month: string): string[] {
  const days: string[] = [];
  for (let d = atLocal(`${month}-01`, 12 * HOUR); localDay(d).startsWith(month); d = addMinutes(d, 1440)) {
    if (scheduleWindow.workingDays.includes(isoDay(d))) days.push(localDay(d));
  }
  return days;
}

/** Hour slots 9:00 … 5:00 PM for one day, each with its reason when it cannot be used. */
function slotsOf(day: string, type: string, handlerId: number | null, duration: number, sessions: Row[], ignore: number[], now: Date, requireHandler = true) {
  const slots: Row[] = [];
  for (let m = scheduleWindow.opens; m <= scheduleWindow.closes; m += HOUR) {
    const start = atLocal(day, m);
    const reason = slotReason(type, handlerId, start, duration, sessions, ignore, now, requireHandler);
    slots.push({ time: `${String(m / HOUR).padStart(2, '0')}:00`, start_at: iso8601(start), available: reason === null, reason });
  }
  return slots;
}

/**
 * `applicant` drives the picker in the Schedule activity modal (handler = the applicant's Sales user).
 * The Master Schedule's "Schedule a session" modal has no applicant: it passes `forcedHandlerId`
 * (the handler picked in the form, may be null) and gets the same calendar for that handler.
 */
export async function availability(db: Db, applicant: Row | null, type: string, month: string, durationMinutes: number | null, ignoreSessionId: number | null = null, forcedHandlerId: number | null = null) {
  const limits = await loadScheduleLimits(db);
  const duration = durationMinutes && durationMinutes > 0 ? durationMinutes : DEFAULT_DURATION[type] ?? 120;
  const applicantHandler = applicant ? await handlerOf(db, applicant) : null;
  const handler = applicantHandler
    ?? (forcedHandlerId ? (await db.query(`select id, full_name from users where id = $1`, [forcedHandlerId]))[0] ?? null : null);
  const handlerId = handler ? Number(handler.id) : null;
  const ignore = ignoreSessionId ? [ignoreSessionId] : [];
  const now = new Date();
  const monthStart = atLocal(`${month}-01`, 0);
  const monthEnd = atLocal(localDay(addMinutes(monthStart, 32 * 1440)).slice(0, 7) + '-01', 0);
  const todayStart = atLocal(localDay(now), 0);
  const horizon = addMinutes(todayStart, (NEXT_AVAILABLE_DAYS + 1) * 1440);
  const from = monthStart < todayStart ? monthStart : todayStart;
  const to = monthEnd > horizon ? monthEnd : horizon;
  // Live sessions of every Sales user: the facility limit counts them all; the handler rule filters to the handler.
  const sessions = await liveSessions(db, from, to);

  // Dots: this handler's sessions of the SAME activity (other Sales users are never shown).
  // "No Show" seats of each session: the calendar dot turns red for a session where somebody did not attend.
  const own = handlerId === null ? [] : await db.query(
    `select s.id, s.start_at, s.end_at, s.status, s.max_capacity, s.activity_type,
       (select count(*)::int from schedule_session_participants p where p.session_id = s.id and p.attendance_status not in ('cancelled', 'removed')) as taken,
       (select count(*)::int from schedule_session_participants p where p.session_id = s.id and p.attendance_status = 'no_show') as no_shows
     from schedule_sessions s where s.handler_id = $1 and s.activity_type = $2 and s.status in ('pending', 'confirmed', 'completed') and s.start_at >= $3 and s.start_at < $4
     order by s.start_at`,
    [handlerId, type, monthStart, monthEnd],
  );

  // Applicant-based pickers need the assigned Sales user; the session modal may be saved with no handler.
  const requireHandler = Boolean(applicant);
  const days = weekdaysOf(month).map((day) => {
    const slots = slotsOf(day, type, handlerId, duration, sessions, ignore, now, requireHandler);
    // The session being adjusted is ignored everywhere, including its dot: its own day stays free.
    const mine = own.filter((s) => !ignore.includes(Number(s.id)) && localDay(new Date(s.start_at)) === day).map((s) => ({
      id: s.id, start_at: iso8601(s.start_at), end_at: iso8601(s.end_at), status: s.status, time: formatRange(new Date(s.start_at), new Date(s.end_at)),
      occupancy: occupancyLabel(Number(s.taken), capacityOf(s)),
      no_show_count: Number(s.no_shows ?? 0), did_not_attend: Number(s.no_shows ?? 0) > 0,
    }));
    const available = slots.some((s) => s.available);
    let reason: string | null = null;
    if (!available) {
      const dayEnd = atLocal(day, scheduleWindow.closes);
      const why = slots.map((s) => s.reason as string).find((r) => r !== 'This time has passed.' && !r.startsWith('Sessions must end by'));
      reason = dayEnd <= now ? 'This day has passed.' : why ? `No free start on ${monthDay(atLocal(day, 12 * HOUR))}. ${why}` : `No ${duration / HOUR}-hour ${activityLabel(type)} fits on ${monthDay(atLocal(day, 12 * HOUR))}.`;
    }
    return { date: day, available, reason, sessions: mine, slots };
  });

  // Next available: the first free start from now on (any month), hour by hour.
  let next: Row | null = null;
  for (let d = 0; d <= NEXT_AVAILABLE_DAYS && !next; d += 1) {
    const dayStart = addMinutes(todayStart, d * 1440 + 12 * HOUR);
    if (!scheduleWindow.workingDays.includes(isoDay(dayStart))) continue;
    const day = localDay(dayStart);
    for (let m = scheduleWindow.opens; m + duration <= scheduleWindow.closes; m += HOUR) {
      const start = atLocal(day, m);
      if (slotReason(type, handlerId, start, duration, sessions, ignore, now, requireHandler) === null) {
        next = { date: day, time: `${String(m / HOUR).padStart(2, '0')}:00`, start_at: iso8601(start), label: `${weekdayMonthDay(start)} · ${formatRange(start, addMinutes(start, duration))}` };
        break;
      }
    }
  }

  const [brand] = applicant?.preferred_brand_id ? await db.query(`select id, name from brands where id = $1`, [applicant.preferred_brand_id]) : [];
  return {
    applicant_id: applicant?.id ?? null, activity_type: type, activity_label: activityLabel(type), duration_minutes: duration,
    // Training is for the applicant's selected brand; Orientation/Tasting is any brand.
    applicant_brand: brand ? { id: Number(brand.id), name: brand.name } : null,
    handler: handler ? { id: handlerId, full_name: handler.full_name } : null,
    capacity: type === 'training' ? limits.training_capacity : limits.orientation_capacity,
    facility_limit: facilityLimit(type),
    month, days, next_available: next,
  };
}

/** The Sessions panel: upcoming sessions of this activity run by the applicant's Sales user, each with whether it can be joined. */
export async function joinableSessions(db: Db, applicant: Row, type: string, actor: Row) {
  await loadScheduleLimits(db);
  const handler = await handlerOf(db, applicant);
  if (!handler) return { handler: null, sessions: [], reason: 'This applicant has no assigned Sales user. Assign one before scheduling.' };
  const rows = await db.query(
    `select s.*, ${SESSION_RELATIONS('s')} from schedule_sessions s
     where s.handler_id = $1 and s.activity_type = $2 and s.start_at > now() and s.status not in ('merged', 'rescheduled')
     order by s.start_at limit 50`,
    [handler.id, type],
  );
  const [withBrand] = await db.query(
    `select a.*, (select jsonb_build_object('id', b.id, 'name', b.name) from brands b where b.id = a.preferred_brand_id) as preferred_brand from applicants a where a.id = $1`,
    [applicant.id],
  );
  const sessions: Row[] = [];
  for (const s of rows) {
    const taken = (s.active_participants ?? []).length;
    const capacity = capacityOf(s);
    let reason: string | null = null;
    if (!isLive(s)) reason = `This session is ${STATUS_LABEL[s.status] ?? s.status}.`;
    else if ((s.active_participants ?? []).some((p: Row) => Number(p.applicant_id) === Number(applicant.id))) reason = 'The applicant is already in this session.';
    else reason = capacityReason(type, taken, 1, capacity) ?? brandReasons(type, s.brand_id === null ? null : Number(s.brand_id), [withBrand], s.brand?.name ?? null)[0] ?? null;
    if (!reason) {
      // Everything else the add itself checks (the applicant's own schedule, the order of activities, …).
      const evaluation = await evaluate(db, {
        activity_type: s.activity_type, brand_id: s.brand_id, start_at: s.start_at, end_at: s.end_at, handler_id: s.handler_id, venue: s.venue,
        applicant_ids: [applicant.id], existing_count: taken, max_capacity: s.max_capacity, ignore_session_ids: [s.id], check_applicant_gates: true,
        check_window: false, check_facility: false,
      }, actor, false);
      reason = evaluation.reasons[0] ?? null;
    }
    const start = new Date(s.start_at);
    const end = new Date(s.end_at);
    sessions.push({
      id: s.id, activity_type: s.activity_type, activity_label: activityLabel(s.activity_type), start_at: iso8601(start), end_at: iso8601(end),
      date: localDay(start), date_label: weekdayMonthDay(start), time: formatRange(start, end), venue: s.venue, brand: s.brand ?? null, status: s.status,
      status_label: STATUS_LABEL[s.status] ?? s.status, participant_count: taken, capacity, occupancy: `${taken}/${capacity}`,
      joinable: reason === null, reason,
    });
  }
  return { handler: { id: Number(handler.id), full_name: handler.full_name }, sessions };
}
