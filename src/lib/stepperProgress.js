/*
 * Fill rules for the applicant stage tracker connectors (display only; the API enforces the gates).
 */

/** Converted → Qualified: accepted Qualification requirements out of all of them (0/4 … 4/4). */
export function qualificationFill(accepted, total) {
  if (!total) return null;
  return Math.max(0, Math.min(1, accepted / total));
}

/**
 * LOI Submission → Payment Record: two halves, independent of order.
 * The left half is the LOI (verified with its file), the right half the Proposed site (Accepted).
 */
export function loiHalves({ loiVerified, siteVerified }) {
  return { left: Boolean(loiVerified), right: Boolean(siteVerified), ratio: (loiVerified ? 0.5 : 0) + (siteVerified ? 0.5 : 0) };
}
