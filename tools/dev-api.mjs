// Runs the real API on real Postgres (PGlite, in memory) with a stand-in for Supabase Auth, on
// Supabase's local port and URL layout, so the frontend runs unchanged with no project or Docker.
// Data resets on restart. Development only: its tokens are unsigned.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { createApp } from '../supabase/functions/api/app.ts';
import { createTestPg, pgliteDb } from '../tests/support/testDb.ts';
import { decodeToken, fakeAuth, linkSeedUsers, makeToken } from '../tests/support/fakeAuth.ts';
import { memoryFiles } from '../tests/support/harness.ts';

const PORT = 54321;
const password = process.env.DEV_SEED_PASSWORD || 'Password123!';

const pg = await createTestPg();
const db = pgliteDb(pg);
const auth = fakeAuth(db);
await linkSeedUsers(db, auth, password);
const api = createApp({ db, auth, files: memoryFiles(), costingEnabled: false });

// npm run dev:api:demo: the supply workflow demo (local only; it refuses anything but this
// in-memory PGlite database). See supabase/seed/supplyDemo.ts and docs/defense-demo.md.
if (process.argv.includes('--supply-demo')) {
  const { seedSupplyDemo } = await import('../supabase/seed/supplyDemo.ts');
  const made = await seedSupplyDemo(pg, api, { local: true, password });
  console.log('Supply demo ready:', made);
}

const root = new Hono();
root.use('/auth/*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'apikey', 'x-client-info', 'x-supabase-api-version'] }));

// The few GoTrue endpoints supabase-js calls.
root.get('/auth/v1/user', (c) => {
  const claims = decodeToken((c.req.header('authorization') ?? '').slice(7));
  if (!claims) return c.json({ message: 'invalid token' }, 401);
  return c.json({ id: claims.sub, email: claims.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
});
root.post('/auth/v1/token', async (c) => {
  const body = await c.req.json();
  const sessionId = String(body.refresh_token ?? '').replace(/^refresh-/, '');
  const [session] = await db.query(`select s.user_id, u.email from auth.sessions s join auth.users u on u.id = s.user_id where s.id::text = $1`, [sessionId]);
  if (!session) return c.json({ error: 'invalid_grant', error_description: 'Invalid Refresh Token' }, 400);
  const { token, exp } = makeToken(session.user_id, session.email, sessionId);
  return c.json({
    access_token: token, refresh_token: `refresh-${sessionId}`, token_type: 'bearer', expires_in: 3600, expires_at: exp,
    user: { id: session.user_id, email: session.email, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  });
});
root.post('/auth/v1/logout', () => new Response(null, { status: 204 }));

root.all('/functions/v1/api/*', (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace('/functions/v1/api', '/api');
  return api.fetch(new Request(url, c.req.raw));
});

serve({ fetch: root.fetch, hostname: '127.0.0.1', port: PORT }, () => {
  console.log(`Local API on http://127.0.0.1:${PORT} (in-memory Postgres; session ${randomUUID().slice(0, 8)})`);
});
