// App\Support\ApplicantPipeline: wrong role -> 403, skipped or unmet stage -> 422.
import type { Db, Row } from '../lib/db.ts';
import { abort, fail, manilaToday, ValidationError } from '../lib/http.ts';
import { REASON_MIN } from './accountability.ts';
import { PIPELINE } from '../config/roles.ts';
import { MILESTONES, QUALIFICATION_KEYS, REQUIRED_MILESTONES } from './applicantModel.ts';
import { requiredPaymentsBlocker } from './requiredPayments.ts';
import { loadRequirementRows } from './requirements.ts';

export const NOT_SCHEDULABLE = 'Activities can only be scheduled for applicants at the Scheduling stage. Admin must click Set Schedule first.';
export const LOI_PENDING_BLOCK = 'The LOI is still Pending. Upload the soft-copy image, mark it Verified and click [Complete] in the LOI section before moving to For Approval.';
const STAGES = PIPELINE.stages as Record<string, { label: string }>;
export const STAGE_ORDER = Object.keys(STAGES);

// The parts of config/applicant_pipeline.php that roles.ts does not send to the browser.
const EDGE_RULES: Record<string, { requires?: string; remarks_required?: boolean }> = {
  'converted>qualified': { requires: 'qualification_checked' },
  'qualified>scheduled': { requires: 'qualification_checked' },
  'scheduled>loi_submitted': { requires: 'scheduled_checked', remarks_required: true },
  'loi_submitted>scheduled': { remarks_required: true },
  'payment_submitted>for_approval': { requires: 'payments_verified' },
  'for_approval>approved': { requires: 'approved_ready' },
  'approved>active_franchisee': { requires: 'payments_verified' },
};

export const TRACKED_ACTIVITY_MILESTONES: Record<string, string> = {
  orientation: 'orientation_attended',
  training: 'training_completed',
};
export const ACTIVITY_ORDER = Object.keys(TRACKED_ACTIVITY_MILESTONES);

export const isSchedulable = (a: Row) => !a.archived_at && a.status === 'scheduled';
export const stageLabel = (stage: string | null) => STAGES[stage ?? '']?.label || String(stage ?? '').replace(/_/g, ' ');
/** Orientation and Product Tasting are one activity: Orientation/Tasting (stored key 'orientation'). */
export const activityLabel = (type: string) => (type === 'orientation' || type === 'product_tasting' ? 'Orientation/Tasting'
  : type.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
export const nextActivityType = (type: string) => {
  const i = ACTIVITY_ORDER.indexOf(type);
  return i < 0 ? null : ACTIVITY_ORDER[i + 1] ?? null;
};

export async function statusLabel(db: Db, a: Row): Promise<string> {
  switch (a.status) {
    case 'scheduled': return (await scheduledChecked(db, a)) ? 'Scheduled' : 'Scheduling';
    case 'loi_submitted': return a.loi_verification_status === 'verified' || a.loi_confirmed_at ? 'LOI Submitted' : 'LOI Submission';
    case 'payment_submitted': return 'Payment Record';
    case 'active_franchisee': return 'Active Franchise';
    default: return stageLabel(a.status);
  }
}

export const qualificationChecked = (a: Row) => QUALIFICATION_KEYS.every((k) => (a.milestones ?? {})[k]);

export function assertQualificationChecked(a: Row) {
  if (qualificationChecked(a)) return;
  const pending = QUALIFICATION_KEYS.filter((k) => !(a.milestones ?? {})[k]).map((k) => MILESTONES[k]).join(', ');
  fail('status', `Complete the qualification checklist before moving forward: ${pending}.`);
}

/** Types Sales marked Complete: Master Schedule first, activity_schedules before migration. */
async function salesCompletedTypes(db: Db, a: Row, types: string[]): Promise<Set<string>> {
  const rows = await db.query(
    `select s.activity_type, p.attendance_status from schedule_session_participants p
     join schedule_sessions s on s.id = p.session_id where p.applicant_id = $1`,
    [a.id],
  );
  // Sales' Complete is saved on activity_schedules and may not be copied to the
  // session participant yet, so either source counts.
  const schedules = await db.query(
    `select activity_type from activity_schedules where applicant_id = $1 and status = 'completed' and activity_type = any($2::text[])`,
    [a.id, `{${types.join(',')}}`],
  );
  return new Set([
    ...rows.filter((r) => types.includes(r.activity_type) && ['completed', 'attended'].includes(r.attendance_status)).map((r) => r.activity_type),
    ...schedules.map((r) => r.activity_type),
  ]);
}

/** DONE = Sales marked Complete AND Admin marked Attended and saved it. */
export async function activityDoneState(db: Db, a: Row): Promise<Record<string, boolean>> {
  const milestones = a.milestones ?? {};
  const completed = await salesCompletedTypes(db, a, ACTIVITY_ORDER);
  return Object.fromEntries(Object.entries(TRACKED_ACTIVITY_MILESTONES).map(([type, key]) => [type, Boolean(milestones[key]) && completed.has(type)]));
}

export const activityDone = async (db: Db, a: Row, type: string) => Boolean((await activityDoneState(db, a))[type]);

export async function currentActivityType(db: Db, a: Row): Promise<string | null> {
  const done = await activityDoneState(db, a);
  return ACTIVITY_ORDER.find((t) => !done[t]) ?? null;
}

export async function assertPreviousActivityDone(db: Db, a: Row, type: string) {
  const i = ACTIVITY_ORDER.indexOf(type);
  if (i <= 0) return;
  const previous = ACTIVITY_ORDER[i - 1];
  if (!(await activityDone(db, a, previous))) {
    fail('activity_type', `${activityLabel(type)} comes after ${activityLabel(previous)}. Sales must mark ${activityLabel(previous)} Complete and Admin must mark it Attended and Save Applicant first.`);
  }
}

const latestOfType = async (db: Db, a: Row, type: string) => (await db.query(
  `select status from activity_schedules where applicant_id = $1 and activity_type = $2 and approval_status <> 'rejected' order by id desc limit 1`, [a.id, type],
))[0] ?? null;

export async function setAgainTarget(db: Db, a: Row): Promise<string> {
  if (a.archived_at) fail('applicant', 'An archived applicant cannot be scheduled.');
  if (!isSchedulable(a)) fail('applicant_id', NOT_SCHEDULABLE);
  const target = await currentActivityType(db, a);
  if (target === null) fail('activity_type', 'Both activities are Done — there is no next step to schedule. Use [Completed] at the Scheduling stage to move to LOI Submission.');
  // After a No Show, Set Again reschedules the same activity (Orientation included).
  const noShow = (await latestOfType(db, a, target!))?.status === 'no_show';
  if (target === ACTIVITY_ORDER[0] && !noShow) fail('activity_type', `No activity is Done yet — schedule ${activityLabel(target!)} with Set Schedule instead of Set Again.`);
  await assertPreviousActivityDone(db, a, target!);
  return target!;
}

export async function scheduledChecked(db: Db, a: Row): Promise<boolean> {
  return Object.values(await activityDoneState(db, a)).every(Boolean);
}

export async function assertScheduledChecked(db: Db, a: Row) {
  if (await scheduledChecked(db, a)) return;
  const milestones = a.milestones ?? {};
  const pending = PIPELINE.tracked_milestones.filter((k) => !milestones[k]).map((k) => MILESTONES[k] ?? k);
  let message = pending.length ? `Scheduled is not checked yet. Pending: ${pending.join(', ')}.` : 'Scheduled is not checked yet.';
  const done = await activityDoneState(db, a);
  const awaiting = Object.entries(done)
    .filter(([type, isDone]) => !isDone && milestones[TRACKED_ACTIVITY_MILESTONES[type]])
    .map(([type]) => type.replace(/_/g, ' '));
  if (awaiting.length) message += ` Marked attended but not Done — Sales must mark these Complete first: ${awaiting.join(', ')}.`;
  fail('status', message);
}

/** No billing: the gate is "at least one required payment, and every one Verified by Admin". */
export async function assertRequiredPaymentsVerified(db: Db, a: Row) {
  const blocker = await requiredPaymentsBlocker(db, a);
  if (blocker) fail('status', blocker);
}

export const loiPending = (a: Row) => a.loi_status === 'pending';

const loiDocumentExists = async (db: Db, a: Row) => (await db.query(
  `select 1 from documents where documentable_type = 'App\\Models\\Applicant' and documentable_id = $1 and type = 'loi' and removed_at is null limit 1`, [a.id],
)).length > 0;

/**
 * Complete LOI (LOI Submission -> Payment Record) needs the LOI verified with its file AND the
 * Proposed site Accepted by Admin. `withSite` is false only for an older Pending LOI that is
 * completed after the applicant already reached Payment Record (the stage does not move then).
 */
export async function assertLoiCompletable(db: Db, a: Row, withSite = true) {
  const messages: string[] = [];
  if (!a.loi_submission_date) messages.push('Set the LOI submission date.');
  else if (String(a.loi_submission_date).slice(0, 10) > manilaToday()) messages.push('The LOI submission date cannot be in the future.');
  if (a.loi_verification_status !== 'verified') messages.push('Mark the LOI as Verified.');
  // The scanned LOI is always required, hard copies included.
  if (!(await loiDocumentExists(db, a))) messages.push('Upload the scanned LOI first — it is required for every LOI, hard copies included.');
  if (withSite) {
    const site = (await loadRequirementRows(db, a.id)).find((r) => r.requirement_key === 'proposed_site');
    if (site?.status !== 'accepted') {
      const where = { submitted: 'it is waiting for Admin review', returned: 'it was returned to Sales' }[String(site?.status)] ?? 'it has not been submitted yet';
      messages.push(`The Proposed site must be verified by Admin (${where}).`);
    }
  }
  if (messages.length) fail('loi', `Complete LOI needs the LOI (with its file) and the Proposed site verified. Missing: ${messages.join(' ')}`);
}

export async function approvalBlocker(db: Db, a: Row): Promise<string | null> {
  const milestones = a.milestones ?? {};
  const missing = REQUIRED_MILESTONES.filter((k) => !milestones[k]);
  if (missing.length) {
    const done = REQUIRED_MILESTONES.length - missing.length;
    return `Approval Failed: Applicant has completed ${done}/${REQUIRED_MILESTONES.length} required activities. Pending: ${missing.map((k) => MILESTONES[k] ?? k).join(', ')}.`;
  }
  const hasLoi = (await loiDocumentExists(db, a)) || Boolean(a.loi_confirmed_at);
  if (!hasLoi) return 'A Letter of Intent is required before approval.';
  const payments = await requiredPaymentsBlocker(db, a);
  if (payments) return payments;
  if (!a.reviewed_at) return 'The review must be confirmed first — use "Review" at the For Approval stage.';
  return null;
}

function blockedReason(from: string, to: string): string {
  if (from === 'active_franchisee') return 'An active franchisee cannot be moved back through the applicant pipeline.';
  if (to === 'rejected') return 'An active franchisee cannot be rejected. Archive the record instead.';
  const fromIndex = STAGE_ORDER.indexOf(from);
  const toIndex = STAGE_ORDER.indexOf(to);
  if (fromIndex >= 0 && toIndex >= 0 && toIndex > fromIndex + 1) {
    return `Stage skipped: ${stageLabel(from)} → ${stageLabel(to)}. Complete "${stageLabel(STAGE_ORDER[fromIndex + 1])}" first — no stage can be skipped.`;
  }
  if (fromIndex >= 0 && toIndex >= 0 && toIndex <= fromIndex) return `The pipeline only moves forward: ${stageLabel(from)} is already past ${stageLabel(to)}.`;
  return `Cannot move from ${stageLabel(from)} to ${stageLabel(to)}.`;
}

export async function assertTransition(db: Db, a: Row, to: string, user: Row, remarks: string | null = null, allowOwnedEdges = false) {
  const from = a.status;
  if (from === to) return;
  if (from === 'active_franchisee') fail('status', blockedReason(from, to));
  const edge = PIPELINE.transitions.find((e) => (e.from === '*' || e.from === from) && e.to === to);
  if (!edge) throw new ValidationError({ status: [blockedReason(from, to)] });
  if (!edge.roles.includes(user.role?.name)) abort(403, `Only ${edge.roles.join(' or ')} can: ${edge.action}.`);
  if (!edge.generic && !allowOwnedEdges) fail('status', `This stage change is handled by "${edge.action}" — use that action instead of moving the stage directly.`);

  const rules = EDGE_RULES[`${from}>${to}`] ?? (to === 'rejected' ? { remarks_required: true } : {});
  if (rules.remarks_required && String(remarks ?? '').trim().length < REASON_MIN) {
    fail('remarks', `Remarks are required for "${edge.action}" (at least ${REASON_MIN} characters) so the record shows who did it and why.`);
  }
  switch (rules.requires) {
    case 'qualification_checked': assertQualificationChecked(a); break;
    case 'scheduled_checked': await assertScheduledChecked(db, a); break;
    case 'payments_verified': await assertRequiredPaymentsVerified(db, a); break;
    case 'approved_ready': {
      const blocker = await approvalBlocker(db, a);
      if (blocker) fail('status', blocker);
      break;
    }
  }
  if (to === 'for_approval' && loiPending(a)) fail('loi', LOI_PENDING_BLOCK);
}
