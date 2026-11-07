// Shared setup for API tests: real Postgres, stand-in Auth, in-memory files.
import { createApp } from '../../supabase/functions/api/app.ts';
import type { FileStore } from '../../supabase/functions/api/lib/env.ts';
import { createTestPg, pgliteDb } from './testDb.ts';
import { fakeAuth, linkSeedUsers } from './fakeAuth.ts';

export const PASSWORD = 'test-only-password';
export const ADMIN = 'admin@franchisetitan.local';
export const SALES = 'sales@franchisetitan.local';
export const MARKETING = 'marketing@franchisetitan.local';
export const LOGISTICS = 'logistics@franchisetitan.local';

export function memoryFiles(): FileStore & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(disk, path, bytes) { store.set(`${disk}/${path}`, bytes); },
    async get(disk, path) { return store.get(`${disk}/${path}`) ?? null; },
    async remove(disk, paths) { for (const p of paths) store.delete(`${disk}/${p}`); },
    publicUrl: (path) => `http://files.test/public/${path}`,
  };
}

/**
 * TEST_DB_ADAPTER=postgres runs a suite through the production postgres.js driver on one
 * connection: a route that reaches past its open transaction would hang instead of passing.
 */
async function productionAdapter(pg: Awaited<ReturnType<typeof createTestPg>>) {
  const [{ default: postgres }, { PGLiteSocketServer }, { postgresDb }] = await Promise.all([
    import('postgres'), import('@electric-sql/pglite-socket'), import('../../supabase/functions/api/lib/db.ts'),
  ]);
  const port = 20000 + (process.pid % 20000);
  await new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' }).start();
  return postgresDb(postgres, `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`, { max: 1 });
}

export async function setup() {
  const pg = await createTestPg();
  const db = process.env.TEST_DB_ADAPTER === 'postgres' ? await productionAdapter(pg) : pgliteDb(pg);
  const auth = fakeAuth(db);
  await linkSeedUsers(db, auth, PASSWORD);
  const files = memoryFiles();
  // Costing stays off like production; a test flips deps.costingEnabled to see the cost fields.
  const deps = { db, auth, files, costingEnabled: false };
  const app = createApp(deps);
  let ip = 0;

  async function call(method: string, path: string, { token, body, form }: { token?: string; body?: unknown; form?: FormData } = {}) {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : form ? { body: form } : {}),
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, json: (type.includes('json') ? await res.json() : null) as any, res };
  }
  const login = async (email: string) => {
    ip += 1;
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${ip}` },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return ((await res.json()) as any).data.token as string;
  };
  return { pg, db, auth, app, files, call, login, deps };
}
