// Real Postgres, in-process (PGlite), with just enough of Supabase's auth schema and
// roles stubbed for the migrations to apply exactly as they will on a hosted project.
import { PGlite, types } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Row } from '../../supabase/functions/api/lib/db.ts';

const SUPABASE_DIR = new URL('../../supabase/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const decodedDir = decodeURIComponent(SUPABASE_DIR);

const SUPABASE_STUB = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
  create table if not exists auth.sessions (id uuid primary key, user_id uuid references auth.users(id) on delete cascade);
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text, public boolean);
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`;

export function migrationFiles(): string[] {
  const dir = join(decodedDir, 'migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));
}

export async function createTestPg({ seed = true } = {}): Promise<PGlite> {
  const pg = new PGlite({
    parsers: {
      // Same decoding as the production adapter: see lib/db.ts.
      [types.INT8]: (v: string) => Number(v),
      [types.DATE]: (v: string) => v,
      [types.NUMERIC]: (v: string) => v,
    },
  });
  await pg.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) await pg.exec(readFileSync(file, 'utf8'));
  if (seed) await pg.exec(readFileSync(join(decodedDir, 'seed.sql'), 'utf8'));
  return pg;
}

export function pgliteDb(pg: PGlite): Db {
  // PGlite is a single connection, so queries inside a transaction must use its handle.
  const wrap = (runner: { query: PGlite['query'] }): Db => ({
    async query<T = Row>(text: string, params: unknown[] = []) {
      const result = await runner.query(text, params as never[]);
      return result.rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      return fn(wrap(runner));
    },
  });
  const root = wrap(pg);
  return {
    query: root.query,
    tx: <T,>(fn: (db: Db) => Promise<T>) => pg.transaction((t) => fn(wrap(t as never))) as Promise<T>,
  };
}
