// Older accounts from before invitations (created with a temporary password, never signed in) are moved
// to the invite states by a one-off data fix. From then on they behave like any invitation: Resend sends
// a fresh invite (or, if Supabase will not remove the old sign-in, a "Reset password" email that still
// accepts the invite on /reset-password), Cancel removes them, and accepting needs no second password change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, setup } from '../support/harness.ts';
import { NEW_PASSWORD, signInInvited } from '../support/accounts.ts';

const { pg, call, login, auth } = await setup();
const admin = await login(ADMIN);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const TEMPORARY = 'Temp#Pass123';

/** An account as the old "temporary password" flow left it, then moved to Invited as the data fix does. */
async function legacyInvited(email: string, createdAgo = '2 hours') {
  const authId = await auth.addUser(email, TEMPORARY);
  const [row] = await q(
    `insert into users (role_id, full_name, email, account_status, must_change_password, auth_user_id, created_at)
     values ((select id from roles where name = 'marketing'), 'Legacy Person', $1, 'active', true, $2::uuid, now() - $3::interval) returning id`,
    [email, authId, createdAgo],
  );
  await q(`update users set account_status = 'invited', invited_at = created_at, must_change_password = false where id = $1`, [row.id]);
  return { id: Number(row.id), authId };
}
const listed = async (email: string) => (await call('GET', `/users?search=${encodeURIComponent(email)}`, { token: admin })).json.data[0];

test('a backfilled account shows Invited (or Expired after 24h) and cannot sign in with the old temporary password', async () => {
  await legacyInvited('legacy.fresh@example.test');
  await legacyInvited('legacy.old@example.test', '3 days');
  assert.equal((await listed('legacy.fresh@example.test')).invite_state, 'invited');
  assert.equal((await listed('legacy.old@example.test')).invite_state, 'expired');
  const refused = await call('POST', '/auth/login', { body: { email: 'legacy.fresh@example.test', password: TEMPORARY, portal: 'staff' } });
  assert.equal(refused.status, 403);
  assert.match(refused.json.message, /invitation email/);
});

test('Resend: the old sign-in (with its temporary password) is replaced by a fresh invite; accepting needs no second change', async () => {
  const email = 'legacy.resend@example.test';
  const { id, authId } = await legacyInvited(email, '3 days');
  const res = await call('POST', `/users/${id}/resend-invite`, { token: admin });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.message, `Invite email sent to ${email}.`);
  assert.equal(auth.exists(authId), false, 'the old sign-in and its temporary password are gone');
  assert.equal(auth.invites.filter((i) => i.email === email).length, 1, 'the "Invite user" email went out');
  assert.equal((await listed(email)).invite_state, 'invited', 'the 24h clock restarts');
  const token = await signInInvited(call, email);
  assert.equal((await call('GET', '/auth/me', { token })).status, 200);
  const [row] = await q(`select account_status, must_change_password, invite_accepted_at from users where id = $1`, [id]);
  assert.deepEqual([row.account_status, row.must_change_password, Boolean(row.invite_accepted_at)], ['active', false, true]);
  const [audit] = await q(`select new_values from audit_logs where action = 'user.invite_resent' and auditable_id = $1`, [id]);
  assert.equal(audit.new_values.email, 'invite');
});

test('Resend when Supabase will not remove the old sign-in: a "Reset password" email; the link still accepts the invite', async () => {
  const email = 'legacy.reset@example.test';
  const { id, authId } = await legacyInvited(email);
  auth.failNextDelete('Database error deleting user');
  const res = await call('POST', `/users/${id}/resend-invite`, { token: admin });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.match(res.json.message, /"Reset password"\) sent to legacy\.reset@example\.test/);
  assert.equal(auth.resets.filter((r) => r.email === email).length, 1);
  assert.equal(auth.invites.filter((i) => i.email === email).length, 0);
  const [kept] = await q(`select auth_user_id, account_status from users where id = $1`, [id]);
  assert.deepEqual([kept.auth_user_id, kept.account_status], [authId, 'invited'], 'still linked, still invited');

  // /reset-password: the page asks the API what the link is for; an invited account is an invitation.
  const link = await auth.openInviteLink(email);
  assert.equal((await call('GET', '/auth/invite', { token: link })).json.data.kind, 'invite');
  await auth.acceptInvite(email, NEW_PASSWORD);
  assert.equal((await call('POST', '/auth/invite/accept', { token: link })).status, 200);
  const session = await call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal: 'staff' } });
  assert.equal(session.status, 200, JSON.stringify(session.json));
  assert.equal(session.json.data.user.must_change_password, false);
  const [audit] = await q(`select new_values from audit_logs where action = 'user.invite_resent' and auditable_id = $1`, [id]);
  assert.equal(audit.new_values.email, 'reset_password');
});

test('Cancel invite removes a backfilled account and its sign-in', async () => {
  const { id, authId } = await legacyInvited('legacy.cancel@example.test');
  assert.equal((await call('DELETE', `/users/${id}/invite`, { token: admin })).status, 200);
  assert.equal((await q(`select count(*)::int c from users where id = $1`, [id]))[0].c, 0);
  assert.equal(auth.exists(authId), false);
});

test('an account that already signed in is not an invitation: no resend or cancel', async () => {
  const [sales] = await q(`select id from users where email = 'sales@franchisetitan.local'`);
  assert.equal((await listed('sales@franchisetitan.local')).invite_state, null);
  assert.equal((await call('POST', `/users/${sales.id}/resend-invite`, { token: admin })).status, 422);
  assert.equal((await call('DELETE', `/users/${sales.id}/invite`, { token: admin })).status, 422);
});
