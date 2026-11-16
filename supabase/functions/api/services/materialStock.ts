// App\Support\MaterialStock and QuantityFormat: one stock rule for every Branches screen.
import type { Db, Row } from '../lib/db.ts';

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

// ---- Objective 2: status tracking, last counts and count units ----

/** A branch with no physical count in this many days reads as stale ("on-hand figures may be higher than actual"). */
export const STALE_COUNT_DAYS = 3;

/** Units counted in whole pieces: their low / critical levels must be whole numbers. */
export const COUNT_UNITS = new Set(['pc', 'pcs', 'piece', 'pieces', 'pack', 'packs', 'box', 'boxes', 'bottle', 'bottles', 'can', 'cans', 'sachet', 'sachets', 'roll', 'rolls', 'set', 'sets', 'unit', 'units', 'tray', 'trays', 'bag', 'bags']);
export const isCountUnit = (unit: unknown) => COUNT_UNITS.has(String(unit ?? '').trim().toLowerCase());

/**
 * Recomputes the stock status of the given materials with evaluate() and stores it. When it differs
 * from the stored one, stock_status_changed_at = now(); a material's FIRST status (null before) is
 * stored without a timestamp, so it never reads as a new alert. Call inside the same transaction as
 * the balance or level change.
 */
export async function syncStockStatus(db: Db, materialIds: number[]): Promise<void> {
  const ids = [...new Set(materialIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return;
  const rows = await db.query(
    `select m.id, m.unit, m.low_level, m.critical_level, m.stock_status,
       (select to_jsonb(b) from profittrack_material_balances b where b.material_id = m.id limit 1) as balance
     from profittrack_materials m where m.id = any($1::bigint[])`, [`{${ids.join(',')}}`],
  );
  for (const m of rows) {
    const next = evaluate(m).status;
    if (m.stock_status === next) continue;
    if (m.stock_status === null || m.stock_status === undefined) {
      await db.query(`update profittrack_materials set stock_status = $2 where id = $1`, [m.id, next]);
    } else {
      await db.query(`update profittrack_materials set stock_status = $2, stock_status_changed_at = now() where id = $1`, [m.id, next]);
    }
  }
}

/**
 * Last REAL physical count per material: profittrack_counts rows (written by every single and batch
 * count) joined to their operation for the time. Bare physical_count movements without a count row
 * (e.g. seeded usage history) never count as a physical count.
 */
export async function lastCountsByMaterial(db: Db, locationIds: number[]): Promise<Map<number, string>> {
  if (!locationIds.length) return new Map();
  const rows = await db.query(
    `select c.material_id, max(o.occurred_at) as last_at from profittrack_counts c join profittrack_operations o on o.id = c.operation_id
     where c.location_id = any($1::bigint[]) group by c.material_id`, [`{${locationIds.join(',')}}`],
  );
  return new Map(rows.map((r) => [Number(r.material_id), new Date(r.last_at).toISOString()]));
}

/** Last real physical count per branch (same source as lastCountsByMaterial). */
export async function lastCountsByLocation(db: Db, locationIds: number[]): Promise<Map<number, string>> {
  if (!locationIds.length) return new Map();
  const rows = await db.query(
    `select c.location_id, max(o.occurred_at) as last_at from profittrack_counts c join profittrack_operations o on o.id = c.operation_id
     where c.location_id = any($1::bigint[]) group by c.location_id`, [`{${locationIds.join(',')}}`],
  );
  return new Map(rows.map((r) => [Number(r.location_id), new Date(r.last_at).toISOString()]));
}

/** Stale: the branch has active materials and no real count, or its last count is older than STALE_COUNT_DAYS. */
export function isStale(lastCountAt: string | null, activeMaterials: number, now = Date.now()): boolean {
  if (activeMaterials <= 0) return false;
  if (!lastCountAt) return true;
  return now - new Date(lastCountAt).getTime() > STALE_COUNT_DAYS * 86_400_000;
}
