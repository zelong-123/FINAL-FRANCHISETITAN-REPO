// Stands in for Supabase Auth in tests and the local dev server. Sessions are real rows in
// the stubbed auth.sessions table, so the API's session check runs for real. Tokens are
// JWT-shaped (unsigned) because supabase-js decodes them; this must never run in production.
import { randomUUID } from 'node:crypto';
import type { AuthProvider, AuthSession } from '../../supabase/functions/api/lib/env.ts';
import type { Db } from '../../supabase/functions/api/lib/db.ts';

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function makeToken(uid: string, email: string, sessionId: string, ttl = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return { token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: uid, email, session_id: sessionId, exp, aud: 'authenticated', role: 'authenticated' })}.${encode({ unsigned: true })}`, exp };
}

export function decodeToken(token: string): any | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
}

export function fakeAuth(db: Db): AuthProvider & { addUser(email: string, password: string): Promise<string> } {
  const accounts = new Map<string, { email: string; password: string }>();
  const byEmail = (email: string) => [...accounts].find(([, a]) => a.email === email);

  const newSession = async (uid: string, email: string): Promise<AuthSession> => {
    const sessionId = randomUUID();
    await db.query(`insert into auth.sessions (id, user_id) values ($1::uuid, $2::uuid)`, [sessionId, uid]);
    const { token, exp } = makeToken(uid, email, sessionId);
    return { access_token: token, refresh_token: `refresh-${sessionId}`, expires_at: exp, expires_in: 3600, auth_user_id: uid };
  };

  const provider = {
    async addUser(email: string, password: string) {
      const uid = randomUUID();
      await db.query(`insert into auth.users (id, email) values ($1::uuid, $2)`, [uid, email]);
      accounts.set(uid, { email, password });
      return uid;
    },
    async signIn(email: string, password: string) {
      const found = byEmail(email);
      return found && found[1].password === password ? newSession(found[0], email) : null;
    },
    async verify(token: string) {
      const claims = decodeToken(token);
      return claims ? { authUserId: claims.sub, sessionId: claims.session_id } : null;
    },
    createUser: (email: string, password: string) => provider.addUser(email, password),
    async updateUser(uid: string, changes: { email?: string; password?: string }) {
      const account = accounts.get(uid);
      if (account) Object.assign(account, changes);
    },
    async deleteUser(uid: string) {
      accounts.delete(uid);
      await db.query(`delete from auth.users where id = $1::uuid`, [uid]);
    },
    async revoke(token: string) {
      await db.query(`delete from auth.sessions where id = $1::uuid`, [decodeToken(token)?.session_id]);
    },
    async revokeOthers(token: string) {
      const claims = decodeToken(token);
      await db.query(`delete from auth.sessions where user_id = $1::uuid and id <> $2::uuid`, [claims?.sub, claims?.session_id]);
    },
    async revokeAll(uid: string) {
      await db.query(`delete from auth.sessions where user_id = $1::uuid`, [uid]);
    },
  };
  return provider;
}

/** Links every seeded app user to a sign-in with the given password. */
export async function linkSeedUsers(db: Db, auth: ReturnType<typeof fakeAuth>, password: string) {
  for (const user of await db.query(`select id, email from users where auth_user_id is null`)) {
    const uid = await auth.addUser(user.email, password);
    await db.query(`update users set auth_user_id = $1::uuid where id = $2`, [uid, user.id]);
  }
}
