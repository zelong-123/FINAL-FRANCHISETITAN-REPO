// App\Support\MaterialStock and QuantityFormat: one stock rule for every Branches screen.
import type { Row } from '../lib/db.ts';

const SEVERITY: Record<string, number> = { ok: 0, low: 1, critical: 2, out: 3 };
export const STOCK_LABELS: Record<string, string> = { ok: 'Normal', low: 'Low stock', critical: 'Critical', out: 'No stock', none: 'No inventory yet' };

export function defaultLevels(unit: unknown) {
  const key = String(unit ?? '').trim().toLowerCase();
  if (key === 'g' || key === 'ml') return { low: 5000, critical: 1000 };
  if (key === 'kg' || key === 'l') return { low: 5, critical: 1 };
  return { low: 50, critical: 10 };
}

function status(onHand: number, low: number, critical: number): string {
  if (onHand <= 0) return 'out';
  if (onHand <= critical) return 'critical';
  if (onHand <= low) return 'low';
  return 'ok';
}

/** `material.balance` is the row from profittrack_material_balances. */
export function evaluate(material: Row) {
  const on_hand = Math.round(Number(material.balance?.quantity_milli ?? 0)) / 1000;
  const defaults = defaultLevels(material.unit);
  const low_level = material.low_level !== null && material.low_level !== undefined ? Number(material.low_level) : defaults.low;
  const critical_level = material.critical_level !== null && material.critical_level !== undefined ? Number(material.critical_level) : defaults.critical;
  return { on_hand, low_level, critical_level, status: status(on_hand, low_level, critical_level) };
}

/** 'none' with no materials, 'out' with nothing on hand, otherwise the worst material. */
export function branchStatus(statuses: string[]): string {
  if (!statuses.length) return 'none';
  if (statuses.every((s) => s === 'out')) return 'out';
  let worst = 'ok';
  for (const raw of statuses) {
    const s = raw === 'out' ? 'critical' : raw;
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return worst;
}

const number = (value: number) => {
  const text = (Math.round((value + Number.EPSILON) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return text;
};

/** Large grams and millilitres read as kg and L; a reference value keeps one scale per material. */
export function formatQuantity(value: number, unit: unknown, reference: number | null = null): string {
  const label = String(unit ?? '');
  const key = label.toLowerCase();
  const scale = Math.abs(reference ?? value) >= 1000 && (key === 'g' || key === 'ml');
  return `${number(scale ? value / 1000 : value)} ${scale ? (key === 'g' ? 'kg' : 'L') : label}`.trim();
}

export function attentionText(name: string, unit: unknown, row: ReturnType<typeof evaluate>): string {
  const reference = Math.max(row.on_hand, row.low_level, row.critical_level);
  const format = (v: number) => formatQuantity(v, unit, reference);
  if (row.status === 'out') return `${name} — no stock (critical at ${format(row.critical_level)})`;
  if (row.status === 'critical') return `${name} — ${format(row.on_hand)} (critical at ${format(row.critical_level)})`;
  return `${name} — ${format(row.on_hand)} (low at ${format(row.low_level)})`;
}
