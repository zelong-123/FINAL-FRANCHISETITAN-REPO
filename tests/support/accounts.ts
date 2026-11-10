import assert from 'node:assert/strict';

type Call = (method: string, path: string, opts?: { token?: string; body?: unknown; form?: FormData }) => Promise<{ status: number; json: any }>;

export const NEW_PASSWORD = 'Passw0rd!';

/**
 * First sign-in of an account created with a temporary password: signs in with it, sets
 * NEW_PASSWORD and returns a working token.
 */
export async function firstSignIn(call: Call, email: string, temporary: string, portal: 'staff' | 'branch' = 'staff') {
  const session = await call('POST', '/auth/login', { body: { email, password: temporary, portal } });
  assert.equal(session.status, 200, `first sign-in: ${JSON.stringify(session.json)}`);
  const token = session.json.data.token as string;
  const changed = await call('POST', '/auth/first-password', { token, body: { password: NEW_PASSWORD, password_confirmation: NEW_PASSWORD } });
  assert.equal(changed.status, 200, `first password: ${JSON.stringify(changed.json)}`);
  return token;
}

/** Admin creates a staff account; the new user completes the first sign-in. Returns its token. */
export async function createStaff(call: Call, adminToken: string, body: { full_name: string; email: string; role: string; phone?: string }) {
  const created = await call('POST', '/users', { token: adminToken, body });
  assert.equal(created.status, 201, `create staff: ${JSON.stringify(created.json)}`);
  return firstSignIn(call, body.email, created.json.data.credentials.temporary_password);
}
