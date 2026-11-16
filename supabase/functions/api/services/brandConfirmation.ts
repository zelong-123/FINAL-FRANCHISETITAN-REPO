// The brand lock. The separate Brand Confirmation step is retired: the brand is now selected when Sales
// completes Orientation/Tasting and locked when Admin verifies it (see routes/activities.ts).
import type { Db, Row } from '../lib/db.ts';
import { fail } from '../lib/http.ts';

export const BRAND_METHODS: Record<string, string> = { in_person: 'In person', call: 'Call', message: 'Message', written: 'Written' };
/** Stages after Scheduling: an older applicant already here has a fixed brand. */
const PAST_SCHEDULING = ['loi_submitted', 'payment_submitted', 'for_approval', 'approved', 'active_franchisee'];

export const latestBrandConfirmation = async (db: Db, applicantId: number): Promise<Row | null> =>
  (await db.query(`select * from applicant_brand_confirmations where applicant_id = $1 order by id desc limit 1`, [applicantId]))[0] ?? null;

/** Legacy: already at Training or later before Brand Confirmation existed. */
async function isLegacyLocked(db: Db, a: Row): Promise<boolean> {
  if (a.brand_locked_at) return false;
  if (PAST_SCHEDULING.includes(a.status) || (a.milestones ?? {}).training_completed) return true;
  const [training] = await db.query(
    `select 1 from activity_schedules where applicant_id = $1 and activity_type = 'training' and status <> 'cancelled' and approval_status <> 'rejected' limit 1`, [a.id],
  );
  return Boolean(training);
}

/** The separate Brand Confirmation step is retired; its endpoints refuse (the table is kept as history). */
export const BRAND_CONFIRMATION_ENABLED = false;
export const BRAND_CONFIRMATION_RETIRED = 'Brand Confirmation is no longer a separate step: Sales selects the brand when completing Orientation/Tasting, and Admin verifies it there.';

/** The brand chosen at Orientation/Tasting (the latest completed one), else the applicant's brand. */
export async function tastedBrandId(db: Db, a: Row): Promise<number | null> {
  const [row] = await db.query(
    `select selected_brand_id from activity_schedules where applicant_id = $1 and activity_type = 'orientation' and status = 'completed' and selected_brand_id is not null
     order by coalesce(completed_at, starts_at) desc limit 1`, [a.id],
  );
  return row ? Number(row.selected_brand_id) : (a.preferred_brand_id ? Number(a.preferred_brand_id) : null);
}

/** Re-tasting is retired with Product Tasting: kept so older callers read "never". */
export async function retastingDone(_db: Db, _applicantId: number, _brandId: number, _since: Date | string): Promise<boolean> {
  return false;
}
export async function retastingSince(_db: Db, _applicantId: number): Promise<Date | null> {
  return null;
}

export async function brandState(db: Db, a: Row): Promise<Row> {
  const confirmation = await latestBrandConfirmation(db, a.id);
  const legacy = await isLegacyLocked(db, a);
  const locked = Boolean(a.brand_locked_at) || legacy;
  return { locked, legacy, confirmed: Boolean(a.brand_locked_at), confirmation, retasting_required: false, retasting_done: false, retired: true };
}

export const LOCKED_MESSAGE = 'The brand is locked: Admin verified it at Orientation/Tasting, so it can no longer be changed.';
export const LEGACY_LOCKED_MESSAGE = 'The brand is locked: this applicant is already at Training or later (Legacy - brand confirmation not captured).';

/** Every path that would change preferred_brand_id calls this first. */
export async function assertBrandUnlocked(db: Db, a: Row, field = 'preferred_brand_id') {
  if (a.brand_locked_at) fail(field, LOCKED_MESSAGE);
  if (await isLegacyLocked(db, a)) fail(field, LEGACY_LOCKED_MESSAGE);
}

/** Training needs Orientation/Tasting verified (which locks the brand); legacy applicants are not blocked. */
export async function assertBrandConfirmedForTraining(db: Db, a: Row) {
  if (a.brand_locked_at || (await isLegacyLocked(db, a))) return;
  fail('activity_type', 'Training can be scheduled only after Admin verifies Orientation/Tasting (attendance proof, brand document and selected brand).');
}
