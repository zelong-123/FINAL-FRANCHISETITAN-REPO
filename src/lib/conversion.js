/**
 * Shared conversion-rate helpers for the Admin, Marketing and Sales dashboards.
 * The API computes the rate (App\Support\ConversionRate); these mirror the same
 * formula and guard the display so a bad payload can never show >100%, <0%,
 * NaN or Infinity.
 */

/** Clamp any percent-like value into [0, 100]; non-finite values become 0. */
export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, number));
}

/** converted ÷ total × 100, rounded to 2 decimals, 0 when total is 0. */
export function conversionRatePercent(converted, total) {
  const numerator = Number(converted);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round(clampPercent((numerator / denominator) * 100) * 100) / 100;
}

/** "66.67%", "100%", "0%" — at most 2 decimals, no trailing zeros. */
export function formatPercent(value) {
  const rounded = Math.round(clampPercent(value) * 100) / 100;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rounded)}%`;
}

/**
 * Rate for a KPI payload: prefer the numerator/denominator the API sends so the
 * card always agrees with its inputs; fall back to the API's own percent.
 */
export function kpiConversionRate(kpis) {
  if (!kpis) return 0;
  if (kpis.conversion_total !== undefined && kpis.conversion_converted !== undefined) {
    return conversionRatePercent(kpis.conversion_converted, kpis.conversion_total);
  }
  return clampPercent(kpis.conversion_rate_percent);
}
