/*
 * Branch stock display rules shared by the franchisee Raw Materials panel and the Branches page.
 * The status rule mirrors services/materialStock.ts evaluate() — the API stays the source of truth;
 * this copy only previews "Status after" while the franchisee types a count.
 */

export const STOCK_STATUS_LABELS = { ok: 'Normal', low: 'Low stock', critical: 'Critical', out: 'No stock' };
/** Worst first: No stock, Critical, Low stock, Normal. */
export const STOCK_ORDER = { out: 0, critical: 1, low: 2, ok: 3 };
/** Same text colours as the Branch Inventory table. */
export const STOCK_TEXT_CLASS = 'font-[600] whitespace-nowrap [&.is-ok]:text-success-text [&.is-low]:text-[color:var(--warning-text)] [&.is-critical]:text-danger-text [&.is-out]:text-danger-text';

export function stockStatusOf(onHand, low, critical) {
  const value = Number(onHand);
  if (!(value > 0)) return 'out';
  if (value <= Number(critical)) return 'critical';
  if (value <= Number(low)) return 'low';
  return 'ok';
}

/** Worst status first, then by name. */
export function sortWorstFirst(rows, statusOf = (row) => row.status, nameOf = (row) => row.name) {
  return [...rows].sort((a, b) => (STOCK_ORDER[statusOf(a)] ?? 9) - (STOCK_ORDER[statusOf(b)] ?? 9)
    || String(nameOf(a) || '').localeCompare(String(nameOf(b) || '')));
}

const manilaDay = (date) => new Date(new Date(date).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const manilaTime = (date) => new Date(date).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });

/** "Today, 9:10 PM", "Yesterday", "3 days ago", or "Never" (Asia/Manila calendar days). */
export function lastCountLabel(value, now = new Date()) {
  if (!value) return 'Never';
  const days = Math.round((Date.parse(`${manilaDay(now)}T00:00:00Z`) - Date.parse(`${manilaDay(value)}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return `Today, ${manilaTime(value)}`;
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/** Relative time for "when it changed": "12 min ago", "3 h ago", "Yesterday", "2 days ago". */
export function changedAgo(value, now = new Date()) {
  if (!value) return '—';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24 && manilaDay(value) === manilaDay(now)) return `${hours} h ago`;
  return lastCountLabel(value, now).replace(/^Today, .*/, `${hours} h ago`);
}

/** Variance text for a count row: "+1.2 L", "-0.5 kg", "No change", or "—" when blank. */
export function varianceText(actual, system, unit, digits = 3) {
  if (actual === '' || actual === null || actual === undefined) return { text: '—', tone: 'none' };
  const delta = Math.round((Number(actual) - Number(system)) * 1000) / 1000;
  if (delta === 0) return { text: 'No change', tone: 'zero' };
  const shown = Number(Math.abs(delta).toFixed(digits)).toString();
  return { text: `${delta > 0 ? '+' : '-'}${shown} ${unit}`.trim(), tone: delta > 0 ? 'up' : 'down' };
}

/** A count input in the material's own unit, as integer milli-units (like the receive form). */
export const toMilli = (value) => Math.round(Number(value) * 1000);
