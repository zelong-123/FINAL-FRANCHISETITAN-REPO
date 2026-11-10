// Application Detail: every recorded action of an applicant, sorted into the seven report pages.
import type { Db, Row } from '../lib/db.ts';
import { requirementsOf } from './requirements.ts';

export const REPORT_PAGES = ['overview', 'qualification', 'activities', 'loi', 'payment', 'approval', 'history'] as const;
export type ReportPage = typeof REPORT_PAGES[number];

const QUALIFICATION_STEPS = new Set(['qualification', ...requirementsOf('qualification').map((r) => r.key)]);
const ACTIVITY_STEPS = new Set(['orientation', 'product_tasting', 'training', 'brand_confirmation']);
const APPROVAL_STEPS = new Set(['activation', ...requirementsOf('activation').map((r) => r.key)]);

/** The report page an action belongs to (History shows them all). */
export function pageOf(row: Row): Exclude<ReportPage, 'history'> {
  const step = String(row.step ?? '');
  const event = String(row.event ?? '');
  const to = String(row.to_stage ?? '');
  const from = String(row.from_stage ?? '');
  const stageChange = from !== to;
  if (QUALIFICATION_STEPS.has(step) || event === 'assessment_saved' || (stageChange && to === 'qualified')) return 'qualification';
  if (ACTIVITY_STEPS.has(step) || event.startsWith('activity_') || event.startsWith('brand_') || ['set_again', 'participant_removed', 'scheduled'].includes(event)
    || (stageChange && to === 'scheduled')) return 'activities';
  if (step === 'loi' || event.startsWith('loi_') || (stageChange && (to === 'loi_submitted' || from === 'loi_submitted'))) return 'loi';
  if (step === 'payment_record' || event.startsWith('payment_') || step.startsWith('applicant.payment') || (stageChange && (to === 'payment_submitted' || to === 'for_approval'))) return 'payment';
  if (APPROVAL_STEPS.has(step) || (stageChange && ['approved', 'active_franchisee'].includes(to)) || step === 'applicant.revision_requested') return 'approval';
  return 'overview';
}

const NICE: Record<string, string> = {
  converted: 'Converted from inquiry', created: 'Applicant created', sales_assigned: 'Sales user assigned', sales_reassigned: 'Sales user reassigned',
  assessment_saved: 'Checklist saved (old)', requirement_submitted: 'Requirement submitted', requirement_resubmitted: 'Requirement resubmitted',
  requirement_accepted: 'Requirement accepted', requirement_returned: 'Requirement returned', activity_completed: 'Activity completed by Sales',
  activity_no_show: 'Marked No Show', activity_attended: 'Marked Attended by Admin', activity_returned: 'Activity returned to Sales',
  activity_completed_early: 'Completed early (legacy)', brand_confirmation_submitted: 'Final brand submitted', brand_confirmation_returned: 'Brand Confirmation returned',
  brand_confirmed: 'Brand confirmed and locked', brand_changed: 'Brand changed', loi_uploaded: 'LOI scan uploaded', loi_replaced: 'LOI scan replaced',
  loi_details_saved: 'LOI details saved', loi_verification_changed: 'LOI verification changed', loi_returned: 'LOI returned to Sales', loi_image_removed: 'LOI scan removed',
  loi_completed: 'LOI completed', loi_proceeded: 'Proceeded with LOI pending', payment_agreed_amount_set: 'Agreed Package Amount set',
  payment_agreed_amount_changed: 'Agreed Package Amount changed', payment_entry_submitted: 'Payment recorded', payment_entry_verified: 'Payment verified',
  payment_entry_returned: 'Payment returned to Sales', payment_entry_reviewed: 'Payment reviewed (older flow)', follow_up_logged: 'Follow-up logged',
  set_again: 'Set Again', scheduled: 'Schedule approved', participant_removed: 'Removed from a session', document_removed: 'File removed',
};
const STAGE_NAMES: Record<string, string> = {
  converted: 'Converted', qualified: 'Qualified', scheduled: 'Scheduling', loi_submitted: 'LOI', payment_submitted: 'Payment Record', for_approval: 'For Approval',
  approved: 'Approved', active_franchisee: 'Active Franchisee', rejected: 'Rejected',
};

/** A plain-English name for the action. */
export function actionLabel(row: Row): string {
  if (row.event && NICE[row.event]) return NICE[row.event];
  if (row.event) return String(row.event).replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase());
  if (row.from_stage !== row.to_stage) return `Stage: ${STAGE_NAMES[row.from_stage] ?? 'New'} → ${STAGE_NAMES[row.to_stage] ?? row.to_stage}`;
  return 'Action';
}

/**
 * Every action of the applicant, oldest first, each tagged with its report page. Files are listed
 * only for users who may open them (Admin and the assigned Sales user).
 */
export async function applicantHistory(db: Db, applicantId: number, showFiles: boolean, page: string | null = null): Promise<Row[]> {
  const rows = await db.query(
    `select h.id, h.from_stage, h.to_stage, h.event, h.step, h.remarks, h.changed_at, h.created_at, h.actor_role, h.old_values, h.new_values, h.attachments, h.context,
       (select full_name from users where id = h.changed_by_user_id) as by_name, h.changed_by_user_id
     from applicant_stage_histories h where h.applicant_id = $1 order by coalesce(h.changed_at, h.created_at), h.id`,
    [applicantId],
  );
  return rows
    .map((h) => ({
      id: h.id, at: h.changed_at ?? h.created_at, by: h.by_name ?? (h.actor_role === 'system' ? 'System' : null), by_user_id: h.changed_by_user_id, role: h.actor_role,
      page: pageOf(h), action: actionLabel(h), event: h.event, step: h.step, stage: h.to_stage, from_stage: h.from_stage,
      reason: h.remarks, old_values: h.old_values, new_values: h.new_values,
      attachments: showFiles ? (h.attachments ?? []) : (h.attachments ?? []).map(() => ({ hidden: true })),
    }))
    .filter((h) => !page || page === 'history' || h.page === page);
}
