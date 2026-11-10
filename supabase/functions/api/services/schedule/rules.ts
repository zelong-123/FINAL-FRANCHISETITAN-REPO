// App\Services\ScheduleService + App\Support\ScheduleWindow + ScheduleDayLock.
// Asia/Manila has no daylight saving, so local time is a fixed +08:00.
import type { Db, Row } from '../../lib/db.ts';
import { fail } from '../../lib/http.ts';
import { activityLabel, assertPreviousActivityDone } from '../pipeline.ts';
import { retastingSince } from '../brandConfirmation.ts';

const OFFSET_MS = 8 * 3600_000;
export const MINUTE = 60_000;
export const VENUE_OPTIONS = ['Main Office (In-person)', 'Virtual'];
export const TRACKED_TYPES = ['orientation', 'product_tasting', 'training'];
export const DEFAULT_DURATION: Record<string, number> = { orientation: 120, product_tasting: 120, training: 180 };
export const NEAR_GAP_MINUTES = 30;
const OPENS = 9 * 60;
const CLOSES = 18 * 60;
const LAST_START = CLOSES - 60;
const WORKING_DAYS = [1, 2, 3, 4, 5];
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A value with no timezone means Manila wall-clock time, as Carbon::parse(.., $tz) read it. */
export function parseLocal(value: unknown): Date {
  if (value instanceof Date) return value;
  const text = String(value).trim().replace(' ', 'T');
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00+08:00`) : new Date(hasZone ? text : `${text}+08:00`);
  if (Number.isNaN(date.getTime())) fail('start_at', 'The date is not valid.');
  return date;
}

const shifted = (d: Date) => new Date(d.getTime() + OFFSET_MS);
export const localDay = (d: Date) => shifted(d).toISOString().slice(0, 10);
export const localMinutes = (d: Date) => shifted(d).getUTCHours() * 60 + shifted(d).getUTCMinutes();
export const isoDay = (d: Date) => shifted(d).getUTCDay() || 7;
export const atLocal = (day: string, minutes: number) => new Date(new Date(`${day}T00:00:00+08:00`).getTime() + minutes * MINUTE);
export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MINUTE);
/** toIso8601String() in the business timezone. */
export const iso8601 = (d: Date | string | null | undefined) => (d ? `${shifted(new Date(d)).toISOString().slice(0, 19)}+08:00` : null);

function clock(d: Date) {
  const s = shifted(d);
  const h = s.getUTCHours();
  return { g: h % 12 === 0 ? 12 : h % 12, i: String(s.getUTCMinutes()).padStart(2, '0'), A: h >= 12 ? 'PM' : 'AM' };
}
export function formatRange(start: Date, end: Date): string {
  const a = clock(start);
  const b = clock(end);
  return a.A === b.A ? `${a.g}:${a.i}–${b.g}:${b.i} ${b.A}` : `${a.g}:${a.i} ${a.A}–${b.g}:${b.i} ${b.A}`;
}
export const monthDay = (d: Date) => `${MONTHS[shifted(d).getUTCMonth()]} ${shifted(d).getUTCDate()}`;
export const weekdayMonthDay = (d: Date) => `${SHORT_DAYS[shifted(d).getUTCDay()]}, ${monthDay(d)}`;
export function longDateTime(d: Date): string {
  const s = shifted(d);
  const c = clock(d);
  return `${MONTHS[s.getUTCMonth()]} ${String(s.getUTCDate()).padStart(2, '0')}, ${s.getUTCFullYear()} ${c.g}:${c.i} ${c.A}`;
}
/** "Nov 11, 2026, 10:30 AM" in Manila time: the hint on a Complete that is not available yet. */
export function availableLabel(d: Date): string {
  const s = shifted(d);
  const c = clock(d);
  return `${MONTHS[s.getUTCMonth()]} ${s.getUTCDate()}, ${s.getUTCFullYear()}, ${c.g}:${c.i} ${c.A}`;
}
const windowLabel = (minutes: number) => {
  const h = Math.trunc(minutes / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minutes % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const hhmm = (minutes: number) => `${String(Math.trunc(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const DAYS_LABEL = `${DAY_NAMES[WORKING_DAYS[0]]} to ${DAY_NAMES[WORKING_DAYS[WORKING_DAYS.length - 1]]}`;

export const scheduleWindow = {
  opens: OPENS,
  closes: CLOSES,
  workingDays: WORKING_DAYS,
  toArray: () => ({
    opens_at: hhmm(OPENS), closes_at: hhmm(CLOSES), last_start: hhmm(LAST_START), working_days: WORKING_DAYS, days_label: DAYS_LABEL,
    step_minutes: 30, default_duration_minutes: DEFAULT_DURATION,
  }),
};

/** The API is the authority on when an activity may run; the form only mirrors this. */
export function resolveWindow(startsAt: Date, durationMinutes: number | null, endsAtValue: unknown) {
  let endsAt = endsAtValue ? parseLocal(endsAtValue) : null;
  if (durationMinutes !== null && durationMinutes > 0) {
    if (durationMinutes % 60 !== 0) fail('duration_minutes', 'Duration must be a whole number of hours (1 hr, 2 hrs, 3 hrs, …). Minutes are not allowed.');
    endsAt = addMinutes(startsAt, durationMinutes);
  } else if (durationMinutes !== null) {
    fail('duration_minutes', 'Duration must be at least 1 whole hour.');
  }
  if (!endsAt) fail('duration_minutes', 'Provide either an activity duration or an end time.');
  const end = endsAt as Date;
  const startMinutes = localMinutes(startsAt);
  if (startMinutes % 60 !== 0 && startMinutes % 60 !== 30) fail('starts_at', 'Start time must be on the hour or on the half hour (e.g. 9:00 AM or 1:30 PM).');
  const closeLabel = windowLabel(CLOSES);
  const lastLabel = windowLabel(LAST_START);
  if (CLOSES - startMinutes < 60) fail('starts_at', `No whole-hour duration fits before ${closeLabel}, so this start time cannot be used. The last valid start time is ${lastLabel}.`);
  if (startsAt.getTime() < Date.now()) fail('starts_at', 'Activities cannot be scheduled in the past.');
  if (!WORKING_DAYS.includes(isoDay(startsAt)) || !WORKING_DAYS.includes(isoDay(end))) fail('starts_at', `Activities can only be scheduled ${DAYS_LABEL}.`);
  if (startMinutes < OPENS) fail('starts_at', `Activities must start between ${windowLabel(OPENS)} and ${lastLabel} local time.`);
  if (end.getTime() > atLocal(localDay(startsAt), CLOSES).getTime()) fail('duration_minutes', `The activity must end by ${closeLabel}. Choose a shorter duration or an earlier start time.`);
  if (end.getTime() <= startsAt.getTime()) fail('duration_minutes', 'The activity duration must be at least 1 whole hour.');
  const minutes = Math.round((end.getTime() - startsAt.getTime()) / MINUTE);
  if (minutes % 60 !== 0) fail('duration_minutes', 'Duration must be a whole number of hours (1 hr, 2 hrs, 3 hrs, …). Minutes are not allowed.');
  return { starts_at: startsAt, ends_at: end, duration_minutes: minutes };
}

export const sessionCapacity = (type: string) => ({ orientation: 30, product_tasting: 15, training: 10 } as Record<string, number>)[type] ?? 0;

/** One lock per touched calendar day, sorted so two writers never deadlock. Needs a transaction. */
export async function acquireDayLocks(tx: Db, moments: unknown[]) {
  const days = [...new Set(moments.filter(Boolean).map((m) => localDay(new Date(m as string))))].sort();
  for (const day of days) {
    await tx.query(`insert into schedule_day_locks (day) values ($1::date) on conflict do nothing`, [day]);
    await tx.query(`select day from schedule_day_locks where day = $1::date for update`, [day]);
  }
}

async function sessionRows(db: Db, type: string, startsAt: Date, brandId: number | null, ignoreId: number | null, sessionKey: string) {
  return db.query<{ n: number }>(
    `select count(*)::int as n from activity_schedules s
     where s.activity_type = $1 and s.starts_at = $2 and s.session_key = $3 and s.status <> 'cancelled' and s.approval_status <> 'rejected'
       and ($4::bigint is null or s.id <> $4::bigint)
       and ($1 <> 'product_tasting' or exists (select 1 from applicants a where a.id = s.applicant_id and a.preferred_brand_id = $5::bigint))`,
    [type, startsAt, sessionKey, ignoreId, brandId],
  );
}

export async function sessionOccupancy(db: Db, type: string, startsAt: Date, brandId: number | null = null, ignoreId: number | null = null, sessionKey = '') {
  const capacity = sessionCapacity(type);
  const [{ n }] = await sessionRows(db, type, startsAt, brandId, ignoreId, sessionKey);
  return { activity_type: type, starts_at: iso8601(startsAt), brand_id: brandId, session_id: sessionKey, attending: n, capacity, full: capacity > 0 && n >= capacity };
}

export async function assertCapacity(db: Db, type: string, startsAt: Date, brandId: number | null = null, ignoreId: number | null = null, sessionKey = '') {
  if (sessionCapacity(type) <= 0) return;
  const o = await sessionOccupancy(db, type, startsAt, brandId, ignoreId, sessionKey);
  if (!o.full) return;
  fail('starts_at', `Session full: ${activityLabel(type)}${type === 'product_tasting' ? ' for this brand' : ''} on ${longDateTime(startsAt)} already has ${o.capacity}/${o.capacity} applicants.`);
}

export async function assertNoConflict(db: Db, applicantId: number, startsAt: Date, endsAt: Date, ignoreId: number | null = null) {
  if (endsAt.getTime() <= startsAt.getTime()) fail('ends_at', 'The end time must be after the start time.');
  const [conflict] = await db.query(
    `select activity_type, starts_at, ends_at from activity_schedules where applicant_id = $1 and status not in ('cancelled', 'completed', 'no_show')
     and approval_status <> 'rejected' and starts_at < $2 and ends_at > $3 and ($4::bigint is null or id <> $4::bigint) order by starts_at limit 1`,
    [applicantId, endsAt, startsAt, ignoreId],
  );
  if (!conflict) return;
  const start = new Date(conflict.starts_at);
  const c = clock(new Date(conflict.ends_at));
  fail('starts_at', `This applicant already has ${activityLabel(conflict.activity_type)} from ${longDateTime(start)} to ${c.g}:${c.i} ${c.A}. Choose another time — back-to-back schedules are allowed.`);
}

export async function assertSlotFree(db: Db, applicantId: number, type: string, ignoreId: number | null = null) {
  if (!TRACKED_TYPES.includes(type)) return;
  // A No Show leaves the slot free for Set Again; a re-tasting for a new brand only looks at rows since it started.
  const since = type === 'product_tasting' ? await retastingSince(db, applicantId) : null;
  const [existing] = await db.query(
    `select status from activity_schedules where applicant_id = $1 and activity_type = $2 and status not in ('cancelled', 'no_show') and approval_status <> 'rejected'
     and ($3::bigint is null or id <> $3::bigint) and ($4::timestamptz is null or created_at >= $4::timestamptz) order by id desc limit 1`,
    [applicantId, type, ignoreId, since],
  );
  if (existing) fail('activity_type', `${activityLabel(type)} already has a ${existing.status} record for this applicant. Each activity is scheduled exactly once — move the existing date with Adjust instead of creating another one.`);
}

export async function assertPrerequisiteDone(db: Db, applicantId: number, type: string) {
  if (!TRACKED_TYPES.includes(type)) return;
  const [a] = await db.query(`select * from applicants where id = $1`, [applicantId]);
  if (a) await assertPreviousActivityDone(db, a, type);
}

export async function assertNoPendingRequest(db: Db, applicantId: number) {
  if ((await db.query(`select 1 from activity_schedules where applicant_id = $1 and approval_status = 'pending_admin' limit 1`, [applicantId])).length) {
    fail('approval_status', 'A Sales request is already waiting for Admin approval. Confirm or reject it first.');
  }
}

export async function assertNotPreviouslyCompleted(db: Db, applicantId: number, type: string, ignoreId: number | null = null) {
  // A re-tasting for a newly chosen brand is the one allowed repeat of a completed activity.
  if (type === 'product_tasting' && await retastingSince(db, applicantId)) return;
  const completed = await db.query(`select 1 from activity_schedules where applicant_id = $1 and activity_type = $2 and status = 'completed' and ($3::bigint is null or id <> $3::bigint) limit 1`, [applicantId, type, ignoreId]);
  const key = ({ orientation: 'orientation_attended', product_tasting: 'product_tasting_attended', training: 'training_completed' } as Row)[type];
  const [a] = await db.query(`select milestones from applicants where id = $1`, [applicantId]);
  if (completed.length || (key && a?.milestones?.[key])) fail('activity_type', 'This activity has already been completed and cannot be scheduled again.');
}

export async function assertNoOtherActiveSchedule(db: Db, applicantId: number, ignoreId: number | null = null) {
  const found = await db.query(`select 1 from activity_schedules where applicant_id = $1 and status in ('pending', 'confirmed') and approval_status <> 'rejected' and ($2::bigint is null or id <> $2::bigint) limit 1`, [applicantId, ignoreId]);
  if (found.length) fail('applicant_id', 'Complete or cancel the current activity before scheduling another one.');
}

export async function assertNoDuplicate(db: Db, applicantId: number, title: string, startsAt: Date, ignoreId: number | null = null) {
  const found = await db.query(
    `select 1 from activity_schedules where applicant_id = $1 and title = $2 and starts_at = $3 and status in ('pending', 'confirmed') and approval_status <> 'rejected' and ($4::bigint is null or id <> $4::bigint) limit 1`,
    [applicantId, title, startsAt, ignoreId],
  );
  if (found.length) fail('title', 'This person already has an activity with the same title at this time.');
}
