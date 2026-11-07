import type { Context } from 'hono';
import type { AppEnv } from './env.ts';
import type { Db, Row } from './db.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ValidationError extends Error {
  errors: Record<string, string[]>;
  constructor(errors: Record<string, string[]>) {
    super('The submitted data is invalid.');
    this.errors = errors;
  }
}

/** An error whose whole JSON body is decided by the thrower. */
export class RawError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message ?? 'Request failed.'));
    this.status = status;
    this.body = body;
  }
}

// Annotated on the name so TypeScript treats a call as the end of the branch.
export const abort: (status: number, message: string) => never = (status, message) => {
  throw new HttpError(status, message);
};

export const fail: (field: string, message: string) => never = (field, message) => {
  throw new ValidationError({ [field]: [message] });
};

/** Laravel's ApiController::success shape. */
export function ok(c: Context<AppEnv>, data: unknown = null, message = 'OK', status = 200) {
  return c.json({ message, data }, status as never);
}

export function boolParam(value: unknown): boolean {
  return value === true || value === 1 || ['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase());
}

export function intParam(value: unknown, fallback = 0): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(n) ? fallback : n;
}

export function routeId(c: Context<AppEnv>, name: string): number {
  const id = Number(c.req.param(name));
  if (!Number.isSafeInteger(id) || id < 1) abort(404, 'Record not found.');
  return id;
}

export function perPage(c: Context<AppEnv>, fallback = 20, maximum = 100): number {
  return Math.max(1, Math.min(maximum, intParam(c.req.query('per_page'), fallback)));
}

/** Builds a WHERE clause: `?` in each fragment is bound to the next value. */
export class Filter {
  clauses: string[] = [];
  params: unknown[] = [];
  add(sql: string, ...values: unknown[]): this {
    let text = sql;
    for (const value of values) {
      this.params.push(value);
      text = text.replace('?', `$${this.params.length}`);
    }
    this.clauses.push(text);
    return this;
  }
  get where(): string {
    return this.clauses.length ? `where ${this.clauses.join(' and ')}` : '';
  }
}

interface PageQuery {
  columns: string;
  from: string;
  where?: string[];
  params?: unknown[];
  /** `?` placeholders in columns or orderBy are bound from these, after the WHERE params. */
  columnParams?: unknown[];
  orderBy?: string;
  orderParams?: unknown[];
  perPage: number;
  map?: (row: Row) => Row;
}

/** Laravel's paginated() JSON shape, including meta and links. */
export async function paginate(c: Context<AppEnv>, db: Db, q: PageQuery) {
  const where = q.where?.length ? `where ${q.where.join(' and ')}` : '';
  const params = q.params ?? [];
  const [{ total }] = await db.query<{ total: number }>(`select count(*)::int as total from ${q.from} ${where}`, params);
  const lastPage = Math.max(1, Math.ceil(total / q.perPage));
  const page = Math.max(1, intParam(c.req.query('page'), 1));
  const all = [...params];
  const bind = (text: string | undefined, values: unknown[] = []) => {
    let out = text ?? '';
    for (const value of values) {
      all.push(value);
      out = out.replace('?', `$${all.length}`);
    }
    return out;
  };
  const columns = bind(q.columns, q.columnParams);
  const orderBy = bind(q.orderBy, q.orderParams);
  const rows = await db.query(
    `select ${columns} from ${q.from} ${where} ${orderBy ? `order by ${orderBy}` : ''} limit ${q.perPage} offset ${(page - 1) * q.perPage}`,
    all,
  );
  const url = (n: number) => {
    const u = new URL(c.req.url);
    u.searchParams.set('page', String(n));
    return u.toString();
  };
  return c.json({
    data: q.map ? rows.map(q.map) : rows,
    meta: { current_page: page, last_page: lastPage, per_page: q.perPage, total },
    links: {
      first: url(1),
      last: url(lastPage),
      prev: page > 1 ? url(page - 1) : null,
      next: page < lastPage ? url(page + 1) : null,
    },
  });
}

/** Inserts or updates only the named columns; identifiers come from code, never from input. */
export async function insertRow(db: Db, table: string, fields: Row): Promise<Row> {
  const keys = Object.keys(fields);
  const [row] = await db.query(
    `insert into ${table} (${keys.map((k) => `"${k}"`).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    keys.map((k) => encode(fields[k])),
  );
  return row;
}

export async function updateRow(db: Db, table: string, id: number, fields: Row): Promise<Row | null> {
  const keys = Object.keys(fields);
  if (!keys.length) return (await db.query(`select * from ${table} where id = $1`, [id]))[0] ?? null;
  const [row] = await db.query(
    `update ${table} set ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} where id = $${keys.length + 1} returning *`,
    [...keys.map((k) => encode(fields[k])), id],
  );
  return row ?? null;
}

function encode(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
}

export function pick<T extends Row>(row: T, keys: string[]): Row {
  return Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));
}

/** Today's date in the business timezone (config/app.php: Asia/Manila). */
export function manilaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
}
