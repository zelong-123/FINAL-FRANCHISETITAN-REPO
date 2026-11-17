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
 * The invited person's whole /reset-password flow: opens the email link (a Supabase session), sets
 * NEW_PASSWORD (updateUser, through the fake auth as the real page does), accepts (the account
 * becomes active) and signs in. Returns a working token.
 */
export async function signInInvited(call: Call, email: string, portal: 'staff' | 'branch' = 'staff') {
  assert.ok(fakeAuth, 'setup() registers the fake auth before invited users can sign in');
  const linkToken = await fakeAuth.openInviteLink(email.toLowerCase());
  await fakeAuth.acceptInvite(email.toLowerCase(), NEW_PASSWORD);
  const accepted = await call('POST', '/auth/invite/accept', { token: linkToken });
  assert.equal(accepted.status, 200, `accept invitation: ${JSON.stringify(accepted.json)}`);
  const session = await call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal } });
  assert.equal(session.status, 200, `invited sign-in: ${JSON.stringify(session.json)}`);
  assert.equal(session.json.data.user.must_change_password, false, 'an invited account chose its own password');
  return session.json.data.token as string;
}

/** Admin invites a staff account; the new user accepts it. Returns its token. */
export async function createStaff(call: Call, adminToken: string, body: { full_name: string; email: string; role: string; phone?: string }) {
  const created = await call('POST', '/users', { token: adminToken, body: { ...body, ...(body.role === 'admin' ? { confirm_admin: true } : {}) } });
  assert.equal(created.status, 201, `create staff: ${JSON.stringify(created.json)}`);
  assert.equal(created.json.data.credentials.method, 'email_link');
  return signInInvited(call, body.email);
}
