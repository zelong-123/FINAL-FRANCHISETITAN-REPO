// The computed parts of App\Models\Applicant: milestones, progress and payment facts.
import type { Db, Row } from '../lib/db.ts';
import { PIPELINE } from '../config/roles.ts';

export const APPLICANT_MODEL = 'App\\Models\\Applicant';
export const PAYMENT_INITIAL_PERCENT = 1;
// Approval needs the record Fully Paid: the old 80% rule is gone.
export const PAYMENT_APPROVAL_PERCENT = 100;

// config/franchise.php milestones
export const MILESTONES: Record<string, string> = {
  qualification_profile_reviewed: 'Applicant profile reviewed',
  qualification_financial_capability_assessed: 'Financial capability assessed',
  qualification_initial_interview_completed: 'Initial interview completed',
  qualification_preferred_location_evaluated: 'Preferred location evaluated',
  qualification_investment_understood: 'Applicant understands franchise investment',
  orientation_attended: 'Orientation attended',
  product_tasting_attended: 'Product tasting attended',
  training_completed: 'Training completed',
};
export const QUALIFICATION_KEYS = Object.keys(MILESTONES).filter((k) => k.startsWith('qualification_'));
export const REQUIRED_MILESTONES = [...new Set([...QUALIFICATION_KEYS, ...PIPELINE.tracked_milestones])];

export function milestoneState(applicant: Row) {
  const stored = applicant.milestones ?? {};
  return Object.entries(MILESTONES).map(([key, label]) => ({ key, label, completed: Boolean(stored[key]) }));
}

export function progress(applicant: Row) {
  const items = milestoneState(applicant).filter((m) => REQUIRED_MILESTONES.includes(m.key));
  const completed = items.filter((m) => m.completed).length;
  const milestonePercent = items.length ? Math.round((completed / items.length) * 100) : 0;
  const stages = Object.keys(PIPELINE.stages);
  const position = stages.indexOf(applicant.status);
  const stagePercent = position < 0 ? 0 : Math.round(((position + 1) / stages.length) * 100);
  const closed = ['approved', 'active_franchisee'].includes(applicant.status);
  const rejected = applicant.status === 'rejected';
  return {
    milestones_completed: completed,
    milestones_total: items.length,
    milestone_percent: milestonePercent,
    stage_percent: stagePercent,
    percent: rejected ? milestonePercent : Math.max(milestonePercent, closed ? 100 : stagePercent),
    state: rejected ? 'rejected' : closed ? 'complete' : milestonePercent === 100 ? 'ready' : 'in_progress',
  };
}

/** Model toArray(): every row leaving the API carries the appended `progress`. */
export const applicantJson = (row: Row): Row => ({ ...row, progress: progress(row) });

export const loadApplicant = async (db: Db, id: number): Promise<Row | null> =>
  (await db.query(`select * from applicants where id = $1`, [id]))[0] ?? null;

export const loadPlan = async (db: Db, applicantId: number): Promise<Row | null> =>
  (await db.query(`select * from applicant_payment_plans where applicant_id = $1 limit 1`, [applicantId]))[0] ?? null;

async function isLegacyFullyPaid(db: Db, a: Row): Promise<boolean> {
  if (a.status !== 'active_franchisee') return false;
  const [row] = await db.query(
    `select exists (select 1 from applicant_payments where applicant_id = $1 and is_legacy_baseline = true)
        or exists (select 1 from payments where applicant_id = $1 and payment_type = 'legacy_fully_paid') as legacy`,
    [a.id],
  );
  return row.legacy;
}

const requiredAmount = (a: Row, plan: Row | null) => Number(plan?.total_required_amount ?? a.total_required_amount ?? 0);

export function isPaymentFullyDiscounted(a: Row, plan: Row | null): boolean {
  const original = Number(plan?.total_required_original_amount ?? a.total_required_original_amount ?? 0);
  return requiredAmount(a, plan) <= 0 && original > 0;
}

export async function verifiedPaymentTotal(db: Db, a: Row, plan?: Row | null): Promise<number> {
  const p = plan === undefined ? await loadPlan(db, a.id) : plan;
  if (await isLegacyFullyPaid(db, a)) return requiredAmount(a, p);
  const [row] = await db.query(`select coalesce(sum(amount), 0) as total from payments where applicant_id = $1 and status = 'verified'`, [a.id]);
  return Number(row.total);
}

export async function hasVerifiedInitialPayment(db: Db, a: Row): Promise<boolean> {
  const plan = await loadPlan(db, a.id);
  if ((await isLegacyFullyPaid(db, a)) || isPaymentFullyDiscounted(a, plan)) return true;
  let initial = Number(plan?.initial_payment_amount ?? a.initial_payment_amount ?? 0);
  const required = requiredAmount(a, plan);
  if (initial <= 0 && required > 0) initial = required * (PAYMENT_INITIAL_PERCENT / 100);
  if (initial > 0) return (await verifiedPaymentTotal(db, a, plan)) >= initial;
  const types = '{downpayment,initial_payment,initial_franchise_fee,franchise_fee}';
  const [row] = await db.query(
    `select exists (select 1 from payments where applicant_id = $1 and status = 'verified' and payment_type = any($2::text[]))
        or exists (select 1 from applicant_payments where applicant_id = $1 and status = 'verified' and payment_type = any($2::text[])) as has`,
    [a.id, types],
  );
  return row.has;
}

export async function paymentPercent(db: Db, a: Row): Promise<number> {
  const plan = await loadPlan(db, a.id);
  if ((await isLegacyFullyPaid(db, a)) || isPaymentFullyDiscounted(a, plan)) return 100;
  const required = requiredAmount(a, plan);
  if (required <= 0) return 0;
  return Math.min(100, Math.round(((await verifiedPaymentTotal(db, a, plan)) / required) * 10000) / 100);
}
