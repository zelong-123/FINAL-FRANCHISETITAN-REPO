// The database connection every data script uses: the API's own adapter (postgresDb), so values are
// serialized exactly like the API does. In particular JSON that is already stringified is stored as
// an object, not encoded a second time as a JSON string.
import type { Db } from '../../functions/api/lib/db.ts';

export type ScriptDb = Db & { close(): Promise<void> };

/** Reads SUPABASE_DB_URL from .env (never printed). */
export async function envDbUrl(): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is missing from .env');
  return env.SUPABASE_DB_URL;
}

export async function readEnv(): Promise<Record<string, string>> {
  const { readFileSync } = await import('node:fs');
  return Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
}

export async function openScriptDb(url?: string, options: { ssl?: false | 'require' } = {}): Promise<ScriptDb> {
  const [{ default: postgres }, { postgresDb }] = await Promise.all([import('postgres'), import('../../functions/api/lib/db.ts')]);
  return postgresDb(postgres, url ?? (await envDbUrl()), { max: 1, ssl: options.ssl ?? 'require' });
}

/** Runs fn inside a READ ONLY transaction (dry-runs). */
export function readOnly<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.tx(async (tx) => {
    await tx.query('set transaction read only');
    return fn(tx);
  });
}
