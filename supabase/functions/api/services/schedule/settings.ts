// Admin-configurable scheduling limits (schedule_settings, one row). No row = the defaults below.
//  capacity        how many applicants one session takes (Orientation/Tasting 5, Training 1)
//  facility limit  how many sessions of that activity may run at the same time across all Sales users
//                  (Orientation/Tasting 5 rooms, Training 2 kitchens)
// The values are read once per request (loadScheduleLimits) and kept here so the pure rule
// helpers (sessionCapacity, the slot check) can read them without a database handle.
import type { Db } from '../../lib/db.ts';

export const SCHEDULE_LIMIT_DEFAULTS = Object.freeze({
  orientation_capacity: 5,
  training_capacity: 1,
  orientation_facility_limit: 5,
  training_facility_limit: 2,
});
export type ScheduleLimits = { -readonly [K in keyof typeof SCHEDULE_LIMIT_DEFAULTS]: number };
export const LIMIT_KEYS = Object.keys(SCHEDULE_LIMIT_DEFAULTS) as (keyof ScheduleLimits)[];
/** Inclusive bounds an Admin may save (the table has the same check). */
export const LIMIT_BOUNDS = { min: 1, max: 50 };

let current: ScheduleLimits = { ...SCHEDULE_LIMIT_DEFAULTS };

export const scheduleLimits = (): ScheduleLimits => current;

export async function loadScheduleLimits(db: Db): Promise<ScheduleLimits> {
  const [row] = await db.query(`select ${LIMIT_KEYS.join(', ')} from schedule_settings order by id desc limit 1`);
  current = row
    ? Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(row[k]) || SCHEDULE_LIMIT_DEFAULTS[k]])) as ScheduleLimits
    : { ...SCHEDULE_LIMIT_DEFAULTS };
  return current;
}

/** Sessions of this activity that may run at the same time (no limit for untracked types). */
export function facilityLimit(type: string): number {
  if (type === 'orientation') return current.orientation_facility_limit;
  if (type === 'training') return current.training_facility_limit;
  return Number.POSITIVE_INFINITY;
}
