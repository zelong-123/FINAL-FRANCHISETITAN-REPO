// Brand Confirmation (between Product Tasting and Training) and the brand lock that follows it.
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

/** The brand that was tasted: the latest completed Product Tasting's brand, else the applicant's brand. */
export async function tastedBrandId(db: Db, a: Row): Promise<number | null> {
  const [row] = await db.query(
    `select tasted_brand_id from activity_schedules where applicant_id = $1 and activity_type = 'product_tasting' and status = 'completed' and tasted_brand_id is not null
     order by coalesce(completed_at, starts_at) desc limit 1`, [a.id],
  );
  return row ? Number(row.tasted_brand_id) : (a.preferred_brand_id ? Number(a.preferred_brand_id) : null);
}

/** A Product Tasting for this brand that Sales completed and Admin marked Attended after `since`. */
export async function retastingDone(db: Db, applicantId: number, brandId: number, since: Date | string): Promise<boolean> {
  const [row] = await db.query(
    `select 1 from activity_schedules where applicant_id = $1 and activity_type = 'product_tasting' and status = 'completed' and review_status = 'accepted'
       and tasted_brand_id = $2 and created_at >= $3 limit 1`,
    [applicantId, brandId, since],
  );
  return Boolean(row);
}

/** When a submitted confirmation names a brand that was not tasted: the time re-tasting started. */
export async function retastingSince(db: Db, applicantId: number): Promise<Date | null> {
  const c = await latestBrandConfirmation(db, applicantId);
  if (!c || c.status !== 'submitted' || !c.retasting_required) return null;
  if (await retastingDone(db, applicantId, Number(c.final_brand_id), c.submitted_at)) return null;
  return new Date(c.submitted_at);
}

export async function brandState(db: Db, a: Row): Promise<Row> {
  const confirmation = await latestBrandConfirmation(db, a.id);
  const legacy = await isLegacyLocked(db, a);
  const locked = Boolean(a.brand_locked_at) || legacy;
  let retastingComplete = false;
  if (confirmation?.status === 'submitted' && confirmation.retasting_required) {
    retastingComplete = await retastingDone(db, a.id, Number(confirmation.final_brand_id), confirmation.submitted_at);
  }
  return { locked, legacy, confirmed: Boolean(a.brand_locked_at), confirmation, retasting_required: Boolean(confirmation?.retasting_required && confirmation.status === 'submitted'), retasting_done: retastingComplete };
}

export const LOCKED_MESSAGE = 'The brand is locked: Admin confirmed it after Product Tasting, so it can no longer be changed.';
export const LEGACY_LOCKED_MESSAGE = 'The brand is locked: this applicant is already at Training or later (Legacy - brand confirmation not captured).';

/** Every path that would change preferred_brand_id calls this first. */
export async function assertBrandUnlocked(db: Db, a: Row, field = 'preferred_brand_id') {
  if (a.brand_locked_at) fail(field, LOCKED_MESSAGE);
  if (await isLegacyLocked(db, a)) fail(field, LEGACY_LOCKED_MESSAGE);
}

/** Training is scheduled only after Admin confirms the brand (legacy applicants are not blocked). */
export async function assertBrandConfirmedForTraining(db: Db, a: Row) {
  if (a.brand_locked_at || (await isLegacyLocked(db, a))) return;
  fail('activity_type', 'Training can be scheduled only after Admin confirms the brand. Complete Brand Confirmation after Product Tasting first.');
}
