/**
 * Payment Submission installment rules (Phase 4) — the same if-then rules the
 * API enforces in App\Support\InstallmentRules, used to guide the Sales form.
 * Amounts are pesos (numbers with up to 2 decimals).
 *
 *  - Downpayment >= min_downpayment_percent of the FINAL total.
 *  - Installment >= saved downpayment × installment percent (fixed), or the
 *    remaining balance when that is lower (the last payment).
 *  - Downpayment first (unless the entry is a Full Payment); one downpayment.
 */

const toCents = (value) => Math.round((Number(value) || 0) * 100);
const fromCents = (cents) => cents / 100;

/** Minimum downpayment for a final total (rounded up to the centavo, like the API). */
export function minDownpayment(totalRequired, percent) {
  return fromCents(Math.ceil((toCents(totalRequired) * (Number(percent) || 0)) / 100));
}

/** The fixed installment minimum for a downpayment. */
export function minInstallment(downpayment, percent) {
  return fromCents(Math.round((toCents(downpayment) * (Number(percent) || 0)) / 100));
}

/** The minimum for the next installment: the fixed minimum, or the balance when lower. */
export function currentMinimum(downpayment, remaining, percent) {
  return fromCents(Math.max(0, Math.min(toCents(minInstallment(downpayment, percent)), toCents(remaining))));
}

/**
 * The downpayment the installment minimum is based on: the saved one (from
 * the API), else a Downpayment drafted earlier in this same report, else null.
 */
export function downpaymentBase(installment, drafts = []) {
  if (installment?.has_downpayment) return Number(installment.downpayment_amount) || 0;
  const drafted = drafts.find((item) => item.payment_type === 'downpayment');
  return drafted ? Number(drafted.amount) || 0 : null;
}

const peso = (value) => `₱${Number(value).toLocaleString('en-PH', { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = (value) => String(Number(value));

/**
 * Why an entry amount is not allowed by the installment rules ('' when fine).
 * `remaining` is what this entry may still use (drafts already taken out).
 */
export function entryRuleIssue({
  type, amount, remaining, totalRequired, base, hasEarlierEntries,
  minDownpaymentPercent = 20, installmentPercent = 50,
}) {
  const value = Number(amount) || 0;
  if (type === 'full_payment' || value <= 0) return '';
  if (type === 'downpayment') {
    const minimum = minDownpayment(totalRequired, minDownpaymentPercent);
    return value < minimum
      ? `The downpayment must be at least ${peso(minimum)} (${pct(minDownpaymentPercent)}% of the final total ${peso(totalRequired)}).`
      : '';
  }
  if (base == null) {
    return hasEarlierEntries ? '' : 'Record the downpayment first (or settle the whole balance as a Full Payment).';
  }
  const minimum = currentMinimum(base, remaining, installmentPercent);
  if (value >= minimum) return '';
  const why = minimum < minInstallment(base, installmentPercent)
    ? 'the remaining balance'
    : `${pct(installmentPercent)}% of the ${peso(base)} downpayment`;
  return `An installment must be at least ${peso(minimum)} (${why}).`;
}
