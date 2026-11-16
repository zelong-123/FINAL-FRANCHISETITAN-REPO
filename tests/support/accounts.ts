import assert from 'node:assert/strict';
import type { FakeAuth } from './fakeAuth.ts';

type Call = (method: string, path: string, opts?: { token?: string; body?: unknown; form?: FormData }) => Promise<{ status: number; json: any }>;

export const NEW_PASSWORD = 'Passw0rd!';

// The fake auth of this test file (set by setup() in harness.ts). Each test file runs in its own
// process, so one registration per file is enough.
let fakeAuth: FakeAuth | null = null;
export function registerFakeAuth(auth: FakeAuth) { fakeAuth = auth; }

/**
 * First sign-in of an account created with a temporary password (Franchisee portal accounts):
 * signs in with it, sets NEW_PASSWORD and returns a working token.
 */
export async function firstSignIn(call: Call, email: string, temporary: string, portal: 'staff' | 'branch' = 'staff') {
  const session = await call('POST', '/auth/login', { body: { email, password: temporary, portal } });
  assert.equal(session.status, 200, `first sign-in: ${JSON.stringify(session.json)}`);
  const token = session.json.data.token as string;
  const changed = await call('POST', '/auth/first-password', { token, body: { password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD } });
  assert.equal(changed.status, 200, `first password: ${JSON.stringify(changed.json)}`);
  return token;
}

/**
 * An invited staff member opens the email link, sets NEW_PASSWORD (done here through the fake auth,
 * as the real Supabase page would) and signs in. Returns a working token.
 */
export async function signInInvited(call: Call, email: string, portal: 'staff' | 'branch' = 'staff') {
  assert.ok(fakeAuth, 'setup() registers the fake auth before invited users can sign in');
  await fakeAuth.acceptInvite(email.toLowerCase(), NEW_PASSWORD);
  const session = await call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal } });
  assert.equal(session.status, 200, `invited sign-in: ${JSON.stringify(session.json)}`);
  assert.equal(session.json.data.user.must_change_password, false, 'an invited account chose its own password');
  return session.json.data.token as string;
}

/** Admin creates a staff account (an invitation is emailed); the new user accepts it. Returns its token. */
export async function createStaff(call: Call, adminToken: string, body: { full_name: string; email: string; role: string; phone?: string }) {
  const created = await call('POST', '/users', { token: adminToken, body });
  assert.equal(created.status, 201, `create staff: ${JSON.stringify(created.json)}`);
  assert.equal(created.json.data.credentials.method, 'email_link');
  return signInInvited(call, body.email);
}
