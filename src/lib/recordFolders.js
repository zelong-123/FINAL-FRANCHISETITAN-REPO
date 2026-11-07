/*
 * Display rules for the Application Detail record folders (shared by the card
 * grid and the list table in components/applicants/RecordFolders.jsx).
 */

export const RECORD_FOLDERS = [
  { key: 'active', label: 'Active Applicants' },
  { key: 'approved', label: 'Approved / Active Franchise' },
  { key: 'rejected', label: 'Rejected' },
];

// Payment-side stages show "% paid"; earlier stages show "Step N of M".
export const PAYMENT_STAGES = new Set(['payment_submitted', 'for_approval']);

/** Branch line: real business name → branch location → brand → explicit fallback. */
export function branchLabel(row) {
  return row.business_name || row.location || row.brand || 'No branch assigned';
}

/** "% paid", or "No payment plan" when no total was ever set (0% would be meaningless). */
export function paidLabel(row) {
  const percent = Number(row.payment_percent) || 0;
  if (percent <= 0 && !row.payment_required_amount) return 'No payment plan';
  return `${Math.round(percent)}% paid`;
}

/** Plan summary for tooltips and the list view, e.g. "Kiosk Package · ₱200,000". */
export function planTitle(row, formatAmount = (value) => String(value)) {
  if (!row.payment_plan && !row.payment_required_amount) return 'No payment plan';
  const parts = [row.payment_plan?.package_name || 'Payment plan'];
  if (row.payment_required_amount) parts.push(`₱${formatAmount(row.payment_required_amount)}`);
  return parts.join(' · ');
}

/** The date that matters for the folder: approved / rejected / last updated. */
export function folderDate(folder, row) {
  if (folder === 'approved') return row.approved_at;
  if (folder === 'rejected') return row.rejected_at;
  return row.updated_at;
}
