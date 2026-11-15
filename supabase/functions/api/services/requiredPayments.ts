// Required payments: the list of payments (names only, never amounts) an applicant must complete.
// "Fully paid" means every required payment is Verified by Admin. The system never stores a target
// amount, never sums money and never computes a balance; counting Verified milestones is not money.
import type { Db, Row } from '../lib/db.ts';

export const PLAN_PRESETS: Record<string, { label: string; items: string[] }> = {
  full: { label: 'Full payment', items: ['Full Payment'] },
  reservation_full: { label: 'Reservation fee + full payment', items: ['Reservation Fee', 'Full Payment'] },
  downpayment_balance: { label: 'Downpayment + balance', items: ['Downpayment', 'Balance'] },
};
export const CUSTOM_PRESET = 'custom';

/** Stored entry statuses keep their old values (the OR/AR and reference unique indexes rely on them). */
export function entryStatus(stored: unknown): 'for_verification' | 'verified' | 'rejected' {
  if (stored === 'verified') return 'verified';
  if (stored === 'pending') return 'for_verification';
  return 'rejected'; // returned, rejected and the older for_revision
}
export const ENTRY_STATUS_LABELS: Record<string, string> = {
  not_yet_paid: 'Not yet paid', for_verification: 'For verification', verified: 'Verified', rejected: 'Rejected',
};

/** Older history records may carry billing values (amounts, totals, percentages): never shown. */
const MONEY_KEY = /amount|total|balance|discount|percent|cents|remaining|paid_cents|promo|fee|package_name|agreed|installment|due_date|frequency|^source$/i;
export function withoutMoney(values: Row | null | undefined): Row | null {
  if (!values || typeof values !== 'object') return values ?? null;
  const out: Row = {};
  // basis_note is a working note for the Payment Record card only: never repeated in history or reports.
  for (const [k, v] of Object.entries(values)) if (!MONEY_KEY.test(k) && k !== 'basis_note') out[k] = v;
  return out;
}

/** Stages the old flow had already confirmed: an applicant here without a list is not blocked. */
const PAST_PAYMENT = ['for_approval', 'approved', 'active_franchisee'];
export const legacySatisfied = (a: Row) =>
  Boolean(a.payment_confirmed_at) || a.payment_stage_state === 'confirmed' || PAST_PAYMENT.includes(a.status);

/** Active required payments, in order, each with the status of its latest entry. */
export async function requiredItems(db: Db, applicantId: number): Promise<Row[]> {
  return db.query(
    `select r.id, r.name, r.position, r.created_at,
       (select p.status from payments p where p.required_payment_id = r.id order by p.id desc limit 1) as latest_status,
       (select count(*)::int from payments p where p.required_payment_id = r.id) as entry_count
     from applicant_required_payments r
     where r.applicant_id = $1 and r.removed_at is null
     order by r.position, r.id`,
    [applicantId],
  ).then((rows) => rows.map((r) => ({ ...r, status: r.latest_status ? entryStatus(r.latest_status) : 'not_yet_paid' })));
}

export async function paymentProgress(db: Db, applicantId: number) {
  const items = await requiredItems(db, applicantId);
  const verified = items.filter((i) => i.status === 'verified').length;
  const pending = items.some((i) => i.status === 'for_verification');
  const badge = items.length > 0 && verified === items.length ? 'completed' : pending ? 'for_verification' : 'unpaid';
  return { items, required: items.length, verified, all_verified: items.length > 0 && verified === items.length, badge };
}

/** Why the applicant cannot move past the Payment Record yet, or null. */
export async function requiredPaymentsBlocker(db: Db, a: Row): Promise<string | null> {
  const { items, verified } = await paymentProgress(db, a.id);
  if (!items.length) {
    if (legacySatisfied(a)) return null;
    return 'Admin must set the required payments first. The applicant moves to For Approval once all required payments are Verified.';
  }
  const open = items.filter((i) => i.status !== 'verified');
  if (open.length) {
    return `All required payments must be Verified first: ${verified} of ${items.length} required payments verified. Not yet verified: ${open.map((i) => i.name).join(', ')}.`;
  }
  return null;
}
