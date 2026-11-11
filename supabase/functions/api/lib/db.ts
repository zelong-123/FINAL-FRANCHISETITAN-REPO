// The one database interface the API uses. Parameters are always bound ($1, $2, ...).
export type Row = Record<string, any>;

export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn atomically. Use the db it receives, not the outer one. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export async function first<T = Row>(db: Db, text: string, params?: unknown[]): Promise<T | null> {
  const rows = await db.query<T>(text, params);
  return rows[0] ?? null;
}

const jsonText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Production adapter over postgres.js. Decoding matches what the frontend got from
 * Laravel: ids and counts are numbers, decimals stay exact strings, dates stay YYYY-MM-DD.
 * prepare:false because Supabase's pooler runs in transaction mode.
 * ssl:false because postgres.js's TLS upgrade throws ERR_NOT_IMPLEMENTED
 * (LibuvStreamWrap.prototype.useUserBuffer) in the Edge runtime. Same as the live
 * function (v24), with postgres@3.4.4 (deno.json).
 */
export function postgresDb(postgres: any, url: string, options: { max?: number } = {}): Db & { close(): Promise<void> } {
  const sql = postgres(url, {
    prepare: false,
    ssl: false,
    max: options.max ?? 4,
    types: {
      bigint: { to: 20, from: [20], serialize: (v: unknown) => String(v), parse: (v: string) => Number(v) },
      date: { to: 1082, from: [1082], serialize: (v: unknown) => String(v), parse: (v: string) => v },
      // Routes send JSON already stringified; the default serializer would encode it twice,
      // storing a JSON string instead of an object.
      json: { to: 114, from: [114], serialize: jsonText, parse: JSON.parse },
      jsonb: { to: 3802, from: [3802], serialize: jsonText, parse: JSON.parse },
    },
  });
  const wrap = (runner: any): Db => ({
    query: (text, params = []) => runner.unsafe(text, params as never[]),
    tx: (fn) => fn(wrap(runner)),
  });
  return {
    query: (text, params = []) => sql.unsafe(text, params as never[]),
    tx: (fn) => sql.begin((t: any) => fn(wrap(t))),
    close: () => sql.end({ timeout: 2 }),
  };
}
