/*
 * Display rules for the Application Detail record folders (shared by the card
 * grid and the list table in components/applicants/RecordFolders.jsx).
 */

export const RECORD_FOLDERS = [
  { key: 'active', label: 'Active Applicants' },
  { key: 'approved', label: 'Approved / Active Franchise' },
  { key: 'rejected', label: 'Rejected' },
];

// Payment-side stages show "N of M verified"; earlier stages show "Step N of M".
export const PAYMENT_STAGES = new Set(['payment_submitted', 'for_approval']);

/** Branch line: real business name → branch location → brand → explicit fallback. */
export function branchLabel(row) {
  return row.business_name || row.location || row.brand || 'No branch assigned';
}

/** Required payments verified, as a count of milestones (never money). */
export function paidLabel(row) {
  const required = Number(row.payments_required) || 0;
  if (!required) return 'No required payments';
  return `${Number(row.payments_verified) || 0} of ${required} verified`;
}

/** Tooltip / list line for the payment column. */
export function planTitle(row) {
  const required = Number(row.payments_required) || 0;
  if (!required) return 'Admin has not set the required payments';
  const verified = Number(row.payments_verified) || 0;
  return verified === required ? 'All required payments verified' : `${required - verified} required payment${required - verified === 1 ? '' : 's'} not verified yet`;
}

/** The date that matters for the folder: approved / rejected / last updated. */
export function folderDate(folder, row) {
  if (folder === 'approved') return row.approved_at;
  if (folder === 'rejected') return row.rejected_at;
  return row.updated_at;
}
