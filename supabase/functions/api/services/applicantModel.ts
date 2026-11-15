// The computed parts of App\Models\Applicant: milestones and progress.
import type { Db, Row } from '../lib/db.ts';
import { PIPELINE } from '../config/roles.ts';

export const APPLICANT_MODEL = 'App\\Models\\Applicant';

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

/**
 * Billing columns kept in the database (deprecated) but never exposed: the system does not bill
 * or compute payments. See migration 20261114000001_required_payments.sql.
 */
export const DEPRECATED_BILLING_KEYS = [
  'package_name', 'total_required_amount', 'total_required_original_amount', 'total_required_discount_percent', 'initial_payment_amount', 'other_fees',
  'payments_fully_paid_on', 'total_required_set_at', 'total_required_set_by_user_id', 'payment_plan', 'plan', 'total_set_by',
];

/** Model toArray(): every row leaving the API carries the appended `progress`, and no billing column. */
export const applicantJson = (row: Row): Row => {
  const out: Row = { ...row, progress: progress(row) };
  for (const key of DEPRECATED_BILLING_KEYS) delete out[key];
  return out;
};

export const loadApplicant = async (db: Db, id: number): Promise<Row | null> =>
  (await db.query(`select * from applicants where id = $1`, [id]))[0] ?? null;

export const loadPlan = async (db: Db, applicantId: number): Promise<Row | null> =>
  (await db.query(`select * from applicant_payment_plans where applicant_id = $1 limit 1`, [applicantId]))[0] ?? null;
