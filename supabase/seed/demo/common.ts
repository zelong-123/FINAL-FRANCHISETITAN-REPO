// Defense demo data: shared helpers. Every date is Manila wall-clock time; the demo is built for
// the defense day, Wednesday 25 November 2026 (business hours 9:00-17:00, Monday to Friday).
import type { Db, Row } from '../../functions/api/lib/db.ts';

export type { Db, Row };
export const DEFENSE_DAY = '2026-11-25';
/** The last day with recorded branch activity (the day before the defense). */
export const LAST_DAY = '2026-11-24';

const MS_DAY = 86_400_000;
export const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}+08:00`);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_DAY);
/** 0 = Sunday ... 6 = Saturday. */
export const dow = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const isWeekday = (day: string) => dow(day) >= 1 && dow(day) <= 5;
export function addWorkingDays(day: string, n: number) {
  let d = day;
  let left = n;
  while (left > 0) { d = addDays(d, 1); if (isWeekday(d)) left -= 1; }
  return d;
}
export const nextWeekday = (day: string) => { let d = day; while (!isWeekday(d)) d = addDays(d, 1); return d; };
export const prevWeekday = (day: string) => { let d = day; while (!isWeekday(d)) d = addDays(d, -1); return d; };
export const plusMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const manilaDay = (d: Date) => new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

/** Deterministic randomness, so a dry run and the real run build the same data. */
export function rng(seed: string) {
  let h = 0x811c9dc5;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)],
    chance: (p: number) => next() < p,
    /** A clock time between two hh:mm values, on the minute. */
    time: (from: string, to: string) => {
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const m = fh * 60 + fm + Math.floor(next() * (th * 60 + tm - fh * 60 - fm));
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    },
  };
}

/** Reserves ids from the table's identity sequence, so rows can reference each other before insert. */
export async function reserveIds(db: Db, table: string, n: number): Promise<number[]> {
  if (n <= 0) return [];
  const rows = await db.query(`select nextval(pg_get_serial_sequence('public."${table}"', 'id'))::bigint as id from generate_series(1, $1::int)`, [n]);
  return rows.map((r) => Number(r.id));
}

const encode = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

/** Bulk insert (rows carry their reserved id). Rows are grouped by their columns, so a column a row
 *  leaves out keeps its database default. */
export async function insertMany(db: Db, table: string, rows: Row[], chunk = 1500) {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = Object.keys(r).filter((k) => r[k] !== undefined).sort().join(',');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  for (const [key, list] of groups) {
    const cols = key.split(',');
    const names = cols.map((c) => `"${c}"`).join(', ');
    for (let i = 0; i < list.length; i += chunk) {
      const part = list.slice(i, i + chunk).map((r) => Object.fromEntries(cols.map((c) => [c, encode(r[c])])));
      try {
        await db.query(`insert into public."${table}" (${names}) select ${names} from json_populate_recordset(null::public."${table}", $1::json)`, [JSON.stringify(part)]);
      } catch (error) {
        const e = error as { message?: string; detail?: string };
        throw new Error(`Insert into ${table} failed: ${e.message ?? error}${e.detail ? ` (${String(e.detail).slice(0, 300)})` : ''}`);
      }
    }
  }
}

/** Collects rows per table in dependency order, then writes them all. */
export class Batch {
  tables = new Map<string, Row[]>();
  add(table: string, row: Row) { if (!this.tables.has(table)) this.tables.set(table, []); this.tables.get(table)!.push(row); return row; }
  count(table: string) { return this.tables.get(table)?.length ?? 0; }
  async write(db: Db, order: string[], log: (s: string) => void) {
    for (const table of [...order, ...[...this.tables.keys()].filter((t) => !order.includes(t))]) {
      const rows = this.tables.get(table);
      if (!rows?.length) continue;
      await insertMany(db, table, rows);
      log(`${table}: ${rows.length}`);
    }
  }
}

/** Id allocator: grabs ids in blocks from each table's sequence. */
export class Ids {
  private pools = new Map<string, number[]>();
  private db: Db;
  constructor(db: Db) { this.db = db; }
  async next(table: string): Promise<number> {
    let pool = this.pools.get(table);
    if (!pool || !pool.length) { pool = await reserveIds(this.db, table, 500); this.pools.set(table, pool); }
    return pool.shift()!;
  }
}

export const round = (n: number, p = 2) => Math.round((n + Number.EPSILON) * 10 ** p) / 10 ** p;
export const MODELS = {
  applicant: 'App\\Models\\Applicant', requirement: 'App\\Models\\ApplicantRequirement', activity: 'App\\Models\\ActivitySchedule',
  payment: 'App\\Models\\Payment', supply: 'App\\Models\\SupplyRequest', inquiry: 'App\\Models\\FranchiseInquiry', user: 'App\\Models\\User',
};
