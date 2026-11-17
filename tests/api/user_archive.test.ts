// Archive (suspend) users: sign-in refused and sessions cut while suspended, a later start, automatic
// restore after the end time, manual restore, self / last-Admin protection, and cancelling invitations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, setup } from '../support/harness.ts';
import { createStaff, NEW_PASSWORD } from '../support/accounts.ts';

const { pg, call, login, auth } = await setup();
const admin = await login(ADMIN);
const q = async (sql: string, params: any[] = []) => (await pg.query(sql, params)).rows as any[];
const firstError = (res: { json: any }) => Object.values(res.json?.errors ?? {}).flat()[0] as string;
const idOf = async (email: string) => Number((await q(`select id from users where email = $1`, [email]))[0].id);
const signIn = (email: string) => call('POST', '/auth/login', { body: { email, password: NEW_PASSWORD, portal: 'staff' } });
const archiveItems = async () => (await call('GET', '/archive?type=users', { token: admin })).json.data.users.items;
const inList = async (name: string) => (await call('GET', `/users?search=${encodeURIComponent(name)}`, { token: admin })).json.data.length > 0;

test('archive now: suspended at once, sessions cut, sign-in refused, out of the lists, in Archive -> Users', async () => {
  const token = await createStaff(call, admin, { full_name: 'Suspend Now', email: 'suspend.now@example.test', role: 'sales' });
  const id = await idOf('suspend.now@example.test');
  const res = await call('POST', `/users/${id}/archive`, { token: admin, body: { suspended_until: new Date(Date.now() + 3 * 86400e3).toISOString(), reason: 'On leave' } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.account_status, 'suspended');
  assert.equal((await call('GET', '/auth/me', { token })).status, 401, 'the open session no longer works');
  const refused = await signIn('suspend.now@example.test');
  assert.equal(refused.status, 403);
  assert.match(refused.json.message, /suspended until/);
  assert.equal(await inList('Suspend Now'), false, 'hidden from the main list');
  const item = (await archiveItems()).find((u: any) => u.id === id);
  assert.deepEqual([item.status, item.reason, item.archived_by], ['suspended', 'On leave', 'System Administrator']);
  assert.ok(item.suspended_from && item.suspended_until);
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.archived' and auditable_id = $1`, [id]))[0].c, 1);
});

test('archive with a later start: archived now, still usable until the start, then refused', async () => {
  await createStaff(call, admin, { full_name: 'Suspend Later', email: 'suspend.later@example.test', role: 'marketing' });
  const id = await idOf('suspend.later@example.test');
  const res = await call('POST', `/users/${id}/archive`, { token: admin, body: { suspended_from: new Date(Date.now() + 86400e3).toISOString() } });
  assert.equal(res.json.data.account_status, 'active', 'not suspended yet');
  assert.equal((await archiveItems()).find((u: any) => u.id === id).status, 'scheduled');
  assert.equal(await inList('Suspend Later'), false, 'already out of the main list');
  const before = await signIn('suspend.later@example.test');
  assert.equal(before.status, 200, 'works until the start');
  await q(`update users set suspended_from = now() - interval '1 minute' where id = $1`, [id]);
  assert.equal((await call('GET', '/auth/me', { token: before.json.data.token })).status, 401, 'cut off once the start passed');
  assert.equal((await signIn('suspend.later@example.test')).status, 403);
  assert.equal((await q(`select account_status from users where id = $1`, [id]))[0].account_status, 'suspended');
});

test('restored automatically after the end time (on sign-in, and on list load), audited', async () => {
  await createStaff(call, admin, { full_name: 'Auto Restore', email: 'auto.restore@example.test', role: 'logistics' });
  const id = await idOf('auto.restore@example.test');
  await call('POST', `/users/${id}/archive`, { token: admin, body: { suspended_until: new Date(Date.now() + 3600e3).toISOString() } });
  await q(`update users set suspended_until = now() - interval '1 minute' where id = $1`, [id]);
  const back = await signIn('auto.restore@example.test');
  assert.equal(back.status, 200, JSON.stringify(back.json));
  const [row] = await q(`select account_status, archived_at, suspended_from, suspended_until from users where id = $1`, [id]);
  assert.deepEqual([row.account_status, row.archived_at, row.suspended_from, row.suspended_until], ['active', null, null, null]);
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.auto_restored' and auditable_id = $1`, [id]))[0].c, 1);

  await call('POST', `/users/${id}/archive`, { token: admin, body: { suspended_until: new Date(Date.now() + 3600e3).toISOString() } });
  await q(`update users set suspended_until = now() - interval '1 minute' where id = $1`, [id]);
  assert.equal(await inList('Auto Restore'), true, 'the list load restores it too');
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.auto_restored' and auditable_id = $1`, [id]))[0].c, 2);
});

test('restore by an Admin reactivates at once (User Management and Archive -> Users)', async () => {
  await createStaff(call, admin, { full_name: 'Manual Restore', email: 'manual.restore@example.test', role: 'sales' });
  const id = await idOf('manual.restore@example.test');
  await call('POST', `/users/${id}/archive`, { token: admin, body: { reason: 'Until further notice' } });
  assert.equal((await q(`select suspended_until from users where id = $1`, [id]))[0].suspended_until, null, 'no end: until restored');
  const restored = await call('POST', `/archive/users/${id}/restore`, { token: admin });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.data.account_status, 'active');
  assert.equal((await signIn('manual.restore@example.test')).status, 200);
  assert.equal(await inList('Manual Restore'), true);
  await call('POST', `/users/${id}/archive`, { token: admin, body: {} });
  assert.equal((await call('POST', `/users/${id}/restore`, { token: admin })).json.data.account_status, 'active');
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.restored' and auditable_id = $1`, [id]))[0].c, 2);
});

test('rules: Admin only, not yourself, not the last active Admin, sensible dates', async () => {
  const sales = await login('sales@franchisetitan.local');
  const target = await idOf('marketing@franchisetitan.local');
  assert.equal((await call('POST', `/users/${target}/archive`, { token: sales, body: {} })).status, 403, 'Admin only');
  const self = await idOf(ADMIN);
  assert.match(firstError(await call('POST', `/users/${self}/archive`, { token: admin, body: {} })), /cannot archive your own account/);
  // The last active Admin: here the acting Admin is already scheduled for suspension, so the
  // other Admin is the only one that would remain — archiving or deactivating it is refused.
  await createStaff(call, admin, { full_name: 'Other Admin', email: 'other.admin@example.test', role: 'admin' });
  const other = await idOf('other.admin@example.test');
  await q(`update users set archived_at = now(), suspended_from = now() + interval '1 day' where id = $1`, [self]);
  try {
    assert.match(firstError(await call('POST', `/users/${other}/archive`, { token: admin, body: {} })), /last active Admin/);
    assert.match(firstError(await call('DELETE', `/users/${other}`, { token: admin })), /last active Admin/);
  } finally {
    await q(`update users set archived_at = null, suspended_from = null where id = $1`, [self]);
  }
  assert.equal((await call('POST', `/users/${other}/archive`, { token: admin, body: {} })).status, 200, 'allowed while another Admin stays active');
  const past = new Date(Date.now() - 3600e3).toISOString();
  assert.match(firstError(await call('POST', `/users/${target}/archive`, { token: admin, body: { suspended_until: past } })), /end after it starts|in the future/);
  assert.match(firstError(await call('PUT', `/users/${target}`, { token: admin, body: { account_status: 'suspended' } })), /Archive \(suspend\)/);
});

test('cancel an invitation nobody accepted: the account and its pending sign-in are removed; not for used accounts', async () => {
  const created = await call('POST', '/users', { token: admin, body: { full_name: 'Test Invite', email: 'test.invite@example.test', role: 'sales' } });
  const id = created.json.data.id;
  const [{ auth_user_id: authId }] = await q(`select auth_user_id from users where id = $1`, [id]);
  assert.match(firstError(await call('POST', `/users/${id}/archive`, { token: admin, body: {} })), /cancel the invite/);
  const cancelled = await call('DELETE', `/users/${id}/invite`, { token: admin });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
  assert.equal((await q(`select count(*)::int c from users where id = $1`, [id]))[0].c, 0);
  assert.equal((await q(`select count(*)::int c from auth.users where id = $1`, [authId]))[0].c, 0, 'the pending Supabase sign-in is gone');
  assert.equal((await q(`select count(*)::int c from audit_logs where action = 'user.invite_cancelled' and auditable_id = $1`, [id]))[0].c, 1);
  assert.equal((await call('POST', '/users', { token: admin, body: { full_name: 'Test Invite', email: 'test.invite@example.test', role: 'sales' } })).status, 201, 'the address is free again');

  const used = await idOf('suspend.now@example.test');
  assert.match(firstError(await call('DELETE', `/users/${used}/invite`, { token: admin })), /never accepted can be cancelled/);
  // A cancelled Franchisee invitation frees the applicant again.
  const [brand] = await q(`select id from brands order by id limit 1`);
  const [a] = await q(
    `insert into applicants (full_name, email, phone, status, application_date, preferred_brand_id, applicant_code) values ('Cancel Branch', 'cancel.branch@example.test', '09170000777', 'active_franchisee', current_date, $1, 'APL-UA-CANCEL') returning id`, [brand.id],
  );
  const portal = await call('POST', `/applicants/${a.id}/portal-user`, { token: admin, body: { email: 'cancel.branch@example.test' } });
  assert.equal(portal.status, 201, JSON.stringify(portal.json));
  assert.equal((await call('DELETE', `/users/${portal.json.data.id}/invite`, { token: admin })).status, 200);
  assert.equal((await q(`select user_id from applicants where id = $1`, [a.id]))[0].user_id, null, 'the applicant can be invited again');
  assert.ok(auth.invites.some((i) => i.email === 'cancel.branch@example.test'));
});
