/**
 * One readable, unit-aware quantity format for the Branches screens (mirrors
 * backend App\Support\QuantityFormat): thousands separator, up to 2 decimals,
 * and large grams / millilitres shown as kg / L. A reference value (e.g. the
 * material's low level) picks the scale so one material always reads in one
 * unit: "0.8 kg (critical at 1 kg)". Pieces and other units stay as they are.
 */
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

export function quantityScale(unit, reference) {
  const key = String(unit || '').toLowerCase();
  if (Math.abs(Number(reference) || 0) >= 1000 && key === 'g') return { divisor: 1000, unit: 'kg' };
  if (Math.abs(Number(reference) || 0) >= 1000 && key === 'ml') return { divisor: 1000, unit: 'L' };
  return { divisor: 1, unit: unit || '' };
}

export function formatQuantity(value, unit, reference) {
  const amount = Number(value) || 0;
  const scale = quantityScale(unit, reference ?? amount);
  const rounded = Math.round((amount / scale.divisor) * 100) / 100;
  return `${NUMBER.format(rounded)} ${scale.unit}`.trim();
}

/** Material / branch stock status labels (one rule: No stock → Critical → Low → Normal). */
export const STOCK_STATUS_LABELS = {
  ok: 'Normal',
  low: 'Low stock',
  critical: 'Critical',
  out: 'No stock',
  none: 'No inventory yet',
};

/**
 * The auto-calculated default levels per unit — the same table as
 * App\Support\MaterialStock::defaultLevels on the server (used by
 * "Reset to default"; the server is the one that applies it).
 */
export function defaultLevelsFor(unit) {
  switch (String(unit || '').trim().toLowerCase()) {
    case 'g':
    case 'ml':
      return { low: 5000, critical: 1000 };
    case 'kg':
    case 'l':
      return { low: 5, critical: 1 };
    default:
      return { low: 50, critical: 10 };
  }
}
