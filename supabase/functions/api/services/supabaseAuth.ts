// Production AuthProvider over Supabase Auth. Sign-in happens here rather than in the
// browser so the portal, suspension and branch-link rules all run before a user gets in.
import { createClient } from '@supabase/supabase-js';
import type { AuthProvider } from '../lib/env.ts';
import type { Db } from '../lib/db.ts';

export function supabaseAuth(url: string, anonKey: string, serviceKey: string, db: Db): AuthProvider {
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const admin = createClient(url, serviceKey, options);
  // A fresh client per sign-in: supabase-js keeps the signed-in user on the client object.
  const publicClient = () => createClient(url, anonKey, options);

  return {
    async signIn(email, password) {
      const { data, error } = await publicClient().auth.signInWithPassword({ email, password });
      if (error || !data.session) return null;
      const s = data.session;
      return {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at ?? 0,
        expires_in: s.expires_in,
        auth_user_id: s.user.id,
      };
    },
    async verify(token) {
      // getClaims verifies locally against the project's JWKS, so a 3-second poll does not
      // turn into a network call to Auth on every request.
      const { data, error } = await admin.auth.getClaims(token);
      if (error || !data?.claims?.sub) return null;
      return { authUserId: data.claims.sub, sessionId: (data.claims.session_id as string) ?? null };
    },
    async createUser(email, password) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`Could not create the sign-in: ${error?.message}`);
      return data.user.id;
    },
    async updateUser(authUserId, changes) {
      const { error } = await admin.auth.admin.updateUserById(authUserId, {
        ...changes,
        ...(changes.email ? { email_confirm: true } : {}),
      });
      if (error) throw new Error(`Could not update the sign-in: ${error.message}`);
    },
    async deleteUser(authUserId) {
      await admin.auth.admin.deleteUser(authUserId);
    },
    async revoke(token) {
      await admin.auth.admin.signOut(token, 'local');
    },
    async revokeOthers(token) {
      await admin.auth.admin.signOut(token, 'others');
    },
    async revokeAll(authUserId) {
      await db.query(`delete from auth.sessions where user_id = $1::uuid`, [authUserId]);
    },
  };
}
